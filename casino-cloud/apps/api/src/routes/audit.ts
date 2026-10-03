import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditHash } from '@m1/database';
import { guard } from '../auth';
import { pool } from '../db';

export async function auditRoutes(app: FastifyInstance) {
  app.get('/api/v1/audit', { preHandler: guard('audit.view') }, async (req) => {
    const qs = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200), action: z.string().optional(), before: z.coerce.number().int().optional() }).parse(req.query);
    const params: unknown[] = [req.auth.orgId];
    let where = 'a.org_id = $1';
    if (qs.action) { params.push(`${qs.action}%`); where += ` AND a.action LIKE $${params.length}`; }
    if (qs.before) { params.push(qs.before); where += ` AND a.id < $${params.length}`; }
    params.push(qs.limit);
    const r = await pool.query(
      `SELECT a.id, a.actor_type, a.actor_name, a.action, a.entity_type, a.entity_id, a.details, a.ip, a.created_at, a.hash, c.name AS casino_name
       FROM audit_logs a LEFT JOIN casinos c ON c.id = a.casino_id WHERE ${where} ORDER BY a.id DESC LIMIT $${params.length}`,
      params,
    );
    return r.rows;
  });

  /** Recomputes the org's hash chain to detect tampering. */
  app.get('/api/v1/audit/verify', { preHandler: guard('audit.view') }, async (req) => {
    const r = await pool.query(
      `SELECT id, org_id, actor_type, actor_id, action, entity_type, entity_id, details, created_at, prev_hash, hash
       FROM audit_logs WHERE org_id = $1 ORDER BY id`,
      [req.auth.orgId],
    );
    let prev: string | null = null;
    for (const row of r.rows) {
      const expected = auditHash(prev, {
        orgId: row.org_id, actorType: row.actor_type, actorId: row.actor_id, action: row.action,
        entityType: row.entity_type, entityId: row.entity_id, details: row.details, createdAt: new Date(row.created_at).toISOString(),
      });
      if (row.prev_hash !== prev || row.hash !== expected) return { valid: false, entries: r.rowCount, brokenAt: row.id };
      prev = row.hash;
    }
    return { valid: true, entries: r.rowCount };
  });
}
