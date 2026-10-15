import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

/**
 * Upgrade path: a database at the pre-003 schema with legacy player data
 * (players.card_number, names, gaming sessions) is migrated to 003.
 */
const base = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://casino:casino@localhost:5432/postgres';
const name = 'casino_upgrade_test';
let pool: pg.Pool;
let migrate: typeof import('@m1/database').migrate;
let resolveCard: typeof import('../src/services/players').resolveCard;
const ids: Record<string, string> = {};

before(async () => {
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
  const db = await import('@m1/database');
  migrate = db.migrate;
  pool = db.createPool(url.toString());
  ({ resolveCard } = await import('../src/services/players'));

  await migrate(pool, () => {}, { until: '002a_hotfix_handpay_idempotency.sql' });
  // Legacy data as written before migration 003.
  ids.org = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Legacy Org', 'legacy') RETURNING id`)).rows[0].id;
  ids.casino = (await pool.query(`INSERT INTO casinos (org_id, code, name) VALUES ($1, 'L-1', 'Legacy Casino') RETURNING id`, [ids.org])).rows[0].id;
  ids.machine = (await pool.query(`INSERT INTO machines (org_id, casino_id, machine_code, asset_no) VALUES ($1,$2,'L-000001','L01') RETURNING id`, [ids.org, ids.casino])).rows[0].id;
  const legacy: Array<[string, string, string, string]> = [
    ['LEG-0002', 'Bertha', 'Second', '2025-01-02T00:00:00Z'],
    ['LEG-0001', 'Anton', 'First', '2025-01-01T00:00:00Z'],
    ['LEG-0003', 'Carla', 'Third', '2025-01-03T00:00:00Z'],
  ];
  for (const [card, first, last, created] of legacy) {
    ids[card] = (await pool.query(
      `INSERT INTO players (org_id, card_number, first_name, last_name, tier, points, created_at) VALUES ($1,$2,$3,$4,'GOLD',100,$5) RETURNING id`,
      [ids.org, card, first, last, created],
    )).rows[0].id;
  }
  ids.session = (await pool.query(
    `INSERT INTO player_sessions (org_id, casino_id, player_id, machine_id, started_at, ended_at, coin_in, games_played)
     VALUES ($1,$2,$3,$4, now() - interval '1 day', now() - interval '23 hours', 50, 25) RETURNING id`,
    [ids.org, ids.casino, ids['LEG-0001'], ids.machine],
  )).rows[0].id;

  await migrate(pool, () => {}); // the upgrade
});

after(async () => {
  await pool?.end();
});

test('upgrade applies 003 and stops before any money migration', async () => {
  const applied = (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
  assert.equal(applied.at(-1), '003_player_identity.sql');
  assert.ok(!applied.some((n) => n.startsWith('004')));
});

test('exactly one authoritative card per legacy card number, same player', async () => {
  const cards = (await pool.query('SELECT card_number, player_id, status FROM player_cards WHERE org_id = $1 ORDER BY card_number', [ids.org])).rows;
  assert.equal(cards.length, 3);
  for (const c of cards) {
    assert.equal(c.player_id, ids[c.card_number]);
    assert.equal(c.status, 'ACTIVE');
  }
});

test('legacy card numbers still resolve to the same player through player_cards', async () => {
  for (const card of ['LEG-0001', 'LEG-0002', 'LEG-0003']) {
    const res = await resolveCard(pool, ids.org, card);
    assert.equal(res.ok && res.player.id, ids[card]);
  }
});

test('player numbers are assigned deterministically by creation order', async () => {
  const rows = (await pool.query('SELECT card_number, player_no FROM players WHERE org_id = $1 ORDER BY player_no', [ids.org])).rows;
  assert.deepEqual(rows.map((r) => [r.card_number, r.player_no]), [
    ['LEG-0001', 'P00000001'],
    ['LEG-0002', 'P00000002'],
    ['LEG-0003', 'P00000003'],
  ]);
  const next = (await pool.query(`INSERT INTO players (org_id) VALUES ($1) RETURNING player_no`, [ids.org])).rows[0].player_no;
  assert.equal(next, 'P00000004');
});

test('legacy data is preserved: names copied to profiles, legacy columns and history unchanged', async () => {
  const p = (await pool.query('SELECT card_number, first_name, last_name, tier, points FROM players WHERE id = $1', [ids['LEG-0001']])).rows[0];
  assert.deepEqual(p, { card_number: 'LEG-0001', first_name: 'Anton', last_name: 'First', tier: 'GOLD', points: 100 });
  const profile = (await pool.query('SELECT first_name, last_name FROM player_profiles WHERE player_id = $1', [ids['LEG-0001']])).rows[0];
  assert.deepEqual(profile, { first_name: 'Anton', last_name: 'First' });
  const session = (await pool.query('SELECT coin_in, games_played, card_id FROM player_sessions WHERE id = $1', [ids.session])).rows[0];
  assert.deepEqual(session, { coin_in: 50, games_played: 25, card_id: null });
  const events = (await pool.query(`SELECT count(*)::int n FROM player_card_events WHERE org_id = $1 AND action = 'ISSUED'`, [ids.org])).rows[0].n;
  assert.equal(events, 3);
});

test('legacy columns are read-only after the upgrade but may be cleared', async () => {
  await assert.rejects(pool.query(`UPDATE players SET card_number = 'LEG-9999' WHERE id = $1`, [ids['LEG-0002']]), /legacy read-only/);
  await pool.query(`UPDATE players SET first_name = NULL, last_name = NULL WHERE id = $1`, [ids['LEG-0003']]);
});

test('running the migration again changes nothing', async () => {
  const count = async () => (await pool.query('SELECT count(*)::int n FROM player_cards')).rows[0].n;
  const before = await count();
  await migrate(pool, () => {});
  assert.equal(await count(), before);
});
