import { after, before } from 'node:test';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { assignPlan, createEmptyDatabase, insertLegacyData } from './helpers';
import { createLedgerCasino } from './ledger-casino';
import { registerStep7eScenarios, type Ctx7e } from './step7e-scenarios';

/**
 * Step 7e on a realistic upgraded database (legacy data written at 004, upgraded to today's schema): the
 * operator views run on a ledger test casino of the upgraded organisation, next to its legacy casino.
 */
const name = 'casino_step7e_upgrade';
let app: FastifyInstance;
let pool: pg.Pool;
let ctx: Ctx7e;
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
  const casino = await createLedgerCasino(pool, { orgId: legacy.org, code: '7E-U', machines: 4, gateway: true, vaultCents: 50_000_000 });
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


registerStep7eScenarios(() => ctx);
