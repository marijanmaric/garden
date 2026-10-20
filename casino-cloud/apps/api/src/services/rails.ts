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
