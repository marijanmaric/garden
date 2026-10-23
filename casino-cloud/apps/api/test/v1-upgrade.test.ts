import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { createEmptyDatabase, insertLegacyData } from './helpers';

/**
 * V1 upgrade (migration 014) on a database at 013 with machine event exceptions of a ledger machine, one
 * explained the old way (reconciliation resolution) and one not: the ledger stays identical, the explained one
 * keeps its state (EXPLAINED_BEFORE_014, settlement not blocked again), the open one now needs a disposition.
 */
const name = 'casino_v1_upgrade';
let pool: pg.Pool;

const fingerprint = async () => (await pool.query(
  `SELECT (SELECT count(*) FROM money_transactions)::int tx, (SELECT count(*) FROM ledger_entries)::int entries,
          (SELECT string_agg(a.kind || ':' || b.balance_cents, ',' ORDER BY a.id) FROM ledger_accounts a JOIN ledger_balances b ON b.account_id = a.id) balances,
          (SELECT count(*) FROM reconciliation_resolutions)::int resolutions, (SELECT count(*) FROM approvals)::int approvals`)).rows[0];

let explained = '';
let open = '';
let before013: Record<string, unknown>;

before(async () => {
  const url = await createEmptyDatabase(name);
  process.env.DATABASE_URL = url;
  process.env.LOG_LEVEL = 'silent';
  const db = await import('@m1/database');
  pool = db.createPool(url);
  await db.migrate(pool, () => {}, { until: '004_money_ledger.sql' });
  await db.syncMoneyModel(pool);
  const legacy = await insertLegacyData(pool);
  await db.migrate(pool, () => {}, { until: '013_handpay_ticket_payout.sql' });
  await db.syncRbac(pool);
  await db.syncMoneyModel(pool);
  const hash = await bcrypt.hash('demo', 4);
  const emp: Record<string, string> = {};
  for (const [email, role] of [['admin@example.com', 'SUPER_ADMIN'], ['manager@example.com', 'MANAGER'], ['accounting@example.com', 'ACCOUNTING']]) {
    emp[email] = (await pool.query(`INSERT INTO employees (org_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [legacy.org, email, email, hash, role])).rows[0].id;
    await pool.query('INSERT INTO employee_casinos (employee_id, casino_id, org_id) VALUES ($1,$2,$3)', [emp[email], legacy.casino, legacy.org]);
  }
  const { createLedgerCasino } = await import('./ledger-casino');
  const c = await createLedgerCasino(pool, { orgId: legacy.org, code: 'V1-U', machines: 2, vaultCents: 1_000_000 });
  // two rejected hopper payouts of a ledger machine (written as 013 wrote them); the first explained the old way
  for (const k of ['explained', 'open']) {
    const ev = randomUUID();
    const cl = await pool.connect(); // the event and its exception in one transaction (the ledger guard checks at COMMIT)
    try {
      await cl.query('BEGIN');
      await cl.query(`INSERT INTO machine_events (event_id, org_id, casino_id, machine_id, type, amount, occurred_at) VALUES ($1,$2,$3,$4,'CASH_OUT',5,now())`, [ev, legacy.org, c.id, c.machines[0].id]);
      await cl.query(`INSERT INTO machine_event_exceptions (event_id, org_id, casino_id, machine_id, rail, event_type, code, message) VALUES ($1,$2,$3,$4,'MACHINE','CASH_OUT','HTTP_409','Insufficient balance on HOPPER')`, [ev, legacy.org, c.id, c.machines[0].id]);
      await cl.query('COMMIT');
    } finally { cl.release(); }
    if (k === 'explained') {
      explained = ev;
      const ap = (await pool.query(`INSERT INTO approvals (org_id, casino_id, action, entity_type, entity_id, status, requested_by, decided_by, decided_at, payload)
        VALUES ($1,$2,'RECONCILIATION_RESOLUTION','reconciliation_item',$3,'APPROVED',$4,$5,now(),'{}') RETURNING id`, [legacy.org, c.id, `machine_event:${ev}`, emp['manager@example.com'], emp['accounting@example.com']])).rows[0].id;
      await pool.query(`INSERT INTO reconciliation_resolutions (org_id, casino_id, item_key, explanation, requested_by, approved_by, approval_id) VALUES ($1,$2,$3,'Hopper empty, nothing paid (explained at 013)',$4,$5,$6)`,
        [legacy.org, c.id, `machine_event:${ev}`, emp['manager@example.com'], emp['accounting@example.com'], ap]);
    } else open = ev;
  }
  before013 = await fingerprint();
  await db.migrate(pool, () => {});
});

after(async () => {
  await pool?.end();
  const { pool: apiPool } = await import('../src/db');
  await apiPool.end().catch(() => undefined);
});

test('014 upgrade: ledger, resolutions and approvals identical; old explanation kept as EXPLAINED_BEFORE_014; the open exception needs a disposition', async () => {
  assert.deepEqual(await fingerprint(), before013, 'no money row, balance, resolution or approval changed');
  const d = (await pool.query('SELECT event_id, kind, money_transaction_id FROM machine_event_dispositions ORDER BY event_id')).rows;
  assert.deepEqual(d, [{ event_id: explained, kind: 'EXPLAINED_BEFORE_014', money_transaction_id: null }]);
  const needs = (await pool.query('SELECT machine_exception_needs_disposition($1) a, machine_exception_needs_disposition($2) b', [explained, open])).rows[0];
  assert.deepEqual(needs, { a: true, b: true });
  // the backfill kind cannot be written afterwards, and the rows are immutable
  await assert.rejects(pool.query(`INSERT INTO machine_event_dispositions (event_id, org_id, casino_id, machine_id, kind, reason, approval_id, requested_by, approved_by)
    SELECT x.event_id, x.org_id, x.casino_id, x.machine_id, 'EXPLAINED_BEFORE_014', 'forged backfill row', a.id, a.requested_by, a.decided_by
    FROM machine_event_exceptions x, approvals a WHERE x.event_id = $1 LIMIT 1`, [open]), /only the migration backfill/);
  await assert.rejects(pool.query(`DELETE FROM machine_event_dispositions WHERE event_id = $1`, [explained]));
  // only the open exception still blocks the machine's settlement
  const blocking = (await pool.query(`SELECT x.event_id FROM machine_event_exceptions x WHERE machine_exception_needs_disposition(x.event_id)
    AND NOT EXISTS (SELECT 1 FROM machine_event_dispositions d WHERE d.event_id = x.event_id)`)).rows.map((r) => r.event_id);
  assert.deepEqual(blocking, [open]);
});
