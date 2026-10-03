import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@m1/database';
import { HttpError, actor, guard, scopeCasino } from '../auth';
import { bus } from '../bus';
import { pool } from '../db';

export async function alertRoutes(app: FastifyInstance) {
  app.get('/api/v1/alerts', { preHandler: guard('alert.view') }, async (req) => {
    const qs = z.object({
      casinoId: z.string().uuid().optional(), status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'ACTIVE', 'ALL']).default('ACTIVE'),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).parse(req.query);
    const casinoId = scopeCasino(req, qs.casinoId);
    const filter = qs.status === 'ALL' ? '' : qs.status === 'ACTIVE' ? `AND a.status <> 'RESOLVED'` : `AND a.status = '${qs.status}'`;
    const r = await pool.query(
      `SELECT a.*, m.asset_no, g.device_id, e.email AS acknowledged_by_email
       FROM alerts a LEFT JOIN machines m ON m.id = a.machine_id LEFT JOIN gateways g ON g.id = a.gateway_id
       LEFT JOIN employees e ON e.id = a.acknowledged_by
       WHERE a.org_id = $1 AND a.casino_id = $2 ${filter} ORDER BY a.created_at DESC LIMIT $3`,
      [req.auth.orgId, casinoId, qs.limit],
    );
    return r.rows;
  });

  for (const action of ['acknowledge', 'resolve'] as const) {
    app.post(`/api/v1/alerts/:id/${action}`, { preHandler: guard('alert.manage') }, async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const sql =
        action === 'acknowledge'
          ? `UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_at = now(), acknowledged_by = $4 WHERE id = $1 AND org_id = $2 AND casino_id = ANY($3) AND status = 'OPEN' RETURNING id, casino_id, status`
          : `UPDATE alerts SET status = 'RESOLVED', resolved_at = now(), acknowledged_by = COALESCE(acknowledged_by, $4) WHERE id = $1 AND org_id = $2 AND casino_id = ANY($3) AND status <> 'RESOLVED' RETURNING id, casino_id, status`;
      const r = await pool.query(sql, [id, req.auth.orgId, req.auth.casinoIds, req.auth.sub]);
      if (!r.rowCount) throw new HttpError(404, 'Alert not found or already handled');
      const a = r.rows[0];
      await writeAudit(pool, { ...actor(req), casinoId: a.casino_id, action: `alert.${action}`, entityType: 'alert', entityId: id });
      bus.publish({ kind: 'alert.updated', orgId: req.auth.orgId, casinoId: a.casino_id, alertId: id, status: a.status });
      return a;
    });
  }
}
