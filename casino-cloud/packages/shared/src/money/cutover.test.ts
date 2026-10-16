import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_KINDS, ACCOUNT_KIND_KEYS } from './accounts';
import { ACCOUNT_KIND_RAIL, CUTOVER_PREREQUISITES, CUTOVER_RAILS, LEGACY_CASH_TX_RAILS } from './cutover';
import { CASH_TX_TYPES } from '../cash';

test('cutover order is acyclic and complete', () => {
  const done = new Set<string>();
  for (let round = 0; round < CUTOVER_RAILS.length; round++)
    for (const r of CUTOVER_RAILS) if (CUTOVER_PREREQUISITES[r].every((p) => done.has(p))) done.add(r);
  assert.equal(done.size, CUTOVER_RAILS.length);
});

test('every money-holding account kind belongs to exactly one rail; suspense and P&L kinds to none', () => {
  const unowned = ACCOUNT_KIND_KEYS.filter((k) => !ACCOUNT_KIND_RAIL[k] && ['ASSET', 'LIABILITY'].includes(ACCOUNT_KINDS[k].class));
  assert.deepEqual(unowned.sort(), ['BANK_CLEARING', 'CARD_SETTLEMENT_RECEIVABLE', 'CASHLESS_EXCEPTION', 'TITO_EXCEPTION']);
  assert.ok(!ACCOUNT_KIND_RAIL.OPENING_EQUITY && !ACCOUNT_KIND_RAIL.GAMING_RESULT);
});

test('every legacy cash transaction type is mapped to the rails it moves money on', () => {
  assert.deepEqual(Object.keys(LEGACY_CASH_TX_RAILS).sort(), Object.keys(CASH_TX_TYPES).sort());
  for (const rails of Object.values(LEGACY_CASH_TX_RAILS)) assert.ok(rails.includes('CASH'));
});

test('production release: a rail is released only with everything its legacy operations depend on', async () => {
  const { RAIL_PRODUCTION_READY, railReleaseBlockers } = await import('./cutover');
  assert.deepEqual([...RAIL_PRODUCTION_READY], ['CASHLESS']);
  assert.deepEqual(railReleaseBlockers('HANDPAY'), ['TITO']);
  assert.deepEqual(railReleaseBlockers('CASH'), ['TITO']);
  assert.deepEqual(railReleaseBlockers('CASHLESS'), []);
});
