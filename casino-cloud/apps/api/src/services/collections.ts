import type { PoolClient } from '@m1/database';
import { CASHBOX_IN_EVENT_TYPES } from '@m1/shared';
import { getBalance } from './ledger';

/**
 * The one definition of the expected machine collection (cashbox drop). Used by the collection view
 * (/cash/collections/expected), the legacy collection booking (/cash/collections) and the MACHINE
 * cutover check, so the screen, the legacy flow and the cutover can never disagree.
 *
 *   MACHINE on the ledger: the machine's CASHBOX ledger balance. It is what a ledger collection is
 *     settled against (verifyCollectionCount: MACHINE_DROP + MACHINE_DROP_DIFFERENCE) and what
 *     reconciliation checks; hopper fills / payouts (HOPPER), vault and drawer movements do not touch it.
 *   MACHINE still LEGACY: the cash the machine itself reported (CASH_IN / COIN_IN machine events,
 *     received since the last collection), the basis of the approved MACHINE cutover opening.
 *
 * Tickets: paper TITO accepted since the last collection (machine-reported TITO_IN / TICKET_IN); the
 * ticket money itself is settled at acceptance (TITO rail), so tickets never change the cash expectation.
 */
type Db = Pick<PoolClient, 'query'>;

export interface ExpectedCollection {
  machineId: string;
  basis: 'LEDGER_CASHBOX' | 'MACHINE_EVENTS';
  since: string | null;
  cashCents: number;
  ticketsCents: number;
}

const TICKET_IN_EVENT_TYPES = ['TITO_IN', 'TICKET_IN'];

export async function expectedCollection(db: Db, orgId: string, machineId: string, opts: { until?: string | Date } = {}): Promise<ExpectedCollection> {
  const m = (await db.query(
    `SELECT m.casino_id, (SELECT as_of FROM money_rail_cutovers c WHERE c.rail = 'MACHINE' AND c.machine_id = m.id) AS ledger_since,
       (SELECT max(period_end) FROM cash_collections WHERE machine_id = m.id) AS last_collection
     FROM machines m WHERE m.id = $1 AND m.org_id = $2`, [machineId, orgId])).rows[0];
  if (m.ledger_since) {
    const since = m.last_collection && new Date(m.last_collection) > new Date(m.ledger_since) ? m.last_collection : m.ledger_since;
    const cashCents = await getBalance(db as never, orgId, { kind: 'CASHBOX', casinoId: m.casino_id, machineId } as never);
    const t = (await db.query(
      `SELECT COALESCE(sum(round(e.amount * 100)), 0)::bigint AS c FROM machine_events e WHERE e.machine_id = $1 AND e.type = ANY($2) AND e.received_at > $3`,
      [machineId, TICKET_IN_EVENT_TYPES, since])).rows[0];
    return { machineId, basis: 'LEDGER_CASHBOX', since, cashCents: Number(cashCents), ticketsCents: Number(t.c) };
  }
  const r = (await db.query(
    `SELECT round(COALESCE((SELECT sum(e.amount) FROM machine_events e WHERE e.machine_id = $1 AND e.type = ANY($2)
         AND e.received_at > COALESCE($3::timestamptz, '-infinity') AND e.received_at <= COALESCE($5::timestamptz, 'infinity')), 0) * 100)::bigint AS cash_cents,
       round(COALESCE((SELECT sum(e.amount) FROM machine_events e WHERE e.machine_id = $1 AND e.type = ANY($4)
         AND e.received_at > COALESCE($3::timestamptz, '-infinity') AND e.received_at <= COALESCE($5::timestamptz, 'infinity')), 0) * 100)::bigint AS tickets_cents`,
    [machineId, [...CASHBOX_IN_EVENT_TYPES], m.last_collection, TICKET_IN_EVENT_TYPES, opts.until ?? null])).rows[0];
  return { machineId, basis: 'MACHINE_EVENTS', since: m.last_collection, cashCents: Number(r.cash_cents), ticketsCents: Number(r.tickets_cents) };
}
