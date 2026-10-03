import jwt from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hasPermission, type Permission, type Role } from '@m1/shared';
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
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

export class HttpError extends Error {
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

/** Casinos the employee may access. Super admins see every casino of their organization. */
export async function accessibleCasinoIds(claims: TokenClaims): Promise<string[]> {
  const res =
    claims.role === 'SUPER_ADMIN'
      ? await pool.query('SELECT id FROM casinos WHERE org_id = $1 ORDER BY name', [claims.orgId])
      : await pool.query(
          `SELECT c.id FROM employee_casinos ec JOIN casinos c ON c.id = ec.casino_id
           WHERE ec.employee_id = $1 AND c.org_id = $2 ORDER BY c.name`,
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
  const emp = await pool.query('SELECT active, role FROM employees WHERE id = $1 AND org_id = $2', [claims.sub, claims.orgId]);
  if (!emp.rowCount || !emp.rows[0].active) throw new HttpError(401, 'Account disabled');
  claims.role = emp.rows[0].role; // role changes take effect immediately
  req.auth = { ...claims, casinoIds: await accessibleCasinoIds(claims) };
  return req.auth;
}

/** Route guard: valid JWT plus (optionally) a permission. */
export function guard(permission?: Permission) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization;
    await authenticate(req, header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (permission && !hasPermission(req.auth.role, permission)) throw new HttpError(403, `Missing permission ${permission}`);
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
