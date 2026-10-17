import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTransaction } from '@m1/database';
import { PRODUCT_MODULES, PRODUCT_MODULE_DEFS } from '@m1/shared';
import { guard } from '../auth';
import { pool } from '../db';
import { entitlementView, loadEntitlements, usageReport } from '../services/entitlements';
import { createCasino, createMachine, licenseStatus, moduleCards, setCasinoStatus, setModuleEnabled, type AdminActor } from '../services/org-admin';

export const adminActor = (req: FastifyRequest): AdminActor => ({
  orgId: req.auth.orgId, employeeId: req.auth.sub, email: req.auth.email, ip: req.ip, platform: req.auth.isPlatformAdmin,
});

export const casinoSchema = z.object({
  code: z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9-]+$/), name: z.string().trim().min(2).max(100),
  city: z.string().trim().max(80).optional(), country: z.string().trim().max(80).optional(),
  timezone: z.string().trim().max(60).optional(), currency: z.string().trim().length(3).optional(),
});
export const machineSchema = z.object({
  casinoId: z.string().uuid(), machineCode: z.string().trim().min(2).max(40), assetNo: z.string().trim().min(1).max(20),
  serialNumber: z.string().trim().max(60).optional(), game: z.string().trim().max(80).optional(),
  denomination: z.number().positive().max(1000).optional(), floorId: z.string().uuid().nullable().optional(),
});
export const statusSchema = z.object({ status: z.enum(['ACTIVE', 'INACTIVE']), reason: z.string().trim().min(3).max(500) });

/**
 * Customer administration (permission org.manage: the organisation's super admin). The customer sees the plan,
 * switches purchased modules on and off (dependency and prerequisite checks), sees limits with usage and
 * manages casinos and machines inside the HARD limits. Purchasing is not possible here: upgrades go through
 * the platform administrator.
 */
export async function orgRoutes(app: FastifyInstance) {
  /** The entitlements of the caller's organisation: what the UI renders menus and pages from. */
  app.get('/api/v1/me/entitlements', { config: { feature: 'core' }, preHandler: guard() }, async (req) => {
    return entitlementView(await loadEntitlements(req.auth.orgId));
  });

  app.get('/api/v1/org', { config: { feature: 'core' }, preHandler: guard('org.manage') }, async (req) => {
    const e = await loadEntitlements(req.auth.orgId, pool, true);
    const [org, modules, usage, plans] = await Promise.all([
      pool.query('SELECT id, name, slug, status, created_at FROM organizations WHERE id = $1', [req.auth.orgId]),
      moduleCards(pool, e),
      usageReport(pool, e),
      pool.query(`SELECT DISTINCT ON (code) code, name, description, modules FROM plans WHERE active ORDER BY code, version DESC`),
    ]);
    const owned = new Set(e.modules.filter((m) => m.purchased).map((m) => m.module));
    const upgrades = PRODUCT_MODULES.filter((m) => !owned.has(m)).map((m) => ({
      module: m, name: PRODUCT_MODULE_DEFS[m].name, description: PRODUCT_MODULE_DEFS[m].description,
      plans: plans.rows.filter((p) => p.modules.includes(m)).map((p) => ({ code: p.code, name: p.name })),
    }));
    return { organization: org.rows[0], license: licenseStatus(e), entitlements: entitlementView(e), modules, usage, upgrades, upgradeContact: 'Contact your platform administrator to upgrade.' };
  });

  app.put('/api/v1/org/modules/:module', { config: { feature: 'core' }, preHandler: guard('org.manage') }, async (req) => {
    const { module } = z.object({ module: z.enum(PRODUCT_MODULES) }).parse(req.params);
    const { enabled, reason } = z.object({ enabled: z.boolean(), reason: z.string().trim().max(500).optional() }).parse(req.body);
    return withTransaction(pool, (db) => setModuleEnabled(db, adminActor(req), req.auth.orgId, module, enabled, reason));
  });

  app.get('/api/v1/org/casinos', { config: { feature: 'core' }, preHandler: guard('org.manage') }, async (req) => {
    const r = await pool.query(
      `SELECT c.id, c.code, c.name, c.city, c.country, c.timezone, c.currency, c.status, c.status_reason, c.created_at,
         (SELECT count(*)::int FROM machines m WHERE m.casino_id = c.id) AS machines,
         (SELECT count(*)::int FROM employee_casinos ec JOIN employees e ON e.id = ec.employee_id WHERE ec.casino_id = c.id AND e.active) AS users
       FROM casinos c WHERE c.org_id = $1 ORDER BY c.status, c.name`,
      [req.auth.orgId],
    );
    return { casinos: r.rows };
  });

  app.post('/api/v1/org/casinos', { config: { feature: 'core' }, preHandler: guard('org.manage') }, async (req) => {
    const body = casinoSchema.parse(req.body);
    return withTransaction(pool, (db) => createCasino(db, adminActor(req), req.auth.orgId, body));
  });

  app.put('/api/v1/org/casinos/:id/status', { config: { feature: 'core' }, preHandler: guard('org.manage') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { status, reason } = statusSchema.parse(req.body);
    return withTransaction(pool, (db) => setCasinoStatus(db, adminActor(req), req.auth.orgId, id, status, reason));
  });

  app.post('/api/v1/org/machines', { config: { feature: 'core' }, preHandler: guard('org.manage') }, async (req) => {
    const body = machineSchema.parse(req.body);
    return withTransaction(pool, (db) => createMachine(db, adminActor(req), req.auth.orgId, body));
  });
}
