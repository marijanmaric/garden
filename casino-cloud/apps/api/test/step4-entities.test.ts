import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { withTransaction, type Pool, type PoolClient } from '@m1/database';
import { APPROVAL_TRANSITIONS, HANDPAY_TRANSITIONS, TRANSFER_TRANSITIONS, VAULT_SESSION_TRANSITIONS, WALLET_TRANSITIONS, cents } from '@m1/shared';
import { setupTestDatabase } from './helpers';
import { createLedgerCasino, openLedgerShift } from './ledger-casino';

let app: FastifyInstance;
let pool: Pool;
let svc: {
  players: typeof import('../src/services/players');
  wallets: typeof import('../src/services/wallets');
  cashless: typeof import('../src/services/cashless');
  handpays: typeof import('../src/services/handpays');
  vault: typeof import('../src/services/vault');
  approvals: typeof import('../src/services/approvals');
  holds: typeof import('../src/services/ticket-holds');
  ledger: typeof import('../src/services/ledger');
};
let ingestEvents: typeof import('../src/services/ingest').ingestEvents;
let orgId: string;
let orgB: string;
let casinoA: string;
let casinoB: string;
let gw: { id: string; orgId: string; casinoId: string; deviceId: string };
let machines: Record<string, { id: string; code: string }>;
let emp: Record<string, string>;
let tokens: Record<string, string>;
let cashierSession: string;
// D7: wallet / cashless money runs on a casino cut over to the ledger; legacy flows stay on casinoA.
let ledgerCasino: string;
let ledgerSession: string;
let lmachines: Record<string, { id: string; code: string }>;
const tx = <T>(fn: (db: PoolClient) => Promise<T>) => withTransaction(pool, fn);
const key = (p = 'k') => `${p}-${randomUUID()}`;
const actor = (email: string) => ({ orgId, employeeId: emp[email], employeeEmail: email });
const scoped = (email: string, casinoIds = [casinoA]) => ({ ...actor(email), casinoIds });
const system = { get orgId() { return orgId; } };

async function machineEvent(asset: string, type: string, extra: Record<string, unknown> = {}) {
  const eventId = randomUUID();
  const r = await ingestEvents(gw, [{ eventId, type: type as never, machineId: machines[asset].code, timestamp: new Date().toISOString(), ...extra }]);
  assert.equal(r.accepted, 1);
  return eventId;
}

async function newPlayerWithCard() {
  const cardNumber = `S4-${randomUUID().slice(0, 8)}`;
  const r = await tx((db) => svc.players.createPlayer(db, actor('admin@example.com'), { homeCasinoId: casinoA, card: { cardNumber } }));
  return { ...r, cardNumber, walletId: r.wallet.id as string };
}

async function deposit(walletId: string, playerId: string, amountCents: number) {
  await tx((db) => svc.ledger.executeMoneyTransaction(db, {
    orgId, type: 'CASH_DEPOSIT', dedupeKey: key('dep'), actor: { type: 'SYSTEM' },
    ctx: { casinoId: ledgerCasino, amountCents: cents(amountCents), playerId, walletId, cashierSessionId: ledgerSession },
  }));
}

const balances = (walletId: string) => svc.wallets.walletBalances(pool, orgId, walletId);
const machineCredit = (machineId: string) => svc.ledger.getBalance(pool, orgId, { kind: 'MACHINE_CREDIT', casinoId: ledgerCasino, machineId });

function post(user: string, url: string, payload: unknown, k = key()) {
  return app.inject({ method: 'POST', url, payload: payload as object, headers: { authorization: `Bearer ${tokens[user]}`, 'idempotency-key': k } });
}

