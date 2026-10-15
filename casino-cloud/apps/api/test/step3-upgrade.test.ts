import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

/** Upgrade path: a seeded database at 003 (with operational cash/ticket/gaming data) gets migration 004. */
const base = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://casino:casino@localhost:5432/postgres';
const name = 'casino_upgrade3_test';
let pool: pg.Pool;
let db: typeof import('@m1/database');
let ledger: typeof import('../src/services/ledger');
const LEGACY_TABLES = ['cash_transactions', 'gaming_transactions', 'tickets', 'ticket_events', 'players', 'player_cards', 'machine_meters', 'cashier_sessions'];
let before004: Record<string, string> = {};

async function fingerprint() {
  const out: Record<string, string> = {};
  for (const t of LEGACY_TABLES) out[t] = (await pool.query(`SELECT count(*) || ':' || COALESCE(md5(string_agg(x::text, ',' ORDER BY x::text)), '') AS f FROM ${t} x`)).rows[0].f;
  return out;
}

before(async () => {
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
  db = await import('@m1/database');
  pool = db.createPool(url.toString());
  await db.migrate(pool, () => {}, { until: '003_player_identity.sql' });
  await db.syncRbac(pool);
  await db.seed(pool, () => {});
  // Some operational activity before the ledger exists.
  const org = (await pool.query(`SELECT id FROM organizations WHERE slug = 'm1'`)).rows[0].id;
  const casino = (await pool.query(`SELECT id FROM casinos WHERE org_id = $1`, [org])).rows[0].id;
  const desk = (await pool.query(`SELECT id FROM cash_desks WHERE casino_id = $1 LIMIT 1`, [casino])).rows[0].id;
  const emp = (await pool.query(`SELECT id FROM employees WHERE email = 'cashier@example.com'`)).rows[0].id;
  const s = (await pool.query(`INSERT INTO cashier_sessions (org_id, casino_id, cash_desk_id, employee_id, opening_balance) VALUES ($1,$2,$3,$4,1000) RETURNING id`, [org, casino, desk, emp])).rows[0].id;
  await pool.query(`INSERT INTO cash_transactions (org_id, casino_id, session_id, employee_id, type, amount) VALUES ($1,$2,$3,$4,'CASH_IN',250)`, [org, casino, s, emp]);
  before004 = await fingerprint();
  ledger = await import('../src/services/ledger');
  await db.migrate(pool, () => {});
  await db.syncMoneyModel(pool);
});

after(async () => {
  await pool?.end();
});

test('004 is applied on top of 003, nothing beyond', async () => {
  const applied = (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
  assert.equal(applied.at(-1), '004_money_ledger.sql');
});

test('existing cash, ticket, gaming and player data is untouched', async () => {
  assert.deepEqual(await fingerprint(), before004);
});

test('the ledger starts empty (no backfill before 006) and consistent', async () => {
  const counts = (await pool.query('SELECT (SELECT count(*)::int FROM money_transactions) t, (SELECT count(*)::int FROM ledger_entries) e, (SELECT count(*)::int FROM ledger_accounts) a')).rows[0];
  assert.deepEqual(counts, { t: 0, e: 0, a: 0 });
  assert.equal((await ledger.checkLedgerInvariants(pool)).ok, true);
});

test('the ledger works on the upgraded database', async () => {
  const org = (await pool.query(`SELECT id FROM organizations WHERE slug = 'm1'`)).rows[0].id;
  const casino = (await pool.query(`SELECT id FROM casinos WHERE org_id = $1`, [org])).rows[0].id;
  const machine = (await pool.query(`SELECT id FROM machines WHERE org_id = $1 LIMIT 1`, [org])).rows[0].id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ledger.executeMoneyTransaction(client, { orgId: org, type: 'MACHINE_CASH_IN', dedupeKey: `t-${randomUUID()}`, actor: { type: 'SYSTEM' }, ctx: { casinoId: casino, machineId: machine, amountCents: 5_000 as never } });
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  assert.equal((await ledger.checkLedgerInvariants(pool)).ok, true);
});
