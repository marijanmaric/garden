import type { PoolClient } from '@m1/database';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../auth';

/**
 * TITO hold: SCAN -> VALIDATE -> HOLD -> ACCEPT -> COMMIT. This step provides validate, hold and
 * release (incl. timeout recovery). COMMIT (redemption with money) is the machine's TITO_IN event (Step 7c, tito.ts).
 * A hold is an atomic conditional update: only one caller can hold a VALID ticket.
 */

type Db = Pick<PoolClient, 'query'>;

export type HoldRejection = 'UNKNOWN_TICKET' | 'TICKET_NOT_VALID' | 'TICKET_EXPIRED' | 'OTHER_CASINO';

export async function holdTicket(db: Db, input: { orgId: string; barcode: string; machineId: string }) {
  const m = await db.query('SELECT id, casino_id FROM machines WHERE id = $1 AND org_id = $2', [input.machineId, input.orgId]);
  if (!m.rowCount) throw new HttpError(404, 'Machine not found');
  const casinoId = m.rows[0].casino_id;
  const holdId = randomUUID();
  const r = await db.query(
    `UPDATE tickets t SET status = 'HELD', hold_id = $4, hold_source = 'MACHINE', hold_machine_id = $3,
       hold_until = now() + make_interval(secs => COALESCE((SELECT tito_hold_seconds FROM casino_money_settings s WHERE s.casino_id = t.casino_id), 30))
     WHERE t.org_id = $1 AND t.casino_id = $5 AND t.barcode = $2 AND t.status = 'VALID' AND t.expires_at > now()
     RETURNING t.id, t.amount_cents, t.hold_id, t.hold_until`,
    [input.orgId, input.barcode, input.machineId, holdId, casinoId],
  );
  if (r.rowCount) {
    await db.query(`INSERT INTO ticket_events (org_id, ticket_id, action, machine_id, details) VALUES ($1,$2,'HELD',$3,$4)`, [input.orgId, r.rows[0].id, input.machineId, { holdId }]);
    return { ok: true as const, ticketId: r.rows[0].id as string, amountCents: r.rows[0].amount_cents as number, holdId, holdUntil: r.rows[0].hold_until as string };
  }
  const t = (await db.query('SELECT casino_id, status, expires_at FROM tickets WHERE org_id = $1 AND barcode = $2', [input.orgId, input.barcode])).rows[0];
  const reason: HoldRejection = !t ? 'UNKNOWN_TICKET' : t.casino_id !== casinoId ? 'OTHER_CASINO' : t.status !== 'VALID' ? 'TICKET_NOT_VALID' : 'TICKET_EXPIRED';
  return { ok: false as const, reason };
}

/** Machine rejected / did not stack the ticket: back to VALID. Idempotent per hold id. */
export async function releaseTicketHold(db: Db, input: { orgId: string; holdId: string; reason: string }) {
  const r = await db.query(
    `UPDATE tickets SET status = 'VALID', hold_id = NULL, hold_until = NULL, hold_machine_id = NULL, hold_source = NULL
     WHERE org_id = $1 AND hold_id = $2 AND status = 'HELD' RETURNING id`,
    [input.orgId, input.holdId],
  );
  if (r.rowCount) await db.query(`INSERT INTO ticket_events (org_id, ticket_id, action, details) VALUES ($1,$2,'RELEASED',$3)`, [input.orgId, r.rows[0].id, { holdId: input.holdId, reason: input.reason }]);
  return r.rowCount === 1;
}

/** Background job: holds past hold_until + grace go back to VALID, so no ticket stays locked. */
export async function releaseExpiredHolds(db: Db) {
  const r = await db.query(
    `UPDATE tickets t SET status = 'VALID', hold_id = NULL, hold_until = NULL, hold_machine_id = NULL, hold_source = NULL
     WHERE t.status = 'HELD' AND t.hold_until + make_interval(secs => COALESCE((SELECT tito_hold_grace_seconds FROM casino_money_settings s WHERE s.casino_id = t.casino_id), 120)) < now()
       -- the machine's accept ack is recorded but deferred (TITO frozen): the hold stays until the replay commits it
       AND NOT EXISTS (SELECT 1 FROM deferred_money_events d JOIN machine_events e ON e.event_id = d.event_id
                       WHERE d.status = 'PENDING' AND d.kind = 'TITO_IN' AND e.payload->>'holdId' = t.hold_id::text)
     RETURNING t.id, t.org_id`,
  );
  for (const row of r.rows) await db.query(`INSERT INTO ticket_events (org_id, ticket_id, action, details) VALUES ($1,$2,'HOLD_EXPIRED','{}')`, [row.org_id, row.id]);
  return r.rowCount ?? 0;
}
