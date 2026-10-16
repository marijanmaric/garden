import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createEmptyDatabase, insertLegacyData } from './helpers';

/** Upgrade path 004 -> 005 with legacy operational data. */
const name = 'casino_upgrade4_test';
let pool: pg.Pool;
let db: typeof import('@m1/database');
let legacy: Awaited<ReturnType<typeof insertLegacyData>>;
let before005: Record<string, string>;

// Original columns only: 005 adds columns (e.g. tickets.amount_cents) without touching existing values.
const LEGACY: Record<string, string> = {
  cash_transactions: 'id, type, amount, session_id, source_event_id',
  tickets: 'id, barcode, amount, status, expires_at',
  gaming_transactions: 'id, type, amount, machine_id',
  machine_events: 'event_id, type, amount, machine_id',
  players: 'id, status, player_no',
  player_cards: 'id, card_number, status, player_id',
  cashier_sessions: 'id, status, opening_balance',
  machines: 'id, status, jackpot_pending',
};

async function fingerprint() {
  const out: Record<string, string> = {};
  for (const [t, cols] of Object.entries(LEGACY))
    out[t] = (await pool.query(`SELECT count(*) || ':' || COALESCE(md5(string_agg(x::text, ',' ORDER BY x::text)), '') AS f FROM (SELECT ${cols} FROM ${t}) x`)).rows[0].f;
  return out;
}

before(async () => {
  const url = await createEmptyDatabase(name);
  process.env.DATABASE_URL = url;
  db = await import('@m1/database');
  pool = db.createPool(url);
  await db.migrate(pool, () => {}, { until: '004_money_ledger.sql' });
  await db.syncMoneyModel(pool);
  legacy = await insertLegacyData(pool);
  before005 = await fingerprint();
  await db.migrate(pool, () => {}, { until: '005_money_entities.sql' });
  await db.syncMoneyModel(pool);
});

after(async () => {
  await pool?.end();
});

test('005 is applied, nothing beyond', async () => {
  const applied = (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
  assert.equal(applied.at(-1), '005_money_entities.sql');
});

test('existing data is unchanged', async () => {
  assert.deepEqual(await fingerprint(), before005);
});

test('ledger remains empty: no balances migrated, no opening balances invented', async () => {
  const c = (await pool.query('SELECT (SELECT count(*)::int FROM money_transactions) t, (SELECT count(*)::int FROM ledger_entries) e, (SELECT count(*)::int FROM ledger_accounts) a')).rows[0];
  assert.deepEqual(c, { t: 0, e: 0, a: 0 });
});

test('entity backfill: wallets for non-closed players, vault and settings per casino', async () => {
  const wallets = (await pool.query('SELECT player_id FROM wallets WHERE org_id = $1', [legacy.org])).rows.map((r) => r.player_id);
  assert.deepEqual(wallets, [legacy.player]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM vaults WHERE casino_id = $1', [legacy.casino])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM casino_money_settings WHERE casino_id = $1', [legacy.casino])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT handpay_approval_cents FROM casino_money_settings WHERE casino_id = $1', [legacy.casino])).rows[0].handpay_approval_cents, null);
});

test('handpay backfill: paid jackpot linked to its legacy payment, pending jackpot payable, old unpaid history ignored', async () => {
  const rows = (await pool.query('SELECT source_event_id, status, amount_cents, legacy_cash_transaction_id FROM handpays WHERE org_id = $1 ORDER BY created_at', [legacy.org])).rows;
  assert.equal(rows.length, 2);
  const paid = rows.find((r) => r.source_event_id === legacy.paidEvent)!;
  assert.equal(paid.status, 'MACHINE_RESET');
  assert.ok(paid.legacy_cash_transaction_id);
  const open = rows.find((r) => r.source_event_id === legacy.pendingEvent)!;
  assert.deepEqual([open.status, open.amount_cents], ['PENDING', 51_234]);
});

test('the legacy handpay flow works on the upgraded database (still exactly once)', async () => {
  await db.migrate(pool, () => {}); // today's code runs on today's schema (006 keeps every rail LEGACY)
  process.env.DATABASE_URL = (pool as unknown as { options: { connectionString: string } }).options.connectionString;
  const { payHandpay } = await import('../src/services/handpays');
  const h = (await pool.query('SELECT id FROM handpays WHERE source_event_id = $1', [legacy.pendingEvent])).rows[0];
  const actor = { orgId: legacy.org, employeeId: legacy.employee, employeeEmail: 'u@upgrade.example' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await payHandpay(client, actor, h.id);
    await client.query('COMMIT');
    assert.equal(r.handpay.status, 'PAID');
  } finally {
    client.release();
  }
  const client2 = await pool.connect();
  try {
    await client2.query('BEGIN');
    await assert.rejects(payHandpay(client2, actor, h.id), /already PAID/);
    await client2.query('ROLLBACK');
  } finally {
    client2.release();
  }
  assert.equal((await pool.query(`SELECT count(*)::int n FROM cash_transactions WHERE source_event_id = $1`, [legacy.pendingEvent])).rows[0].n, 1);
});
