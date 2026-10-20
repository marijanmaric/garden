import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, evaluateModules, featureAvailable, type ProductModule } from '@m1/shared';
import { NAV, navItemFor } from '../components/nav';

const visible = (modules: ProductModule[]) => {
  const eff = new Set(evaluateModules({ planModules: modules, overrides: {}, disabled: [], subscriptionUsable: true }).filter((m) => m.effective).map((m) => m.module));
  return NAV.flatMap((g) => g.items).filter((i) => featureAvailable(i.feature, eff)).map((i) => i.href);
};

test('every navigation item declares a known feature', () => {
  for (const i of NAV.flatMap((g) => g.items)) assert.ok(i.feature in FEATURES, `${i.href}: ${i.feature}`);
});

test('the page guard maps direct URLs (also nested) to their navigation feature', () => {
  assert.equal(navItemFor('/tickets')?.feature, 'tito');
  assert.equal(navItemFor('/vault')?.feature, 'vault');
  assert.equal(navItemFor('/machines/123')?.feature, 'core');
  assert.equal(navItemFor('/cashier')?.feature, 'cash');
  assert.equal(navItemFor('/mobile')?.feature, 'cash');
  assert.equal(navItemFor('/reports')?.feature, 'reporting');
  assert.equal(navItemFor('/')?.feature, 'core');
});

test('sidebar per plan: TITO only shows no cash, vault or cashier pages; Enterprise shows all', () => {
  const tito = visible(['CORE', 'TITO', 'REPORTING']);
  for (const h of ['/tickets', '/reports', '/reconciliation', '/']) assert.ok(tito.includes(h), h);
  for (const h of ['/cashier', '/mobile', '/vault', '/cash']) assert.ok(!tito.includes(h), h);
  assert.ok(!tito.includes('/handpays'));
  // F3: TITO + HANDPAY pays handpays as TITO vouchers on its own handpay page (no cashier)
  const titoHandpay = visible(['CORE', 'TITO', 'HANDPAY']);
  assert.ok(titoHandpay.includes('/handpays') && !titoHandpay.includes('/cashier'));
  const cashless = visible(['CORE', 'CASHLESS', 'MACHINE', 'VAULT']);
  assert.ok(cashless.includes('/vault') && !cashless.includes('/tickets') && !cashless.includes('/cashier'));
  const all = visible(['CORE', 'TITO', 'HANDPAY', 'CASH', 'VAULT', 'CASHLESS', 'MACHINE', 'REPORTING', 'ADVANCED_RECONCILIATION']);
  assert.equal(all.length, NAV.flatMap((g) => g.items).length);
  const core = visible(['CORE']);
  assert.ok(!core.includes('/reconciliation') && !core.includes('/reports'), 'reconciliation needs a money module');
});
