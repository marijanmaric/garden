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
  const { cutoverFreshRails } = await import('../src/services/cutover');
  await cutoverFreshRails(pool);
  const { buildApp } = await import('../src/app');
  const app = await buildApp();
  await opts.beforeReady?.(app);
  await app.ready();
  return { app, pool };
}

/**
 * Legacy-style operational data written with plain SQL at an older schema version (001-003 tables
 * only), so upgrade tests do not depend on today's seed.
 */
export async function insertLegacyData(pool: import('pg').Pool) {
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];
  const org = (await q(`INSERT INTO organizations (name, slug) VALUES ('Upgrade Org', 'upgrade') RETURNING id`)).id;
  const casino = (await q(`INSERT INTO casinos (org_id, code, name) VALUES ($1, 'U-1', 'Upgrade Casino') RETURNING id`, [org])).id;
  const machine = (await q(`INSERT INTO machines (org_id, casino_id, machine_code, asset_no, jackpot_pending) VALUES ($1,$2,'U-000001','U01', true) RETURNING id`, [org, casino])).id;
  const machine2 = (await q(`INSERT INTO machines (org_id, casino_id, machine_code, asset_no) VALUES ($1,$2,'U-000002','U02') RETURNING id`, [org, casino])).id;
  const employee = (await q(`INSERT INTO employees (org_id, email, name, password_hash, role) VALUES ($1, 'u@upgrade.example', 'U', 'x', 'CASHIER') RETURNING id`, [org])).id;
  const player = (await q(`INSERT INTO players (org_id) VALUES ($1) RETURNING id`, [org])).id;
  await q(`INSERT INTO player_profiles (player_id, org_id, first_name) VALUES ($1,$2,'Up')`, [player, org]);
  const card = (await q(`INSERT INTO player_cards (org_id, player_id, card_number) VALUES ($1,$2,'UP-0001') RETURNING id`, [org, player])).id;
  const closedPlayer = (await q(`INSERT INTO players (org_id, status) VALUES ($1, 'CLOSED') RETURNING id`, [org])).id;
  const desk = (await q(`INSERT INTO cash_desks (org_id, casino_id, name) VALUES ($1,$2,'Desk') RETURNING id`, [org, casino])).id;
  const session = (await q(`INSERT INTO cashier_sessions (org_id, casino_id, cash_desk_id, employee_id, opening_balance) VALUES ($1,$2,$3,$4,1000) RETURNING id`, [org, casino, desk, employee])).id;
  await q(`INSERT INTO cash_transactions (org_id, casino_id, session_id, employee_id, type, amount) VALUES ($1,$2,$3,$4,'CASH_IN',250)`, [org, casino, session, employee]);
  await q(`INSERT INTO tickets (org_id, casino_id, barcode, amount, expires_at) VALUES ($1,$2,'111122223333444455',42.5, now() + interval '30 days')`, [org, casino]);
  await q(`INSERT INTO gaming_transactions (org_id, casino_id, machine_id, type, amount, occurred_at) VALUES ($1,$2,$3,'WAGER',2,now())`, [org, casino, machine]);
  // A jackpot that was paid through the Step 1 handpay (legacy cash transaction) and later reset ...
  const paidEvent = (await q(`INSERT INTO machine_events (event_id, org_id, casino_id, machine_id, type, amount, occurred_at) VALUES (gen_random_uuid(),$1,$2,$3,'JACKPOT',300,now() - interval '2 hours') RETURNING event_id`, [org, casino, machine2])).event_id;
  await q(`INSERT INTO cash_transactions (org_id, casino_id, session_id, employee_id, type, amount, machine_id, source_event_id) VALUES ($1,$2,$3,$4,'HANDPAY',-300,$5,$6)`, [org, casino, session, employee, machine2, paidEvent]);
  await q(`INSERT INTO machine_events (event_id, org_id, casino_id, machine_id, type, occurred_at) VALUES (gen_random_uuid(),$1,$2,$3,'JACKPOT_RESET',now() - interval '1 hour')`, [org, casino, machine2]);
  // ... an old jackpot without payment, and the currently pending jackpot of machine U01.
  await q(`INSERT INTO machine_events (event_id, org_id, casino_id, machine_id, type, amount, occurred_at) VALUES (gen_random_uuid(),$1,$2,$3,'JACKPOT',90,now() - interval '3 days')`, [org, casino, machine]);
  const pendingEvent = (await q(`INSERT INTO machine_events (event_id, org_id, casino_id, machine_id, type, amount, occurred_at) VALUES (gen_random_uuid(),$1,$2,$3,'JACKPOT',512.34,now()) RETURNING event_id`, [org, casino, machine])).event_id;
  return { org, casino, machine, machine2, employee, player, card, closedPlayer, session, paidEvent, pendingEvent };
}

export async function createEmptyDatabase(name: string) {
  const base = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://casino:casino@localhost:5432/postgres';
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Upgraded organisations only receive the conservative usage-derived entitlements of migration 012. Tests
 * that exercise every rail on an upgraded organisation assign a plan explicitly, as a platform admin would.
 */
export async function assignPlan(pool: import('pg').Pool, orgId: string, code = 'ENTERPRISE') {
  await pool.query(
    `INSERT INTO subscriptions (org_id, plan_id, status)
     SELECT $1, id, 'ACTIVE' FROM plans WHERE code = $2 ORDER BY version DESC LIMIT 1
     ON CONFLICT (org_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'ACTIVE', ends_at = NULL, updated_at = now()`,
    [orgId, code],
  );
}