before(async () => {
  ({ app, pool } = await setupTestDatabase());
  svc = {
    players: await import('../src/services/players'),
    wallets: await import('../src/services/wallets'),
    cashless: await import('../src/services/cashless'),
    handpays: await import('../src/services/handpays'),
    vault: await import('../src/services/vault'),
    approvals: await import('../src/services/approvals'),
    holds: await import('../src/services/ticket-holds'),
    ledger: await import('../src/services/ledger'),
  };
  ({ ingestEvents } = await import('../src/services/ingest'));
  const g = (await pool.query(`SELECT id, org_id, casino_id, device_id FROM gateways WHERE device_id = 'GW-VIE-001'`)).rows[0];
  gw = { id: g.id, orgId: g.org_id, casinoId: g.casino_id, deviceId: g.device_id };
  orgId = g.org_id;
  casinoA = g.casino_id;
  orgB = (await pool.query(`SELECT id FROM organizations WHERE slug = 'riverside'`)).rows[0].id;
  casinoB = (await pool.query(`INSERT INTO casinos (org_id, code, name) VALUES ($1, 'VIE-002', 'Second Casino') RETURNING id`, [orgId])).rows[0].id;
  await pool.query(`INSERT INTO casino_money_settings (casino_id, org_id) VALUES ($1,$2)`, [casinoB, orgId]);
  await pool.query(`INSERT INTO vaults (org_id, casino_id, name) VALUES ($1,$2,'Main Vault')`, [orgId, casinoB]);
  machines = Object.fromEntries((await pool.query('SELECT id, machine_code, asset_no FROM machines WHERE org_id = $1', [orgId])).rows.map((r) => [r.asset_no, { id: r.id, code: r.machine_code }]));
  emp = Object.fromEntries((await pool.query('SELECT email, id FROM employees')).rows.map((r) => [r.email, r.id]));
  tokens = {};
  for (const u of ['cashier@example.com', 'attendant@example.com', 'manager@example.com'])
    tokens[u] = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u, password: 'demo' } })).json().token;
  const desks = (await app.inject({ method: 'GET', url: `/api/v1/cashier/desks?casinoId=${casinoA}`, headers: { authorization: `Bearer ${tokens['cashier@example.com']}` } })).json();
  cashierSession = (await post('cashier@example.com', '/api/v1/cashier/session/open', { cashDeskId: desks[0].id, openingBalance: 5000 })).json().id;
  assert.equal((await post('attendant@example.com', '/api/v1/cashier/session/open', { cashDeskId: desks[1].id, openingBalance: 5000 })).statusCode, 200);
  assert.equal((await post('manager@example.com', '/api/v1/cashier/session/open', { cashDeskId: desks[2].id, openingBalance: 5000 })).statusCode, 200);
  const l = await createLedgerCasino(pool, { orgId, code: 'VIE-L4', machines: 9 });
  ledgerCasino = l.id;
  lmachines = Object.fromEntries(l.machines.map((m, i) => [`M00${i + 1}`, { id: m.id, code: m.code }]));
  ledgerSession = await openLedgerShift(pool, l, { cashierEmail: 'admin@example.com', floatCents: 5_000_000 });
});

after(async () => {
  await app?.close();
  await pool?.end();
});

describe('model consistency', () => {
  test('database transition triggers mirror the shared state machines', async () => {
    const triggers = (await pool.query(`SELECT tgname, tgargs FROM pg_trigger WHERE tgname LIKE '%_transition'`)).rows;
    const args = (name: string) => {
      const raw: Buffer = triggers.find((t) => t.tgname === name)!.tgargs;
      return raw.toString('utf8').split('\u0000').filter(Boolean).sort();
    };
    const flat = (map: Record<string, readonly string[]>) => Object.entries(map).flatMap(([f, ts]) => ts.map((t) => `${f}>${t}`)).sort();
    assert.deepEqual(args('wallets_transition'), flat(WALLET_TRANSITIONS.map));
    assert.deepEqual(args('wallet_transfers_transition'), flat(TRANSFER_TRANSITIONS.map));
    assert.deepEqual(args('handpays_transition'), flat(HANDPAY_TRANSITIONS.map));
    assert.deepEqual(args('vault_sessions_transition'), flat(VAULT_SESSION_TRANSITIONS.map));
    assert.deepEqual(args('approvals_transition'), flat(APPROVAL_TRANSITIONS.map));
  });

  test('all previously open ledger references now have foreign keys', async () => {
    const fks = (await pool.query(`SELECT conname FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text IN ('money_transactions', 'ledger_accounts', 'machine_commands', 'cashier_sessions', 'tickets')`)).rows.map((r) => r.conname);
    for (const name of ['money_transactions_wallet_fk', 'money_transactions_vault_fk', 'money_transactions_handpay_fk', 'money_transactions_transfer_fk', 'ledger_accounts_wallet_fk', 'ledger_accounts_vault_fk'])
      assert.ok(fks.includes(name), name);
    assert.ok(fks.some((n) => n.startsWith('machine_commands_handpay_id')));
    assert.ok(fks.some((n) => n.startsWith('machine_commands_transfer_id')));
    assert.ok(fks.some((n) => n.startsWith('cashier_sessions_vault_session_id')));
    assert.ok(fks.some((n) => n.startsWith('tickets_hold_machine_id')));
  });

  test('no circular foreign keys between entities and money transactions', async () => {
    const back = (await pool.query(`SELECT conrelid::regclass::text AS t FROM pg_constraint WHERE contype = 'f' AND confrelid = 'money_transactions'::regclass`)).rows.map((r) => r.t).sort();
    // The ledger itself (entries, reversal), approvals, the legacy projections (cash_transactions, 006),
    // backfill items (006), vault movements and count settlements (007), deferred ticket events (010), ledger machine
    // collections (011) and exception dispositions (014) point at money transactions; none is referenced back.
    assert.deepEqual(back, ['approvals', 'cash_collections', 'cash_movements', 'cash_transactions', 'count_settlements', 'deferred_money_events', 'ledger_entries', 'machine_event_dispositions', 'money_backfill_items', 'money_transactions']);
  });
});

