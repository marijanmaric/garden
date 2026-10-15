import { writeAudit, type PoolClient } from '@m1/database';
import { APPROVAL_TRANSITIONS, type ApprovalStatus } from '@m1/shared';
import { HttpError } from '../auth';
import type { Actor } from './players';

/** Four-eyes approvals. The decider must differ from the requester (also a database check). */

type Db = Pick<PoolClient, 'query'>;

export async function requestApproval(
  db: Db,
  a: Actor,
  input: { casinoId: string; action: string; entityType?: string; entityId?: string; amountCents?: number; payload?: Record<string, unknown> },
) {
  if (!a.employeeId) throw new HttpError(400, 'An employee must request approvals');
  const r = await db.query(
    `INSERT INTO approvals (org_id, casino_id, action, entity_type, entity_id, amount_cents, payload, requested_by)
     SELECT $1, c.id, $3, $4, $5, $6, $7, $8 FROM casinos c WHERE c.id = $2 AND c.org_id = $1 RETURNING *`,
    [a.orgId, input.casinoId, input.action, input.entityType ?? null, input.entityId ?? null, input.amountCents ?? null, input.payload ?? {}, a.employeeId],
  );
  if (!r.rowCount) throw new HttpError(404, 'Casino not found');
  await writeAudit(db as PoolClient, { orgId: a.orgId, casinoId: input.casinoId, actorType: 'EMPLOYEE', actorId: a.employeeId, actorName: a.employeeEmail ?? null, action: 'approval.requested', entityType: 'approval', entityId: r.rows[0].id, details: { action: input.action, entityType: input.entityType, entityId: input.entityId } });
  return r.rows[0];
}

async function lock(db: Db, orgId: string, id: string) {
  const r = await db.query('SELECT * FROM approvals WHERE id = $1 AND org_id = $2 FOR UPDATE', [id, orgId]);
  if (!r.rowCount) throw new HttpError(404, 'Approval not found');
  return r.rows[0];
}

function move(from: ApprovalStatus, to: ApprovalStatus) {
  if (!APPROVAL_TRANSITIONS.can(from, to)) throw new HttpError(409, `Approval cannot change from ${from} to ${to}`);
}

export async function decideApproval(db: Db, a: Actor, id: string, decision: 'APPROVED' | 'REJECTED', note?: string) {
  if (!a.employeeId) throw new HttpError(400, 'An employee must decide');
  const ap = await lock(db, a.orgId, id);
  if (ap.status === 'PENDING' && new Date(ap.expires_at) < new Date()) {
    await db.query(`UPDATE approvals SET status = 'EXPIRED' WHERE id = $1`, [id]);
    throw new HttpError(409, 'Approval request expired');
  }
  move(ap.status, decision);
  if (ap.requested_by === a.employeeId) throw new HttpError(409, 'The requester cannot approve their own request');
  const r = await db.query(`UPDATE approvals SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1 RETURNING *`, [id, decision, a.employeeId, note ?? null]);
  await writeAudit(db as PoolClient, { orgId: a.orgId, casinoId: ap.casino_id, actorType: 'EMPLOYEE', actorId: a.employeeId, actorName: a.employeeEmail ?? null, action: `approval.${decision.toLowerCase()}`, entityType: 'approval', entityId: id, details: { action: ap.action } });
  return r.rows[0];
}

/** Uses an approval exactly once for the action / entity it was granted for. */
export async function consumeApproval(db: Db, a: Actor, id: string, expect: { action: string; entityId?: string; moneyTransactionId?: string | null }) {
  const ap = await lock(db, a.orgId, id);
  if (ap.action !== expect.action || (expect.entityId && ap.entity_id !== expect.entityId)) throw new HttpError(409, 'Approval was granted for a different action');
  move(ap.status, 'EXECUTED');
  return (await db.query(`UPDATE approvals SET status = 'EXECUTED', executed_at = now(), money_transaction_id = $2 WHERE id = $1 RETURNING *`, [id, expect.moneyTransactionId ?? null])).rows[0];
}
