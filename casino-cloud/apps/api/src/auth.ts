import jwt from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hasPermission, type Feature, type Permission, type Role } from '@m1/shared';
import { config } from './config';
import { pool } from './db';

export interface TokenClaims {
  sub: string;
  orgId: string;
  role: Role;
  name: string;
  email: string;
}

export interface AuthContext extends TokenClaims {
  casinoIds: string[];
  /** Platform administrator (member of the platform organisation): may use the /platform API. */
  isPlatformAdmin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
  interface FastifyContextConfig {
    /**
     * The commercial feature this route belongs to (packages/shared/src/entitlements.ts). Every /api/v1 route
     * declares one; the guard enforces it after authentication and role, before the handler.
     */
    feature?: Feature | 'platform' | 'gateway' | 'public';
  }
}

export class HttpError extends Error {
  /** Extra fields for the error response (e.g. a cutover report). */
  body?: Record<string, unknown>;
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function signToken(claims: TokenClaims): string {
  return jwt.sign(claims, config.jwtSecret, { expiresIn: config.jwtTtl });
}

export function verifyToken(token: string): TokenClaims {
  return jwt.verify(token, config.jwtSecret) as TokenClaims;
}

/**
 * Casinos the employee may operate. Super admins see every casino of their organisation. Inactive casinos
 * are not operable by anyone (the organisation admin manages them through /org/casinos).
 */
export async function accessibleCasinoIds(claims: TokenClaims): Promise<string[]> {
  const res =
    claims.role === 'SUPER_ADMIN'
      ? await pool.query(`SELECT id FROM casinos WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY name`, [claims.orgId])
      : await pool.query(
          `SELECT c.id FROM employee_casinos ec JOIN casinos c ON c.id = ec.casino_id
           WHERE ec.employee_id = $1 AND c.org_id = $2 AND c.status = 'ACTIVE' ORDER BY c.name`,
          [claims.sub, claims.orgId],
        );
  return res.rows.map((r) => r.id);
}

export async function authenticate(req: FastifyRequest, token: string | undefined): Promise<AuthContext> {
  if (!token) throw new HttpError(401, 'Missing token');
  let claims: TokenClaims;
  try {
    claims = verifyToken(token);
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }
  const emp = await pool.query(
    `SELECT e.active, e.role, e.is_platform_admin, o.status AS org_status, o.is_platform
     FROM employees e JOIN organizations o ON o.id = e.org_id WHERE e.id = $1 AND e.org_id = $2`, [claims.sub, claims.orgId]);
  if (!emp.rowCount || !emp.rows[0].active) throw new HttpError(401, 'Account disabled');
  if (emp.rows[0].org_status !== 'ACTIVE') throw orgDisabled();
  claims.role = emp.rows[0].role; // role changes take effect immediately
  req.auth = { ...claims, casinoIds: await accessibleCasinoIds(claims), isPlatformAdmin: emp.rows[0].is_platform_admin && emp.rows[0].is_platform };
  return req.auth;
}

const orgDisabled = () => {
  const e = new HttpError(403, 'This organisation is disabled.');
  e.body = { code: 'ORGANIZATION_DISABLED' };
  return e;
};

/**
 * Route guard. Evaluation order: authentication -> tenant (organisation active) -> role permission ->
 * commercial entitlement of the route's feature. Casino scope, rail state, business rules and the money
 * service follow in the handler. A route without a declared feature is refused (fail closed).
 */
export function guard(permission?: Permission) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization;
    await authenticate(req, header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (permission && !hasPermission(req.auth.role, permission)) throw new HttpError(403, `Missing permission ${permission}`);
    const feature = req.routeOptions.config?.feature;
    if (!feature) throw new HttpError(500, 'Route without entitlement feature');
    if (feature === 'platform') {
      if (!req.auth.isPlatformAdmin) throw new HttpError(403, 'Platform administrators only');
      return;
    }
    if (feature === 'public' || feature === 'gateway') return;
    const { loadEntitlements, requireFeature } = await import('./services/entitlements');
    requireFeature(await loadEntitlements(req.auth.orgId), feature, { read: req.method === 'GET' });
  };
}

/** Resolves the casino for a request and enforces tenant + casino isolation. */
export function scopeCasino(req: FastifyRequest, casinoId: string | undefined): string {
  const id = casinoId ?? req.auth.casinoIds[0];
  if (!id || !req.auth.casinoIds.includes(id)) throw new HttpError(404, 'Casino not found');
  return id;
}

export function actor(req: FastifyRequest) {
  return {
    orgId: req.auth.orgId,
    actorType: 'EMPLOYEE' as const,
    actorId: req.auth.sub,
    actorName: req.auth.email,
    ip: req.ip,
  };
}
