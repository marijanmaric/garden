import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { withTransaction, type Pool, type PoolClient } from '@m1/database';
import { LEGACY_CASH_TX_RAILS, cents, type CutoverRail } from '@m1/shared';
import { setupTestDatabase } from './helpers';

/**
 * Step 5 / migration 006: rail cutover. Every rail is cut over through the real mechanism on a fresh
 * database, plus the abort paths (mismatch, missing / unverified counts, pending work, non-deterministic
 * handpay data), duplicate, concurrent and interrupted cutovers, and the dual-write guards afterwards.
 */

let app: FastifyInstance;
let pool: Pool;
let svc: {
  cutover: typeof import('../src/services/cutover');
  ledger: typeof import('../src/services/ledger');
  handpays: typeof import('../src/services/handpays');
  cashier: typeof import('../src/services/cashier');
  cashless: typeof import('../src/services/cashless');
};
let orgId: string;
let casinoA: string;
const emp: Record<string, string> = {};
const tokens: Record<string, string> = {};

const tx = <T>(fn: (db: PoolClient) => Promise<T>) => withTransaction(pool, fn);
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];
const who = (email: string, casinoIds: string[]) => ({ orgId, employeeId: emp[email], employeeEmail: email, casinoIds });

interface TestCasino {
  id: string;
  vault: string;
  desk: string;
  machines: string[];
}

let seq = 0;
/** A separate casino per scenario, created with plain SQL (legacy state is written the legacy way). */
async function newCasino(): Promise<TestCasino> {
  const n = ++seq;
  const id = (await one(`INSERT INTO casinos (org_id, code, name) VALUES ($1, $2, $3) RETURNING id`, [orgId, `CUT-${n}`, `Cutover ${n}`])).id;
  await q('INSERT INTO casino_money_settings (casino_id, org_id) VALUES ($1,$2)', [id, orgId]);
  const vault = (await one(`INSERT INTO vaults (org_id, casino_id, name) VALUES ($1,$2,'Main Vault') RETURNING id`, [orgId, id])).id;
  const desk = (await one(`INSERT INTO cash_desks (org_id, casino_id, name) VALUES ($1,$2,'Cage') RETURNING id`, [orgId, id])).id;
  const machines = [];
  for (const i of [1, 2]) machines.push((await one(`INSERT INTO machines (org_id, casino_id, machine_code, asset_no) VALUES ($1,$2,$3,$4) RETURNING id`, [orgId, id, `C${n}-${i}`, `C${n}M${i}`])).id);
  return { id, vault, desk, machines };
}

const cut = (rail: CutoverRail, c: { casinoId?: string; machineId?: string }, opts?: { failAfterOpenings?: boolean }) =>
  svc.cutover.runCutover(pool, who('admin@example.com', [c.casinoId!].filter(Boolean)), { rail, ...c }, opts);
const dry = (rail: CutoverRail, c: { casinoId?: string; machineId?: string }) => svc.cutover.dryRunCutover(pool, who('admin@example.com', [c.casinoId!].filter(Boolean)), { rail, ...c });
const failed = (r: { checks: { name: string; ok: boolean }[] }) => r.checks.filter((c) => !c.ok).map((c) => c.name);

/** Physical count by the manager, blind second count by the admin. */
async function count(casinoId: string, context: 'VAULT_CUTOVER' | 'DRAWER_CUTOVER' | 'MACHINE_DROP', ref: { vaultId?: string; cashDeskId?: string; machineId?: string }, totalCents: number, verifyCents: number | null = totalCents) {
  const c = await tx((db) => svc.cutover.recordCutoverCount(db, who('manager@example.com', [casinoId]), { casinoId, context, ...ref, totalCents }));
  if (verifyCents !== null) await tx((db) => svc.cutover.verifyCutoverCount(db, who('admin@example.com', [casinoId]), c.id, { totalCents: verifyCents }));
  return c.id as string;
}

