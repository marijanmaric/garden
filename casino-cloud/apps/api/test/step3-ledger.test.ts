import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { syncMoneyModel, withTransaction, type Pool, type PoolClient } from '@m1/database';
import { MONEY_TRANSACTION_TYPES, ACCOUNT_KIND_KEYS, cents, type MoneyContext, type MoneyTransactionType } from '@m1/shared';
import { setupTestDatabase } from './helpers';

let app: FastifyInstance;
let pool: Pool;
let ledger: typeof import('../src/services/ledger');
let ingestEvents: typeof import('../src/services/ingest').ingestEvents;
let orgId: string;
let casinoA: string;
let casinoB: string;
let sessionA: string;
let sessionB: string;
let playerId: string;
let cardId: string;
let machineId: string;
let machineCode: string;
let gw: { id: string; orgId: string; casinoId: string; deviceId: string };
let cashierId: string;
let cashierToken: string;
let walletPC1: string;
const walletPlayers = new Map<string, string>();
const system = { type: 'SYSTEM' as const, name: 'test' };

const tx = <T>(fn: (db: PoolClient) => Promise<T>) => withTransaction(pool, fn);
const key = (p = 'k') => `${p}-${randomUUID()}`;

/** A new player with a wallet (migration 005: wallets are real entities now). */
async function newWallet() {
  const p = (await pool.query('INSERT INTO players (org_id) VALUES ($1) RETURNING id', [orgId])).rows[0].id;
  const w = (await pool.query('INSERT INTO wallets (org_id, player_id) VALUES ($1,$2) RETURNING id', [orgId, p])).rows[0].id;
  walletPlayers.set(w, p);
  return w as string;
}

/** Player / card references consistent with the wallet (the ledger checks this since 005). */
function withOwner<T extends { walletId?: string; playerId?: string; cardId?: string }>(ctx: T): T {
  if (!ctx.walletId || !walletPlayers.has(ctx.walletId)) return ctx;
  return { ...ctx, playerId: walletPlayers.get(ctx.walletId), cardId: ctx.walletId === walletPC1 ? ctx.cardId : undefined };
}

function run(type: Exclude<MoneyTransactionType, 'REVERSAL'>, ctx: Omit<Partial<MoneyContext>, 'amountCents'> & { amountCents: number }, dedupeKey = key(), extra: Record<string, unknown> = {}) {
  return tx((db) => ledger.executeMoneyTransaction(db, { orgId, type, ctx: withOwner({ casinoId: casinoA, ...ctx, amountCents: ctx.amountCents as never }), dedupeKey, actor: system, ...extra }));
}

const wallet = (walletId: string) => ({ kind: 'WALLET_AVAILABLE' as const, walletId });
const drawer = (casinoId: string, cashierSessionId: string) => ({ kind: 'DRAWER' as const, casinoId, cashierSessionId });
const balance = (ref: Parameters<typeof ledger.getBalance>[2]) => ledger.getBalance(pool, orgId, ref);

async function fundDrawer(casinoId: string, cashierSessionId: string, amountCents: number) {
  await tx((db) => ledger.executeMoneyTransaction(db, {
    orgId, type: 'OPENING_BALANCE', dedupeKey: key('open'), actor: system,
    ctx: { casinoId, amountCents: cents(amountCents), debit: drawer(casinoId, cashierSessionId), credit: { kind: 'OPENING_EQUITY' } },
  }));
}

async function deposit(walletId: string, amountCents: number, casinoId = casinoA, cashierSessionId = sessionA) {
  return tx((db) => ledger.executeMoneyTransaction(db, {
    orgId, type: 'CASH_DEPOSIT', dedupeKey: key('dep'), actor: system,
    ctx: withOwner({ casinoId, amountCents: cents(amountCents), playerId, walletId, cardId, cashierSessionId }),
  }));
}

async function moneyCount() {
  return (await pool.query('SELECT (SELECT count(*)::int FROM money_transactions) t, (SELECT count(*)::int FROM ledger_entries) e')).rows[0];
}

