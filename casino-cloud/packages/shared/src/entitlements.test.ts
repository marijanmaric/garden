import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURES, PRODUCT_MODULES, PRODUCT_MODULE_DEFS, closure, dependentsOf, evaluateModules, featureAvailable, subscriptionUsable,
  type ProductModule,
} from './entitlements';

const effective = (s: ReturnType<typeof evaluateModules>) => s.filter((x) => x.effective).map((x) => x.module);
const ev = (planModules: ProductModule[], extra: Partial<Parameters<typeof evaluateModules>[0]> = {}) =>
  evaluateModules({ planModules, overrides: {}, disabled: [], subscriptionUsable: true, ...extra });

test('dependency graph: acyclic, CORE everywhere, verified dependencies', () => {
  for (const m of PRODUCT_MODULES) {
    assert.ok(!closure([m]).filter((x) => x !== m).some((d) => closure([d]).includes(m)), `${m} in a cycle`);
    if (m !== 'CORE') assert.ok(PRODUCT_MODULE_DEFS[m].requires.includes('CORE'), m);
  }
  assert.deepEqual(closure(['CASHLESS']), ['CORE', 'VAULT', 'CASHLESS', 'MACHINE']);
  assert.deepEqual(closure(['CASH']), ['CORE', 'CASH', 'VAULT']);
  assert.deepEqual(closure(['TITO']), ['CORE', 'TITO']);
  assert.deepEqual(dependentsOf('VAULT').sort(), ['CASH', 'CASHLESS', 'MACHINE']);
});

test('customer matrix: TITO only, TITO + HANDPAY, CASH, CASHLESS, FULL', () => {
  assert.deepEqual(effective(ev(['CORE', 'TITO'])), ['CORE', 'TITO']);
  assert.deepEqual(effective(ev(['CORE', 'TITO', 'HANDPAY'])), ['CORE', 'TITO', 'HANDPAY']);
  assert.deepEqual(effective(ev(['CORE', 'CASH', 'VAULT'])), ['CORE', 'CASH', 'VAULT']);
  assert.deepEqual(effective(ev(['CORE', 'CASHLESS', 'MACHINE', 'VAULT'])), ['CORE', 'VAULT', 'CASHLESS', 'MACHINE']);
  assert.deepEqual(effective(ev([...PRODUCT_MODULES])), [...PRODUCT_MODULES]);
});

test('states: not purchased, disabled, dependency missing, subscription inactive are distinct', () => {
  const s = ev(['CORE', 'CASH', 'CASHLESS', 'MACHINE'], { disabled: ['MACHINE'] });
  const st = (m: ProductModule) => s.find((x) => x.module === m)!;
  assert.equal(st('VAULT').state, 'NOT_PURCHASED');
  assert.equal(st('CASH').state, 'DEPENDENCY_MISSING');
  assert.deepEqual(st('CASH').missing, ['VAULT']);
  assert.equal(st('MACHINE').state, 'DISABLED');
  assert.equal(st('CASHLESS').state, 'DEPENDENCY_MISSING');
  assert.equal(st('CORE').state, 'ENABLED');
  const off = ev(['CORE', 'TITO'], { subscriptionUsable: false });
  assert.equal(off.find((x) => x.module === 'TITO')!.state, 'SUBSCRIPTION_INACTIVE');
  assert.equal(off.find((x) => x.module === 'CORE')!.effective, true, 'CORE stays usable (data access, administration)');
});

test('overrides win over the plan in both directions; CORE cannot be removed', () => {
  const s = ev(['CORE', 'TITO', 'CASHLESS', 'MACHINE', 'VAULT'], { overrides: { CASHLESS: false, HANDPAY: true, CORE: false } });
  assert.deepEqual(effective(s), ['CORE', 'TITO', 'HANDPAY', 'VAULT', 'MACHINE']);
  assert.equal(s.find((x) => x.module === 'HANDPAY')!.source, 'OVERRIDE');
  assert.equal(s.find((x) => x.module === 'CASHLESS')!.state, 'NOT_PURCHASED');
});

test('features: cage actions need the cash module, handpay payment needs cash or cashless', () => {
  const tito = new Set<ProductModule>(['CORE', 'TITO']);
  assert.equal(featureAvailable('tito', tito), true);
  assert.equal(featureAvailable('tito.cashier', tito), false);
  assert.equal(featureAvailable('handpay.pay', new Set<ProductModule>(['CORE', 'HANDPAY'])), false);
  assert.equal(featureAvailable('handpay.pay', new Set<ProductModule>(['CORE', 'HANDPAY', 'CASHLESS'])), true);
  assert.equal(featureAvailable('reconciliation', new Set<ProductModule>(['CORE'])), false);
  assert.equal(featureAvailable('reconciliation', tito), true);
  assert.equal(featureAvailable('core', new Set<ProductModule>(['CORE'])), true);
  for (const f of Object.keys(FEATURES)) assert.equal(typeof featureAvailable(f as never, [...PRODUCT_MODULES]), 'boolean');
});

test('subscription lifecycle: only TRIAL / ACTIVE before ends_at are usable', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  assert.equal(subscriptionUsable('ACTIVE', null, now), true);
  assert.equal(subscriptionUsable('TRIAL', '2026-07-01T00:00:00Z', now), true);
  assert.equal(subscriptionUsable('TRIAL', '2026-05-01T00:00:00Z', now), false);
  for (const s of ['SUSPENDED', 'EXPIRED', 'CANCELLED'] as const) assert.equal(subscriptionUsable(s, null, now), false);
  assert.equal(subscriptionUsable(null, null, now), false);
});
