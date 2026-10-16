import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createEmptyDatabase, insertLegacyData } from './helpers';

/**
 * Upgrade path 005 -> 006 with legacy operational data, then a full cutover of every rail on it.
 * 006 itself moves nothing; the cutovers represent exactly the outstanding legacy money.
 */
const name = 'casino_upgrade6_test';
let pool: pg.Pool;
let db: typeof import('@m1/database');
let cutover: typeof import('../src/services/cutover');
let ledger: typeof import('../src/services/ledger');
let legacy: Awaited<ReturnType<typeof insertLegacyData>>;
let verifier: string;

const LEGACY: Record<string, string> = {
  cash_transactions: 'id, type, amount, session_id, source_event_id, machine_id, ticket_id',
  tickets: 'id, barcode, amount, status, expires_at',
  gaming_transactions: 'id, type, amount, machine_id',
  machine_events: 'event_id, type, amount, machine_id',
  players: 'id, status, player_no, points, tier',
  cashier_sessions: 'id, status, opening_balance, expected_balance, counted_balance',
  handpays: 'id, status, amount_cents, legacy_cash_transaction_id',
  machines: 'id, status, jackpot_pending',
};

async function fingerprint() {
  const out: Record<string, string> = {};
  for (const [t, cols] of Object.entries(LEGACY))
    out[t] = (await pool.query(`SELECT count(*) || ':' || COALESCE(md5(string_agg(x::text, ',' ORDER BY x::text)), '') AS f FROM (SELECT ${cols} FROM ${t}) x`)).rows[0].f;
  return out;
}
const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];
const money = () => one('SELECT (SELECT count(*)::int FROM money_transactions) t, (SELECT count(*)::int FROM money_rail_cutovers) c, (SELECT count(*)::int FROM money_backfill_items) i');
const actor = () => ({ orgId: legacy.org, employeeId: legacy.employee, employeeEmail: 'u@upgrade.example' });
const bal = (ref: Record<string, unknown>) => ledger.getBalance(pool, legacy.org, { casinoId: legacy.casino, ...ref } as never);

async function verifiedCount(context: 'VAULT_CUTOVER' | 'DRAWER_CUTOVER' | 'MACHINE_DROP', ref: Record<string, string>, totalCents: number) {
  const scoped = { ...actor(), casinoIds: [legacy.casino] };
  const c = await db.withTransaction(pool, (x) => cutover.recordCutoverCount(x, scoped, { casinoId: legacy.casino, context, ...ref, totalCents }));
  await db.withTransaction(pool, (x) => cutover.verifyCutoverCount(x, { ...scoped, employeeId: verifier }, c.id, { totalCents }));
}

let before006: Record<string, string>;

before(async () => {
  const url = await createEmptyDatabase(name);
  process.env.DATABASE_URL = url;
  process.env.LOG_LEVEL = 'silent';
  db = await import('@m1/database');
  pool = db.createPool(url);
  await db.migrate(pool, () => {}, { until: '004_money_ledger.sql' });
  await db.syncMoneyModel(pool);
  legacy = await insertLegacyData(pool);
  await db.migrate(pool, () => {}, { until: '005_money_entities.sql' });
  before006 = await fingerprint();
  await db.migrate(pool, () => {});
  await db.syncMoneyModel(pool);
  cutover = await import('../src/services/cutover');
  ledger = await import('../src/services/ledger');
  verifier = (await one(`INSERT INTO employees (org_id, email, name, password_hash, role) VALUES ($1, 'v@upgrade.example', 'V', 'x', 'MANAGER') RETURNING id`, [legacy.org])).id;
});

after(async () => {
  await pool?.end();
});

