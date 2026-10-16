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

test('dependencies: HANDPAY needs CASH technically, never TITO; TITO only through the maintenance window', async () => {
  const { RAIL_PRODUCTION_READY, RAIL_IMPLEMENTATION_REQUIRES, CUTOVER_PREREQUISITES, railRelease, railReleaseBlockers } = await import('./cutover');
  const { MONEY_TRANSACTIONS, postings } = await import('./transactions');
  const { ACCOUNT_KIND_RAIL } = await import('./cutover');
  // A: derived from the posting matrix: every rail a HANDPAY posting touches
  const touched = new Set<string>();
  for (const type of ['HANDPAY_CREATE_JACKPOT', 'HANDPAY_PAY'] as const)
    for (const payTo of ['CASH', 'WALLET'] as const)
      for (const p of postings(type, { casinoId: 'c', amountCents: 100 as never, machineId: 'm', handpayId: 'h', cashierSessionId: 's', walletId: 'w', payTo }))
        if (ACCOUNT_KIND_RAIL[p.account.kind]) touched.add(ACCOUNT_KIND_RAIL[p.account.kind]!);
  assert.deepEqual([...touched].sort(), ['CASH', 'CASHLESS', 'HANDPAY']);
  assert.ok(!touched.has('TITO'));
  assert.ok(MONEY_TRANSACTIONS.HANDPAY_PAY.rail === 'HANDPAY');
  assert.deepEqual([...RAIL_IMPLEMENTATION_REQUIRES.HANDPAY], ['CASH']);
  // B: the cutover prerequisite
  assert.deepEqual([...CUTOVER_PREREQUISITES.HANDPAY], ['CASH']);
  // C: TITO appears only as a missing rail of the shared maintenance window
  const r = railRelease('HANDPAY');
  assert.deepEqual([r.implementationMissing, r.windowMissing, r.released], [[], ['TITO'], false]);
  assert.deepEqual(railReleaseBlockers('HANDPAY'), ['TITO']);
  assert.deepEqual(railRelease('CASHLESS').released, true);
  assert.deepEqual([...RAIL_PRODUCTION_READY], ['CASHLESS']);
});