before(async () => {
  ({ app, pool } = await setupTestDatabase({
    beforeReady: async (instance) => {
      // Test-only route: the Step 1 idempotency wrapper around the ledger service (integration of both layers).
      const { guard } = await import('../src/auth');
      const { idempotent } = await import('../src/services/idempotency');
      const svc = await import('../src/services/ledger');
      instance.post('/test/money', { preHandler: guard('cash.transact') }, async (req, reply) => {
        const body = req.body as { type: Exclude<MoneyTransactionType, 'REVERSAL'>; ctx: MoneyContext };
        return idempotent(req, reply, async (db) => {
          const r = await svc.executeMoneyTransaction(db, {
            orgId: req.auth.orgId, type: body.type, ctx: body.ctx, actor: { type: 'EMPLOYEE', employeeId: req.auth.sub, name: req.auth.email },
            dedupeKey: svc.clientDedupeKey(req.auth.sub, req.headers['idempotency-key'] as string, body.type),
          });
          return { id: r.transaction.id, entries: r.entries.length, replayed: r.replayed };
        });
      });
    },
  }));
  ledger = await import('../src/services/ledger');
  ({ ingestEvents } = await import('../src/services/ingest'));
  const g = (await pool.query(`SELECT id, org_id, casino_id, device_id FROM gateways WHERE device_id = 'GW-VIE-001'`)).rows[0];
  gw = { id: g.id, orgId: g.org_id, casinoId: g.casino_id, deviceId: g.device_id };
  orgId = g.org_id;
  casinoA = g.casino_id;
  casinoB = (await pool.query(`INSERT INTO casinos (org_id, code, name) VALUES ($1, 'VIE-002', 'Second Casino') RETURNING id`, [orgId])).rows[0].id;
  const employees = Object.fromEntries((await pool.query('SELECT email, id FROM employees WHERE org_id = $1', [orgId])).rows.map((r) => [r.email, r.id]));
  cashierId = employees['cashier@example.com'];
  const deskA = (await pool.query(`SELECT id FROM cash_desks WHERE casino_id = $1 LIMIT 1`, [casinoA])).rows[0].id;
  const deskB = (await pool.query(`INSERT INTO cash_desks (org_id, casino_id, name) VALUES ($1,$2,'Cage B') RETURNING id`, [orgId, casinoB])).rows[0].id;
  sessionA = (await pool.query(`INSERT INTO cashier_sessions (org_id, casino_id, cash_desk_id, employee_id, opening_balance) VALUES ($1,$2,$3,$4,0) RETURNING id`, [orgId, casinoA, deskA, employees['manager@example.com']])).rows[0].id;
  sessionB = (await pool.query(`INSERT INTO cashier_sessions (org_id, casino_id, cash_desk_id, employee_id, opening_balance) VALUES ($1,$2,$3,$4,0) RETURNING id`, [orgId, casinoB, deskB, employees['admin@example.com']])).rows[0].id;
  const card = (await pool.query(`SELECT id, player_id FROM player_cards WHERE org_id = $1 AND card_number = 'PC-00001'`, [orgId])).rows[0];
  cardId = card.id;
  playerId = card.player_id;
  walletPC1 = (await pool.query('SELECT id FROM wallets WHERE player_id = $1', [playerId])).rows[0].id;
  walletPlayers.set(walletPC1, playerId);
  const m = (await pool.query(`SELECT id, machine_code FROM machines WHERE org_id = $1 AND asset_no = 'M003'`, [orgId])).rows[0];
  machineId = m.id;
  machineCode = m.machine_code;
  await fundDrawer(casinoA, sessionA, 1_000_000);
  await fundDrawer(casinoB, sessionB, 1_000_000);
  cashierToken = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'cashier@example.com', password: 'demo' } })).json().token;
});

after(async () => {
  await app?.close();
  await pool?.end();
});

