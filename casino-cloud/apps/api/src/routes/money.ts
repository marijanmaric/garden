import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CUTOVER_RAILS, CUTOVER_SCOPE, RAIL_PRODUCTION_READY, maintenanceWindowOf, railRelease } from '@m1/shared';
import { HttpError, guard, scopeCasino } from '../auth';
import { pool } from '../db';
import { idempotent } from '../services/idempotency';
import { CutoverAborted, cutoverRail, dryRunCutover, railStatus, recordCutoverCount, verifyCutoverCount, type CutoverReport } from '../services/cutover';

/** Blind count: until every count of the cutover is verified by a second person, no legacy amount is returned. */
function blindReport(report: CutoverReport) {
  const unverified = report.checks.some((c) => (c.name.endsWith(':count_verified') || c.name.endsWith(':count_exists')) && !c.ok);
  if (!unverified) return report;
  return {
    ...report, legacy: {}, blind: true,
    checks: report.checks.map((c) => (c.detail !== undefined ? { ...c, detail: 'hidden until the counts are verified (blind count)' } : c)),
  };
}

/**
 * Rail cutover (migration 006). Nothing here runs by itself: every cutover is an explicit,
 * permissioned request after verified physical counts. A dry run executes everything and rolls back.
 */
const target = z.object({ rail: z.enum(CUTOVER_RAILS), casinoId: z.string().uuid().optional(), machineId: z.string().uuid().optional() });
const count = z.object({
  totalCents: z.number().int().min(0).max(1e13).optional(),
  denominations: z.record(z.string().regex(/^\d+$/), z.number().int().min(0)).optional(),
  note: z.string().max(500).optional(),
});

/** Casino-level rails default to the employee's casino, like every other casino-scoped route. */
const parseTarget = (req: FastifyRequest) => {
  const t = target.parse(req.body);
  return CUTOVER_SCOPE[t.rail] === 'CASINO' ? { ...t, casinoId: scopeCasino(req, t.casinoId) } : t;
};

const scoped = (req: FastifyRequest) => ({
  orgId: req.auth.orgId, employeeId: req.auth.sub, employeeEmail: req.auth.email, ip: req.ip, casinoIds: req.auth.casinoIds,
});

export async function moneyRoutes(app: FastifyInstance) {
  app.get('/api/v1/money/rails', { config: { feature: 'money.admin' }, preHandler: guard('money.cutover') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    return railStatus(pool, req.auth.orgId, casinoId);
  });

  /**
   * Blind count (Step 7e): while a cutover count is not verified by a second person, the dry run does not
   * reveal the legacy amounts the count is compared with (legacy totals and the amount details of checks).
   */
  app.post('/api/v1/money/cutover/dry-run', { config: { feature: 'money.admin' }, preHandler: guard('money.cutover') }, async (req) => {
    return blindReport(await dryRunCutover(pool, scoped(req), parseTarget(req)));
  });

  app.post('/api/v1/money/cutover', { config: { feature: 'money.admin' }, preHandler: guard('money.cutover') }, async (req, reply) => {
    const body = parseTarget(req);
    // Only rails whose complete ledger operations are released may be cut over in production.
    if (!RAIL_PRODUCTION_READY.includes(body.rail))
    {
      const r = railRelease(body.rail);
      throw new HttpError(409, r.implementationMissing.length
        ? `${body.rail} cutover is not released yet: ledger operations missing for ${r.implementationMissing.join(', ')} (implementation dependency; dry run is available)`
        : `${body.rail} cutover is not released yet: it goes live in one maintenance window with ${maintenanceWindowOf(body.rail).filter((x) => x !== body.rail).join(', ')}, and ledger operations are still missing for ${r.windowMissing.join(', ')} (maintenance-window dependency, not a technical one; dry run is available)`);
    }
    try {
      return await idempotent(req, reply, (db) => cutoverRail(db, scoped(req), body));
    } catch (err) {
      if (err instanceof CutoverAborted) err.body = { report: blindReport(err.report) };
      throw err;
    }
  });

  app.post('/api/v1/money/counts', { config: { feature: 'money.admin' }, preHandler: guard('cash.manage') }, async (req, reply) => {
    const body = count.extend({
      casinoId: z.string().uuid().optional(), context: z.enum(['VAULT_CUTOVER', 'DRAWER_CUTOVER', 'MACHINE_DROP']),
      vaultId: z.string().uuid().optional(), cashDeskId: z.string().uuid().optional(), machineId: z.string().uuid().optional(),
    }).parse(req.body);
    const casinoId = scopeCasino(req, body.casinoId);
    return idempotent(req, reply, (db) => recordCutoverCount(db, scoped(req), { ...body, casinoId }));
  });

  app.post('/api/v1/money/counts/:id/verify', { config: { feature: 'money.admin' }, preHandler: guard('cash.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = count.parse(req.body);
    return idempotent(req, reply, (db) => verifyCutoverCount(db, scoped(req), id, body));
  });
}
