import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from '@m1/database';
import { setupTestDatabase } from './helpers';

/**
 * F3 independent verification: financial invariants proven at database level for the customers without a cash
 * desk (B: TITO + Handpay, D: Cashless + Machine + Vault). Every probe tries to break an invariant directly
 * (SQL or service) instead of trusting the happy path.
 */
let app: FastifyInstance;
let pool: Pool;
let platform: string;
let duplicateAccept = '';

interface Org { key: string; id: string; casino: string; vault: string; machines: Array<{ id: string; code: string }>; gw: { deviceId: string; key: string }; t: Record<string, string>; emp: Record<string, string> }
const O: Record<'B' | 'D' | 'X', Org> = {} as never;

const call = (token: string, method: string, url: string, payload?: unknown, key: string = randomUUID()) =>
  app.inject({ method: method as 'GET', url, payload: payload as object, headers: { authorization: `Bearer ${token}`, ...(method === 'GET' ? {} : { 'idempotency-key': key }) } });
const post = (t: string, url: string, body: unknown = {}, key?: string) => call(t, 'POST', url, body, key);
const ok = <T extends { statusCode: number; body: string }>(r: T, msg = ''): T => { assert.ok(r.statusCode < 300, `${msg}: ${r.statusCode} ${r.body}`); return r; };
const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
const n = async (sql: string, p: unknown[] = []) => Number((await one(sql, p)).n);
const gw = (o: Org, url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object, headers: { 'x-gateway-id': o.gw.deviceId, 'x-gateway-key': o.gw.key } });
const event = async (o: Org, i: number, type: string, fields: Record<string, unknown> = {}, eventId = randomUUID()) => {
  const res = await gw(o, '/api/v1/gateway/events', { events: [{ eventId, type, machineId: o.machines[i].code, timestamp: new Date().toISOString(), ...fields }] });
  return { res, eventId, body: res.json() };
};
const barcode = () => String(Math.floor(1e17 + Math.random() * 8e17));
const raw = async (o: Org, kind: string, machineId?: string) => Number((await one(
  `SELECT COALESCE(sum(b.balance_cents), 0)::bigint v FROM ledger_accounts a JOIN ledger_balances b ON b.account_id = a.id WHERE a.org_id = $1 AND a.kind = $2 AND ($3::uuid IS NULL OR a.machine_id = $3)`,
  [o.id, kind, machineId ?? null])).v);
const footprint = async (o: Org) => one(
  `SELECT (SELECT count(*) FROM money_transactions WHERE org_id = $1)::int tx, (SELECT count(*) FROM ledger_entries e JOIN money_transactions t ON t.id = e.transaction_id WHERE t.org_id = $1)::int entries,
          (SELECT count(*) FROM tickets WHERE org_id = $1)::int tickets, (SELECT string_agg(status || ':' || COALESCE(pay_method, '-'), ',' ORDER BY id) FROM handpays WHERE org_id = $1) handpays`, [o.id]);

async function tokenFor(email: string) {
  const { signToken } = await import('../src/auth');
  const e = await one('SELECT id, org_id, role, name, email FROM employees WHERE lower(email) = lower($1)', [email]);
  return signToken({ sub: e.id, orgId: e.org_id, role: e.role, name: e.name, email: e.email });
}

