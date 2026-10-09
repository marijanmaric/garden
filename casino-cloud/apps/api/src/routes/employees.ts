import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTransaction, writeAudit, type PoolClient } from '@m1/database';
import { ROLES, ROLE_PERMISSIONS } from '@m1/shared';
import { HttpError, actor, guard } from '../auth';
import { pool } from '../db';

const base = {
  name: z.string().trim().min(2).max(100),
  role: z.enum(ROLES),
  casinoIds: z.array(z.string().uuid()).max(100),
  phone: z.string().trim().max(40).optional(),
};
const createSchema = z.object({ ...base, email: z.string().trim().toLowerCase().email(), password: z.string().min(8).max(200) });
const updateSchema = z.object({ ...base, active: z.boolean(), password: z.string().min(8).max(200).optional() });

/** Only a SUPER_ADMIN may create or modify SUPER_ADMIN accounts. */
function checkRoleChange(req: FastifyRequest, role: string) {
  if (role === 'SUPER_ADMIN' && req.auth.role !== 'SUPER_ADMIN') throw new HttpError(403, 'Only a super admin can assign SUPER_ADMIN');
}

async function setCasinos(db: PoolClient, req: FastifyRequest, employeeId: string, casinoIds: string[]) {
  const invalid = casinoIds.filter((c) => !req.auth.casinoIds.includes(c));
  if (invalid.length) throw new HttpError(403, 'You can only grant access to casinos you can access yourself');
  await db.query('DELETE FROM employee_casinos WHERE employee_id = $1 AND casino_id = ANY($2)', [employeeId, req.auth.casinoIds]);
  for (const c of casinoIds) await db.query('INSERT INTO employee_casinos (employee_id, casino_id, org_id) VALUES ($1,$2,$3)', [employeeId, c, req.auth.orgId]);
}

export async function employeeRoutes(app: FastifyInstance) {
  app.get('/api/v1/employees', { preHandler: guard('employee.view') }, async (req) => {
    const r = await pool.query(
      `SELECT e.id, e.email, e.name, e.role, e.active, e.phone, e.last_login_at, e.created_at,
         COALESCE((SELECT json_agg(json_build_object('id', c.id, 'name', c.name)) FROM employee_casinos ec JOIN casinos c ON c.id = ec.casino_id WHERE ec.employee_id = e.id), '[]') casinos,
         (SELECT d.name FROM cashier_sessions s JOIN cash_desks d ON d.id = s.cash_desk_id WHERE s.employee_id = e.id AND s.status = 'OPEN') AS open_desk
       FROM employees e WHERE e.org_id = $1 ORDER BY e.active DESC, e.name`,
      [req.auth.orgId],
    );
    return { employees: r.rows, rolePermissions: ROLE_PERMISSIONS };
  });

  app.post('/api/v1/employees', { preHandler: guard('user.manage') }, async (req) => {
    const body = createSchema.parse(req.body);
    checkRoleChange(req, body.role);
    return withTransaction(pool, async (db) => {
      const hash = await bcrypt.hash(body.password, 10);
      let id: string;
      try {
        id = (await db.query('INSERT INTO employees (org_id, email, name, password_hash, role, phone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [
          req.auth.orgId, body.email, body.name, hash, body.role, body.phone ?? null,
        ])).rows[0].id;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'Email already in use');
        throw err;
      }
      await setCasinos(db, req, id, body.casinoIds);
      await writeAudit(db, { ...actor(req), action: 'employee.created', entityType: 'employee', entityId: id, details: { email: body.email, role: body.role, casinoIds: body.casinoIds } });
      return { id };
    });
  });

  app.put('/api/v1/employees/:id', { preHandler: guard('user.manage') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = updateSchema.parse(req.body);
    return withTransaction(pool, async (db) => {
      const r = await db.query('SELECT * FROM employees WHERE id = $1 AND org_id = $2 FOR NO KEY UPDATE', [id, req.auth.orgId]);
      const e = r.rows[0];
      if (!e) throw new HttpError(404, 'Employee not found');
      checkRoleChange(req, e.role);
      checkRoleChange(req, body.role);
      if (id === req.auth.sub && (!body.active || body.role !== e.role)) throw new HttpError(409, 'You cannot deactivate yourself or change your own role');
      const hash = body.password ? await bcrypt.hash(body.password, 10) : null;
      await db.query(
        `UPDATE employees SET name = $2, role = $3, active = $4, phone = $5, password_hash = COALESCE($6, password_hash), updated_at = now() WHERE id = $1`,
        [id, body.name, body.role, body.active, body.phone ?? null, hash],
      );
      await setCasinos(db, req, id, body.casinoIds);
      const changes: Record<string, unknown> = {};
      if (e.role !== body.role) changes.role = { from: e.role, to: body.role };
      if (e.active !== body.active) changes.active = body.active;
      if (e.name !== body.name) changes.name = body.name;
      if (hash) changes.passwordReset = true;
      await writeAudit(db, { ...actor(req), action: 'employee.updated', entityType: 'employee', entityId: id, details: { email: e.email, ...changes, casinoIds: body.casinoIds } });
      return { id };
    });
  });

  /** Activity of one employee: audit trail and cashier shifts. */
  app.get('/api/v1/employees/:id/activity', { preHandler: guard('employee.view') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const e = await pool.query('SELECT id FROM employees WHERE id = $1 AND org_id = $2', [id, req.auth.orgId]);
    if (!e.rowCount) throw new HttpError(404, 'Employee not found');
    const [audit, sessions] = await Promise.all([
      pool.query(`SELECT id, action, entity_type, entity_id, details, created_at FROM audit_logs WHERE org_id = $1 AND actor_id = $2 ORDER BY id DESC LIMIT 100`, [req.auth.orgId, id]),
      pool.query(
        `SELECT s.id, s.status, s.opened_at, s.closed_at, s.opening_balance, s.expected_balance, s.counted_balance, s.difference, d.name AS desk
         FROM cashier_sessions s JOIN cash_desks d ON d.id = s.cash_desk_id WHERE s.employee_id = $1 ORDER BY s.opened_at DESC LIMIT 30`,
        [id],
      ),
    ]);
    return { audit: audit.rows, sessions: sessions.rows };
  });
}
