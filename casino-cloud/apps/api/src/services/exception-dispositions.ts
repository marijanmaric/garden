import { writeAudit, type PoolClient } from '@m1/database';
import { cents, type AccountRef } from '@m1/shared';
import { HttpError, stateError } from '../auth';
import { consumeApproval, decideApproval, requestApproval } from './approvals';
import { entityDedupeKey, executeMoneyTransaction } from './ledger';
import type { Actor } from './players';

/**
 * V1: the financial disposition of a machine event exception (migration 014), separate from its explanation.
 *
 * A credit-changing money event of a machine on the MACHINE ledger that could not be booked leaves the
 * machine's credit meter and its MACHINE_CREDIT account apart. The machine's settlement stays blocked until
 * the event has a disposition; an explanation never releases it. Two dispositions, both four eyes
 * (requester and approver differ, also a database check), executed atomically on approval:
 *
 *   CORRECTION      the event's money is booked as an ADJUSTMENT of this event, amount = the amount the
 *                   machine reported. Only where the accounting follows from the event:
 *                     TITO_OUT  credit left the machine as a ticket the ledger does not know:
 *                               MACHINE_CREDIT (debit) -> TITO_EXCEPTION (credit, ticket value under investigation)
 *                     TITO_IN   a ticket the ledger does not know put credit on the machine:
 *                               TITO_EXCEPTION (debit) -> MACHINE_CREDIT (credit)  (as TITO_EXCEPTION does)
 *   NO_MONEY_MOVED  attestation with evidence that the event moved no money (e.g. a duplicate ack). Refused
 *                   for a ticket event with an amount: the machine reported that its credit changed.
 *
 * Anything else (e.g. a hopper payout the ledger hopper cannot cover) has no correction rule here: the
 * settlement stays blocked and the case is escalated. Nothing is ever deleted or rewritten.
 */

type Db = Pick<PoolClient, 'query'>;
type ScopedActor = Actor & { casinoIds: string[] };
export type DispositionKind = 'CORRECTION' | 'NO_MONEY_MOVED';

const CORRECTION_RULE: Record<string, { debit: 'MACHINE_CREDIT' | 'TITO_EXCEPTION'; credit: 'MACHINE_CREDIT' | 'TITO_EXCEPTION' }> = {
  TITO_OUT: { debit: 'MACHINE_CREDIT', credit: 'TITO_EXCEPTION' },
  TITO_IN: { debit: 'TITO_EXCEPTION', credit: 'MACHINE_CREDIT' },
};

async function loadException(db: Db, orgId: string, eventId: string) {
  const x = (await db.query(
    `SELECT x.*, e.amount, machine_exception_needs_disposition(x.event_id) AS needs,
       (SELECT kind FROM machine_event_dispositions d WHERE d.event_id = x.event_id) AS disposition
     FROM machine_event_exceptions x JOIN machine_events e ON e.event_id = x.event_id WHERE x.event_id = $1 AND x.org_id = $2`,
    [eventId, orgId])).rows[0];
  if (!x) throw new HttpError(404, 'Machine event exception not found');
  return { ...x, amountCents: x.amount === null ? null : Math.round(Number(x.amount) * 100) } as {
    event_id: string; org_id: string; casino_id: string; machine_id: string; event_type: string; code: string;
    needs: boolean; disposition: string | null; amountCents: number | null;
  };
}

/** The checks of a disposition, run on the request and again on its execution. */
function validate(x: Awaited<ReturnType<typeof loadException>>, kind: DispositionKind, amountCents: number | null) {
  if (!x.needs) throw new HttpError(409, 'This exception moved no machine credit on the ledger: explain it in reconciliation');
  if (x.disposition) throw new HttpError(409, `This exception already has a disposition (${x.disposition})`);
  const ticketWithAmount = (x.event_type === 'TITO_OUT' || x.event_type === 'TITO_IN') && (x.amountCents ?? 0) > 0;
  if (kind === 'NO_MONEY_MOVED' && ticketWithAmount)
    throw stateError(409, 'DISPOSITION_NOT_ALLOWED', `The machine reported a ticket of ${x.amountCents} cents: its credit changed. Book the correction`);
  if (kind === 'CORRECTION') {
    if (!CORRECTION_RULE[x.event_type] || !ticketWithAmount)
      throw stateError(409, 'DISPOSITION_NOT_ALLOWED', `No correction rule for ${x.event_type} without a reported amount: settlement stays blocked, escalate`);
    if (amountCents !== x.amountCents) throw new HttpError(422, `The correction amount must equal the amount the machine reported (${x.amountCents} cents)`);
  }
}

