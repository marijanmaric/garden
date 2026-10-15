import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from '@m1/database';
import { setupTestDatabase } from './helpers';

let app: FastifyInstance;
let pool: Pool;
let ingestEvents: typeof import('../src/services/ingest').ingestEvents;
let gw: { id: string; orgId: string; casinoId: string; deviceId: string };
const tokens: Record<string, string> = {};
let machines: Record<string, { id: string; code: string }> = {};

const key = () => `test-${randomUUID()}`;

async function login(email: string) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'demo' } });
  assert.equal(r.statusCode, 200);
  return r.json().token as string;
}

function post(user: string, url: string, payload: unknown, idemKey: string | null = key()) {
  const headers: Record<string, string> = { authorization: `Bearer ${tokens[user]}` };
  if (idemKey) headers['idempotency-key'] = idemKey;
  return app.inject({ method: 'POST', url, payload: payload as object, headers });
}

function get(user: string, url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tokens[user]}` } });
}

async function machineEvent(asset: string, type: 'JACKPOT' | 'JACKPOT_RESET', amount?: number) {
  const eventId = randomUUID();
  const r = await ingestEvents(gw, [{ eventId, type, machineId: machines[asset].code, timestamp: new Date().toISOString(), amount }]);
  assert.equal(r.accepted, 1);
  return eventId;
}

async function handpayRows(eventId: string) {
  return (await pool.query(`SELECT * FROM cash_transactions WHERE type = 'HANDPAY' AND source_event_id = $1`, [eventId])).rows;
}

before(async () => {
  ({ app, pool } = await setupTestDatabase());
  ({ ingestEvents } = await import('../src/services/ingest'));
  const g = (await pool.query(`SELECT id, org_id, casino_id, device_id FROM gateways WHERE device_id = 'GW-VIE-001'`)).rows[0];
  gw = { id: g.id, orgId: g.org_id, casinoId: g.casino_id, deviceId: g.device_id };
  const m = await pool.query('SELECT id, machine_code, asset_no FROM machines WHERE org_id = $1', [gw.orgId]);
  machines = Object.fromEntries(m.rows.map((r) => [r.asset_no, { id: r.id, code: r.machine_code }]));
  tokens.cashier = await login('cashier@example.com');
  tokens.attendant = await login('attendant@example.com');
  const desks = (await get('cashier', `/api/v1/cashier/desks?casinoId=${gw.casinoId}`)).json();
  assert.equal((await post('cashier', '/api/v1/cashier/session/open', { cashDeskId: desks[0].id, openingBalance: 50000 })).statusCode, 200);
  assert.equal((await post('attendant', '/api/v1/cashier/session/open', { cashDeskId: desks[1].id, openingBalance: 50000 })).statusCode, 200);
});

after(async () => {
  await app?.close();
  await pool?.end();
});

describe('handpay double payment (regression)', () => {
  test('a jackpot is listed, paid once, then refused and no longer listed', async () => {
    const eventId = await machineEvent('M005', 'JACKPOT', 750);
    const list = (await get('cashier', `/api/v1/cashier/handpays?casinoId=${gw.casinoId}`)).json();
    const hp = list.find((h: { jackpot_event_id: string }) => h.jackpot_event_id === eventId);
    assert.ok(hp, 'jackpot is listed as handpay');
    assert.equal(hp.amount, 750);

    const first = await post('cashier', `/api/v1/cashier/handpays/${machines.M005.id}`, { jackpotEventId: eventId });
    assert.equal(first.statusCode, 200, first.body);
    const second = await post('cashier', `/api/v1/cashier/handpays/${machines.M005.id}`, { jackpotEventId: eventId });
    assert.equal(second.statusCode, 409);
    assert.match(second.json().error, /already paid/);
    const third = await post('attendant', `/api/v1/cashier/handpays/${machines.M005.id}`, {});
    assert.equal(third.statusCode, 409);

    assert.equal((await handpayRows(eventId)).length, 1);
    const after = (await get('cashier', `/api/v1/cashier/handpays?casinoId=${gw.casinoId}`)).json();
    assert.ok(!after.some((h: { jackpot_event_id: string }) => h.jackpot_event_id === eventId), 'paid handpay is not listed again');

    // Payment is independent from the machine: it stays in jackpot state until the reset arrives.
    const m = (await pool.query('SELECT status, jackpot_pending FROM machines WHERE id = $1', [machines.M005.id])).rows[0];
    assert.equal(m.jackpot_pending, true);
    const cmd = (await pool.query(`SELECT type, payload FROM machine_commands WHERE machine_id = $1 AND type = 'RESET_JACKPOT'`, [machines.M005.id])).rows;
    assert.equal(cmd.length, 1);
    assert.equal(cmd[0].payload.jackpotEventId, eventId);
  });

  test('concurrent payment requests pay the same handpay exactly once', async () => {
    const eventId = await machineEvent('M006', 'JACKPOT', 1200);
    const attempts = Array.from({ length: 8 }, (_, i) =>
      post(i % 2 ? 'attendant' : 'cashier', `/api/v1/cashier/handpays/${machines.M006.id}`, { jackpotEventId: eventId }),
    );
    const results = await Promise.all(attempts);
    const codes = results.map((r) => r.statusCode).sort();
    assert.equal(codes.filter((c) => c === 200).length, 1, `exactly one success, got ${codes}`);
    assert.equal(codes.filter((c) => c === 409).length, 7);
    assert.equal((await handpayRows(eventId)).length, 1);
  });

  test('the database refuses a second payment of the same jackpot event even outside the API', async () => {
    const eventId = await machineEvent('M007', 'JACKPOT', 300);
    assert.equal((await post('cashier', `/api/v1/cashier/handpays/${machines.M007.id}`, { jackpotEventId: eventId })).statusCode, 200);
    const original = (await handpayRows(eventId))[0];
    await assert.rejects(
      pool.query(
        `INSERT INTO cash_transactions (org_id, casino_id, session_id, employee_id, type, amount, machine_id, source_event_id)
         VALUES ($1,$2,$3,$4,'HANDPAY',-300,$5,$6)`,
        [original.org_id, original.casino_id, original.session_id, original.employee_id, original.machine_id, eventId],
      ),
      /cash_transactions_one_payment_per_event/,
    );
  });

  test('a new jackpot after the machine reset is a new handpay', async () => {
    await machineEvent('M005', 'JACKPOT_RESET');
    const eventId = await machineEvent('M005', 'JACKPOT', 400);
    const r = await post('cashier', `/api/v1/cashier/handpays/${machines.M005.id}`, { jackpotEventId: eventId });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().amount, 400);
  });

  test('a stale jackpot id is refused', async () => {
    await machineEvent('M008', 'JACKPOT', 100);
    const r = await post('cashier', `/api/v1/cashier/handpays/${machines.M008.id}`, { jackpotEventId: randomUUID() });
    assert.equal(r.statusCode, 409);
  });
});

describe('idempotency', () => {
  async function drawerExpected(user: string) {
    return (await get(user, '/api/v1/cashier/session')).json().session.expected as number;
  }

  test('money routes require an Idempotency-Key', async () => {
    const r = await post('cashier', '/api/v1/cashier/transactions', { type: 'CASH_IN', amount: 10 }, null);
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /Idempotency-Key/);
  });

  test('a replay returns the stored response and books only once', async () => {
    const before = await drawerExpected('cashier');
    const k = key();
    const payload = { type: 'CASH_IN', amount: 100, reference: `replay-${k}` };
    const a = await post('cashier', '/api/v1/cashier/transactions', payload, k);
    const b = await post('cashier', '/api/v1/cashier/transactions', payload, k);
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.equal(b.headers['idempotent-replayed'], 'true');
    assert.equal(a.headers['idempotent-replayed'], undefined);
    assert.deepEqual(b.json(), a.json());
    const rows = (await pool.query('SELECT count(*)::int n FROM cash_transactions WHERE reference = $1', [payload.reference])).rows[0].n;
    assert.equal(rows, 1);
    assert.equal(await drawerExpected('cashier'), before + 100);
  });

  test('the same key with a different request is rejected', async () => {
    const k = key();
    assert.equal((await post('cashier', '/api/v1/cashier/transactions', { type: 'CASH_IN', amount: 20 }, k)).statusCode, 200);
    const r = await post('cashier', '/api/v1/cashier/transactions', { type: 'CASH_IN', amount: 25 }, k);
    assert.equal(r.statusCode, 422);
  });

  test('concurrent requests with the same key execute once', async () => {
    const k = key();
    const payload = { type: 'CASH_OUT', amount: 30, reference: `concurrent-${k}` };
    const results = await Promise.all(Array.from({ length: 6 }, () => post('cashier', '/api/v1/cashier/transactions', payload, k)));
    assert.ok(results.every((r) => r.statusCode === 200), results.map((r) => r.statusCode).join());
    const ids = new Set(results.map((r) => r.json().id));
    assert.equal(ids.size, 1, 'all callers see the same transaction');
    assert.equal(results.filter((r) => r.headers['idempotent-replayed'] === 'true').length, 5);
    const rows = (await pool.query('SELECT count(*)::int n FROM cash_transactions WHERE reference = $1', [payload.reference])).rows[0].n;
    assert.equal(rows, 1);
  });

  test('a failed action does not consume the key, the retry executes', async () => {
    const k = key();
    const url = `/api/v1/cashier/handpays/${machines.M009.id}`;
    const fail = await post('cashier', url, {}, k);
    assert.equal(fail.statusCode, 409, 'no jackpot yet');
    await machineEvent('M009', 'JACKPOT', 250);
    const ok = await post('cashier', url, {}, k);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.headers['idempotent-replayed'], undefined);
  });

  test('double tap on handpay with the same key returns the original success once', async () => {
    const eventId = await machineEvent('M010', 'JACKPOT', 500);
    const k = `handpay-${eventId}`;
    const url = `/api/v1/cashier/handpays/${machines.M010.id}`;
    const [a, b] = await Promise.all([post('cashier', url, { jackpotEventId: eventId }, k), post('cashier', url, { jackpotEventId: eventId }, k)]);
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.equal(a.json().transaction.id, b.json().transaction.id);
    assert.equal((await handpayRows(eventId)).length, 1);
  });

  test('ticket redeem replay pays the ticket once', async () => {
    const issued = await post('cashier', '/api/v1/tickets/issue', { amount: 60 });
    assert.equal(issued.statusCode, 200);
    const barcode = issued.json().barcode;
    const k = `redeem-${barcode}`;
    const a = await post('cashier', '/api/v1/tickets/redeem', { barcode }, k);
    const b = await post('cashier', '/api/v1/tickets/redeem', { barcode }, k);
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.equal(b.headers['idempotent-replayed'], 'true');
    const payouts = (await pool.query(`SELECT count(*)::int n FROM cash_transactions WHERE type = 'TICKET_PAYOUT' AND reference = $1`, [barcode])).rows[0].n;
    assert.equal(payouts, 1);
  });
});
