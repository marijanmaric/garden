import { randomUUID } from 'node:crypto';
import type {
  CommandResult,
  GatewayMachineConfig,
  MachineCommand,
  MachineEvent,
  MachineEventType,
  MachineMeters,
  MachineStatus,
  PlayerSession,
} from '@m1/shared';
import type { GamingMachineAdapter } from './types';

/**
 * Base class for real manufacturer adapters. Subclasses implement the transport
 * (serial, TCP, vendor SDK ...) and translate native messages with `emit()`.
 */
export abstract class ProtocolAdapter implements GamingMachineAdapter {
  abstract readonly key: string;
  protected buffer: MachineEvent[] = [];

  constructor(readonly machine: GatewayMachineConfig) {}

  /** Translate into the internal event model and buffer it. */
  protected emit(type: MachineEventType, data: Partial<MachineEvent> = {}): MachineEvent {
    const event: MachineEvent = {
      eventId: randomUUID(),
      type,
      machineId: this.machine.machineId,
      timestamp: new Date().toISOString(),
      source: this.key,
      ...data,
    };
    this.buffer.push(event);
    return event;
  }

  async getEvents(): Promise<MachineEvent[]> {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract getStatus(): Promise<MachineStatus>;
  abstract getMeters(): Promise<MachineMeters>;
  abstract sendCommand(command: MachineCommand): Promise<CommandResult>;
  abstract getPlayerSession(): Promise<PlayerSession | null>;
}

/**
 * Placeholder for manufacturers whose protocol is not implemented yet.
 * Connecting fails loudly so a misconfigured machine never silently reports nothing.
 */
export class NotImplementedAdapter extends ProtocolAdapter {
  constructor(
    readonly key: string,
    machine: GatewayMachineConfig,
  ) {
    super(machine);
  }
  private fail(): never {
    throw new Error(`Adapter "${this.key}" is not implemented yet (machine ${this.machine.machineId})`);
  }
  async connect() { this.fail(); }
  async disconnect() {}
  async getStatus(): Promise<MachineStatus> { return 'OFFLINE'; }
  async getMeters(): Promise<MachineMeters> { this.fail(); }
  async sendCommand(): Promise<CommandResult> { this.fail(); }
  async getPlayerSession() { return null; }
}
