import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction, writeAudit } from '@m1/database';
import { HttpError, actor, guard, scopeCasino } from '../auth';
import { pool } from '../db';

const fixture = z.object({
  id: z.string().max(40), label: z.string().max(40), kind: z.string().max(20),
  x: z.number().int().min(0).max(5000), y: z.number().int().min(0).max(5000),
  w: z.number().int().min(10).max(5000), h: z.number().int().min(10).max(5000),
});

export async function floorRoutes(app: FastifyInstance) {
  app.get('/api/v1/floors', { preHandler: guard('floor.view') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    const [floors, machines] = await Promise.all([
      pool.query('SELECT id, name, width, height, layout FROM floors WHERE org_id = $1 AND casino_id = $2 ORDER BY sort_order, name', [req.auth.orgId, casinoId]),
      pool.query(
        `SELECT m.id, m.floor_id, m.asset_no, m.machine_code, m.game, m.status, m.pos_x, m.pos_y, m.position_label, mm.manufacturer,
           (m.current_player_id IS NOT NULL) AS has_player
         FROM machines m LEFT JOIN machine_models mm ON mm.id = m.model_id WHERE m.org_id = $1 AND m.casino_id = $2 ORDER BY m.asset_no`,
        [req.auth.orgId, casinoId],
      ),
    ]);
    return floors.rows.map((f) => ({ ...f, machines: machines.rows.filter((m) => m.floor_id === f.id) }));
  });

  /** Saves machine positions and fixtures of a floor (drag & drop editor). Configuration changes are audited. */
  app.put('/api/v1/floors/:id/layout', { preHandler: guard('floor.edit') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      machines: z.array(z.object({ id: z.string().uuid(), x: z.number().int().min(0).max(5000), y: z.number().int().min(0).max(5000) })).max(2000),
      fixtures: z.array(fixture).max(200),
    }).parse(req.body);
    await withTransaction(pool, async (db) => {
      const f = await db.query('SELECT id, casino_id, layout FROM floors WHERE id = $1 AND org_id = $2 AND casino_id = ANY($3)', [id, req.auth.orgId, req.auth.casinoIds]);
      if (!f.rowCount) throw new HttpError(404, 'Floor not found');
      await db.query('UPDATE floors SET layout = $2 WHERE id = $1', [id, JSON.stringify(body.fixtures)]);
      for (const m of body.machines)
        await db.query('UPDATE machines SET pos_x = $2, pos_y = $3, floor_id = $4 WHERE id = $1 AND org_id = $5 AND casino_id = $6', [m.id, m.x, m.y, id, req.auth.orgId, f.rows[0].casino_id]);
      await writeAudit(db, { ...actor(req), casinoId: f.rows[0].casino_id, action: 'floor.layout_updated', entityType: 'floor', entityId: id, details: { machines: body.machines.length, fixtures: body.fixtures.length } });
    });
    return { ok: true };
  });
}
