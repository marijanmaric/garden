import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { featureAvailable, hasPermission, type Feature } from '@m1/shared';
import { HttpError, guard, scopeCasino } from '../auth';
import { bus, type BusMessage } from '../bus';
import { pool } from '../db';
import { idempotent } from '../services/idempotency';
import { cancelMovement, confirmMovement, decideShortOver, recountVault, requestMovement, verifyVaultCount, type CashActor } from '../services/cash-ops';
import { closeBusinessDay, decideResolution, liftFreeze, requestResolution, runReconciliation } from '../services/reconciliation';
import { closeVaultSession, openVaultSession, startVaultCount } from '../services/vault';
import { decideApproval } from '../services/approvals';
import { decideHandpayApproval } from '../services/handpays';
import { decideException } from '../services/handpay-exceptions';
import { decideTicketApproval } from '../services/tito';
import { decideLateEventBooking } from '../services/late-events';
import { loadEntitlements, requireFeature } from '../services/entitlements';

/** The feature an approval belongs to (deciding it executes the action of that module). */
const APPROVAL_FEATURE: Record<string, Feature> = {
  DRAWER_SHORT_OVER: 'cash', HANDPAY_PAY: 'handpay', HANDPAY_EXCEPTION: 'handpay',
  TITO_REDEEM_CASHIER: 'tito.cashier', TITO_CANCEL: 'tito', TITO_VOID: 'tito',
  CASH_DEPOSIT: 'cashless.cashier', CASH_WITHDRAWAL: 'cashless.cashier',
  RECONCILIATION_RESOLUTION: 'reconciliation', LATE_EVENT_BOOKING: 'reconciliation',
};

/**
 * Step 7a: ledger-backed vault and drawer operations, approvals, reconciliation, freezes, day close.
 * All writes are idempotent (Idempotency-Key) and run in one database transaction each.
 */
const count = z.object({
  totalCents: z.number().int().min(0).max(1e13).optional(),
  denominations: z.record(z.string().regex(/^\d+$/), z.number().int().min(0)).optional(),
  note: z.string().max(500).optional(),
});

const actorOf = (req: FastifyRequest): CashActor => ({
  orgId: req.auth.orgId, employeeId: req.auth.sub, employeeEmail: req.auth.email, ip: req.ip, casinoIds: req.auth.casinoIds,
});

async function withEvents<T>(fn: (out: BusMessage[]) => Promise<T>) {
  const out: BusMessage[] = [];
  const r = await fn(out);
  out.forEach((m) => bus.publish(m));
  return r;
}