test('006 applied; history untouched; no money, no cutover, every rail LEGACY', async () => {
  const applied = (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
  assert.ok(applied.includes('006_money_cutover.sql'));
  assert.deepEqual(await fingerprint(), before006);
  assert.deepEqual(await money(), { t: 0, c: 0, i: 0 });
  for (const rail of ['VAULT', 'CASH', 'HANDPAY', 'TITO', 'CASHLESS'])
    assert.equal((await one('SELECT money_rail_ledger($1,$2,$3,NULL) AS l', [legacy.org, legacy.casino, rail])).l, false, rail);
});

test('repeated migration changes nothing', async () => {
  await db.migrate(pool, () => {});
  assert.deepEqual(await fingerprint(), before006);
  assert.deepEqual(await money(), { t: 0, c: 0, i: 0 });
});

test('dry runs on the upgraded data report exactly what blocks each rail', async () => {
  const failed = async (rail: 'VAULT' | 'CASH' | 'HANDPAY' | 'TITO') =>
    (await cutover.dryRunCutover(pool, actor(), { rail, casinoId: legacy.casino })).checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(await failed('VAULT'), ['vault:Main Vault:count_exists']);
  assert.ok((await failed('CASH')).includes('no_open_cashier_sessions'));
  assert.deepEqual(await failed('HANDPAY'), ['prerequisite:CASH']); // the legacy data itself maps deterministically
  assert.deepEqual(await failed('TITO'), ['prerequisite:CASH']);
  assert.deepEqual(await money(), { t: 0, c: 0, i: 0 });
});

test('full cutover of the upgraded casino represents exactly the outstanding legacy money', async () => {
  // The shift is closed the legacy way first (opening 1000 + 250 cash in - 300 handpay = 950, counted 950).
  await pool.query(`UPDATE cashier_sessions SET status = 'CLOSED', closed_at = now(), expected_balance = 950, counted_balance = 950, difference = 0 WHERE id = $1`, [legacy.session]);
  const history = await fingerprint();

  await verifiedCount('VAULT_CUTOVER', { vaultId: (await one('SELECT id FROM vaults WHERE casino_id = $1', [legacy.casino])).id }, 500_000);
  await cutover.runCutover(pool, actor(), { rail: 'VAULT', casinoId: legacy.casino });
  const desk = (await one('SELECT cash_desk_id FROM cashier_sessions WHERE id = $1', [legacy.session])).cash_desk_id;
  await verifiedCount('DRAWER_CUTOVER', { cashDeskId: desk }, 95_000);
  const cash = await cutover.runCutover(pool, actor(), { rail: 'CASH', casinoId: legacy.casino });
  assert.equal(cash.legacy.drawers_total, 95_000);
  const hp = await cutover.runCutover(pool, actor(), { rail: 'HANDPAY', casinoId: legacy.casino });
  assert.deepEqual([hp.legacy.unpaid_total, hp.legacy.paid_count], [51_234, 1]);
  const tito = await cutover.runCutover(pool, actor(), { rail: 'TITO', casinoId: legacy.casino });
  assert.equal(tito.legacy.outstanding_total, 4_250);
  const cl = await cutover.runCutover(pool, actor(), { rail: 'CASHLESS' });
  assert.deepEqual([cl.openings.length, cl.ledger.wallet_money], [0, 0]);
  await verifiedCount('MACHINE_DROP', { machineId: legacy.machine2 }, 0);
  const m = await cutover.runCutover(pool, actor(), { rail: 'MACHINE', machineId: legacy.machine2 });
  assert.equal(m.ok, true);

  assert.equal(await bal({ kind: 'VAULT', vaultId: (await one('SELECT id FROM vaults WHERE casino_id = $1', [legacy.casino])).id }), 500_000 + 95_000);
  assert.equal(await bal({ kind: 'TICKET_LIABILITY' }), 4_250);
  assert.equal(await bal({ kind: 'HANDPAY_PAYABLE' }), 51_234);
  assert.equal(await bal({ kind: 'OPENING_EQUITY' }), 595_000 - 4_250 - 51_234);
  const w = await one(`SELECT COALESCE(sum(available_cents + reserved_cents), 0)::int AS money FROM wallet_balances WHERE org_id = $1`, [legacy.org]);
  assert.equal(w.money, 0, 'no wallet money invented (points / tier stay loyalty data)');
  assert.equal((await ledger.checkLedgerInvariants(pool, legacy.org)).ok, true);
  assert.deepEqual(await fingerprint(), history, 'the cutovers did not rewrite any legacy record');

  // every opening is traceable to exactly one legacy source
  const items = (await pool.query(`SELECT source_table, account_kind, amount_cents FROM money_backfill_items WHERE org_id = $1 ORDER BY source_table, account_kind, amount_cents`, [legacy.org])).rows;
  assert.deepEqual(items.map((i) => `${i.source_table}:${i.account_kind}:${i.amount_cents}`), [
    'cash_counts:VAULT:0', 'cash_counts:VAULT:95000', 'cash_counts:VAULT:500000', 'handpays:HANDPAY_PAYABLE:51234', 'tickets:TICKET_LIABILITY:4250',
  ]);

  // repeated cutovers: nothing new
  const before_ = await money();
  for (const rail of ['VAULT', 'CASH', 'HANDPAY', 'TITO'] as const) assert.equal((await cutover.runCutover(pool, actor(), { rail, casinoId: legacy.casino })).replayed, true);
  assert.deepEqual(await money(), before_);
});

test('after the cutover the legacy handpay payment path is gone: the ledger path pays (here: refused, empty drawer)', async () => {
  const { payHandpay } = await import('../src/services/handpays');
  const h = (await one('SELECT id FROM handpays WHERE source_event_id = $1', [legacy.pendingEvent])).id;
  const s = (await one(`INSERT INTO cashier_sessions (org_id, casino_id, cash_desk_id, employee_id, opening_balance) SELECT org_id, casino_id, cash_desk_id, employee_id, 0 FROM cashier_sessions WHERE id = $1 RETURNING id`, [legacy.session])).id;
  await assert.rejects(db.withTransaction(pool, (x) => payHandpay(x, actor(), h)), /Insufficient balance on DRAWER/);
  assert.equal((await one('SELECT status FROM handpays WHERE id = $1', [h])).status, 'PENDING');
  assert.equal((await one(`SELECT count(*)::int n FROM cash_transactions WHERE type = 'HANDPAY' AND source_event_id = $1`, [legacy.pendingEvent])).n, 0);
  void s;
});
