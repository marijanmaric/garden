import { writeAudit, type PoolClient } from '@m1/database';
import type { BusMessage } from '../bus';
import { HttpError } from '../auth';
import { openAlert } from './alerts';

/**
 * Step 7d: the money part of a machine event that cannot be booked (duplicate barcode, unknown transfer,
 * insufficient hopper, ...) is a deterministic business rejection, never an HTTP 500 and never a fake
 * booking. The machine event itself stays stored (it is a physical fact); an immutable exception record
 * says why no money moved; it is audited and alerted, and reconciliation reports it until two employees
 * explain it (item key machine_event:<event id>). A resend of the event is a duplicate (event id).
 */

export interface ExceptionEvent {
  orgId: string;
  casinoId: string;
  machineId: string;
  eventId: string;
  type: string;
  label: string;
}

export type ExceptionRail = 'HANDPAY' | 'TITO' | 'MACHINE' | 'CASHLESS';

export async function recordEventException(db: PoolClient, ev: ExceptionEvent, rail: ExceptionRail, code: string, message: string, out: BusMessage[]) {
  const r = await db.query(
    `INSERT INTO machine_event_exceptions (event_id, org_id, casino_id, machine_id, rail, event_type, code, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
    [ev.eventId, ev.orgId, ev.casinoId, ev.machineId, rail, ev.type, code, message],
  );
  if (!r.rowCount) return;
  await writeAudit(db, {
    orgId: ev.orgId, casinoId: ev.casinoId, actorType: 'SYSTEM', actorId: null, actorName: 'ingest',
    action: 'machine_event.rejected', entityType: 'machine_event', entityId: ev.eventId, details: { rail, type: ev.type, machineId: ev.machineId, code, message },
  });
  await openAlert(db, { orgId: ev.orgId, casinoId: ev.casinoId, machineId: ev.machineId, type: 'MACHINE_EVENT_REJECTED', severity: 'CRITICAL', message: `${ev.label} ${ev.type}: ${message} (no money booked)` }, out);
}

/**
 * Runs the money part of a machine event in a savepoint. An expected domain error (HttpError) rolls the
 * money part back and becomes an exception record; anything else (a bug, a lost connection) still fails
 * the event's transaction so the gateway resends it.
 */
export async function withEventException<T>(db: PoolClient, ev: ExceptionEvent, rail: ExceptionRail, out: BusMessage[], fn: () => Promise<T>): Promise<T | null> {
  await db.query('SAVEPOINT machine_event_money');
  const mark = out.length;
  try {
    const r = await fn();
    await db.query('RELEASE SAVEPOINT machine_event_money');
    return r;
  } catch (err) {
    // business refusals: service errors, and database rule refusals (raised exception, unique / check violation)
    const code = (err as { code?: string }).code;
    if (!(err instanceof HttpError) && code !== 'P0001' && code !== '23505' && code !== '23514') throw err;
    await db.query('ROLLBACK TO SAVEPOINT machine_event_money');
    out.length = mark; // alerts of the rolled back part never happened
    await recordEventException(db, ev, rail, err instanceof HttpError ? `HTTP_${err.statusCode}` : `DB_${code}`, (err as Error).message, out);
    return null;
  }
}
