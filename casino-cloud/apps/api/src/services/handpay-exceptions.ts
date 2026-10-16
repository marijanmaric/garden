import { writeAudit, type PoolClient } from '@m1/database';
import { HttpError } from '../auth';
import { consumeApproval, decideApproval, requestApproval } from './approvals';
import type { CashActor } from './cash-ops';
import { railOnLedger } from './rails';

/**
 * Legacy handpay exceptions: a HANDPAY cash payment from before Step 1 has no jackpot event id, so it
 * cannot be mapped to a jackpot deterministically. It is never matched by amount or time. Instead two
 * different employees classify it with evidence (reviewer 1 proposes, reviewer 2 decides through the
 * approvals system):
 *   LINK        the payment paid this jackpot event (same machine, same amount, event before payment,
 *               event not paid otherwise) -> the event's handpay becomes PAID by that legacy payment;
 *   HISTORICAL  a settled historical payment without an open handpay;
 *   DISPUTED    unclear: documented with evidence; any loss is corrected later by a four-eyes adjustment.
 * No classification creates ledger money or a cash movement: the payment happened in the past and is
 * already part of the legacy drawer history. The HANDPAY cutover requires every such payment classified.
 */

type Db = Pick<PoolClient, 'query'>;
export type ExceptionResolution = 'LINK' | 'HISTORICAL' | 'DISPUTED';

async function event(db: Db, orgId: string, exceptionId: string, action: string, employeeId: string | null, details: Record<string, unknown> = {}) {
  await db.query('INSERT INTO handpay_exception_events (org_id, exception_id, action, employee_id, details) VALUES ($1,$2,$3,$4,$5)', [orgId, exceptionId, action, employeeId, details]);
}

async function audit(db: Db, a: CashActor, casinoId: string, action: string, id: string, details: Record<string, unknown>) {
  await writeAudit(db as PoolClient, { orgId: a.orgId, casinoId, actorType: 'EMPLOYEE', actorId: a.employeeId, actorName: a.employeeEmail ?? null, ip: a.ip ?? null, action, entityType: 'handpay_exception', entityId: id, details });
}

/** Opens one exception per legacy HANDPAY payment without jackpot event id (idempotent). */
export async function detectLegacyHandpayExceptions(db: Db, a: CashActor, casinoId: string) {
  if (!a.casinoIds.includes(casinoId)) throw new HttpError(404, 'Casino not found');
  const created = (await db.query(
    `INSERT INTO handpay_legacy_exceptions (org_id, casino_id, cash_transaction_id, machine_id, amount_cents)
     SELECT ct.org_id, ct.casino_id, ct.id, ct.machine_id, -round(ct.amount * 100)::bigint FROM cash_transactions ct
     WHERE ct.org_id = $1 AND ct.casino_id = $2 AND ct.type = 'HANDPAY' AND ct.source_event_id IS NULL
     ON CONFLICT (cash_transaction_id) DO NOTHING RETURNING id`,
    [a.orgId, casinoId],
  )).rows;
  for (const r of created) await event(db, a.orgId, r.id, 'DETECTED', a.employeeId);
  if (created.length) await audit(db, a, casinoId, 'handpay_exception.detected', casinoId, { count: created.length });
  return (await db.query('SELECT * FROM handpay_legacy_exceptions WHERE org_id = $1 AND casino_id = $2 ORDER BY created_at, cash_transaction_id', [a.orgId, casinoId])).rows;
}

