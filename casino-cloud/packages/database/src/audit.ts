import { createHash } from 'node:crypto';
import type pg from 'pg';

/** JSON with recursively sorted keys, so hashes survive the jsonb round trip. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v,
  );
}

export function auditHash(prevHash: string | null, r: {
  orgId: string | null; actorType: string; actorId?: string | null; action: string;
  entityType?: string | null; entityId?: string | null; details: unknown; createdAt: string;
}): string {
  return createHash('sha256')
    .update(canonicalJson([prevHash, r.orgId, r.actorType, r.actorId ?? null, r.action, r.entityType ?? null, r.entityId ?? null, r.details, r.createdAt]))
    .digest('hex');
}

export interface AuditEntry {
  orgId: string | null;
  casinoId?: string | null;
  actorType: 'EMPLOYEE' | 'GATEWAY' | 'SYSTEM';
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Append an audit entry to the per-org hash chain. An advisory lock serialises writers
 * of the same org so the chain stays linear.
 */
export async function writeAudit(db: pg.Pool | pg.PoolClient, e: AuditEntry): Promise<void> {
  const client = 'release' in db ? db : await (db as pg.Pool).connect();
  const own = !('release' in db);
  try {
    if (own) await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${e.orgId ?? 'platform'}`]);
    const prev = await client.query(
      'SELECT hash FROM audit_logs WHERE org_id IS NOT DISTINCT FROM $1 ORDER BY id DESC LIMIT 1',
      [e.orgId],
    );
    const prevHash: string | null = prev.rows[0]?.hash ?? null;
    const createdAt = new Date().toISOString();
    const details = JSON.parse(JSON.stringify(e.details ?? {}));
    const hash = auditHash(prevHash, { ...e, details, createdAt });
    await client.query(
      `INSERT INTO audit_logs (org_id, casino_id, actor_type, actor_id, actor_name, action, entity_type, entity_id, details, ip, created_at, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [e.orgId, e.casinoId ?? null, e.actorType, e.actorId ?? null, e.actorName ?? null, e.action, e.entityType ?? null,
        e.entityId ?? null, details, e.ip ?? null, createdAt, prevHash, hash],
    );
    if (own) await client.query('COMMIT');
  } catch (err) {
    if (own) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (own) (client as pg.PoolClient).release();
  }
}
