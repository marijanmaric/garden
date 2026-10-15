import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { withTransaction, type PoolClient } from '@m1/database';
import { HttpError } from '../auth';
import { pool } from '../db';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** Stable JSON (sorted keys) so the same logical request always hashes the same. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v,
  );
}

/**
 * Runs a money action exactly once per Idempotency-Key.
 *
 * The key row is inserted at the start of the action's own transaction:
 *  - a concurrent request with the same key blocks on that insert until the first one finishes,
 *    then sees the committed row and gets the stored response (no second execution);
 *  - if the action fails, the key row rolls back with it, so a retry executes again.
 * Keys are scoped per employee. A replay with the same key but a different request is rejected.
 */
export async function idempotent<T>(req: FastifyRequest, reply: FastifyReply, action: (db: PoolClient) => Promise<T>): Promise<T> {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw new HttpError(400, 'Idempotency-Key header required (8-128 chars, A-Z a-z 0-9 _ -)');
  const route = req.routeOptions.url ?? req.url;
  const hash = createHash('sha256').update(stable({ m: req.method, u: req.url, b: req.body ?? null })).digest('hex');

  const outcome = await withTransaction(pool, async (db) => {
    const claimed = await db.query(
      `INSERT INTO idempotency_keys (org_id, key, employee_id, route, request_hash) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (org_id, employee_id, key) DO NOTHING RETURNING key`,
      [req.auth.orgId, key, req.auth.sub, route, hash],
    );
    if (!claimed.rowCount) {
      const prev = (await db.query('SELECT request_hash, response FROM idempotency_keys WHERE org_id = $1 AND employee_id = $2 AND key = $3', [req.auth.orgId, req.auth.sub, key])).rows[0];
      if (prev.request_hash !== hash) throw new HttpError(422, 'Idempotency-Key was already used for a different request');
      return { replayed: true, response: prev.response as T };
    }
    const response = await action(db);
    await db.query('UPDATE idempotency_keys SET response = $4 WHERE org_id = $1 AND employee_id = $2 AND key = $3', [req.auth.orgId, req.auth.sub, key, JSON.stringify(response ?? null)]);
    return { replayed: false, response };
  });
  if (outcome.replayed) reply.header('Idempotent-Replayed', 'true');
  return outcome.response;
}
