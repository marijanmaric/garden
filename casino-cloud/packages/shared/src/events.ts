/**
 * Unified internal event model. Every adapter (simulator or manufacturer protocol)
 * translates its native messages into these events. The rest of the platform never
 * knows which manufacturer an event came from.
 */
export const MACHINE_EVENT_TYPES = [
  'GAME_PLAYED',
  'COIN_IN',
  'COIN_OUT',
  'TICKET_IN',
  'TICKET_OUT',
  'JACKPOT',
  'JACKPOT_RESET',
  'MACHINE_ERROR',
  'MACHINE_ERROR_CLEARED',
  'MACHINE_DOOR_OPEN',
  'MACHINE_DOOR_CLOSED',
  'CASHBOX_OPEN',
  'CASHBOX_CLOSED',
  'PRINTER_ERROR',
  'PRINTER_OK',
  'PLAYER_LOGIN',
  'PLAYER_LOGOUT',
  'MACHINE_OFFLINE',
  'MACHINE_ONLINE',
  'MACHINE_DISABLED',
  'MACHINE_ENABLED',
] as const;
export type MachineEventType = (typeof MACHINE_EVENT_TYPES)[number];

export interface MachineEvent {
  /** Globally unique id generated at the source (gateway). Used for idempotent ingestion. */
  eventId: string;
  type: MachineEventType;
  machineId: string;
  /** ISO timestamp of when the event happened at the machine. */
  timestamp: string;
  /** Primary monetary amount in EUR (bet, inserted cash, ticket value, jackpot ...). */
  amount?: number;
  /** For GAME_PLAYED: amount won in that game. */
  win?: number;
  playerCardId?: string;
  ticketBarcode?: string;
  errorCode?: string;
  message?: string;
  /** Source adapter key, kept for traceability only. */
  source?: string;
}

/** Messages pushed to dashboards over the realtime stream (SSE). */
export type StreamMessage =
  | { kind: 'machine.event'; casinoId: string; event: MachineEvent & { assetNo: string; status: string } }
  | { kind: 'machine.status'; casinoId: string; machineId: string; assetNo: string; status: string }
  | { kind: 'alert.created'; casinoId: string; alert: { id: string; type: string; severity: string; message: string; machineId: string | null } }
  | { kind: 'alert.updated'; casinoId: string; alertId: string; status: string }
  | { kind: 'gateway.status'; casinoId: string; gatewayId: string; status: string }
  | { kind: 'simulation.updated'; casinoId: string; running: boolean; eventsPerSecond: number };
