import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_STATUSES, PLAYER_CAPABILITIES, PLAYER_STATUSES, canTransitionCard, canTransitionPlayer, cardUsability, maskDocumentNumber, playerCan,
  verificationRequired,
} from './player';

test('ACTIVE can do everything, CLOSED nothing', () => {
  for (const c of PLAYER_CAPABILITIES) {
    assert.equal(playerCan('ACTIVE', c), true, c);
    assert.equal(playerCan('CLOSED', c), false, c);
  }
});

test('SUSPENDED: frozen, only machine -> wallet and profile maintenance', () => {
  assert.equal(playerCan('SUSPENDED', 'CASHLESS_FROM_MACHINE'), true);
  assert.equal(playerCan('SUSPENDED', 'PROFILE_UPDATE'), true);
  for (const c of ['CARD_LOGIN', 'CARD_ISSUE', 'WALLET_DEPOSIT', 'WALLET_WITHDRAW', 'CASHLESS_TO_MACHINE', 'HANDPAY_TO_WALLET', 'CASH_ADVANCE'] as const)
    assert.equal(playerCan('SUSPENDED', c), false, c);
});

test('EXCLUDED: wallet in and cashless to machine blocked, withdrawal of the existing balance allowed', () => {
  for (const c of ['CARD_LOGIN', 'CARD_ISSUE', 'WALLET_DEPOSIT', 'CASHLESS_TO_MACHINE', 'HANDPAY_TO_WALLET', 'CASH_ADVANCE'] as const)
    assert.equal(playerCan('EXCLUDED', c), false, c);
  assert.equal(playerCan('EXCLUDED', 'WALLET_WITHDRAW'), true);
  assert.equal(playerCan('EXCLUDED', 'CASHLESS_FROM_MACHINE'), true);
});

test('status transitions: CLOSED is terminal', () => {
  for (const s of PLAYER_STATUSES) assert.equal(canTransitionPlayer('CLOSED', s), false);
  assert.equal(canTransitionPlayer('ACTIVE', 'SUSPENDED'), true);
  assert.equal(canTransitionPlayer('EXCLUDED', 'SUSPENDED'), false);
});

test('cards: only ACTIVE, unexpired cards are usable; LOST/REPLACED/EXPIRED are terminal', () => {
  assert.equal(cardUsability({ status: 'ACTIVE' }), null);
  assert.equal(cardUsability({ status: 'BLOCKED' }), 'CARD_BLOCKED');
  assert.equal(cardUsability({ status: 'LOST' }), 'CARD_LOST');
  assert.equal(cardUsability({ status: 'REPLACED' }), 'CARD_REPLACED');
  assert.equal(cardUsability({ status: 'ACTIVE', expires_at: '2000-01-01' }), 'CARD_EXPIRED');
  for (const s of CARD_STATUSES) for (const t of ['LOST', 'REPLACED', 'EXPIRED'] as const) assert.equal(canTransitionCard(t, s), false);
  assert.equal(canTransitionCard('BLOCKED', 'ACTIVE'), true);
});

test('document numbers are masked to the last 4 characters', () => {
  assert.equal(maskDocumentNumber('P 1234 5678'), '*****5678');
  assert.equal(maskDocumentNumber('123'), '***');
});

test('verification threshold is configurable and absent by default', () => {
  assert.equal(verificationRequired(1_000_000_00, null), false);
  assert.equal(verificationRequired(100_00, 100_00), true);
  assert.equal(verificationRequired(99_99, 100_00), false);
});
