import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { assignPlan, createEmptyDatabase, insertLegacyData } from './helpers';
import { createLedgerCasino, cutoverCasinoRails, type LedgerCasino } from './ledger-casino';
import { registerStep7dScenarios, type Ctx7d } from './step7d-scenarios';

/**
 * Step 7d on a realistic upgraded database (legacy data written at 004, upgraded to today's schema).
 * The shared scenarios run on a ledger test casino of the upgraded organisation (every rail, machines cut
 * over one by one); in addition the upgraded legacy casino goes through its maintenance window and then
 * cuts its legacy machine over to the ledger after a verified, empty collection.
 */
const name = 'casino_step7d_upgrade';
let app: FastifyInstance;
let pool: pg.Pool;
let ctx: Ctx7d;
let legacy: Awaited<ReturnType<typeof insertLegacyData>>;

before(async () => {
  const url = await createEmptyDatabase(name);
  process.env.DATABASE_URL = url;
  process.env.LOG_LEVEL = 'silent';
  const db = await import('@m1/database');
  pool = db.createPool(url);
  await db.migrate(pool, () => {}, { until: '004_money_ledger.sql' });
  await db.syncMoneyModel(pool);
  legacy = await insertLegacyData(pool);
  await db.migrate(pool, () => {});
  await db.syncRbac(pool);
  await db.syncMoneyModel(pool);
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
  const casino = await createLedgerCasino(pool, { orgId: legacy.org, code: '7D-U', machines: 8, gateway: true, vaultCents: 50_000_000 });
  await assignPlan(pool, legacy.org); // every rail is exercised: the plan is assigned explicitly
  const { buildApp } = await import('../src/app');
  app = await buildApp();
  await app.ready();
  const tokens: Record<string, string> = {};
  for (const e of Object.keys(roles)) tokens[e] = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: e, password: 'demo' } })).json().token;
  ctx = { app, pool, orgId: legacy.org, casino, emp, tokens };
});

after(async () => {
  await app?.close();
  await pool?.end();
  const { pool: apiPool } = await import('../src/db');
  await apiPool.end().catch(() => undefined);
});


registerStep7dScenarios(() => ctx);

test('upgraded legacy casino: window cutover, then a legacy machine moves to the MACHINE ledger after a verified collection', async () => {
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const ledger = await import('../src/services/ledger');
  await pool.query(`UPDATE cashier_sessions SET status = 'CLOSED', closed_at = now(), expected_balance = 950, counted_balance = 950, difference = 0 WHERE id = $1`, [legacy.session]);
  const desk = (await q('SELECT cash_desk_id FROM cashier_sessions WHERE id = $1', [legacy.session]))[0].cash_desk_id;
  const vault = (await q('SELECT id FROM vaults WHERE casino_id = $1', [legacy.casino]))[0].id;
  const machines = await q('SELECT id, machine_code AS code, asset_no AS asset FROM machines WHERE id = $1', [legacy.machine2]);
  const lc: LedgerCasino = { id: legacy.casino, orgId: legacy.org, vault, desk, machines };
  await cutoverCasinoRails(pool, lc, ['VAULT', 'CASH', 'HANDPAY', 'TITO'], { vaultCents: 1_000_000, deskCents: 95_000 });
  const before = (await q('SELECT count(*)::int n FROM machine_events WHERE machine_id = $1', [legacy.machine2]))[0].n;
  await cutoverCasinoRails(pool, lc, ['MACHINE']);
  const r = (await q(`SELECT money_rail_ledger($1, $2, 'MACHINE', $3) AS l`, [legacy.org, legacy.casino, legacy.machine2]))[0];
  assert.equal(r.l, true);
  for (const kind of ['MACHINE_CREDIT', 'CASHBOX', 'HOPPER'])
    assert.equal(await ledger.getBalance(pool as never, legacy.org, { kind, casinoId: legacy.casino, machineId: legacy.machine2 } as never), 0, kind);
  // legacy history of the machine is kept unchanged; a new money event needs its booking (guard)
  assert.equal((await q('SELECT count(*)::int n FROM machine_events WHERE machine_id = $1', [legacy.machine2]))[0].n, before);
  await assert.rejects(pool.query(`INSERT INTO machine_events (event_id, org_id, casino_id, machine_id, type, amount, occurred_at) VALUES (gen_random_uuid(),$1,$2,$3,'CASH_IN',5,now())`,
    [legacy.org, legacy.casino, legacy.machine2]), /machine money is on the ledger/);
  // the other legacy machine stays LEGACY: its cash events need no booking
  await pool.query(`INSERT INTO machine_events (event_id, org_id, casino_id, machine_id, type, amount, occurred_at) VALUES (gen_random_uuid(),$1,$2,$3,'CASH_IN',5,now())`, [legacy.org, legacy.casino, legacy.machine]);
  assert.equal((await ledger.checkLedgerInvariants(pool as never, legacy.org)).ok, true);
});
