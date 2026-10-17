import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit, type PoolClient } from '@m1/database';
import { TICKET_STATUSES, hasPermission } from '@m1/shared';
import { HttpError, actor, guard, scopeCasino } from '../auth';
import { pool } from '../db';
import { loadEntitlements, requireModule } from '../services/entitlements';
import { idempotent } from '../services/idempotency';
import { addCashTx, newBarcode, requireOpenSession } from '../services/cashier';
import { requireUsableCard } from '../services/players';
import { redeemTicket, requestTicketApproval, sellTicket, titoOnLedger } from '../services/tito';

const moneyActor = (req: FastifyRequest) => ({ orgId: req.auth.orgId, employeeId: req.auth.sub, employeeEmail: req.auth.email, ip: req.ip, casinoIds: req.auth.casinoIds });

const TICKET_SELECT = `
  SELECT t.*, mi.asset_no AS issued_machine, mr.asset_no AS redeemed_machine,
    ei.name AS issued_employee, er.name AS redeemed_employee,
    (t.status = 'VALID' AND t.expires_at > now()) AS payable
  FROM tickets t
  LEFT JOIN machines mi ON mi.id = t.issued_by_machine_id
  LEFT JOIN machines mr ON mr.id = t.redeemed_machine_id
  LEFT JOIN employees ei ON ei.id = t.issued_by_employee
  LEFT JOIN employees er ON er.id = t.redeemed_by_employee`;

const barcodeSchema = z.string().trim().regex(/^\d{6,30}$/, 'Barcode must be numeric');

async function ticketEvent(db: PoolClient, orgId: string, ticketId: string, action: string, employeeId: string | null, details: Record<string, unknown> = {}) {
  await db.query('INSERT INTO ticket_events (org_id, ticket_id, action, employee_id, details) VALUES ($1,$2,$3,$4,$5)', [orgId, ticketId, action, employeeId, details]);
}

async function loadTicket(db: PoolClient, req: FastifyRequest, id: string) {
  const r = await db.query('SELECT * FROM tickets WHERE id = $1 AND org_id = $2 AND casino_id = ANY($3) FOR NO KEY UPDATE', [id, req.auth.orgId, req.auth.casinoIds]);
  if (!r.rowCount) throw new HttpError(404, 'Ticket not found');
  return r.rows[0];
}

function requireValid(t: { status: string; expires_at: string }) {
  if (t.status !== 'VALID') throw new HttpError(409, `Ticket is ${t.status}`);
}

