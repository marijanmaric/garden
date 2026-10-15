import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_KINDS, ACCOUNT_KIND_KEYS, MONEY_TRANSACTIONS, MONEY_TRANSACTION_TYPES, MoneyError, accountKey, add, cents, displayBalance,
  parseAmount, postings, requiredCapability, toDecimal, type MoneyContext, type MoneyTransactionType,
} from './index';
import { PLAYER_CAPABILITIES } from '../player';

const ids = {
  casinoId: 'casino-1', playerId: 'player-1', walletId: 'wallet-1', cardId: 'card-1', machineId: 'machine-1', cashierSessionId: 'session-1',
  vaultId: 'vault-1', ticketId: 'ticket-1', handpayId: 'handpay-1', transferId: 'transfer-1',
};

/** A complete, valid context for every transaction type. */
function ctxFor(type: MoneyTransactionType): MoneyContext {
  const base: MoneyContext = { ...ids, amountCents: cents(12_345) };
  if (type === 'ADJUSTMENT') return { ...base, debit: { kind: 'CASH_SHORT_OVER' }, credit: { kind: 'DRAWER', cashierSessionId: 'session-1' } };
  if (type === 'OPENING_BALANCE') return { ...base, debit: { kind: 'VAULT', vaultId: 'vault-1' }, credit: { kind: 'OPENING_EQUITY' } };
  if (type === 'REVERSAL') return { ...base, original: postings('CASH_DEPOSIT', base) };
  if (type === 'CASH_ADVANCE') return { ...base, feeCents: cents(300) };
  return base;
}

test('cents: parsing is exact and refuses silent rounding', () => {
  assert.equal(parseAmount('12.5'), 1250);
  assert.equal(parseAmount('12,50'), 1250);
  assert.equal(parseAmount(0.1), 10);
  assert.equal(parseAmount('-3.05'), -305);
  for (const bad of ['0.001', '1e3', 'abc', '', '12.345', NaN, Infinity, 0.1 + 0.2]) assert.throws(() => parseAmount(bad as never), MoneyError);
  assert.throws(() => cents(1.5), MoneyError);
  assert.equal(add(cents(10), cents(20), cents(-5)), 25);
  assert.equal(toDecimal(cents(1234)), 12.34);
});

test('matrix: every transaction type is defined and produces balanced postings', () => {
  assert.deepEqual(Object.keys(MONEY_TRANSACTIONS).sort(), [...MONEY_TRANSACTION_TYPES].sort());
  for (const type of MONEY_TRANSACTION_TYPES) {
    const list = postings(type, ctxFor(type));
    assert.ok(list.length >= 2, type);
    assert.equal(list.reduce((s, p) => s + p.amountCents, 0), 0, `${type} balances`);
    assert.ok(list.every((p) => Number.isSafeInteger(p.amountCents) && p.amountCents !== 0), `${type} integer cents`);
  }
});

test('matrix: no gaming and no COIN terminology among money transactions', () => {
  for (const type of MONEY_TRANSACTION_TYPES) {
    assert.ok(!/COIN|WAGER|BET|GAME_PLAYED/.test(type), type);
    assert.ok(!/coin/i.test(MONEY_TRANSACTIONS[type].label), type);
  }
  for (const kind of ACCOUNT_KIND_KEYS) assert.ok(!/COIN|CARD$/.test(kind), kind);
});

test('matrix: a player card is only a reference, never an account', () => {
  for (const type of MONEY_TRANSACTION_TYPES) {
    for (const p of postings(type, ctxFor(type))) {
      assert.ok(!('cardId' in p.account), `${type} has no card account`);
      assert.ok(!accountKey(p.account).includes('card-1'), `${type} card id not in account key`);
    }
  }
});