/** LINK is allowed only when it is fully determined by the data; otherwise a 409 says why. */
async function validateLink(db: Db, x: Record<string, any>, eventId: string) {
  const ct = (await db.query('SELECT * FROM cash_transactions WHERE id = $1', [x.cash_transaction_id])).rows[0];
  const e = (await db.query(`SELECT event_id, machine_id, type, round(amount * 100)::bigint AS cents, occurred_at FROM machine_events WHERE event_id = $1 AND org_id = $2`, [eventId, x.org_id])).rows[0];
  if (!e || e.type !== 'JACKPOT') throw new HttpError(409, 'LINK: not a jackpot event');
  if (!ct.machine_id || ct.machine_id !== e.machine_id) throw new HttpError(409, 'LINK: the payment and the jackpot belong to different machines');
  if (Number(e.cents) !== Number(x.amount_cents)) throw new HttpError(409, 'LINK: the payment amount differs from the jackpot amount');
  if (new Date(e.occurred_at) > new Date(ct.created_at)) throw new HttpError(409, 'LINK: the jackpot happened after the payment');
  const paid = await db.query(
    `SELECT 1 FROM cash_transactions WHERE source_event_id = $1
     UNION ALL SELECT 1 FROM handpays WHERE source_event_id = $1 AND status IN ('PAID', 'MACHINE_RESET', 'VOIDED')
     UNION ALL SELECT 1 FROM handpay_legacy_exceptions WHERE linked_event_id = $1 AND status = 'APPROVED' AND resolution = 'LINK' AND id <> $2`,
    [eventId, x.id]);
  if (paid.rowCount) throw new HttpError(409, 'LINK: this jackpot is already paid, voided or linked');
}

/** Reviewer 1: proposes a classification with evidence; creates the approval request for reviewer 2. */
export async function proposeException(
  db: Db,
  a: CashActor,
  id: string,
  input: { resolution: ExceptionResolution; jackpotEventId?: string; evidenceReference: string; evidenceHash?: string; justification: string },
) {
  const x = (await db.query('SELECT * FROM handpay_legacy_exceptions WHERE id = $1 AND org_id = $2 FOR UPDATE', [id, a.orgId])).rows[0];
  if (!x || !a.casinoIds.includes(x.casino_id)) throw new HttpError(404, 'Exception not found');
  if (x.status !== 'OPEN' && x.status !== 'REJECTED') throw new HttpError(409, `Exception is ${x.status}`);
  if (!input.evidenceReference || input.evidenceReference.trim().length < 3) throw new HttpError(400, 'Evidence is required');
  if (!input.justification || input.justification.trim().length < 20) throw new HttpError(400, 'A justification of at least 20 characters is required');
  if (input.resolution === 'LINK') {
    if (!input.jackpotEventId) throw new HttpError(400, 'LINK needs the jackpot event');
    await validateLink(db, x, input.jackpotEventId);
  } else if (input.jackpotEventId) throw new HttpError(400, 'Only LINK takes a jackpot event');
  if (await railOnLedger(db, a.orgId, 'HANDPAY', x.casino_id)) throw new HttpError(409, 'HANDPAY is already on the ledger');
  const ap = await requestApproval(db, a, { casinoId: x.casino_id, action: 'HANDPAY_EXCEPTION', entityType: 'handpay_exception', entityId: id, amountCents: Number(x.amount_cents), payload: { resolution: input.resolution, jackpotEventId: input.jackpotEventId ?? null } });
  const r = (await db.query(
    `UPDATE handpay_legacy_exceptions SET status = 'PROPOSED', resolution = $2, linked_event_id = $3, evidence_reference = $4, evidence_hash = $5, justification = $6,
       proposed_by = $7, proposed_at = now(), approval_id = $8, decided_by = NULL, decided_at = NULL WHERE id = $1 RETURNING *`,
    [id, input.resolution, input.jackpotEventId ?? null, input.evidenceReference, input.evidenceHash ?? null, input.justification, a.employeeId, ap.id])).rows[0];
  await event(db, a.orgId, id, 'PROPOSED', a.employeeId, { resolution: input.resolution, jackpotEventId: input.jackpotEventId ?? null, evidenceReference: input.evidenceReference, approvalId: ap.id });
  await audit(db, a, x.casino_id, 'handpay_exception.proposed', id, { resolution: input.resolution, approvalId: ap.id });
  return r;
}

