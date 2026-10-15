import pg from 'pg';

/**
 * Creates a fresh, seeded test database and points the API at it. Must run before any module
 * that creates the connection pool is imported (src/db.ts reads DATABASE_URL at import time).
 */
export async function setupTestDatabase(opts: { beforeReady?: (app: import('fastify').FastifyInstance) => void | Promise<void> } = {}) {
  const base = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://casino:casino@localhost:5432/postgres';
  const name = process.env.TEST_DATABASE_NAME ?? 'casino_test';
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
  process.env.LOG_LEVEL = 'silent';

  const { migrate, seed, syncMoneyModel, syncRbac } = await import('@m1/database');
  const { pool } = await import('../src/db');
  const quiet = () => {};
  await migrate(pool, quiet);
  await syncRbac(pool);
  await syncMoneyModel(pool);
  await seed(pool, quiet);
  const { buildApp } = await import('../src/app');
  const app = await buildApp();
  await opts.beforeReady?.(app);
  await app.ready();
  return { app, pool };
}
