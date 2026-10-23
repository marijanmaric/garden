import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { guard, scopeCasino } from '../auth';
import { bus, type BusMessage } from '../bus';
import { pool } from '../db';
import { idempotent } from '../services/idempotency';
import { requestLateEventBooking } from '../services/late-events';
import { requestDisposition } from '../services/exception-dispositions';
import { confirmHopperFill, recordCollectionCount, requestHopperFill, verifyCollectionCount } from '../services/machine-ops';
import { requireUsableCard } from '../services/players';
import { requestWalletCashApproval, walletCash } from '../services/wallet-cash';
import type { CashActor } from '../services/cash-ops';

/**
 * Step 7d routes: hopper fills and machine collections on the ledger, cashier <-> wallet cash, machine
 * event exceptions, and the four-eyes late-event booking of deferred events on a closed business date
 * (decided under /api/v1/approvals/:id/decide). Every write is idempotent (Idempotency-Key).
 */
const count = z.object({
  totalCents: z.number().int().min(0).max(1e13).optional(),
  denominations: z.record(z.string().regex(/^\d+$/), z.number().int().min(0)).optional(),
  note: z.string().max(500).optional(),
});

const actorOf = (req: FastifyRequest): CashActor => ({
  orgId: req.auth.orgId, employeeId: req.auth.sub, employeeEmail: req.auth.email, ip: req.ip, casinoIds: req.auth.casinoIds,
});

export async function machineMoneyRoutes(app: FastifyInstance) {
  // ---- hopper fill: requested by the vault, confirmed at the machine ----
  app.post('/api/v1/machines/:id/hopper-fills', { config: { feature: 'machine' }, preHandler: guard('cash.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ amountCents: z.number().int().positive().max(1e13), note: z.string().max(500).optional() }).parse(req.body);
    return idempotent(req, reply, (db) => requestHopperFill(db, actorOf(req), { machineId: id, amountCents: body.amountCents, note: body.note, requestKey: `hopper:${req.headers['idempotency-key']}` }));
  });
  app.post('/api/v1/machines/hopper-fills/:id/confirm', { config: { feature: 'machine' }, preHandler: guard('cash.transact') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = count.parse(req.body);
    return idempotent(req, reply, (db) => confirmHopperFill(db, actorOf(req), id, body));
  });

  // ---- machine collection: blind count, blind second count by a different employee ----
  app.post('/api/v1/machines/:id/collections/count', { config: { feature: 'machine' }, preHandler: guard('cash.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = count.parse(req.body);
    return idempotent(req, reply, (db) => recordCollectionCount(db, actorOf(req), id, body));
  });
  app.post('/api/v1/machines/collections/counts/:id/verify', { config: { feature: 'machine' }, preHandler: guard('cash.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = count.parse(req.body);
    return idempotent(req, reply, (db) => verifyCollectionCount(db, actorOf(req), id, body));
  });

  // ---- cashier <-> wallet ----
  const walletBody = z.object({ playerCard: z.string().min(1).max(40), amount: z.number().positive().max(1_000_000) });
  for (const [path, kind] of [['deposit', 'CASH_DEPOSIT'], ['withdraw', 'CASH_WITHDRAWAL']] as const) {
    app.post(`/api/v1/cashier/wallet/${path}`, { config: { feature: 'cashless.cashier' }, preHandler: guard('cash.transact') }, async (req, reply) => {
      const body = walletBody.parse(req.body);
      return idempotent(req, reply, async (db) => {
        const card = await requireUsableCard(db, req.auth.orgId, body.playerCard);
        return walletCash(db, actorOf(req), { kind, playerId: card.player.id, cardId: card.card.id, amountCents: Math.round(body.amount * 100), requestKey: String(req.headers['idempotency-key']) });
      });
    });
  }
  app.post('/api/v1/cashier/wallet/approval-request', { config: { feature: 'cashless.cashier' }, preHandler: guard('cash.transact') }, async (req, reply) => {
    const body = walletBody.extend({ kind: z.enum(['CASH_DEPOSIT', 'CASH_WITHDRAWAL']) }).parse(req.body);
    return idempotent(req, reply, async (db) => {
      const card = await requireUsableCard(db, req.auth.orgId, body.playerCard);
      return requestWalletCashApproval(db, actorOf(req), { kind: body.kind, playerId: card.player.id, amountCents: Math.round(body.amount * 100) });
    });
  });

  // ---- machine event exceptions (money part rejected, event kept) ----
  app.get('/api/v1/machines/event-exceptions', { config: { feature: 'reconciliation' }, preHandler: guard('cashier.supervise') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    return (await pool.query(
      `SELECT x.*, m.asset_no, e.amount, e.occurred_at,
         EXISTS (SELECT 1 FROM reconciliation_resolutions r WHERE r.org_id = x.org_id AND r.item_key = 'machine_event:' || x.event_id) AS explained,
         (SELECT a.status FROM approvals a WHERE a.action = 'RECONCILIATION_RESOLUTION' AND a.entity_id = 'machine_event:' || x.event_id ORDER BY a.created_at DESC LIMIT 1) AS explanation_status,
         machine_exception_needs_disposition(x.event_id) AS needs_disposition,
         (SELECT d.kind FROM machine_event_dispositions d WHERE d.event_id = x.event_id) AS disposition,
         (SELECT a.status FROM approvals a WHERE a.action = 'MACHINE_EXCEPTION_DISPOSITION' AND a.entity_id = x.event_id::text ORDER BY a.created_at DESC LIMIT 1) AS disposition_status
       FROM machine_event_exceptions x JOIN machines m ON m.id = x.machine_id JOIN machine_events e ON e.event_id = x.event_id
       WHERE x.org_id = $1 AND x.casino_id = $2 ORDER BY x.created_at DESC LIMIT 200`,
      [req.auth.orgId, casinoId])).rows;
  });

  /**
   * V1: financial disposition of an exception that changed a ledger machine's credit (four eyes; executed when a
   * different person approves under /api/v1/approvals/:id/decide). Settlement of the machine waits for it.
   */
  app.post('/api/v1/machines/event-exceptions/:eventId/disposition', { config: { feature: 'reconciliation' }, preHandler: guard('cashier.supervise') }, async (req, reply) => {
    const { eventId } = z.object({ eventId: z.string().uuid() }).parse(req.params);
    const body = z.object({
      kind: z.enum(['CORRECTION', 'NO_MONEY_MOVED']), reason: z.string().trim().min(10).max(1000), evidenceRef: z.string().trim().min(3).max(300),
      amountCents: z.number().int().positive().max(1e13).optional(), currency: z.literal('EUR').default('EUR'),
    }).parse(req.body);
    return idempotent(req, reply, (db) => requestDisposition(db, actorOf(req), eventId, body));
  });

  // ---- late-event booking of a deferred event whose business date is closed (four eyes) ----
  app.post('/api/v1/money/deferred/:eventId/late-booking', { config: { feature: 'reconciliation' }, preHandler: guard('cashier.supervise') }, async (req, reply) => {
    const { eventId } = z.object({ eventId: z.string().uuid() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().min(10).max(1000) }).parse(req.body);
    const out: BusMessage[] = [];
    const r = await idempotent(req, reply, (db) => requestLateEventBooking(db, actorOf(req), eventId, reason));
    out.forEach((m) => bus.publish(m));
    return r;
  });
}