test('scope: wallet accounts are organisation-level, physical money is casino-level', () => {
  assert.equal(ACCOUNT_KINDS.WALLET_AVAILABLE.scope, 'ORG');
  assert.equal(ACCOUNT_KINDS.WALLET_RESERVED.scope, 'ORG');
  for (const k of ['DRAWER', 'VAULT', 'CASHBOX', 'HOPPER', 'TICKET_LIABILITY', 'MACHINE_CREDIT'] as const) assert.equal(ACCOUNT_KINDS[k].scope, 'CASINO');
  // The same wallet used from two casinos maps to the same wallet account.
  const a = postings('CASH_DEPOSIT', { ...ctxFor('CASH_DEPOSIT'), casinoId: 'casino-A' });
  const b = postings('CASH_DEPOSIT', { ...ctxFor('CASH_DEPOSIT'), casinoId: 'casino-B' });
  const walletA = a.find((p) => p.account.kind === 'WALLET_AVAILABLE')!;
  const walletB = b.find((p) => p.account.kind === 'WALLET_AVAILABLE')!;
  assert.equal(walletA.account.casinoId, undefined);
  assert.equal(accountKey(walletA.account), accountKey(walletB.account));
  // Physical money stays casino-specific.
  const drawerA = a.find((p) => p.account.kind === 'DRAWER')!;
  const drawerB = b.find((p) => p.account.kind === 'DRAWER')!;
  assert.notEqual(accountKey(drawerA.account), accountKey(drawerB.account));
});

test('postings: concrete rows follow the agreed matrix', () => {
  const show = (type: MoneyTransactionType, extra: Partial<MoneyContext> = {}) =>
    postings(type, { ...ctxFor(type), ...extra }).map((p) => `${p.amountCents > 0 ? 'Dr' : 'Cr'} ${p.account.kind}`);
  assert.deepEqual(show('CASH_DEPOSIT'), ['Dr DRAWER', 'Cr WALLET_AVAILABLE']);
  assert.deepEqual(show('CASH_WITHDRAWAL'), ['Dr WALLET_AVAILABLE', 'Cr DRAWER']);
  assert.deepEqual(show('WALLET_TO_MACHINE_RESERVE'), ['Dr WALLET_AVAILABLE', 'Cr WALLET_RESERVED']);
  assert.deepEqual(show('WALLET_TO_MACHINE_CONFIRM'), ['Dr WALLET_RESERVED', 'Cr MACHINE_CREDIT']);
  assert.deepEqual(show('WALLET_TO_MACHINE_RELEASE'), ['Dr WALLET_RESERVED', 'Cr WALLET_AVAILABLE']);
  assert.deepEqual(show('MACHINE_TO_WALLET'), ['Dr MACHINE_CREDIT', 'Cr WALLET_AVAILABLE']);
  assert.deepEqual(show('MACHINE_CASH_IN'), ['Dr CASHBOX', 'Cr MACHINE_CREDIT']);
  assert.deepEqual(show('TITO_ISSUE_MACHINE'), ['Dr MACHINE_CREDIT', 'Cr TICKET_LIABILITY']);
  assert.deepEqual(show('TITO_REDEEM_CASHIER'), ['Dr TICKET_LIABILITY', 'Cr DRAWER']);
  assert.deepEqual(show('TITO_REDEEM_CASHIER', { payTo: 'WALLET' }), ['Dr TICKET_LIABILITY', 'Cr WALLET_AVAILABLE']);
  assert.deepEqual(show('TITO_REDEEM_MACHINE'), ['Dr TICKET_LIABILITY', 'Cr MACHINE_CREDIT']);
  assert.deepEqual(show('HANDPAY_CREATE_JACKPOT'), ['Dr GAMING_JACKPOT_EXPENSE', 'Cr HANDPAY_PAYABLE']);
  assert.deepEqual(show('HANDPAY_PAY'), ['Dr HANDPAY_PAYABLE', 'Cr DRAWER']);
  assert.deepEqual(show('HANDPAY_PAY', { payTo: 'WALLET' }), ['Dr HANDPAY_PAYABLE', 'Cr WALLET_AVAILABLE']);
  assert.deepEqual(show('VAULT_FILL'), ['Dr DRAWER', 'Cr VAULT']);
  assert.deepEqual(show('VAULT_DROP'), ['Dr VAULT', 'Cr DRAWER']);
  assert.deepEqual(show('MACHINE_DROP'), ['Dr VAULT', 'Cr CASHBOX']);
  assert.deepEqual(show('PETTY_CASH'), ['Dr PETTY_CASH_EXPENSE', 'Cr VAULT']);
  assert.deepEqual(show('CASH_ADVANCE'), ['Dr CARD_SETTLEMENT_RECEIVABLE', 'Cr DRAWER', 'Cr ADVANCE_FEE_INCOME']);
  assert.deepEqual(show('DRAWER_SHORT_OVER', { amountCents: cents(-500) }), ['Dr CASH_SHORT_OVER', 'Cr DRAWER']);
  assert.deepEqual(show('DRAWER_SHORT_OVER', { amountCents: cents(500) }), ['Dr DRAWER', 'Cr CASH_SHORT_OVER']);
  assert.deepEqual(show('GAMING_SETTLEMENT', { amountCents: cents(700) }), ['Dr MACHINE_CREDIT', 'Cr GAMING_RESULT']);
});

