import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@m1/database';
import { round2 } from '@m1/shared';
import { HttpError, actor, guard, scopeCasino } from '../auth';
import { bus, type BusMessage } from '../bus';
import { pool } from '../db';
import { expectedCollection } from '../services/collections';
import { idempotent } from '../services/idempotency';
import { openAlert } from '../services/alerts';

/** Expected cashbox content of a machine since its last collection, derived from the ledger. */
export async function cashRoutes(app: FastifyInstance) {
  app.get('/api/v1/cash/overview', { preHandler: guard('cashier.supervise') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    const today = `(date_trunc('day', now() AT TIME ZONE c.timezone) AT TIME ZONE c.timezone)`;
    const [byType, open, liability, collections] = await Promise.all([
      pool.query(
        `SELECT ct.type, sum(ct.amount) total, count(*) n FROM cash_transactions ct JOIN casinos c ON c.id = ct.casino_id
         WHERE ct.org_id = $1 AND ct.casino_id = $2 AND ct.created_at >= ${today} GROUP BY ct.type ORDER BY ct.type`,
        [req.auth.orgId, casinoId],
      ),
      pool.query(
        `SELECT count(*) sessions, COALESCE(sum(s.opening_balance + COALESCE((SELECT sum(amount) FROM cash_transactions ct WHERE ct.session_id = s.id), 0)), 0) AS in_drawers
         FROM cashier_sessions s WHERE s.org_id = $1 AND s.casino_id = $2 AND s.status = 'OPEN'`,
        [req.auth.orgId, casinoId],
      ),
      pool.query(`SELECT COALESCE(sum(amount), 0) AS liability, count(*) n FROM tickets WHERE org_id = $1 AND casino_id = $2 AND status = 'VALID'`, [req.auth.orgId, casinoId]),
      pool.query(
        `SELECT cc.*, m.asset_no, e.name AS collected_by_name FROM cash_collections cc JOIN machines m ON m.id = cc.machine_id JOIN employees e ON e.id = cc.collected_by
         WHERE cc.org_id = $1 AND cc.casino_id = $2 ORDER BY cc.created_at DESC LIMIT 50`,
        [req.auth.orgId, casinoId],
      ),
    ]);
    return { today: byType.rows, open: open.rows[0], tickets: liability.rows[0], collections: collections.rows };
  });

  app.get('/api/v1/cash/collections/expected/:machineId', { preHandler: guard('cash.manage') }, async (req) => {
    const { machineId } = z.object({ machineId: z.string().uuid() }).parse(req.params);
    const m = await pool.query('SELECT id, asset_no FROM machines WHERE id = $1 AND org_id = $2 AND casino_id = ANY($3)', [machineId, req.auth.orgId, req.auth.casinoIds]);
    if (!m.rowCount) throw new HttpError(404, 'Machine not found');
    // Step 7e: the one authoritative definition (services/collections.ts): CASHBOX ledger balance for a
    // ledger machine, machine-reported cash since the last collection for a legacy machine.
    const e = await expectedCollection(pool, req.auth.orgId, machineId);
    return { machineId, assetNo: m.rows[0].asset_no, basis: e.basis, since: e.since, cashCents: e.cashCents, ticketsCents: e.ticketsCents, cash: e.cashCents / 100, tickets: e.ticketsCents / 100 };
  });

  /** Records a machine drop count. Differences against the meters raise an alert. */
  app.post('/api/v1/cash/collections', { preHandler: guard('cash.manage') }, async (req, reply) => {
    const body = z.object({
      machineId: z.string().uuid(), countedCash: z.number().min(0).max(1e7), countedTickets: z.number().min(0).max(1e7), note: z.string().max(500).optional(),
    }).parse(req.body);
    const out: BusMessage[] = [];
    const result = await idempotent(req, reply, async (db) => {
      const m = await db.query('SELECT id, asset_no, casino_id FROM machines WHERE id = $1 AND org_id = $2 AND casino_id = ANY($3) FOR NO KEY UPDATE', [body.machineId, req.auth.orgId, req.auth.casinoIds]);
      if (!m.rowCount) throw new HttpError(404, 'Machine not found');
      if ((await db.query(`SELECT money_rail_ledger($1, $2, 'MACHINE', $3) AS l`, [req.auth.orgId, m.rows[0].casino_id, body.machineId])).rows[0].l)
        throw new HttpError(409, 'This machine is on the ledger: collect with a verified count (/api/v1/machines/:id/collections/count)');
      const e = await expectedCollection(db, req.auth.orgId, body.machineId);
      // first collection of a machine: the period starts with its first reported event (or now)
      const since = e.since ?? (await db.query('SELECT COALESCE(min(received_at), now()) AS t FROM machine_events WHERE machine_id = $1', [body.machineId])).rows[0].t;
      const exp = { since, cash: e.cashCents / 100, tickets: e.ticketsCents / 100 };
      const difference = round2(body.countedCash + body.countedTickets - exp.cash - exp.tickets);
      const r = await db.query(
        `INSERT INTO cash_collections (org_id, casino_id, machine_id, period_start, period_end, expected_cash, expected_tickets, counted_cash, counted_tickets, difference, note, collected_by)
         VALUES ($1,$2,$3,$4,now(),$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [req.auth.orgId, m.rows[0].casino_id, body.machineId, exp.since, exp.cash, exp.tickets, body.countedCash, body.countedTickets, difference, body.note ?? null, req.auth.sub],
      );
      if (difference !== 0)
        await openAlert(db, {
          orgId: req.auth.orgId, casinoId: m.rows[0].casino_id, machineId: body.machineId, type: 'DROP_DIFFERENCE', severity: Math.abs(difference) >= 50 ? 'CRITICAL' : 'WARNING',
          message: `Drop difference ${difference > 0 ? '+' : ''}${difference.toFixed(2)} EUR on ${m.rows[0].asset_no}`,
        }, out);
      await writeAudit(db, { ...actor(req), casinoId: m.rows[0].casino_id, action: 'cash.collection', entityType: 'machine', entityId: body.machineId, details: { assetNo: m.rows[0].asset_no, expectedCash: exp.cash, expectedTickets: exp.tickets, countedCash: body.countedCash, countedTickets: body.countedTickets, difference } });
      return r.rows[0];
    });
    out.forEach((msg) => bus.publish(msg));
    return result;
  });
}
