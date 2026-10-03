import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@m1/database';
import { MODULES, ROLE_PERMISSIONS } from '@m1/shared';
import { HttpError, guard, signToken } from '../auth';
import { pool } from '../db';

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/v1/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const res = await pool.query('SELECT * FROM employees WHERE lower(email) = lower($1)', [body.email]);
    const emp = res.rows[0];
    const ok = emp && emp.active && (await bcrypt.compare(body.password, emp.password_hash));
    if (!ok) {
      if (emp) await writeAudit(pool, { orgId: emp.org_id, actorType: 'EMPLOYEE', actorId: emp.id, actorName: emp.email, action: 'auth.login_failed', ip: req.ip });
      throw new HttpError(401, 'Invalid email or password');
    }
    await pool.query('UPDATE employees SET last_login_at = now() WHERE id = $1', [emp.id]);
    await writeAudit(pool, { orgId: emp.org_id, actorType: 'EMPLOYEE', actorId: emp.id, actorName: emp.email, action: 'auth.login', ip: req.ip });
    return { token: signToken({ sub: emp.id, orgId: emp.org_id, role: emp.role, name: emp.name, email: emp.email }) };
  });

  app.get('/api/v1/auth/me', { preHandler: guard() }, async (req) => {
    const { auth } = req;
    const [org, casinos, modules] = await Promise.all([
      pool.query('SELECT id, name FROM organizations WHERE id = $1', [auth.orgId]),
      pool.query('SELECT id, code, name, city, country, timezone, currency FROM casinos WHERE org_id = $1 AND id = ANY($2) ORDER BY name', [auth.orgId, auth.casinoIds]),
      pool.query('SELECT casino_id, module_key, enabled FROM casino_modules WHERE org_id = $1 AND casino_id = ANY($2)', [auth.orgId, auth.casinoIds]),
    ]);
    return {
      user: { id: auth.sub, name: auth.name, email: auth.email, role: auth.role },
      organization: org.rows[0],
      permissions: ROLE_PERMISSIONS[auth.role],
      casinos: casinos.rows.map((c) => ({
        ...c,
        modules: Object.fromEntries(
          MODULES.map((m) => [m.key, !!m.core || !!modules.rows.find((r) => r.casino_id === c.id && r.module_key === m.key && r.enabled)]),
        ),
      })),
    };
  });
}
