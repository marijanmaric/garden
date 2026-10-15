import { writeAudit, type PoolClient } from '@m1/database';
import { HANDPAY_TRANSITIONS, type HandpayStatus } from '@m1/shared';
import { HttpError } from '../auth';
import { addCashTx, requireOpenSession } from './cashier';
import type { Actor } from './players';

/**
 * Handpay entity: one per jackpot event (unique source_event_id).
 * PENDING -> APPROVED -> PAID -> MACHINE_RESET, or VOIDED before payment.
 * Payment never waits for the machine: the reset is requested separately and confirmed later.
 * The money itself is still paid through the legacy cash_transactions (Step 1 unique index
 * remains in force) until handpays move onto the ledger in a later step.
 */

type Db = Pick<PoolClient, 'query'>;

export interface HandpayRow {
  id: string;
  org_id: string;
  casino_id: string;
  machine_id: string;
  source_event_id: string;
  amount_cents: number;
  status: HandpayStatus;
  approved_by: string | null;
  paid_by: string | null;
  reset_confirmed_at: string | null;
}

async function event(db: Db, h: { id: string; org_id: string }, action: string, from: string | null, to: string | null, employeeId?: string | null, details: Record<string, unknown> = {}) {
  await db.query('INSERT INTO handpay_events (org_id, handpay_id, action, from_status, to_status, employee_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    h.org_id, h.id, action, from, to, employeeId ?? null, details,
  ]);
}

function audit(db: Db, a: Actor, action: string, h: HandpayRow, details: Record<string, unknown> = {}) {
  return writeAudit(db as PoolClient, {
    orgId: a.orgId, casinoId: h.casino_id, actorType: a.employeeId ? 'EMPLOYEE' : 'SYSTEM', actorId: a.employeeId ?? null, actorName: a.employeeEmail ?? 'system',
    action, entityType: 'handpay', entityId: h.id, details: { machineId: h.machine_id, amountCents: h.amount_cents, ...details },
  });
}

function assertTransition(h: HandpayRow, to: HandpayStatus) {
  if (h.status === to) throw new HttpError(409, `Handpay is already ${to}`);
  if (h.status === 'PAID' || h.status === 'MACHINE_RESET') throw new HttpError(409, 'Handpay already paid');
  if (!HANDPAY_TRANSITIONS.can(h.status, to)) throw new HttpError(409, `Handpay cannot change from ${h.status} to ${to}`);
}

/** Creates the handpay for a jackpot event (idempotent: one handpay per event). */
export async function ensureHandpayForJackpot(db: Db, input: { orgId: string; casinoId: string; machineId: string; eventId: string; amountCents: number }) {
  const r = await db.query(
    `INSERT INTO handpays (org_id, casino_id, machine_id, source_event_id, kind, amount_cents) VALUES ($1,$2,$3,$4,'JACKPOT',$5)
     ON CONFLICT ON CONSTRAINT handpays_one_per_event DO NOTHING RETURNING *`,
    [input.orgId, input.casinoId, input.machineId, input.eventId, input.amountCents],
  );
  if (r.rowCount) await event(db, r.rows[0], 'CREATED', null, 'PENDING');
  return r.rows[0] as HandpayRow | undefined;
}

export async function lockHandpay(db: Db, orgId: string, handpayId: string): Promise<HandpayRow> {
  const r = await db.query('SELECT * FROM handpays WHERE id = $1 AND org_id = $2 FOR UPDATE', [handpayId, orgId]);
  if (!r.rowCount) throw new HttpError(404, 'Handpay not found');
  return r.rows[0];
}

/** Supervisor approval. The approver may not be the person who pays (database check). */
export async function approveHandpay(db: Db, a: Actor, handpayId: string, approvalId?: string | null) {
  if (!a.employeeId) throw new HttpError(400, 'An employee must approve');
  const h = await lockHandpay(db, a.orgId, handpayId);
  assertTransition(h, 'APPROVED');
  const r = await db.query(
    `UPDATE handpays SET status = 'APPROVED', approved_by = $2, approved_at = now(), approval_id = $3 WHERE id = $1 RETURNING *`,
    [h.id, a.employeeId, approvalId ?? null],
  );
  await event(db, h, 'APPROVED', h.status, 'APPROVED', a.employeeId);
  await audit(db, a, 'handpay.approved', h);
  return r.rows[0] as HandpayRow;
}

/** Whether a handpay of this amount needs supervisor approval (casino setting; NULL = never). */
async function approvalRequired(db: Db, h: HandpayRow) {
  const limit = (await db.query('SELECT handpay_approval_cents FROM casino_money_settings WHERE casino_id = $1', [h.casino_id])).rows[0]?.handpay_approval_cents;
  return limit !== null && limit !== undefined && h.amount_cents >= limit;
}

/**
 * Pays a handpay in cash from the cashier's drawer (legacy money record) and requests the
 * machine reset. Below the approval limit a PENDING handpay is approved implicitly.
 */
