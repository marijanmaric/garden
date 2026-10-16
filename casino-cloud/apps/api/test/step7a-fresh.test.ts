import { after, before } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Pool } from '@m1/database';
import { setupTestDatabase } from './helpers';
import { createLedgerCasino } from './ledger-casino';
import { registerStep7aScenarios, type Ctx7a } from './step7a-scenarios';

/** Step 7a on a fresh seeded database: a test casino whose VAULT and CASH rails were cut over (D7). */
let app: FastifyInstance;
let pool: Pool;
let ctx: Ctx7a;

before(async () => {
  ({ app, pool } = await setupTestDatabase());
  const orgId = (await pool.query(`SELECT org_id FROM gateways WHERE device_id = 'GW-VIE-001'`)).rows[0].org_id;
  const casino = await createLedgerCasino(pool as never, { orgId, code: '7A-F', rails: ['VAULT', 'CASH'], machines: 0, vaultCents: 5_000_000, counter: 'manager@example.com', verifier: 'accounting@example.com' });
  const desks = [];
  for (const n of [1, 2, 3]) desks.push((await pool.query(`INSERT INTO cash_desks (org_id, casino_id, name) VALUES ($1,$2,$3) RETURNING id`, [orgId, casino.id, `7a desk ${n}`])).rows[0].id);
  const emp = Object.fromEntries((await pool.query('SELECT email, id FROM employees WHERE org_id = $1', [orgId])).rows.map((r) => [r.email, r.id]));
  const tokens: Record<string, string> = {};
  for (const e of ['admin@example.com', 'manager@example.com', 'accounting@example.com', 'cashier@example.com', 'attendant@example.com', 'floor@example.com'])
    tokens[e] = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: e, password: 'demo' } })).json().token;
  ctx = { app, pool: pool as never, orgId, casinoId: casino.id, vaultId: casino.vault, desks, emp, tokens };
});

after(async () => {
  await app?.close();
  await pool?.end();
});

registerStep7aScenarios(() => ctx);
