import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createEmptyDatabase, insertLegacyData } from './helpers';

/**
 * Migration 012 on an upgraded database: existing customers keep working with a safe default (plan CUSTOM +
 * exactly the modules their data shows in use, dependencies closed, each with its reason). Nobody receives an
 * unused paid module, nothing is deleted and no money transaction is created.
 */
const name = 'casino_saas_upgrade';
let pool: pg.Pool;
let legacy: Awaited<ReturnType<typeof insertLegacyData>>;
let emptyOrg: string;
const counts: Record<string, number> = {};
const MONEY = ['money_transactions', 'ledger_entries', 'tickets', 'handpays', 'cash_transactions', 'cashier_sessions', 'machines', 'casinos', 'employees', 'players', 'audit_logs'];

before(async () => {
  const url = await createEmptyDatabase(name);
  process.env.DATABASE_URL = url;
  process.env.LOG_LEVEL = 'silent';
  const db = await import('@m1/database');
  pool = db.createPool(url);
  await db.migrate(pool, () => {}, { until: '004_money_ledger.sql' });
  await db.syncMoneyModel(pool);
  legacy = await insertLegacyData(pool);
  emptyOrg = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Empty Org', 'empty') RETURNING id`)).rows[0].id;
  await db.migrate(pool, () => {}, { until: '011_machine_cashless_ledger.sql' });
  for (const t of MONEY) counts[t] = (await pool.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n;
  await db.migrate(pool, () => {});
  await db.syncRbac(pool);
});

after(async () => {
  await pool?.end();
});

test('012 derives safe defaults from real use: plan CUSTOM, overrides only for used modules (dependencies closed), each with a reason', async () => {
  const sub = (await pool.query('SELECT s.status, p.code FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.org_id = $1', [legacy.org])).rows[0];
  assert.deepEqual(sub, { status: 'ACTIVE', code: 'CUSTOM' });
  const ov = (await pool.query('SELECT module_key, entitled, reason FROM entitlement_overrides WHERE org_id = $1 ORDER BY module_key', [legacy.org])).rows;
  // legacy data: tickets, a Step 1 handpay cash transaction, a cashier shift -> TITO, HANDPAY, CASH (+ VAULT, required by Cash)
  assert.deepEqual(ov.map((r) => r.module_key), ['CASH', 'HANDPAY', 'TITO', 'VAULT']);
  assert.ok(ov.every((r) => r.entitled && r.reason.startsWith('migration 012:')));
  assert.equal((await pool.query('SELECT count(*)::int n FROM entitlement_overrides WHERE org_id = $1', [emptyOrg])).rows[0].n, 0, 'an organisation without use gets Core only');
  assert.equal((await pool.query('SELECT count(*)::int n FROM entitlement_overrides WHERE module_key IN ($1, $2)', ['CASHLESS', 'ADVANCED_RECONCILIATION'])).rows[0].n, 0, 'no unused paid module');
});

test('012 changes no money and deletes nothing; the effective modules load through the service', async () => {
  for (const t of MONEY.filter((x) => x !== 'audit_logs')) assert.equal((await pool.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n, counts[t], t);
  const { loadEntitlements } = await import('../src/services/entitlements');
  const e = await loadEntitlements(legacy.org, pool as never, true);
  assert.deepEqual([...e.effective].sort(), ['CASH', 'CORE', 'HANDPAY', 'TITO', 'VAULT']);
  const empty = await loadEntitlements(emptyOrg, pool as never, true);
  assert.deepEqual([...empty.effective], ['CORE']);
  // organisations, casinos and employees received the new lifecycle columns with safe values
  assert.equal((await pool.query(`SELECT count(*)::int n FROM organizations WHERE status <> 'ACTIVE' OR is_platform`)).rows[0].n, 0);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM casinos WHERE status <> 'ACTIVE'`)).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM employees WHERE is_platform_admin')).rows[0].n, 0);
  const { pool: apiPool } = await import('../src/db');
  await apiPool.end().catch(() => undefined);
});
