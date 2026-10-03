import type {
  CommandResult,
  GatewayMachineConfig,
  MachineCommand,
  MachineEvent,
  MachineFlags,
  MachineMeters,
  MachineStatus,
  PlayerSession,
} from '@m1/shared';

/**
 * Contract every machine integration implements. The gateway only talks to this
 * interface, so new manufacturers are added by implementing it, nothing else changes.
 */
export interface GamingMachineAdapter {
  /** Adapter key, e.g. "simulator", "novomatic", "sas". */
  readonly key: string;
  readonly machine: GatewayMachineConfig;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): Promise<MachineStatus>;
  getMeters(): Promise<MachineMeters>;
  /** Returns (and drains) events collected since the last call, already in the internal model. */
  getEvents(): Promise<MachineEvent[]>;
  sendCommand(command: MachineCommand): Promise<CommandResult>;
  getPlayerSession(): Promise<PlayerSession | null>;
}

export type AdapterFactory = (machine: GatewayMachineConfig) => GamingMachineAdapter;

export type { MachineFlags };
