import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createEmptyDatabase, insertLegacyData } from './helpers';

/** Upgrade path: a seeded database at 003 (with operational cash/ticket/gaming data) gets migration 004. */
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
  const url = await createEmptyDatabase(name);
  process.env.DATABASE_URL = url;
  db = await import('@m1/database');
  pool = db.createPool(url);
  await db.migrate(pool, () => {}, { until: '003_player_identity.sql' });
  await insertLegacyData(pool);
  before004 = await fingerprint();
  ledger = await import('../src/services/ledger');
  await db.migrate(pool, () => {}, { until: '004_money_ledger.sql' });
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

test('the ledger on the upgraded database (today\'s schema): legacy rails take no ledger booking (Step 7a guard)', async () => {
  await db.migrate(pool, () => {});
  await db.syncMoneyModel(pool);
  const org = (await pool.query(`SELECT id FROM organizations WHERE slug = 'upgrade'`)).rows[0].id;
  const casino = (await pool.query(`SELECT id FROM casinos WHERE org_id = $1`, [org])).rows[0].id;
  const machine = (await pool.query(`SELECT id FROM machines WHERE org_id = $1 LIMIT 1`, [org])).rows[0].id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(
      ledger.executeMoneyTransaction(client, { orgId: org, type: 'MACHINE_CASH_IN', dedupeKey: `t-${randomUUID()}`, actor: { type: 'SYSTEM' }, ctx: { casinoId: casino, machineId: machine, amountCents: 5_000 as never } }),
      /MACHINE money is not on the ledger/,
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  const counts = (await pool.query('SELECT (SELECT count(*)::int FROM money_transactions) t, (SELECT count(*)::int FROM ledger_entries) e')).rows[0];
  assert.deepEqual(counts, { t: 0, e: 0 });
  assert.equal((await ledger.checkLedgerInvariants(pool)).ok, true);
});