describe('wallet', () => {
  test('one wallet per player, created at registration, organisation-level', async () => {
    const p = await newPlayerWithCard();
    assert.ok(p.walletId);
    await assert.rejects(tx((db) => svc.wallets.createWallet(db, actor('admin@example.com'), p.player.id)), /already has a wallet/);
    await assert.rejects(pool.query('INSERT INTO wallets (org_id, player_id) VALUES ($1,$2)', [orgId, p.player.id]), /duplicate key/);
    await assert.rejects(pool.query('INSERT INTO wallets (org_id, player_id) VALUES ($1,$2)', [orgB, p.player.id]), /another organisation|duplicate/);
    const seeded = (await pool.query('SELECT count(*)::int n FROM players p JOIN wallets w ON w.player_id = p.id WHERE p.org_id = $1', [orgId])).rows[0].n;
    assert.ok(seeded >= 60);
    const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'wallets'`)).rows.map((r) => r.column_name);
    assert.ok(!cols.some((c) => /balance|casino|name|email/.test(c)), 'no balance, casino or identity fields on wallets');
  });

  test('balances come from the ledger; wallet usable from every casino of the organisation', async () => {
    const p = await newPlayerWithCard();
    await deposit(p.walletId, p.player.id, 10_000);
    assert.equal((await balances(p.walletId)).available_cents, 10_000);
    const accounts = (await pool.query('SELECT casino_id FROM ledger_accounts WHERE wallet_id = $1', [p.walletId])).rows;
    assert.ok(accounts.every((a) => a.casino_id === null));
  });

  test('ACTIVE / BLOCKED / CLOSED with documented rules; CLOSED needs zero balance and is terminal', async () => {
    const p = await newPlayerWithCard();
    await tx((db) => svc.wallets.setWalletStatus(db, actor('manager@example.com'), p.walletId, 'BLOCKED', 'suspicious activity'));
    await assert.rejects(tx((db) => svc.cashless.openCashlessSession(db, actor('attendant@example.com'), { cardNumber: p.cardNumber, machineId: lmachines.M001.id, requestKey: key() })), /Wallet status BLOCKED/);
    await tx((db) => svc.wallets.setWalletStatus(db, actor('manager@example.com'), p.walletId, 'ACTIVE', 'cleared'));
    await deposit(p.walletId, p.player.id, 500);
    await assert.rejects(tx((db) => svc.wallets.setWalletStatus(db, actor('manager@example.com'), p.walletId, 'CLOSED', 'player request')), /must be zero/);
    await tx((db) => svc.ledger.executeMoneyTransaction(db, { orgId, type: 'CASH_WITHDRAWAL', dedupeKey: key(), actor: { type: 'SYSTEM' }, ctx: { casinoId: ledgerCasino, amountCents: cents(500), playerId: p.player.id, walletId: p.walletId, cashierSessionId: ledgerSession } }));
    await tx((db) => svc.wallets.setWalletStatus(db, actor('manager@example.com'), p.walletId, 'CLOSED', 'player request'));
    await assert.rejects(pool.query(`UPDATE wallets SET status = 'ACTIVE' WHERE id = $1`, [p.walletId]), /cannot change from CLOSED/);
    await assert.rejects(pool.query('DELETE FROM wallets WHERE id = $1', [p.walletId]), /append-only/);
  });

  test('player status restrictions apply to the wallet', async () => {
    const p = await newPlayerWithCard();
    await tx((db) => svc.players.changePlayerStatus(db, actor('manager@example.com'), p.player.id, 'EXCLUDED', 'self exclusion'));
    await assert.rejects(tx((db) => svc.cashless.openCashlessSession(db, actor('attendant@example.com'), { cardNumber: p.cardNumber, machineId: lmachines.M001.id, requestKey: key() })), /does not allow/);
    const w = await svc.wallets.lockWallet(pool, orgId, p.walletId);
    svc.wallets.assertWalletOperation(w, 'WITHDRAW');
    svc.wallets.assertWalletOperation(w, 'FROM_MACHINE');
    assert.throws(() => svc.wallets.assertWalletOperation(w, 'DEPOSIT'));
  });
});

describe('cashless sessions and transfers', () => {
  test('session ties player, card, wallet and machine; card is only the identifier', async () => {
    const p = await newPlayerWithCard();
    const { session } = await tx((db) => svc.cashless.openCashlessSession(db, actor('attendant@example.com'), { cardNumber: p.cardNumber, machineId: lmachines.M002.id, requestKey: key() }));
    assert.deepEqual([session.player_id, session.card_id, session.wallet_id, session.machine_id, session.casino_id], [p.player.id, p.card!.id, p.walletId, lmachines.M002.id, ledgerCasino]);
    await tx((db) => svc.cashless.closeCashlessSession(db, actor('attendant@example.com'), session.id));
  });

  test('unknown, blocked and foreign-organisation inputs are rejected', async () => {
    const p = await newPlayerWithCard();
    await assert.rejects(tx((db) => svc.cashless.openCashlessSession(db, actor('attendant@example.com'), { cardNumber: 'NOPE-0000', machineId: lmachines.M003.id, requestKey: key() })), /Unknown player card/);
    await tx((db) => svc.players.setCardStatus(db, actor('manager@example.com'), p.card!.id, 'BLOCKED'));
    await assert.rejects(tx((db) => svc.cashless.openCashlessSession(db, actor('attendant@example.com'), { cardNumber: p.cardNumber, machineId: lmachines.M003.id, requestKey: key() })), /blocked/);
    const casinoOrgB = (await pool.query('SELECT id FROM casinos WHERE org_id = $1', [orgB])).rows[0].id;
    const foreignMachine = (await pool.query(`INSERT INTO machines (org_id, casino_id, machine_code, asset_no) VALUES ($1,$2,'RIV-1','R01') RETURNING id`, [orgB, casinoOrgB])).rows[0].id;
    const q = await newPlayerWithCard();
    await assert.rejects(tx((db) => svc.cashless.openCashlessSession(db, actor('attendant@example.com'), { cardNumber: q.cardNumber, machineId: foreignMachine, requestKey: key() })), /Machine not found/);
    // Database guard: card of another player
    await assert.rejects(pool.query(
      `INSERT INTO cashless_sessions (org_id, casino_id, wallet_id, player_id, card_id, machine_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [orgId, ledgerCasino, q.walletId, q.player.id, p.card!.id, lmachines.M003.id],
    ), /card does not belong/);
  });

  test('duplicate open requests are idempotent; one open session per machine and per wallet', async () => {
    const p = await newPlayerWithCard();
    const k = key('open');
    const a = await tx((db) => svc.cashless.openCashlessSession(db, actor('attendant@example.com'), { cardNumber: p.cardNumber, machineId: lmachines.M004.id, requestKey: k }));
    const b = await tx((db) => svc.cashless.openCashlessSession(db, actor('attendant@example.com'), { cardNumber: p.cardNumber, machineId: lmachines.M004.id, requestKey: k }));
    assert.equal(b.replayed, true);
    assert.equal(a.session.id, b.session.id);
    await assert.rejects(tx((db) => svc.cashless.openCashlessSession(db, actor('attendant@example.com'), { cardNumber: p.cardNumber, machineId: lmachines.M005.id, requestKey: k })), /different session/);
    const q = await newPlayerWithCard();
    await assert.rejects(tx((db) => svc.cashless.openCashlessSession(db, actor('attendant@example.com'), { cardNumber: q.cardNumber, machineId: lmachines.M004.id, requestKey: key() })), /Machine already has an open/);
    await assert.rejects(tx((db) => svc.cashless.openCashlessSession(db, actor('attendant@example.com'), { cardNumber: p.cardNumber, machineId: lmachines.M006.id, requestKey: key() })), /Wallet already has an open/);
    await tx((db) => svc.cashless.closeCashlessSession(db, actor('attendant@example.com'), a.session.id));
  });

  test('wallet -> machine: REQUESTED only reserves, CONFIRMED moves money to the machine', async () => {
    const p = await newPlayerWithCard();
    await deposit(p.walletId, p.player.id, 10_000);
    const { session } = await tx((db) => svc.cashless.openCashlessSession(db, actor('attendant@example.com'), { cardNumber: p.cardNumber, machineId: lmachines.M007.id, requestKey: key() }));
    const creditBefore = await machineCredit(lmachines.M007.id);
    const k = key('tr');
    const { transfer } = await tx((db) => svc.cashless.requestTransfer(db, actor('attendant@example.com'), { sessionId: session.id, direction: 'TO_MACHINE', amountCents: 3_000, requestKey: k }));
    assert.equal(transfer.status, 'REQUESTED');
    assert.deepEqual([(await balances(p.walletId)).available_cents, (await balances(p.walletId)).reserved_cents], [7_000, 3_000]);
    assert.equal(await machineCredit(lmachines.M007.id), creditBefore, 'requested is not a completed movement');
    const replay = await tx((db) => svc.cashless.requestTransfer(db, actor('attendant@example.com'), { sessionId: session.id, direction: 'TO_MACHINE', amountCents: 3_000, requestKey: k }));
    assert.equal(replay.replayed, true);
    await assert.rejects(tx((db) => svc.cashless.confirmTransfer(db, system, { transferId: transfer.id })), /from REQUESTED to CONFIRMED/);
    await tx((db) => svc.cashless.markTransferSent(db, system, transfer.id));
    await tx((db) => svc.cashless.confirmTransfer(db, system, { transferId: transfer.id }));
    assert.deepEqual([(await balances(p.walletId)).available_cents, (await balances(p.walletId)).reserved_cents], [7_000, 0]);
    assert.equal(await machineCredit(lmachines.M007.id), creditBefore + 3_000);
    await assert.rejects(tx((db) => svc.cashless.endTransfer(db, system, transfer.id, 'FAILED', 'late')), /from CONFIRMED to FAILED/);
    await assert.rejects(pool.query(`UPDATE wallet_transfers SET status = 'FAILED' WHERE id = $1`, [transfer.id]), /cannot change from CONFIRMED/);
    const txs = (await pool.query('SELECT type FROM money_transactions WHERE transfer_id = $1 ORDER BY created_at', [transfer.id])).rows.map((r) => r.type);
    assert.deepEqual(txs, ['WALLET_TO_MACHINE_RESERVE', 'WALLET_TO_MACHINE_CONFIRM']);
    await tx((db) => svc.cashless.closeCashlessSession(db, actor('attendant@example.com'), session.id));
  });

  test('failed and expired transfers release the reservation; insufficient funds create no transfer', async () => {
    const p = await newPlayerWithCard();
    await deposit(p.walletId, p.player.id, 5_000);
    const { session } = await tx((db) => svc.cashless.openCashlessSession(db, actor('attendant@example.com'), { cardNumber: p.cardNumber, machineId: lmachines.M008.id, requestKey: key() }));
    const req = (amountCents: number) => tx((db) => svc.cashless.requestTransfer(db, actor('attendant@example.com'), { sessionId: session.id, direction: 'TO_MACHINE', amountCents, requestKey: key() }));
    const a = await req(2_000);
    await assert.rejects(req(1_000), /transfer in progress/);
    await assert.rejects(tx((db) => svc.cashless.closeCashlessSession(db, actor('attendant@example.com'), session.id)), /transfer in progress/);
    await tx((db) => svc.cashless.endTransfer(db, system, a.transfer.id, 'FAILED', 'machine rejected'));
    assert.equal((await balances(p.walletId)).available_cents, 5_000);
    const b = await req(1_500);
    await pool.query(`UPDATE wallet_transfers SET expires_at = now() - interval '1 second' WHERE id = $1`, [b.transfer.id]);
    assert.ok((await tx((db) => svc.cashless.expireStaleTransfers(db))) >= 1);
    assert.equal((await pool.query('SELECT status FROM wallet_transfers WHERE id = $1', [b.transfer.id])).rows[0].status, 'EXPIRED');
    assert.deepEqual([(await balances(p.walletId)).available_cents, (await balances(p.walletId)).reserved_cents], [5_000, 0]);
    const before = (await pool.query('SELECT count(*)::int n FROM wallet_transfers WHERE wallet_id = $1', [p.walletId])).rows[0].n;
    await assert.rejects(req(999_999), /Insufficient balance/);
    assert.equal((await pool.query('SELECT count(*)::int n FROM wallet_transfers WHERE wallet_id = $1', [p.walletId])).rows[0].n, before);
    await tx((db) => svc.cashless.closeCashlessSession(db, actor('attendant@example.com'), session.id));
  });

  test('machine -> wallet credits the confirmed amount, also for a blocked wallet', async () => {
    const p = await newPlayerWithCard();
    const { session } = await tx((db) => svc.cashless.openCashlessSession(db, actor('attendant@example.com'), { cardNumber: p.cardNumber, machineId: lmachines.M009.id, requestKey: key() }));
    await tx((db) => svc.wallets.setWalletStatus(db, actor('manager@example.com'), p.walletId, 'BLOCKED', 'review'));
    const { transfer } = await tx((db) => svc.cashless.requestTransfer(db, actor('attendant@example.com'), { sessionId: session.id, direction: 'FROM_MACHINE', amountCents: 2_000, requestKey: key() }));
    assert.equal((await balances(p.walletId)).available_cents, 0, 'requested is not a completed movement');
    assert.equal((await balances(p.walletId)).pending_in_cents, 2_000);
    await tx((db) => svc.cashless.markTransferSent(db, system, transfer.id));
    await tx((db) => svc.cashless.confirmTransfer(db, system, { transferId: transfer.id, confirmedAmountCents: 1_234 }));
    assert.equal((await balances(p.walletId)).available_cents, 1_234);
  });
});

