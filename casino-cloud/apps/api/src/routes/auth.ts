import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@m1/database';
import { ROLE_PERMISSIONS } from '@m1/shared';
import { entitlementView, loadEntitlements } from '../services/entitlements';
import { HttpError, guard, signToken } from '../auth';
import { pool } from '../db';

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/v1/auth/login', { config: { feature: 'public', rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const res = await pool.query('SELECT e.*, o.status AS org_status FROM employees e JOIN organizations o ON o.id = e.org_id WHERE lower(e.email) = lower($1)', [body.email]);
    const emp = res.rows[0];
    const ok = emp && emp.active && (await bcrypt.compare(body.password, emp.password_hash));
    if (ok && emp.org_status !== 'ACTIVE') {
      await writeAudit(pool, { orgId: emp.org_id, actorType: 'EMPLOYEE', actorId: emp.id, actorName: emp.email, action: 'auth.login_refused', ip: req.ip, details: { reason: 'organisation disabled' } });
      const e = new HttpError(403, 'This organisation is disabled.');
      e.body = { code: 'ORGANIZATION_DISABLED' };
      throw e;
    }
    if (!ok) {
      if (emp) await writeAudit(pool, { orgId: emp.org_id, actorType: 'EMPLOYEE', actorId: emp.id, actorName: emp.email, action: 'auth.login_failed', ip: req.ip });
      throw new HttpError(401, 'Invalid email or password');
    }
    await pool.query('UPDATE employees SET last_login_at = now() WHERE id = $1', [emp.id]);
    await writeAudit(pool, { orgId: emp.org_id, actorType: 'EMPLOYEE', actorId: emp.id, actorName: emp.email, action: 'auth.login', ip: req.ip });
    return { token: signToken({ sub: emp.id, orgId: emp.org_id, role: emp.role, name: emp.name, email: emp.email }) };
  });

  app.get('/api/v1/auth/me', { config: { feature: 'core' }, preHandler: guard() }, async (req) => {
    const { auth } = req;
    const [org, casinos, ent] = await Promise.all([
      pool.query('SELECT id, name, is_platform FROM organizations WHERE id = $1', [auth.orgId]),
      pool.query('SELECT id, code, name, city, country, timezone, currency FROM casinos WHERE org_id = $1 AND id = ANY($2) ORDER BY name', [auth.orgId, auth.casinoIds]),
      loadEntitlements(auth.orgId),
    ]);
    return {
      user: { id: auth.sub, name: auth.name, email: auth.email, role: auth.role, isPlatformAdmin: auth.isPlatformAdmin },
      organization: org.rows[0],
      permissions: ROLE_PERMISSIONS[auth.role],
      casinos: casinos.rows,
      entitlements: entitlementView(ent),
    };
  });
}

