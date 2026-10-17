import { writeAudit, type PoolClient } from '@m1/database';
import { HttpError } from '../auth';
import type { BusMessage } from '../bus';
import { consumeApproval, decideApproval, requestApproval } from './approvals';
import { recordEventException } from './event-exceptions';
import { ensureHandpayForJackpot } from './handpays';
import { deferredToEvent, processMachineEvent } from './machine-money';
import type { LatePosting } from './ledger';
import type { Actor } from './players';
import { processTitoEvent } from './tito';

/**
 * Step 7d (D4): the explicit late-event process. A deferred money event whose economic business date
 * (occurred_at) is already closed is never booked on that date and never moved silently: two employees
 * decide to book it on the current open business date. The deferred record keeps the original
 * business_date and records booked_business_date and the approval; the booking references the event.
 */

type Db = Pick<PoolClient, 'query'>;
type ScopedActor = Actor & { casinoIds: string[] };

async function lockDeferred(db: Db, a: ScopedActor, eventId: string) {
  const d = (await db.query(
    `SELECT d.*, d.business_date::text AS business_date, e.payload, m.asset_no,
       EXISTS (SELECT 1 FROM business_day_closes b WHERE b.casino_id = d.casino_id AND b.business_date = d.business_date) AS closed,
       (now() AT TIME ZONE c.timezone)::date::text AS today
     FROM deferred_money_events d JOIN machine_events e ON e.event_id = d.event_id JOIN machines m ON m.id = d.machine_id JOIN casinos c ON c.id = d.casino_id
     WHERE d.event_id = $1 AND d.org_id = $2 FOR UPDATE OF d`, [eventId, a.orgId])).rows[0];
  if (!d || !a.casinoIds.includes(d.casino_id)) throw new HttpError(404, 'Deferred event not found');
  if (d.status !== 'PENDING') throw new HttpError(409, 'Deferred event already processed');
  if (!d.closed) throw new HttpError(409, `Business date ${d.business_date} is not closed: the event is booked on it by the normal replay`);
  return d;
}

/** Step 1: request the late booking of one deferred event of a closed business date (with a reason). */
export async function requestLateEventBooking(db: Db, a: ScopedActor, eventId: string, reason: string) {
  if (!reason || reason.trim().length < 10) throw new HttpError(400, 'A reason of at least 10 characters is required');
  const d = await lockDeferred(db, a, eventId);
  const open = await db.query(`SELECT * FROM approvals WHERE action = 'LATE_EVENT_BOOKING' AND entity_id = $1 AND status IN ('PENDING', 'APPROVED') AND expires_at > now()`, [eventId]);
  if (open.rowCount) return open.rows[0];
  return requestApproval(db, a, {
    casinoId: d.casino_id, action: 'LATE_EVENT_BOOKING', entityType: 'machine_event', entityId: eventId, amountCents: Number(d.amount_cents),
    payload: { reason, rail: d.rail, kind: d.kind, originalBusinessDate: d.business_date, occurredAt: d.occurred_at, receivedAt: d.received_at },
  });
}

/** Step 2: a different employee decides; on approval the event is booked now, on today's open business date. */
export async function decideLateEventBooking(db: PoolClient, a: ScopedActor, approvalId: string, decision: 'APPROVED' | 'REJECTED', note?: string, out: BusMessage[] = []) {
  const ap = await decideApproval(db, a, approvalId, decision, note);
  if (ap.action !== 'LATE_EVENT_BOOKING') throw new HttpError(409, 'Not a late-event booking');
  if (decision === 'REJECTED') return { approval: ap, booking: null };
  const d = await lockDeferred(db, a, ap.entity_id);
  // The posting itself carries the original event, its dates, the reason and both people (validated by the ledger).
  const late: LatePosting = {
    approvalId: ap.id, originalBusinessDate: d.business_date, occurredAt: new Date(d.occurred_at).toISOString(), receivedAt: new Date(d.received_at).toISOString(),
    reason: String(ap.payload?.reason ?? ''), requestedBy: ap.requested_by, approvedBy: a.employeeId!,
  };
  let moneyTransactionId: string | null = null;
  let handpayId: string | null = null;
  let ticketId: string | null = null;
  if (d.rail === 'HANDPAY') {
    let h = await ensureHandpayForJackpot(db, { orgId: d.org_id, casinoId: d.casino_id, machineId: d.machine_id, eventId: d.event_id, amountCents: Number(d.amount_cents), latePosting: late });
    if (!h) h = (await db.query('SELECT * FROM handpays WHERE source_event_id = $1', [d.event_id])).rows[0];
    handpayId = h!.id;
    moneyTransactionId = (await db.query(`SELECT id FROM money_transactions WHERE handpay_id = $1 AND type = 'HANDPAY_CREATE_JACKPOT'`, [h!.id])).rows[0]?.id ?? null;
  } else if (d.rail === 'TITO') {
    const ev = {
      orgId: d.org_id, casinoId: d.casino_id, machineId: d.machine_id, label: d.asset_no, eventId: d.event_id, type: d.kind,
      barcode: d.payload?.ticketBarcode ?? null, holdId: d.payload?.holdId ?? null, amountCents: Number(d.amount_cents), occurredAt: d.occurred_at,
    };
    const r = await processTitoEvent(db, ev, null, out, late);
    if (r.outcome === 'DUPLICATE_BARCODE' || r.outcome === 'EXCEPTION_UNBOOKED')
      await recordEventException(db, ev, 'TITO', r.outcome, 'late ticket event cannot be booked', out);
    moneyTransactionId = r.moneyTransactionId;
    ticketId = r.ticketId;
  } else {
    moneyTransactionId = (await processMachineEvent(db, deferredToEvent(d), null, out, late)).moneyTransactionId;
  }
  await db.query(
    `UPDATE deferred_money_events SET status = 'PROCESSED', replayed_at = now(), attempts = attempts + 1, last_error = NULL,
       late_approval_id = $2, booked_business_date = $3::date, handpay_id = COALESCE($4, handpay_id), ticket_id = COALESCE($5, ticket_id), money_transaction_id = $6
     WHERE event_id = $1`,
    [d.event_id, ap.id, d.today, handpayId, ticketId, moneyTransactionId],
  );
  await consumeApproval(db, a, ap.id, { action: 'LATE_EVENT_BOOKING', entityId: d.event_id, moneyTransactionId });
  await writeAudit(db, {
    orgId: a.orgId, casinoId: d.casino_id, actorType: 'EMPLOYEE', actorId: a.employeeId ?? null, actorName: a.employeeEmail ?? null, ip: a.ip ?? null,
    action: 'money.late_event_booked', entityType: 'machine_event', entityId: d.event_id,
    details: { rail: d.rail, kind: d.kind, amountCents: Number(d.amount_cents), originalBusinessDate: d.business_date, bookedBusinessDate: d.today, approvalId: ap.id, requestedBy: ap.requested_by, moneyTransactionId },
  });
  return { approval: ap, booking: { eventId: d.event_id, originalBusinessDate: d.business_date, bookedBusinessDate: d.today, moneyTransactionId, handpayId, ticketId } };
}
