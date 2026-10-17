import type { PoolClient } from '@m1/database';
import { hasPermission, type Role } from '@m1/shared';
import { HttpError } from '../auth';
import { expectedCollection } from './collections';
import { drawerLegacyBalance } from './cutover';
import { getBalance } from './ledger';

/**
 * Step 7e: blind counting, enforced by the API.
 *
 * The first count of a vault, a machine cashbox or a cutover drawer is blind: whoever may count such a
 * target (cash.manage; a drawer by the cashier of its shift) gets no expected amount and no balance that
 * reveals it from any response. The expected amount (always the authoritative calculation:
 * services/collections.ts, the vault / drawer ledger balance, the cutover legacy balance) is disclosed only
 * in the review of a count that was already submitted, and only to a different, authorized employee, who
 * then confirms it (verification with the same total: the approved settlement runs) or rejects it with a
 * different count of their own (mismatch: nothing is booked, the counter counts again).
 */
type Db = Pick<PoolClient, 'query'>;

export interface Viewer { orgId: string; employeeId: string; role: Role | string; casinoIds: string[] }

const REVIEWABLE = ['VAULT_OPEN', 'VAULT_CLOSE', 'MACHINE_DROP', 'VAULT_CUTOVER', 'DRAWER_CUTOVER'] as const;

/** Balances of count targets (vault, machine cashbox, drawer) are never shown to a role that counts them. */
export const countsTargets = (role: Role | string) => hasPermission(role as Role, 'cash.manage');

export async function reviewCount(db: Db, v: Viewer, countId: string) {
  if (!hasPermission(v.role as Role, 'cash.manage')) throw new HttpError(403, 'Missing permission cash.manage');
  const c = (await db.query(
    `SELECT c.*, e.name AS counted_by_name, m.asset_no, vt.name AS vault_name, d.name AS desk_name,
       EXISTS (SELECT 1 FROM count_settlements s WHERE s.count_id = c.id) AS settled,
       EXISTS (SELECT 1 FROM cash_count_verifications x WHERE x.count_id = c.id AND x.matches) AS verified,
       (SELECT count(*)::int FROM cash_count_verifications x WHERE x.count_id = c.id AND NOT x.matches) AS mismatches,
       (SELECT vs.vault_id FROM vault_sessions vs WHERE vs.id = c.vault_session_id) AS session_vault_id
     FROM cash_counts c JOIN employees e ON e.id = c.counted_by
     LEFT JOIN machines m ON m.id = c.machine_id LEFT JOIN vaults vt ON vt.id = COALESCE(c.vault_id, (SELECT vault_id FROM vault_sessions WHERE id = c.vault_session_id))
     LEFT JOIN cash_desks d ON d.id = c.cash_desk_id
     WHERE c.id = $1 AND c.org_id = $2`, [countId, v.orgId])).rows[0];
  if (!c || !v.casinoIds.includes(c.casino_id)) throw new HttpError(404, 'Count not found');
  if (!(REVIEWABLE as readonly string[]).includes(c.context)) throw new HttpError(409, 'This count is not reviewed here');
  if (c.counted_by === v.employeeId) throw new HttpError(403, 'Blind count: the counter cannot see the expected amount of the own count');
  if (c.settled || c.verified) throw new HttpError(409, 'Count already verified');

  let expectedCents: number | null = null;
  let basis: string;
  if (c.context === 'MACHINE_DROP') {
    const e = await expectedCollection(db, v.orgId, c.machine_id, { until: c.created_at });
    expectedCents = e.cashCents;
    basis = e.basis;
  } else if (c.context === 'VAULT_OPEN' || c.context === 'VAULT_CLOSE') {
    expectedCents = Number(await getBalance(db as never, v.orgId, { kind: 'VAULT', casinoId: c.casino_id, vaultId: c.session_vault_id } as never));
    basis = 'LEDGER_VAULT';
  } else if (c.context === 'DRAWER_CUTOVER') {
    expectedCents = await drawerLegacyBalance(db, c.casino_id, c.cash_desk_id);
    basis = 'LEGACY_DRAWER';
  } else basis = 'OPENING_COUNT'; // VAULT_CUTOVER: the opening of the vault on the ledger is the count itself
  const counted = Number(c.total_cents);
  return {
    countId: c.id, context: c.context, basis,
    target: c.asset_no ?? c.vault_name ?? c.desk_name ?? null,
    countedBy: c.counted_by, countedByName: c.counted_by_name, countedAt: c.created_at,
    countedCents: counted, expectedCents, differenceCents: expectedCents === null ? null : counted - expectedCents,
    mismatches: c.mismatches,
  };
}

/**
 * The machine's pending (latest, unverified) collection count submitted by someone else: the only case in
 * which the expected collection may be shown to this viewer.
 */
export async function reviewableMachineCount(db: Db, v: Viewer, machineId: string): Promise<string | null> {
  const r = (await db.query(
    `SELECT c.id, c.counted_by,
       EXISTS (SELECT 1 FROM count_settlements s WHERE s.count_id = c.id)
         OR EXISTS (SELECT 1 FROM cash_count_verifications x WHERE x.count_id = c.id AND x.matches) AS done
     FROM cash_counts c WHERE c.machine_id = $1 AND c.org_id = $2 AND c.context = 'MACHINE_DROP'
     ORDER BY c.created_at DESC, c.id DESC LIMIT 1`, [machineId, v.orgId])).rows[0];
  return r && !r.done && r.counted_by !== v.employeeId ? r.id : null;
}
