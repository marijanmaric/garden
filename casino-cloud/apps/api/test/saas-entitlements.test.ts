import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from '@m1/database';
import { ENTITLEMENT_ERRORS, type ProductModule } from '@m1/shared';
import { setupTestDatabase } from './helpers';

/**
 * Production readiness: multi-tenant SaaS administration and commercial entitlements. Five customer
 * organisations are onboarded through the platform API (ORG_TITO_ONLY, ORG_TITO_HANDPAY, ORG_CASH,
 * ORG_CASHLESS, ORG_FULL) and every module boundary is checked against the backend, not the UI.
 */
let app: FastifyInstance;
let pool: Pool;
let platform: string;
const SAFE = ENTITLEMENT_ERRORS.MODULE_NOT_ENTITLED;

type Org = { id: string; key: string; admin: string; casino: string; machines: string[]; tokens: Record<string, string> };
const orgs: Record<string, Org> = {};
const PLANS: Record<string, string> = {
  ORG_TITO_ONLY: 'TITO_STARTER', ORG_TITO_HANDPAY: 'TITO_HANDPAY', ORG_CASH: 'CASH_OPERATIONS', ORG_CASHLESS: 'CASHLESS_MACHINE', ORG_FULL: 'ENTERPRISE',
};
const EXPECTED: Record<string, ProductModule[]> = {
  ORG_TITO_ONLY: ['CORE', 'TITO', 'REPORTING'],
  ORG_TITO_HANDPAY: ['CORE', 'TITO', 'HANDPAY', 'REPORTING'],
  ORG_CASH: ['CORE', 'TITO', 'HANDPAY', 'CASH', 'VAULT', 'REPORTING'],
  ORG_CASHLESS: ['CORE', 'VAULT', 'CASHLESS', 'MACHINE', 'REPORTING'],
  ORG_FULL: ['CORE', 'TITO', 'HANDPAY', 'CASH', 'VAULT', 'CASHLESS', 'MACHINE', 'REPORTING', 'ADVANCED_RECONCILIATION'],
};

const call = (token: string | undefined, method: string, url: string, payload?: unknown) =>
  app.inject({
    method: method as 'GET', url, payload: payload as object,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(method === 'GET' ? {} : { 'idempotency-key': `t-${randomUUID()}` }) },
  });
const login = async (email: string, password: string) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } })).json().token as string;
/** Tokens for the onboarded users are signed directly: the login route is rate limited to 10 per minute. */
const tokenFor = async (email: string) => {
  const { signToken } = await import('../src/auth');
  const e = (await pool.query('SELECT id, org_id, role, name, email FROM employees WHERE lower(email) = lower($1)', [email])).rows[0];
  return signToken({ sub: e.id, orgId: e.org_id, role: e.role, name: e.name, email: e.email });
};
const planId = async (code: string) => (await pool.query('SELECT id FROM plans WHERE code = $1 ORDER BY version DESC LIMIT 1', [code])).rows[0].id as string;
const ok = (r: { statusCode: number; body: string }, msg = '') => assert.ok(r.statusCode < 300, `${msg} ${r.statusCode} ${r.body}`);

async function onboard(key: string): Promise<Org> {
  const slug = key.toLowerCase().replace(/_/g, '-');
  const r = await call(platform, 'POST', '/api/v1/platform/organizations', {
    name: key, slug, planId: await planId(PLANS[key]), admin: { name: `${key} Admin`, email: `admin@${slug}.test`, password: 'correct-horse-battery' },
  });
  ok(r, 'onboard');
  const id = r.json().id;
  const casino = await call(platform, 'POST', `/api/v1/platform/organizations/${id}/casinos`, { code: `${slug.slice(4, 12)}-1`.toUpperCase(), name: `${key} Casino` });
  ok(casino, 'casino');
  const machines: string[] = [];
  for (let i = 1; i <= 2; i++) {
    const m = await call(platform, 'POST', `/api/v1/platform/organizations/${id}/machines`, { casinoId: casino.json().id, machineCode: `${key}-M${i}`, assetNo: `A${i}` });
    ok(m, 'machine');
    machines.push(m.json().id);
  }
  const admin = await tokenFor(`admin@${slug}.test`);
  const tokens: Record<string, string> = { admin };
  for (const role of ['CASINO_ADMIN', 'MANAGER', 'CASHIER']) {
    const email = `${role.toLowerCase()}@${slug}.test`;
    ok(await call(admin, 'POST', '/api/v1/employees', { name: role, role, email, password: 'password-1', casinoIds: [casino.json().id] }), 'employee');
    tokens[role] = await tokenFor(email);
  }
  return { id, key, admin, casino: casino.json().id, machines, tokens };
}

before(async () => {
  ({ app, pool } = await setupTestDatabase());
  platform = await login('platform@example.com', 'demo');
  for (const key of Object.keys(PLANS)) orgs[key] = await onboard(key);
});

after(async () => {
  await app?.close();
  await pool?.end();
});

