import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, guard, scopeCasino } from '../auth';
import { pool } from '../db';
import { idempotent } from '../services/idempotency';
import { replayDeferredHandpays, requestHandpayApproval, retryHandpayReset, voidHandpay } from '../services/handpays';
import { detectLegacyHandpayExceptions, proposeException } from '../services/handpay-exceptions';
import type { CashActor } from '../services/cash-ops';

/**
 * Step 7b handpay routes: approval request (four eyes, decided under /api/v1/approvals/:id/decide),
 * reset retry (never money), void, and the legacy handpay exceptions. Payment stays
 * POST /api/v1/cashier/handpays/:machineId. Every write needs an Idempotency-Key.
 */
const actorOf = (req: FastifyRequest): CashActor => ({ orgId: req.auth.orgId, employeeId: req.auth.sub, employeeEmail: req.auth.email, ip: req.ip, casinoIds: req.auth.casinoIds });

async function inScope(req: FastifyRequest, handpayId: string) {
  const h = (await pool.query('SELECT casino_id FROM handpays WHERE id = $1 AND org_id = $2', [handpayId, req.auth.orgId])).rows[0];
  if (!h || !req.auth.casinoIds.includes(h.casino_id)) throw new HttpError(404, 'Handpay not found');
}

export async function handpayRoutes(app: FastifyInstance) {
  app.post('/api/v1/handpays/:id/approval-request', { preHandler: guard('cash.transact') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await inScope(req, id);
    return idempotent(req, reply, (db) => requestHandpayApproval(db, actorOf(req), id));
  });

  /** Reset retry of a paid handpay: returns the open command instead of creating a second one. */
  app.post('/api/v1/handpays/:id/reset', { preHandler: guard('cash.transact') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await inScope(req, id);
    return idempotent(req, reply, (db) => retryHandpayReset(db, actorOf(req), id));
  });

  app.post('/api/v1/handpays/:id/void', { preHandler: guard('cashier.supervise') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    await inScope(req, id);
    return idempotent(req, reply, (db) => voidHandpay(db, actorOf(req), id, reason));
  });

  // ---- jackpots deferred while HANDPAY was frozen ----
  app.get('/api/v1/handpays/deferred', { preHandler: guard('cashier.supervise') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    return (await pool.query('SELECT * FROM deferred_money_events WHERE org_id = $1 AND casino_id = $2 ORDER BY created_at', [req.auth.orgId, casinoId])).rows;
  });

  /** Replays deferred jackpots of an unfrozen rail (also done by the freeze lift and the maintenance job). */
  app.post('/api/v1/handpays/deferred/replay', { preHandler: guard('cashier.supervise') }, async (req, reply) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.body ?? {}).casinoId);
    return idempotent(req, reply, async (db) => ({ replayed: await replayDeferredHandpays(db, { orgId: req.auth.orgId, casinoId }) }));
  });

  // ---- legacy handpay exceptions (pre Step 1 payments without jackpot event id) ----
  app.get('/api/v1/handpays/legacy-exceptions', { preHandler: guard('cashier.supervise') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    return (await pool.query('SELECT * FROM handpay_legacy_exceptions WHERE org_id = $1 AND casino_id = $2 ORDER BY created_at, cash_transaction_id', [req.auth.orgId, casinoId])).rows;
  });

  app.post('/api/v1/handpays/legacy-exceptions/detect', { preHandler: guard('cashier.supervise') }, async (req, reply) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.body ?? {}).casinoId);
    return idempotent(req, reply, (db) => detectLegacyHandpayExceptions(db, actorOf(req), casinoId));
  });

  app.post('/api/v1/handpays/legacy-exceptions/:id/propose', { preHandler: guard('cashier.supervise') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      resolution: z.enum(['LINK', 'HISTORICAL', 'DISPUTED']), jackpotEventId: z.string().uuid().optional(),
      evidenceReference: z.string().trim().min(3).max(500), evidenceHash: z.string().max(200).optional(), justification: z.string().trim().min(20).max(2000),
    }).parse(req.body);
    return idempotent(req, reply, (db) => proposeException(db, actorOf(req), id, body));
  });
}