test('postings: required references and amounts are enforced', () => {
  assert.throws(() => postings('CASH_DEPOSIT', { casinoId: 'c', amountCents: cents(100), cashierSessionId: 's' }), /player required/);
  assert.throws(() => postings('HANDPAY_PAY', { ...ids, cashierSessionId: undefined, amountCents: cents(100) }), /cashierSession required/);
  assert.throws(() => postings('CASH_DEPOSIT', { ...ids, amountCents: cents(0) }), /positive/);
  assert.throws(() => postings('CASH_DEPOSIT', { ...ids, amountCents: cents(-1) }), /positive/);
  assert.throws(() => postings('DRAWER_SHORT_OVER', { ...ids, amountCents: cents(0) }), /non-zero/);
  assert.throws(() => postings('ADJUSTMENT', { ...ids, amountCents: cents(1), debit: { kind: 'GAMING_RESULT' }, credit: { kind: 'VAULT', vaultId: 'v' } }), /cannot be adjusted/);
  assert.throws(() => postings('OPENING_BALANCE', { ...ids, amountCents: cents(1), debit: { kind: 'VAULT', vaultId: 'v' }, credit: { kind: 'DRAWER', cashierSessionId: 's' } }), /OPENING_EQUITY/);
});

test('reversal negates the original exactly', () => {
  const original = postings('CASH_WITHDRAWAL', ctxFor('CASH_WITHDRAWAL'));
  const rev = postings('REVERSAL', { ...ids, amountCents: cents(12_345), original });
  assert.deepEqual(rev.map((p) => p.amountCents), original.map((p) => -p.amountCents));
});

test('matrix metadata references only valid types and capabilities', () => {
  for (const type of MONEY_TRANSACTION_TYPES) {
    const def = MONEY_TRANSACTIONS[type];
    if (def.reversal.kind === 'VIA') assert.ok(MONEY_TRANSACTION_TYPES.includes(def.reversal.type), `${type} reversal target`);
    for (const opt of [{}, { payTo: 'WALLET' as const }, { payFrom: 'WALLET' as const }]) {
      const cap = requiredCapability(type, opt);
      if (cap) assert.ok(PLAYER_CAPABILITIES.includes(cap));
    }
  }
  assert.equal(requiredCapability('WALLET_TO_MACHINE_RELEASE'), null, 'system steps never blocked by player status');
  assert.equal(requiredCapability('WALLET_TO_MACHINE_CONFIRM'), null);
});

test('display balance sign follows the account class', () => {
  assert.equal(displayBalance('DRAWER', 500), 500);
  assert.equal(displayBalance('WALLET_AVAILABLE', -500), 500);
});
