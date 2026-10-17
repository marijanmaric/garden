import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyScan, describeItem, eventLabel, formatCents, parseAmountCents, parseCountCents, requiresApproval, APPROVAL_LABEL, MACHINE_EVENT_LABEL, CASH_TX_LABEL_LEDGER, MONEY_TX_LABEL } from '../lib/money';
import { intentKey, settleIntent } from '../lib/intent';

test('amounts are parsed to integer cents without floating point', () => {
  assert.equal(parseAmountCents('50'), 5000);
  assert.equal(parseAmountCents('12,5'), 1250);
  assert.equal(parseAmountCents('12.50'), 1250);
  assert.equal(parseAmountCents('0,10'), 10);
  assert.equal(parseAmountCents('1.234,56'), 123456);
  assert.equal(parseAmountCents('1,234.56'), 123456);
  assert.equal(parseAmountCents('1.234'), 123400, 'three digits after a separator group thousands');
  assert.equal(parseAmountCents('19.99'), 1999);
  assert.equal(parseAmountCents('0.29'), 29, 'no float rounding error (0.29 * 100 = 28.999...)');
  assert.equal(parseAmountCents(' 7 € '), 700);
  for (const bad of ['', '0', '0,00', '-5', 'abc', '1,2,3', '12.345,6.7', '5e3', '1.5.5']) assert.equal(parseAmountCents(bad), null, bad);
});

test('blind counts accept zero', () => {
  assert.equal(parseCountCents('0'), 0);
  assert.equal(parseCountCents('0,00'), 0);
  assert.equal(parseCountCents('25,5'), 2550);
  assert.equal(parseCountCents('x'), null);
});

test('cents are displayed exactly', () => {
  assert.equal(formatCents(123456), '1.234,56 €');
  assert.equal(formatCents(-5), '-0,05 €');
  assert.equal(formatCents(0), '0,00 €');
  assert.equal(formatCents(null), '-');
});

test('approval requirement mirrors the API rule (amount >= limit, no limit = none)', () => {
  assert.equal(requiresApproval(10000, 10000), true);
  assert.equal(requiresApproval(9999, 10000), false);
  assert.equal(requiresApproval(1_000_000, null), false);
  assert.equal(requiresApproval(1, 0), true);
});

test('scan anything: TITO barcode vs player card', () => {
  assert.equal(classifyScan('123456789012345678'), 'TICKET');
  assert.equal(classifyScan('PC-00001'), 'CARD');
  assert.equal(classifyScan(' 4711 0815 '), 'UNKNOWN');
  assert.equal(classifyScan(''), 'UNKNOWN');
});

test('operator wording never says COIN', () => {
  const all = [...Object.values(APPROVAL_LABEL), ...Object.values(MACHINE_EVENT_LABEL), ...Object.values(CASH_TX_LABEL_LEDGER), ...Object.values(MONEY_TX_LABEL)];
  for (const l of all) assert.doesNotMatch(l, /coin/i, l);
  for (const t of ['COIN_IN', 'COIN_OUT', 'TICKET_IN', 'SOME_COIN_EVENT']) assert.doesNotMatch(eventLabel(t), /coin/i, t);
  assert.equal(eventLabel('COIN_IN'), 'CASH in');
});

test('reconciliation items are described in business terms', () => {
  assert.equal(describeItem('meters:m1:CASH_IN', (id) => (id === 'm1' ? 'A-001' : undefined)), 'Meters ≠ ledger: A-001 CASH in');
  assert.match(describeItem('machine_event:0123456789abcdef'), /^Machine event 01234567/);
  assert.equal(describeItem('ledger:org'), 'Ledger invariants');
  assert.equal(describeItem('unknown_kind:x'), 'unknown_kind:x');
});

test('one idempotency key per operator intent, released only after success', () => {
  const a = intentKey('/cashier/wallet/deposit', { playerCard: 'PC-1', amount: 50 });
  const b = intentKey('/cashier/wallet/deposit', { amount: 50, playerCard: 'PC-1' });
  assert.equal(a, b, 'same intent (key order irrelevant) -> same key: a retry after a lost response replays instead of booking twice');
  assert.match(a, /^op-[0-9a-f]{32}$/);
  assert.notEqual(intentKey('/cashier/wallet/deposit', { playerCard: 'PC-1', amount: 60 }), a, 'different amount -> different intent');
  assert.notEqual(intentKey('/cashier/wallet/withdraw', { playerCard: 'PC-1', amount: 50 }), a, 'different action -> different intent');
  settleIntent('/cashier/wallet/deposit', { amount: 50, playerCard: 'PC-1' });
  assert.notEqual(intentKey('/cashier/wallet/deposit', { playerCard: 'PC-1', amount: 50 }), a, 'after success the next identical action is a new one');
});
