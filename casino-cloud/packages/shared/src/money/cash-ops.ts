/**
 * Vault <-> drawer cash movements (Step 7a). Money moves only when the RECEIVING side confirms
 * with its own count: a fill is requested by the vault and confirmed by the cashier, a drop is
 * requested by the cashier and confirmed by the vault. REQUESTED never moves money.
 */
export const CASH_MOVEMENT_KINDS = ['FILL', 'DROP'] as const;
export type CashMovementKind = (typeof CASH_MOVEMENT_KINDS)[number];

export const CASH_MOVEMENT_STATUSES = ['REQUESTED', 'CONFIRMED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const;
export type CashMovementStatus = (typeof CASH_MOVEMENT_STATUSES)[number];

export const CASH_MOVEMENT_TRANSITIONS: Record<CashMovementStatus, readonly CashMovementStatus[]> = {
  REQUESTED: ['CONFIRMED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  CONFIRMED: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
};

/** Shift (cashier session) states on a ledger casino: OPEN -> COUNTING (blind close count) -> CLOSED. */
export const LEDGER_SHIFT_STATUSES = ['OPEN', 'COUNTING', 'CLOSED'] as const;
