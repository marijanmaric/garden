import { after, before } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Pool } from '@m1/database';
import { setupTestDatabase } from './helpers';
import { createLedgerCasino } from './ledger-casino';
import { registerStep7bScenarios, type Ctx7b } from './step7b-scenarios';

/** Step 7b on a fresh seeded database: a test casino with VAULT, CASH and HANDPAY cut over (D7) and a gateway. */
let app: FastifyInstance;
let pool: Pool;
let ctx: Ctx7b;

before(async () => {
  ({ app, pool } = await setupTestDatabase());
  const orgId = (await pool.query(`SELECT org_id FROM gateways WHERE device_id = 'GW-VIE-001'`)).rows[0].org_id;
  const casino = await createLedgerCasino(pool as never, { orgId, code: '7B-F', rails: ['VAULT', 'CASH', 'HANDPAY'], machines: 8, gateway: true, vaultCents: 50_000_000 });
  const emp = Object.fromEntries((await pool.query('SELECT email, id FROM employees WHERE org_id = $1', [orgId])).rows.map((r) => [r.email, r.id]));
  const tokens: Record<string, string> = {};
  for (const e of ['admin@example.com', 'manager@example.com', 'accounting@example.com', 'cashier@example.com', 'attendant@example.com', 'floor@example.com'])
    tokens[e] = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: e, password: 'demo' } })).json().token;
  ctx = { app, pool: pool as never, orgId, casino, emp, tokens };
});

after(async () => {
  await app?.close();
  await pool?.end();
});

registerStep7bScenarios(() => ctx);
