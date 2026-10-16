import type { PoolClient } from '@m1/database';
import { addCashTx, type SessionRow } from './cashier';

/**
 * LegacyProjection: the ONLY code that writes legacy money tables (cash_transactions, the money
 * columns of cashier_sessions) for a rail that is on the ledger.
 *
 * The ledger is authoritative. Every projection is written AFTER its ledger transaction, in the
 * same database transaction, and references it; the database refuses a legacy money row on a
 * ledger rail without such a ledger transaction (migration 006). Legacy screens and reports keep
 * working on these rows; reconciliation (Step 7a) compares them with the ledger continuously.
 *
 * Legacy drawer formula (must always equal the ledger DRAWER balance of the shift):
 *   opening_balance (0 on the ledger) + sum(cash_transactions.amount) + difference
 */

type Db = Pick<PoolClient, 'query'>;

/** A confirmed vault fill / drop as a legacy drawer movement. */
export async function projectDrawerMovement(
  db: Db,
  session: SessionRow,
  kind: 'FILL' | 'DROP',
  amountCents: number,
  moneyTransactionId: string,
  reference: string,
) {
  return addCashTx(db as PoolClient, session, kind, amountCents / 100, { moneyTransactionId, reference });
}

/** Shift handed in for counting (no money). */
export async function projectShiftCounting(db: Db, sessionId: string) {
  await db.query(`UPDATE cashier_sessions SET status = 'COUNTING' WHERE id = $1 AND status = 'OPEN'`, [sessionId]);
}

/**
 * A booked close count: expected = drawer before any short / over of this close, counted = latest
 * verified count, difference = everything booked as short / over (cumulative over recounts).
 */
export async function projectShiftCounted(db: Db, sessionId: string, c: { expectedCents: number; countedCents: number; differenceCents: number }) {
  await db.query(
    'UPDATE cashier_sessions SET expected_balance = $2, counted_balance = $3, difference = $4 WHERE id = $1',
    [sessionId, c.expectedCents / 100, c.countedCents / 100, c.differenceCents / 100],
  );
}

/** Shift closed after the final drop (drawer 0 in the ledger). */
export async function projectShiftClosed(db: Db, sessionId: string, note?: string | null) {
  await db.query(`UPDATE cashier_sessions SET status = 'CLOSED', closed_at = now(), close_note = COALESCE($2, close_note) WHERE id = $1`, [sessionId, note ?? null]);
}

/**
 * A ledger handpay payment in cash as the legacy HANDPAY drawer row. It carries the jackpot event id,
 * so the Step 1 unique index (one cash payment per jackpot event) keeps protecting it.
 */
export async function projectHandpayCash(
  db: Db,
  session: SessionRow,
  input: { amountCents: number; moneyTransactionId: string; sourceEventId: string; machineId: string; playerId?: string | null; reference: string },
) {
  return addCashTx(db as PoolClient, session, 'HANDPAY', input.amountCents / 100, {
    moneyTransactionId: input.moneyTransactionId, sourceEventId: input.sourceEventId, machineId: input.machineId, playerId: input.playerId ?? undefined, reference: input.reference,
  });
}

/** A ledger ticket sale (TICKET_ISSUE, into the drawer) or cash payout (TICKET_PAYOUT, out of it) as the legacy drawer row. */
export async function projectTicketCash(
  db: Db,
  session: SessionRow,
  input: { type: 'TICKET_ISSUE' | 'TICKET_PAYOUT'; amountCents: number; moneyTransactionId: string; ticketId: string; reference: string; playerId?: string | null },
) {
  return addCashTx(db as PoolClient, session, input.type, input.amountCents / 100, {
    moneyTransactionId: input.moneyTransactionId, ticketId: input.ticketId, reference: input.reference, playerId: input.playerId ?? undefined,
  });
}

/** The reversal of a voided cash ticket sale (money back to the customer) as a negative legacy drawer row. */
export async function projectTicketVoid(db: Db, session: SessionRow, input: { amountCents: number; moneyTransactionId: string; ticketId: string; reference: string }) {
  return addCashTx(db as PoolClient, session, 'ADJUSTMENT', -input.amountCents / 100, {
    moneyTransactionId: input.moneyTransactionId, ticketId: input.ticketId, reference: `Void ${input.reference}`,
  });
}
