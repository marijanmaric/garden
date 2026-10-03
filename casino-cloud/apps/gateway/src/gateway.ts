import { randomUUID } from 'node:crypto';
import { createAdapter, SimulatorAdapter, type GamingMachineAdapter } from '@m1/adapters';
import type { GatewayMachineConfig, GatewayRemoteConfig, MachineEvent, SimulationConfig } from '@m1/shared';
import type { CloudClient } from './cloud';
import type { OfflineQueue } from './queue';

export const GATEWAY_VERSION = '0.1.0';
const BATCH_SIZE = 200;

export interface GatewayLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * Edge gateway runtime:
 *  - manages one adapter per machine (created from the cloud's remote configuration)
 *  - polls adapters for events and writes them to the durable offline queue
 *  - flushes the queue to the cloud and keeps it while the cloud is unreachable
 *  - sends heartbeats, receives config and machine commands
 *  - drives the simulator when simulation is enabled
 */
export class Gateway {
  private adapters = new Map<string, GamingMachineAdapter>();
  private simulation: SimulationConfig = { running: false, eventsPerSecond: 2 };
  private cloudOnline = false;
  private timers: NodeJS.Timeout[] = [];
  private simTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private sentTotal = 0;
  private startedAt = Date.now();

  constructor(
    private cloud: CloudClient,
    private queue: OfflineQueue,
    private log: GatewayLogger = { info: console.log, warn: console.warn },
  ) {}

  start() {
    this.log.info(`[gateway] starting, ${this.queue.size} event(s) in offline queue`);
    void this.heartbeat();
    this.timers.push(setInterval(() => void this.heartbeat(), 2000));
    this.timers.push(setInterval(() => void this.poll(), 500));
    this.timers.push(setInterval(() => void this.flush(), 1000));
  }

  async stop() {
    this.timers.forEach(clearInterval);
    if (this.simTimer) clearInterval(this.simTimer);
    await this.poll();
    for (const a of this.adapters.values()) await a.disconnect();
  }

  // ---- configuration ----------------------------------------------------

  private async applyConfig(cfg: GatewayRemoteConfig) {
    const wanted = new Map(cfg.machines.map((m) => [m.machineId, m]));
    for (const [id, adapter] of this.adapters) {
      if (!wanted.has(id)) {
        await adapter.disconnect();
        this.adapters.delete(id);
        this.log.info(`[gateway] removed machine ${id}`);
      }
    }
    for (const m of cfg.machines) if (!this.adapters.has(m.machineId)) await this.addMachine(m);

    if (cfg.simulation.running !== this.simulation.running || cfg.simulation.eventsPerSecond !== this.simulation.eventsPerSecond) {
      this.simulation = cfg.simulation;
      this.restartSimulation();
    }

    for (const cmd of cfg.pendingCommands) {
      const adapter = this.adapters.get(cmd.machineId);
      try {
        const res = adapter
          ? await adapter.sendCommand(cmd)
          : { commandId: cmd.id, success: false, message: 'Machine not connected to this gateway' };
        await this.cloud.commandResult(cmd.id, res.success, res.message);
        this.log.info(`[gateway] command ${cmd.type} on ${cmd.machineId}: ${res.success ? 'ok' : res.message}`);
      } catch (err) {
        this.log.warn(`[gateway] command ${cmd.id} failed: ${(err as Error).message}`);
      }
    }
  }

  private async addMachine(m: GatewayMachineConfig) {
    const adapter = createAdapter(m);
    this.adapters.set(m.machineId, adapter);
    try {
      await adapter.connect();
      this.record([this.statusEvent(m.machineId, 'MACHINE_ONLINE', `Connected via ${adapter.key} adapter`, adapter.key)]);
      this.log.info(`[gateway] connected ${m.assetNo} (${m.manufacturer}) via ${adapter.key}`);
    } catch (err) {
      this.record([this.statusEvent(m.machineId, 'MACHINE_OFFLINE', (err as Error).message, adapter.key)]);
      this.log.warn(`[gateway] ${m.assetNo}: ${(err as Error).message}`);
    }
  }

  private restartSimulation() {
    if (this.simTimer) clearInterval(this.simTimer);
    this.simTimer = null;
    if (!this.simulation.running) {
      this.log.info('[gateway] simulation stopped');
      return;
    }
    const eps = Math.min(5, Math.max(1, this.simulation.eventsPerSecond));
    this.log.info(`[gateway] simulation running at ~${eps} events/sec`);
    this.simTimer = setInterval(() => {
      const sims = [...this.adapters.values()].filter((a): a is SimulatorAdapter => a instanceof SimulatorAdapter);
      if (sims.length) sims[Math.floor(Math.random() * sims.length)].tick();
    }, 1000 / eps);
  }

  // ---- event pipeline ---------------------------------------------------

  private async poll() {
    for (const adapter of this.adapters.values()) {
      try {
        this.record(await adapter.getEvents());
      } catch (err) {
        this.log.warn(`[gateway] poll ${adapter.machine.machineId}: ${(err as Error).message}`);
      }
    }
  }

  private record(events: MachineEvent[]) {
    this.queue.push(events);
  }

  private async flush() {
    if (this.flushing || !this.queue.size) return;
    this.flushing = true;
    try {
      while (this.queue.size) {
        const batch = this.queue.peek(BATCH_SIZE);
        const res = await this.cloud.sendEvents(batch);
        this.queue.ack(batch.length);
        this.sentTotal += res.accepted;
        if (!this.cloudOnline) this.setCloudOnline(true);
        if (res.rejected.length) this.log.warn(`[gateway] cloud rejected ${res.rejected.length} event(s) (unknown machine)`);
      }
    } catch (err) {
      if (this.cloudOnline) this.log.warn(`[gateway] cloud unreachable, buffering events offline: ${(err as Error).message}`);
      this.setCloudOnline(false);
    } finally {
      this.flushing = false;
    }
  }

  private async heartbeat() {
    try {
      const machines = await Promise.all(
        [...this.adapters.values()].map(async (a) => ({ machineId: a.machine.machineId, status: await a.getStatus() })),
      );
      const cfg = await this.cloud.heartbeat({
        version: GATEWAY_VERSION,
        machines,
        stats: {
          queueSize: this.queue.size,
          sentTotal: this.sentTotal,
          adapters: this.adapters.size,
          uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
          simulation: this.simulation,
        },
      });
      if (!this.cloudOnline) this.setCloudOnline(true);
      await this.applyConfig(cfg);
    } catch (err) {
      if (this.cloudOnline) this.log.warn(`[gateway] heartbeat failed: ${(err as Error).message}`);
      this.setCloudOnline(false);
    }
  }

  private setCloudOnline(online: boolean) {
    if (online === this.cloudOnline) return;
    this.cloudOnline = online;
    this.log.info(online ? `[gateway] cloud connection established (${this.queue.size} queued)` : '[gateway] OFFLINE MODE: events are stored locally');
  }

  private statusEvent(machineId: string, type: 'MACHINE_ONLINE' | 'MACHINE_OFFLINE', message: string, source: string): MachineEvent {
    return { eventId: randomUUID(), type, machineId, timestamp: new Date().toISOString(), message, source };
  }
}
