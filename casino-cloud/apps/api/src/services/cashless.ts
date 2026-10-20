import { writeAudit, type PoolClient } from '@m1/database';
import { TRANSFER_TRANSITIONS, cents, type TransferDirection, type TransferStatus } from '@m1/shared';
import { HttpError, stateError } from '../auth';
import { entityDedupeKey, executeMoneyTransaction, type LatePosting, type MoneyActor } from './ledger';
import { requireUsableCard, type Actor } from './players';
import { assertWalletOperation, lockWallet, walletOfPlayer } from './wallets';
import { railOnLedger, requireRailOnLedger } from './rails';

/**
 * Cashless sessions (wallet play on one machine) and wallet transfers (wallet <-> machine).
 * The card only identifies the player; money lives in the wallet's ledger accounts.
 *
 * Transfer money flow (shared matrix):
 *   TO_MACHINE   REQUESTED: WALLET_TO_MACHINE_RESERVE (available -> reserved, NOT on the machine yet)
 *                CONFIRMED: WALLET_TO_MACHINE_CONFIRM (reserved -> MACHINE_CREDIT)
 *                FAILED / EXPIRED: WALLET_TO_MACHINE_RELEASE (reserved -> available)
 *   FROM_MACHINE REQUESTED / SENT: no money movement
 *                CONFIRMED: MACHINE_TO_WALLET with the amount the machine actually released
 */

type Db = Pick<PoolClient, 'query'>;

function moneyActor(a: Actor): MoneyActor {
  return { type: a.employeeId ? 'EMPLOYEE' : 'SYSTEM', employeeId: a.employeeId ?? null, name: a.employeeEmail ?? 'system', ip: a.ip ?? null };
}

function audit(db: Db, a: Actor, action: string, entityType: string, entityId: string, details: Record<string, unknown>) {
  return writeAudit(db as PoolClient, { orgId: a.orgId, actorType: a.employeeId ? 'EMPLOYEE' : 'SYSTEM', actorId: a.employeeId ?? null, actorName: a.employeeEmail ?? 'system', action, entityType, entityId, details });
}

async function machineOfOrg(db: Db, orgId: string, machineId: string) {
  const r = await db.query('SELECT id, casino_id FROM machines WHERE id = $1 AND org_id = $2', [machineId, orgId]);
  if (!r.rowCount) throw new HttpError(404, 'Machine not found');
  return r.rows[0] as { id: string; casino_id: string };
}

// ---- cashless sessions ---------------------------------------------------------------------