/** Step 1 (four eyes): requested by one person, executed when a different person approves. */
export async function requestDisposition(db: Db, a: ScopedActor, eventId: string, input: { kind: DispositionKind; reason: string; evidenceRef: string; amountCents?: number | null }) {
  const x = await loadException(db, a.orgId, eventId);
  if (!a.casinoIds.includes(x.casino_id)) throw new HttpError(404, 'Machine event exception not found');
  validate(x, input.kind, input.amountCents ?? null);
  const open = await db.query(
    `SELECT 1 FROM approvals WHERE org_id = $1 AND action = 'MACHINE_EXCEPTION_DISPOSITION' AND entity_id = $2 AND status IN ('PENDING', 'APPROVED') AND expires_at > now()`,
    [a.orgId, eventId]);
  if (open.rowCount) throw new HttpError(409, 'A disposition of this exception is already waiting for approval');
  return requestApproval(db, a, {
    casinoId: x.casino_id, action: 'MACHINE_EXCEPTION_DISPOSITION', entityType: 'machine_event', entityId: eventId,
    amountCents: input.kind === 'CORRECTION' ? x.amountCents! : undefined,
    payload: { kind: input.kind, reason: input.reason, evidenceRef: input.evidenceRef, eventType: x.event_type, code: x.code, machineId: x.machine_id },
  });
}

/** Step 2: the decision of a different person; on approval the posting and the disposition commit together. */
export async function decideDisposition(db: Db, a: ScopedActor, approvalId: string, decision: 'APPROVED' | 'REJECTED', note?: string) {
  const ap = await decideApproval(db, a, approvalId, decision, note);
  if (ap.action !== 'MACHINE_EXCEPTION_DISPOSITION') throw new HttpError(409, 'Not an exception disposition');
  if (decision === 'REJECTED') return { approval: ap, disposition: null, moneyTransaction: null };
  const eventId = ap.entity_id as string;
  // Serialises with the machine's event ingest and credit-meter settlement (same row lock).
  await db.query('SELECT 1 FROM machines m JOIN machine_event_exceptions x ON x.machine_id = m.id WHERE x.event_id = $1 FOR UPDATE OF m', [eventId]);
  const x = await loadException(db, a.orgId, eventId);
  const kind = ap.payload.kind as DispositionKind;
  validate(x, kind, ap.amount_cents === null ? null : Number(ap.amount_cents));

  let moneyTransaction = null;
  if (kind === 'CORRECTION') {
    const rule = CORRECTION_RULE[x.event_type];
    const ref = (k: 'MACHINE_CREDIT' | 'TITO_EXCEPTION'): AccountRef => (k === 'MACHINE_CREDIT' ? { kind: k, casinoId: x.casino_id, machineId: x.machine_id } : { kind: k, casinoId: x.casino_id });
    const r = await executeMoneyTransaction(db, {
      orgId: a.orgId, type: 'ADJUSTMENT', dedupeKey: entityDedupeKey('machine_event', eventId, 'correction'),
      actor: { type: 'EMPLOYEE', employeeId: ap.requested_by }, approvedBy: a.employeeId, sourceEventId: eventId,
      reason: `Correction of machine event exception ${x.code} (${x.event_type}): ${ap.payload.reason} [evidence: ${ap.payload.evidenceRef}]`,
      ctx: { casinoId: x.casino_id, machineId: x.machine_id, amountCents: cents(x.amountCents!), debit: ref(rule.debit), credit: ref(rule.credit) },
    });
    if (r.replayed) throw new HttpError(409, 'This exception was already corrected');
    moneyTransaction = r.transaction;
  }
  const disposition = (await db.query(
    `INSERT INTO machine_event_dispositions (event_id, org_id, casino_id, machine_id, kind, reason, evidence_ref, money_transaction_id, approval_id, requested_by, approved_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [eventId, a.orgId, x.casino_id, x.machine_id, kind, ap.payload.reason, ap.payload.evidenceRef, moneyTransaction?.id ?? null, ap.id, ap.requested_by, a.employeeId],
  )).rows[0];
  await consumeApproval(db, a, ap.id, { action: 'MACHINE_EXCEPTION_DISPOSITION', entityId: eventId, moneyTransactionId: moneyTransaction?.id ?? null });
  await writeAudit(db as PoolClient, {
    orgId: a.orgId, casinoId: x.casino_id, actorType: 'EMPLOYEE', actorId: a.employeeId, actorName: a.employeeEmail ?? null, ip: a.ip ?? null,
    action: 'machine_event.disposition', entityType: 'machine_event', entityId: eventId,
    details: { kind, eventType: x.event_type, code: x.code, machineId: x.machine_id, amountCents: kind === 'CORRECTION' ? x.amountCents : null, reason: ap.payload.reason,
      evidenceRef: ap.payload.evidenceRef, requestedBy: ap.requested_by, approvedBy: a.employeeId, approvalId: ap.id, moneyTransactionId: moneyTransaction?.id ?? null },
  });
  return { approval: ap, disposition, moneyTransaction };
}
