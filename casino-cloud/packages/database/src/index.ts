import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

// Return numeric/bigint as JS numbers (amounts are bounded to numeric(14,2)).
pg.types.setTypeParser(1700, (v) => parseFloat(v));
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
// Keep SQL dates as plain YYYY-MM-DD strings (no timezone shift).
pg.types.setTypeParser(1082, (v) => v);

export const DEFAULT_DATABASE_URL = 'postgres://casino:casino@localhost:5432/casino';

export function createPool(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // An idle connection dropped by the server (restart, failover, network) must not end the process: the pool
  // discards it and opens a new one; requests in flight fail with 503 and are retried with their Idempotency-Key.
  pool.on('error', (err) => console.error(`[db] idle connection lost: ${err.message}`));
  return pool;
}

export async function withTransaction<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  // a connection lost while checked out emits 'error' on the client: the transaction fails (rolled back by the
  // server), the broken client is destroyed instead of returned to the pool, the process keeps running
  let broken: Error | undefined;
  const onError = (err: Error) => { broken = err; };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch((e: Error) => { broken ??= e; });
    throw err;
  } finally {
    client.off('error', onError);
    client.release(broken);
  }
}

export { migrate } from './migrate';
export { seed, syncRbac } from './seed';
export { syncMoneyModel } from './money-model';
export { writeAudit, auditHash, canonicalJson, type AuditEntry } from './audit';
