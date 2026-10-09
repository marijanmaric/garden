import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction, writeAudit } from '@m1/database';
import { round2 } from '@m1/shared';
import { HttpError, actor, guard, scopeCasino } from '../auth';
import { bus, type BusMessage } from '../bus';
import { pool } from '../db';
import { openAlert } from '../services/alerts';

/** Expected cashbox content of a machine since its last collection, derived from the ledger. */
async function expectedDrop(orgId: string, machineId: string) {
  const r = await pool.query(
    `WITH last AS (SELECT max(period_end) AS since FROM cash_collections WHERE machine_id = $2)
     SELECT COALESCE((SELECT since FROM last), (SELECT min(occurred_at) FROM gaming_transactions WHERE machine_id = $2), now()) AS since,
       COALESCE(sum(t.amount) FILTER (WHERE t.type = 'CASH_IN'), 0) AS cash,
       COALESCE(sum(t.amount) FILTER (WHERE t.type = 'TICKET_IN'), 0) AS tickets
     FROM gaming_transactions t
     WHERE t.org_id = $1 AND t.machine_id = $2 AND t.occurred_at > COALESCE((SELECT since FROM last), '-infinity')`,
    [orgId, machineId],
  );
  return r.rows[0] as { since: string; cash: number; tickets: number };
}

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
    return { machineId, assetNo: m.rows[0].asset_no, ...(await expectedDrop(req.auth.orgId, machineId)) };
  });

  /** Records a machine drop count. Differences against the meters raise an alert. */
  app.post('/api/v1/cash/collections', { preHandler: guard('cash.manage') }, async (req) => {
    const body = z.object({
      machineId: z.string().uuid(), countedCash: z.number().min(0).max(1e7), countedTickets: z.number().min(0).max(1e7), note: z.string().max(500).optional(),
    }).parse(req.body);
    const out: BusMessage[] = [];
    const result = await withTransaction(pool, async (db) => {
      const m = await db.query('SELECT id, asset_no, casino_id FROM machines WHERE id = $1 AND org_id = $2 AND casino_id = ANY($3) FOR NO KEY UPDATE', [body.machineId, req.auth.orgId, req.auth.casinoIds]);
      if (!m.rowCount) throw new HttpError(404, 'Machine not found');
      const exp = await expectedDrop(req.auth.orgId, body.machineId);
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
