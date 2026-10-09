/** TITO ticket lifecycle. */
export const TICKET_STATUSES = ['VALID', 'REDEEMED', 'CANCELLED', 'EXPIRED', 'VOID'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * Cash drawer movements. Amounts are stored signed: positive = into the drawer, negative = out of it.
 * The table is append-only; a wrong entry is corrected by a new ADJUSTMENT.
 */
export const CASH_TX_TYPES = {
  CASH_IN: { sign: 1, label: 'Cash in' },
  CASH_OUT: { sign: -1, label: 'Cash out' },
  TICKET_PAYOUT: { sign: -1, label: 'Ticket payout' },
  TICKET_ISSUE: { sign: 1, label: 'Ticket sold' },
  HANDPAY: { sign: -1, label: 'Jackpot handpay' },
  FILL: { sign: 1, label: 'Fill from vault' },
  DROP: { sign: -1, label: 'Drop to vault' },
  ADJUSTMENT: { sign: 0, label: 'Adjustment' }, // sign given by the amount
} as const;
export type CashTxType = keyof typeof CASH_TX_TYPES;

/** Signed drawer effect of a movement. ADJUSTMENT keeps the caller's sign. */
export function signedCashAmount(type: CashTxType, amount: number): number {
  const sign = CASH_TX_TYPES[type].sign;
  return sign === 0 ? amount : sign * Math.abs(amount);
}
