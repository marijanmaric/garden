import type { PoolClient } from '@m1/database';
import {
  ENTITLEMENT_ERRORS, FEATURES, LIMIT_DEFS, LIMIT_KEYS, PRODUCT_MODULE_DEFS, evaluateModules, featureAvailable, subscriptionUsable,
  type Feature, type LimitKey, type ModuleStatus, type ProductModule, type SubscriptionStatus,
} from '@m1/shared';
import { HttpError } from '../auth';
import { pool } from '../db';

/**
 * The one authoritative entitlement service. Every route declares its feature (route config); the route guard
 * calls requireFeature after authentication, tenant and role checks and before any business rule or money
 * service. Commercial state (purchased / enabled / subscription) is evaluated here only; the operational rail
 * state (LEGACY / LEDGER / frozen) stays with the money service and is merely reported next to it.
 */
type Db = Pick<PoolClient, 'query'>;

export interface OrgEntitlements {
  orgId: string;
  orgName: string;
  orgStatus: 'ACTIVE' | 'DISABLED';
  isPlatform: boolean;
  subscription: null | {
    status: SubscriptionStatus; startsAt: string; endsAt: string | null; usable: boolean;
    plan: { id: string; code: string; name: string; version: number; modules: string[]; limits: Record<string, number> };
  };
  modules: ModuleStatus[];
  /** Modules usable right now. */
  effective: Set<ProductModule>;
  /** Purchased + enabled + dependencies (ignoring the subscription): readable history, in-use for reconciliation. */
  inUse: Set<ProductModule>;
  limits: Record<LimitKey, { value: number | null; source: 'PLAN' | 'OVERRIDE' | 'NONE' }>;
  loadedAt: number;
}

export class EntitlementError extends HttpError {
  constructor(public code: keyof typeof ENTITLEMENT_ERRORS, detail?: string, status = 403) {
    super(status, ENTITLEMENT_ERRORS[code] + (detail ? ` ${detail}` : ''));
    this.body = { code };
  }
}

const TTL_MS = 5_000;
const cache = new Map<string, OrgEntitlements>();

/** Called after every change of a subscription, plan assignment, override, switch or organisation status. */
export function invalidateEntitlements(orgId?: string) {
  if (orgId) cache.delete(orgId);
  else cache.clear();
}

export async function loadEntitlements(orgId: string, db: Db = pool, fresh = false): Promise<OrgEntitlements> {
  const hit = cache.get(orgId);
  if (!fresh && hit && Date.now() - hit.loadedAt < TTL_MS) return hit;
  const [org, sub, overrides, settings, limitOverrides] = await Promise.all([
    db.query('SELECT id, name, status, is_platform FROM organizations WHERE id = $1', [orgId]),
    db.query(
      `SELECT s.status, s.starts_at, s.ends_at, p.id AS plan_id, p.code, p.name, p.version, p.modules, p.limits
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.org_id = $1`, [orgId]),
    db.query('SELECT module_key, entitled FROM entitlement_overrides WHERE org_id = $1', [orgId]),
    db.query('SELECT module_key FROM org_module_settings WHERE org_id = $1 AND NOT enabled', [orgId]),
    db.query('SELECT limit_key, value FROM limit_overrides WHERE org_id = $1', [orgId]),
  ]);
  if (!org.rowCount) throw new HttpError(404, 'Organisation not found');
  const s = sub.rows[0];
  const usable = !!s && subscriptionUsable(s.status, s.ends_at) && org.rows[0].status === 'ACTIVE';
  const ov = Object.fromEntries(overrides.rows.map((r) => [r.module_key, r.entitled]));
  const disabled = settings.rows.map((r) => r.module_key);
  const planModules: string[] = s?.modules ?? ['CORE'];
  const modules = evaluateModules({ planModules, overrides: ov, disabled, subscriptionUsable: usable });
  const inUse = new Set(evaluateModules({ planModules, overrides: ov, disabled, subscriptionUsable: true }).filter((m) => m.effective).map((m) => m.module));
  const planLimits: Record<string, number> = s?.limits ?? {};
  const lo = Object.fromEntries(limitOverrides.rows.map((r) => [r.limit_key, r.value === null ? null : Number(r.value)]));
  const limits = Object.fromEntries(LIMIT_KEYS.map((k) => [k,
    k in lo ? { value: lo[k], source: 'OVERRIDE' as const } : k in planLimits ? { value: Number(planLimits[k]), source: 'PLAN' as const } : { value: null, source: 'NONE' as const }]),
  ) as OrgEntitlements['limits'];
  const e: OrgEntitlements = {
    orgId, orgName: org.rows[0].name, orgStatus: org.rows[0].status, isPlatform: org.rows[0].is_platform,
    subscription: s ? {
      status: s.status, startsAt: s.starts_at, endsAt: s.ends_at, usable,
      plan: { id: s.plan_id, code: s.code, name: s.name, version: s.version, modules: s.modules, limits: s.limits },
    } : null,
    modules, effective: new Set(modules.filter((m) => m.effective).map((m) => m.module)), inUse, limits, loadedAt: Date.now(),
  };
  cache.set(orgId, e);
  return e;
}

export const can = (e: OrgEntitlements, feature: Feature) => featureAvailable(feature, e.effective);
export const canModule = (e: OrgEntitlements, m: ProductModule) => e.effective.has(m);

/**
 * Throws the deterministic entitlement error for a feature. Reads (GET) of purchased, enabled modules stay
 * possible when the subscription is inactive (historical data is never taken away).
 */
