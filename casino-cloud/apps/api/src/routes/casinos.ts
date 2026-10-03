import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@m1/database';
import { MODULES, ROLE_PERMISSIONS } from '@m1/shared';
import { HttpError, actor, guard, scopeCasino } from '../auth';
import { pool } from '../db';

export async function casinoRoutes(app: FastifyInstance) {
  app.get('/api/v1/casinos', { preHandler: guard('casino.view') }, async (req) => {
    const r = await pool.query(
      `SELECT c.id, c.code, c.name, c.city, c.country, c.timezone, c.currency,
         (SELECT count(*) FROM floors f WHERE f.casino_id = c.id) floors,
         (SELECT count(*) FROM machines m WHERE m.casino_id = c.id) machines,
         (SELECT count(*) FROM machines m WHERE m.casino_id = c.id AND m.status NOT IN ('OFFLINE','MAINTENANCE')) online,
         (SELECT count(*) FROM alerts a WHERE a.casino_id = c.id AND a.status <> 'RESOLVED') open_alerts,
         (SELECT json_agg(json_build_object('id', f.id, 'name', f.name, 'machines', (SELECT count(*) FROM machines m WHERE m.floor_id = f.id)) ORDER BY f.sort_order)
            FROM floors f WHERE f.casino_id = c.id) floor_list
       FROM casinos c WHERE c.org_id = $1 AND c.id = ANY($2) ORDER BY c.name`,
      [req.auth.orgId, req.auth.casinoIds],
    );
    return r.rows;
  });

  app.get('/api/v1/casinos/:id/modules', { preHandler: guard('casino.view') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ id: z.string().uuid() }).parse(req.params).id);
    const r = await pool.query('SELECT module_key, enabled, updated_at FROM casino_modules WHERE org_id = $1 AND casino_id = $2', [req.auth.orgId, casinoId]);
    return MODULES.map((m) => {
      const row = r.rows.find((x) => x.module_key === m.key);
      return { ...m, enabled: !!m.core || !!row?.enabled, updatedAt: row?.updated_at ?? null };
    });
  });

  app.put('/api/v1/casinos/:id/modules/:key', { preHandler: guard('settings.manage') }, async (req) => {
    const p = z.object({ id: z.string().uuid(), key: z.string() }).parse(req.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const casinoId = scopeCasino(req, p.id);
    const mod = MODULES.find((m) => m.key === p.key);
    if (!mod) throw new HttpError(404, 'Unknown module');
    if (mod.core) throw new HttpError(409, 'Core modules cannot be disabled');
    await pool.query(
      `INSERT INTO casino_modules (org_id, casino_id, module_key, enabled) VALUES ($1,$2,$3,$4)
       ON CONFLICT (casino_id, module_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [req.auth.orgId, casinoId, p.key, enabled],
    );
    await writeAudit(pool, { ...actor(req), casinoId, action: enabled ? 'module.enabled' : 'module.disabled', entityType: 'module', entityId: p.key });
    return { key: p.key, enabled };
  });

  app.get('/api/v1/players', { preHandler: guard('player.view') }, async (req) => {
    const qs = z.object({ search: z.string().optional() }).parse(req.query);
    const r = await pool.query(
      `SELECT p.id, p.card_number, p.first_name, p.last_name, p.tier, floor(p.points) points, p.total_coin_in, p.visits, p.last_visit_at,
         m.asset_no AS current_machine
       FROM players p LEFT JOIN machines m ON m.current_player_id = p.id
       WHERE p.org_id = $1 AND ($2::text IS NULL OR p.card_number ILIKE $2 OR p.first_name || ' ' || p.last_name ILIKE $2)
       ORDER BY p.total_coin_in DESC LIMIT 200`,
      [req.auth.orgId, qs.search ? `%${qs.search}%` : null],
    );
    return r.rows;
  });

  app.get('/api/v1/jackpots', { preHandler: guard('jackpot.view') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    const r = await pool.query('SELECT * FROM jackpots WHERE org_id = $1 AND casino_id = $2 ORDER BY current_value DESC', [req.auth.orgId, casinoId]);
    return r.rows;
  });

  app.get('/api/v1/employees', { preHandler: guard('employee.view') }, async (req) => {
    const r = await pool.query(
      `SELECT e.id, e.email, e.name, e.role, e.active, e.last_login_at, e.created_at,
         (SELECT json_agg(c.name) FROM employee_casinos ec JOIN casinos c ON c.id = ec.casino_id WHERE ec.employee_id = e.id) casinos
       FROM employees e WHERE e.org_id = $1 ORDER BY e.name`,
      [req.auth.orgId],
    );
    return { employees: r.rows, rolePermissions: ROLE_PERMISSIONS };
  });
}