/** A closed legacy cashier shift: opening float, movements, close with a count (legacy columns only). */
async function legacyShift(c: TestCasino, employee: string, opening: number, moves: [string, number][], counted?: number) {
  const s = (await one(`INSERT INTO cashier_sessions (org_id, casino_id, cash_desk_id, employee_id, opening_balance) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [orgId, c.id, c.desk, emp[employee], opening])).id;
  for (const [type, amount] of moves)
    await q(`INSERT INTO cash_transactions (org_id, casino_id, session_id, employee_id, type, amount) VALUES ($1,$2,$3,$4,$5,$6)`, [orgId, c.id, s, emp[employee], type, amount]);
  if (counted !== undefined) {
    const expected = opening + moves.reduce((x, [, a]) => x + a, 0);
    await q(`UPDATE cashier_sessions SET status = 'CLOSED', closed_at = now(), expected_balance = $2, counted_balance = $3, difference = $4 WHERE id = $1`, [s, expected, counted, counted - expected]);
  }
  return s as string;
}

async function machineEvent(c: TestCasino, machineId: string, type: string, amount: number | null, extra: Record<string, unknown> = {}) {
  const r = await one(
    `INSERT INTO machine_events (event_id, org_id, casino_id, machine_id, type, amount, payload, occurred_at) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,now()) RETURNING event_id`,
    [orgId, c.id, machineId, type, amount, extra],
  );
  return r.event_id as string;
}

async function ticket(c: TestCasino, cents_: number, status = 'VALID', opts: { expiresInDays?: number; hold?: { secondsLeft: number; source?: 'MACHINE' | 'CASHIER' } } = {}) {
  const t = (await one(
    `INSERT INTO tickets (org_id, casino_id, barcode, amount, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(days => $5)) RETURNING id`,
    [orgId, c.id, String(Date.now()) + String(++seq).padStart(5, '0'), cents_ / 100, opts.expiresInDays ?? 30],
  )).id;
  if (opts.hold)
    await q(`UPDATE tickets SET status = 'HELD', hold_id = gen_random_uuid(), hold_until = now() + make_interval(secs => $2), hold_source = $3 WHERE id = $1`, [t, opts.hold.secondsLeft, opts.hold.source ?? 'MACHINE']);
  else if (status !== 'VALID') await q('UPDATE tickets SET status = $2 WHERE id = $1', [t, status]);
  return t as string;
}

const balance = (casinoId: string, ref: Record<string, unknown>) => svc.ledger.getBalance(pool, orgId, { casinoId, ...ref } as never);
const onLedger = async (rail: CutoverRail, casinoId: string | null, machineId: string | null = null) =>
  (await one('SELECT money_rail_ledger($1,$2,$3,$4) AS l', [orgId, casinoId, rail, machineId])).l as boolean;
const moneyCount = async () => (await one('SELECT (SELECT count(*)::int FROM money_transactions) t, (SELECT count(*)::int FROM money_backfill_items) i, (SELECT count(*)::int FROM money_rail_cutovers) c'));

/** VAULT + CASH cut over with the given desk balance (closed legacy shift). */
async function cashReady(c: TestCasino, vaultCents = 100_000, deskCents = 0) {
  await count(c.id, 'VAULT_CUTOVER', { vaultId: c.vault }, vaultCents);
  await cut('VAULT', { casinoId: c.id });
  if (deskCents) await legacyShift(c, 'cashier@example.com', deskCents / 100, [], deskCents / 100);
  await count(c.id, 'DRAWER_CUTOVER', { cashDeskId: c.desk }, deskCents);
  await cut('CASH', { casinoId: c.id });
}

before(async () => {
  ({ app, pool } = await setupTestDatabase());
  svc = {
    cutover: await import('../src/services/cutover'),
    ledger: await import('../src/services/ledger'),
    handpays: await import('../src/services/handpays'),
    cashier: await import('../src/services/cashier'),
    cashless: await import('../src/services/cashless'),
  };
  const g = await one(`SELECT org_id, casino_id FROM gateways WHERE device_id = 'GW-VIE-001'`);
  orgId = g.org_id;
  casinoA = g.casino_id;
  for (const r of await q('SELECT email, id FROM employees WHERE org_id = $1', [orgId])) emp[r.email] = r.id;
  for (const email of ['admin@example.com', 'manager@example.com', 'cashier@example.com'])
    tokens[email] = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'demo' } })).json().token;
});

after(async () => {
  await app?.close();
  await pool?.end();
});

describe('fresh database and migration', () => {
  test('006 applied; only CASHLESS starts on the ledger (through the cutover itself); no money anywhere', async () => {
    assert.ok((await q(`SELECT 1 FROM schema_migrations WHERE name = '006_money_cutover.sql'`)).length);
    const rows = await q('SELECT org_id, rail, casino_id, actor_type, opening_count FROM money_rail_cutovers');
    const orgs = await q('SELECT id FROM organizations');
    assert.equal(rows.length, orgs.length);
    assert.ok(rows.every((r) => r.rail === 'CASHLESS' && r.casino_id === null && r.actor_type === 'SYSTEM' && r.opening_count === 0));
    assert.equal(await onLedger('CASHLESS', null), true);
    for (const rail of ['VAULT', 'CASH', 'HANDPAY', 'TITO'] as const) assert.equal(await onLedger(rail, casinoA), false);
    assert.deepEqual(await moneyCount(), { t: 0, i: 0, c: orgs.length });
    const wallets = await one(`SELECT count(*)::int n, COALESCE(sum(available_cents + reserved_cents), 0)::int money FROM wallet_balances WHERE org_id = $1`, [orgId]);
    assert.ok(wallets.n > 0);
    assert.equal(wallets.money, 0);
  });

  test('repeated migration and repeated fresh cutover create nothing', async () => {
    const before_ = await moneyCount();
    const { migrate } = await import('@m1/database');
    await migrate(pool, () => {});
    const again = await svc.cutover.cutoverFreshRails(pool);
    assert.ok(again.every((r) => r.replayed));
    assert.deepEqual(await moneyCount(), before_);
  });

  test('the SQL mirror of the legacy cash rails matches the shared model', async () => {
    for (const [type, rails] of Object.entries(LEGACY_CASH_TX_RAILS))
      assert.deepEqual((await one('SELECT legacy_cash_tx_rails($1) AS r', [type])).r, [...rails], type);
  });
});

describe('cutover counts (four eyes)', () => {
  test('second count by another employee; mismatch stays unverified; counts are immutable', async () => {
    const c = await newCasino();
    const id = await count(c.id, 'VAULT_CUTOVER', { vaultId: c.vault }, 5_000, null);
    await assert.rejects(tx((db) => svc.cutover.verifyCutoverCount(db, who('manager@example.com', [c.id]), id, { totalCents: 5_000 })), /different employee/);
    const bad = await tx((db) => svc.cutover.verifyCutoverCount(db, who('admin@example.com', [c.id]), id, { totalCents: 4_900 }));
    assert.equal(bad.matches, false);
    // the database computes `matches` itself: a client claiming a match is overruled
    await q(`INSERT INTO cash_count_verifications (org_id, count_id, total_cents, matches, verified_by) VALUES ($1,$2,4900,true,$3)`, [orgId, id, emp['cashier@example.com']]);
    assert.equal((await one('SELECT matches FROM cash_count_verifications WHERE count_id = $1 AND verified_by = $2', [id, emp['cashier@example.com']])).matches, false);
    assert.equal((await dry('VAULT', { casinoId: c.id })).checks.find((x) => x.name === 'vault:Main Vault:count_verified')!.ok, false);
    await assert.rejects(pool.query('UPDATE cash_counts SET total_cents = 1 WHERE id = $1', [id]), /immutable|not allowed|cannot/i);
    await assert.rejects(tx((db) => svc.cutover.recordCutoverCount(db, who('manager@example.com', [c.id]), { casinoId: c.id, context: 'VAULT_CUTOVER', totalCents: 1 })), /needs vaultId/);
  });
});

describe('VAULT', () => {
  test('aborts without a verified count; dry run posts nothing; cutover opens the counted amount once', async () => {
    const c = await newCasino();
    let r = await dry('VAULT', { casinoId: c.id });
    assert.deepEqual(failed(r), ['vault:Main Vault:count_exists']);
    await count(c.id, 'VAULT_CUTOVER', { vaultId: c.vault }, 250_000, 249_000);
    r = await dry('VAULT', { casinoId: c.id });
    assert.deepEqual(failed(r), ['vault:Main Vault:count_verified']);
    await count(c.id, 'VAULT_CUTOVER', { vaultId: c.vault }, 250_000);
    const before_ = await moneyCount();
    r = await dry('VAULT', { casinoId: c.id });
    assert.equal(r.ok, true);
    assert.equal(r.openings[0].amountCents, 250_000);
    assert.deepEqual(await moneyCount(), before_, 'dry run rolled back');
    assert.equal(await onLedger('VAULT', c.id), false);

    const done = await cut('VAULT', { casinoId: c.id });
    assert.equal(done.ok, true);
    assert.equal(await balance(c.id, { kind: 'VAULT', vaultId: c.vault }), 250_000);
    assert.equal(await balance(c.id, { kind: 'OPENING_EQUITY' }), 250_000); // equity shown with its normal sign (credit)
    assert.equal(await onLedger('VAULT', c.id), true);
    const mt = await one(`SELECT * FROM money_transactions WHERE id = $1`, [done.openings[0].transactionId]);
    assert.equal(mt.type, 'OPENING_BALANCE');
    assert.equal(mt.dedupe_key, `backfill:006:VAULT:cash_counts:${done.openings[0].sourceId}`);
    assert.deepEqual(mt.options.backfillSource, { table: 'cash_counts', id: done.openings[0].sourceId });
    assert.match(mt.reason, /VAULT cutover \(migration 006\)/);
    assert.equal(mt.actor_id, emp['admin@example.com']);
    const audit = await one(`SELECT details FROM audit_logs WHERE entity_id = $1 AND action = 'money.opening_balance'`, [mt.id]);
    assert.equal(audit.details.amountCents, 250_000);
    assert.ok(await one(`SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'money.cutover'`, [done.cutoverId]));

    // duplicate: replayed, nothing new; an opening outside the cutover is refused on a ledger rail
    const after_ = await moneyCount();
    const again = await cut('VAULT', { casinoId: c.id });
    assert.equal(again.replayed, true);
    assert.equal(again.cutoverId, done.cutoverId);
    assert.deepEqual(await moneyCount(), after_);
    await assert.rejects(tx((db) => svc.ledger.executeMoneyTransaction(db, {
      orgId, type: 'OPENING_BALANCE', dedupeKey: `x-${randomUUID()}`, actor: { type: 'SYSTEM' },
      ctx: { casinoId: c.id, amountCents: cents(1), debit: { kind: 'VAULT', vaultId: c.vault }, credit: { kind: 'OPENING_EQUITY' }, backfillSource: { table: 'cash_counts', id: randomUUID() } },
    })), /only created by a rail cutover/);
    // forward-only: cutovers and items cannot be changed or deleted
    await assert.rejects(pool.query('DELETE FROM money_rail_cutovers WHERE id = $1', [done.cutoverId]));
    await assert.rejects(pool.query('UPDATE money_backfill_items SET amount_cents = 1 WHERE cutover_id = $1', [done.cutoverId]));
  });

  test('a count with zero cash opens nothing but is recorded and used once', async () => {
    const c = await newCasino();
    await count(c.id, 'VAULT_CUTOVER', { vaultId: c.vault }, 0);
    const r = await cut('VAULT', { casinoId: c.id });
    assert.deepEqual(r.openings.map((o) => [o.amountCents, o.transactionId]), [[0, null]]);
    assert.equal(await balance(c.id, { kind: 'VAULT', vaultId: c.vault }), 0);
  });
});

describe('CASH', () => {
  test('needs VAULT, no open shift, no pending approval / cash operation / count, and verified desk counts', async () => {
    const c = await newCasino();
    let r = await dry('CASH', { casinoId: c.id });
    assert.ok(failed(r).includes('prerequisite:VAULT'));
    await count(c.id, 'VAULT_CUTOVER', { vaultId: c.vault }, 10_000);
    await cut('VAULT', { casinoId: c.id });

    const open = await legacyShift(c, 'cashier@example.com', 1000, [['CASH_IN', 250], ['CASH_OUT', -300]]);
    await q(`INSERT INTO approvals (org_id, casino_id, action, requested_by) VALUES ($1,$2,'HANDPAY_PAY',$3)`, [orgId, c.id, emp['cashier@example.com']]);
    const vs = (await one(`INSERT INTO vault_sessions (org_id, casino_id, vault_id, business_date, opened_by, status) VALUES ($1,$2,$3,current_date,$4,'OPEN') RETURNING id`, [orgId, c.id, c.vault, emp['manager@example.com']])).id;
    await q(`UPDATE vault_sessions SET status = 'COUNTING' WHERE id = $1`, [vs]);
    r = await dry('CASH', { casinoId: c.id });
    for (const name of ['no_open_cashier_sessions', 'no_pending_approvals', 'no_active_cash_count', 'drawer:Cage:count_exists']) assert.ok(failed(r).includes(name), name);

    // clean up the pending work the legacy way
    await q(`UPDATE approvals SET status = 'EXPIRED' WHERE casino_id = $1`, [c.id]);
    await q(`UPDATE vault_sessions SET status = 'CLOSED', closed_at = now(), closed_by = $2 WHERE id = $1`, [vs, emp['manager@example.com']]);
    await count(c.id, 'DRAWER_CUTOVER', { cashDeskId: c.desk }, 95_000); // counted BEFORE the shift is closed
    await q(`UPDATE cashier_sessions SET status = 'CLOSED', closed_at = now() + interval '1 second', expected_balance = 950, counted_balance = 950, difference = 0 WHERE id = $1`, [open]);
    r = await dry('CASH', { casinoId: c.id });
    assert.deepEqual(failed(r), ['drawer:Cage:count_current'], 'the count must be taken after the last close');
  });

  test('count mismatch aborts; a matching verified count moves the desk cash into the vault, drawers stay 0', async () => {
    const c = await newCasino();
    await count(c.id, 'VAULT_CUTOVER', { vaultId: c.vault }, 10_000);
    await cut('VAULT', { casinoId: c.id });
    // legacy: opening 1000 + 250 in - 300 out = 950 expected; counted 940 => difference -10 recognised at close => 940 in the drawer
    const s = await legacyShift(c, 'cashier@example.com', 1000, [['CASH_IN', 250], ['CASH_OUT', -300]], 940);
    await count(c.id, 'DRAWER_CUTOVER', { cashDeskId: c.desk }, 95_000);
    let r = await dry('CASH', { casinoId: c.id });
    assert.deepEqual(failed(r), ['drawer:Cage:count_matches_legacy']);
    assert.deepEqual(r.checks.find((x) => x.name === 'drawer:Cage:count_matches_legacy')!.detail, { legacy: 94_000, counted: 95_000 });
    await assert.rejects(cut('CASH', { casinoId: c.id }), (err: Error & { report?: unknown }) => /count_matches_legacy/.test(err.message));
    assert.equal(await onLedger('CASH', c.id), false);

    await count(c.id, 'DRAWER_CUTOVER', { cashDeskId: c.desk }, 94_000);
    r = await cut('CASH', { casinoId: c.id });
    assert.equal(r.ok, true);
    assert.equal(r.legacy['drawer:Cage:balance'], 94_000);
    assert.equal(await balance(c.id, { kind: 'VAULT', vaultId: c.vault }), 10_000 + 94_000);
    const mt = await one('SELECT cashier_session_id, vault_id FROM money_transactions WHERE id = $1', [r.openings[0].transactionId]);
    assert.deepEqual([mt.cashier_session_id, mt.vault_id], [s, c.vault]);
    assert.equal((await one(`SELECT count(*)::int n FROM ledger_accounts WHERE casino_id = $1 AND kind = 'DRAWER'`, [c.id])).n, 0);
  });

  test('tampered legacy totals abort (stored expected balance differs from the movements)', async () => {
    const c = await newCasino();
    await count(c.id, 'VAULT_CUTOVER', { vaultId: c.vault }, 0);
    await cut('VAULT', { casinoId: c.id });
    const s = await legacyShift(c, 'cashier@example.com', 100, [['CASH_IN', 50]], 150);
    await q('UPDATE cashier_sessions SET expected_balance = 170, difference = -20 WHERE id = $1', [s]);
    await count(c.id, 'DRAWER_CUTOVER', { cashDeskId: c.desk }, 15_000);
    const r = await dry('CASH', { casinoId: c.id });
    assert.ok(failed(r).includes('drawer:Cage:expected_consistent'));
  });

  test('after the cutover, legacy cash writes are refused; only ledger projections are accepted', async () => {
    const c = await newCasino();
    await cashReady(c, 50_000);
    // a 0-float shift may open (no money); a float or a cash movement needs a ledger transaction
    const s = (await one(`INSERT INTO cashier_sessions (org_id, casino_id, cash_desk_id, employee_id, opening_balance) VALUES ($1,$2,$3,$4,0) RETURNING *`, [orgId, c.id, c.desk, emp['cashier@example.com']]));
    await tx(async (db) => assert.rejects(svc.cashier.addCashTx(db, s, 'CASH_IN', 10), /CASH money is on the ledger/));
    await assert.rejects(pool.query(`INSERT INTO cash_transactions (org_id, casino_id, session_id, employee_id, type, amount) VALUES ($1,$2,$3,$4,'CASH_IN',10)`, [orgId, c.id, s.id, emp['cashier@example.com']]), /CASH money is on the ledger/);
    const desk2 = (await one(`INSERT INTO cash_desks (org_id, casino_id, name) VALUES ($1,$2,'Cage 2') RETURNING id`, [orgId, c.id])).id;
    await assert.rejects(pool.query(`INSERT INTO cashier_sessions (org_id, casino_id, cash_desk_id, employee_id, opening_balance) VALUES ($1,$2,$3,$4,500)`, [orgId, c.id, desk2, emp['manager@example.com']]), /CASH is on the ledger/);
    // projection: the ledger transaction first, then the legacy row referencing it, in one database transaction
    await tx(async (db) => {
      const m = await svc.ledger.executeMoneyTransaction(db, {
        orgId, type: 'VAULT_FILL', dedupeKey: `fill-${randomUUID()}`, actor: { type: 'EMPLOYEE', employeeId: emp['manager@example.com'] },
        ctx: { casinoId: c.id, amountCents: cents(1_000), cashierSessionId: s.id, vaultId: c.vault },
      });
      await svc.cashier.addCashTx(db, s, 'FILL', 10, { moneyTransactionId: m.transaction.id });
    });
    assert.equal(await balance(c.id, { kind: 'DRAWER', cashierSessionId: s.id }), 1_000);
    // a projection must reference a ledger transaction of the SAME database transaction
    const old = (await one(`SELECT id FROM money_transactions WHERE casino_id = $1 AND type = 'VAULT_FILL'`, [c.id])).id;
    await assert.rejects(pool.query(`INSERT INTO cash_transactions (org_id, casino_id, session_id, employee_id, type, amount, money_transaction_id) VALUES ($1,$2,$3,$4,'FILL',10,$5)`, [orgId, c.id, s.id, emp['cashier@example.com'], old]), /same database transaction/);
    await q(`UPDATE cashier_sessions SET status = 'CLOSED', closed_at = now(), expected_balance = 0, counted_balance = 0, difference = 0 WHERE id = $1`, [s.id]);
  });
});

describe('HANDPAY', () => {
  test('a legacy payment without jackpot event id stops the cutover (no guessing by amount or time)', async () => {
    const c = await newCasino();
    const s = await legacyShift(c, 'cashier@example.com', 1000, [], undefined);
    const ct = (await one(`INSERT INTO cash_transactions (org_id, casino_id, session_id, employee_id, type, amount, machine_id) VALUES ($1,$2,$3,$4,'HANDPAY',-200,$5) RETURNING id`, [orgId, c.id, s, emp['cashier@example.com'], c.machines[0]])).id;
    await q(`UPDATE cashier_sessions SET status = 'CLOSED', closed_at = now(), expected_balance = 800, counted_balance = 800, difference = 0 WHERE id = $1`, [s]);
    // an unrelated jackpot event of exactly the same amount and time must NOT be used to map it
    await machineEvent(c, c.machines[0], 'JACKPOT', 200);
    const r = await dry('HANDPAY', { casinoId: c.id });
    assert.ok(failed(r).includes('handpay_payments_have_jackpot_event'));
    assert.deepEqual(r.checks.find((x) => x.name === 'handpay_payments_have_jackpot_event')!.detail, {
      unmappedCashTransactionIds: [ct], reason: 'legacy handpay payment without jackpot event id: cannot be mapped deterministically',
    });
  });

  test('paid handpays are history, unpaid ones become HANDPAY_PAYABLE; mapping is by event id 1:1', async () => {
    const c = await newCasino();
    // paid jackpot through the Step 1/4 flow (legacy rails)
    const paidEvent = await machineEvent(c, c.machines[0], 'JACKPOT', 300);
    await q('UPDATE machines SET jackpot_pending = true WHERE id = $1', [c.machines[0]]);
    const paid = await tx((db) => svc.handpays.ensureHandpayForJackpot(db, { orgId, casinoId: c.id, machineId: c.machines[0], eventId: paidEvent, amountCents: 30_000 }));
    const shift = await legacyShift(c, 'cashier@example.com', 1000, []);
    await tx((db) => svc.handpays.payHandpay(db, { orgId, employeeId: emp['cashier@example.com'] }, paid!.id));
    await machineEvent(c, c.machines[0], 'JACKPOT_RESET', null);
    await tx((db) => svc.handpays.confirmHandpayReset(db, { orgId, machineId: c.machines[0] }));
    await q('UPDATE machines SET jackpot_pending = false WHERE id = $1', [c.machines[0]]);
    await q(`UPDATE cashier_sessions SET status = 'CLOSED', closed_at = now(), expected_balance = 700, counted_balance = 700, difference = 0 WHERE id = $1`, [shift]);
    // pending jackpot
    const openEvent = await machineEvent(c, c.machines[1], 'JACKPOT', 512.34);
    await q('UPDATE machines SET jackpot_pending = true WHERE id = $1', [c.machines[1]]);
    const open = await tx((db) => svc.handpays.ensureHandpayForJackpot(db, { orgId, casinoId: c.id, machineId: c.machines[1], eventId: openEvent, amountCents: 51_234 }));

    await count(c.id, 'VAULT_CUTOVER', { vaultId: c.vault }, 0);
    await cut('VAULT', { casinoId: c.id });
    await count(c.id, 'DRAWER_CUTOVER', { cashDeskId: c.desk }, 70_000);
    await cut('CASH', { casinoId: c.id });

    // inconsistency: a jackpot-pending machine without handpay stops the cutover
    await q('UPDATE machines SET jackpot_pending = true WHERE id = $1', [c.machines[0]]);
    let r = await dry('HANDPAY', { casinoId: c.id });
    assert.deepEqual(failed(r), ['pending_jackpots_have_one_handpay']);
    await q('UPDATE machines SET jackpot_pending = false WHERE id = $1', [c.machines[0]]);

    r = await cut('HANDPAY', { casinoId: c.id });
    assert.equal(r.ok, true);
    assert.deepEqual(r.openings.map((o) => [o.sourceTable, o.sourceId, o.accountKind, o.amountCents]), [['handpays', open!.id, 'HANDPAY_PAYABLE', 51_234]]);
    assert.equal(await balance(c.id, { kind: 'HANDPAY_PAYABLE' }), 51_234);
    assert.deepEqual([r.legacy.paid_count, r.legacy.unpaid_count], [1, 1]);
    const mt = await one('SELECT handpay_id, machine_id FROM money_transactions WHERE id = $1', [r.openings[0].transactionId]);
    assert.deepEqual([mt.handpay_id, mt.machine_id], [open!.id, c.machines[1]]);

    // after the cutover: the legacy payment path is refused (no second, independent money write)
    const s2 = await legacyShift(c, 'cashier@example.com', 0, []);
    await assert.rejects(tx((db) => svc.handpays.payHandpay(db, { orgId, employeeId: emp['cashier@example.com'] }, open!.id)), /money is on the ledger/);
    assert.equal((await one('SELECT status FROM handpays WHERE id = $1', [open!.id])).status, 'PENDING');
    // a new jackpot cannot create a handpay without its ledger transaction
    const e3 = await machineEvent(c, c.machines[0], 'JACKPOT', 10);
    await assert.rejects(tx((db) => svc.handpays.ensureHandpayForJackpot(db, { orgId, casinoId: c.id, machineId: c.machines[0], eventId: e3, amountCents: 1_000 })), /HANDPAY is on the ledger/);
    await q(`UPDATE cashier_sessions SET status = 'CLOSED', closed_at = now(), expected_balance = 0, counted_balance = 0, difference = 0 WHERE id = $1`, [s2]);
  });
});

describe('TITO', () => {
  test('expiry and stale holds are applied atomically first; VALID + HELD become the liability, nothing else', async () => {
    const c = await newCasino();
    await cashReady(c);
    const valid = await ticket(c, 4_250);
    const expiring = await ticket(c, 1_000, 'VALID', { expiresInDays: -1 });
    const heldActive = await ticket(c, 2_000, 'VALID', { hold: { secondsLeft: 30 } });
    const heldStale = await ticket(c, 3_000, 'VALID', { hold: { secondsLeft: -3600 } });
    for (const s of ['REDEEMED', 'CANCELLED', 'VOID', 'EXPIRED']) await ticket(c, 9_999, s);

    const r = await cut('TITO', { casinoId: c.id });
    assert.equal(r.ok, true);
    assert.equal(r.legacy.outstanding_total, 4_250 + 2_000 + 3_000);
    assert.deepEqual([r.legacy.valid_count, r.legacy.held_count, r.legacy.expired_at_cutover, r.legacy.holds_released_at_cutover], [2, 1, 1, 1]);
    assert.equal(await balance(c.id, { kind: 'TICKET_LIABILITY' }), 9_250);
    assert.deepEqual(r.openings.map((o) => o.sourceId).sort(), [valid, heldActive, heldStale].sort());
    assert.equal((await one('SELECT status FROM tickets WHERE id = $1', [expiring])).status, 'EXPIRED');
    assert.equal((await one('SELECT status FROM tickets WHERE id = $1', [heldStale])).status, 'VALID');
    assert.ok(await one(`SELECT 1 FROM ticket_events WHERE ticket_id = $1 AND action = 'EXPIRED' AND details->>'source' = 'cutover'`, [expiring]));
    for (const id of [valid, heldActive, heldStale]) {
      const mt = await one(`SELECT ticket_id, amount_cents FROM money_transactions WHERE dedupe_key = $1`, [`backfill:006:TITO:tickets:${id}`]);
      assert.equal(mt.ticket_id, id);
    }
    // no duplicate liability: a ticket is a backfill source exactly once
    await assert.rejects(pool.query(`INSERT INTO money_backfill_items (cutover_id, org_id, source_table, source_id, account_kind, amount_cents) VALUES ($1,$2,'tickets',$3,'TICKET_LIABILITY',0)`, [r.cutoverId, orgId, valid]), /money_backfill_items_once|immutable/);

    // after the cutover: legacy ticket writes need a ledger transaction; holds (no money) still work
    await assert.rejects(ticket(c, 500), /TITO is on the ledger/);
    await assert.rejects(pool.query(`UPDATE tickets SET status = 'REDEEMED' WHERE id = $1`, [valid]), /TITO is on the ledger/);
    await q(`UPDATE tickets SET status = 'HELD', hold_id = gen_random_uuid(), hold_until = now() + interval '30 seconds', hold_source = 'MACHINE' WHERE id = $1`, [valid]);
    // legacy maintenance expiry skips casinos whose TITO rail is on the ledger
    await q(`UPDATE tickets SET hold_id = NULL, hold_until = NULL, hold_source = NULL, status = 'VALID' WHERE id = $1`, [valid]);
    const maintenanceExpiry = `UPDATE tickets SET status = 'EXPIRED' WHERE status = 'VALID' AND expires_at <= now() + interval '400 days' AND casino_id = $1 AND NOT money_rail_ledger(org_id, casino_id, 'TITO', NULL)`;
    assert.equal((await pool.query(maintenanceExpiry, [c.id])).rowCount, 0);
  });

  test('interrupted cutover: everything rolls back (openings, expiry, items) and the rerun succeeds once', async () => {
    const c = await newCasino();
    await cashReady(c);
    await ticket(c, 1_500);
    const expiring = await ticket(c, 700, 'VALID', { expiresInDays: -1 });
    const before_ = await moneyCount();
    await assert.rejects(cut('TITO', { casinoId: c.id }, { failAfterOpenings: true }), /Injected failure/);
    assert.deepEqual(await moneyCount(), before_);
    assert.equal((await one('SELECT status FROM tickets WHERE id = $1', [expiring])).status, 'VALID');
    assert.equal(await onLedger('TITO', c.id), false);
    const r = await cut('TITO', { casinoId: c.id });
    assert.equal(r.openings.length, 1);
    assert.equal(await balance(c.id, { kind: 'TICKET_LIABILITY' }), 1_500);
  });

  test('concurrent cutovers of the same rail: exactly one executes, the other replays it', async () => {
    const c = await newCasino();
    await cashReady(c);
    for (let i = 0; i < 5; i++) await ticket(c, 100 * (i + 1));
    const results = await Promise.all([cut('TITO', { casinoId: c.id }), cut('TITO', { casinoId: c.id }), cut('TITO', { casinoId: c.id })]);
    assert.equal(results.filter((r) => !r.replayed).length, 1);
    assert.equal(new Set(results.map((r) => r.cutoverId)).size, 1);
    assert.equal(await balance(c.id, { kind: 'TICKET_LIABILITY' }), 1_500);
    assert.equal((await one(`SELECT count(*)::int n FROM money_transactions WHERE casino_id = $1 AND type = 'OPENING_BALANCE' AND ticket_id IS NOT NULL`, [c.id])).n, 5);
  });

  test('no stray opening balance can exist before the cutover (service and database refuse it)', async () => {
    const c = await newCasino();
    await cashReady(c);
    await ticket(c, 1_000);
    await assert.rejects(tx((db) => svc.ledger.executeMoneyTransaction(db, {
      orgId, type: 'OPENING_BALANCE', dedupeKey: `stray-${randomUUID()}`, actor: { type: 'SYSTEM' },
      ctx: { casinoId: c.id, amountCents: cents(1), debit: { kind: 'OPENING_EQUITY' }, credit: { kind: 'TICKET_LIABILITY' }, backfillSource: { table: 'tickets', id: randomUUID() } },
    })), /only created by a rail cutover/);
    const r = await dry('TITO', { casinoId: c.id });
    assert.equal(r.ok, true, JSON.stringify(failed(r)));
    assert.ok(r.checks.some((x) => x.name === 'ledger_empty_before_cutover' && x.ok));
  });
});

describe('CASHLESS', () => {
  test('wallets open at zero; never from points, tier or play history; pending work and missing wallets abort', async () => {
    const org = (await one(`INSERT INTO organizations (name, slug) VALUES ('Cashless Org', 'cashless-org') RETURNING id`)).id;
    const casino = (await one(`INSERT INTO casinos (org_id, code, name) VALUES ($1,'CL-1','CL') RETURNING id`, [org])).id;
    const player = (await one(`INSERT INTO players (org_id) VALUES ($1) RETURNING id`, [org])).id;
    await q(`INSERT INTO player_profiles (player_id, org_id, first_name) VALUES ($1,$2,'Rich')`, [player, org]);
    // legacy loyalty data (points, tier) must never become money
    await q(`UPDATE players SET points = 99999, tier = 'VIP' WHERE id = $1`, [player]);
    const system = { orgId: org };
    let r = await svc.cutover.dryRunCutover(pool, system, { rail: 'CASHLESS' });
    assert.deepEqual(failed(r), ['every_player_has_wallet']);
    await q('INSERT INTO wallets (org_id, player_id) VALUES ($1,$2)', [org, player]);
    // cashless money cannot move before the cutover
    await assert.rejects(tx((db) => svc.cashless.requestTransfer(db, { orgId: org }, { sessionId: randomUUID(), direction: 'TO_MACHINE', amountCents: 100, requestKey: 'k-12345678' })), /CASHLESS money is not on the ledger yet/);
    r = await svc.cutover.runCutover(pool, system, { rail: 'CASHLESS' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.openings, []);
    assert.equal(r.ledger.wallet_money, 0);
    const w = await one('SELECT available_cents, reserved_cents FROM wallet_balances WHERE player_id = $1', [player]);
    assert.deepEqual([w.available_cents, w.reserved_cents], [0, 0]);
    assert.equal((await one(`SELECT count(*)::int n FROM money_transactions WHERE org_id = $1`, [org])).n, 0);
    void casino;
  });
});

describe('MACHINE', () => {
  test('after a verified collection that matches the legacy cash-in; credit, cashbox and hopper open at 0', async () => {
    const c = await newCasino();
    const m = c.machines[0];
    const asset = (await one('SELECT asset_no FROM machines WHERE id = $1', [m])).asset_no;
    await machineEvent(c, m, 'CASH_IN', 100);
    await machineEvent(c, m, 'COIN_IN', 20); // legacy wire name, same money
    await machineEvent(c, m, 'GAME_PLAYED', 5, { bet: 5, win: 50 }); // gaming: never money
    const early = await count(c.id, 'MACHINE_DROP', { machineId: m }, 12_000); // before the vault cutover
    let r = await dry('MACHINE', { casinoId: c.id, machineId: m });
    for (const pre of ['VAULT', 'TITO', 'HANDPAY']) assert.ok(failed(r).includes(`prerequisite:${pre}`), pre);

    await cashReady(c);
    await cut('HANDPAY', { casinoId: c.id });
    await cut('TITO', { casinoId: c.id });
    r = await dry('MACHINE', { casinoId: c.id, machineId: m });
    assert.deepEqual(failed(r), [`machine:${asset}:count_current`]);
    void early;

    await count(c.id, 'MACHINE_DROP', { machineId: m }, 11_000);
    r = await dry('MACHINE', { casinoId: c.id, machineId: m });
    assert.deepEqual(failed(r), [`machine:${asset}:collection_matches_legacy_cash_in`]);

    await count(c.id, 'MACHINE_DROP', { machineId: m }, 12_000);
    await machineEvent(c, m, 'CASH_IN', 5); // the machine was played after the collection
    r = await dry('MACHINE', { casinoId: c.id, machineId: m });
    assert.deepEqual(failed(r), [`machine:${asset}:idle_since_collection`]);

    // second machine: clean collection
    const m2 = c.machines[1];
    await machineEvent(c, m2, 'CASH_IN', 50);
    await count(c.id, 'MACHINE_DROP', { machineId: m2 }, 5_000);
    const vaultBefore = await balance(c.id, { kind: 'VAULT', vaultId: c.vault });
    r = await cut('MACHINE', { casinoId: c.id, machineId: m2 });
    assert.equal(r.ok, true);
    assert.equal(await balance(c.id, { kind: 'VAULT', vaultId: c.vault }), vaultBefore + 5_000);
    for (const kind of ['MACHINE_CREDIT', 'CASHBOX', 'HOPPER']) assert.equal(await balance(c.id, { kind, machineId: m2 }), 0);
    assert.equal((await one(`SELECT count(*)::int n FROM money_transactions WHERE machine_id = $1 AND type = 'GAMING_SETTLEMENT'`, [m2])).n, 0);
    assert.equal(await onLedger('MACHINE', c.id, m2), true);
    assert.equal(await onLedger('MACHINE', c.id, m), false);

    // after the cutover: money events / collections of that machine need their ledger transaction
    await assert.rejects(machineEvent(c, m2, 'CASH_IN', 10), /machine money is on the ledger/);
    await assert.rejects(pool.query(
      `INSERT INTO cash_collections (org_id, casino_id, machine_id, period_start, period_end, expected_cash, expected_tickets, counted_cash, counted_tickets, difference, collected_by)
       VALUES ($1,$2,$3,now(),now(),0,0,0,0,0,$4)`, [orgId, c.id, m2, emp['manager@example.com']]), /machine money is on the ledger/);
    await machineEvent(c, m2, 'MACHINE_DOOR_OPEN', null); // non-money events are unaffected
    await machineEvent(c, m, 'CASH_IN', 10); // the other machine is still legacy
  });
});

describe('HTTP and invariants', () => {
  test('cutover routes need money.cutover; counts need cash.manage; the abort report is returned', async () => {
    const h = (email: string, key = randomUUID()) => ({ authorization: `Bearer ${tokens[email]}`, 'idempotency-key': key });
    let res = await app.inject({ method: 'POST', url: '/api/v1/money/cutover', headers: h('manager@example.com'), payload: { rail: 'VAULT', casinoId: casinoA } });
    assert.equal(res.statusCode, 403);
    res = await app.inject({ method: 'POST', url: '/api/v1/money/cutover', headers: h('admin@example.com'), payload: { rail: 'VAULT', casinoId: casinoA } });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /not released yet/, 'production cutover only for released rails (Step 7a)');
    res = await app.inject({ method: 'POST', url: '/api/v1/money/cutover/dry-run', headers: h('admin@example.com'), payload: { rail: 'VAULT', casinoId: casinoA } });
    assert.ok(res.json().checks.some((x: { name: string; ok: boolean }) => x.name === 'vault:Main Vault:count_exists' && !x.ok));
    res = await app.inject({ method: 'POST', url: '/api/v1/money/cutover/dry-run', headers: h('admin@example.com'), payload: { rail: 'TITO', casinoId: casinoA } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, false);
    const vault = (await one('SELECT id FROM vaults WHERE casino_id = $1', [casinoA])).id;
    res = await app.inject({ method: 'POST', url: '/api/v1/money/counts', headers: h('manager@example.com'), payload: { casinoId: casinoA, context: 'VAULT_CUTOVER', vaultId: vault, denominations: { '5000': 3 } } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().total_cents, 15_000);
    res = await app.inject({ method: 'POST', url: `/api/v1/money/counts/${res.json().id}/verify`, headers: h('admin@example.com'), payload: { totalCents: 15_000 } });
    assert.equal(res.json().matches, true);
    res = await app.inject({ method: 'GET', url: `/api/v1/money/rails?casinoId=${casinoA}`, headers: h('admin@example.com') });
    assert.deepEqual(res.json().rails.map((r: { rail: string; mode: string }) => `${r.rail}:${r.mode}`), ['VAULT:LEGACY', 'CASH:LEGACY', 'HANDPAY:LEGACY', 'TITO:LEGACY', 'CASHLESS:LEDGER']);
  });

  test('the demo casino keeps working on legacy rails (no cutover happened there)', async () => {
    const desks = (await app.inject({ method: 'GET', url: `/api/v1/cashier/desks?casinoId=${casinoA}`, headers: { authorization: `Bearer ${tokens['cashier@example.com']}` } })).json();
    const res = await app.inject({ method: 'POST', url: '/api/v1/cashier/session/open', headers: { authorization: `Bearer ${tokens['cashier@example.com']}`, 'idempotency-key': `open-${randomUUID()}` }, payload: { cashDeskId: desks[0].id, openingBalance: 500 } });
    assert.equal(res.statusCode, 200);
    const t = await app.inject({ method: 'POST', url: '/api/v1/cashier/transactions', headers: { authorization: `Bearer ${tokens['cashier@example.com']}`, 'idempotency-key': `tx-${randomUUID()}` }, payload: { type: 'CASH_IN', amount: 20 } });
    assert.equal(t.statusCode, 200);
  });

  test('ledger invariants hold; every opening has exactly one backfill item and source', async () => {
    const inv = await svc.ledger.checkLedgerInvariants(pool, orgId);
    assert.equal(inv.ok, true, JSON.stringify(inv));
    const orphan = await one(`SELECT count(*)::int n FROM money_transactions t WHERE t.type = 'OPENING_BALANCE' AND t.dedupe_key LIKE 'backfill:006:%' AND NOT EXISTS (SELECT 1 FROM money_backfill_items i WHERE i.money_transaction_id = t.id)`);
    assert.equal(orphan.n, 0);
    const mismatch = await one(`SELECT count(*)::int n FROM money_backfill_items i JOIN money_transactions t ON t.id = i.money_transaction_id WHERE t.amount_cents <> i.amount_cents OR t.options->'backfillSource'->>'id' <> i.source_id`);
    assert.equal(mismatch.n, 0);
  });
});