export async function cashOpsRoutes(app: FastifyInstance) {
  // ---- vault sessions and counts ----
  app.post('/api/v1/vault/sessions', { config: { feature: 'vault' }, preHandler: guard('cash.manage') }, async (req, reply) => {
    const body = z.object({ casinoId: z.string().uuid().optional(), vaultId: z.string().uuid().optional(), count, note: z.string().max(500).optional() }).parse(req.body);
    const casinoId = scopeCasino(req, body.casinoId);
    return idempotent(req, reply, async (db) => {
      const vaultId = body.vaultId ?? (await db.query('SELECT id FROM vaults WHERE casino_id = $1 AND active ORDER BY created_at, id LIMIT 1', [casinoId])).rows[0]?.id;
      if (!vaultId) throw new HttpError(404, 'Vault not found');
      return openVaultSession(db, actorOf(req), { vaultId, count: body.count, note: body.note });
    });
  });

  /** Closing count (blind). On the ledger the session closes when a second employee verifies it. */
  app.post('/api/v1/vault/sessions/:id/close', { config: { feature: 'vault' }, preHandler: guard('cash.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = count.parse(req.body);
    return idempotent(req, reply, async (db) => {
      const s = (await db.query('SELECT status FROM vault_sessions WHERE id = $1 AND org_id = $2', [id, req.auth.orgId])).rows[0];
      if (s?.status === 'OPEN') await startVaultCount(db, actorOf(req), id);
      return closeVaultSession(db, actorOf(req), id, body);
    });
  });

  app.post('/api/v1/vault/sessions/:id/recount', { config: { feature: 'vault' }, preHandler: guard('cash.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = count.parse(req.body);
    return idempotent(req, reply, (db) => recountVault(db, actorOf(req), id, body));
  });

  app.post('/api/v1/vault/counts/:id/verify', { config: { feature: 'vault' }, preHandler: guard('cash.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = count.parse(req.body);
    return idempotent(req, reply, (db) => verifyVaultCount(db, actorOf(req), id, body));
  });

  // ---- vault <-> drawer movements ----
  app.get('/api/v1/cash/movements', { config: { feature: 'cash' }, preHandler: guard() }, async (req) => {
    const qs = z.object({ casinoId: z.string().uuid().optional(), status: z.string().max(20).optional() }).parse(req.query);
    const casinoId = scopeCasino(req, qs.casinoId);
    return (await pool.query(
      // Blind count (Step 7e): the receiving side confirms an open movement with its own count, so it does not
      // get the requested amount (the requester does; decided movements show it).
      `SELECT m.id, m.kind, m.purpose, m.status,
         CASE WHEN m.status <> 'REQUESTED' OR m.requested_by = $4 THEN m.amount_cents
           WHEN m.kind = 'FILL' AND s.employee_id = $4 THEN NULL
           WHEN m.kind = 'DROP' AND $5::boolean THEN NULL ELSE m.amount_cents END AS amount_cents,
         m.cashier_session_id, m.requested_by, m.requested_at, m.expires_at, m.decided_by, m.money_transaction_id,
         s.employee_id AS cashier_id
       FROM cash_movements m JOIN cashier_sessions s ON s.id = m.cashier_session_id
       WHERE m.org_id = $1 AND m.casino_id = $2 AND ($3::text IS NULL OR m.status = $3) ORDER BY m.requested_at DESC LIMIT 200`,
      [req.auth.orgId, casinoId, qs.status ?? null, req.auth.sub, hasPermission(req.auth.role, 'cash.manage')],
    )).rows;
  });

  /** FILL: issued by the vault (cash.manage) for a shift. DROP: handed in by the cashier from the own shift. */
  app.post('/api/v1/cash/movements', { config: { feature: 'cash' }, preHandler: guard() }, async (req, reply) => {
    const body = z.object({
      kind: z.enum(['FILL', 'DROP']), cashierSessionId: z.string().uuid().optional(), amountCents: z.number().int().positive().max(1e13),
      requestKey: z.string().min(8).max(128).optional(), note: z.string().max(500).optional(),
    }).parse(req.body);
    if (body.kind === 'FILL' && !hasPermission(req.auth.role, 'cash.manage')) throw new HttpError(403, 'Missing permission cash.manage');
    if (body.kind === 'DROP' && !hasPermission(req.auth.role, 'cash.transact')) throw new HttpError(403, 'Missing permission cash.transact');
    return idempotent(req, reply, async (db) => {
      let sessionId = body.cashierSessionId;
      if (!sessionId && body.kind === 'DROP')
        sessionId = (await db.query(`SELECT id FROM cashier_sessions WHERE org_id = $1 AND employee_id = $2 AND status = 'OPEN'`, [req.auth.orgId, req.auth.sub])).rows[0]?.id;
      if (!sessionId) throw new HttpError(400, 'cashierSessionId required');
      const requestKey = body.requestKey ?? `${req.auth.sub}:${req.headers['idempotency-key']}`;
      return requestMovement(db, actorOf(req), { kind: body.kind, cashierSessionId: sessionId, amountCents: body.amountCents, requestKey, note: body.note });
    });
  });

  /** The receiving side confirms with its own count: FILL by the cashier, DROP by the vault. */
  app.post('/api/v1/cash/movements/:id/confirm', { config: { feature: 'cash' }, preHandler: guard() }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = count.parse(req.body);
    const m = (await pool.query('SELECT kind FROM cash_movements WHERE id = $1 AND org_id = $2', [id, req.auth.orgId])).rows[0];
    if (!m) throw new HttpError(404, 'Movement not found');
    const needed = m.kind === 'FILL' ? 'cash.transact' : 'cash.manage';
    if (!hasPermission(req.auth.role, needed)) throw new HttpError(403, `Missing permission ${needed}`);
    return idempotent(req, reply, (db) => confirmMovement(db, actorOf(req), id, body));
  });

  app.post('/api/v1/cash/movements/:id/cancel', { config: { feature: 'cash' }, preHandler: guard() }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return idempotent(req, reply, (db) => cancelMovement(db, actorOf(req), id));
  });

  // ---- approvals inbox (four eyes) ----
  app.get('/api/v1/approvals', { config: { feature: 'reconciliation' }, preHandler: guard('cashier.supervise') }, async (req) => {
    const qs = z.object({ casinoId: z.string().uuid().optional(), status: z.string().max(20).default('PENDING') }).parse(req.query);
    const casinoId = scopeCasino(req, qs.casinoId);
    const ent = await loadEntitlements(req.auth.orgId);
    // Step 7e: plus who asked, who decided and the affected entity (ticket, machine, player), read-only.
    return (await pool.query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.amount_cents, a.payload, a.status, a.requested_by, a.created_at, a.expires_at,
         a.decided_by, a.decided_at, a.decision_note, a.executed_at, a.money_transaction_id,
         rq.name AS requested_by_name, dc.name AS decided_by_name, (a.requested_by = $4) AS own,
         t.barcode, COALESCE(hm.asset_no, dm.asset_no, xm.asset_no, hxm.asset_no) AS asset_no,
         COALESCE(wp.player_no, pp.player_no) AS player_no, concat_ws(' ', COALESCE(wpr.first_name, ppr.first_name), COALESCE(wpr.last_name, ppr.last_name)) AS player_name,
         cd.name AS desk_name, ce.name AS cashier_name
       FROM approvals a
       JOIN employees rq ON rq.id = a.requested_by
       LEFT JOIN employees dc ON dc.id = a.decided_by
       LEFT JOIN tickets t ON a.entity_type = 'ticket' AND t.id::text = a.entity_id
       LEFT JOIN handpays h ON a.entity_type = 'handpay' AND h.id::text = a.entity_id
       LEFT JOIN machines hm ON hm.id = h.machine_id
       LEFT JOIN deferred_money_events d ON a.action = 'LATE_EVENT_BOOKING' AND d.event_id::text = a.entity_id
       LEFT JOIN machines dm ON dm.id = d.machine_id
       LEFT JOIN machine_event_exceptions x ON a.action = 'RECONCILIATION_RESOLUTION' AND a.entity_id = 'machine_event:' || x.event_id
       LEFT JOIN machines xm ON xm.id = x.machine_id
       LEFT JOIN handpay_legacy_exceptions hx ON a.entity_type = 'handpay_exception' AND hx.id::text = a.entity_id
       LEFT JOIN machines hxm ON hxm.id = hx.machine_id
       LEFT JOIN wallets w ON a.entity_type = 'wallet' AND w.id::text = a.entity_id
       LEFT JOIN players wp ON wp.id = w.player_id LEFT JOIN player_profiles wpr ON wpr.player_id = w.player_id
       LEFT JOIN players pp ON pp.id::text = a.payload->>'playerId' AND a.entity_type <> 'wallet' LEFT JOIN player_profiles ppr ON ppr.player_id = pp.id
       LEFT JOIN cash_counts cc ON a.action = 'DRAWER_SHORT_OVER' AND cc.id::text = a.entity_id
       LEFT JOIN cashier_sessions cs ON cs.id = cc.cashier_session_id LEFT JOIN cash_desks cd ON cd.id = cs.cash_desk_id LEFT JOIN employees ce ON ce.id = cs.employee_id
       WHERE a.org_id = $1 AND a.casino_id = $2 AND ($3 = 'ALL' OR a.status = $3) ORDER BY a.created_at DESC LIMIT 200`, [req.auth.orgId, casinoId, qs.status, req.auth.sub])).rows
      // only approvals of modules the organisation uses
      .filter((a) => featureAvailable(APPROVAL_FEATURE[a.action] ?? 'reconciliation', ent.inUse));
  });

  app.post('/api/v1/approvals/:id/decide', { config: { feature: 'reconciliation' }, preHandler: guard('cashier.supervise') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().max(500).optional() }).parse(req.body);
    return idempotent(req, reply, async (db) => {
      const ap = (await db.query('SELECT action, casino_id FROM approvals WHERE id = $1 AND org_id = $2', [id, req.auth.orgId])).rows[0];
      if (!ap || !req.auth.casinoIds.includes(ap.casino_id)) throw new HttpError(404, 'Approval not found');
      // the approval's own module must be entitled (deciding executes it)
      requireFeature(await loadEntitlements(req.auth.orgId), APPROVAL_FEATURE[ap.action] ?? 'reconciliation');
      if (ap.action === 'DRAWER_SHORT_OVER') return decideShortOver(db, actorOf(req), id, body.decision, body.note);
      if (ap.action === 'RECONCILIATION_RESOLUTION') return decideResolution(db, actorOf(req), id, body.decision, body.note);
      if (ap.action === 'HANDPAY_PAY') return decideHandpayApproval(db, actorOf(req), id, body.decision, body.note);
      if (ap.action === 'HANDPAY_EXCEPTION') return decideException(db, actorOf(req), id, body.decision, body.note);
      if (ap.action === 'TITO_REDEEM_CASHIER' || ap.action === 'TITO_CANCEL' || ap.action === 'TITO_VOID') return decideTicketApproval(db, actorOf(req), id, body.decision, body.note);
      if (ap.action === 'LATE_EVENT_BOOKING') return decideLateEventBooking(db, actorOf(req), id, body.decision, body.note);
      return { approval: await decideApproval(db, actorOf(req), id, body.decision, body.note) };
    });
  });

  // ---- reconciliation, freezes, day close ----
  app.post('/api/v1/money/reconciliation', { config: { feature: 'reconciliation' }, preHandler: guard('cashier.supervise') }, async (req, reply) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.body ?? {}).casinoId);
    return withEvents((out) => idempotent(req, reply, (db) => runReconciliation(db, { orgId: req.auth.orgId, casinoId, trigger: 'MANUAL', employeeId: req.auth.sub }, out)));
  });

  app.get('/api/v1/money/reconciliation', { config: { feature: 'reconciliation' }, preHandler: guard('cashier.supervise') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    const [last, freezes] = await Promise.all([
      pool.query('SELECT id, trigger, ok, checks, created_at FROM reconciliation_runs WHERE org_id = $1 AND casino_id = $2 ORDER BY created_at DESC LIMIT 1', [req.auth.orgId, casinoId]),
      pool.query('SELECT id, rail, casino_id, reason, frozen_at FROM money_rail_freezes WHERE org_id = $1 AND lifted_at IS NULL AND (casino_id = $2 OR casino_id IS NULL)', [req.auth.orgId, casinoId]),
    ]);
    return { lastRun: last.rows[0] ?? null, freezes: freezes.rows };
  });

  app.post('/api/v1/money/resolutions', { config: { feature: 'reconciliation' }, preHandler: guard('cashier.supervise') }, async (req, reply) => {
    const body = z.object({ casinoId: z.string().uuid().optional(), itemKey: z.string().min(3).max(200), explanation: z.string().min(10).max(2000) }).parse(req.body);
    const casinoId = scopeCasino(req, body.casinoId);
    return idempotent(req, reply, (db) => requestResolution(db, actorOf(req), { casinoId, itemKey: body.itemKey, explanation: body.explanation }));
  });

  app.post('/api/v1/money/freezes/:id/lift', { config: { feature: 'reconciliation' }, preHandler: guard('money.cutover') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().min(5).max(500) }).parse(req.body);
    const r = await withEvents((out) => idempotent(req, reply, (db) => liftFreeze(db, actorOf(req), id, reason, out)));
    if (!r.lifted) reply.code(409);
    return r;
  });

  app.post('/api/v1/money/day-close', { config: { feature: 'reconciliation' }, preHandler: guard('cash.manage') }, async (req, reply) => {
    const body = z.object({ casinoId: z.string().uuid().optional(), businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.body);
    const casinoId = scopeCasino(req, body.casinoId);
    const r = await withEvents((out) => idempotent(req, reply, (db) => closeBusinessDay(db, actorOf(req), { casinoId, businessDate: body.businessDate }, out)));
    if (!r.closed) reply.code(409);
    return r;
  });
}