async function onboard(k: 'B' | 'D' | 'X', plan: string, rails: string[]): Promise<Org> {
  const slug = `verify-${k.toLowerCase()}`;
  const planId = (await one('SELECT id FROM plans WHERE code = $1 ORDER BY version DESC LIMIT 1', [plan])).id;
  const org = ok(await call(platform, 'POST', '/api/v1/platform/organizations', { name: `Verify ${k}`, slug, planId, admin: { name: `Admin ${k}`, email: `admin@${slug}.test`, password: 'correct-horse-battery' } }), 'org').json();
  const casino = ok(await call(platform, 'POST', `/api/v1/platform/organizations/${org.id}/casinos`, { code: `V${k}-1`, name: `Casino ${k}` })).json().id;
  const machines: Org['machines'] = [];
  for (let i = 1; i <= 3; i++) machines.push({ id: ok(await call(platform, 'POST', `/api/v1/platform/organizations/${org.id}/machines`, { casinoId: casino, machineCode: `V${k}-M${i}`, assetNo: `A${i}` })).json().id, code: `V${k}-M${i}` });
  const gwKey = randomUUID();
  const g = await one(`INSERT INTO gateways (org_id, casino_id, device_id, name, api_key_hash) VALUES ($1,$2,$3,$3,$4) RETURNING id`, [org.id, casino, `V${k}-GW`, createHash('sha256').update(gwKey).digest('hex')]);
  await pool.query('UPDATE machines SET gateway_id = $1 WHERE casino_id = $2', [g.id, casino]);
  const t: Record<string, string> = { admin: await tokenFor(`admin@${slug}.test`) };
  const emp: Record<string, string> = { admin: org.adminId };
  for (const r of ['MANAGER', 'CASHIER', 'ACCOUNTING', 'ATTENDANT']) {
    const email = `${r.toLowerCase()}@${slug}.test`;
    emp[r] = ok(await post(t.admin, '/api/v1/employees', { name: r, role: r, email, password: 'password-12345', casinoIds: [casino] }), r).json().id;
    t[r] = await tokenFor(email);
  }
  const vault = (await one('SELECT id FROM vaults WHERE casino_id = $1', [casino])).id;
  const o: Org = { key: k, id: org.id, casino, vault, machines, gw: { deviceId: `V${k}-GW`, key: gwKey }, t, emp };
  for (const rail of rails) {
    if (rail === 'VAULT') {
      const c = ok(await post(t.MANAGER, '/api/v1/money/counts', { casinoId: casino, context: 'VAULT_CUTOVER', vaultId: vault, totalCents: 1_000_000 })).json();
      ok(await post(t.admin, `/api/v1/money/counts/${c.id}/verify`, { totalCents: 1_000_000 }));
    }
    if (rail === 'MACHINE') {
      for (const m of machines) {
        const c = ok(await post(t.MANAGER, '/api/v1/money/counts', { casinoId: casino, context: 'MACHINE_DROP', machineId: m.id, totalCents: 0 })).json();
        ok(await post(t.admin, `/api/v1/money/counts/${c.id}/verify`, { totalCents: 0 }));
        ok(await post(t.admin, '/api/v1/money/cutover', { rail, machineId: m.id }), `cutover MACHINE ${k}`);
      }
      continue;
    }
    ok(await post(t.admin, '/api/v1/money/cutover', { rail, casinoId: casino }), `cutover ${rail} ${k}`);
  }
  return o;
}

before(async () => {
  ({ app, pool } = await setupTestDatabase());
  platform = await tokenFor('platform@example.com');
  O.B = await onboard('B', 'TITO_HANDPAY', ['TITO', 'HANDPAY']);
  O.D = await onboard('D', 'CASHLESS_MACHINE', ['VAULT', 'MACHINE']);
  O.X = await onboard('X', 'TITO_HANDPAY', ['HANDPAY']); // HANDPAY on the ledger, TITO still legacy
});
after(async () => { await app?.close(); await pool?.end(); });

