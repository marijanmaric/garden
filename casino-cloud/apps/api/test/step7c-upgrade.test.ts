import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { createEmptyDatabase, insertLegacyData } from './helpers';
import { createLedgerCasino, cutoverCasinoRails, ensureVaultOpen, type LedgerCasino } from './ledger-casino';
import { registerStep7cScenarios, type Ctx7c } from './step7c-scenarios';

/**
 * Step 7c on a realistic upgraded database (legacy data written at 004, upgraded to today's schema).
 * The shared scenarios run on a ledger test casino of the upgraded organisation; in addition the
 * upgraded legacy casino itself is cut over in its maintenance window (VAULT, CASH, HANDPAY, TITO) and
 * its outstanding legacy ticket, opened as TICKET_LIABILITY by the cutover, is paid through the ledger.
 */
const name = 'casino_step7c_upgrade';
let app: FastifyInstance;
let pool: pg.Pool;
let ctx: Ctx7c;
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
  const casino = await createLedgerCasino(pool, { orgId: legacy.org, code: '7C-U', rails: ['VAULT', 'CASH', 'HANDPAY', 'TITO', 'CASHLESS'], machines: 8, gateway: true, vaultCents: 50_000_000 });
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


registerStep7cScenarios(() => ctx);

test('upgraded legacy casino: the window cutover opens the outstanding legacy ticket; it is paid once through the ledger', async () => {
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const ledger = await import('../src/services/ledger');
  const legacyTicket = (await q(`SELECT * FROM tickets WHERE casino_id = $1 AND barcode = '111122223333444455'`, [legacy.casino]))[0];
  const historyBefore = (await q('SELECT count(*)::int n FROM ticket_events WHERE ticket_id = $1', [legacyTicket.id]))[0].n;
  await pool.query(`UPDATE cashier_sessions SET status = 'CLOSED', closed_at = now(), expected_balance = 950, counted_balance = 950, difference = 0 WHERE id = $1`, [legacy.session]);
  const desk = (await q('SELECT cash_desk_id FROM cashier_sessions WHERE id = $1', [legacy.session]))[0].cash_desk_id;
  const vault = (await q('SELECT id FROM vaults WHERE casino_id = $1', [legacy.casino]))[0].id;
  const machines = await q('SELECT id, machine_code AS code, asset_no AS asset FROM machines WHERE casino_id = $1 ORDER BY asset_no', [legacy.casino]);
  const lc: LedgerCasino = { id: legacy.casino, orgId: legacy.org, vault, desk, machines };
  await cutoverCasinoRails(pool, lc, ['VAULT', 'CASH', 'HANDPAY', 'TITO'], { vaultCents: 1_000_000, deskCents: 95_000 });
  const opening = (await q(`SELECT t.type, t.amount_cents FROM money_transactions t JOIN money_backfill_items i ON i.money_transaction_id = t.id WHERE i.source_table = 'tickets' AND i.source_id = $1`, [legacyTicket.id]))[0];
  assert.deepEqual(opening, { type: 'OPENING_BALANCE', amount_cents: 4_250 });
  assert.equal(await ledger.getBalance(pool as never, legacy.org, { kind: 'TICKET_LIABILITY', casinoId: legacy.casino }), 4_250);

  await ensureVaultOpen(pool, lc);
  // the scenarios' cashier, attendant and manager still have open shifts in the test casino
  const H = (e: string) => ({ authorization: `Bearer ${ctx.tokens[e]}`, 'idempotency-key': randomUUID() });
  const s = await app.inject({ method: 'POST', url: '/api/v1/cashier/session/open', headers: H('admin@example.com'), payload: { cashDeskId: desk, openingBalance: 0 } });
  assert.equal(s.statusCode, 200, s.body);
  const f = await app.inject({ method: 'POST', url: '/api/v1/cash/movements', headers: H('manager@example.com'), payload: { kind: 'FILL', cashierSessionId: s.json().id, amountCents: 60_000 } });
  await app.inject({ method: 'POST', url: `/api/v1/cash/movements/${f.json().movement.id}/confirm`, headers: H('admin@example.com'), payload: { totalCents: 60_000 } });
  const paid = await app.inject({ method: 'POST', url: '/api/v1/tickets/redeem', headers: H('admin@example.com'), payload: { barcode: '111122223333444455' } });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(await ledger.getBalance(pool as never, legacy.org, { kind: 'TICKET_LIABILITY', casinoId: legacy.casino }), 0);
  assert.deepEqual((await q(`SELECT type FROM money_transactions WHERE ticket_id = $1 ORDER BY created_at`, [legacyTicket.id])).map((r) => r.type), ['OPENING_BALANCE', 'TITO_REDEEM_CASHIER']);
  const again = await app.inject({ method: 'POST', url: '/api/v1/tickets/redeem', headers: H('admin@example.com'), payload: { barcode: '111122223333444455' } });
  assert.equal(again.statusCode, 409);
  // legacy history is kept, only extended
  assert.equal((await q('SELECT count(*)::int n FROM ticket_events WHERE ticket_id = $1', [legacyTicket.id]))[0].n, historyBefore + 1);
  assert.equal((await ledger.checkLedgerInvariants(pool as never, legacy.org)).ok, true);
});