/** Reviewer 2 (a different employee): approves or rejects the proposal. LINK pays the linked handpay record. */
export async function decideException(db: Db, a: CashActor, approvalId: string, decision: 'APPROVED' | 'REJECTED', note?: string) {
  const ap = await decideApproval(db, a, approvalId, decision, note);
  if (ap.action !== 'HANDPAY_EXCEPTION') throw new HttpError(409, 'Not a handpay exception');
  const x = (await db.query('SELECT * FROM handpay_legacy_exceptions WHERE id = $1 FOR UPDATE', [ap.entity_id])).rows[0];
  if (x.status !== 'PROPOSED' || x.approval_id !== approvalId) throw new HttpError(409, 'The exception is not waiting for this approval');
  if (decision === 'REJECTED') {
    const r = (await db.query(`UPDATE handpay_legacy_exceptions SET status = 'REJECTED', decided_by = $2, decided_at = now() WHERE id = $1 RETURNING *`, [x.id, a.employeeId])).rows[0];
    await event(db, a.orgId, x.id, 'REJECTED', a.employeeId, { note: note ?? null });
    await audit(db, a, x.casino_id, 'handpay_exception.rejected', x.id, {});
    return { exception: r, handpay: null };
  }
  if (await railOnLedger(db, a.orgId, 'HANDPAY', x.casino_id)) throw new HttpError(409, 'HANDPAY is already on the ledger');
  let handpayId: string | null = null;
  if (x.resolution === 'LINK') {
    await validateLink(db, x, x.linked_event_id);
    const ct = (await db.query('SELECT * FROM cash_transactions WHERE id = $1', [x.cash_transaction_id])).rows[0];
    let h = (await db.query('SELECT * FROM handpays WHERE source_event_id = $1 FOR UPDATE', [x.linked_event_id])).rows[0];
    if (!h) {
      h = (await db.query(
        `INSERT INTO handpays (org_id, casino_id, machine_id, source_event_id, kind, amount_cents, status, paid_by, paid_at, pay_method, cashier_session_id, legacy_cash_transaction_id, approved_at, created_at)
         SELECT $1, e.casino_id, e.machine_id, e.event_id, 'JACKPOT', $3, 'PAID', $4, $5, 'CASH', $6, $7, $5, e.occurred_at FROM machine_events e WHERE e.event_id = $2 RETURNING *`,
        [x.org_id, x.linked_event_id, x.amount_cents, ct.employee_id, ct.created_at, ct.session_id, ct.id])).rows[0];
    } else {
      if (h.status === 'PENDING') h = (await db.query(`UPDATE handpays SET status = 'APPROVED', approved_at = $2 WHERE id = $1 RETURNING *`, [h.id, ct.created_at])).rows[0];
      h = (await db.query(
        `UPDATE handpays SET status = 'PAID', paid_by = $2, paid_at = $3, pay_method = 'CASH', cashier_session_id = $4, legacy_cash_transaction_id = $5 WHERE id = $1 RETURNING *`,
        [h.id, ct.employee_id, ct.created_at, ct.session_id, ct.id])).rows[0];
    }
    await db.query('INSERT INTO handpay_events (org_id, handpay_id, action, to_status, employee_id, details) VALUES ($1,$2,$3,$4,$5,$6)',
      [x.org_id, h.id, 'LEGACY_PAYMENT_LINKED', 'PAID', a.employeeId, { exceptionId: x.id, cashTransactionId: ct.id }]);
    handpayId = h.id;
  }
  const r = (await db.query(`UPDATE handpay_legacy_exceptions SET status = 'APPROVED', decided_by = $2, decided_at = now(), linked_handpay_id = $3 WHERE id = $1 RETURNING *`, [x.id, a.employeeId, handpayId])).rows[0];
  await consumeApproval(db, a, approvalId, { action: 'HANDPAY_EXCEPTION', entityId: x.id });
  await event(db, a.orgId, x.id, 'APPROVED', a.employeeId, { resolution: x.resolution, handpayId });
  await audit(db, a, x.casino_id, 'handpay_exception.approved', x.id, { resolution: x.resolution, handpayId });
  return { exception: r, handpay: handpayId };
}
