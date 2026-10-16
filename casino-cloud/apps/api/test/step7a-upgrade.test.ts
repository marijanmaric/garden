import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { createEmptyDatabase, insertLegacyData } from './helpers';
import { registerStep7aScenarios, type Ctx7a } from './step7a-scenarios';

/**
 * Step 7a on a realistic upgraded database: legacy operational data written at 004 (open shift with
 * cash movements, paid and pending jackpots, tickets, gaming), upgraded to today's schema, then
 * VAULT and CASH cut over with verified counts. The same scenarios as on the fresh database.
 */
const name = 'casino_step7a_upgrade';
let app: FastifyInstance;
let pool: pg.Pool;
let ctx: Ctx7a;

before(async () => {
  const url = await createEmptyDatabase(name);
  process.env.DATABASE_URL = url;
  process.env.LOG_LEVEL = 'silent';
  const db = await import('@m1/database');
  pool = db.createPool(url);
  await db.migrate(pool, () => {}, { until: '004_money_ledger.sql' });
  await db.syncMoneyModel(pool);
  const legacy = await insertLegacyData(pool);
  await db.migrate(pool, () => {});
  await db.syncRbac(pool);
  await db.syncMoneyModel(pool);

  // Employees of the upgraded organisation (same roles as the demo tenant), access to its casino.
  const hash = await bcrypt.hash('demo', 4);
  const roles: Record<string, string> = {
    'admin@example.com': 'SUPER_ADMIN', 'manager@example.com': 'MANAGER', 'accounting@example.com': 'ACCOUNTING',
    'cashier@example.com': 'CASHIER', 'attendant@example.com': 'ATTENDANT', 'floor@example.com': 'FLOOR_SUPERVISOR', 'tech@example.com': 'TECHNICIAN',
  };
  const emp: Record<string, string> = {};
  for (const [email, role] of Object.entries(roles)) {
    emp[email] = (await pool.query(`INSERT INTO employees (org_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [legacy.org, email, email, hash, role])).rows[0].id;
    await pool.query('INSERT INTO employee_casinos (employee_id, casino_id, org_id) VALUES ($1,$2,$3)', [emp[email], legacy.casino, legacy.org]);
  }

  // The legacy shift is closed the legacy way (1000 + 250 - 300 = 950), then VAULT and CASH are cut over.
  await pool.query(`UPDATE cashier_sessions SET status = 'CLOSED', closed_at = now(), expected_balance = 950, counted_balance = 950, difference = 0 WHERE id = $1`, [legacy.session]);
  const cutover = await import('../src/services/cutover');
  const vaultId = (await pool.query('SELECT id FROM vaults WHERE casino_id = $1', [legacy.casino])).rows[0].id;
  const desk = (await pool.query('SELECT cash_desk_id FROM cashier_sessions WHERE id = $1', [legacy.session])).rows[0].cash_desk_id;
  const as = (e: string) => ({ orgId: legacy.org, employeeId: emp[e], employeeEmail: e, casinoIds: [legacy.casino] });
  const count = async (context: 'VAULT_CUTOVER' | 'DRAWER_CUTOVER', ref: Record<string, string>, totalCents: number) => {
    const c = await db.withTransaction(pool, (x) => cutover.recordCutoverCount(x, as('manager@example.com'), { casinoId: legacy.casino, context, ...ref, totalCents }));
    await db.withTransaction(pool, (x) => cutover.verifyCutoverCount(x, as('accounting@example.com'), c.id, { totalCents }));
  };
  await count('VAULT_CUTOVER', { vaultId }, 3_000_000);
  assert.equal((await cutover.runCutover(pool, as('admin@example.com'), { rail: 'VAULT', casinoId: legacy.casino })).ok, true);
  await count('DRAWER_CUTOVER', { cashDeskId: desk }, 95_000);
  assert.equal((await cutover.runCutover(pool, as('admin@example.com'), { rail: 'CASH', casinoId: legacy.casino })).ok, true);

  const desks = [];
  for (const n of [1, 2, 3]) desks.push((await pool.query(`INSERT INTO cash_desks (org_id, casino_id, name) VALUES ($1,$2,$3) RETURNING id`, [legacy.org, legacy.casino, `7a desk ${n}`])).rows[0].id);
  const { buildApp } = await import('../src/app');
  app = await buildApp();
  await app.ready();
  const tokens: Record<string, string> = {};
  for (const e of Object.keys(roles)) tokens[e] = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: e, password: 'demo' } })).json().token;
  ctx = { app, pool, orgId: legacy.org, casinoId: legacy.casino, vaultId, desks, emp, tokens };
});

after(async () => {
  await app?.close();
  await pool?.end();
  const { pool: apiPool } = await import('../src/db');
  await apiPool.end().catch(() => undefined);
});

registerStep7aScenarios(() => ctx);
