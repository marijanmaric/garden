import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CUTOVER_RAILS, CUTOVER_SCOPE } from '@m1/shared';
import { guard, scopeCasino } from '../auth';
import { pool } from '../db';
import { idempotent } from '../services/idempotency';
import { cutoverRail, dryRunCutover, railStatus, recordCutoverCount, verifyCutoverCount } from '../services/cutover';

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
  app.get('/api/v1/money/rails', { preHandler: guard('money.cutover') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    return railStatus(pool, req.auth.orgId, casinoId);
  });

  app.post('/api/v1/money/cutover/dry-run', { preHandler: guard('money.cutover') }, async (req) => dryRunCutover(pool, scoped(req), parseTarget(req)));

  app.post('/api/v1/money/cutover', { preHandler: guard('money.cutover') }, async (req, reply) => {
    const body = parseTarget(req);
    return idempotent(req, reply, (db) => cutoverRail(db, scoped(req), body));
  });

  app.post('/api/v1/money/counts', { preHandler: guard('cash.manage') }, async (req, reply) => {
    const body = count.extend({
      casinoId: z.string().uuid().optional(), context: z.enum(['VAULT_CUTOVER', 'DRAWER_CUTOVER', 'MACHINE_DROP']),
      vaultId: z.string().uuid().optional(), cashDeskId: z.string().uuid().optional(), machineId: z.string().uuid().optional(),
    }).parse(req.body);
    const casinoId = scopeCasino(req, body.casinoId);
    return idempotent(req, reply, (db) => recordCutoverCount(db, scoped(req), { ...body, casinoId }));
  });

  app.post('/api/v1/money/counts/:id/verify', { preHandler: guard('cash.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = count.parse(req.body);
    return idempotent(req, reply, (db) => verifyCutoverCount(db, scoped(req), id, body));
  });
}
