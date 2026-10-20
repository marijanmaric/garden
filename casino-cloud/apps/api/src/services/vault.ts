import { writeAudit, type PoolClient } from '@m1/database';
import { VAULT_SESSION_TRANSITIONS, denominationTotal, type CashCountContext, type VaultSessionStatus } from '@m1/shared';
import { HttpError, stateError } from '../auth';
import type { Actor } from './players';
import { railOnLedger } from './rails';

/** Vault sessions and cash counts (entities only; vault money movements follow with the ledger). */

type Db = Pick<PoolClient, 'query'>;
type ScopedActor = Actor & { casinoIds: string[] };

export interface CountInput {
  denominations?: Record<string, number>;
  totalCents?: number;
  blind?: boolean;
  note?: string;
}

export function countTotal(c: CountInput): number {
  if (c.denominations) {
    const total = denominationTotal(c.denominations);
    if (c.totalCents !== undefined && c.totalCents !== total) throw new HttpError(400, 'Count total does not match the denominations');
    return total;
  }
  if (c.totalCents === undefined || !Number.isSafeInteger(c.totalCents) || c.totalCents < 0) throw new HttpError(400, 'A count total in cents is required');
  return c.totalCents;
}

export async function recordCashCount(
  db: Db,
  a: ScopedActor,
  input: CountInput & { casinoId: string; context: CashCountContext; vaultSessionId?: string; cashierSessionId?: string; machineId?: string; vaultId?: string; cashDeskId?: string },
) {
  if (!a.employeeId) throw new HttpError(400, 'An employee must count');
  if (!a.casinoIds.includes(input.casinoId)) throw new HttpError(404, 'Casino not found');
  const total = countTotal(input);
  const r = await db.query(
    `INSERT INTO cash_counts (org_id, casino_id, context, vault_session_id, cashier_session_id, machine_id, vault_id, cash_desk_id, total_cents, denominations, blind, counted_by, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [a.orgId, input.casinoId, input.context, input.vaultSessionId ?? null, input.cashierSessionId ?? null, input.machineId ?? null,
      input.vaultId ?? null, input.cashDeskId ?? null, total, input.denominations ?? null, !!input.blind, a.employeeId, input.note ?? null],
  );
  return r.rows[0];
}

async function lockSession(db: Db, a: ScopedActor, id: string) {
  const r = await db.query('SELECT * FROM vault_sessions WHERE id = $1 AND org_id = $2 FOR UPDATE', [id, a.orgId]);
  if (!r.rowCount || !a.casinoIds.includes(r.rows[0].casino_id)) throw new HttpError(404, 'Vault session not found');
  return r.rows[0];
}

function move(from: VaultSessionStatus, to: VaultSessionStatus) {
  if (!VAULT_SESSION_TRANSITIONS.can(from, to)) throw new HttpError(409, `Vault session cannot change from ${from} to ${to}`);
}

export async function openVaultSession(db: Db, a: ScopedActor, input: { vaultId: string; count: CountInput; note?: string }) {
  if (!a.employeeId) throw new HttpError(400, 'An employee must open the vault');
  const v = await db.query('SELECT id, casino_id FROM vaults WHERE id = $1 AND org_id = $2 AND active', [input.vaultId, a.orgId]);
  if (!v.rowCount || !a.casinoIds.includes(v.rows[0].casino_id)) throw new HttpError(404, 'Vault not found');
  const casinoId = v.rows[0].casino_id;
  // a vault on the ledger is operated together with the cash rail (its counts are verified by the cash services):
  // refuse before anything is created instead of leaving a session that can never be verified
  if ((await railOnLedger(db, a.orgId, 'VAULT', casinoId)) && !(await railOnLedger(db, a.orgId, 'CASH', casinoId)))
    throw stateError(409, 'RAIL_LEGACY', 'The vault is on the ledger but Cash is not: ledger vault operations need the CASH rail on the ledger');
  let s;
  try {
    s = (await db.query(
      `INSERT INTO vault_sessions (org_id, casino_id, vault_id, business_date, opened_by, note)
       SELECT $1, $2, $3, (now() AT TIME ZONE c.timezone)::date, $4, $5 FROM casinos c WHERE c.id = $2 RETURNING *`,
      [a.orgId, casinoId, input.vaultId, a.employeeId, input.note ?? null],
    )).rows[0];
  } catch (err) {
    if ((err as { constraint?: string }).constraint === 'vault_sessions_one_open_per_vault') throw new HttpError(409, 'Vault already has an open session');
    throw err;
  }
  // On the ledger the opening count is blind and takes effect only after a second, blind count (cash-ops).
  const onLedger = await railOnLedger(db, a.orgId, 'VAULT', casinoId);
  const count = await recordCashCount(db, a, { ...input.count, ...(onLedger ? { blind: true } : {}), casinoId, context: 'VAULT_OPEN', vaultSessionId: s.id });
  await writeAudit(db as PoolClient, { orgId: a.orgId, casinoId, actorType: 'EMPLOYEE', actorId: a.employeeId, actorName: a.employeeEmail ?? null, action: 'vault.session_opened', entityType: 'vault_session', entityId: s.id, details: { vaultId: input.vaultId, countId: count.id, totalCents: count.total_cents } });
  return { session: s, count };
}

export async function startVaultCount(db: Db, a: ScopedActor, sessionId: string) {
  const s = await lockSession(db, a, sessionId);
  move(s.status, 'COUNTING');
  const pending = await db.query(`SELECT 1 FROM cash_movements WHERE vault_session_id = $1 AND status = 'REQUESTED' LIMIT 1`, [sessionId]);
  if (pending.rowCount) throw new HttpError(409, 'Pending fills / drops must be confirmed or cancelled before the vault count');
  return (await db.query(`UPDATE vault_sessions SET status = 'COUNTING', counting_at = now() WHERE id = $1 RETURNING *`, [sessionId])).rows[0];
}

/** Closes the vault session with a (blind) closing count. */
export async function closeVaultSession(db: Db, a: ScopedActor, sessionId: string, count: CountInput) {
  const s = await lockSession(db, a, sessionId);
  move(s.status, 'CLOSED');
  const c = await recordCashCount(db, a, { blind: true, ...count, casinoId: s.casino_id, context: 'VAULT_CLOSE', vaultSessionId: s.id });
  // On the ledger the session closes only when a second employee verifies this count (cash-ops.verifyVaultCount).
  if (await railOnLedger(db, a.orgId, 'VAULT', s.casino_id)) return { session: s, count: c, pendingVerification: true };
  const r = await db.query(`UPDATE vault_sessions SET status = 'CLOSED', closed_by = $2, closed_at = now() WHERE id = $1 RETURNING *`, [sessionId, a.employeeId]);
  await writeAudit(db as PoolClient, { orgId: a.orgId, casinoId: s.casino_id, actorType: 'EMPLOYEE', actorId: a.employeeId ?? null, actorName: a.employeeEmail ?? null, action: 'vault.session_closed', entityType: 'vault_session', entityId: s.id, details: { countId: c.id, totalCents: c.total_cents } });
  return { session: r.rows[0], count: c };
}

/** Cashier session extension: attach a drawer shift to the vault session it is supplied from. */
export async function linkCashierSessionToVault(db: Db, a: ScopedActor, cashierSessionId: string, vaultSessionId: string) {
  const vs = await lockSession(db, a, vaultSessionId);
  if (vs.status === 'CLOSED') throw new HttpError(409, 'Vault session is closed');
  const r = await db.query('UPDATE cashier_sessions SET vault_session_id = $2 WHERE id = $1 AND org_id = $3 RETURNING *', [cashierSessionId, vaultSessionId, a.orgId]);
  if (!r.rowCount) throw new HttpError(404, 'Cashier session not found');
  return r.rows[0];
}
