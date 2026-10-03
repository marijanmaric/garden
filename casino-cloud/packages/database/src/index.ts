import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

// Return numeric/bigint as JS numbers (amounts are bounded to numeric(14,2)).
pg.types.setTypeParser(1700, (v) => parseFloat(v));
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

export const DEFAULT_DATABASE_URL = 'postgres://casino:casino@localhost:5432/casino';

export function createPool(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function withTransaction<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export { migrate } from './migrate';
export { seed } from './seed';
export { writeAudit, auditHash, canonicalJson, type AuditEntry } from './audit';