describe('F3 verification: financial invariants', () => {
  test('1 + 2: the database refuses a posting to a legacy rail and an unbalanced transaction, whoever writes it', async () => {
    const tx = async (c: import('pg').PoolClient, type: string) => (await c.query(
      `INSERT INTO money_transactions (org_id, casino_id, type, amount_cents, dedupe_key, request_hash, actor_type, business_date)
       VALUES ($1, $2, $3, 100, $4, 'probe', 'SYSTEM', current_date) RETURNING id`, [O.D.id, O.D.casino, type, `probe-${randomUUID()}`])).rows[0].id as string;
    const c = await pool.connect();
    try {
      // D: TITO is legacy. An entry on its TICKET_LIABILITY account is refused by the database rail guard.
      await c.query('BEGIN');
      const acc = (await c.query(`INSERT INTO ledger_accounts (org_id, casino_id, kind) VALUES ($1, $2, 'TICKET_LIABILITY') RETURNING id`, [O.D.id, O.D.casino])).rows[0].id;
      const t1 = await tx(c, 'TITO_EXPIRY');
      await assert.rejects(c.query(`INSERT INTO ledger_entries (org_id, transaction_id, account_id, amount_cents) VALUES ($1, $2, $3, 100)`, [O.D.id, t1, acc]), /TITO is not on the ledger/);
      await c.query('ROLLBACK');
      // unbalanced: one entry on the (ledger) vault, nothing else -> refused at COMMIT
      await c.query('BEGIN');
      const vault = (await c.query(`SELECT id FROM ledger_accounts WHERE org_id = $1 AND kind = 'VAULT'`, [O.D.id])).rows[0].id;
      const t2 = await tx(c, 'VAULT_COUNT_DIFFERENCE');
      await c.query(`INSERT INTO ledger_entries (org_id, transaction_id, account_id, amount_cents) VALUES ($1, $2, $3, 100)`, [O.D.id, t2, vault]);
      await c.query(`INSERT INTO ledger_entries (org_id, transaction_id, account_id, amount_cents) VALUES ($1, $2, $3, -50)`, [O.D.id, t2, vault]);
      await assert.rejects(c.query('COMMIT'), /unbalanced/);
      // a single entry is refused as well
      await c.query('BEGIN');
      const t3 = await tx(c, 'VAULT_COUNT_DIFFERENCE');
      await c.query(`INSERT INTO ledger_entries (org_id, transaction_id, account_id, amount_cents) VALUES ($1, $2, $3, 100)`, [O.D.id, t3, vault]);
      await assert.rejects(c.query('COMMIT'), /at least 2 required/);
    } finally {
      await c.query('ROLLBACK').catch(() => null);
      c.release();
    }
    const ub = await n(`SELECT count(*)::int n FROM (SELECT transaction_id FROM ledger_entries GROUP BY 1 HAVING sum(amount_cents) <> 0) x`);
    assert.equal(ub, 0);
  });

  test('1: the service refuses incompatible rails: cash handpay in B, voucher payout where TITO is legacy (X) leaves no ticket', async () => {
    const jp = await event(O.X, 0, 'JACKPOT', { amount: 40 });
    assert.equal(jp.body.accepted, 1, jp.res.body);
    const f0 = await footprint(O.X);
    const r = await post(O.X.t.CASHIER, `/api/v1/cashier/handpays/${O.X.machines[0].id}`, { payTo: 'TICKET' });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().code, 'RAIL_LEGACY');
    assert.deepEqual(await footprint(O.X), f0, 'no orphaned voucher, no partial booking');
  });

  test('3 + 4 + 6: a handpay voucher is created once (retries, 20 parallel, direct SQL) and redeemed once; a failed payout leaves nothing', async () => {
    const o = O.B;
    const jp = await event(o, 0, 'JACKPOT', { amount: 120 });
    const h = await one('SELECT id FROM handpays WHERE source_event_id = $1', [jp.eventId]);
    // failure in the middle: TITO frozen -> the voucher insert and the booking roll back together
    const fz = await one(`INSERT INTO money_rail_freezes (org_id, rail, casino_id, reason) VALUES ($1, 'TITO', $2, 'verification') RETURNING id`, [o.id, o.casino]);
    const f0 = await footprint(o);
    const frozen = await post(o.t.CASHIER, `/api/v1/cashier/handpays/${o.machines[0].id}`, { payTo: 'TICKET' });
    assert.equal(frozen.statusCode, 409, frozen.body);
    assert.deepEqual(await footprint(o), f0, 'nothing left behind by a failed payout');
    ok(await post(o.t.admin, `/api/v1/money/freezes/${fz.id}/lift`, { reason: 'verification over' }));
    // same Idempotency-Key retried 5 times + 20 parallel different keys
    const key = `retry-${randomUUID()}`;
    const first = ok(await post(o.t.CASHIER, `/api/v1/cashier/handpays/${o.machines[0].id}`, { payTo: 'TICKET' }, key)).json();
    for (let i = 0; i < 5; i++) {
      const again = await post(o.t.CASHIER, `/api/v1/cashier/handpays/${o.machines[0].id}`, { payTo: 'TICKET' }, key);
      assert.equal(again.headers['idempotent-replayed'], 'true');
      assert.equal(again.json().voucher.ticketId, first.voucher.ticketId);
    }
    const par = await Promise.all(Array.from({ length: 20 }, () => post(o.t.CASHIER, `/api/v1/cashier/handpays/${o.machines[0].id}`, { payTo: 'TICKET', jackpotEventId: jp.eventId })));
    assert.equal(par.filter((r) => r.statusCode === 200).length, 0, 'already paid');
    assert.equal(await n(`SELECT count(*)::int n FROM money_transactions WHERE handpay_id = $1 AND type = 'HANDPAY_PAY'`, [h.id]), 1);
    assert.equal(await n(`SELECT count(*)::int n FROM tickets WHERE org_id = $1 AND issued_by_employee IS NOT NULL`, [o.id]), 1, 'exactly one voucher');
    // the database itself refuses a second voucher booking for the handpay and a second origin for the ticket
    const { executeMoneyTransaction } = await import('../src/services/ledger');
    const { withTransaction } = await import('@m1/database');
    const second = await withTransaction(pool, (db) => executeMoneyTransaction(db, {
      orgId: o.id, type: 'HANDPAY_PAY', dedupeKey: `probe-${randomUUID()}`, actor: { type: 'SYSTEM', name: 'probe' },
      ctx: { casinoId: o.casino, amountCents: 12_000 as never, machineId: o.machines[0].id, handpayId: h.id, ticketId: first.voucher.ticketId, payTo: 'TICKET' },
    })).then(() => 'booked', (e) => (e as Error).message);
    assert.notEqual(second, 'booked');
    await assert.rejects(pool.query(`UPDATE handpays SET payout_ticket_id = NULL WHERE id = $1`, [h.id]), 'the link cannot be removed (TICKET needs its voucher)');
    // redeemed once: 10 parallel holds -> 1; a second accept event of another machine books nothing
    const holds = await Promise.all(Array.from({ length: 10 }, (_, i) => gw(o, '/api/v1/gateway/tickets/hold', { machineId: o.machines[1 + (i % 2)].code, barcode: first.voucher.barcode })));
    const win = holds.map((x, i) => ({ b: x.json(), i })).filter((x) => x.b.ok);
    assert.equal(win.length, 1);
    const idx = 1 + (win[0].i % 2);
    assert.equal((await event(o, idx, 'TITO_IN', { ticketBarcode: first.voucher.barcode, holdId: win[0].b.holdId })).body.accepted, 1);
    const dup = await event(o, idx === 1 ? 2 : 1, 'TITO_IN', { ticketBarcode: first.voucher.barcode });
    assert.equal(dup.res.statusCode, 200);
    duplicateAccept = dup.eventId;
    assert.equal(await n(`SELECT count(*)::int n FROM money_transactions WHERE ticket_id = $1 AND type IN ('TITO_REDEEM_MACHINE', 'TITO_REDEEM_CASHIER')`, [first.voucher.ticketId]), 1);
    assert.equal(await raw(o, 'TICKET_LIABILITY'), 0, 'the liability is released exactly once');
    assert.equal(await raw(o, 'HANDPAY_PAYABLE'), 0);
  });

  test('7: a crash before commit leaves no voucher, no booking, no handpay change', async () => {
    const o = O.B;
    const jp = await event(o, 0, 'JACKPOT', { amount: 33 });
    const h = await one('SELECT id, status FROM handpays WHERE source_event_id = $1', [jp.eventId]);
    const f0 = await footprint(o);
    const { payHandpay } = await import('../src/services/handpays');
    const c = await pool.connect();
    await c.query('BEGIN');
    const pid = (await c.query('SELECT pg_backend_pid() p')).rows[0].p;
    await payHandpay(c, { orgId: o.id, employeeId: o.emp.CASHIER, employeeEmail: 'cashier@verify-b.test' } as never, h.id, { payTo: 'TICKET' });
    assert.equal((await c.query(`SELECT count(*)::int n FROM tickets WHERE org_id = $1`, [o.id])).rows[0].n, Number(f0.tickets) + 1, 'visible inside the transaction');
    await pool.query('SELECT pg_terminate_backend($1)', [pid]); // the process / connection dies before COMMIT
    c.release(true);
    assert.deepEqual(await footprint(o), f0);
    assert.equal((await one('SELECT status FROM handpays WHERE id = $1', [h.id])).status, h.status);
    // recovery: the payment simply works afterwards, once
    ok(await post(o.t.CASHIER, `/api/v1/cashier/handpays/${o.machines[0].id}`, { payTo: 'TICKET' }));
    // reconciliation: the only open item is the deliberate second accept of the redeemed voucher (previous probe)
    const run = ok(await post(o.t.MANAGER, '/api/v1/money/reconciliation', { casinoId: o.casino })).json();
    const items = run.checks.filter((x: { ok: boolean }) => !x.ok).flatMap((x: { items: string[] }) => x.items);
    assert.deepEqual(items, [`ticket_event:${duplicateAccept}`]);
  });

  test('10: tenants: D cannot pay, read or redeem B\'s voucher or handpay', async () => {
    const v = await one(`SELECT t.id, t.barcode, h.id hid FROM handpays h JOIN tickets t ON t.id = h.payout_ticket_id WHERE h.org_id = $1 LIMIT 1`, [O.B.id]);
    for (const [m, url] of [['GET', `/api/v1/tickets/${v.id}`], ['GET', `/api/v1/tickets/lookup/${v.barcode}`], ['POST', `/api/v1/cashier/handpays/${O.B.machines[0].id}`], ['POST', `/api/v1/handpays/${v.hid}/approval-request`]] as const) {
      const r = await call(O.D.t.admin, m, url, m === 'POST' ? { payTo: 'TICKET' } : undefined);
      assert.ok([403, 404, 409].includes(r.statusCode), `${m} ${url}: ${r.statusCode}`);
      assert.ok(!r.body.includes(v.barcode));
    }
    assert.equal((await gw(O.D, '/api/v1/gateway/tickets/hold', { machineId: O.B.machines[1].code, barcode: v.barcode })).json().ok, false);
  });
});

