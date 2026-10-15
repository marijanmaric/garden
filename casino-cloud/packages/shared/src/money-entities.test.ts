import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HANDPAY_TRANSITIONS, TRANSFER_TRANSITIONS, WALLET_TRANSITIONS, denominationTotal, walletOperationBlocked } from './money-entities';

test('wallet rules combine wallet state and player status', () => {
  assert.equal(walletOperationBlocked('DEPOSIT', 'ACTIVE', 'ACTIVE'), null);
  assert.match(walletOperationBlocked('DEPOSIT', 'ACTIVE', 'BLOCKED')!, /Wallet status BLOCKED/);
  assert.equal(walletOperationBlocked('FROM_MACHINE', 'ACTIVE', 'BLOCKED'), null);
  assert.match(walletOperationBlocked('DEPOSIT', 'EXCLUDED', 'ACTIVE')!, /Player status EXCLUDED/);
  assert.equal(walletOperationBlocked('WITHDRAW', 'EXCLUDED', 'ACTIVE'), null);
  for (const op of ['DEPOSIT', 'WITHDRAW', 'TO_MACHINE', 'FROM_MACHINE'] as const) assert.ok(walletOperationBlocked(op, 'ACTIVE', 'CLOSED'));
  assert.equal(WALLET_TRANSITIONS.can('CLOSED', 'ACTIVE'), false);
});

test('a requested transfer is not a completed movement; terminal states stay terminal', () => {
  assert.equal(TRANSFER_TRANSITIONS.can('REQUESTED', 'CONFIRMED'), false);
  assert.equal(TRANSFER_TRANSITIONS.can('SENT', 'CONFIRMED'), true);
  for (const t of ['CONFIRMED', 'FAILED', 'EXPIRED'] as const) assert.deepEqual(TRANSFER_TRANSITIONS.map[t], []);
});

test('handpay: PENDING -> APPROVED -> PAID -> MACHINE_RESET, VOIDED only before payment', () => {
  assert.equal(HANDPAY_TRANSITIONS.can('PENDING', 'PAID'), false);
  assert.equal(HANDPAY_TRANSITIONS.can('APPROVED', 'PAID'), true);
  assert.equal(HANDPAY_TRANSITIONS.can('PAID', 'VOIDED'), false);
  assert.equal(HANDPAY_TRANSITIONS.can('PAID', 'MACHINE_RESET'), true);
});

test('denomination counts sum in integer cents', () => {
  assert.equal(denominationTotal({ '5000': 3, '1000': 2, '50': 7 }), 17_350);
  assert.throws(() => denominationTotal({ '12.5': 1 }));
  assert.throws(() => denominationTotal({ '100': -1 }));
});
