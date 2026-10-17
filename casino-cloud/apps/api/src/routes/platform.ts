import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction, type PoolClient } from '@m1/database';
import {
  LIMIT_DEFS, LIMIT_KEYS, PRODUCT_MODULES, PRODUCT_MODULE_DEFS, SUBSCRIPTION_STATUSES, evaluateModules,
  type LimitKey, type ProductModule,
} from '@m1/shared';
import { HttpError, guard } from '../auth';
import { pool } from '../db';
import { entitlementView, invalidateEntitlements, loadEntitlements, requireLimit, usageReport } from '../services/entitlements';
import {
  auditChange, blocked, createCasino, createMachine, disableBlockers, moduleCards, orgSummaries, setCasinoStatus, setModuleEnabled, type AdminActor,
} from '../services/org-admin';
import { runCutover } from '../services/cutover';
import { adminActor, casinoSchema, machineSchema, statusSchema } from './org';

const reason = z.string().trim().min(3).max(500);
const uuid = z.object({ id: z.string().uuid() });
const P = { config: { feature: 'platform' as const }, preHandler: guard('org.manage') };

async function customerOrg(db: Pick<PoolClient, 'query'>, id: string, lock = false) {
  const o = (await db.query(`SELECT id, name, status, is_platform FROM organizations WHERE id = $1${lock ? ' FOR NO KEY UPDATE' : ''}`, [id])).rows[0];
  if (!o) throw new HttpError(404, 'Organisation not found');
  return o;
}

/**
 * Modules that a commercial change (plan, subscription, override) takes away from what the organisation uses
 * now must not strand money: each needs the same open-item check as switching the module off.
 */
async function checkRemovals(db: PoolClient, orgId: string, after: Set<ProductModule>) {
  const e = await loadEntitlements(orgId, db, true);
  const removed = [...e.inUse].filter((m) => !after.has(m));
  const reasons: string[] = [];
  for (const m of removed) {
    const b = (await disableBlockers(db, { ...e, inUse: after }, m)).filter((r) => !r.includes('depend'));
    reasons.push(...b.map((r) => `${PRODUCT_MODULE_DEFS[m].name}: ${r}`));
  }
  if (reasons.length) throw blocked('MODULE_DISABLE_BLOCKED', reasons);
  return removed;
}

async function inUseAfter(db: PoolClient, orgId: string, change: { planModules?: string[]; overrides?: Record<string, boolean | null> }) {
  const [sub, ov, off] = await Promise.all([
    db.query('SELECT p.modules FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.org_id = $1', [orgId]),
    db.query('SELECT module_key, entitled FROM entitlement_overrides WHERE org_id = $1', [orgId]),
    db.query('SELECT module_key FROM org_module_settings WHERE org_id = $1 AND NOT enabled', [orgId]),
  ]);
  const overrides: Record<string, boolean> = Object.fromEntries(ov.rows.map((r) => [r.module_key, r.entitled]));
  for (const [k, v] of Object.entries(change.overrides ?? {})) if (v === null) delete overrides[k]; else overrides[k] = v;
  const planModules = change.planModules ?? sub.rows[0]?.modules ?? ['CORE'];
  return new Set(evaluateModules({ planModules, overrides, disabled: off.rows.map((r) => r.module_key), subscriptionUsable: true }).filter((m) => m.effective).map((m) => m.module));
}

/**
 * Platform administration (platform administrators only): organisations and their lifecycle, plans,
 * subscriptions, entitlement and limit overrides, onboarding. Every change is audited with old value, new
 * value and reason in the customer's chain and in the platform chain. No billing: price fields are metadata.
 */