const explained = { eventId: '', gr0: 0 };
describe('F3 verification: customer D', () => {
  test('vault without Cash; collection; machine <-> wallet accounts; ticket / jackpot quarantined; settlement blocked while unexplained', async () => {
    const o = O.D;
    const [m0, m1] = [o.machines[0].id, o.machines[1].id];
    const s = ok(await post(o.t.MANAGER, '/api/v1/vault/sessions', { casinoId: o.casino, count: { totalCents: 1_000_000 } })).json();
    ok(await post(o.t.admin, `/api/v1/vault/counts/${s.count.id}/verify`, { totalCents: 1_000_000 }));
    assert.equal(await raw(o, 'DRAWER'), 0);
    assert.equal(await n(`SELECT count(*)::int n FROM ledger_accounts WHERE org_id = $1 AND kind = 'DRAWER'`, [o.id]), 0, 'no drawer account exists');
    await event(o, 0, 'CASH_IN', { amount: 20 });
    const c = ok(await post(o.t.MANAGER, `/api/v1/machines/${m0}/collections/count`, { totalCents: 2_000 })).json();
    ok(await post(o.t.admin, `/api/v1/machines/collections/counts/${c.id}/verify`, { totalCents: 2_000 }));
    assert.deepEqual([await raw(o, 'CASHBOX', m0), await raw(o, 'VAULT')], [0, 1_002_000]);
    // machine -> wallet uses MACHINE_CREDIT and WALLET_AVAILABLE only
    const card = `D-${randomUUID().slice(0, 8)}`;
    const p = ok(await post(o.t.CASHIER, '/api/v1/players', { profile: { firstName: 'Pat', lastName: 'D' }, card: { cardNumber: card } })).json();
    const sess = (await gw(o, '/api/v1/gateway/cashless/sessions', { machineId: o.machines[0].code, cardNumber: card, requestKey: randomUUID() })).json().session;
    const tr = (await gw(o, '/api/v1/gateway/cashless/transfers', { sessionId: sess.id, direction: 'FROM_MACHINE', amountCents: 1_500, requestKey: randomUUID() })).json().transfer;
    await gw(o, `/api/v1/gateway/cashless/transfers/${tr.id}/sent`, {});
    const out = await event(o, 0, 'CASHLESS_OUT', { amount: 15, transferId: tr.id });
    const kinds = (await pool.query(`SELECT a.kind, e.amount_cents::int c FROM money_transactions t JOIN ledger_entries e ON e.transaction_id = t.id JOIN ledger_accounts a ON a.id = e.account_id WHERE t.source_event_id = $1 ORDER BY e.amount_cents DESC`, [out.eventId])).rows;
    assert.deepEqual(kinds, [{ kind: 'MACHINE_CREDIT', c: 1_500 }, { kind: 'WALLET_AVAILABLE', c: -1_500 }]);
    void p;
    // ticket printed on a machine of a casino without TITO: quarantined, never booked
    await pool.query('UPDATE machines SET credit_meter_reliable = true WHERE id = $1', [m1]);
    await event(o, 1, 'CASH_IN', { amount: 50 });
    const tOut = await event(o, 1, 'TITO_OUT', { amount: 25, ticketBarcode: barcode() });
    assert.deepEqual(tOut.body.exceptions.map((x: { code: string }) => x.code), ['TITO_NOT_ON_LEDGER']);
    assert.equal(await n(`SELECT count(*)::int n FROM money_transactions WHERE source_event_id = $1`, [tOut.eventId]), 0);
    // bypass attempts: settlement at a reliable meter, at zero credit, and a direct service call are all skipped
    const gr0 = await raw(o, 'GAMING_RESULT');
    await event(o, 1, 'CREDIT_METER', { creditCents: 2_500 });
    await event(o, 1, 'CREDIT_METER', { creditCents: 0 });
    const { handleCreditMeter } = await import('../src/services/machine-money');
    const { withTransaction } = await import('@m1/database');
    const meterEv = await event(o, 1, 'MACHINE_ERROR', { errorCode: 'probe' });
    const direct = await withTransaction(pool, (db) => handleCreditMeter(db, { orgId: o.id, casinoId: o.casino, machineId: m1, label: 'probe', eventId: meterEv.eventId, creditCents: 2_500, occurredAt: new Date().toISOString() }));
    assert.equal(direct.outcome, 'UNRECONCILED');
    assert.equal(await raw(o, 'GAMING_RESULT'), gr0, 'nothing reached the gaming result');
    // a jackpot is quarantined too: no handpay, no money
    const jp = await event(o, 2, 'JACKPOT', { amount: 70 });
    assert.deepEqual(jp.body.exceptions.map((x: { code: string }) => x.code), ['HANDPAY_NOT_ON_LEDGER']);
    assert.equal(await n(`SELECT count(*)::int n FROM handpays WHERE org_id = $1`, [o.id]), 0);
    explained.eventId = tOut.eventId;
    explained.gr0 = gr0;
  });

  // KNOWN GAP (pre-existing since 7d, reachable for D via F3): an explanation releases the settlement block,
  // and there is no four-eyes ledger correction, so the unbooked amount of the event lands in GAMING_RESULT.
  test('settlement after an explained ticket exception does not book the unbooked voucher as gaming result', { todo: 'needs a booked correction for credit-changing machine exceptions' }, async () => {
    const o = O.D;
    const tOut = { eventId: explained.eventId };
    const gr0 = explained.gr0;
    const m1 = o.machines[1].id; void m1;
    const r = ok(await post(o.t.MANAGER, '/api/v1/money/resolutions', { casinoId: o.casino, itemKey: `machine_event:${tOut.eventId}`, explanation: 'Ticket printed by mistake, voucher of 25.00 handed to the player' })).json();
    assert.ok((await post(o.t.MANAGER, `/api/v1/approvals/${r.id}/decide`, { decision: 'APPROVED' })).statusCode >= 400, 'no self-approval');
    ok(await post(o.t.ACCOUNTING, `/api/v1/approvals/${r.id}/decide`, { decision: 'APPROVED' }));
    for (const f of (await pool.query(`SELECT id FROM money_rail_freezes WHERE org_id = $1 AND lifted_at IS NULL`, [o.id])).rows)
      ok(await post(o.t.admin, `/api/v1/money/freezes/${f.id}/lift`, { reason: 'explained with four eyes' }));
    await event(o, 1, 'CREDIT_METER', { creditCents: 2_500 });
    const settled = await raw(o, 'GAMING_RESULT') - gr0;
    // physical truth: 50 in, 25 left as a voucher outside the system, 25 credit remain -> the players lost nothing.
    assert.equal(settled, 0, `after the explanation the unbooked 25.00 voucher must not be booked as gaming result (booked ${settled})`);
  });
});
