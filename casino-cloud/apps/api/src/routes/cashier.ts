import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@m1/database';
import { hasPermission, round2 } from '@m1/shared';
import { HttpError, actor, guard, scopeCasino } from '../auth';
import { bus, type BusMessage } from '../bus';
import { pool } from '../db';
import { idempotent } from '../services/idempotency';
import { requireUsableCard } from '../services/players';
import { payHandpay } from '../services/handpays';
import { openAlert, resolveAlerts } from '../services/alerts';
import { addCashTx, requireOpenSession, sessionTotals } from '../services/cashier';
import { cashOnLedger, submitCloseCount } from '../services/cash-ops';

const money = z.number().min(0).max(1_000_000);

export async function cashierRoutes(app: FastifyInstance) {
  /** Cash desks of the casino with their current shift and expected drawer balance. */
  app.get('/api/v1/cashier/desks', { preHandler: guard() }, async (req) => {
    if (!hasPermission(req.auth.role, 'cash.transact') && !hasPermission(req.auth.role, 'cashier.supervise')) throw new HttpError(403, 'Missing permission cash.transact');
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    const r = await pool.query(
      `SELECT d.id, d.name, d.kind, s.id AS session_id, s.opened_at, s.opening_balance, e.name AS employee,
         s.opening_balance + COALESCE((SELECT sum(amount) FROM cash_transactions ct WHERE ct.session_id = s.id), 0) AS balance,
         (SELECT count(*) FROM cash_transactions ct WHERE ct.session_id = s.id) AS transactions
       FROM cash_desks d
       LEFT JOIN cashier_sessions s ON s.cash_desk_id = d.id AND s.status = 'OPEN'
       LEFT JOIN employees e ON e.id = s.employee_id
       WHERE d.org_id = $1 AND d.casino_id = $2 AND d.active ORDER BY d.kind, d.name`,
      [req.auth.orgId, casinoId],
    );
    return r.rows;
  });

  /** The signed-in cashier's open shift, with totals and the latest movements. */
  app.get('/api/v1/cashier/session', { preHandler: guard('cash.transact') }, async (req) => {
    const r = await pool.query(
      `SELECT s.*, d.name AS desk_name, d.kind AS desk_kind FROM cashier_sessions s JOIN cash_desks d ON d.id = s.cash_desk_id
       WHERE s.org_id = $1 AND s.employee_id = $2 AND s.status = 'OPEN'`,
      [req.auth.orgId, req.auth.sub],
    );
    const s = r.rows[0];
    if (!s) return { session: null };
    // Ledger casinos: the cashier counts blind, the expected drawer balance is shown to supervisors only.
    const blind = (await cashOnLedger(pool, req.auth.orgId, s.casino_id)) && !hasPermission(req.auth.role, 'cashier.supervise');
    const [totals, tx] = await Promise.all([
      sessionTotals(pool, s.id, s.opening_balance),
      pool.query(
        `SELECT ct.id, ct.type, ct.amount, ct.reference, ct.created_at, m.asset_no, t.barcode
         FROM cash_transactions ct LEFT JOIN machines m ON m.id = ct.machine_id LEFT JOIN tickets t ON t.id = ct.ticket_id
         WHERE ct.session_id = $1 ORDER BY ct.id DESC LIMIT 30`,
        [s.id],
      ),
    ]);
    if (blind) return { session: { ...s, expected_balance: null, blind: true, expected: null, byType: {} }, transactions: tx.rows.map(({ amount: _a, ...t }) => t) };
    return { session: { ...s, ...totals }, transactions: tx.rows };
  });

  app.post('/api/v1/cashier/session/open', { preHandler: guard('cash.transact') }, async (req, reply) => {
    const body = z.object({ cashDeskId: z.string().uuid(), openingBalance: money }).parse(req.body);
    return idempotent(req, reply, async (db) => {
      const d = await db.query('SELECT id, casino_id FROM cash_desks WHERE id = $1 AND org_id = $2 AND casino_id = ANY($3) AND active', [body.cashDeskId, req.auth.orgId, req.auth.casinoIds]);
      if (!d.rowCount) throw new HttpError(404, 'Cash desk not found');
      if (body.openingBalance !== 0 && (await cashOnLedger(db, req.auth.orgId, d.rows[0].casino_id)))
        throw new HttpError(409, 'On the ledger a shift opens with an empty drawer: the float comes from the vault as a fill');
      try {
        const s = await db.query(
          `INSERT INTO cashier_sessions (org_id, casino_id, cash_desk_id, employee_id, opening_balance) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [req.auth.orgId, d.rows[0].casino_id, body.cashDeskId, req.auth.sub, body.openingBalance],
        );
        await writeAudit(db, { ...actor(req), casinoId: d.rows[0].casino_id, action: 'cashier.session_opened', entityType: 'cashier_session', entityId: s.rows[0].id, details: { cashDeskId: body.cashDeskId, openingBalance: body.openingBalance } });
        return s.rows[0];
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'This desk or this employee already has an open session');
        throw err;
      }
    });
  });

  /** Closes the shift: counted cash vs. expected balance. Any difference raises an alert. */
  app.post('/api/v1/cashier/session/close', { preHandler: guard('cash.transact') }, async (req, reply) => {
    const body = z.object({ countedBalance: money, note: z.string().max(500).optional() }).parse(req.body);
    const out: BusMessage[] = [];
    const result = await idempotent(req, reply, async (db) => {
      const ledgerSession = (await db.query(`SELECT casino_id FROM cashier_sessions WHERE org_id = $1 AND employee_id = $2 AND status IN ('OPEN', 'COUNTING')`, [req.auth.orgId, req.auth.sub])).rows[0];
      if (ledgerSession && (await cashOnLedger(db, req.auth.orgId, ledgerSession.casino_id))) {
        // Ledger casinos: blind count -> short / over (approval above the limit) -> final drop to the vault.
        return submitCloseCount(db, { orgId: req.auth.orgId, employeeId: req.auth.sub, employeeEmail: req.auth.email, ip: req.ip, casinoIds: req.auth.casinoIds },
          { totalCents: Math.round(body.countedBalance * 100), note: body.note });
      }
      const s = await requireOpenSession(db, req.auth.orgId, req.auth.sub);
      const { expected } = await sessionTotals(db, s.id, s.opening_balance);
      const difference = round2(body.countedBalance - expected);
      await db.query(
        `UPDATE cashier_sessions SET status = 'CLOSED', closed_at = now(), expected_balance = $2, counted_balance = $3, difference = $4, close_note = $5 WHERE id = $1`,
        [s.id, expected, body.countedBalance, difference, body.note ?? null],
      );
      if (difference !== 0) {
        const desk = await db.query('SELECT name FROM cash_desks WHERE id = $1', [s.cash_desk_id]);
        await openAlert(db, {
          orgId: s.org_id, casinoId: s.casino_id, type: 'CASH_DIFFERENCE', severity: Math.abs(difference) >= 50 ? 'CRITICAL' : 'WARNING',
          message: `Cash difference ${difference > 0 ? '+' : ''}${difference.toFixed(2)} EUR at ${desk.rows[0].name} (${req.auth.name})`,
        }, out);
      }
      await writeAudit(db, { ...actor(req), casinoId: s.casino_id, action: 'cashier.session_closed', entityType: 'cashier_session', entityId: s.id, details: { expected, counted: body.countedBalance, difference } });
      return { id: s.id, expected, counted: body.countedBalance, difference };
    });
    out.forEach((m) => bus.publish(m));
    return result;
  });

  app.get('/api/v1/cashier/sessions', { preHandler: guard('cashier.supervise') }, async (req) => {
    const qs = z.object({ casinoId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const casinoId = scopeCasino(req, qs.casinoId);
    const r = await pool.query(
      `SELECT s.id, s.status, s.opened_at, s.closed_at, s.opening_balance, s.expected_balance, s.counted_balance, s.difference, s.close_note,
         d.name AS desk, e.name AS employee,
         s.opening_balance + COALESCE((SELECT sum(amount) FROM cash_transactions ct WHERE ct.session_id = s.id), 0) AS current_balance
       FROM cashier_sessions s JOIN cash_desks d ON d.id = s.cash_desk_id JOIN employees e ON e.id = s.employee_id
       WHERE s.org_id = $1 AND s.casino_id = $2 ORDER BY s.opened_at DESC LIMIT $3`,
      [req.auth.orgId, casinoId, qs.limit],
    );
    return r.rows;
  });

  /** Manual drawer movements. Vault transfers and adjustments are supervisor operations. */
  app.post('/api/v1/cashier/transactions', { preHandler: guard('cash.transact') }, async (req, reply) => {
    const body = z.object({
      type: z.enum(['CASH_IN', 'CASH_OUT', 'FILL', 'DROP', 'ADJUSTMENT']),
      amount: z.number().refine((n) => n !== 0 && Math.abs(n) <= 1_000_000),
      reference: z.string().trim().max(200).optional(),
      playerCard: z.string().max(40).optional(),
    }).parse(req.body);
    if ((body.type === 'FILL' || body.type === 'DROP') && !hasPermission(req.auth.role, 'cash.manage')) throw new HttpError(403, 'Vault transfers need permission cash.manage');
    if (body.type === 'ADJUSTMENT') {
      if (!hasPermission(req.auth.role, 'cashier.supervise')) throw new HttpError(403, 'Adjustments need permission cashier.supervise');
      if (!body.reference || body.reference.length < 3) throw new HttpError(400, 'Adjustments need a reason');
    } else if (body.amount < 0) throw new HttpError(400, 'Amount must be positive');
    return idempotent(req, reply, async (db) => {
      const s = await requireOpenSession(db, req.auth.orgId, req.auth.sub);
      if (await cashOnLedger(db, req.auth.orgId, s.casino_id))
        throw new HttpError(409, body.type === 'FILL' || body.type === 'DROP'
          ? 'On the ledger fills and drops are vault movements confirmed by the receiving side (/api/v1/cash/movements)'
          : 'Generic cash in / out / adjustment is not available on the ledger: use an explicit money operation or a four-eyes adjustment');
      let playerId: string | undefined;
      if (body.playerCard) {
        // Reference only: the card identifies the player for this cash movement; it holds no money.
        playerId = (await requireUsableCard(db, req.auth.orgId, body.playerCard)).player.id;
      }
      const tx = await addCashTx(db, s, body.type, body.amount, { reference: body.reference, playerId });
      await writeAudit(db, { ...actor(req), casinoId: s.casino_id, action: `cash.${body.type.toLowerCase()}`, entityType: 'cash_transaction', entityId: String(tx.id), details: body });
      return tx;
    });
  });

  /** Unpaid handpays (PENDING / APPROVED) of the casino, from the handpay entity. */
  app.get('/api/v1/cashier/handpays', { preHandler: guard('cash.transact') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    const r = await pool.query(
      `SELECT m.id, m.asset_no, m.game, mm.manufacturer, f.name AS floor, m.position_label,
         h.id AS handpay_id, h.status AS handpay_status, h.source_event_id AS jackpot_event_id,
         h.amount_cents / 100.0 AS amount, h.amount_cents, e.occurred_at AS hit_at
       FROM handpays h
       JOIN machines m ON m.id = h.machine_id
       JOIN machine_events e ON e.event_id = h.source_event_id
       LEFT JOIN machine_models mm ON mm.id = m.model_id LEFT JOIN floors f ON f.id = m.floor_id
       WHERE h.org_id = $1 AND h.casino_id = $2 AND h.status IN ('PENDING', 'APPROVED')
       ORDER BY e.occurred_at`,
      [req.auth.orgId, casinoId],
    );
    return r.rows;
  });

  /**
   * Pays the unpaid handpay of a machine. Bound to the handpay entity (one per jackpot event) and,
   * through the legacy cash transaction, to the Step 1 unique index: a jackpot is paid at most once.
   * Payment does not depend on the machine; the reset is requested separately.
   */
  app.post('/api/v1/cashier/handpays/:machineId', { preHandler: guard('cash.transact') }, async (req, reply) => {
    const { machineId } = z.object({ machineId: z.string().uuid() }).parse(req.params);
    const { playerCard, jackpotEventId } = z.object({ playerCard: z.string().max(40).optional(), jackpotEventId: z.string().uuid().optional() }).parse(req.body ?? {});
    const out: BusMessage[] = [];
    const result = await idempotent(req, reply, async (db) => {
      const actorRef = { orgId: req.auth.orgId, employeeId: req.auth.sub, employeeEmail: req.auth.email, ip: req.ip };
      const open = await db.query(
        `SELECT id, source_event_id FROM handpays WHERE org_id = $1 AND machine_id = $2 AND casino_id = ANY($3) AND status IN ('PENDING', 'APPROVED')
         ORDER BY created_at DESC LIMIT 1`,
        [req.auth.orgId, machineId, req.auth.casinoIds],
      );
      const hp = open.rows[0];
      if (!hp) {
        const last = await db.query(`SELECT status FROM handpays WHERE org_id = $1 AND machine_id = $2 ORDER BY created_at DESC LIMIT 1`, [req.auth.orgId, machineId]);
        const alreadyPaid = ['PAID', 'MACHINE_RESET'].includes(last.rows[0]?.status);
        throw new HttpError(409, alreadyPaid ? 'Handpay already paid' : 'No pending jackpot on this machine');
      }
      if (jackpotEventId && jackpotEventId !== hp.source_event_id) {
        const paid = await db.query(`SELECT 1 FROM handpays WHERE source_event_id = $1 AND status IN ('PAID', 'MACHINE_RESET')`, [jackpotEventId]);
        throw new HttpError(409, paid.rowCount ? 'Handpay already paid' : 'This jackpot is no longer the pending one');
      }
      const playerId = playerCard ? (await requireUsableCard(db, req.auth.orgId, playerCard)).player.id : null;
      const paid = await payHandpay(db, actorRef, hp.id, { playerId });
      await resolveAlerts(db, { orgId: req.auth.orgId, casinoId: paid.handpay.casino_id, type: 'JACKPOT', machineId }, out);
      const asset = (await db.query('SELECT asset_no FROM machines WHERE id = $1', [machineId])).rows[0].asset_no;
      return { transaction: paid.transaction, amount: paid.handpay.amount_cents / 100, assetNo: asset, jackpotEventId: paid.handpay.source_event_id, handpayId: paid.handpay.id, status: paid.handpay.status };
    });
    out.forEach((msg) => bus.publish(msg));
    return result;
  });
}