export function requireFeature(e: OrgEntitlements, feature: Feature, opts: { read?: boolean } = {}) {
  if (featureAvailable(feature, e.effective)) return;
  if (opts.read && featureAvailable(feature, e.inUse)) return;
  const f = FEATURES[feature] as { modules: readonly ProductModule[]; anyOf?: readonly ProductModule[] };
  const needed = [...f.modules, ...(f.anyOf && !f.anyOf.some((m) => e.effective.has(m)) ? [f.anyOf[0]] : [])];
  const st = (m: ProductModule) => e.modules.find((x) => x.module === m)!;
  const blocking = needed.map(st).find((x) => !x.effective);
  if (featureAvailable(feature, e.inUse)) throw new EntitlementError('SUBSCRIPTION_INACTIVE');
  if (blocking?.state === 'DISABLED') throw new EntitlementError('MODULE_DISABLED', `(${PRODUCT_MODULE_DEFS[blocking.module].name})`);
  throw new EntitlementError('MODULE_NOT_ENTITLED');
}

export function requireModule(e: OrgEntitlements, m: ProductModule) {
  if (e.effective.has(m)) return;
  const st = e.modules.find((x) => x.module === m)!;
  if (st.purchased && st.enabled && !st.missing.length) throw new EntitlementError('SUBSCRIPTION_INACTIVE');
  throw new EntitlementError(st.state === 'DISABLED' ? 'MODULE_DISABLED' : 'MODULE_NOT_ENTITLED', `(${PRODUCT_MODULE_DEFS[m].name})`);
}

// ---- limits ----------------------------------------------------------------------------------------

const USAGE_SQL: Record<LimitKey, string> = {
  MAX_CASINOS: `SELECT count(*)::int n FROM casinos WHERE org_id = $1 AND status = 'ACTIVE'`,
  MAX_MACHINES: `SELECT count(*)::int n FROM machines m JOIN casinos c ON c.id = m.casino_id WHERE m.org_id = $1 AND c.status = 'ACTIVE'`,
  MAX_USERS: `SELECT count(*)::int n FROM employees WHERE org_id = $1 AND active`,
  MAX_PLAYERS: `SELECT count(*)::int n FROM players WHERE org_id = $1 AND status <> 'CLOSED'`,
  MAX_WALLETS: `SELECT count(*)::int n FROM wallets WHERE org_id = $1 AND status <> 'CLOSED'`,
  MAX_CASHLESS_PLAYERS: `SELECT count(DISTINCT player_id)::int n FROM wallet_transfers WHERE org_id = $1 AND requested_at >= date_trunc('month', now())`,
  MAX_MONTHLY_TITO_VOLUME: `SELECT count(*)::int n FROM tickets WHERE org_id = $1 AND issued_at >= date_trunc('month', now())`,
  MAX_MONTHLY_HANDPAYS: `SELECT count(*)::int n FROM handpays WHERE org_id = $1 AND created_at >= date_trunc('month', now())`,
};

export async function limitUsage(db: Db, orgId: string, key: LimitKey): Promise<number> {
  return (await db.query(USAGE_SQL[key], [orgId])).rows[0].n;
}

export async function usageReport(db: Db, e: OrgEntitlements) {
  return Promise.all(LIMIT_KEYS.map(async (k) => {
    const used = await limitUsage(db, e.orgId, k);
    const l = e.limits[k];
    return { key: k, ...LIMIT_DEFS[k], value: l.value, source: l.source, used, available: l.value === null ? null : Math.max(0, l.value - used), exceeded: l.value !== null && used > l.value };
  }));
}

/**
 * HARD limit check inside the creating transaction. A transaction-scoped advisory lock per organisation and
 * limit serialises concurrent creations, so two parallel requests cannot both take the last slot.
 */
export async function requireLimit(db: Db, orgId: string, key: LimitKey, adding = 1) {
  if (LIMIT_DEFS[key].kind !== 'HARD') return;
  const e = await loadEntitlements(orgId, db, true);
  // growth (casinos, machines, users, players) needs a usable subscription; Core operation itself continues
  if (!e.subscription?.usable) throw new EntitlementError('SUBSCRIPTION_INACTIVE');
  const max = e.limits[key].value;
  if (max === null) return;
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`limit:${orgId}:${key}`]);
  const used = await limitUsage(db, orgId, key);
  if (used + adding > max) throw new EntitlementError('LIMIT_REACHED', `(${LIMIT_DEFS[key].label}: ${used} of ${max})`);
}

/**
 * The client view of the entitlements (GET /me and /me/entitlements): module states, the features available
 * now and the ones readable (inactive subscription), the plan and the subscription. Org-bound: the web app
 * refreshes it with every login / organisation change and never shares it across organisations.
 */
export function entitlementView(e: OrgEntitlements) {
  const features = (Object.keys(FEATURES) as Feature[]).filter((f) => featureAvailable(f, e.effective));
  const readable = (Object.keys(FEATURES) as Feature[]).filter((f) => featureAvailable(f, e.inUse));
  return {
    orgId: e.orgId, orgName: e.orgName, orgStatus: e.orgStatus, isPlatform: e.isPlatform,
    subscription: e.subscription && { status: e.subscription.status, startsAt: e.subscription.startsAt, endsAt: e.subscription.endsAt, usable: e.subscription.usable,
      plan: { code: e.subscription.plan.code, name: e.subscription.plan.name, version: e.subscription.plan.version } },
    modules: e.modules.map((m) => ({ ...m, name: PRODUCT_MODULE_DEFS[m.module].name })),
    features, readable,
  };
}