export async function payHandpay(db: Db, a: Actor, handpayId: string, opts: { playerId?: string | null } = {}) {
  if (!a.employeeId) throw new HttpError(400, 'An employee must pay');
  const session = await requireOpenSession(db as PoolClient, a.orgId, a.employeeId);
  let h = await lockHandpay(db, a.orgId, handpayId);
  if (h.casino_id !== session.casino_id) throw new HttpError(409, 'Handpay belongs to another casino');
  if (h.status === 'PENDING') {
    if (await approvalRequired(db, h)) throw new HttpError(409, 'Supervisor approval required for this handpay');
    h = (await db.query(`UPDATE handpays SET status = 'APPROVED', approved_at = now() WHERE id = $1 RETURNING *`, [h.id])).rows[0];
    await event(db, h, 'APPROVED', 'PENDING', 'APPROVED', null, { automatic: true, reason: 'below approval limit' });
  }
  assertTransition(h, 'PAID');
  if (h.approved_by && h.approved_by === a.employeeId) throw new HttpError(409, 'The approver cannot pay the same handpay');
  const machine = (await db.query('SELECT asset_no, gateway_id FROM machines WHERE id = $1', [h.machine_id])).rows[0];
  let tx;
  try {
    tx = await addCashTx(db as PoolClient, session, 'HANDPAY', h.amount_cents / 100, {
      machineId: h.machine_id, playerId: opts.playerId ?? undefined, reference: `Jackpot ${machine.asset_no}`, sourceEventId: h.source_event_id,
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'Handpay already paid');
    throw err;
  }
  const resetDone = !!h.reset_confirmed_at;
  let paid = (await db.query(
    `UPDATE handpays SET status = 'PAID', paid_by = $2, paid_at = now(), pay_method = 'CASH', cashier_session_id = $3, legacy_cash_transaction_id = $4, player_id = COALESCE($5, player_id)
     WHERE id = $1 RETURNING *`,
    [h.id, a.employeeId, session.id, tx.id, opts.playerId ?? null],
  )).rows[0] as HandpayRow;
  await event(db, h, 'PAID', 'APPROVED', 'PAID', a.employeeId, { cashTransactionId: tx.id });
  if (resetDone) {
    paid = (await db.query(`UPDATE handpays SET status = 'MACHINE_RESET' WHERE id = $1 RETURNING *`, [h.id])).rows[0];
    await event(db, h, 'RESET_CONFIRMED', 'PAID', 'MACHINE_RESET', null, { before: 'payment' });
  } else {
    await requestReset(db, paid, machine.gateway_id, a.employeeId);
  }
  await audit(db, a, 'handpay.paid', paid, { cashTransactionId: tx.id });
  return { handpay: paid, transaction: tx };
}

async function requestReset(db: Db, h: HandpayRow, gatewayId: string | null, employeeId: string | null) {
  if (!gatewayId) return;
  await db.query(
    `INSERT INTO machine_commands (org_id, machine_id, gateway_id, type, payload, requested_by, handpay_id) VALUES ($1,$2,$3,'RESET_JACKPOT',$4,$5,$6)`,
    [h.org_id, h.machine_id, gatewayId, { jackpotEventId: h.source_event_id }, employeeId, h.id],
  );
  await db.query('UPDATE handpays SET reset_requested_at = now(), reset_attempts = reset_attempts + 1 WHERE id = $1', [h.id]);
  await event(db, h, 'RESET_REQUESTED', null, null, employeeId);
}

/**
 * The machine was reset (JACKPOT_RESET event or confirmed command). A paid handpay becomes
 * MACHINE_RESET; an unpaid one only records the reset and stays payable.
 */
export async function confirmHandpayReset(db: Db, input: { orgId: string; machineId: string; handpayId?: string | null }) {
  const r = await db.query(
    `SELECT * FROM handpays WHERE org_id = $1 AND machine_id = $2 AND ($3::uuid IS NULL OR id = $3) AND reset_confirmed_at IS NULL
       AND status IN ('PENDING', 'APPROVED', 'PAID') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [input.orgId, input.machineId, input.handpayId ?? null],
  );
  const h = r.rows[0] as HandpayRow | undefined;
  if (!h) return null;
  const next = h.status === 'PAID' ? 'MACHINE_RESET' : h.status;
  const u = await db.query('UPDATE handpays SET reset_confirmed_at = now(), status = $2 WHERE id = $1 RETURNING *', [h.id, next]);
  await event(db, h, 'RESET_CONFIRMED', h.status, next);
  return u.rows[0] as HandpayRow;
}

export async function voidHandpay(db: Db, a: Actor, handpayId: string, reason: string) {
  if (!reason || reason.trim().length < 3) throw new HttpError(400, 'A reason is required');
  const h = await lockHandpay(db, a.orgId, handpayId);
  assertTransition(h, 'VOIDED');
  const r = await db.query(`UPDATE handpays SET status = 'VOIDED', voided_by = $2, voided_at = now(), void_reason = $3 WHERE id = $1 RETURNING *`, [h.id, a.employeeId ?? null, reason]);
  await event(db, h, 'VOIDED', h.status, 'VOIDED', a.employeeId, { reason });
  await audit(db, a, 'handpay.voided', h, { reason });
  return r.rows[0] as HandpayRow;
}

/** Background job: re-requests resets of paid handpays whose last reset command failed. */
export async function retryFailedHandpayResets(db: Db, maxAttempts = 10) {
  const due = await db.query(
    `SELECT h.*, m.gateway_id FROM handpays h JOIN machines m ON m.id = h.machine_id
     WHERE h.status = 'PAID' AND h.reset_confirmed_at IS NULL AND h.reset_attempts < $1
       AND NOT EXISTS (SELECT 1 FROM machine_commands c WHERE c.handpay_id = h.id AND c.status IN ('PENDING', 'SENT'))
       AND EXISTS (SELECT 1 FROM machine_commands c WHERE c.handpay_id = h.id AND c.status = 'FAILED')
     FOR UPDATE OF h SKIP LOCKED`,
    [maxAttempts],
  );
  for (const h of due.rows) await requestReset(db, h, h.gateway_id, null);
  return due.rowCount ?? 0;
}