export async function ticketRoutes(app: FastifyInstance) {
  app.get('/api/v1/tickets', { config: { feature: 'tito' }, preHandler: guard('ticket.view') }, async (req) => {
    const qs = z.object({
      casinoId: z.string().uuid().optional(), status: z.enum(TICKET_STATUSES).optional(), search: z.string().max(40).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).parse(req.query);
    const casinoId = scopeCasino(req, qs.casinoId);
    const r = await pool.query(
      `${TICKET_SELECT} WHERE t.org_id = $1 AND t.casino_id = $2 AND ($3::text IS NULL OR t.status = $3) AND ($4::text IS NULL OR t.barcode LIKE $4)
       ORDER BY t.issued_at DESC LIMIT $5`,
      [req.auth.orgId, casinoId, qs.status ?? null, qs.search ? `%${qs.search}%` : null, qs.limit],
    );
    return r.rows;
  });

  app.get('/api/v1/tickets/summary', { config: { feature: 'tito' }, preHandler: guard('ticket.view') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    const today = `(date_trunc('day', now() AT TIME ZONE c.timezone) AT TIME ZONE c.timezone)`;
    const r = await pool.query(
      `SELECT
         count(*) FILTER (WHERE t.status = 'VALID') valid_count,
         COALESCE(sum(t.amount) FILTER (WHERE t.status = 'VALID'), 0) liability,
         count(*) FILTER (WHERE t.issued_at >= ${today}) issued_today,
         COALESCE(sum(t.amount) FILTER (WHERE t.issued_at >= ${today}), 0) issued_today_amount,
         count(*) FILTER (WHERE t.redeemed_at >= ${today}) redeemed_today,
         COALESCE(sum(t.amount) FILTER (WHERE t.redeemed_at >= ${today}), 0) redeemed_today_amount,
         count(*) FILTER (WHERE t.status = 'EXPIRED') expired_count,
         count(*) FILTER (WHERE t.status = 'VALID' AND t.expires_at < now() + interval '3 days') expiring_soon
       FROM tickets t JOIN casinos c ON c.id = t.casino_id WHERE t.org_id = $1 AND t.casino_id = $2`,
      [req.auth.orgId, casinoId],
    );
    return r.rows[0];
  });

  /** Validation for cashier and mobile cashier: returns the ticket and whether it may be paid. */
  app.get('/api/v1/tickets/lookup/:barcode', { config: { feature: 'tito' }, preHandler: guard() }, async (req) => {
    if (!hasPermission(req.auth.role, 'ticket.view') && !hasPermission(req.auth.role, 'ticket.payout')) throw new HttpError(403, 'Missing permission ticket.view');
    const barcode = barcodeSchema.parse((req.params as { barcode: string }).barcode);
    const r = await pool.query(`${TICKET_SELECT} WHERE t.org_id = $1 AND t.casino_id = ANY($2) AND t.barcode = $3`, [req.auth.orgId, req.auth.casinoIds, barcode]);
    if (!r.rowCount) throw new HttpError(404, 'Unknown ticket');
    const t = r.rows[0];
    const reason = t.payable ? null : t.status !== 'VALID' ? `Ticket is ${t.status}` : 'Ticket expired';
    return { ...t, reason };
  });

  app.get('/api/v1/tickets/:id', { config: { feature: 'tito' }, preHandler: guard('ticket.view') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await pool.query(`${TICKET_SELECT} WHERE t.id = $1 AND t.org_id = $2 AND t.casino_id = ANY($3)`, [id, req.auth.orgId, req.auth.casinoIds]);
    if (!r.rowCount) throw new HttpError(404, 'Ticket not found');
    const events = await pool.query(
      `SELECT te.action, te.details, te.created_at, m.asset_no, e.name AS employee
       FROM ticket_events te LEFT JOIN machines m ON m.id = te.machine_id LEFT JOIN employees e ON e.id = te.employee_id
       WHERE te.ticket_id = $1 ORDER BY te.id`,
      [id],
    );
    return { ...r.rows[0], events: events.rows };
  });

  /** Cashier pays out a ticket from the drawer. Atomic: a ticket can only ever be redeemed once. */
  app.post('/api/v1/tickets/redeem', { config: { feature: 'tito.cashier' }, preHandler: guard('ticket.payout') }, async (req, reply) => {
    const { barcode, payTo, playerCard } = z.object({ barcode: barcodeSchema, payTo: z.enum(['CASH', 'WALLET']).default('CASH'), playerCard: z.string().max(40).optional() }).parse(req.body);
    if (payTo === 'WALLET') requireModule(await loadEntitlements(req.auth.orgId), 'CASHLESS');
    const result = await idempotent(req, reply, async (db) => {
      const session = await requireOpenSession(db, req.auth.orgId, req.auth.sub);
      if (await titoOnLedger(db, req.auth.orgId, session.casino_id)) {
        // Step 7c: TITO_REDEEM_CASHIER (cash or wallet), approval above the payout limit.
        const card = playerCard ? await requireUsableCard(db, req.auth.orgId, playerCard) : null;
        return redeemTicket(db, moneyActor(req), { barcode, payTo, playerId: card?.player.id ?? null, cardId: card?.card.id ?? null });
      }
      if (payTo !== 'CASH') throw new HttpError(409, 'Wallet ticket payouts need the TITO rail on the ledger');
      const r = await db.query(
        `UPDATE tickets SET status = 'REDEEMED', redeemed_at = now(), redeemed_by_employee = $3, redeemed_session_id = $4
         WHERE org_id = $1 AND casino_id = $5 AND barcode = $2 AND status = 'VALID' AND expires_at > now() RETURNING *`,
        [req.auth.orgId, barcode, req.auth.sub, session.id, session.casino_id],
      );
      if (!r.rowCount) {
        const t = await db.query('SELECT status, expires_at FROM tickets WHERE org_id = $1 AND casino_id = $2 AND barcode = $3', [req.auth.orgId, session.casino_id, barcode]);
        if (!t.rowCount) throw new HttpError(404, 'Unknown ticket');
        throw new HttpError(409, t.rows[0].status === 'VALID' ? 'Ticket expired' : `Ticket is ${t.rows[0].status}`);
      }
      const ticket = r.rows[0];
      const tx = await addCashTx(db, session, 'TICKET_PAYOUT', ticket.amount, { ticketId: ticket.id, reference: barcode });
      await ticketEvent(db, req.auth.orgId, ticket.id, 'REDEEMED', req.auth.sub, { sessionId: session.id });
      await writeAudit(db, { ...actor(req), casinoId: session.casino_id, action: 'ticket.redeemed', entityType: 'ticket', entityId: ticket.id, details: { barcode, amount: ticket.amount } });
      return { ticket, transaction: tx };
    });
    return result;
  });

  /** Cashier sells a ticket for cash (player takes it to a machine). */
  app.post('/api/v1/tickets/issue', { config: { feature: 'tito.cashier' }, preHandler: guard('ticket.payout') }, async (req, reply) => {
    const { amount, payFrom, playerCard } = z.object({ amount: z.number().positive().max(100000), payFrom: z.enum(['CASH', 'WALLET']).default('CASH'), playerCard: z.string().max(40).optional() }).parse(req.body);
    if (payFrom === 'WALLET') requireModule(await loadEntitlements(req.auth.orgId), 'CASHLESS');
    return idempotent(req, reply, async (db) => {
      const session = await requireOpenSession(db, req.auth.orgId, req.auth.sub);
      if (await titoOnLedger(db, req.auth.orgId, session.casino_id)) {
        // Step 7c: TITO_ISSUE_CASHIER, paid with cash or from the player's wallet.
        const card = playerCard ? await requireUsableCard(db, req.auth.orgId, playerCard) : null;
        const sold = await sellTicket(db, moneyActor(req), { amountCents: Math.round(amount * 100), payFrom, playerId: card?.player.id ?? null, cardId: card?.card.id ?? null });
        return { ...sold.ticket, moneyTransactionId: sold.moneyTransaction.id };
      }
      if (payFrom !== 'CASH') throw new HttpError(409, 'Wallet ticket sales need the TITO rail on the ledger');
      const r = await db.query(
        `INSERT INTO tickets (org_id, casino_id, barcode, amount, issued_by_employee, expires_at)
         SELECT $1, $2, $3, $4, $5, now() + make_interval(days => c.ticket_expiry_days) FROM casinos c WHERE c.id = $2 RETURNING *`,
        [req.auth.orgId, session.casino_id, newBarcode(), amount, req.auth.sub],
      );
      const ticket = r.rows[0];
      await addCashTx(db, session, 'TICKET_ISSUE', amount, { ticketId: ticket.id, reference: ticket.barcode });
      await ticketEvent(db, req.auth.orgId, ticket.id, 'ISSUED', req.auth.sub, { sessionId: session.id });
      await writeAudit(db, { ...actor(req), casinoId: session.casino_id, action: 'ticket.issued', entityType: 'ticket', entityId: ticket.id, details: { barcode: ticket.barcode, amount } });
      return ticket;
    });
  });

  // ---- administrative ticket actions (supervisor / accounting) ----
  const reasonBody = z.object({ reason: z.string().trim().min(3).max(300) });

  for (const [action, status, event] of [['cancel', 'CANCELLED', 'CANCELLED'], ['void', 'VOID', 'VOIDED']] as const) {
    app.post(`/api/v1/tickets/:id/${action}`, { config: { feature: 'tito' }, preHandler: guard('ticket.manage') }, async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { reason } = reasonBody.parse(req.body);
      return idempotent(req, reply, async (db) => {
        const t = await loadTicket(db, req, id);
        // Step 7c: on the ledger a cancellation / void is a four-eyes request, executed when a second person approves.
        if (await titoOnLedger(db, req.auth.orgId, t.casino_id))
          return { id, status: t.status, approval: await requestTicketApproval(db, moneyActor(req), id, action === 'cancel' ? 'TITO_CANCEL' : 'TITO_VOID', reason) };
        requireValid(t);
        await db.query('UPDATE tickets SET status = $2, status_reason = $3 WHERE id = $1', [id, status, reason]);
        await ticketEvent(db, req.auth.orgId, id, event, req.auth.sub, { reason });
        await writeAudit(db, { ...actor(req), casinoId: t.casino_id, action: `ticket.${action}`, entityType: 'ticket', entityId: id, details: { barcode: t.barcode, amount: t.amount, reason } });
        return { id, status };
      });
    });
  }

  /** Step 7c: four-eyes approval request for a ticket payout above the casino's limit (decided under /api/v1/approvals/:id/decide). */
  app.post('/api/v1/tickets/:id/approval-request', { config: { feature: 'tito.cashier' }, preHandler: guard('ticket.payout') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return idempotent(req, reply, async (db) => requestTicketApproval(db, moneyActor(req), id, 'TITO_REDEEM_CASHIER'));
  });

  app.post('/api/v1/tickets/:id/reprint', { config: { feature: 'tito' }, preHandler: guard('ticket.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return idempotent(req, reply, async (db) => {
      const t = await loadTicket(db, req, id);
      requireValid(t);
      const r = await db.query('UPDATE tickets SET reprint_count = reprint_count + 1 WHERE id = $1 RETURNING reprint_count', [id]);
      await ticketEvent(db, req.auth.orgId, id, 'REPRINTED', req.auth.sub, { copy: r.rows[0].reprint_count });
      await writeAudit(db, { ...actor(req), casinoId: t.casino_id, action: 'ticket.reprinted', entityType: 'ticket', entityId: id, details: { barcode: t.barcode } });
      return { ...t, reprint_count: r.rows[0].reprint_count };
    });
  });

  /** Amount correction: the old ticket is cancelled and replaced by a new one (tickets are never edited). */
  app.post('/api/v1/tickets/:id/adjust', { config: { feature: 'tito' }, preHandler: guard('ticket.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { amount, reason } = z.object({ amount: z.number().positive().max(100000), reason: z.string().trim().min(3).max(300) }).parse(req.body);
    return idempotent(req, reply, async (db) => {
      const t = await loadTicket(db, req, id);
      if (await titoOnLedger(db, req.auth.orgId, t.casino_id))
        throw new HttpError(409, 'On the ledger an amount correction is a four-eyes cancellation plus a new ticket sale');
      requireValid(t);
      await db.query(`UPDATE tickets SET status = 'CANCELLED', status_reason = $2 WHERE id = $1`, [id, `Replaced: ${reason}`]);
      const n = await db.query(
        `INSERT INTO tickets (org_id, casino_id, barcode, amount, issued_by_machine_id, issued_by_employee, issued_at, expires_at, replaces_ticket_id)
         VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8) RETURNING *`,
        [t.org_id, t.casino_id, newBarcode(), amount, t.issued_by_machine_id, req.auth.sub, t.expires_at, id],
      );
      await ticketEvent(db, req.auth.orgId, id, 'REPLACED', req.auth.sub, { reason, newTicketId: n.rows[0].id, oldAmount: t.amount, newAmount: amount });
      await ticketEvent(db, req.auth.orgId, n.rows[0].id, 'ISSUED', req.auth.sub, { replaces: id, reason });
      await writeAudit(db, { ...actor(req), casinoId: t.casino_id, action: 'ticket.adjusted', entityType: 'ticket', entityId: id, details: { barcode: t.barcode, oldAmount: t.amount, newAmount: amount, newBarcode: n.rows[0].barcode, reason } });
      return n.rows[0];
    });
  });
}
