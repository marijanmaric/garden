import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction, writeAudit } from '@m1/database';
import { hasPermission, round2 } from '@m1/shared';
import { HttpError, actor, guard, scopeCasino } from '../auth';
import { bus, type BusMessage } from '../bus';
import { pool } from '../db';
import { openAlert, resolveAlerts } from '../services/alerts';
import { addCashTx, requireOpenSession, sessionTotals } from '../services/cashier';

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
    const [totals, tx] = await Promise.all([
      sessionTotals(pool, s.id, s.opening_balance),
      pool.query(
        `SELECT ct.id, ct.type, ct.amount, ct.reference, ct.created_at, m.asset_no, t.barcode
         FROM cash_transactions ct LEFT JOIN machines m ON m.id = ct.machine_id LEFT JOIN tickets t ON t.id = ct.ticket_id
         WHERE ct.session_id = $1 ORDER BY ct.id DESC LIMIT 30`,
        [s.id],
      ),
    ]);
    return { session: { ...s, ...totals }, transactions: tx.rows };
  });

  app.post('/api/v1/cashier/session/open', { preHandler: guard('cash.transact') }, async (req) => {
    const body = z.object({ cashDeskId: z.string().uuid(), openingBalance: money }).parse(req.body);
    return withTransaction(pool, async (db) => {
      const d = await db.query('SELECT id, casino_id FROM cash_desks WHERE id = $1 AND org_id = $2 AND casino_id = ANY($3) AND active', [body.cashDeskId, req.auth.orgId, req.auth.casinoIds]);
      if (!d.rowCount) throw new HttpError(404, 'Cash desk not found');
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
  app.post('/api/v1/cashier/session/close', { preHandler: guard('cash.transact') }, async (req) => {
    const body = z.object({ countedBalance: money, note: z.string().max(500).optional() }).parse(req.body);
    const out: BusMessage[] = [];
    const result = await withTransaction(pool, async (db) => {
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
  app.post('/api/v1/cashier/transactions', { preHandler: guard('cash.transact') }, async (req) => {
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
    return withTransaction(pool, async (db) => {
      const s = await requireOpenSession(db, req.auth.orgId, req.auth.sub);
      let playerId: string | undefined;
      if (body.playerCard) {
        const p = await db.query('SELECT id FROM players WHERE org_id = $1 AND card_number = $2', [req.auth.orgId, body.playerCard]);
        if (!p.rowCount) throw new HttpError(404, 'Unknown player card');
        playerId = p.rows[0].id;
      }
      const tx = await addCashTx(db, s, body.type, body.amount, { reference: body.reference, playerId });
      await writeAudit(db, { ...actor(req), casinoId: s.casino_id, action: `cash.${body.type.toLowerCase()}`, entityType: 'cash_transaction', entityId: String(tx.id), details: body });
      return tx;
    });
  });

  /** Machines waiting for a jackpot handpay, with the amount to pay. */
  app.get('/api/v1/cashier/handpays', { preHandler: guard('cash.transact') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    const r = await pool.query(
      `SELECT m.id, m.asset_no, m.game, mm.manufacturer, f.name AS floor, m.position_label,
         (SELECT e.amount FROM machine_events e WHERE e.machine_id = m.id AND e.type = 'JACKPOT' ORDER BY e.occurred_at DESC LIMIT 1) AS amount,
         (SELECT e.occurred_at FROM machine_events e WHERE e.machine_id = m.id AND e.type = 'JACKPOT' ORDER BY e.occurred_at DESC LIMIT 1) AS hit_at
       FROM machines m LEFT JOIN machine_models mm ON mm.id = m.model_id LEFT JOIN floors f ON f.id = m.floor_id
       WHERE m.org_id = $1 AND m.casino_id = $2 AND m.jackpot_pending ORDER BY m.asset_no`,
      [req.auth.orgId, casinoId],
    );
    return r.rows;
  });

  /** Pays a jackpot handpay from the drawer and tells the machine (via gateway) that the handpay is done. */
  app.post('/api/v1/cashier/handpays/:machineId', { preHandler: guard('cash.transact') }, async (req) => {
    const { machineId } = z.object({ machineId: z.string().uuid() }).parse(req.params);
    const { playerCard } = z.object({ playerCard: z.string().max(40).optional() }).parse(req.body ?? {});
    const out: BusMessage[] = [];
    const result = await withTransaction(pool, async (db) => {
      const s = await requireOpenSession(db, req.auth.orgId, req.auth.sub);
      const m = await db.query('SELECT * FROM machines WHERE id = $1 AND org_id = $2 AND casino_id = $3 FOR NO KEY UPDATE', [machineId, req.auth.orgId, s.casino_id]);
      const machine = m.rows[0];
      if (!machine) throw new HttpError(404, 'Machine not found');
      if (!machine.jackpot_pending) throw new HttpError(409, 'No pending jackpot on this machine');
      const jp = await db.query(`SELECT amount FROM machine_events WHERE machine_id = $1 AND type = 'JACKPOT' ORDER BY occurred_at DESC LIMIT 1`, [machineId]);
      const amount = jp.rows[0]?.amount;
      if (!amount) throw new HttpError(409, 'Jackpot amount unknown');
      let playerId: string | undefined;
      if (playerCard) {
        const p = await db.query('SELECT id FROM players WHERE org_id = $1 AND card_number = $2', [req.auth.orgId, playerCard]);
        playerId = p.rows[0]?.id;
      }
      const tx = await addCashTx(db, s, 'HANDPAY', amount, { machineId, playerId, reference: `Jackpot ${machine.asset_no}` });
      if (machine.gateway_id)
        await db.query(`INSERT INTO machine_commands (org_id, machine_id, gateway_id, type, requested_by) VALUES ($1,$2,$3,'RESET_JACKPOT',$4)`, [req.auth.orgId, machineId, machine.gateway_id, req.auth.sub]);
      await resolveAlerts(db, { orgId: req.auth.orgId, casinoId: s.casino_id, type: 'JACKPOT', machineId }, out);
      await writeAudit(db, { ...actor(req), casinoId: s.casino_id, action: 'cash.handpay', entityType: 'machine', entityId: machineId, details: { assetNo: machine.asset_no, amount } });
      return { transaction: tx, amount, assetNo: machine.asset_no };
    });
    out.forEach((m) => bus.publish(m));
    return result;
  });
}