describe('handpay', () => {
  const pending = async (asset: string) => (await pool.query(`SELECT * FROM handpays WHERE machine_id = $1 ORDER BY created_at DESC LIMIT 1`, [machines[asset].id])).rows[0];

  test('a jackpot event creates exactly one handpay', async () => {
    const eventId = await machineEvent('M010', 'JACKPOT', { amount: 321.45 });
    const h = await pending('M010');
    assert.deepEqual([h.status, h.amount_cents, h.source_event_id], ['PENDING', 32_145, eventId]);
    assert.equal(await tx((db) => svc.handpays.ensureHandpayForJackpot(db, { orgId, casinoId: casinoA, machineId: machines.M010.id, eventId, amountCents: 32_145 })), undefined);
    await assert.rejects(pool.query(`INSERT INTO handpays (org_id, casino_id, machine_id, source_event_id, amount_cents) VALUES ($1,$2,$3,$4,1)`, [orgId, casinoA, machines.M010.id, eventId]), /handpays_one_per_event/);
    assert.equal((await pool.query('SELECT count(*)::int n FROM handpays WHERE source_event_id = $1', [eventId])).rows[0].n, 1);
  });

  test('PENDING -> APPROVED -> PAID -> MACHINE_RESET, with the reset arriving after payment', async () => {
    await machineEvent('M011', 'JACKPOT', { amount: 250 });
    let h = await pending('M011');
    await tx((db) => svc.handpays.approveHandpay(db, actor('manager@example.com'), h.id));
    const r = await post('cashier@example.com', `/api/v1/cashier/handpays/${machines.M011.id}`, {});
    assert.equal(r.statusCode, 200, r.body);
    h = await pending('M011');
    assert.equal(h.status, 'PAID');
    assert.ok(h.legacy_cash_transaction_id);
    const cmd = (await pool.query(`SELECT type FROM machine_commands WHERE handpay_id = $1`, [h.id])).rows;
    assert.deepEqual(cmd.map((c) => c.type), ['RESET_JACKPOT']);
    await machineEvent('M011', 'JACKPOT_RESET');
    assert.equal((await pending('M011')).status, 'MACHINE_RESET');
  });

  test('payment is independent from the reset: reset first, payment later still works', async () => {
    await machineEvent('M013', 'JACKPOT', { amount: 120 });
    await machineEvent('M013', 'JACKPOT_RESET');
    let h = await pending('M013');
    assert.equal(h.status, 'PENDING');
    assert.ok(h.reset_confirmed_at);
    const r = await post('cashier@example.com', `/api/v1/cashier/handpays/${machines.M013.id}`, {});
    assert.equal(r.statusCode, 200, r.body);
    h = await pending('M013');
    assert.equal(h.status, 'MACHINE_RESET');
    assert.equal((await pool.query('SELECT count(*)::int n FROM machine_commands WHERE handpay_id = $1', [h.id])).rows[0].n, 0, 'no reset needed');
  });

  test('a failed reset leaves the handpay PAID and is retried', async () => {
    await machineEvent('M014', 'JACKPOT', { amount: 80 });
    assert.equal((await post('cashier@example.com', `/api/v1/cashier/handpays/${machines.M014.id}`, {})).statusCode, 200);
    const h = await pending('M014');
    await pool.query(`UPDATE machine_commands SET status = 'FAILED', result_message = 'Machine offline' WHERE handpay_id = $1`, [h.id]);
    assert.ok((await tx((db) => svc.handpays.retryFailedHandpayResets(db))) >= 1);
    const after = await pending('M014');
    assert.equal(after.status, 'PAID');
    assert.equal(after.reset_attempts, 2);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM machine_commands WHERE handpay_id = $1 AND status = 'PENDING'`, [h.id])).rows[0].n, 1);
  });

  test('approval limit, four eyes and concurrent approvals / payments', async () => {
    await pool.query('UPDATE casino_money_settings SET handpay_approval_cents = 10000 WHERE casino_id = $1', [casinoA]);
    try {
      await machineEvent('M015', 'JACKPOT', { amount: 200 });
      const h = await pending('M015');
      const blocked = await post('cashier@example.com', `/api/v1/cashier/handpays/${machines.M015.id}`, {});
      assert.equal(blocked.statusCode, 409);
      assert.match(blocked.json().error, /approval required/);
      const approvals = await Promise.allSettled(Array.from({ length: 5 }, () => tx((db) => svc.handpays.approveHandpay(db, actor('attendant@example.com'), h.id))));
      assert.equal(approvals.filter((a) => a.status === 'fulfilled').length, 1);
      const selfPay = await post('attendant@example.com', `/api/v1/cashier/handpays/${machines.M015.id}`, {});
      assert.equal(selfPay.statusCode, 409);
      assert.match(selfPay.json().error, /approver cannot pay/);
      const pays = await Promise.all(Array.from({ length: 6 }, (_, i) => post(i % 2 ? 'manager@example.com' : 'cashier@example.com', `/api/v1/cashier/handpays/${machines.M015.id}`, {})));
      assert.equal(pays.filter((r) => r.statusCode === 200).length, 1);
      assert.equal((await pool.query(`SELECT count(*)::int n FROM cash_transactions WHERE source_event_id = $1`, [h.source_event_id])).rows[0].n, 1);
    } finally {
      await pool.query('UPDATE casino_money_settings SET handpay_approval_cents = NULL WHERE casino_id = $1', [casinoA]);
    }
  });

  test('VOIDED only before payment', async () => {
    await machineEvent('M016', 'JACKPOT', { amount: 60 });
    const h = await pending('M016');
    await tx((db) => svc.handpays.voidHandpay(db, actor('manager@example.com'), h.id, 'test jackpot'));
    assert.equal((await post('cashier@example.com', `/api/v1/cashier/handpays/${machines.M016.id}`, {})).statusCode, 409);
    await machineEvent('M016', 'JACKPOT', { amount: 70 });
    assert.equal((await post('cashier@example.com', `/api/v1/cashier/handpays/${machines.M016.id}`, {})).statusCode, 200);
    const paid = await pending('M016');
    await assert.rejects(tx((db) => svc.handpays.voidHandpay(db, actor('manager@example.com'), paid.id, 'too late')), /already paid/);
    await assert.rejects(pool.query(`UPDATE handpays SET amount_cents = 1 WHERE id = $1`, [paid.id]), /immutable/);
  });

  test('the handpay ledger stays untouched: money still runs on the legacy cash transactions', async () => {
    assert.equal((await pool.query(`SELECT count(*)::int n FROM money_transactions WHERE handpay_id IS NOT NULL OR type LIKE 'HANDPAY%'`)).rows[0].n, 0);
  });
});

describe('vault, cash counts and approvals', () => {
  test('vault session lifecycle with opening and blind closing counts', async () => {
    const vaultId = (await pool.query('SELECT id FROM vaults WHERE casino_id = $1', [casinoA])).rows[0].id;
    const a = scoped('manager@example.com');
    const { session, count } = await tx((db) => svc.vault.openVaultSession(db, a, { vaultId, count: { denominations: { '5000': 10, '1000': 20, '200': 5 } } }));
    assert.equal(count.total_cents, 71_000);
    await assert.rejects(tx((db) => svc.vault.openVaultSession(db, a, { vaultId, count: { totalCents: 0 } })), /already has an open session/);
    await assert.rejects(tx((db) => svc.vault.closeVaultSession(db, a, session.id, { totalCents: 1 })), /from OPEN to CLOSED/);
    await tx((db) => svc.vault.startVaultCount(db, a, session.id));
    const closed = await tx((db) => svc.vault.closeVaultSession(db, a, session.id, { totalCents: 70_500 }));
    assert.equal(closed.session.status, 'CLOSED');
    assert.equal(closed.count.blind, true);
    await assert.rejects(tx((db) => svc.vault.recordCashCount(db, a, { casinoId: casinoA, context: 'VAULT_OPEN', vaultSessionId: session.id, denominations: { '100': 2 }, totalCents: 300 })), /does not match/);
    await assert.rejects(pool.query('UPDATE cash_counts SET total_cents = 0 WHERE id = $1', [count.id]), /append-only/);
  });

  test('casino scope: other casino vaults, sessions and counts are rejected', async () => {
    const vaultB = (await pool.query('SELECT id FROM vaults WHERE casino_id = $1', [casinoB])).rows[0].id;
    await assert.rejects(tx((db) => svc.vault.openVaultSession(db, scoped('manager@example.com', [casinoA]), { vaultId: vaultB, count: { totalCents: 0 } })), /Vault not found/);
    const { session } = await tx((db) => svc.vault.openVaultSession(db, scoped('admin@example.com', [casinoA, casinoB]), { vaultId: vaultB, count: { totalCents: 100 } }));
    await assert.rejects(pool.query(`INSERT INTO cash_counts (org_id, casino_id, context, vault_session_id, total_cents, counted_by) VALUES ($1,$2,'VAULT_OPEN',$3,0,$4)`, [orgId, casinoA, session.id, emp['admin@example.com']]), /another casino/);
    await assert.rejects(tx((db) => svc.vault.linkCashierSessionToVault(db, scoped('admin@example.com', [casinoA, casinoB]), cashierSession, session.id)), /another casino/);
    const vaultA = (await pool.query('SELECT id FROM vaults WHERE casino_id = $1', [casinoA])).rows[0].id;
    const vsA = await tx((db) => svc.vault.openVaultSession(db, scoped('manager@example.com'), { vaultId: vaultA, count: { totalCents: 0 } }));
    const linked = await tx((db) => svc.vault.linkCashierSessionToVault(db, scoped('manager@example.com'), cashierSession, vsA.session.id));
    assert.equal(linked.vault_session_id, vsA.session.id);
  });

  test('approvals: four eyes, single use, linked to the action', async () => {
    const ap = await tx((db) => svc.approvals.requestApproval(db, actor('cashier@example.com'), { casinoId: casinoA, action: 'CASH_WITHDRAWAL', entityType: 'wallet', entityId: 'w-1', amountCents: 500_00 }));
    await assert.rejects(tx((db) => svc.approvals.decideApproval(db, actor('cashier@example.com'), ap.id, 'APPROVED')), /own request/);
    await assert.rejects(pool.query('UPDATE approvals SET status = $2, decided_by = requested_by WHERE id = $1', [ap.id, 'APPROVED']), /approvals_four_eyes/);
    await tx((db) => svc.approvals.decideApproval(db, actor('manager@example.com'), ap.id, 'APPROVED'));
    await assert.rejects(tx((db) => svc.approvals.consumeApproval(db, actor('cashier@example.com'), ap.id, { action: 'HANDPAY_PAY' })), /different action/);
    const used = await tx((db) => svc.approvals.consumeApproval(db, actor('cashier@example.com'), ap.id, { action: 'CASH_WITHDRAWAL', entityId: 'w-1' }));
    assert.equal(used.status, 'EXECUTED');
    await assert.rejects(tx((db) => svc.approvals.consumeApproval(db, actor('cashier@example.com'), ap.id, { action: 'CASH_WITHDRAWAL' })), /from EXECUTED/);
  });
});

describe('ticket holds', () => {
  async function newTicket(casinoId = casinoA) {
    const barcode = String(Math.floor(Math.random() * 1e17)).padStart(18, '9');
    await pool.query(`INSERT INTO tickets (org_id, casino_id, barcode, amount, expires_at) VALUES ($1,$2,$3,25.5, now() + interval '30 days')`, [orgId, casinoId, barcode]);
    return barcode;
  }

  test('hold: VALID -> HELD with machine and hold id; amount in cents derived from the ticket', async () => {
    const barcode = await newTicket();
    const h = await tx((db) => svc.holds.holdTicket(db, { orgId, barcode, machineId: machines.M017.id }));
    assert.equal(h.ok, true);
    const t = (await pool.query('SELECT status, hold_id, hold_machine_id, hold_source, amount_cents FROM tickets WHERE barcode = $1', [barcode])).rows[0];
    assert.deepEqual(t, { status: 'HELD', hold_id: h.ok && h.holdId, hold_machine_id: machines.M017.id, hold_source: 'MACHINE', amount_cents: 2_550 });
    const cashierRedeem = await post('cashier@example.com', '/api/v1/tickets/redeem', { barcode });
    assert.equal(cashierRedeem.statusCode, 409, 'a held ticket cannot be paid elsewhere');
    assert.equal(await tx((db) => svc.holds.releaseTicketHold(db, { orgId, holdId: h.ok ? h.holdId : '', reason: 'machine rejected' })), true);
    assert.equal((await pool.query('SELECT status FROM tickets WHERE barcode = $1', [barcode])).rows[0].status, 'VALID');
  });

  test('concurrent holds: exactly one machine wins', async () => {
    const barcode = await newTicket();
    const results = await Promise.all(['M017', 'M018', 'M019', 'M020', 'M001', 'M002'].map((a) => tx((db) => svc.holds.holdTicket(db, { orgId, barcode, machineId: machines[a].id }))));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'TICKET_NOT_VALID'));
  });

  test('expired holds are released (no permanently locked tickets); other casino and bad shapes rejected', async () => {
    const barcode = await newTicket();
    const h = await tx((db) => svc.holds.holdTicket(db, { orgId, barcode, machineId: machines.M018.id }));
    await pool.query(`UPDATE tickets SET hold_until = now() - interval '1 hour' WHERE barcode = $1`, [barcode]);
    assert.ok((await tx((db) => svc.holds.releaseExpiredHolds(db))) >= 1);
    assert.equal((await pool.query('SELECT status FROM tickets WHERE barcode = $1', [barcode])).rows[0].status, 'VALID');
    const events = (await pool.query(`SELECT action FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id WHERE t.barcode = $1 ORDER BY e.id`, [barcode])).rows.map((r) => r.action);
    assert.deepEqual(events, ['HELD', 'HOLD_EXPIRED']);
    assert.equal(h.ok, true);
    const otherCasino = await newTicket(casinoB);
    const r = await tx((db) => svc.holds.holdTicket(db, { orgId, barcode: otherCasino, machineId: machines.M018.id }));
    assert.equal(!r.ok && r.reason, 'OTHER_CASINO');
    await assert.rejects(pool.query(`UPDATE tickets SET status = 'HELD' WHERE barcode = $1`, [otherCasino]), /tickets_hold_shape/);
  });
});

describe('foreign keys and delete restrictions', () => {
  test('invalid references are rejected', async () => {
    const anyPlayer = (await pool.query('SELECT id FROM players WHERE org_id = $1 LIMIT 1', [orgId])).rows[0].id;
    await assert.rejects(tx((db) => svc.ledger.executeMoneyTransaction(db, { orgId, type: 'CASH_DEPOSIT', dedupeKey: key(), actor: { type: 'SYSTEM' }, ctx: { casinoId: ledgerCasino, amountCents: cents(100), playerId: anyPlayer, walletId: randomUUID(), cashierSessionId: ledgerSession } })), /foreign key|another organisation|does not belong/);
    await assert.rejects(pool.query(`UPDATE machine_commands SET handpay_id = $1 WHERE id = (SELECT id FROM machine_commands LIMIT 1)`, [randomUUID()]), /foreign key/);
    await assert.rejects(pool.query(`UPDATE cashier_sessions SET vault_session_id = $1 WHERE id = $2`, [randomUUID(), cashierSession]), /foreign key|another casino/);
    await assert.rejects(pool.query(`INSERT INTO ledger_accounts (org_id, kind, vault_id, casino_id) VALUES ($1, 'VAULT', $2, $3)`, [orgId, randomUUID(), casinoA]), /foreign key|does not belong/);
  });

  test('deletes and identity changes are restricted', async () => {
    const p = await newPlayerWithCard();
    await assert.rejects(pool.query('DELETE FROM players WHERE id = $1', [p.player.id]), /foreign key|violates/);
    await assert.rejects(pool.query('UPDATE wallets SET player_id = $2 WHERE id = $1', [p.walletId, (await newPlayerWithCard()).player.id]), /immutable/);
    const vault = (await pool.query('SELECT id FROM vaults WHERE casino_id = $1', [casinoA])).rows[0].id;
    await assert.rejects(pool.query('DELETE FROM vaults WHERE id = $1', [vault]), /foreign key/);
    const hp = (await pool.query('SELECT id FROM handpays LIMIT 1')).rows[0].id;
    await assert.rejects(pool.query('DELETE FROM handpays WHERE id = $1', [hp]), /append-only/);
  });
});

describe('ledger invariants', () => {
  test('hold after all entity operations', async () => {
    const inv = await svc.ledger.checkLedgerInvariants(pool, orgId);
    assert.equal(inv.ok, true, JSON.stringify(inv));
  });
});
