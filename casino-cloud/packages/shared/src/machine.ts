/** Platform-wide machine status. Manufacturer specific states are mapped onto these by adapters. */
export const MACHINE_STATUSES = [
  'ONLINE',
  'OFFLINE',
  'WARNING',
  'ERROR',
  'MAINTENANCE',
  'DISABLED',
  'JACKPOT',
] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

/** Raw condition flags. The effective MachineStatus is derived from them (see deriveMachineStatus). */
export interface MachineFlags {
  online: boolean;
  disabled: boolean;
  maintenance: boolean;
  errorCode: string | null;
  doorOpen: boolean;
  cashboxOpen: boolean;
  printerError: boolean;
  jackpotPending: boolean;
}

/** Priority order: the most severe condition wins. */
export function deriveMachineStatus(f: MachineFlags): MachineStatus {
  if (!f.online) return 'OFFLINE';
  if (f.maintenance) return 'MAINTENANCE';
  if (f.disabled) return 'DISABLED';
  if (f.jackpotPending) return 'JACKPOT';
  if (f.errorCode) return 'ERROR';
  if (f.doorOpen || f.cashboxOpen || f.printerError) return 'WARNING';
  return 'ONLINE';
}

/** Cumulative machine meters, amounts in EUR. */
export interface MachineMeters {
  coinIn: number;
  coinOut: number;
  jackpot: number;
  gamesPlayed: number;
  gamesWon: number;
  ticketsIn: number;
  ticketsOut: number;
  cashIn: number;
  cashOut: number;
}

export const EMPTY_METERS: MachineMeters = {
  coinIn: 0,
  coinOut: 0,
  jackpot: 0,
  gamesPlayed: 0,
  gamesWon: 0,
  ticketsIn: 0,
  ticketsOut: 0,
  cashIn: 0,
  cashOut: 0,
};

export interface PlayerSession {
  playerCardId: string;
  startedAt: string;
}

export const MACHINE_COMMANDS = ['LOCK', 'UNLOCK', 'RESET_ERROR', 'RESET_JACKPOT', 'PING'] as const;
export type MachineCommandType = (typeof MACHINE_COMMANDS)[number];

export interface MachineCommand {
  id: string;
  type: MachineCommandType;
  payload?: Record<string, unknown>;
}

export interface CommandResult {
  commandId: string;
  success: boolean;
  message?: string;
}

/** Machine definition as distributed to an edge gateway (remote configuration). */
export interface GatewayMachineConfig {
  machineId: string; // platform machine code, e.g. VIE-001-000001
  assetNo: string; // floor asset number, e.g. M001
  manufacturer: string;
  model: string;
  game: string;
  denomination: number;
  adapter: string; // adapter key, e.g. "simulator", "novomatic"
  adapterConfig: Record<string, unknown>;
}

export interface SimulationConfig {
  running: boolean;
  eventsPerSecond: number; // 1..5
}

export interface GatewayRemoteConfig {
  gatewayId: string;
  casinoId: string;
  heartbeatIntervalSec: number;
  machines: GatewayMachineConfig[];
  simulation: SimulationConfig;
  pendingCommands: Array<MachineCommand & { machineId: string }>;
}