describe('model', () => {
  test('migration 004 applied; kinds and types mirror the shared model (no second matrix)', async () => {
    const applied = (await pool.query(`SELECT name FROM schema_migrations WHERE name >= '004'`)).rows.map((r) => r.name).sort();
    assert.deepEqual(applied, ['004_money_ledger.sql', '005_money_entities.sql']);
    const types = (await pool.query('SELECT code FROM money_transaction_types ORDER BY code')).rows.map((r) => r.code);
    assert.deepEqual(types, [...MONEY_TRANSACTION_TYPES].sort());
    const kinds = (await pool.query('SELECT code FROM ledger_account_kinds ORDER BY code')).rows.map((r) => r.code);
    assert.deepEqual(kinds, [...ACCOUNT_KIND_KEYS].sort());
    assert.ok(!types.some((t) => /COIN|WAGER|WIN$|BET/.test(t)), 'no gaming or COIN money types');
    await assert.rejects(pool.query(`INSERT INTO money_transaction_types (code, rail, label, signed) VALUES ('COIN_IN', 'CASH', 'x', false)`), /no_coin/);
  });

  test('sync refuses a database definition that differs from the shared model', async () => {
    await pool.query(`UPDATE ledger_account_kinds SET allow_negative = true WHERE code = 'WALLET_AVAILABLE'`);
    await assert.rejects(syncMoneyModel(pool), /differs/);
    await pool.query(`UPDATE ledger_account_kinds SET allow_negative = false WHERE code = 'WALLET_AVAILABLE'`);
    await syncMoneyModel(pool);
  });

  test('ledger tables carry references only: no card account, no personal data columns', async () => {
    const cols = (await pool.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('ledger_accounts', 'ledger_entries', 'money_transactions')`)).rows;
    const names = cols.map((c) => `${c.table_name}.${c.column_name}`);
    assert.ok(!names.includes('ledger_accounts.card_id'), 'cards are never accounts');
    assert.ok(names.includes('money_transactions.card_id') && names.includes('money_transactions.player_id') && names.includes('money_transactions.wallet_id'));
    assert.ok(!names.some((n) => /name|email|phone|birth|document|address/.test(n)), names.join());
  });
});

describe('posting', () => {
  test('a balanced transaction posts entries, balances and references', async () => {
    const walletId = walletPC1;
    const r = await deposit(walletId, 10_000);
    assert.equal(r.entries.length, 2);
    assert.equal(r.entries.reduce((s, e) => s + e.amount_cents, 0), 0);
    assert.deepEqual(r.entries.map((e) => [e.kind, e.amount_cents]).sort(), [['DRAWER', 10_000], ['WALLET_AVAILABLE', -10_000]]);
    assert.equal(await balance(wallet(walletId)), 10_000);
    const row = (await pool.query('SELECT player_id, wallet_id, card_id, cashier_session_id, business_date FROM money_transactions WHERE id = $1', [r.transaction.id])).rows[0];
    assert.deepEqual([row.player_id, row.wallet_id, row.card_id, row.cashier_session_id], [playerId, walletId, cardId, sessionA]);
    assert.ok(row.business_date);
    const audit = (await pool.query(`SELECT details FROM audit_logs WHERE entity_id = $1 AND action = 'money.cash_deposit'`, [r.transaction.id])).rows[0];
    assert.equal(audit.details.amountCents, 10_000);
  });

  test('zero, negative and fractional amounts are rejected', async () => {
    for (const amountCents of [0, -500, 1.5]) {
      await assert.rejects(run('CASH_DEPOSIT', { amountCents, playerId, walletId: await newWallet(), cashierSessionId: sessionA }), (e: Error & { statusCode?: number }) => e.statusCode === 400);
    }
    const w = await newWallet();
    await assert.rejects(tx((db) => ledger.executeMoneyTransaction(db, { orgId, type: 'CASH_DEPOSIT', dedupeKey: key(), actor: system, ctx: { casinoId: casinoA, amountCents: cents(100), walletId: w, cashierSessionId: sessionA } })), /player required/);
  });

  test('the database rejects unbalanced, empty, invalid and late entries', async () => {
    const accountId = (await pool.query(`SELECT id FROM ledger_accounts WHERE kind = 'DRAWER' AND cashier_session_id = $1`, [sessionA])).rows[0].id;
    const equity = (await pool.query(`SELECT id FROM ledger_accounts WHERE kind = 'OPENING_EQUITY' AND casino_id = $1`, [casinoA])).rows[0].id;
    const header = (db: PoolClient, amount = 100, type = 'PETTY_CASH') =>
      db.query(`INSERT INTO money_transactions (org_id, casino_id, type, amount_cents, dedupe_key, request_hash, actor_type, business_date)
                VALUES ($1,$2,$3,$4,$5,'x','SYSTEM',current_date) RETURNING id`, [orgId, casinoA, type, amount, key('raw')]);
    // unbalanced
    await assert.rejects(tx(async (db) => {
      const id = (await header(db)).rows[0].id;
      await db.query('INSERT INTO ledger_entries (transaction_id, account_id, amount_cents, org_id) VALUES ($1,$2,100,$3),($1,$4,-90,$3)', [id, equity, orgId, accountId]);
    }), /unbalanced/);
    // no entries at all
    await assert.rejects(tx(async (db) => { await header(db); }), /at least 2 required/);
    // zero entry and non-positive amount for an unsigned type
    await assert.rejects(tx(async (db) => {
      const id = (await header(db)).rows[0].id;
      await db.query('INSERT INTO ledger_entries (transaction_id, account_id, amount_cents, org_id) VALUES ($1,$2,0,$3)', [id, equity, orgId]);
    }), /check constraint/);
    await assert.rejects(tx((db) => header(db, -100)), /must be positive/);
    // entries added later to an already committed transaction
    const committed = (await deposit(await newWallet(), 500)).transaction.id;
    await assert.rejects(tx((db) => db.query('INSERT INTO ledger_entries (transaction_id, account_id, amount_cents, org_id) VALUES ($1,$2,1,$3)', [committed, equity, orgId])), /only be added in the transaction/);
    const counts = await moneyCount();
    const unbalanced = await ledger.checkLedgerInvariants(pool, orgId);
    assert.equal(unbalanced.unbalancedTransactions, 0, JSON.stringify(counts));
  });

  test('a failure rolls back the whole transaction: no entries, balances or audit left behind', async () => {
    const walletId = await newWallet();
    const before = await moneyCount();
    let txId = '';
    await assert.rejects(tx(async (db) => {
      txId = (await ledger.executeMoneyTransaction(db, { orgId, type: 'CASH_DEPOSIT', dedupeKey: key(), actor: system, ctx: withOwner({ casinoId: casinoA, amountCents: cents(700), playerId, walletId, cashierSessionId: sessionA }) })).transaction.id;
      throw new Error('boom after posting');
    }), /boom/);
    assert.deepEqual(await moneyCount(), before);
    assert.equal(await balance(wallet(walletId)), 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM audit_logs WHERE entity_id = $1', [txId])).rows[0].n, 0);
  });
});

describe('immutability and reversals', () => {
  test('money transactions, entries, accounts and balances cannot be changed directly', async () => {
    const r = await deposit(await newWallet(), 300);
    await assert.rejects(pool.query('UPDATE money_transactions SET amount_cents = 1 WHERE id = $1', [r.transaction.id]), /append-only/);
    await assert.rejects(pool.query('DELETE FROM money_transactions WHERE id = $1', [r.transaction.id]), /append-only/);
    await assert.rejects(pool.query('UPDATE ledger_entries SET amount_cents = 1 WHERE transaction_id = $1', [r.transaction.id]), /append-only/);
    await assert.rejects(pool.query('DELETE FROM ledger_entries WHERE transaction_id = $1', [r.transaction.id]), /append-only/);
    await assert.rejects(pool.query('UPDATE ledger_balances SET balance_cents = 0 WHERE account_id = $1', [r.entries[0].account_id]), /only be changed by posting/);
    await assert.rejects(pool.query('DELETE FROM ledger_accounts WHERE id = $1', [r.entries[0].account_id]), /append-only/);
  });

  test('a reversal is a new balanced transaction; the original stays unchanged', async () => {
    const walletId = await newWallet();
    const original = await deposit(walletId, 2_500);
    const snapshot = (await pool.query('SELECT * FROM money_transactions WHERE id = $1', [original.transaction.id])).rows[0];
    const k = key('rev');
    const rev = await tx((db) => ledger.reverseMoneyTransaction(db, { orgId, transactionId: original.transaction.id, dedupeKey: k, actor: system, reason: 'wrong player' }));
    assert.equal(rev.transaction.type, 'REVERSAL');
    assert.equal(rev.transaction.reversal_of, original.transaction.id);
    assert.notEqual(rev.transaction.id, original.transaction.id);
    assert.equal(rev.entries.reduce((s, e) => s + e.amount_cents, 0), 0);
    assert.equal(await balance(wallet(walletId)), 0);
    assert.deepEqual((await pool.query('SELECT * FROM money_transactions WHERE id = $1', [original.transaction.id])).rows[0], snapshot);
    // replay with the same key, second reversal, reversing a reversal
    const replay = await tx((db) => ledger.reverseMoneyTransaction(db, { orgId, transactionId: original.transaction.id, dedupeKey: k, actor: system, reason: 'wrong player' }));
    assert.equal(replay.replayed, true);
    await assert.rejects(tx((db) => ledger.reverseMoneyTransaction(db, { orgId, transactionId: original.transaction.id, dedupeKey: key(), actor: system, reason: 'again' })), /already reversed/);
    await assert.rejects(tx((db) => ledger.reverseMoneyTransaction(db, { orgId, transactionId: rev.transaction.id, dedupeKey: key(), actor: system, reason: 'undo undo' })), /cannot be reversed/);
  });

  test('reversal rules from the matrix are enforced and reversals respect balances', async () => {
    const vaultId = (await pool.query('SELECT id FROM vaults WHERE casino_id = $1', [casinoA])).rows[0].id;
    await tx((db) => ledger.executeMoneyTransaction(db, { orgId, type: 'OPENING_BALANCE', dedupeKey: key('vault'), actor: system, ctx: { casinoId: casinoA, amountCents: cents(50_000), debit: { kind: 'VAULT', vaultId }, credit: { kind: 'OPENING_EQUITY' } } }));
    const fill = await run('VAULT_FILL', { amountCents: 400, vaultId, cashierSessionId: sessionA });
    await assert.rejects(tx((db) => ledger.reverseMoneyTransaction(db, { orgId, transactionId: fill.transaction.id, dedupeKey: key(), actor: system, reason: 'nope' })), /undone with VAULT_DROP/);
    // Deposit, spend it, then try to reverse the deposit: the wallet would go negative.
    const w2 = await newWallet();
    const dep = await deposit(w2, 500);
    await run('CASH_WITHDRAWAL', { amountCents: 500, playerId, walletId: w2, cashierSessionId: sessionA });
    await assert.rejects(tx((db) => ledger.reverseMoneyTransaction(db, { orgId, transactionId: dep.transaction.id, dedupeKey: key(), actor: system, reason: 'too late' })), /Insufficient balance on WALLET_AVAILABLE/);
  });
});

describe('scopes', () => {
  test('a wallet is organisation-level: deposit in casino A, withdraw in casino B, one account', async () => {
    const walletId = await newWallet();
    await deposit(walletId, 6_000, casinoA, sessionA);
    await tx((db) => ledger.executeMoneyTransaction(db, { orgId, type: 'CASH_WITHDRAWAL', dedupeKey: key(), actor: system, ctx: withOwner({ casinoId: casinoB, amountCents: cents(4_000), playerId, walletId, cashierSessionId: sessionB }) }));
    const accounts = (await pool.query(`SELECT casino_id FROM ledger_accounts WHERE wallet_id = $1`, [walletId])).rows;
    assert.deepEqual(accounts, [{ casino_id: null }]);
    assert.equal(await balance(wallet(walletId)), 2_000);
    await assert.rejects(pool.query(`INSERT INTO ledger_accounts (org_id, kind, casino_id, wallet_id) VALUES ($1, 'WALLET_AVAILABLE', $2, $3)`, [orgId, casinoA, walletId]), /must not have a casino/);
  });

  test('physical money is casino-level and cannot be moved through another casino', async () => {
    const drawerB = (await pool.query(`SELECT id, casino_id FROM ledger_accounts WHERE kind = 'DRAWER' AND cashier_session_id = $1`, [sessionB])).rows[0];
    assert.equal(drawerB.casino_id, casinoB);
    await assert.rejects(pool.query(`INSERT INTO ledger_accounts (org_id, kind, cashier_session_id) VALUES ($1, 'DRAWER', $2)`, [orgId, sessionA]), /needs a casino/);
    await assert.rejects(pool.query(`INSERT INTO ledger_accounts (org_id, kind, casino_id, cashier_session_id) VALUES ($1, 'DRAWER', $2, $3)`, [orgId, casinoB, sessionA]), /does not belong to this casino/);
    // Service: a casino A transaction with a casino B drawer session is rejected by the entry trigger.
    await assert.rejects(run('CASH_DEPOSIT', { amountCents: 100, playerId, walletId: await newWallet(), cashierSessionId: sessionB }), /does not belong to this casino|another casino/);
  });
});

describe('MACHINE_CREDIT: the bridge between money and gaming', () => {
  test('cash in, ticket out/in and gaming settlement; game play itself creates no money transaction', async () => {
    const credit = { kind: 'MACHINE_CREDIT' as const, casinoId: casinoA, machineId };
    const before = await moneyCount();
    const r = await ingestEvents(gw, [{ eventId: randomUUID(), type: 'GAME_PLAYED', machineId: machineCode, timestamp: new Date().toISOString(), amount: 2, win: 1 }]);
    assert.equal(r.accepted, 1);
    assert.deepEqual(await moneyCount(), before, 'bets and wins never become ledger transactions');

    const ticketId = (await pool.query(`INSERT INTO tickets (org_id, casino_id, barcode, amount, expires_at) VALUES ($1,$2,$3,70,now() + interval '30 days') RETURNING id`, [orgId, casinoA, String(Date.now()).padStart(18, '0')])).rows[0].id;
    await run('MACHINE_CASH_IN', { amountCents: 10_000, machineId }, key('cashin'));
    assert.equal(await balance(credit), 10_000);
    // Player loses 30.00 on the machine (gaming only), then cashes out 70.00 by ticket.
    await run('TITO_ISSUE_MACHINE', { amountCents: 7_000, machineId, ticketId });
    assert.equal(await balance(credit), 3_000);
    assert.equal(await balance({ kind: 'TICKET_LIABILITY', casinoId: casinoA }), 7_000);
    // Settlement: credit meter reports 0, so 30.00 is the gaming result.
    await run('GAMING_SETTLEMENT', { amountCents: 3_000, machineId }, ledger.entityDedupeKey('settlement', machineId, 'snap-1'));
    assert.equal(await balance(credit), 0);
    assert.equal(await balance({ kind: 'GAMING_RESULT', casinoId: casinoA }), 3_000);
    assert.equal(await balance({ kind: 'CASHBOX', casinoId: casinoA, machineId }), 10_000);
    // The ticket goes into another machine.
    await run('TITO_REDEEM_MACHINE', { amountCents: 7_000, machineId, ticketId }, ledger.entityDedupeKey('ticket', ticketId, 'redeem'));
    assert.equal(await balance({ kind: 'TICKET_LIABILITY', casinoId: casinoA }), 0);
  });
});

describe('protection against overdraft and duplicates', () => {
  test('insufficient balance is refused and leaves no trace', async () => {
    const before = await moneyCount();
    await assert.rejects(run('CASH_WITHDRAWAL', { amountCents: 100, playerId, walletId: await newWallet(), cashierSessionId: sessionA }), /Insufficient balance on WALLET_AVAILABLE/);
    await assert.rejects(run('TITO_REDEEM_MACHINE', { amountCents: 100, machineId, ticketId: (await pool.query(`SELECT id FROM tickets LIMIT 1`)).rows[0].id }), /Insufficient balance on TICKET_LIABILITY/);
    const emptyDrawerSession = sessionB;
    const drawerBalance = await balance(drawer(casinoB, emptyDrawerSession));
    await assert.rejects(tx((db) => ledger.executeMoneyTransaction(db, { orgId, type: 'PETTY_CASH', dedupeKey: key(), actor: system, ctx: { casinoId: casinoB, amountCents: cents(drawerBalance + 1), source: 'DRAWER', cashierSessionId: emptyDrawerSession } })), /Insufficient balance on DRAWER/);
    assert.deepEqual(await moneyCount(), before);
  });

  test('concurrent withdrawals can never overdraw a wallet (double spend)', async () => {
    const walletId = await newWallet();
    await deposit(walletId, 10_000);
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => run('CASH_WITHDRAWAL', { amountCents: 3_000, playerId, walletId, cashierSessionId: sessionA })));
    const ok = attempts.filter((a) => a.status === 'fulfilled').length;
    assert.equal(ok, 3);
    assert.ok(attempts.filter((a) => a.status === 'rejected').every((a) => /Insufficient balance/.test(String((a as PromiseRejectedResult).reason))));
    assert.equal(await balance(wallet(walletId)), 1_000);
  });

  test('the same dedupe key moves money once, even concurrently; a different request with it is refused', async () => {
    const walletId = await newWallet();
    const k = key('same');
    const results = await Promise.all(Array.from({ length: 5 }, () => run('CASH_DEPOSIT', { amountCents: 1_500, playerId, walletId, cashierSessionId: sessionA }, k)));
    assert.equal(new Set(results.map((r) => r.transaction.id)).size, 1);
    assert.equal(results.filter((r) => r.replayed).length, 4);
    assert.equal(await balance(wallet(walletId)), 1_500);
    await assert.rejects(run('CASH_DEPOSIT', { amountCents: 1_600, playerId, walletId, cashierSessionId: sessionA }, k), /already used for a different transaction/);
  });

  test('HTTP idempotency key and ledger dedupe work together', async () => {
    const walletId = await newWallet();
    const payload = { type: 'CASH_DEPOSIT', ctx: withOwner({ casinoId: casinoA, amountCents: 2_000, playerId, walletId, cardId, cashierSessionId: sessionA }) };
    const send = (k: string, p: unknown = payload) => app.inject({ method: 'POST', url: '/test/money', payload: p as object, headers: { authorization: `Bearer ${cashierToken}`, 'idempotency-key': k } });
    const k = key('http');
    const results = await Promise.all([send(k), send(k), send(k)]);
    assert.ok(results.every((r) => r.statusCode === 200), results.map((r) => r.body).join());
    assert.equal(new Set(results.map((r) => r.json().id)).size, 1);
    assert.equal(await balance(wallet(walletId)), 2_000);
    const different = await send(k, { ...payload, ctx: { ...payload.ctx, amountCents: 2_100 } });
    assert.equal(different.statusCode, 422);
    const row = (await pool.query('SELECT dedupe_key, actor_id FROM money_transactions WHERE id = $1', [results[0].json().id])).rows[0];
    assert.equal(row.dedupe_key, `client:${cashierId}:${k}:CASH_DEPOSIT`);
    assert.equal(row.actor_id, cashierId);
  });
});

describe('invariants', () => {
  test('ledger invariants hold after all tests (service and API)', async () => {
    const inv = await ledger.checkLedgerInvariants(pool, orgId);
    assert.equal(inv.ok, true, JSON.stringify(inv));
    assert.equal(inv.totalSumCents, 0);
    assert.ok(inv.transactions > 10);
    const admin = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'accounting@example.com', password: 'demo' } })).json().token;
    const health = (await app.inject({ method: 'GET', url: '/api/v1/ledger/health', headers: { authorization: `Bearer ${admin}` } })).json();
    assert.equal(health.ok, true);
    const accounts = (await app.inject({ method: 'GET', url: `/api/v1/ledger/accounts?casinoId=${casinoA}`, headers: { authorization: `Bearer ${admin}` } })).json();
    assert.ok(accounts.some((a: { kind: string; casino_id: string | null }) => a.kind === 'WALLET_AVAILABLE' && a.casino_id === null));
  });
});