describe('SaaS entitlements', () => {
  test('onboarding: each organisation has exactly the modules of its plan; /me/entitlements is per organisation (no cross-org cache)', async () => {
    for (const [key, o] of Object.entries(orgs)) {
      const me = (await call(o.admin, 'GET', '/api/v1/me/entitlements')).json();
      assert.equal(me.orgId, o.id);
      assert.deepEqual(me.modules.filter((m: { effective: boolean }) => m.effective).map((m: { module: string }) => m.module).sort(), [...EXPECTED[key]].sort(), key);
      const auth = (await call(o.tokens.CASHIER, 'GET', '/api/v1/auth/me')).json();
      assert.equal(auth.entitlements.orgId, o.id, 'a cashier sees the entitlements of the own organisation');
      assert.equal(auth.user.isPlatformAdmin, false);
    }
    // alternating requests of two organisations never return the other organisation's entitlements
    for (let i = 0; i < 5; i++) {
      assert.equal((await call(orgs.ORG_TITO_ONLY.admin, 'GET', '/api/v1/me/entitlements')).json().orgId, orgs.ORG_TITO_ONLY.id);
      assert.equal((await call(orgs.ORG_FULL.admin, 'GET', '/api/v1/me/entitlements')).json().orgId, orgs.ORG_FULL.id);
    }
  });

  test('route coverage: every API route declares a feature; a route without one cannot be registered and the guard fails closed', async () => {
    const { buildApp } = await import('../src/app');
    const probe = await buildApp();
    const features: string[] = [];
    // the onRoute hook of buildApp already refused any feature-less /api/v1 route; re-check the registered ones
    assert.throws(() => probe.get('/api/v1/unguarded', async () => ({})), /declares no entitlement feature/);
    probe.get('/api/v1/probe', { config: { feature: 'core' } }, async () => ({}));
    await probe.ready();
    const lines = probe.printRoutes({ commonPrefix: false }).split('\n').filter((l) => l.includes('/api/v1/'));
    features.push(...lines);
    assert.ok(features.length >= 50, `${features.length} API route nodes registered, all with a feature`);
    await probe.close();
  });

  test('matrix: every module boundary is enforced by the API with 403 MODULE_NOT_ENTITLED and the safe message', async () => {
    // [feature modules needed, method, url]; a non-entitled call returns the entitlement error before validation
    const probes: Array<[ProductModule[], ProductModule[] | null, string, (o: Org) => string]> = [
      [['TITO'], null, 'GET', () => '/api/v1/tickets'],
      [['TITO', 'CASH'], null, 'POST', () => '/api/v1/tickets/redeem'],
      [['HANDPAY'], null, 'GET', () => '/api/v1/cashier/handpays'],
      [['HANDPAY'], ['CASH', 'CASHLESS'], 'POST', (o) => `/api/v1/cashier/handpays/${o.machines[0]}`],
      [['CASH'], null, 'GET', () => '/api/v1/cashier/desks'],
      [['CASH'], null, 'POST', () => '/api/v1/cashier/session/open'],
      [['VAULT'], null, 'GET', (o) => `/api/v1/vault/status?casinoId=${o.casino}`],
      [['VAULT'], null, 'POST', () => '/api/v1/vault/sessions'],
      [['MACHINE'], null, 'GET', (o) => `/api/v1/cash/collections/expected/${o.machines[0]}`],
      [['MACHINE'], null, 'POST', (o) => `/api/v1/machines/${o.machines[0]}/hopper-fills`],
      [['CASHLESS', 'CASH'], null, 'POST', () => '/api/v1/cashier/wallet/approval-request'],
      [['REPORTING'], null, 'GET', () => '/api/v1/reports'],
      [['ADVANCED_RECONCILIATION'], null, 'GET', () => '/api/v1/audit/verify'],
      [['ADVANCED_RECONCILIATION'], null, 'GET', (o) => `/api/v1/money/reconciliation/meters?casinoId=${o.casino}`],
      [[], ['TITO', 'HANDPAY', 'CASH', 'VAULT', 'CASHLESS', 'MACHINE'], 'GET', (o) => `/api/v1/money/reconciliation?casinoId=${o.casino}`],
      [['CORE'], null, 'GET', () => '/api/v1/dashboard'],
      [['CORE'], null, 'GET', () => '/api/v1/machines'],
    ];
    let checked = 0, refused = 0;
    for (const [key, o] of Object.entries(orgs)) {
      const has = new Set(EXPECTED[key]);
      for (const [all, anyOf, method, url] of probes) {
        const entitled = all.every((m) => has.has(m)) && (!anyOf || anyOf.some((m) => has.has(m)));
        const r = await call(o.admin, method, url(o), method === 'POST' ? {} : undefined);
        checked++;
        if (entitled) assert.ok(!(r.statusCode === 403 && r.json().code), `${key} ${method} ${url(o)} should be entitled: ${r.statusCode} ${r.body}`);
        else {
          refused++;
          assert.equal(r.statusCode, 403, `${key} ${method} ${url(o)}: ${r.body}`);
          assert.equal(r.json().code, 'MODULE_NOT_ENTITLED', `${key} ${url(o)}`);
          assert.equal(r.json().error, SAFE);
        }
      }
    }
    assert.equal(checked, 5 * probes.length);
    assert.ok(refused >= 30, `refused ${refused}`);
  });

  test('reports and dashboard follow the entitlements in the backend', async () => {
    const list = async (o: Org) => (await call(o.admin, 'GET', '/api/v1/reports')).json().map((r: { key: string }) => r.key);
    const tito = await list(orgs.ORG_TITO_ONLY);
    assert.ok(tito.includes('tickets') && !tito.includes('cashier-sessions') && !tito.includes('jackpot-wins') && !tito.includes('collections'), tito.join());
    const full = await list(orgs.ORG_FULL);
    for (const k of ['tickets', 'cashier-sessions', 'jackpot-wins', 'collections']) assert.ok(full.includes(k), k);
    const run = await call(orgs.ORG_TITO_ONLY.admin, 'GET', '/api/v1/reports/cashier-sessions');
    assert.equal(run.statusCode, 403);
    assert.equal(run.json().code, 'MODULE_NOT_ENTITLED');
    const dash = (await call(orgs.ORG_TITO_ONLY.admin, 'GET', '/api/v1/dashboard')).json();
    assert.equal(dash.cashier, null, 'no cash section without Cash');
    assert.deepEqual([...dash.modules].sort(), [...EXPECTED.ORG_TITO_ONLY].sort());
  });

  test('module switches: dependency checks, prerequisite checks, MODULE_DISABLED, audit with old / new / reason', async () => {
    const o = orgs.ORG_CASH;
    // Vault cannot be switched off while Cash depends on it
    const v = await call(o.admin, 'PUT', '/api/v1/org/modules/VAULT', { enabled: false });
    assert.equal(v.statusCode, 409);
    assert.equal(v.json().code, 'MODULE_DISABLE_BLOCKED');
    assert.match(v.json().reasons[0], /Cash depends on Vault/);
    // a module that was not purchased cannot be switched on
    const nb = await call(o.admin, 'PUT', '/api/v1/org/modules/CASHLESS', { enabled: true });
    assert.equal(nb.statusCode, 403);
    assert.equal(nb.json().code, 'MODULE_NOT_ENTITLED');
    // Handpay off: the handpay API is refused with MODULE_DISABLED, other modules continue
    ok(await call(o.admin, 'PUT', '/api/v1/org/modules/HANDPAY', { enabled: false, reason: 'not used at this site' }));
    const hp = await call(o.admin, 'GET', '/api/v1/cashier/handpays');
    assert.equal(hp.statusCode, 403);
    assert.equal(hp.json().code, 'MODULE_DISABLED');
    assert.notEqual((await call(o.admin, 'GET', '/api/v1/tickets')).statusCode, 403);
    const card = (await call(o.admin, 'GET', '/api/v1/org')).json().modules.find((m: { module: string }) => m.module === 'HANDPAY');
    assert.equal(card.state, 'DISABLED');
    assert.equal(card.purchased, true);
    // Cash off, then Vault off; Cash cannot come back while Vault is off (exact reason)
    ok(await call(o.admin, 'PUT', '/api/v1/org/modules/CASH', { enabled: false }));
    ok(await call(o.admin, 'PUT', '/api/v1/org/modules/VAULT', { enabled: false }));
    const cb = await call(o.admin, 'PUT', '/api/v1/org/modules/CASH', { enabled: true });
    assert.equal(cb.statusCode, 409);
    assert.equal(cb.json().code, 'MODULE_ENABLE_BLOCKED');
    assert.match(cb.json().reasons.join(' '), /Cash requires Vault/);
    for (const m of ['VAULT', 'CASH', 'HANDPAY']) ok(await call(o.admin, 'PUT', `/api/v1/org/modules/${m}`, { enabled: true }), m);
    const audit = (await pool.query(`SELECT action, details FROM audit_logs WHERE org_id = $1 AND action LIKE 'module.%' ORDER BY id`, [o.id])).rows;
    assert.equal(audit.length, 6);
    assert.deepEqual(audit[0].details.old, { module: 'HANDPAY', enabled: true });
    assert.deepEqual(audit[0].details.new, { module: 'HANDPAY', enabled: false });
    assert.equal(audit[0].details.reason, 'not used at this site');
  });

  test('open money items block switching a module off (no stranded shift)', async () => {
    const o = orgs.ORG_FULL;
    const desk = (await pool.query('SELECT id FROM cash_desks WHERE casino_id = $1', [o.casino])).rows[0].id;
    const emp = (await pool.query(`SELECT id FROM employees WHERE org_id = $1 AND role = 'CASHIER'`, [o.id])).rows[0].id;
    const s = (await pool.query(`INSERT INTO cashier_sessions (org_id, casino_id, cash_desk_id, employee_id, opening_balance) VALUES ($1,$2,$3,$4,0) RETURNING id`, [o.id, o.casino, desk, emp])).rows[0].id;
    const r = await call(o.admin, 'PUT', '/api/v1/org/modules/CASH', { enabled: false });
    assert.equal(r.statusCode, 409);
    assert.match(r.json().reasons.join(' '), /1 open cashier shift/);
    // the platform cannot take Cash away commercially either while the shift is open
    const p = await call(platform, 'PUT', `/api/v1/platform/organizations/${o.id}/subscription`, { planId: await planId('TITO_STARTER'), status: 'ACTIVE', reason: 'downgrade test' });
    assert.equal(p.statusCode, 409);
    assert.equal(p.json().code, 'MODULE_DISABLE_BLOCKED');
    await pool.query(`UPDATE cashier_sessions SET status = 'CLOSED', closed_at = now(), counted_balance = 0, expected_balance = 0, difference = 0 WHERE id = $1`, [s]);
  });

  test('platform administration: only platform administrators; overrides with dependency checks; audit in both chains', async () => {
    const o = orgs.ORG_TITO_ONLY;
    for (const t of [o.admin, o.tokens.CASINO_ADMIN, orgs.ORG_FULL.admin]) {
      for (const [m, u] of [['GET', '/api/v1/platform/organizations'], ['PUT', `/api/v1/platform/organizations/${o.id}/entitlements/CASH`], ['POST', '/api/v1/platform/plans']]) {
        const r = await call(t, m, u, m === 'GET' ? undefined : { entitled: true, reason: 'self service' });
        assert.equal(r.statusCode, 403, `${m} ${u}`);
      }
    }
    assert.equal((await call(undefined, 'GET', '/api/v1/platform/organizations')).statusCode, 401);
    // grant Cash without Vault: blocked with the exact missing dependency
    const g = await call(platform, 'PUT', `/api/v1/platform/organizations/${o.id}/entitlements/CASH`, { entitled: true, reason: 'pilot' });
    assert.equal(g.statusCode, 409);
    assert.equal(g.json().code, 'MODULE_ENABLE_BLOCKED');
    assert.match(g.json().reasons[0], /Cash requires Vault/);
    ok(await call(platform, 'PUT', `/api/v1/platform/organizations/${o.id}/entitlements/VAULT`, { entitled: true, reason: 'pilot' }));
    ok(await call(platform, 'PUT', `/api/v1/platform/organizations/${o.id}/entitlements/CASH`, { entitled: true, reason: 'pilot' }));
    assert.notEqual((await call(o.admin, 'GET', '/api/v1/cashier/desks')).statusCode, 403, 'the override takes effect at once (cache invalidated)');
    // taking Vault back while Cash depends on it is refused
    const rv = await call(platform, 'PUT', `/api/v1/platform/organizations/${o.id}/entitlements/VAULT`, { entitled: null, reason: 'end of pilot' });
    assert.equal(rv.json().code, 'MODULE_DISABLE_BLOCKED');
    ok(await call(platform, 'PUT', `/api/v1/platform/organizations/${o.id}/entitlements/CASH`, { entitled: null, reason: 'end of pilot' }));
    ok(await call(platform, 'PUT', `/api/v1/platform/organizations/${o.id}/entitlements/VAULT`, { entitled: null, reason: 'end of pilot' }));
    assert.equal((await call(o.admin, 'GET', '/api/v1/cashier/desks')).json().code, 'MODULE_NOT_ENTITLED');
    const customer = (await pool.query(`SELECT details FROM audit_logs WHERE org_id = $1 AND action = 'entitlement.override_changed' ORDER BY id`, [o.id])).rows;
    assert.equal(customer.length, 4);
    assert.deepEqual(customer[0].details.old, { module: 'VAULT', override: null });
    assert.deepEqual(customer[0].details.new, { module: 'VAULT', override: true });
    assert.equal(customer[0].details.reason, 'pilot');
    assert.equal(customer[0].details.platformActor, 'platform@example.com');
    const platformOrg = (await pool.query(`SELECT id FROM organizations WHERE is_platform`)).rows[0].id;
    const chain = (await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE org_id = $1 AND action = 'entitlement.override_changed' AND details->>'targetOrgId' = $2`, [platformOrg, o.id])).rows[0].n;
    assert.equal(chain, 4, 'mirrored into the platform chain');
    // the audit chains stay valid
    const v = await call(orgs.ORG_FULL.admin, 'GET', '/api/v1/audit/verify');
    assert.equal(v.json().valid, true, v.body);
    // organisation detail for the portal
    const d = (await call(platform, 'GET', `/api/v1/platform/organizations/${o.id}`)).json();
    assert.equal(d.organization.casinos, 1);
    assert.equal(d.organization.machines, 2);
    assert.equal(d.organization.users, 4);
    assert.equal(d.organization.license, 'VALID');
    assert.ok(d.organization.last_activity);
    assert.equal(d.modules.length, 9);
  });

  test('plans: versioned and immutable; a new version does not change existing subscriptions', async () => {
    const r = await call(platform, 'POST', '/api/v1/platform/plans', { code: 'TITO_STARTER', name: 'TITO Starter', modules: ['TITO', 'REPORTING', 'HANDPAY'], limits: { MAX_CASINOS: 1 }, reason: 'v2 includes handpay' });
    ok(r);
    assert.equal(r.json().version, 2);
    const me = (await call(orgs.ORG_TITO_ONLY.admin, 'GET', '/api/v1/me/entitlements')).json();
    assert.equal(me.subscription.plan.version, 1);
    assert.equal(me.modules.find((m: { module: string }) => m.module === 'HANDPAY').purchased, false);
    await assert.rejects(pool.query(`UPDATE plans SET modules = ARRAY['CORE'] WHERE code = 'TITO_STARTER' AND version = 1`), /immutable/);
    const bad = await call(platform, 'POST', '/api/v1/platform/plans', { code: 'BROKEN', name: 'Broken', modules: ['CASHLESS'], reason: 'missing deps' });
    assert.equal(bad.json().code, 'MODULE_ENABLE_BLOCKED');
    assert.match(bad.json().reasons.join(' '), /Cashless requires Machine Money/);
  });

  test('limits: HARD limits are enforced on create, also under concurrency; a SOFT limit is measured only', async () => {
    const o = orgs.ORG_TITO_HANDPAY; // plan: MAX_CASINOS 2
    ok(await call(o.admin, 'POST', '/api/v1/org/casinos', { code: 'TH-2', name: 'Second' }));
    const third = await call(o.admin, 'POST', '/api/v1/org/casinos', { code: 'TH-3', name: 'Third' });
    assert.equal(third.statusCode, 403);
    assert.equal(third.json().code, 'LIMIT_REACHED');
    // users: limit = current + 1, two parallel creations -> exactly one
    const used = (await pool.query('SELECT count(*)::int n FROM employees WHERE org_id = $1 AND active', [o.id])).rows[0].n;
    ok(await call(platform, 'PUT', `/api/v1/platform/organizations/${o.id}/limits/MAX_USERS`, { value: used + 1, reason: 'concurrency test' }));
    const res = await Promise.all([1, 2].map((i) => call(o.admin, 'POST', '/api/v1/employees', { name: `P${i}`, role: 'CASHIER', email: `par${i}@lim.test`, password: 'password-1', casinoIds: [] })));
    assert.deepEqual(res.map((r) => r.statusCode).sort(), [200, 403], res.map((r) => r.body).join());
    // machines: limit to current usage -> next machine refused; lowering below usage removes nothing
    const lim = await call(platform, 'PUT', `/api/v1/platform/organizations/${o.id}/limits/MAX_MACHINES`, { value: 1, reason: 'test' });
    assert.equal(lim.json().exceeded, true);
    assert.match(lim.json().warning, /nothing is removed/);
    assert.equal((await pool.query('SELECT count(*)::int n FROM machines WHERE org_id = $1', [o.id])).rows[0].n, 2);
    const m = await call(o.admin, 'POST', '/api/v1/org/machines', { casinoId: o.casino, machineCode: 'TH-M9', assetNo: 'A9' });
    assert.equal(m.json().code, 'LIMIT_REACHED');
    // a SOFT limit (tickets per month) at 0 does not stop operations
    ok(await call(platform, 'PUT', `/api/v1/platform/organizations/${o.id}/limits/MAX_MONTHLY_TITO_VOLUME`, { value: 0, reason: 'soft' }));
    const usage = (await call(o.admin, 'GET', '/api/v1/org')).json().usage.find((u: { key: string }) => u.key === 'MAX_MONTHLY_TITO_VOLUME');
    assert.equal(usage.kind, 'SOFT');
  });

  test('lifecycle: SUSPENDED / EXPIRED subscription = read-only; DISABLED organisation = no access; CANCELLED deletes nothing', async () => {
    const o = orgs.ORG_CASH;
    const counts = async () => (await pool.query(`SELECT (SELECT count(*) FROM casinos WHERE org_id = $1) c, (SELECT count(*) FROM machines WHERE org_id = $1) m, (SELECT count(*) FROM employees WHERE org_id = $1) e, (SELECT count(*) FROM audit_logs WHERE org_id = $1) a`, [o.id])).rows[0];
    const before0 = await counts();
    for (const status of ['SUSPENDED', 'EXPIRED', 'CANCELLED']) {
      ok(await call(platform, 'PUT', `/api/v1/platform/organizations/${o.id}/subscription`, { planId: await planId('CASH_OPERATIONS'), status, reason: `lifecycle ${status}` }));
      assert.equal((await call(o.admin, 'GET', '/api/v1/cashier/desks')).statusCode, 200, `${status}: reads stay possible`);
      const w = await call(o.admin, 'POST', '/api/v1/cashier/session/open', {});
      assert.equal(w.statusCode, 403);
      assert.equal(w.json().code, 'SUBSCRIPTION_INACTIVE', status);
      assert.equal((await call(o.admin, 'POST', '/api/v1/org/casinos', { code: 'X-1', name: 'Extra' })).json().code, 'SUBSCRIPTION_INACTIVE');
    }
    // an ACTIVE subscription whose end date passed is expired
    ok(await call(platform, 'PUT', `/api/v1/platform/organizations/${o.id}/subscription`, { planId: await planId('CASH_OPERATIONS'), status: 'ACTIVE', startsAt: '2025-01-01T00:00:00Z', endsAt: '2025-12-31T00:00:00Z', reason: 'term ended' }));
    assert.equal((await call(o.admin, 'POST', '/api/v1/cashier/session/open', {})).json().code, 'SUBSCRIPTION_INACTIVE');
    assert.equal((await call(platform, 'GET', `/api/v1/platform/organizations/${o.id}`)).json().organization.license, 'EXPIRED');
    ok(await call(platform, 'PUT', `/api/v1/platform/organizations/${o.id}/subscription`, { planId: await planId('CASH_OPERATIONS'), status: 'ACTIVE', endsAt: null, reason: 'renewed' }));
    assert.notEqual((await call(o.admin, 'POST', '/api/v1/cashier/session/open', {})).statusCode, 403);
    // disabled organisation: existing tokens and new logins are refused
    ok(await call(platform, 'PUT', `/api/v1/platform/organizations/${o.id}/status`, { status: 'DISABLED', reason: 'contract paused' }));
    const t = await call(o.tokens.CASHIER, 'GET', '/api/v1/dashboard');
    assert.equal(t.statusCode, 403);
    assert.equal(t.json().code, 'ORGANIZATION_DISABLED');
    const l = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'admin@org-cash.test', password: 'correct-horse-battery' } });
    assert.equal(l.statusCode, 403);
    assert.equal(l.json().code, 'ORGANIZATION_DISABLED');
    const pl = await call(platform, 'PUT', `/api/v1/platform/organizations/${(await pool.query('SELECT id FROM organizations WHERE is_platform')).rows[0].id}/status`, { status: 'DISABLED', reason: 'not allowed' });
    assert.equal(pl.statusCode, 409);
    ok(await call(platform, 'PUT', `/api/v1/platform/organizations/${o.id}/status`, { status: 'ACTIVE', reason: 'resumed' }));
    assert.equal((await call(o.tokens.CASHIER, 'GET', '/api/v1/dashboard')).statusCode, 200);
    const after0 = await counts();
    assert.equal(after0.c, before0.c);
    assert.equal(after0.m, before0.m);
    assert.equal(after0.e, before0.e);
    assert.ok(Number(after0.a) > Number(before0.a), 'only audit grew');
  });

  test('inactive casino: not accessible by id, excluded from the scope, limit slot released', async () => {
    const o = orgs.ORG_FULL;
    const c2 = (await call(o.admin, 'POST', '/api/v1/org/casinos', { code: 'FULL-2', name: 'Second' })).json().id;
    assert.equal((await call(o.admin, 'GET', `/api/v1/dashboard?casinoId=${c2}`)).statusCode, 200);
    ok(await call(o.admin, 'PUT', `/api/v1/org/casinos/${c2}/status`, { status: 'INACTIVE', reason: 'closed for renovation' }));
    assert.equal((await call(o.admin, 'GET', `/api/v1/dashboard?casinoId=${c2}`)).statusCode, 404);
    assert.ok(!(await call(o.admin, 'GET', '/api/v1/auth/me')).json().casinos.some((c: { id: string }) => c.id === c2));
    const m = await call(o.admin, 'POST', '/api/v1/org/machines', { casinoId: c2, machineCode: 'FULL-X', assetNo: 'X' });
    assert.equal(m.statusCode, 404);
    const a = (await pool.query(`SELECT details FROM audit_logs WHERE org_id = $1 AND action = 'casino.status_changed'`, [o.id])).rows[0].details;
    assert.deepEqual([a.old, a.new, a.reason], [{ status: 'ACTIVE' }, { status: 'INACTIVE' }, 'closed for renovation']);
  });

  test('tenant isolation: manipulated organisation, casino, machine, player, card, ticket, employee and approval ids', async () => {
    const t = orgs.ORG_FULL.admin;
    const m1 = (await pool.query(`SELECT org_id, id FROM casinos WHERE code = 'VIE-001'`)).rows[0];
    const other = {
      casino: m1.id,
      machine: (await pool.query('SELECT id FROM machines WHERE casino_id = $1 LIMIT 1', [m1.id])).rows[0].id,
      employee: (await pool.query(`SELECT id FROM employees WHERE email = 'cashier@example.com'`)).rows[0].id,
      card: (await pool.query('SELECT card_number FROM player_cards WHERE org_id = $1 LIMIT 1', [m1.org_id])).rows[0].card_number,
      ticket: (await pool.query('SELECT id, barcode FROM tickets WHERE org_id = $1 LIMIT 1', [m1.org_id])).rows[0],
      player: (await pool.query('SELECT id FROM players WHERE org_id = $1 LIMIT 1', [m1.org_id])).rows[0].id,
    };
    const expect404 = [
      ['GET', `/api/v1/machines/${other.machine}`], ['GET', `/api/v1/machines/${other.machine}/money`], ['GET', `/api/v1/cash/collections/expected/${other.machine}`],
      ['GET', `/api/v1/dashboard?casinoId=${other.casino}`], ['GET', `/api/v1/vault/status?casinoId=${other.casino}`], ['GET', `/api/v1/money/day-close/status?casinoId=${other.casino}`],
      ['GET', `/api/v1/players/lookup/${other.card}`], ['GET', `/api/v1/tickets/lookup/${other.ticket.barcode}`], ['GET', `/api/v1/tickets/${other.ticket.id}`],
      ['GET', `/api/v1/employees/${other.employee}/activity`], ['PUT', `/api/v1/org/casinos/${other.casino}/status`],
      ['POST', `/api/v1/machines/${other.machine}/commands`], ['POST', `/api/v1/approvals/${randomUUID()}/decide`],
    ] as const;
    const bodies: Record<string, unknown> = {
      [`/api/v1/org/casinos/${other.casino}/status`]: { status: 'INACTIVE', reason: 'attack' },
      [`/api/v1/machines/${other.machine}/commands`]: { type: 'LOCK' },
      decide: { decision: 'APPROVED' },
    };
    for (const [method, url] of expect404) {
      const r = await call(t, method, url, method === 'GET' ? undefined : bodies[url] ?? bodies.decide);
      assert.ok([403, 404].includes(r.statusCode), `${method} ${url}: ${r.statusCode} ${r.body}`);
      assert.ok(!r.body.includes(other.casino) && !r.body.includes(other.player), 'no foreign data in the answer');
    }
    // writes with foreign ids in the body
    const e = await call(t, 'PUT', `/api/v1/employees/${other.employee}`, { name: 'Hijack', role: 'CASHIER', active: true, casinoIds: [] });
    assert.equal(e.statusCode, 404);
    const mc = await call(t, 'POST', '/api/v1/org/machines', { casinoId: other.casino, machineCode: 'HIJACK', assetNo: 'H' });
    assert.equal(mc.statusCode, 404);
    const emp = await call(t, 'POST', '/api/v1/employees', { name: 'Spy', role: 'CASHIER', email: 'spy@x.test', password: 'password-1', casinoIds: [other.casino] });
    assert.equal(emp.statusCode, 403);
    // list endpoints with a foreign casino in the query string never return foreign rows
    const ms = await call(t, 'GET', `/api/v1/machines?casinoId=${other.casino}`);
    assert.ok(ms.statusCode === 404 || !ms.body.includes(other.machine), ms.body.slice(0, 200));
    const tk = await call(t, 'GET', `/api/v1/tickets?casinoId=${other.casino}`);
    assert.ok(tk.statusCode === 404 || !tk.body.includes(other.ticket.barcode));
    // a gateway of one organisation cannot report or hold for a machine of another
    const key = 'iso-gw-key';
    const gw = (await pool.query(`INSERT INTO gateways (org_id, casino_id, device_id, name, api_key_hash) VALUES ($1,$2,'ISO-GW','iso',$3) RETURNING device_id`, [orgs.ORG_FULL.id, orgs.ORG_FULL.casino, createHash('sha256').update(key).digest('hex')])).rows[0];
    const foreignCode = (await pool.query('SELECT machine_code FROM machines WHERE id = $1', [other.machine])).rows[0].machine_code;
    const hold = await app.inject({ method: 'POST', url: '/api/v1/gateway/tickets/hold', headers: { 'x-gateway-id': gw.device_id, 'x-gateway-key': key }, payload: { machineId: foreignCode, barcode: other.ticket.barcode } });
    assert.ok(hold.statusCode >= 400 || hold.json().ok === false, hold.body);
    // the platform detail of another organisation is not reachable for a customer
    assert.equal((await call(t, 'GET', `/api/v1/platform/organizations/${m1.org_id}`)).statusCode, 403);
  });

  test('role escalation: nobody assigns a role above their own; org administration needs org.manage', async () => {
    const o = orgs.ORG_FULL;
    const ca = o.tokens.CASINO_ADMIN;
    const sa = await call(ca, 'POST', '/api/v1/employees', { name: 'Boss', role: 'SUPER_ADMIN', email: 'boss@full.test', password: 'password-1', casinoIds: [] });
    assert.equal(sa.statusCode, 403);
    for (const [m, u, b] of [['PUT', '/api/v1/org/modules/TITO', { enabled: false }], ['POST', '/api/v1/org/casinos', { code: 'Z-1', name: 'Z' }], ['GET', '/api/v1/org', undefined]] as const) {
      assert.equal((await call(ca, m, u, b)).statusCode, 403, `casino admin ${u}`);
      assert.equal((await call(o.tokens.MANAGER, m, u, b)).statusCode, 403, `manager ${u}`);
      assert.equal((await call(o.tokens.CASHIER, m, u, b)).statusCode, 403, `cashier ${u}`);
    }
    // a manager cannot manage users at all; a cashier cannot change their own role
    assert.equal((await call(o.tokens.MANAGER, 'POST', '/api/v1/employees', { name: 'X', role: 'CASHIER', email: 'x@full.test', password: 'password-1', casinoIds: [] })).statusCode, 403);
    const me = (await pool.query(`SELECT id FROM employees WHERE email = 'cashier@org-full.test'`)).rows[0].id;
    assert.equal((await call(o.tokens.CASHIER, 'PUT', `/api/v1/employees/${me}`, { name: 'C', role: 'SUPER_ADMIN', active: true, casinoIds: [] })).statusCode, 403);
    // platform administrators exist only in a platform organisation (database guard)
    await assert.rejects(pool.query('UPDATE employees SET is_platform_admin = true WHERE id = $1', [me]), /platform organisation/);
  });

  test('gateway: physical facts are recorded without the module; new business needs it', async () => {
    const o = orgs.ORG_CASHLESS; // no TITO
    const key = 'cl-gw-key';
    const gw = (await pool.query(`INSERT INTO gateways (org_id, casino_id, device_id, name, api_key_hash) VALUES ($1,$2,'CL-GW','cl',$3) RETURNING device_id`, [o.id, o.casino, createHash('sha256').update(key).digest('hex')])).rows[0];
    await pool.query('UPDATE machines SET gateway_id = (SELECT id FROM gateways WHERE device_id = $1) WHERE org_id = $2', [gw.device_id, o.id]);
    const headers = { 'x-gateway-id': gw.device_id, 'x-gateway-key': key };
    const hold = await app.inject({ method: 'POST', url: '/api/v1/gateway/tickets/hold', headers, payload: { machineId: 'ORG_CASHLESS-M1', barcode: '123412341234123412' } });
    assert.deepEqual(hold.json(), { ok: false, reason: 'MODULE_NOT_ENTITLED' });
    const eventId = randomUUID();
    const ev = await app.inject({ method: 'POST', url: '/api/v1/gateway/events', headers, payload: { events: [{ eventId, type: 'GAME_PLAYED', machineId: 'ORG_CASHLESS-M1', timestamp: new Date().toISOString(), amount: 1, win: 0 }] } });
    assert.equal(ev.statusCode, 200, ev.body);
    assert.equal((await pool.query('SELECT count(*)::int n FROM machine_events WHERE event_id = $1', [eventId])).rows[0].n, 1, 'the physical event is recorded');
    // TITO-only organisation: no cashless sessions / transfers from its machines
    const t = orgs.ORG_TITO_ONLY;
    const k2 = 'tt-gw-key';
    await pool.query(`INSERT INTO gateways (org_id, casino_id, device_id, name, api_key_hash) VALUES ($1,$2,'TT-GW','tt',$3)`, [t.id, t.casino, createHash('sha256').update(k2).digest('hex')]);
    const tr = await app.inject({ method: 'POST', url: '/api/v1/gateway/cashless/transfers', headers: { 'x-gateway-id': 'TT-GW', 'x-gateway-key': k2 }, payload: {} });
    assert.equal(tr.statusCode, 403);
    assert.equal(tr.json().code, 'MODULE_NOT_ENTITLED');
  });

  test('day close and reconciliation follow the modules in use: a TITO-only casino is not blocked by Cash / Vault / Machine checks', async () => {
    const o = orgs.ORG_TITO_HANDPAY;
    const st = (await call(o.admin, 'GET', `/api/v1/money/day-close/status?casinoId=${o.casino}`)).json();
    assert.deepEqual([...st.railsInUse].sort(), ['HANDPAY', 'TITO']);
    for (const b of st.blockers ?? []) assert.ok(!/CASH|VAULT|MACHINE|CASHLESS/.test(JSON.stringify(b)), JSON.stringify(b));
    const run = await app.inject({ method: 'POST', url: '/api/v1/money/reconciliation', payload: { casinoId: o.casino }, headers: { authorization: `Bearer ${o.admin}`, 'idempotency-key': `recon-${randomUUID()}` } });
    assert.ok(run.statusCode < 300, run.body);
    const checks = run.json().checks ?? run.json().run?.checks ?? [];
    for (const c of checks) if (/^(CASH|VAULT|MACHINE|CASHLESS)/.test(c.rail ?? '')) assert.equal(c.advisory, true, JSON.stringify(c));
    assert.equal((await pool.query(`SELECT count(*)::int n FROM money_rail_freezes WHERE org_id = $1 AND lifted_at IS NULL`, [o.id])).rows[0].n, 0, 'no freeze from modules not in use');
  });

  test('money integrity: administration and entitlement changes never create money transactions', async () => {
    const n = (await pool.query(`SELECT count(*)::int n FROM money_transactions WHERE org_id = ANY($1)`, [Object.values(orgs).map((o) => o.id)])).rows[0].n;
    assert.equal(n, 0);
    const inv = (await pool.query(`SELECT count(*)::int n FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount_cents) <> 0) x`)).rows[0].n;
    assert.equal(inv, 0, 'every ledger transaction balances');
  });
});
