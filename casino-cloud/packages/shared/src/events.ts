/**
 * Unified internal event model. Every adapter (simulator or manufacturer protocol)
 * translates its native messages into these events. The rest of the platform never
 * knows which manufacturer an event came from.
 */
export const MACHINE_EVENT_TYPES = [
  'GAME_PLAYED',
  'CASH_IN', // bills / cash accepted by the machine
  'CASH_OUT', // cash paid out by the machine (hopper)
  'TITO_IN', // ticket accepted
  'TITO_OUT', // ticket printed
  'CASHLESS_IN', // wallet -> machine transfer completed on the machine
  'CASHLESS_OUT', // machine -> wallet transfer completed on the machine
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

/**
 * Legacy event names still accepted from adapters and old gateway queues. They are translated to
 * the canonical names at the ingestion boundary; nothing behind it uses the legacy names.
 */
export const LEGACY_EVENT_ALIASES = {
  COIN_IN: 'CASH_IN',
  COIN_OUT: 'CASH_OUT',
  TICKET_IN: 'TITO_IN',
  TICKET_OUT: 'TITO_OUT',
} as const satisfies Record<string, MachineEventType>;
export type LegacyMachineEventType = keyof typeof LEGACY_EVENT_ALIASES;

/** Every event type the ingestion boundary accepts. */
export const WIRE_EVENT_TYPES = [...MACHINE_EVENT_TYPES, ...(Object.keys(LEGACY_EVENT_ALIASES) as LegacyMachineEventType[])] as const;
export type WireMachineEventType = MachineEventType | LegacyMachineEventType;

export function normalizeEventType(type: WireMachineEventType): MachineEventType {
  return (LEGACY_EVENT_ALIASES as Record<string, MachineEventType>)[type] ?? (type as MachineEventType);
}

/** Translates an event from the wire (possibly legacy) to the canonical model. */
export function normalizeEvent<E extends { type: WireMachineEventType }>(event: E): Omit<E, 'type'> & { type: MachineEventType; legacyType?: LegacyMachineEventType } {
  const type = normalizeEventType(event.type);
  return type === event.type ? (event as never) : { ...event, type, legacyType: event.type as LegacyMachineEventType };
}

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
  /** TITO_IN: the hold the machine committed (accept ack of a ticket held for this machine). */
  holdId?: string;
  errorCode?: string;
  message?: string;
  /** Source adapter key, kept for traceability only. */
  source?: string;
}

/** An event as received from a gateway: may still carry a legacy type name. */
export type WireMachineEvent = Omit<MachineEvent, 'type'> & { type: WireMachineEventType };

/** Messages pushed to dashboards over the realtime stream (SSE). */
export type StreamMessage =
  | { kind: 'machine.event'; casinoId: string; event: MachineEvent & { assetNo: string; status: string } }
  | { kind: 'machine.status'; casinoId: string; machineId: string; assetNo: string; status: string }
  | { kind: 'alert.created'; casinoId: string; alert: { id: string; type: string; severity: string; message: string; machineId: string | null } }
  | { kind: 'alert.updated'; casinoId: string; alertId: string; status: string }
  | { kind: 'gateway.status'; casinoId: string; gatewayId: string; status: string }
  | { kind: 'simulation.updated'; casinoId: string; running: boolean; eventsPerSecond: number };
