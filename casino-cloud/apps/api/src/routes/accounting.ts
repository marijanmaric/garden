import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@m1/database';
import { LEDGER_TYPES } from '@m1/shared';
import { actor, guard, scopeCasino } from '../auth';
import { pool } from '../db';
import { financialSummary } from './dashboard';

export async function accountingRoutes(app: FastifyInstance) {
  app.get('/api/v1/accounting/summary', { preHandler: guard('accounting.view') }, async (req) => {
    const qs = z.object({ casinoId: z.string().uuid().optional(), days: z.coerce.number().int().min(1).max(90).default(1) }).parse(req.query);
    const casinoId = scopeCasino(req, qs.casinoId);
    const from = `((date_trunc('day', now() AT TIME ZONE c.timezone) - make_interval(days => $3 - 1)) AT TIME ZONE c.timezone)`;
    const [summary, daily, byMachine] = await Promise.all([
      financialSummary(req.auth.orgId, casinoId, from, [qs.days]),
      pool.query(
        `SELECT (t.occurred_at AT TIME ZONE c.timezone)::date AS day,
           COALESCE(sum(amount) FILTER (WHERE type = 'WAGER'), 0) coin_in,
           COALESCE(sum(amount) FILTER (WHERE type = 'WIN'), 0) coin_out,
           COALESCE(sum(amount) FILTER (WHERE type = 'JACKPOT'), 0) jackpots,
           COALESCE(sum(amount) FILTER (WHERE type = 'TICKET_OUT'), 0) tickets_out
         FROM gaming_transactions t JOIN casinos c ON c.id = t.casino_id
         WHERE t.org_id = $1 AND t.casino_id = $2 AND t.occurred_at >= now() - interval '14 days'
         GROUP BY 1 ORDER BY 1`,
        [req.auth.orgId, casinoId],
      ),
      pool.query(
        `SELECT m.id, m.asset_no, mm.manufacturer, m.game,
           COALESCE(sum(t.amount) FILTER (WHERE t.type = 'WAGER'), 0) coin_in,
           COALESCE(sum(t.amount) FILTER (WHERE t.type = 'WIN'), 0) coin_out,
           COALESCE(sum(t.amount) FILTER (WHERE t.type = 'JACKPOT'), 0) jackpots
         FROM machines m JOIN casinos c ON c.id = m.casino_id LEFT JOIN machine_models mm ON mm.id = m.model_id
         LEFT JOIN gaming_transactions t ON t.machine_id = m.id AND t.occurred_at >= ${from}
         WHERE m.org_id = $1 AND m.casino_id = $2 GROUP BY m.id, mm.manufacturer ORDER BY m.asset_no`,
        [req.auth.orgId, casinoId, qs.days],
      ),
    ]);
    return {
      summary,
      daily: daily.rows.map((d) => ({ ...d, ggr: d.coin_in - d.coin_out - d.jackpots })),
      byMachine: byMachine.rows.map((d) => ({ ...d, ggr: d.coin_in - d.coin_out - d.jackpots })),
    };
  });

  app.get('/api/v1/transactions', { preHandler: guard('accounting.view') }, async (req) => {
    const qs = z.object({
      casinoId: z.string().uuid().optional(), type: z.enum(LEDGER_TYPES).optional(), machineId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().optional(),
    }).parse(req.query);
    const casinoId = scopeCasino(req, qs.casinoId);
    const params: unknown[] = [req.auth.orgId, casinoId];
    let where = 't.org_id = $1 AND t.casino_id = $2';
    if (qs.type) { params.push(qs.type); where += ` AND t.type = $${params.length}`; }
    if (qs.machineId) { params.push(qs.machineId); where += ` AND t.machine_id = $${params.length}`; }
    if (qs.before) { params.push(qs.before); where += ` AND t.id < $${params.length}`; }
    params.push(qs.limit);
    const r = await pool.query(
      `SELECT t.id, t.type, t.amount, t.occurred_at, t.recorded_at, t.reference, t.source_event_id, m.asset_no, e.email AS created_by
       FROM gaming_transactions t LEFT JOIN machines m ON m.id = t.machine_id LEFT JOIN employees e ON e.id = t.created_by
       WHERE ${where} ORDER BY t.id DESC LIMIT $${params.length}`,
      params,
    );
    return r.rows;
  });

  /** Corrections never modify the ledger; they append an ADJUSTMENT entry with a mandatory reason. */
  app.post('/api/v1/transactions/adjustments', { preHandler: guard('casino.manage') }, async (req) => {
    const body = z.object({
      casinoId: z.string().uuid(), machineId: z.string().uuid().optional(), amount: z.number().refine((n) => n !== 0).refine((n) => Math.abs(n) < 1e9),
      reason: z.string().min(3).max(500),
    }).parse(req.body);
    const casinoId = scopeCasino(req, body.casinoId);
    const r = await pool.query(
      `INSERT INTO gaming_transactions (org_id, casino_id, machine_id, type, amount, reference, created_by, occurred_at)
       SELECT $1, $2, m.id, 'ADJUSTMENT', $4, $5, $6, now()
       FROM (SELECT $3::uuid AS id) x LEFT JOIN machines m ON m.id = x.id AND m.org_id = $1 AND m.casino_id = $2
       RETURNING id`,
      [req.auth.orgId, casinoId, body.machineId ?? null, body.amount, body.reason, req.auth.sub],
    );
    await writeAudit(pool, { ...actor(req), casinoId, action: 'ledger.adjustment', entityType: 'gaming_transaction', entityId: String(r.rows[0].id), details: body });
    return r.rows[0];
  });
}