export async function platformRoutes(app: FastifyInstance) {
  app.get('/api/v1/platform/registry', P, async () => ({
    modules: PRODUCT_MODULES.map((m) => ({ ...PRODUCT_MODULE_DEFS[m] })),
    limits: LIMIT_KEYS.map((k) => ({ key: k, ...LIMIT_DEFS[k] })),
    subscriptionStatuses: SUBSCRIPTION_STATUSES,
  }));

  app.get('/api/v1/platform/organizations', P, async () => ({ organizations: await orgSummaries(pool) }));

  app.get('/api/v1/platform/organizations/:id', P, async (req) => {
    const { id } = uuid.parse(req.params);
    await customerOrg(pool, id);
    const e = await loadEntitlements(id, pool, true);
    const [summary, modules, usage, overrides, limitOverrides, sub] = await Promise.all([
      orgSummaries(pool, [id]),
      moduleCards(pool, e),
      usageReport(pool, e),
      pool.query('SELECT module_key, entitled, reason, created_at FROM entitlement_overrides WHERE org_id = $1 ORDER BY module_key', [id]),
      pool.query('SELECT limit_key, value, reason, created_at FROM limit_overrides WHERE org_id = $1 ORDER BY limit_key', [id]),
      pool.query('SELECT s.*, p.code, p.name AS plan_name, p.version FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.org_id = $1', [id]),
    ]);
    return { organization: summary[0], entitlements: entitlementView(e), modules, usage, overrides: overrides.rows, limitOverrides: limitOverrides.rows, subscription: sub.rows[0] ?? null };
  });

  /** Onboarding step 1-2: organisation, subscription (plan) and its first admin user in one transaction. */
  app.post('/api/v1/platform/organizations', P, async (req) => {
    const body = z.object({
      name: z.string().trim().min(2).max(120), slug: z.string().trim().toLowerCase().min(2).max(60).regex(/^[a-z0-9-]+$/),
      planId: z.string().uuid(), status: z.enum(['TRIAL', 'ACTIVE']).default('ACTIVE'), endsAt: z.string().datetime().nullable().optional(),
      admin: z.object({ name: z.string().trim().min(2).max(100), email: z.string().trim().toLowerCase().email(), password: z.string().min(12).max(200) }),
      note: z.string().trim().max(500).optional(),
    }).parse(req.body);
    const a = adminActor(req);
    const out = await withTransaction(pool, async (db) => {
      const plan = (await db.query('SELECT id, code, version, active FROM plans WHERE id = $1', [body.planId])).rows[0];
      if (!plan?.active) throw new HttpError(422, 'Plan not found or no longer offered');
      let orgId: string;
      try {
        orgId = (await db.query('INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id', [body.name, body.slug])).rows[0].id;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'Slug already in use');
        throw err;
      }
      await db.query(`INSERT INTO subscriptions (org_id, plan_id, status, ends_at, note, updated_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [orgId, plan.id, body.status, body.endsAt ?? null, body.note ?? null, a.employeeId]);
      let adminId: string;
      try {
        adminId = (await db.query(`INSERT INTO employees (org_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,'SUPER_ADMIN') RETURNING id`,
          [orgId, body.admin.email, body.admin.name, await bcrypt.hash(body.admin.password, 10)])).rows[0].id;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'Email already in use');
        throw err;
      }
      await auditChange(db, a, orgId, { action: 'organization.created', entityType: 'organization', entityId: orgId, old: null,
        new: { name: body.name, slug: body.slug, plan: `${plan.code} v${plan.version}`, status: body.status, endsAt: body.endsAt ?? null, admin: body.admin.email }, reason: body.note });
      return { id: orgId, adminId };
    });
    // the organisation-wide cashless rail starts on the ledger like on a fresh install (no wallet, no money)
    await runCutover(pool, { orgId: out.id }, { rail: 'CASHLESS' });
    invalidateEntitlements(out.id);
    return out;
  });

  app.put('/api/v1/platform/organizations/:id/status', P, async (req) => {
    const { id } = uuid.parse(req.params);
    const body = z.object({ status: z.enum(['ACTIVE', 'DISABLED']), reason }).parse(req.body);
    return withTransaction(pool, async (db) => {
      const o = await customerOrg(db, id, true);
      if (o.is_platform) throw new HttpError(409, 'The platform organisation cannot be disabled');
      if (o.status === body.status) return { id, status: o.status, changed: false };
      await db.query('UPDATE organizations SET status = $2, status_reason = $3, updated_at = now() WHERE id = $1', [id, body.status, body.reason]);
      await auditChange(db, adminActor(req), id, { action: 'organization.status_changed', entityType: 'organization', entityId: id, old: { status: o.status }, new: { status: body.status }, reason: body.reason });
      invalidateEntitlements(id);
      return { id, status: body.status, changed: true };
    });
  });

  app.put('/api/v1/platform/organizations/:id/subscription', P, async (req) => {
    const { id } = uuid.parse(req.params);
    const body = z.object({
      planId: z.string().uuid(), status: z.enum(SUBSCRIPTION_STATUSES), startsAt: z.string().datetime().optional(),
      endsAt: z.string().datetime().nullable().optional(), reason,
    }).parse(req.body);
    return withTransaction(pool, async (db) => {
      await customerOrg(db, id, true);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`entitlements:${id}`]);
      const plan = (await db.query('SELECT id, code, version, modules, limits FROM plans WHERE id = $1', [body.planId])).rows[0];
      if (!plan) throw new HttpError(404, 'Plan not found');
      const old = (await db.query('SELECT s.plan_id, s.status, s.starts_at, s.ends_at, p.code, p.version FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.org_id = $1', [id])).rows[0];
      if (body.endsAt && new Date(body.endsAt) <= new Date(body.startsAt ?? old?.starts_at ?? Date.now())) throw new HttpError(422, 'The end must be after the start');
      const removed = await checkRemovals(db, id, await inUseAfter(db, id, { planModules: plan.modules }));
      await db.query(
        `INSERT INTO subscriptions (org_id, plan_id, status, starts_at, ends_at, updated_by) VALUES ($1,$2,$3,COALESCE($4::timestamptz, now()),$5,$6)
         ON CONFLICT (org_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = EXCLUDED.status, starts_at = COALESCE($4::timestamptz, subscriptions.starts_at),
           ends_at = EXCLUDED.ends_at, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [id, plan.id, body.status, body.startsAt ?? null, body.endsAt ?? null, req.auth.sub],
      );
      await auditChange(db, adminActor(req), id, {
        action: 'subscription.changed', entityType: 'subscription', entityId: id,
        old: old ? { plan: `${old.code} v${old.version}`, status: old.status, startsAt: old.starts_at, endsAt: old.ends_at } : null,
        new: { plan: `${plan.code} v${plan.version}`, status: body.status, startsAt: body.startsAt ?? old?.starts_at ?? null, endsAt: body.endsAt ?? null },
        reason: body.reason, extra: { modulesRemoved: removed },
      });
      invalidateEntitlements(id);
      return { id, plan: plan.code, version: plan.version, status: body.status };
    });
  });

  /** Entitlement override: true grants, false withholds against the plan, null returns to the plan. */
  app.put('/api/v1/platform/organizations/:id/entitlements/:module', P, async (req) => {
    const { id, module } = z.object({ id: z.string().uuid(), module: z.enum(PRODUCT_MODULES) }).parse(req.params);
    const body = z.object({ entitled: z.boolean().nullable(), reason }).parse(req.body);
    if (module === 'CORE') throw new HttpError(422, 'Core is always included');
    return withTransaction(pool, async (db) => {
      await customerOrg(db, id, true);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`entitlements:${id}`]);
      const e = await loadEntitlements(id, db, true);
      const purchasedAfter = (() => {
        const planHas = e.subscription?.plan.modules.includes(module) ?? false;
        return body.entitled === null ? planHas : body.entitled;
      })();
      if (purchasedAfter) {
        // dependencies must be purchased too: the exact missing ones are named
        const deps = PRODUCT_MODULE_DEFS[module].requires.filter((d) => d !== 'CORE' && !e.modules.find((x) => x.module === d)!.purchased);
        if (deps.length) throw blocked('MODULE_ENABLE_BLOCKED', [`${PRODUCT_MODULE_DEFS[module].name} requires ${deps.map((d) => PRODUCT_MODULE_DEFS[d].name).join(', ')}${PRODUCT_MODULE_DEFS[module].requiresWhy ? `: ${PRODUCT_MODULE_DEFS[module].requiresWhy}` : '.'} Grant ${deps.length === 1 ? 'it' : 'them'} first.`]);
      } else {
        const dependents = e.modules.filter((x) => x.purchased && PRODUCT_MODULE_DEFS[x.module].requires.includes(module)).map((x) => x.module);
        if (dependents.length) throw blocked('MODULE_DISABLE_BLOCKED', [`${dependents.map((d) => PRODUCT_MODULE_DEFS[d].name).join(', ')} depend${dependents.length === 1 ? 's' : ''} on ${PRODUCT_MODULE_DEFS[module].name}; remove ${dependents.length === 1 ? 'it' : 'them'} first.`]);
      }
      await checkRemovals(db, id, await inUseAfter(db, id, { overrides: { [module]: body.entitled } }));
      const old = (await db.query('SELECT entitled, reason FROM entitlement_overrides WHERE org_id = $1 AND module_key = $2', [id, module])).rows[0] ?? null;
      if (body.entitled === null) await db.query('DELETE FROM entitlement_overrides WHERE org_id = $1 AND module_key = $2', [id, module]);
      else await db.query(
        `INSERT INTO entitlement_overrides (org_id, module_key, entitled, reason, created_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (org_id, module_key) DO UPDATE SET entitled = EXCLUDED.entitled, reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, created_at = now()`,
        [id, module, body.entitled, body.reason, req.auth.sub],
      );
      await auditChange(db, adminActor(req), id, { action: 'entitlement.override_changed', entityType: 'module', old: { module, override: old?.entitled ?? null }, new: { module, override: body.entitled }, reason: body.reason, extra: { module } });
      invalidateEntitlements(id);
      return { id, module, entitled: body.entitled };
    });
  });

  /** The customer switch, operated by the platform (e.g. on request of the customer). */
  app.put('/api/v1/platform/organizations/:id/modules/:module', P, async (req) => {
    const { id, module } = z.object({ id: z.string().uuid(), module: z.enum(PRODUCT_MODULES) }).parse(req.params);
    const body = z.object({ enabled: z.boolean(), reason }).parse(req.body);
    await customerOrg(pool, id);
    return withTransaction(pool, (db) => setModuleEnabled(db, adminActor(req), id, module, body.enabled, body.reason));
  });

  /** Limit override: a number, null (unlimited) or 'PLAN' (remove the override). */
  app.put('/api/v1/platform/organizations/:id/limits/:key', P, async (req) => {
    const { id, key } = z.object({ id: z.string().uuid(), key: z.enum(LIMIT_KEYS as [LimitKey, ...LimitKey[]]) }).parse(req.params);
    const body = z.object({ value: z.union([z.number().int().min(0).max(10_000_000), z.null(), z.literal('PLAN')]), reason }).parse(req.body);
    return withTransaction(pool, async (db) => {
      await customerOrg(db, id, true);
      const e = await loadEntitlements(id, db, true);
      const old = e.limits[key];
      if (body.value === 'PLAN') await db.query('DELETE FROM limit_overrides WHERE org_id = $1 AND limit_key = $2', [id, key]);
      else await db.query(
        `INSERT INTO limit_overrides (org_id, limit_key, value, reason, created_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (org_id, limit_key) DO UPDATE SET value = EXCLUDED.value, reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, created_at = now()`,
        [id, key, body.value, body.reason, req.auth.sub],
      );
      await auditChange(db, adminActor(req), id, { action: 'limit.override_changed', entityType: 'limit', old: { key, value: old.value, source: old.source }, new: { key, value: body.value }, reason: body.reason, extra: { limit: key } });
      invalidateEntitlements(id);
      const fresh = await loadEntitlements(id, db, true);
      const usage = (await usageReport(db, fresh)).find((u) => u.key === key)!;
      // a limit below the current usage is allowed: nothing existing is removed, new creations are refused (HARD)
      return { id, key, value: fresh.limits[key].value, used: usage.used, exceeded: usage.exceeded, warning: usage.exceeded ? `Current usage (${usage.used}) is above the new limit; nothing is removed, new ${LIMIT_DEFS[key].label.toLowerCase()} are refused.` : null };
    });
  });

  // ---- organisation sub-views and onboarding steps --------------------------------------------

  app.get('/api/v1/platform/organizations/:id/users', P, async (req) => {
    const { id } = uuid.parse(req.params);
    await customerOrg(pool, id);
    const r = await pool.query(
      `SELECT e.id, e.email, e.name, e.role, e.active, e.is_platform_admin, e.last_login_at, e.created_at,
         COALESCE((SELECT json_agg(c.code ORDER BY c.code) FROM employee_casinos ec JOIN casinos c ON c.id = ec.casino_id WHERE ec.employee_id = e.id), '[]') casinos
       FROM employees e WHERE e.org_id = $1 ORDER BY e.active DESC, e.role, e.name`, [id]);
    return { users: r.rows };
  });

  /** An additional customer admin (e.g. a replacement); every other user is managed by the customer. */
  app.post('/api/v1/platform/organizations/:id/users', P, async (req) => {
    const { id } = uuid.parse(req.params);
    const body = z.object({ name: z.string().trim().min(2).max(100), email: z.string().trim().toLowerCase().email(), password: z.string().min(12).max(200), reason }).parse(req.body);
    return withTransaction(pool, async (db) => {
      const o = await customerOrg(db, id, true);
      if (o.is_platform) throw new HttpError(409, 'Platform administrators are created with the CLI');
      await requireLimit(db, id, 'MAX_USERS');
      let userId: string;
      try {
        userId = (await db.query(`INSERT INTO employees (org_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,'SUPER_ADMIN') RETURNING id`,
          [id, body.email, body.name, await bcrypt.hash(body.password, 10)])).rows[0].id;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'Email already in use');
        throw err;
      }
      await db.query(`INSERT INTO employee_casinos (employee_id, casino_id, org_id) SELECT $1, id, $2 FROM casinos WHERE org_id = $2`, [userId, id]);
      await auditChange(db, adminActor(req), id, { action: 'employee.created', entityType: 'employee', entityId: userId, old: null, new: { email: body.email, role: 'SUPER_ADMIN' }, reason: body.reason });
      return { id: userId };
    });
  });

  app.get('/api/v1/platform/organizations/:id/casinos', P, async (req) => {
    const { id } = uuid.parse(req.params);
    await customerOrg(pool, id);
    const r = await pool.query(
      `SELECT c.id, c.code, c.name, c.city, c.country, c.status, c.status_reason, c.created_at,
         (SELECT count(*)::int FROM machines m WHERE m.casino_id = c.id) AS machines,
         (SELECT count(*)::int FROM money_rail_cutovers x WHERE x.casino_id = c.id AND x.rail <> 'MACHINE') AS rails_on_ledger
       FROM casinos c WHERE c.org_id = $1 ORDER BY c.name`, [id]);
    return { casinos: r.rows };
  });

  app.post('/api/v1/platform/organizations/:id/casinos', P, async (req) => {
    const { id } = uuid.parse(req.params);
    const body = casinoSchema.parse(req.body);
    await customerOrg(pool, id);
    return withTransaction(pool, (db) => createCasino(db, adminActor(req), id, body));
  });

  app.put('/api/v1/platform/organizations/:id/casinos/:casinoId/status', P, async (req) => {
    const { id, casinoId } = z.object({ id: z.string().uuid(), casinoId: z.string().uuid() }).parse(req.params);
    const { status, reason: r } = statusSchema.parse(req.body);
    return withTransaction(pool, (db) => setCasinoStatus(db, adminActor(req), id, casinoId, status, r));
  });

  app.post('/api/v1/platform/organizations/:id/machines', P, async (req) => {
    const { id } = uuid.parse(req.params);
    const body = machineSchema.parse(req.body);
    await customerOrg(pool, id);
    return withTransaction(pool, (db) => createMachine(db, adminActor(req), id, body));
  });

  /** Administrative audit of one organisation (module, plan, limit, status, user, casino, machine changes). */
  app.get('/api/v1/platform/organizations/:id/audit', P, async (req) => {
    const { id } = uuid.parse(req.params);
    await customerOrg(pool, id);
    const r = await pool.query(
      `SELECT id, action, actor_name, entity_type, entity_id, details, created_at FROM audit_logs
       WHERE org_id = $1 AND split_part(action, '.', 1) IN ('organization', 'subscription', 'entitlement', 'limit', 'module', 'casino', 'machine', 'employee', 'auth')
       ORDER BY id DESC LIMIT 200`, [id]);
    return { entries: r.rows };
  });

  /** The platform's own chain: every platform action across organisations. */
  app.get('/api/v1/platform/audit', P, async (req) => {
    const r = await pool.query(
      `SELECT a.id, a.action, a.actor_name, a.entity_type, a.entity_id, a.details, a.created_at, o.name AS target_org
       FROM audit_logs a LEFT JOIN organizations o ON o.id = (a.details->>'targetOrgId')::uuid
       WHERE a.org_id = $1 ORDER BY a.id DESC LIMIT 300`, [req.auth.orgId]);
    return { entries: r.rows };
  });

  // ---- plans ------------------------------------------------------------------------------------

  app.get('/api/v1/platform/plans', P, async () => {
    const r = await pool.query(
      `SELECT p.*, (SELECT count(*)::int FROM subscriptions s WHERE s.plan_id = p.id) AS subscriptions
       FROM plans p ORDER BY p.code, p.version DESC`);
    return { plans: r.rows };
  });

  const planBody = z.object({
    code: z.string().trim().toUpperCase().min(2).max(40).regex(/^[A-Z0-9_]+$/), name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(500).optional(), active: z.boolean().default(true),
    modules: z.array(z.enum(PRODUCT_MODULES)).min(1), limits: z.record(z.enum(LIMIT_KEYS as [LimitKey, ...LimitKey[]]), z.number().int().min(0)).default({}),
    priceCents: z.number().int().min(0).nullable().optional(), currency: z.string().length(3).default('EUR'), billingInterval: z.enum(['MONTH', 'YEAR', 'NONE']).default('MONTH'),
    reason,
  });

  /** A new plan, or a new version of an existing code (versions are immutable; subscriptions keep theirs). */
  app.post('/api/v1/platform/plans', P, async (req) => {
    const body = planBody.parse(req.body);
    const modules = [...new Set<ProductModule>(['CORE', ...body.modules])];
    const missing = modules.flatMap((m) => PRODUCT_MODULE_DEFS[m].requires.filter((d) => !modules.includes(d)).map((d) => `${PRODUCT_MODULE_DEFS[m].name} requires ${PRODUCT_MODULE_DEFS[d].name}`));
    if (missing.length) throw blocked('MODULE_ENABLE_BLOCKED', missing);
    return withTransaction(pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`plan:${body.code}`]);
      const version = (await db.query('SELECT COALESCE(max(version), 0) + 1 AS v FROM plans WHERE code = $1', [body.code])).rows[0].v;
      const id = (await db.query(
        `INSERT INTO plans (code, version, name, description, active, modules, limits, price_cents, currency, billing_interval, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [body.code, version, body.name, body.description ?? null, body.active, modules, body.limits, body.priceCents ?? null, body.currency, body.billingInterval, req.auth.sub],
      )).rows[0].id;
      const a: AdminActor = adminActor(req);
      await auditChange(db, a, a.orgId, { action: 'plan.created', entityType: 'plan', entityId: id, old: null, new: { code: body.code, version, modules, limits: body.limits, priceCents: body.priceCents ?? null }, reason: body.reason });
      return { id, code: body.code, version };
    });
  });

  /** Metadata of a plan version (name, description, offered, price); modules and limits need a new version. */
  app.put('/api/v1/platform/plans/:id', P, async (req) => {
    const { id } = uuid.parse(req.params);
    const body = z.object({
      name: z.string().trim().min(2).max(80), description: z.string().trim().max(500).nullable().optional(), active: z.boolean(),
      priceCents: z.number().int().min(0).nullable().optional(), billingInterval: z.enum(['MONTH', 'YEAR', 'NONE']), reason,
    }).parse(req.body);
    return withTransaction(pool, async (db) => {
      const old = (await db.query('SELECT name, description, active, price_cents, billing_interval FROM plans WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!old) throw new HttpError(404, 'Plan not found');
      await db.query('UPDATE plans SET name = $2, description = $3, active = $4, price_cents = $5, billing_interval = $6 WHERE id = $1',
        [id, body.name, body.description ?? null, body.active, body.priceCents ?? null, body.billingInterval]);
      const a = adminActor(req);
      await auditChange(db, a, a.orgId, { action: 'plan.updated', entityType: 'plan', entityId: id, old, new: { name: body.name, description: body.description ?? null, active: body.active, price_cents: body.priceCents ?? null, billing_interval: body.billingInterval }, reason: body.reason });
      invalidateEntitlements();
      return { id };
    });
  });
}
