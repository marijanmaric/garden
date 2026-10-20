import type { PoolClient } from '@m1/database';
import type { CutoverRail } from '@m1/shared';
import { stateError } from '../auth';

type Db = Pick<PoolClient, 'query'>;

/** Is the rail on the ledger (its cutover committed)? No cutover = legacy money. */
export async function railOnLedger(db: Db, orgId: string, rail: CutoverRail, casinoId?: string | null, machineId?: string | null): Promise<boolean> {
  const r = await db.query('SELECT money_rail_ledger($1, $2, $3, $4) AS ledger', [orgId, casinoId ?? null, rail, machineId ?? null]);
  return r.rows[0].ledger;
}

/** Ledger-only rails (cashless) move money only after their cutover. */
export async function requireRailOnLedger(db: Db, orgId: string, rail: CutoverRail, casinoId?: string | null, machineId?: string | null) {
  if (!(await railOnLedger(db, orgId, rail, casinoId, machineId))) throw stateError(409, 'RAIL_LEGACY', `${rail} money is not on the ledger yet (cutover pending)`);
}

/**
 * F3: is the rail IN USE in the casino? Its module is contracted (purchased + enabled, regardless of the
 * subscription state), or legacy money records of it exist. Decides whether a workflow prerequisite
 * (CUTOVER_WORKFLOW_PREREQUISITES) applies; never grants anything.
 */
export async function railInUse(db: Db, orgId: string, rail: CutoverRail, casinoId: string | null): Promise<{ inUse: boolean; module: boolean; records: number }> {
  const { loadEntitlements } = await import('./entitlements');
  const module = (await loadEntitlements(orgId, db, true, false)).inUse.has(rail);
  const sql: Partial<Record<CutoverRail, string>> = {
    CASH: `SELECT count(*) AS n FROM cashier_sessions WHERE org_id = $1 AND casino_id = $2`, // every cash transaction belongs to a session
    TITO: `SELECT count(*) AS n FROM tickets WHERE org_id = $1 AND casino_id = $2`,
    HANDPAY: `SELECT count(*) AS n FROM handpays WHERE org_id = $1 AND casino_id = $2`,
  };
  const records = sql[rail] && casinoId ? Number((await db.query(sql[rail]!, [orgId, casinoId])).rows[0].n) : 0;
  return { inUse: module || records > 0, module, records };
}