export async function openCashlessSession(
  db: Db,
  a: Actor,
  input: { cardNumber: string; machineId: string; requestKey: string; gamingSessionId?: string | null; sourceEventId?: string | null },
) {
  if (!input.requestKey) throw new HttpError(400, 'requestKey required');
  await requireRailOnLedger(db, a.orgId, 'CASHLESS');
  const existing = (await db.query('SELECT * FROM cashless_sessions WHERE org_id = $1 AND request_key = $2', [a.orgId, input.requestKey])).rows[0];
  const machine = await machineOfOrg(db, a.orgId, input.machineId);
  const { card, player } = await requireUsableCard(db, a.orgId, input.cardNumber);
  if (existing) {
    if (existing.machine_id === machine.id && existing.card_id === card.id) return { session: existing, replayed: true };
    throw new HttpError(409, 'Request key already used for a different session');
  }
  const wallet = await walletOfPlayer(db, a.orgId, player.id);
  assertWalletOperation(wallet, 'TO_MACHINE');
  try {
    const r = await db.query(
      `INSERT INTO cashless_sessions (org_id, casino_id, wallet_id, player_id, card_id, machine_id, gaming_session_id, request_key, source_event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [a.orgId, machine.casino_id, wallet.id, player.id, card.id, machine.id, input.gamingSessionId ?? null, input.requestKey, input.sourceEventId ?? null],
    );
    await audit(db, a, 'cashless.session_opened', 'cashless_session', r.rows[0].id, { walletId: wallet.id, machineId: machine.id, cardId: card.id });
    return { session: r.rows[0], replayed: false };
  } catch (err) {
    const c = (err as { constraint?: string }).constraint;
    if (c === 'cashless_sessions_one_open_per_machine') throw new HttpError(409, 'Machine already has an open cashless session');
    if (c === 'cashless_sessions_one_open_per_wallet') throw new HttpError(409, 'Wallet already has an open cashless session');
    throw err;
  }
}

export async function closeCashlessSession(db: Db, a: Actor, sessionId: string, reason = 'closed') {
  const s = (await db.query('SELECT * FROM cashless_sessions WHERE id = $1 AND org_id = $2 FOR UPDATE', [sessionId, a.orgId])).rows[0];
  if (!s) throw new HttpError(404, 'Cashless session not found');
  if (s.status === 'CLOSED') return s;
  const active = await db.query(`SELECT 1 FROM wallet_transfers WHERE cashless_session_id = $1 AND status IN ('REQUESTED', 'SENT')`, [sessionId]);
  if (active.rowCount) throw new HttpError(409, 'Session has a transfer in progress');
  const r = await db.query(`UPDATE cashless_sessions SET status = 'CLOSED', closed_at = now(), close_reason = $2 WHERE id = $1 RETURNING *`, [sessionId, reason]);
  await audit(db, a, 'cashless.session_closed', 'cashless_session', sessionId, { reason });
  return r.rows[0];
}

// ---- transfers -----------------------------------------------------------------------------

export interface TransferRow {
  id: string;
  org_id: string;
  casino_id: string;
  wallet_id: string;
  player_id: string;
  card_id: string | null;
  machine_id: string;
  cashless_session_id: string | null;
  direction: TransferDirection;
  amount_cents: number;
  confirmed_amount_cents: number | null;
  status: TransferStatus;
  request_key: string;
  ack_event_id: string | null;
}

function ledgerCtx(t: TransferRow, amountCents: number) {
  return {
    casinoId: t.casino_id, amountCents: cents(amountCents), playerId: t.player_id, walletId: t.wallet_id, cardId: t.card_id ?? undefined,
    machineId: t.machine_id, transferId: t.id,
  };
}

/** Requests a transfer within an open cashless session. Exactly once per request key. */
export async function requestTransfer(db: Db, a: Actor, input: { sessionId: string; direction: TransferDirection; amountCents: number; requestKey: string }) {
  if (!input.requestKey) throw new HttpError(400, 'requestKey required');
  await requireRailOnLedger(db, a.orgId, 'CASHLESS');
  const amount = cents(input.amountCents);
  if (amount <= 0) throw new HttpError(400, 'Amount must be positive');
  const prev = (await db.query('SELECT * FROM wallet_transfers WHERE org_id = $1 AND request_key = $2', [a.orgId, input.requestKey])).rows[0] as TransferRow | undefined;
  if (prev) {
    if (prev.cashless_session_id === input.sessionId && prev.direction === input.direction && prev.amount_cents === amount) return { transfer: prev, replayed: true };
    throw new HttpError(409, 'Request key already used for a different transfer');
  }
  const s = (await db.query('SELECT * FROM cashless_sessions WHERE id = $1 AND org_id = $2 FOR NO KEY UPDATE', [input.sessionId, a.orgId])).rows[0];
  if (!s) throw new HttpError(404, 'Cashless session not found');
  if (s.status !== 'OPEN') throw new HttpError(409, 'Cashless session is closed');
  // 7d: the machine side of a transfer is MACHINE_CREDIT, so the machine must be on the ledger (no reservation otherwise)
  if (!(await railOnLedger(db, a.orgId, 'MACHINE', s.casino_id, s.machine_id))) throw stateError(409, 'RAIL_LEGACY', 'MACHINE money is not on the ledger for this machine (cutover pending)');
  if ((await db.query(`SELECT money_rail_frozen($1, $2, 'MACHINE', $3) AS f`, [a.orgId, s.casino_id, s.machine_id])).rows[0].f)
    throw stateError(409, 'RAIL_FROZEN', 'MACHINE is frozen after a reconciliation mismatch: no new transfers');
  const wallet = await lockWallet(db, a.orgId, s.wallet_id);
  assertWalletOperation(wallet, input.direction === 'TO_MACHINE' ? 'TO_MACHINE' : 'FROM_MACHINE');
  const timeout = (await db.query('SELECT transfer_timeout_seconds FROM casino_money_settings WHERE casino_id = $1', [s.casino_id])).rows[0]?.transfer_timeout_seconds ?? 60;
  let t: TransferRow;
  try {
    t = (await db.query(
      `INSERT INTO wallet_transfers (org_id, casino_id, wallet_id, player_id, card_id, machine_id, cashless_session_id, direction, amount_cents, request_key, expires_at, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + make_interval(secs => $11), $12) RETURNING *`,
      [a.orgId, s.casino_id, s.wallet_id, s.player_id, s.card_id, s.machine_id, s.id, input.direction, amount, input.requestKey, timeout, a.employeeId ?? null],
    )).rows[0];
  } catch (err) {
    if ((err as { constraint?: string }).constraint === 'wallet_transfers_one_active_per_machine') throw new HttpError(409, 'Machine already has a transfer in progress');
    throw err;
  }
  if (t.direction === 'TO_MACHINE') {
    // Reserve inside the wallet. Insufficient funds roll the whole request back (no transfer row).
    await executeMoneyTransaction(db, { orgId: a.orgId, type: 'WALLET_TO_MACHINE_RESERVE', ctx: ledgerCtx(t, amount), dedupeKey: entityDedupeKey('transfer', t.id, 'reserve'), actor: moneyActor(a) });
  }
  await audit(db, a, 'cashless.transfer_requested', 'wallet_transfer', t.id, { direction: t.direction, amountCents: amount, walletId: t.wallet_id, machineId: t.machine_id });
  return { transfer: t, replayed: false };
}

async function lockTransfer(db: Db, orgId: string, transferId: string): Promise<TransferRow> {
  const r = await db.query('SELECT * FROM wallet_transfers WHERE id = $1 AND org_id = $2 FOR UPDATE', [transferId, orgId]);
  if (!r.rowCount) throw new HttpError(404, 'Transfer not found');
  return r.rows[0];
}

function assertTransition(t: TransferRow, to: TransferStatus) {
  if (!TRANSFER_TRANSITIONS.can(t.status, to)) throw new HttpError(409, `Transfer cannot change from ${t.status} to ${to}`);
}

/** The gateway delivered the transfer request to the machine. */
export async function markTransferSent(db: Db, a: Actor, transferId: string) {
  const t = await lockTransfer(db, a.orgId, transferId);
  if (t.status === 'SENT') return t;
  assertTransition(t, 'SENT');
  return (await db.query(`UPDATE wallet_transfers SET status = 'SENT', sent_at = now() WHERE id = $1 RETURNING *`, [transferId])).rows[0];
}

/**
 * The machine confirmed the transfer (its ack event). Only now does money reach (or leave) the machine.
 * Step 7d: an ack after FAILED / EXPIRED (reservation already released) is LATE_CONFIRMED: wallet ->
 * machine is booked from CASHLESS_EXCEPTION (the wallet is not charged twice), machine -> wallet with the
 * released amount; both are alerted by the caller. businessDate only for a validated deferred replay.
 */
export async function confirmTransfer(db: Db, a: Actor, input: { transferId: string; ackEventId?: string | null; confirmedAmountCents?: number; businessDate?: string | null; latePosting?: LatePosting | null }) {
  const t = await lockTransfer(db, a.orgId, input.transferId);
  if (t.status === 'CONFIRMED' || t.status === 'LATE_CONFIRMED') {
    if ((input.ackEventId ?? null) === t.ack_event_id) return { transfer: t, replayed: true, late: t.status === 'LATE_CONFIRMED', moneyTransactionId: null as string | null };
    throw new HttpError(409, 'Transfer already confirmed');
  }
  const late = t.status === 'FAILED' || t.status === 'EXPIRED';
  if (!late) assertTransition(t, 'CONFIRMED');
  const amount = t.direction === 'TO_MACHINE' ? t.amount_cents : cents(input.confirmedAmountCents ?? t.amount_cents);
  if (amount <= 0) throw new HttpError(400, 'Confirmed amount must be positive');
  if (t.direction === 'TO_MACHINE' && input.confirmedAmountCents !== undefined && input.confirmedAmountCents !== t.amount_cents)
    throw new HttpError(409, 'A wallet to machine transfer is confirmed for its full amount');
  const type = t.direction === 'FROM_MACHINE' ? 'MACHINE_TO_WALLET' as const : late ? 'WALLET_TO_MACHINE_LATE_CONFIRM' as const : 'WALLET_TO_MACHINE_CONFIRM' as const;
  const r = await executeMoneyTransaction(db, {
    orgId: a.orgId, type, ctx: ledgerCtx(t, amount), dedupeKey: entityDedupeKey('transfer', t.id, 'confirm'), actor: moneyActor(a),
    sourceEventId: input.ackEventId ?? null, businessDate: input.businessDate ?? null, latePosting: input.latePosting ?? null, reason: late ? `Confirmed after ${t.status}` : null,
  });
  const updated = await db.query(
    `UPDATE wallet_transfers SET status = $4, confirmed_amount_cents = $2, ack_event_id = $3, completed_at = now() WHERE id = $1 RETURNING *`,
    [t.id, amount, input.ackEventId ?? null, late ? 'LATE_CONFIRMED' : 'CONFIRMED'],
  );
  await audit(db, a, late ? 'cashless.transfer_late_confirmed' : 'cashless.transfer_confirmed', 'wallet_transfer', t.id, { direction: t.direction, amountCents: amount, previousStatus: t.status, transactionId: r.transaction.id });
  return { transfer: updated.rows[0] as TransferRow, replayed: false, late, moneyTransactionId: r.transaction.id as string };
}

/** FAILED or EXPIRED: a reserved amount goes back to the wallet's available balance. */
export async function endTransfer(db: Db, a: Actor, transferId: string, to: 'FAILED' | 'EXPIRED', reason: string) {
  const t = await lockTransfer(db, a.orgId, transferId);
  if (t.status === to) return t;
  assertTransition(t, to);
  if (t.direction === 'TO_MACHINE') {
    await executeMoneyTransaction(db, { orgId: a.orgId, type: 'WALLET_TO_MACHINE_RELEASE', ctx: ledgerCtx(t, t.amount_cents), dedupeKey: entityDedupeKey('transfer', t.id, 'release'), actor: moneyActor(a), reason });
  }
  const r = await db.query(`UPDATE wallet_transfers SET status = $2, failure_reason = $3, completed_at = now() WHERE id = $1 RETURNING *`, [t.id, to, reason]);
  await audit(db, a, `cashless.transfer_${to.toLowerCase()}`, 'wallet_transfer', t.id, { reason });
  return r.rows[0] as TransferRow;
}

/** Background job: expires transfers past their deadline (and releases reservations). */
export async function expireStaleTransfers(db: Db, limit = 50) {
  const due = await db.query(
    `SELECT id, org_id FROM wallet_transfers WHERE status IN ('REQUESTED', 'SENT') AND expires_at < now() ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  for (const row of due.rows) await endTransfer(db, { orgId: row.org_id }, row.id, 'EXPIRED', 'timeout');
  return due.rowCount ?? 0;
}
