import type { Pool } from 'pg';
import type { CutoverRail } from '@m1/shared';

/**
 * D7: a test casino whose rails are on the ledger through the REAL cutover mechanism (verified
 * physical counts, deterministic openings), so ledger tests run under the final rail guard.
 * Import after setupTestDatabase / DATABASE_URL (services create the pool at import).
 */
export interface LedgerCasino {
  id: string;
  orgId: string;
  vault: string;
  desk: string;
  machines: Array<{ id: string; code: string; asset: string }>;
}

const ALL: CutoverRail[] = ['VAULT', 'CASH', 'HANDPAY', 'TITO', 'CASHLESS', 'MACHINE'];

async function employees(pool: Pool, orgId: string) {
  const rows = (await pool.query('SELECT email, id FROM employees WHERE org_id = $1', [orgId])).rows;
  return Object.fromEntries(rows.map((r) => [r.email, r.id])) as Record<string, string>;
}

export async function createLedgerCasino(
  pool: Pool,
  opts: { orgId: string; code: string; rails?: CutoverRail[]; machines?: number; vaultCents?: number; counter?: string; verifier?: string },
): Promise<LedgerCasino> {
  const { withTransaction } = await import('@m1/database');
  const cutover = await import('../src/services/cutover');
  const rails = opts.rails ?? ALL;
  const emp = await employees(pool, opts.orgId);
  const counter = emp[opts.counter ?? 'manager@example.com'];
  const verifier = emp[opts.verifier ?? 'admin@example.com'];
  const q = async (sql: string, p: unknown[]) => (await pool.query(sql, p)).rows[0];

  const id = (await q(`INSERT INTO casinos (org_id, code, name) VALUES ($1,$2,$3) RETURNING id`, [opts.orgId, opts.code, `Ledger ${opts.code}`])).id;
  await pool.query('INSERT INTO casino_money_settings (casino_id, org_id) VALUES ($1,$2)', [id, opts.orgId]);
  const vault = (await q(`INSERT INTO vaults (org_id, casino_id, name) VALUES ($1,$2,'Main Vault') RETURNING id`, [opts.orgId, id])).id;
  const desk = (await q(`INSERT INTO cash_desks (org_id, casino_id, name) VALUES ($1,$2,'Ledger Cage') RETURNING id`, [opts.orgId, id])).id;
  for (const e of Object.values(emp)) await pool.query('INSERT INTO employee_casinos (employee_id, casino_id, org_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [e, id, opts.orgId]);
  const machines = [];
  for (let i = 1; i <= (opts.machines ?? 3); i++) {
    const code = `${opts.code}-${String(i).padStart(4, '0')}`;
    const m = await q(`INSERT INTO machines (org_id, casino_id, machine_code, asset_no) VALUES ($1,$2,$3,$4) RETURNING id`, [opts.orgId, id, code, `${opts.code}M${i}`]);
    machines.push({ id: m.id, code, asset: `${opts.code}M${i}` });
  }

  const as = (employeeId: string) => ({ orgId: opts.orgId, employeeId, casinoIds: [id] });
  const count = async (context: 'VAULT_CUTOVER' | 'DRAWER_CUTOVER' | 'MACHINE_DROP', ref: Record<string, string>, totalCents: number) => {
    const c = await withTransaction(pool as never, (db) => cutover.recordCutoverCount(db, as(counter), { casinoId: id, context, ...ref, totalCents }));
    await withTransaction(pool as never, (db) => cutover.verifyCutoverCount(db, as(verifier), c.id, { totalCents }));
  };
  const run = (rail: CutoverRail, target: Record<string, string> = { casinoId: id }) => cutover.runCutover(pool as never, as(verifier), { rail, ...target });

  if (rails.includes('VAULT')) {
    await count('VAULT_CUTOVER', { vaultId: vault }, opts.vaultCents ?? 100_000_000);
    await run('VAULT');
  }
  if (rails.includes('CASH')) {
    await count('DRAWER_CUTOVER', { cashDeskId: desk }, 0);
    await run('CASH');
  }
  if (rails.includes('HANDPAY')) await run('HANDPAY');
  if (rails.includes('TITO')) await run('TITO');
  if (rails.includes('CASHLESS')) await run('CASHLESS', {});
  if (rails.includes('MACHINE'))
    for (const m of machines) {
      await count('MACHINE_DROP', { machineId: m.id }, 0);
      await run('MACHINE', { machineId: m.id });
    }
  return { id, orgId: opts.orgId, vault, desk, machines };
}

/** Opens (and verifies) the vault session if needed: counter counts the ledger amount, verifier confirms blind. */
export async function ensureVaultOpen(pool: Pool, c: LedgerCasino, counterEmail = 'manager@example.com', verifierEmail = 'admin@example.com') {
  const { withTransaction } = await import('@m1/database');
  const vault = await import('../src/services/vault');
  const ops = await import('../src/services/cash-ops');
  const ledger = await import('../src/services/ledger');
  const emp = await employees(pool, c.orgId);
  const open = (await pool.query(`SELECT id FROM vault_sessions WHERE vault_id = $1 AND status IN ('OPEN', 'COUNTING')`, [c.vault])).rows[0];
  if (open) return open.id as string;
  const amount = await ledger.getBalance(pool as never, c.orgId, { kind: 'VAULT', casinoId: c.id, vaultId: c.vault });
  const actor = (e: string) => ({ orgId: c.orgId, employeeId: emp[e], employeeEmail: e, casinoIds: [c.id] });
  const s = await withTransaction(pool as never, (db) => vault.openVaultSession(db, actor(counterEmail), { vaultId: c.vault, count: { totalCents: amount } }));
  await withTransaction(pool as never, (db) => ops.verifyVaultCount(db, actor(verifierEmail), s.count.id, { totalCents: amount }));
  return s.session.id as string;
}

/** A ledger shift of `cashierEmail` with a float filled from the vault (issued by `vaultEmail`, confirmed by the cashier). */
export async function openLedgerShift(pool: Pool, c: LedgerCasino, opts: { cashierEmail: string; vaultEmail?: string; floatCents: number }) {
  const { withTransaction } = await import('@m1/database');
  const ops = await import('../src/services/cash-ops');
  const emp = await employees(pool, c.orgId);
  const vaultEmail = opts.vaultEmail ?? (opts.cashierEmail === 'admin@example.com' ? 'manager@example.com' : 'admin@example.com');
  await ensureVaultOpen(pool, c);
  let desk = (await pool.query(
    `SELECT d.id FROM cash_desks d WHERE d.casino_id = $1 AND NOT EXISTS (SELECT 1 FROM cashier_sessions s WHERE s.cash_desk_id = d.id AND s.status <> 'CLOSED') ORDER BY d.created_at LIMIT 1`, [c.id])).rows[0]?.id;
  if (!desk) desk = (await pool.query(`INSERT INTO cash_desks (org_id, casino_id, name) VALUES ($1,$2,$3) RETURNING id`, [c.orgId, c.id, `Desk ${Date.now()}`])).rows[0].id;
  const session = (await pool.query(
    `INSERT INTO cashier_sessions (org_id, casino_id, cash_desk_id, employee_id, opening_balance) VALUES ($1,$2,$3,$4,0) RETURNING id`,
    [c.orgId, c.id, desk, emp[opts.cashierEmail]])).rows[0].id as string;
  if (opts.floatCents > 0) {
    const actor = (e: string) => ({ orgId: c.orgId, employeeId: emp[e], employeeEmail: e, casinoIds: [c.id] });
    const { movement } = await withTransaction(pool as never, (db) => ops.requestMovement(db, actor(vaultEmail), { kind: 'FILL', cashierSessionId: session, amountCents: opts.floatCents, requestKey: `float-${session}` }));
    await withTransaction(pool as never, (db) => ops.confirmMovement(db, actor(opts.cashierEmail), movement.id, { totalCents: opts.floatCents }));
  }
  return session;
}
