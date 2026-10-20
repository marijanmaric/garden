import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from '@m1/database';
import { ENTITLEMENT_ERRORS } from '@m1/shared';
import { withTransaction } from '@m1/database';
import { setupTestDatabase } from './helpers';

/**
 * Final acceptance before the first pilot customer. Five customer organisations are onboarded through the
 * platform API exactly as in production (organisation, plan, casino, machines, gateway, users) and their money
 * rails are cut over through the real HTTP cutover (blind counts, second person, dry run). Every customer then
 * runs the operations of its purchased modules end to end and is refused everything else by the backend.
 *
 *   A  TITO only               plan TITO_STARTER     CORE TITO REPORTING
 *   B  TITO + Handpay          plan TITO_HANDPAY     CORE TITO HANDPAY REPORTING
 *   C  Cash + Vault + TITO     plan CASH_OPERATIONS  CORE CASH VAULT TITO HANDPAY REPORTING
 *   D  Cashless + Machine      plan CASHLESS_MACHINE CORE CASHLESS MACHINE VAULT REPORTING
 *   E  Enterprise              plan ENTERPRISE       every module
 *
 * "Player" and "Jackpot" are part of CORE in this product (players, cards, jackpot display); there is no
 * separate module for them.
 */
let app: FastifyInstance;
let pool: Pool;
let platform: string;

type Role = 'admin' | 'CASINO_ADMIN' | 'MANAGER' | 'CASHIER' | 'CASHIER2' | 'FLOOR_SUPERVISOR' | 'ACCOUNTING' | 'ATTENDANT';
interface Org {
  key: string; id: string; slug: string; casino: string; desk: string; vault: string;
  machines: Array<{ id: string; code: string }>; gw: { deviceId: string; key: string };
  t: Record<Role, string>; emp: Record<Role, string>;
}
const O: Record<'A' | 'B' | 'C' | 'D' | 'E', Org> = {} as never;
const PLAN = { A: 'TITO_STARTER', B: 'TITO_HANDPAY', C: 'CASH_OPERATIONS', D: 'CASHLESS_MACHINE', E: 'ENTERPRISE' } as const;
/**
 * Rails each customer cuts over (F3): exactly its purchased money rails. TITO and HANDPAY no longer need Cash where
 * Cash is not in use; MACHINE needs only the vault (count room) and the wallets, plus TITO / HANDPAY where they are used.
 */
const RAILS = { A: ['TITO'], B: ['TITO', 'HANDPAY'], C: ['VAULT', 'CASH', 'HANDPAY', 'TITO'], D: ['VAULT', 'MACHINE'], E: ['VAULT', 'CASH', 'HANDPAY', 'TITO', 'MACHINE'] } as const;

// ---- helpers ------------------------------------------------------------------------------------------
const call = (token: string | undefined, method: string, url: string, payload?: unknown, key: string = randomUUID()) =>
  app.inject({
    method: method as 'GET', url, payload: payload as object,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(method === 'GET' ? {} : { 'idempotency-key': key }) },
  });
const get = (t: string, url: string) => call(t, 'GET', url);
const post = (t: string, url: string, body: unknown = {}, key?: string) => call(t, 'POST', url, body, key);
const ok = <T extends { statusCode: number; body: string }>(r: T, msg = ''): T => { assert.ok(r.statusCode < 300, `${msg}: ${r.statusCode} ${r.body}`); return r; };
const code = (r: { body: string }) => { try { return JSON.parse(r.body).code; } catch { return undefined; } };
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
const gw = (o: Org, url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object, headers: { 'x-gateway-id': o.gw.deviceId, 'x-gateway-key': o.gw.key } });
const event = async (o: Org, i: number, type: string, fields: Record<string, unknown> = {}, eventId = randomUUID(), at = new Date()) => {
  const res = await gw(o, '/api/v1/gateway/events', { events: [{ eventId, type, machineId: o.machines[i].code, timestamp: at.toISOString(), ...fields }] });
  return { res, eventId, body: res.json() };
};
const barcode = () => String(Math.floor(1e17 + Math.random() * 8e17));
const balance = async (o: Org, kind: string, ref: Record<string, string | null> = {}) => {
  const where = Object.entries(ref).map(([k], i) => `AND a.${k} = $${i + 3}`).join(' ');
  const r = await one(`SELECT COALESCE(sum(b.balance_cents * b.normal_sign), 0)::bigint AS v FROM ledger_accounts a JOIN ledger_balances b ON b.account_id = a.id
    WHERE a.org_id = $1 AND a.kind = $2 ${where}`, [o.id, kind, ...Object.values(ref)]);
  return Number(r.v);
};
/** Raw ledger balance (debit positive, credit negative), independent of the account's normal side. */
const rawBalance = async (o: Org, kind: string, ref: Record<string, string> = {}) => {
  const where = Object.keys(ref).map((k, i) => `AND a.${k} = $${i + 3}`).join(' ');
  return Number((await one(`SELECT COALESCE(sum(b.balance_cents), 0)::bigint AS v FROM ledger_accounts a JOIN ledger_balances b ON b.account_id = a.id WHERE a.org_id = $1 AND a.kind = $2 ${where}`,
    [o.id, kind, ...Object.values(ref)])).v);
};
/** The postings of the transactions of an organisation, as "TYPE KIND+cents" lines (proof of the accounting). */
const postingsOf = async (o: Org, where = 'TRUE', p: unknown[] = []) => (await q(
  `SELECT t.type, a.kind, e.amount_cents::bigint AS c, t.id FROM money_transactions t JOIN ledger_entries e ON e.transaction_id = t.id JOIN ledger_accounts a ON a.id = e.account_id
   WHERE t.org_id = $1 AND ${where} ORDER BY t.created_at, t.id, e.amount_cents DESC`, [o.id, ...p])).map((r) => `${r.type} ${r.kind}${Number(r.c) > 0 ? '+' : ''}${Number(r.c)}`);
const reconcile = async (o: Org) => ok(await post(o.t.FLOOR_SUPERVISOR, '/api/v1/money/reconciliation', { casinoId: o.casino })).json();
const failed = (run: { checks: Array<{ ok: boolean; key: string; items: string[] }> }) => run.checks.filter((c) => !c.ok).map((c) => `${c.key}: ${c.items.join(',')}`);
const yesterdayOf = async (o: Org) => (await one(`SELECT ((now() AT TIME ZONE timezone)::date - 1)::text d FROM casinos WHERE id = $1`, [o.casino])).d as string;
const railMode = async (o: Org) => Object.fromEntries((await get(o.t.admin, `/api/v1/money/rails?casinoId=${o.casino}`)).json().rails.map((x: { rail: string; mode: string }) => [x.rail, x.mode]));
const moneyTx = async (o: Org) => Number((await one('SELECT count(*)::int n FROM money_transactions WHERE org_id = $1', [o.id])).n);
const invariants = async () => {
  const unbalanced = (await one(`SELECT count(*)::int n FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount_cents) <> 0) x`)).n;
  const negative = (await one(`SELECT count(*)::int n FROM ledger_balances b WHERE NOT b.allow_negative AND b.balance_cents * b.normal_sign < 0`)).n;
  return { unbalanced, negative };
};
/** Not entitled: 403 with the safe message and a code that says why. */
const refused = (r: { statusCode: number; body: string }, expected = 'MODULE_NOT_ENTITLED', msg = '') => {
  assert.equal(r.statusCode, 403, `${msg} ${r.body}`);
  assert.equal(code(r), expected, `${msg} ${r.body}`);
  if (expected === 'MODULE_NOT_ENTITLED') assert.ok(JSON.parse(r.body).error.startsWith(ENTITLEMENT_ERRORS.MODULE_NOT_ENTITLED), r.body);
};

async function tokenFor(email: string) {
  const { signToken } = await import('../src/auth');
  const e = await one('SELECT id, org_id, role, name, email FROM employees WHERE lower(email) = lower($1)', [email]);
  return signToken({ sub: e.id, orgId: e.org_id, role: e.role, name: e.name, email: e.email });
}

async function onboard(k: keyof typeof O): Promise<Org> {
  const slug = `cust-${k.toLowerCase()}`;
  const planId = (await one('SELECT id FROM plans WHERE code = $1 ORDER BY version DESC LIMIT 1', [PLAN[k]])).id;
  const org = ok(await post(platform, '/api/v1/platform/organizations', {
    name: `Customer ${k}`, slug, planId, admin: { name: `Admin ${k}`, email: `admin@${slug}.test`, password: 'correct-horse-battery' },
  }), 'org').json();
  const casino = ok(await post(platform, `/api/v1/platform/organizations/${org.id}/casinos`, { code: `${k}-CAS`, name: `Casino ${k}` }), 'casino').json().id;
  const machines: Org['machines'] = [];
  for (let i = 1; i <= 4; i++) {
    const c = `${k}-M${i}`;
    machines.push({ id: ok(await post(platform, `/api/v1/platform/organizations/${org.id}/machines`, { casinoId: casino, machineCode: c, assetNo: `A${i}` }), 'machine').json().id, code: c });
  }
  // gateway registration exactly as `npm run gateway -w @m1/database` does it (hash only, machines assigned)
  const gwKey = randomUUID();
  const g = await one(`INSERT INTO gateways (org_id, casino_id, device_id, name, api_key_hash) VALUES ($1,$2,$3,$3,$4) RETURNING id`,
    [org.id, casino, `${k}-GW`, createHash('sha256').update(gwKey).digest('hex')]);
  await pool.query('UPDATE machines SET gateway_id = $1 WHERE casino_id = $2 AND gateway_id IS NULL', [g.id, casino]);
  const admin = await tokenFor(`admin@${slug}.test`);
  const t = { admin } as Record<Role, string>;
  const emp = { admin: org.adminId } as Record<Role, string>;
  for (const r of ['CASINO_ADMIN', 'MANAGER', 'CASHIER', 'CASHIER2', 'FLOOR_SUPERVISOR', 'ACCOUNTING', 'ATTENDANT'] as const) {
    const email = `${r.toLowerCase()}@${slug}.test`;
    emp[r] = ok(await post(admin, '/api/v1/employees', { name: r, role: r === 'CASHIER2' ? 'CASHIER' : r, email, password: 'password-12345', casinoIds: [casino] }), r).json().id;
    t[r] = await tokenFor(email);
  }
  const desk = (await one('SELECT id FROM cash_desks WHERE casino_id = $1', [casino])).id;
  const vault = (await one('SELECT id FROM vaults WHERE casino_id = $1', [casino])).id;
  return { key: k, id: org.id, slug, casino, desk, vault, machines, gw: { deviceId: `${k}-GW`, key: gwKey }, t, emp };
}

/** The real cutover over HTTP: blind count by the manager, verification by the admin, then the cutover. */
async function cutover(o: Org) {
  const count = async (context: string, ref: Record<string, string>, totalCents: number) => {
    const c = ok(await post(o.t.MANAGER, '/api/v1/money/counts', { casinoId: o.casino, context, ...ref, totalCents }), `count ${context}`).json();
    ok(await post(o.t.admin, `/api/v1/money/counts/${c.id}/verify`, { totalCents }), `verify ${context}`);
  };
  for (const rail of RAILS[o.key as keyof typeof RAILS] as readonly string[]) {
    if (rail === 'VAULT') await count('VAULT_CUTOVER', { vaultId: o.vault }, 10_000_000);
    if (rail === 'CASH') await count('DRAWER_CUTOVER', { cashDeskId: o.desk }, 0);
    if (rail === 'MACHINE') {
      for (const m of o.machines) {
        await count('MACHINE_DROP', { machineId: m.id }, 0);
        ok(await post(o.t.admin, '/api/v1/money/cutover', { rail, machineId: m.id }), `cutover MACHINE ${m.code}`);
      }
      continue;
    }
    ok(await post(o.t.admin, '/api/v1/money/cutover', { rail, casinoId: o.casino }), `cutover ${rail} ${o.key}`);
  }
}

/** Vault open with a blind count (manager) verified by a second person (admin). */
async function openVault(o: Org, cents = 10_000_000) {
  const s = ok(await post(o.t.MANAGER, '/api/v1/vault/sessions', { casinoId: o.casino, count: { totalCents: cents } }), 'vault open').json();
  ok(await post(o.t.admin, `/api/v1/vault/counts/${s.count.id}/verify`, { totalCents: cents }), 'vault verify');
  return s;
}

/** A ledger shift: empty drawer, float as a FILL from the vault, confirmed by the cashier with a count. */
async function openShift(o: Org, who: 'CASHIER' | 'CASHIER2', floatCents: number) {
  let desk = (await one(`SELECT d.id FROM cash_desks d WHERE d.casino_id = $1 AND NOT EXISTS (SELECT 1 FROM cashier_sessions s WHERE s.cash_desk_id = d.id AND s.status <> 'CLOSED')`, [o.casino]))?.id;
  if (!desk) desk = (await one(`INSERT INTO cash_desks (org_id, casino_id, name) VALUES ($1,$2,$3) RETURNING id`, [o.id, o.casino, `Desk ${who}`])).id;
  const s = ok(await post(o.t[who], '/api/v1/cashier/session/open', { cashDeskId: desk, openingBalance: 0 }), 'shift').json();
  const f = ok(await post(o.t.MANAGER, '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: s.id, amountCents: floatCents }), 'fill').json();
  assert.equal(ok(await post(o.t[who], `/api/v1/cash/movements/${f.movement.id}/confirm`, { totalCents: floatCents }), 'fill confirm').json().movement.status, 'CONFIRMED');
  return s.id as string;
}

async function registerPlayer(o: Org, who: Role = 'CASHIER') {
  const card = `${o.key}-${randomUUID().slice(0, 8)}`;
  const p = ok(await post(o.t[who], '/api/v1/players', { profile: { firstName: 'Pat', lastName: o.key }, card: { cardNumber: card } }), 'player').json();
  return { id: p.player.id as string, card, cardId: p.card.id as string, walletId: p.walletId as string };
}
const wallet = async (playerId: string) => {
  const r = await one('SELECT available_cents::bigint a, reserved_cents::bigint r FROM wallet_balances WHERE player_id = $1', [playerId]);
  return { a: Number(r.a), r: Number(r.r) };
};

before(async () => {
  ({ app, pool } = await setupTestDatabase());
  platform = await tokenFor('platform@example.com');
  for (const k of ['A', 'B', 'C', 'D', 'E'] as const) {
    O[k] = await onboard(k);
    await cutover(O[k]);
  }
});

after(async () => {
  await app?.close();
  await pool?.end();
});

describe('Final acceptance: five customers', () => {
  test('setup (F3): every customer runs exactly its purchased rails on the ledger; true dependencies still enforced; visible to customer and platform', async () => {
    for (const [k, rails] of Object.entries(RAILS)) {
      const o = O[k as keyof typeof O];
      const r = (await get(o.t.admin, `/api/v1/money/rails?casinoId=${o.casino}`)).json();
      for (const rail of (rails as readonly string[]).filter((x) => x !== 'MACHINE')) assert.equal(r.rails.find((x: { rail: string }) => x.rail === rail).mode, 'LEDGER', `${k} ${rail}`);
      if ((rails as readonly string[]).includes('MACHINE')) assert.equal(r.machinesOnLedger, 4, k);
      assert.equal(r.rails.find((x: { rail: string }) => x.rail === 'CASHLESS').mode, 'LEDGER', `${k}: the organisation-wide cashless rail starts on the ledger (no money)`);
    }
    // what is not purchased stays legacy (nothing was cut over to make another rail work)
    assert.deepEqual([(await railMode(O.A)).VAULT, (await railMode(O.A)).CASH, (await railMode(O.B)).CASH, (await railMode(O.D)).CASH, (await railMode(O.D)).TITO, (await railMode(O.D)).HANDPAY],
      ['LEGACY', 'LEGACY', 'LEGACY', 'LEGACY', 'LEGACY', 'LEGACY']);
    // the cutover report records why a workflow prerequisite did not apply
    const checks = async (o: Org, rail: string) => (await one(`SELECT checks FROM money_rail_cutovers WHERE org_id = $1 AND rail = $2 LIMIT 1`, [o.id, rail])).checks.map((c: { name: string }) => c.name);
    assert.ok((await checks(O.A, 'TITO')).includes('not_in_use:CASH'));
    assert.ok((await checks(O.B, 'HANDPAY')).includes('not_in_use:CASH'));
    const dm = await checks(O.D, 'MACHINE');
    assert.ok(dm.includes('prerequisite:VAULT') && dm.includes('prerequisite:CASHLESS') && dm.includes('not_in_use:TITO') && dm.includes('not_in_use:HANDPAY'), dm.join());
    // a true dependency is still enforced: machine cash is collected into the vault, so MACHINE needs VAULT
    const before = await moneyTx(O.A);
    const c = ok(await post(O.A.t.MANAGER, '/api/v1/money/counts', { casinoId: O.A.casino, context: 'MACHINE_DROP', machineId: O.A.machines[0].id, totalCents: 0 })).json();
    ok(await post(O.A.t.admin, `/api/v1/money/counts/${c.id}/verify`, { totalCents: 0 }));
    const m = await post(O.A.t.admin, '/api/v1/money/cutover', { rail: 'MACHINE', machineId: O.A.machines[0].id });
    assert.equal(m.statusCode, 409);
    assert.match(m.json().error, /prerequisite:VAULT/);
    assert.doesNotMatch(m.json().error, /prerequisite:(CASH|HANDPAY)\b/, 'no accidental dependency');
    assert.equal(await moneyTx(O.A), before, 'a refused cutover leaves nothing behind');
    assert.equal((await one(`SELECT count(*)::int n FROM money_rail_cutovers WHERE org_id = $1 AND rail = 'MACHINE'`, [O.A.id])).n, 0);
    // shown, never silent: customer module cards and platform plan list
    const lim = async (o: Org, mod: string) => ok(await get(o.t.admin, '/api/v1/org')).json().modules.find((x: { module: string }) => x.module === mod).limitations.join(' ');
    assert.equal(await lim(O.A, 'TITO'), 'Tickets are accepted and redeemed at machines only: cage redemption and ticket sale need Cash.');
    assert.equal(await lim(O.B, 'HANDPAY'), 'Handpays are paid as TITO vouchers only: cash payment needs Cash.');
    assert.doesNotMatch(await lim(O.D, 'MACHINE'), /cannot run on the ledger/);
    assert.equal(await lim(O.C, 'TITO'), '', 'C is ledger-ready');
    const plans = ok(await get(platform, '/api/v1/platform/plans')).json().plans;
    const gaps = Object.fromEntries(plans.map((p: { code: string; ledgerGaps: unknown[] }) => [p.code, p.ledgerGaps.length]));
    assert.deepEqual([gaps.TITO_STARTER, gaps.TITO_HANDPAY, gaps.CASHLESS_MACHINE, gaps.CASH_OPERATIONS, gaps.ENTERPRISE], [0, 0, 0, 0, 0]);
    // no cash account exists where cash is not purchased (no fake dependency)
    for (const o of [O.A, O.B]) assert.equal((await one(`SELECT count(*)::int n FROM ledger_accounts WHERE org_id = $1 AND kind IN ('DRAWER', 'VAULT', 'CASHBOX', 'HOPPER', 'MACHINE_CREDIT')`, [o.id])).n, 0, o.key);
    assert.equal((await one(`SELECT count(*)::int n FROM ledger_accounts WHERE org_id = $1 AND kind IN ('DRAWER', 'TICKET_LIABILITY', 'HANDPAY_PAYABLE', 'LEGACY_FLOOR_CLEARING')`, [O.D.id])).n, 0);
    // gateway: machines added later are served by the casino gateway
    const nm = ok(await post(O.A.t.admin, '/api/v1/org/machines', { casinoId: O.A.casino, machineCode: 'A-M5', assetNo: 'A5' })).json();
    assert.ok((await one('SELECT gateway_id FROM machines WHERE id = $1', [nm.id])).gateway_id, 'auto-assigned to the only gateway of the casino');
    assert.equal((await gw(O.A, '/api/v1/gateway/heartbeat', {})).json().machines.length, 5);
    // a repeated cutover is refused; the opening exists exactly once
    const again = await post(O.C.t.admin, '/api/v1/money/cutover', { rail: 'VAULT', casinoId: O.C.casino });
    assert.ok(again.statusCode === 409 || again.json().replayed === true, again.body);
    assert.equal((await one(`SELECT count(*)::int n FROM money_transactions WHERE org_id = $1 AND type = 'OPENING_BALANCE' AND casino_id = $2 AND vault_id IS NOT NULL`, [O.C.id, O.C.casino])).n, 1);
    assert.deepEqual(await invariants(), { unbalanced: 0, negative: 0 });
  });

  // ---------------------------------------------------------------------------------------------
  test('A (TITO only, TITO on the ledger, no Cash): print, hold race, accept, expiry, four-eyes cancel; balanced postings; floor clearing attributable; reconciliation and day close', async () => {
    const o = O.A;
    const code1 = barcode();
    const printed = await event(o, 0, 'TITO_OUT', { amount: 25, ticketBarcode: code1 });
    assert.equal(printed.body.accepted, 1, printed.res.body);
    assert.equal((await one('SELECT status FROM tickets WHERE barcode = $1', [code1])).status, 'VALID');
    assert.equal((await event(o, 0, 'TITO_OUT', { amount: 25, ticketBarcode: code1 }, printed.eventId)).body.duplicates, 1, 'a resend creates nothing');
    assert.equal((await one('SELECT count(*)::int n FROM tickets WHERE barcode = $1', [code1])).n, 1);
    // 15 machines race for the same ticket: exactly one hold
    const holds = await Promise.all(Array.from({ length: 15 }, (_, i) => gw(o, '/api/v1/gateway/tickets/hold', { machineId: o.machines[1 + (i % 3)].code, barcode: code1 })));
    const winners = holds.map((h, i) => ({ h: h.json(), i })).filter((x) => x.h.ok);
    assert.equal(winners.length, 1, JSON.stringify(holds.map((h) => h.json())));
    const idx = 1 + (winners[0].i % 3);
    const acc = await event(o, idx, 'TITO_IN', { ticketBarcode: code1, holdId: winners[0].h.holdId });
    assert.equal(acc.body.accepted, 1, acc.res.body);
    assert.equal((await one('SELECT status FROM tickets WHERE barcode = $1', [code1])).status, 'REDEEMED');
    assert.equal((await gw(o, '/api/v1/gateway/tickets/hold', { machineId: o.machines[2].code, barcode: code1 })).json().ok, false, 'never twice');
    assert.equal((await gw(o, '/api/v1/gateway/tickets/hold', { machineId: o.machines[1].code, barcode: '999999999999999999' })).json().ok, false, 'unknown');
    // expiry: never accepted, booked as income by the expiry job
    const code2 = barcode();
    await event(o, 0, 'TITO_OUT', { amount: 7, ticketBarcode: code2 });
    await pool.query(`UPDATE tickets SET expires_at = now() - interval '1 minute' WHERE barcode = $1`, [code2]);
    assert.equal((await gw(o, '/api/v1/gateway/tickets/hold', { machineId: o.machines[1].code, barcode: code2 })).json().ok, false, 'expired');
    const { expireTicketsLedger } = await import('../src/services/tito');
    await withTransaction(pool, (db) => expireTicketsLedger(db, { casinoId: o.casino }));
    assert.equal((await one('SELECT status FROM tickets WHERE barcode = $1', [code2])).status, 'EXPIRED');
    // cancel of a machine ticket: four eyes (the requester cannot approve), then never accepted
    const code3 = barcode();
    await event(o, 0, 'TITO_OUT', { amount: 10, ticketBarcode: code3 });
    const t3 = await one('SELECT id FROM tickets WHERE barcode = $1', [code3]);
    const cr = ok(await post(o.t.MANAGER, `/api/v1/tickets/${t3.id}/cancel`, { reason: 'printer fault, ticket destroyed' })).json();
    assert.ok((await post(o.t.MANAGER, `/api/v1/approvals/${cr.approval.id}/decide`, { decision: 'APPROVED' })).statusCode >= 400, 'no self-approval');
    ok(await post(o.t.ACCOUNTING, `/api/v1/approvals/${cr.approval.id}/decide`, { decision: 'APPROVED' }));
    assert.equal((await one('SELECT status FROM tickets WHERE id = $1', [t3.id])).status, 'CANCELLED');
    assert.equal((await gw(o, '/api/v1/gateway/tickets/hold', { machineId: o.machines[1].code, barcode: code3 })).json().ok, false, 'cancelled');
    // one ticket stays outstanding
    const code4 = barcode();
    await event(o, 1, 'TITO_OUT', { amount: 12, ticketBarcode: code4 });

    // proof: every booking, balanced, nothing else
    assert.deepEqual(await postingsOf(o), [
      'TITO_ISSUE_MACHINE LEGACY_FLOOR_CLEARING+2500', 'TITO_ISSUE_MACHINE TICKET_LIABILITY-2500',
      'TITO_REDEEM_MACHINE TICKET_LIABILITY+2500', 'TITO_REDEEM_MACHINE LEGACY_FLOOR_CLEARING-2500',
      'TITO_ISSUE_MACHINE LEGACY_FLOOR_CLEARING+700', 'TITO_ISSUE_MACHINE TICKET_LIABILITY-700',
      'TITO_EXPIRY TICKET_LIABILITY+700', 'TITO_EXPIRY EXPIRED_TICKET_INCOME-700',
      'TITO_ISSUE_MACHINE LEGACY_FLOOR_CLEARING+1000', 'TITO_ISSUE_MACHINE TICKET_LIABILITY-1000',
      'TITO_CANCEL TICKET_LIABILITY+1000', 'TITO_CANCEL TITO_ADJUSTMENT-1000',
      'TITO_ISSUE_MACHINE LEGACY_FLOOR_CLEARING+1200', 'TITO_ISSUE_MACHINE TICKET_LIABILITY-1200',
    ]);
    // ticket liability = the outstanding ticket exactly (raw ledger sign: credit negative)
    assert.equal(await rawBalance(o, 'TICKET_LIABILITY'), -1_200);
    assert.equal(Number((await one(`SELECT COALESCE(sum(amount_cents), 0)::bigint s FROM tickets WHERE org_id = $1 AND status IN ('VALID', 'HELD')`, [o.id])).s), 1_200);
    // the D1 floor clearing per machine = its own ticket events (printed - accepted), attributable, no other source
    for (const [i, m] of o.machines.entries())
      assert.equal(await rawBalance(o, 'LEGACY_FLOOR_CLEARING', { machine_id: m.id }), (i === 0 ? 4_200 : 0) + (i === 1 ? 1_200 : 0) + (i === idx ? -2_500 : 0), m.code);
    assert.equal((await one(`SELECT count(*)::int n FROM ledger_accounts WHERE org_id = $1 AND kind IN ('DRAWER', 'VAULT', 'CASHBOX', 'HOPPER', 'MACHINE_CREDIT', 'WALLET_AVAILABLE')`, [o.id])).n, 0, 'no cash, vault or machine account');
    // reconciliation (TITO mandatory) and the day close
    const run = await reconcile(o);
    assert.equal(run.ok, true, failed(run).join('; '));
    assert.ok(run.checks.some((c: { key: string; ok: boolean }) => c.key === 'tito.floor_clearing_attributable' && c.ok));
    const st = ok(await get(o.t.FLOOR_SUPERVISOR, `/api/v1/money/day-close/status?casinoId=${o.casino}`)).json();
    assert.deepEqual(st.railsInUse, ['TITO']);
    const close = ok(await post(o.t.MANAGER, '/api/v1/money/day-close', { casinoId: o.casino, businessDate: await yesterdayOf(o) })).json();
    assert.equal(close.closed, true, JSON.stringify(close).slice(0, 400));
    assert.ok(await one(`SELECT 1 FROM audit_logs WHERE org_id = $1 AND entity_id = $2 AND action LIKE 'ticket.%'`, [o.id, t3.id]), 'cancel audited');
    // not purchased: cage (Cash), vault, handpay, cashless, machine money, advanced reconciliation
    refused(await post(o.t.CASHIER, '/api/v1/tickets/redeem', { barcode: code4 }), 'MODULE_NOT_ENTITLED', 'cage redemption needs Cash');
    refused(await get(o.t.admin, `/api/v1/cashier/desks?casinoId=${o.casino}`));
    refused(await get(o.t.admin, `/api/v1/vault/status?casinoId=${o.casino}`));
    refused(await get(o.t.admin, '/api/v1/cashier/handpays'));
    refused(await post(o.t.CASHIER, '/api/v1/cashier/wallet/approval-request', {}));
    refused(await post(o.t.admin, `/api/v1/machines/${o.machines[0].id}/hopper-fills`, { amountCents: 100 }));
    refused(await get(o.t.admin, '/api/v1/audit/verify'));
    refused(await gw(o, '/api/v1/gateway/cashless/sessions', { machineId: o.machines[0].code, cardNumber: 'X-1', requestKey: randomUUID() }));
    const reps = ok(await get(o.t.admin, '/api/v1/reports')).json().map((r: { key: string }) => r.key);
    assert.ok(reps.includes('tickets') && !reps.includes('cashier-sessions') && !reps.includes('jackpot-wins'), reps.join());
    ok(await get(o.t.admin, `/api/v1/reports/tickets?casinoId=${o.casino}&from=2026-01-01&to=2030-12-31`));
    assert.deepEqual(await invariants(), { unbalanced: 0, negative: 0 });
  });

  // ---------------------------------------------------------------------------------------------
  test('B (TITO + Handpay on the ledger, no Cash): jackpot liability, four-eyes approval, payout as a TITO voucher exactly once, reset, voucher redeemed at a machine; balanced', async () => {
    const o = O.B;
    const jp = await event(o, 0, 'JACKPOT', { amount: 250 });
    assert.equal(jp.body.accepted, 1, jp.res.body);
    assert.equal((await event(o, 0, 'JACKPOT', { amount: 250 }, jp.eventId)).body.duplicates, 1);
    const h = await one('SELECT id, status FROM handpays WHERE source_event_id = $1', [jp.eventId]);
    assert.equal(h.status, 'PENDING');
    // cash and wallet payouts are not purchased (refused, nothing booked); the voucher is the payout
    const tx0 = await moneyTx(o);
    refused(await post(o.t.CASHIER, `/api/v1/cashier/handpays/${o.machines[0].id}`, {}));
    refused(await post(o.t.CASHIER, `/api/v1/cashier/handpays/${o.machines[0].id}`, { payTo: 'WALLET', playerCard: 'X' }));
    assert.equal(await moneyTx(o), tx0);
    // above the approval limit: four eyes; the approver cannot pay
    assert.equal((await pool.query('UPDATE casino_money_settings SET handpay_approval_cents = 10000 WHERE casino_id = $1', [o.casino])).rowCount, 1);
    const early = await post(o.t.CASHIER, `/api/v1/cashier/handpays/${o.machines[0].id}`, { payTo: 'TICKET' });
    assert.equal(early.statusCode, 409, early.body);
    const ap = ok(await post(o.t.CASHIER, `/api/v1/handpays/${h.id}/approval-request`)).json();
    const apId = ap.approval?.id ?? ap.id;
    assert.ok((await post(o.t.CASHIER, `/api/v1/approvals/${apId}/decide`, { decision: 'APPROVED' })).statusCode >= 400, 'the cashier cannot approve');
    ok(await post(o.t.MANAGER, `/api/v1/approvals/${apId}/decide`, { decision: 'APPROVED' }));
    const byApprover = await post(o.t.MANAGER, `/api/v1/cashier/handpays/${o.machines[0].id}`, { payTo: 'TICKET' });
    assert.ok(byApprover.statusCode >= 400, `the approver cannot pay: ${byApprover.body}`);
    // 15 parallel voucher payouts of the same jackpot: exactly one
    const pays = await Promise.all(Array.from({ length: 15 }, () => post(o.t.CASHIER, `/api/v1/cashier/handpays/${o.machines[0].id}`, { payTo: 'TICKET', jackpotEventId: jp.eventId })));
    const paid = pays.filter((r) => r.statusCode === 200);
    assert.equal(paid.length, 1, pays.map((r) => `${r.statusCode}`).join());
    const voucher = paid[0].json().voucher;
    assert.equal(voucher.amountCents, 25_000);
    const hp = await one('SELECT status, pay_method, payout_ticket_id, cashier_session_id FROM handpays WHERE id = $1', [h.id]);
    assert.deepEqual([hp.status, hp.pay_method, hp.payout_ticket_id, hp.cashier_session_id], ['PAID', 'TICKET', voucher.ticketId, null]);
    const vt = await one('SELECT status, amount_cents, barcode FROM tickets WHERE id = $1', [voucher.ticketId]);
    assert.deepEqual([vt.status, Number(vt.amount_cents), vt.barcode], ['VALID', 25_000, voucher.barcode]);
    assert.equal((await one(`SELECT count(*)::int n FROM money_transactions WHERE handpay_id = $1 AND type = 'HANDPAY_PAY'`, [h.id])).n, 1);
    assert.ok(await one(`SELECT 1 FROM audit_logs WHERE org_id = $1 AND action = 'handpay.paid' AND entity_id = $2`, [o.id, h.id]), 'payment audited');
    // the machine reset is requested and confirmed independently of the payment
    const cmds = (await gw(o, '/api/v1/gateway/heartbeat', {})).json().pendingCommands as Array<{ id: string; type: string }>;
    const resetCmd = cmds.find((x) => x.type === 'RESET_JACKPOT');
    assert.ok(resetCmd, JSON.stringify(cmds));
    ok(await gw(o, `/api/v1/gateway/commands/${resetCmd!.id}/result`, { success: true }));
    assert.equal((await one('SELECT status FROM handpays WHERE id = $1', [h.id])).status, 'MACHINE_RESET');
    // the voucher is an ordinary ticket: accepted by another machine exactly once
    const hd = (await gw(o, '/api/v1/gateway/tickets/hold', { machineId: o.machines[2].code, barcode: voucher.barcode })).json();
    assert.equal(hd.ok, true, JSON.stringify(hd));
    assert.equal((await event(o, 2, 'TITO_IN', { ticketBarcode: voucher.barcode, holdId: hd.holdId })).body.accepted, 1);
    assert.equal((await gw(o, '/api/v1/gateway/tickets/hold', { machineId: o.machines[3].code, barcode: voucher.barcode })).json().ok, false);
    // proof: jackpot expense -> handpay payable -> ticket liability -> the accepting machine; balanced
    assert.deepEqual(await postingsOf(o), [
      'HANDPAY_CREATE_JACKPOT GAMING_JACKPOT_EXPENSE+25000', 'HANDPAY_CREATE_JACKPOT HANDPAY_PAYABLE-25000',
      'HANDPAY_PAY HANDPAY_PAYABLE+25000', 'HANDPAY_PAY TICKET_LIABILITY-25000',
      'TITO_REDEEM_MACHINE TICKET_LIABILITY+25000', 'TITO_REDEEM_MACHINE LEGACY_FLOOR_CLEARING-25000',
    ]);
    assert.deepEqual([await rawBalance(o, 'HANDPAY_PAYABLE'), await rawBalance(o, 'TICKET_LIABILITY')], [0, 0]);
    assert.equal(await rawBalance(o, 'LEGACY_FLOOR_CLEARING', { machine_id: o.machines[2].id }), -25_000, 'the credit given by the accepting machine, attributable to its event');
    assert.equal((await one(`SELECT count(*)::int n FROM ledger_accounts WHERE org_id = $1 AND kind IN ('DRAWER', 'VAULT', 'WALLET_AVAILABLE')`, [o.id])).n, 0);
    // Cash / Vault are never reachable
    ok(await get(o.t.admin, '/api/v1/cashier/handpays'));
    refused(await put(o.t.admin, '/api/v1/org/modules/CASH', { enabled: true }));
    refused(await get(o.t.admin, `/api/v1/vault/status?casinoId=${o.casino}`));
    refused(await post(o.t.CASHIER, '/api/v1/cashier/session/open', { cashDeskId: o.desk, openingBalance: 0 }));
    const run = await reconcile(o);
    assert.equal(run.ok, true, failed(run).join('; '));
    const st = ok(await get(o.t.FLOOR_SUPERVISOR, `/api/v1/money/day-close/status?casinoId=${o.casino}`)).json();
    assert.deepEqual([...st.railsInUse].sort(), ['HANDPAY', 'TITO']);
    const close = ok(await post(o.t.MANAGER, '/api/v1/money/day-close', { casinoId: o.casino, businessDate: await yesterdayOf(o) })).json();
    assert.equal(close.closed, true, JSON.stringify(close).slice(0, 400));
    assert.deepEqual(await invariants(), { unbalanced: 0, negative: 0 });
  });

  // ---------------------------------------------------------------------------------------------
  test('C (Cash + Vault + TITO + Handpay): blind vault, fill with receiving count, cage TITO, cash handpay, drop, blind shift close; never twice', async () => {
    const o = O.C;
    const v = await openVault(o);
    // the first counter does not learn the expected amount from the vault view
    const vs = ok(await get(o.t.MANAGER, `/api/v1/vault/status?casinoId=${o.casino}`)).json();
    assert.ok(!JSON.stringify(vs).includes('10000000'), `blind vault view: ${JSON.stringify(vs).slice(0, 300)}`);
    void v;
    const shift = await openShift(o, 'CASHIER', 200_000);
    // a fill counted wrong by the receiver is not booked
    const f2 = ok(await post(o.t.MANAGER, '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: shift, amountCents: 10_000 })).json();
    const wrong = ok(await post(o.t.CASHIER, `/api/v1/cash/movements/${f2.movement.id}/confirm`, { totalCents: 9_000 })).json();
    assert.notEqual(wrong.movement.status, 'CONFIRMED', JSON.stringify(wrong));
    const drawer = () => balance(o, 'DRAWER', { casino_id: o.casino });
    assert.equal(await drawer(), 200_000, 'only the confirmed float is in the drawer');
    // the cashier's own drawer balance stays blind in every view
    const sh = ok(await get(o.t.CASHIER, '/api/v1/cashier/shift')).json();
    assert.ok(!JSON.stringify(sh).includes('200000'), JSON.stringify(sh).slice(0, 300));
    const dash = ok(await get(o.t.CASHIER, `/api/v1/dashboard?casinoId=${o.casino}`)).json();
    assert.ok(dash.cashier.every((c: { balance: unknown }) => c.balance === null));
    // cage ticket: sale, redemption, never twice (15 parallel redemptions)
    const sale = ok(await post(o.t.CASHIER, '/api/v1/tickets/issue', { amount: 40 })).json();
    const reds = await Promise.all(Array.from({ length: 15 }, () => post(o.t.CASHIER, '/api/v1/tickets/redeem', { barcode: sale.barcode })));
    assert.equal(reds.filter((r) => r.statusCode === 200).length, 1, reds.map((r) => r.statusCode).join());
    assert.equal(await drawer(), 200_000);
    // machine ticket redeemed at the cage once
    const mt = barcode();
    await event(o, 0, 'TITO_OUT', { amount: 12, ticketBarcode: mt });
    ok(await post(o.t.CASHIER, '/api/v1/tickets/redeem', { barcode: mt }));
    assert.equal((await post(o.t.CASHIER, '/api/v1/tickets/redeem', { barcode: mt })).statusCode, 409);
    assert.equal(await drawer(), 200_000 - 1_200);
    // cash handpay: 15 parallel payments of one jackpot -> one payment; reset afterwards, independently retryable
    const jp = await event(o, 1, 'JACKPOT', { amount: 300 });
    const pays = await Promise.all(Array.from({ length: 15 }, () => post(o.t.CASHIER, `/api/v1/cashier/handpays/${o.machines[1].id}`, {})));
    assert.equal(pays.filter((r) => r.statusCode === 200).length, 1, pays.map((r) => `${r.statusCode}`).join());
    const h = await one('SELECT id, status FROM handpays WHERE source_event_id = $1', [jp.eventId]);
    assert.equal(h.status, 'PAID');
    assert.equal(await drawer(), 200_000 - 1_200 - 30_000);
    assert.equal((await one(`SELECT count(*)::int n FROM money_transactions WHERE handpay_id = $1 AND type = 'HANDPAY_PAY'`, [h.id])).n, 1);
    const cmds = (await gw(o, '/api/v1/gateway/heartbeat', {})).json().pendingCommands as Array<{ id: string; type: string }>;
    const resetCmd = cmds.find((x) => x.type === 'RESET_JACKPOT');
    assert.ok(resetCmd, JSON.stringify(cmds));
    ok(await gw(o, `/api/v1/gateway/commands/${resetCmd!.id}/result`, { success: true }));
    assert.equal((await one('SELECT status FROM handpays WHERE id = $1', [h.id])).status, 'MACHINE_RESET');
    // drop to the vault: confirmed by the vault with its own count
    const drop = ok(await post(o.t.CASHIER, '/api/v1/cash/movements', { kind: 'DROP', amountCents: 50_000 })).json();
    assert.equal((await post(o.t.CASHIER, `/api/v1/cash/movements/${drop.movement.id}/confirm`, { totalCents: 50_000 })).statusCode >= 400, true, 'the cashier cannot confirm the own drop');
    assert.equal(ok(await post(o.t.MANAGER, `/api/v1/cash/movements/${drop.movement.id}/confirm`, { totalCents: 50_000 })).json().movement.status, 'CONFIRMED');
    const again = await post(o.t.MANAGER, `/api/v1/cash/movements/${drop.movement.id}/confirm`, { totalCents: 50_000 });
    assert.ok(again.statusCode >= 400 || again.json().movement.status === 'CONFIRMED');
    assert.equal(await drawer(), 200_000 - 1_200 - 30_000 - 50_000, 'a second confirmation books nothing');
    // blind shift close: the cashier counts without seeing the expected amount
    const expected = await drawer();
    const close = ok(await post(o.t.CASHIER, '/api/v1/cashier/session/close', { countedBalance: expected / 100 })).json();
    assert.ok(!JSON.stringify(close).includes(String(expected)) || close.expected === undefined, 'no expected amount to the counting cashier');
    // Cashless / Machine money not purchased
    refused(await post(o.t.CASHIER, '/api/v1/cashier/wallet/approval-request', {}));
    refused(await post(o.t.MANAGER, `/api/v1/machines/${o.machines[0].id}/hopper-fills`, { amountCents: 100 }));
    refused(await gw(o, '/api/v1/gateway/cashless/transfers', {}));
    refused(await post(o.t.CASHIER, '/api/v1/tickets/redeem', { barcode: barcode(), payTo: 'WALLET', playerCard: 'X-1' }));
    const run = ok(await post(o.t.FLOOR_SUPERVISOR, '/api/v1/money/reconciliation', { casinoId: o.casino })).json();
    assert.equal(run.ok, true, JSON.stringify(run.checks?.filter((c: { ok: boolean }) => !c.ok)));
    assert.deepEqual(await invariants(), { unbalanced: 0, negative: 0 });
  });

  // ---------------------------------------------------------------------------------------------
  test('D (Cashless + Machine + Vault on the ledger, no Cash / TITO / Handpay): vault, machine cash in, wallet transfers, settlement, collection, hopper fill; unbooked ticket / jackpot events are exceptions, never gaming', async () => {
    const o = O.D;
    const [m0, m1, m2, m3] = o.machines.map((m) => m.id);
    // the vault works without Cash: blind open count verified by a second person (F3: no accidental Cash dependency)
    await openVault(o);
    assert.equal(await rawBalance(o, 'VAULT'), 10_000_000);
    const p = await registerPlayer(o);
    ok(await post(o.t.CASHIER, `/api/v1/players/${p.id}/verification`, { status: 'VERIFIED', documentType: 'ID_CARD', documentNumber: 'AB1234567' }));
    const ver = await one('SELECT document_number_masked, document_number_hash FROM player_verifications WHERE player_id = $1', [p.id]);
    assert.ok(!ver.document_number_masked.includes('1234567') && ver.document_number_hash.length === 64, 'document stored masked and hashed only');
    // bill acceptor: the money entry point of a casino without a cage
    const cin = await event(o, 0, 'CASH_IN', { amount: 50 });
    assert.equal(cin.body.accepted, 1, cin.res.body);
    assert.equal((await event(o, 0, 'CASH_IN', { amount: 50 }, cin.eventId)).body.duplicates, 1);
    // machine -> wallet, wallet -> machine (reservation, confirmation)
    const s = (await gw(o, '/api/v1/gateway/cashless/sessions', { machineId: o.machines[0].code, cardNumber: p.card, requestKey: randomUUID() })).json().session;
    assert.ok(s?.id, 'cashless session');
    const back = (await gw(o, '/api/v1/gateway/cashless/transfers', { sessionId: s.id, direction: 'FROM_MACHINE', amountCents: 3_000, requestKey: randomUUID() })).json().transfer;
    await gw(o, `/api/v1/gateway/cashless/transfers/${back.id}/sent`, {});
    assert.equal((await event(o, 0, 'CASHLESS_OUT', { amount: 30, transferId: back.id })).body.exceptions.length, 0);
    const to = (await gw(o, '/api/v1/gateway/cashless/transfers', { sessionId: s.id, direction: 'TO_MACHINE', amountCents: 1_000, requestKey: randomUUID() })).json().transfer;
    assert.deepEqual(await wallet(p.id), { a: 2_000, r: 1_000 });
    const ack = await event(o, 0, 'CASHLESS_IN', { amount: 10, transferId: to.id });
    assert.equal((await event(o, 0, 'CASHLESS_IN', { amount: 10, transferId: to.id }, ack.eventId)).body.duplicates, 1, 'a resent ack is a duplicate (parallel acks: see E)');
    assert.equal((await one(`SELECT count(*)::int n FROM money_transactions WHERE type = 'WALLET_TO_MACHINE_CONFIRM' AND transfer_id = $1`, [to.id])).n, 1);
    assert.deepEqual(await wallet(p.id), { a: 2_000, r: 0 });
    // D3 settlement at a reliable credit meter (configuration): players lost 10.00
    await pool.query('UPDATE machines SET credit_meter_reliable = true WHERE id = ANY($1)', [[m0, m3]]);
    const meter = await event(o, 0, 'CREDIT_METER', { creditCents: 2_000 });
    assert.equal(meter.body.accepted, 1, meter.res.body);
    // the machine pays the rest into the wallet: zero credit
    const rest = (await gw(o, '/api/v1/gateway/cashless/transfers', { sessionId: s.id, direction: 'FROM_MACHINE', amountCents: 2_000, requestKey: randomUUID() })).json().transfer;
    await gw(o, `/api/v1/gateway/cashless/transfers/${rest.id}/sent`, {});
    await event(o, 0, 'CASHLESS_OUT', { amount: 20, transferId: rest.id });
    assert.deepEqual(await wallet(p.id), { a: 4_000, r: 0 });
    // collection into the vault (count room): blind count, second person
    const cc = ok(await post(o.t.MANAGER, `/api/v1/machines/${m0}/collections/count`, { totalCents: 5_000 })).json();
    ok(await post(o.t.admin, `/api/v1/machines/collections/counts/${cc.id}/verify`, { totalCents: 5_000 }));
    // hopper fill from the vault, confirmed at the machine by another person
    const fill = ok(await post(o.t.MANAGER, `/api/v1/machines/${m1}/hopper-fills`, { amountCents: 2_000 })).json();
    assert.equal(ok(await post(o.t.ATTENDANT, `/api/v1/machines/hopper-fills/${fill.movement.id}/confirm`, { totalCents: 2_000 })).json().movement.status, 'CONFIRMED');

    // proof: every booking, balanced; the wallets hold exactly what came from the bill acceptor minus the gaming result
    assert.deepEqual((await postingsOf(o, `t.type <> 'OPENING_BALANCE'`)), [
      'MACHINE_CASH_IN CASHBOX+5000', 'MACHINE_CASH_IN MACHINE_CREDIT-5000',
      'MACHINE_TO_WALLET MACHINE_CREDIT+3000', 'MACHINE_TO_WALLET WALLET_AVAILABLE-3000',
      'WALLET_TO_MACHINE_RESERVE WALLET_AVAILABLE+1000', 'WALLET_TO_MACHINE_RESERVE WALLET_RESERVED-1000',
      'WALLET_TO_MACHINE_CONFIRM WALLET_RESERVED+1000', 'WALLET_TO_MACHINE_CONFIRM MACHINE_CREDIT-1000',
      'GAMING_SETTLEMENT MACHINE_CREDIT+1000', 'GAMING_SETTLEMENT GAMING_RESULT-1000',
      'MACHINE_TO_WALLET MACHINE_CREDIT+2000', 'MACHINE_TO_WALLET WALLET_AVAILABLE-2000',
      'MACHINE_DROP VAULT+5000', 'MACHINE_DROP CASHBOX-5000',
      'HOPPER_FILL HOPPER+2000', 'HOPPER_FILL VAULT-2000',
    ]);
    assert.deepEqual([await rawBalance(o, 'CASHBOX'), await rawBalance(o, 'MACHINE_CREDIT', { machine_id: m0 }), await rawBalance(o, 'WALLET_AVAILABLE'), await rawBalance(o, 'WALLET_RESERVED'), await rawBalance(o, 'GAMING_RESULT'), await rawBalance(o, 'VAULT'), await rawBalance(o, 'HOPPER')],
      [0, 0, -4_000, 0, -1_000, 10_000_000 + 5_000 - 2_000, 2_000]);
    let run = await reconcile(o);
    assert.equal(run.ok, true, failed(run).join('; '));

    // a ticket printed and a jackpot hit on a machine of this casino: TITO / HANDPAY not purchased, not on the ledger.
    // Physical facts are kept; no money is invented and nothing is folded into the gaming result.
    const tOut = await event(o, 3, 'TITO_OUT', { amount: 25, ticketBarcode: barcode() });
    assert.equal(tOut.res.statusCode, 200, tOut.res.body);
    assert.deepEqual(tOut.body.exceptions.map((x: { code: string }) => x.code), ['TITO_NOT_ON_LEDGER']);
    const jp = await event(o, 2, 'JACKPOT', { amount: 90 });
    assert.deepEqual(jp.body.exceptions.map((x: { code: string }) => x.code), ['HANDPAY_NOT_ON_LEDGER']);
    assert.equal((await one('SELECT count(*)::int n FROM machine_events WHERE event_id = ANY($1)', [[tOut.eventId, jp.eventId]])).n, 2, 'both physical events are recorded');
    assert.equal((await one('SELECT count(*)::int n FROM money_transactions WHERE source_event_id = ANY($1)', [[tOut.eventId, jp.eventId]])).n, 0);
    assert.equal((await one('SELECT count(*)::int n FROM tickets WHERE org_id = $1', [o.id])).n + (await one('SELECT count(*)::int n FROM handpays WHERE org_id = $1', [o.id])).n, 0, 'no ticket, no handpay');
    assert.equal((await event(o, 3, 'TITO_OUT', { amount: 25 }, tOut.eventId)).body.duplicates, 1);
    // a reliable meter on that machine is NOT settled while the unbooked ticket is unexplained
    const gr = await rawBalance(o, 'GAMING_RESULT');
    await event(o, 3, 'CREDIT_METER', { creditCents: 0 });
    assert.equal(await rawBalance(o, 'GAMING_RESULT'), gr, 'never estimated into gaming');
    assert.ok(await one(`SELECT 1 FROM audit_logs WHERE org_id = $1 AND action = 'machine.settlement_skipped' AND details->>'reason' LIKE 'unexplained money event exceptions%'`, [o.id]));
    // reconciliation (MACHINE mandatory) reports exactly these two and freezes only these machines
    run = await reconcile(o);
    assert.equal(run.ok, false);
    assert.deepEqual(failed(run), [`machine.events_accounted: ${[`machine_event:${tOut.eventId}`, `machine_event:${jp.eventId}`].sort().join(',')}`]);
    const frozen = await q(`SELECT machine_id FROM money_rail_freezes WHERE org_id = $1 AND rail = 'MACHINE' AND lifted_at IS NULL`, [o.id]);
    assert.deepEqual(frozen.map((f) => f.machine_id).sort(), [m2, m3].sort());
    // explained with four eyes, then clean; freezes lifted
    for (const key of [`machine_event:${tOut.eventId}`, `machine_event:${jp.eventId}`]) {
      const r = ok(await post(o.t.MANAGER, '/api/v1/money/resolutions', { casinoId: o.casino, itemKey: key, explanation: 'Event of a module this casino does not run; machine disabled for tickets / jackpots by the operator' })).json();
      ok(await post(o.t.ACCOUNTING, `/api/v1/approvals/${r.id}/decide`, { decision: 'APPROVED' }));
    }
    run = await reconcile(o);
    assert.equal(run.ok, true, failed(run).join('; '));
    for (const f of await q(`SELECT id FROM money_rail_freezes WHERE org_id = $1 AND lifted_at IS NULL`, [o.id]))
      ok(await post(o.t.admin, `/api/v1/money/freezes/${f.id}/lift`, { reason: 'explained with four eyes' }));
    // not purchased: TITO, cage (Cash), handpay
    assert.deepEqual((await gw(o, '/api/v1/gateway/tickets/hold', { machineId: o.machines[1].code, barcode: barcode() })).json(), { ok: false, reason: 'MODULE_NOT_ENTITLED' });
    refused(await post(o.t.CASHIER, '/api/v1/cashier/wallet/approval-request', {}), 'MODULE_NOT_ENTITLED', 'cage deposit needs Cash');
    refused(await post(o.t.CASHIER, '/api/v1/cashier/session/open', { cashDeskId: o.desk, openingBalance: 0 }));
    refused(await get(o.t.admin, '/api/v1/tickets'));
    refused(await get(o.t.admin, '/api/v1/cashier/handpays'));
    const lims = ok(await get(o.t.admin, '/api/v1/org')).json().modules.filter((m: { module: string }) => ['CASHLESS', 'MACHINE'].includes(m.module)).flatMap((m: { limitations: string[] }) => m.limitations).join(' ');
    assert.match(lims, /through machines only/);
    assert.doesNotMatch(lims, /cannot run on the ledger/);
    const st = ok(await get(o.t.FLOOR_SUPERVISOR, `/api/v1/money/day-close/status?casinoId=${o.casino}`)).json();
    assert.deepEqual([...st.railsInUse].sort(), ['CASHLESS', 'MACHINE', 'VAULT']);
    const close = ok(await post(o.t.MANAGER, '/api/v1/money/day-close', { casinoId: o.casino, businessDate: await yesterdayOf(o) })).json();
    assert.equal(close.closed, true, JSON.stringify(close).slice(0, 400));
    assert.deepEqual(await invariants(), { unbalanced: 0, negative: 0 });
  });

  // ---------------------------------------------------------------------------------------------
  // ---------------------------------------------------------------------------------------------
  test('E (Enterprise) money concurrency: same wallet, same ticket, same handpay, same Idempotency-Key (15 parallel each)', async () => {
    const o = O.E;
    await openVault(o);
    await openShift(o, 'CASHIER', 500_000);
    const p = await registerPlayer(o);
    // deposit 300 at the cage
    ok(await post(o.t.CASHIER, '/api/v1/cashier/wallet/deposit', { playerCard: p.card, amount: 300 }));
    assert.deepEqual(await wallet(p.id), { a: 30_000, r: 0 });
    // same Idempotency-Key, same request, 15 in parallel: exactly one booking
    const before = await moneyTx(o);
    const key = `same-${randomUUID()}`;
    const same = await Promise.all(Array.from({ length: 15 }, () => post(o.t.CASHIER, '/api/v1/cashier/wallet/deposit', { playerCard: p.card, amount: 10 }, key)));
    assert.equal(await moneyTx(o) - before, 1, same.map((r) => r.statusCode).join());
    assert.deepEqual(await wallet(p.id), { a: 31_000, r: 0 });
    assert.ok(same.every((r) => r.statusCode === 200 || r.statusCode === 409), same.map((r) => r.statusCode).join());
    // same key, different payload: refused
    const diff = await post(o.t.CASHIER, '/api/v1/cashier/wallet/deposit', { playerCard: p.card, amount: 11 }, key);
    assert.equal(diff.statusCode, 422, diff.body);
    // replay returns the same answer, books nothing
    const replay = await post(o.t.CASHIER, '/api/v1/cashier/wallet/deposit', { playerCard: p.card, amount: 10 }, key);
    assert.equal(replay.headers['idempotent-replayed'], 'true');
    assert.equal(await moneyTx(o) - before, 1);
    // same wallet: 15 parallel withdrawals of 30 from 310: at most 10 succeed, never negative
    const wd = await Promise.all(Array.from({ length: 15 }, () => post(o.t.CASHIER, '/api/v1/cashier/wallet/withdraw', { playerCard: p.card, amount: 30 })));
    const okW = wd.filter((r) => r.statusCode === 200).length;
    assert.equal(okW, 10, wd.map((r) => r.statusCode).join());
    assert.deepEqual(await wallet(p.id), { a: 1_000, r: 0 });
    // same ticket: 15 parallel cage redemptions -> one
    const t = ok(await post(o.t.CASHIER, '/api/v1/tickets/issue', { amount: 20 })).json();
    const red = await Promise.all(Array.from({ length: 15 }, () => post(o.t.CASHIER, '/api/v1/tickets/redeem', { barcode: t.barcode })));
    assert.equal(red.filter((r) => r.statusCode === 200).length, 1);
    // same handpay: 15 parallel payments (cash and wallet mixed) -> one
    const jp = await event(o, 0, 'JACKPOT', { amount: 80 });
    const pays = await Promise.all(Array.from({ length: 15 }, (_, i) => post(o.t.CASHIER, `/api/v1/cashier/handpays/${o.machines[0].id}`, i % 2 ? { payTo: 'WALLET', playerCard: p.card } : {})));
    assert.equal(pays.filter((r) => r.statusCode === 200).length, 1, pays.map((r) => r.statusCode).join());
    const h = await one('SELECT id FROM handpays WHERE source_event_id = $1', [jp.eventId]);
    assert.equal((await one(`SELECT count(*)::int n FROM money_transactions WHERE handpay_id = $1 AND type = 'HANDPAY_PAY'`, [h.id])).n, 1);
    // machine events: 15 resends of one CASH_IN -> one booking
    const evId = randomUUID();
    await Promise.all(Array.from({ length: 15 }, () => event(o, 1, 'CASH_IN', { amount: 20 }, evId)));
    assert.equal((await one('SELECT count(*)::int n FROM money_transactions WHERE source_event_id = $1', [evId])).n, 1);
    assert.deepEqual(await invariants(), { unbalanced: 0, negative: 0 });
    const run = ok(await post(o.t.FLOOR_SUPERVISOR, '/api/v1/money/reconciliation', { casinoId: o.casino })).json();
    assert.equal(run.ok, true, JSON.stringify(run.checks?.filter((c: { ok: boolean }) => !c.ok)));
  });

  // ---------------------------------------------------------------------------------------------
  test('E (Enterprise) machine money + cashless: player and card onboarding, machine cash in, machine <-> wallet with reservation, failure, duplicate and concurrent acks', async () => {
    const o = O.E;
    const p = await registerPlayer(o);
    ok(await post(o.t.CASHIER, `/api/v1/players/${p.id}/verification`, { status: 'VERIFIED', documentType: 'ID_CARD', documentNumber: 'AB1234567' }));
    const ver = await one('SELECT document_number_masked, document_number_hash FROM player_verifications WHERE player_id = $1', [p.id]);
    assert.ok(!ver.document_number_masked.includes('1234567') && ver.document_number_hash.length === 64, 'document stored masked and hashed only');
    const credit = (i: number) => balance(o, 'MACHINE_CREDIT', { machine_id: o.machines[i].id });
    const cin = await event(o, 0, 'CASH_IN', { amount: 50 });
    assert.equal(cin.body.accepted, 1, cin.res.body);
    assert.equal(await credit(0), 5_000);
    const s = (await gw(o, '/api/v1/gateway/cashless/sessions', { machineId: o.machines[0].code, cardNumber: p.card, requestKey: randomUUID() })).json().session;
    assert.ok(s?.id, 'cashless session');
    // machine -> wallet
    const back = (await gw(o, '/api/v1/gateway/cashless/transfers', { sessionId: s.id, direction: 'FROM_MACHINE', amountCents: 3_000, requestKey: randomUUID() })).json().transfer;
    await gw(o, `/api/v1/gateway/cashless/transfers/${back.id}/sent`, {});
    const out = await event(o, 0, 'CASHLESS_OUT', { amount: 30, transferId: back.id });
    assert.equal(out.body.exceptions.length, 0, out.res.body);
    assert.deepEqual(await wallet(p.id), { a: 3_000, r: 0 });
    assert.equal(await credit(0), 2_000);
    // wallet -> machine: request reserves, the ack moves it; 15 concurrent acks (different event ids) move it once
    const to = (await gw(o, '/api/v1/gateway/cashless/transfers', { sessionId: s.id, direction: 'TO_MACHINE', amountCents: 1_000, requestKey: randomUUID() })).json().transfer;
    assert.deepEqual(await wallet(p.id), { a: 2_000, r: 1_000 });
    await Promise.all(Array.from({ length: 15 }, () => event(o, 0, 'CASHLESS_IN', { amount: 10, transferId: to.id })));
    assert.equal((await one(`SELECT count(*)::int n FROM money_transactions WHERE type = 'WALLET_TO_MACHINE_CONFIRM' AND transfer_id = $1`, [to.id])).n, 1);
    assert.deepEqual(await wallet(p.id), { a: 2_000, r: 0 });
    assert.equal(await credit(0), 3_000);
    // failure releases the reservation; more than available is refused (never negative)
    const f = (await gw(o, '/api/v1/gateway/cashless/transfers', { sessionId: s.id, direction: 'TO_MACHINE', amountCents: 500, requestKey: randomUUID() })).json().transfer;
    assert.equal((await gw(o, `/api/v1/gateway/cashless/transfers/${f.id}/fail`, { reason: 'machine busy' })).json().status, 'FAILED');
    assert.deepEqual(await wallet(p.id), { a: 2_000, r: 0 });
    const tooMuch = await gw(o, '/api/v1/gateway/cashless/transfers', { sessionId: s.id, direction: 'TO_MACHINE', amountCents: 999_999, requestKey: randomUUID() });
    assert.equal(tooMuch.statusCode, 409, tooMuch.body);
    // 15 parallel transfer requests on the same machine: one active transfer at most
    const par = await Promise.all(Array.from({ length: 15 }, () => gw(o, '/api/v1/gateway/cashless/transfers', { sessionId: s.id, direction: 'TO_MACHINE', amountCents: 100, requestKey: randomUUID() })));
    assert.equal(par.filter((r) => r.statusCode === 200).length, 1, par.map((r) => r.statusCode).join());
    assert.equal((await one(`SELECT count(*)::int n FROM wallet_transfers WHERE machine_id = $1 AND status IN ('REQUESTED', 'SENT')`, [o.machines[0].id])).n, 1);
    const w = await wallet(p.id);
    assert.ok(w.a >= 0 && w.r === 100);
    // card blocked: no new session
    ok(await post(o.t.CASHIER, `/api/v1/players/cards/${p.cardId}/status`, { status: 'BLOCKED', reason: 'reported by player' }));
    const blockedSession = await gw(o, '/api/v1/gateway/cashless/sessions', { machineId: o.machines[1].code, cardNumber: p.card, requestKey: randomUUID() });
    assert.ok(blockedSession.statusCode >= 400 || !blockedSession.json().session, blockedSession.body);
    // the 14 rejected duplicate acks are recorded exceptions: the run reports them (and freezes only that machine)
    const first = ok(await post(o.t.FLOOR_SUPERVISOR, '/api/v1/money/reconciliation', { casinoId: o.casino })).json();
    const items: string[] = first.checks.filter((c: { ok: boolean }) => !c.ok).flatMap((c: { items: string[] }) => c.items);
    assert.equal(items.length, 14, JSON.stringify(first.checks.filter((c: { ok: boolean }) => !c.ok)));
    const frozen = await q(`SELECT rail, machine_id FROM money_rail_freezes WHERE org_id = $1 AND lifted_at IS NULL`, [o.id]);
    assert.deepEqual(frozen.map((f) => [f.rail, f.machine_id]), [['MACHINE', o.machines[0].id]], 'only the affected machine is frozen');
    // explanation with four eyes (the requester cannot approve), then clean and lifted
    for (const key of items) {
      const r = ok(await post(o.t.MANAGER, '/api/v1/money/resolutions', { casinoId: o.casino, itemKey: key, explanation: 'Duplicate machine ack, transfer already confirmed, no money moved' })).json();
      assert.equal((await post(o.t.MANAGER, `/api/v1/approvals/${r.id}/decide`, { decision: 'APPROVED' })).statusCode >= 400, true);
      ok(await post(o.t.ACCOUNTING, `/api/v1/approvals/${r.id}/decide`, { decision: 'APPROVED' }));
    }
    const run = ok(await post(o.t.FLOOR_SUPERVISOR, '/api/v1/money/reconciliation', { casinoId: o.casino })).json();
    assert.equal(run.ok, true, JSON.stringify(run.checks?.filter((c: { ok: boolean }) => !c.ok)));
    for (const f of await q(`SELECT id FROM money_rail_freezes WHERE org_id = $1 AND lifted_at IS NULL`, [o.id]))
      ok(await post(o.t.admin, `/api/v1/money/freezes/${f.id}/lift`, { reason: 'explained with four eyes' }));
    assert.deepEqual(await invariants(), { unbalanced: 0, negative: 0 });
  });

  // ---------------------------------------------------------------------------------------------
  test('tenant isolation C <-> E: players, cards, tickets, wallets, machines, employees, approvals, casinos, cutover counts (GET and write)', async () => {
    const a = O.C;
    const b = O.E;
    const pb = await registerPlayer(b);
    const tb = await one(`SELECT id, barcode FROM tickets WHERE org_id = $1 LIMIT 1`, [b.id]);
    const ab = await one(`SELECT id FROM approvals WHERE org_id = $1 LIMIT 1`, [b.id]) ?? { id: randomUUID() };
    const mvB = await one(`SELECT id FROM cash_movements WHERE org_id = $1 LIMIT 1`, [b.id]);
    const hb = await one(`SELECT id FROM handpays WHERE org_id = $1 LIMIT 1`, [b.id]);
    const probes: Array<[string, string, unknown?]> = [
      ['GET', `/api/v1/players/lookup/${pb.card}`], ['GET', `/api/v1/tickets/${tb.id}`], ['GET', `/api/v1/tickets/lookup/${tb.barcode}`],
      ['GET', `/api/v1/machines/${b.machines[0].id}`], ['GET', `/api/v1/machines/${b.machines[0].id}/money`], ['GET', `/api/v1/cash/collections/expected/${b.machines[0].id}`],
      ['GET', `/api/v1/employees/${b.emp.CASHIER}/activity`], ['GET', `/api/v1/dashboard?casinoId=${b.casino}`], ['GET', `/api/v1/vault/status?casinoId=${b.casino}`],
      ['GET', `/api/v1/money/day-close/status?casinoId=${b.casino}`], ['GET', `/api/v1/cashier/desks?casinoId=${b.casino}`], ['GET', `/api/v1/reports/tickets?casinoId=${b.casino}`],
      ['POST', `/api/v1/players/${pb.id}/cards`, { cardNumber: 'HIJACK-1' }], ['POST', `/api/v1/players/cards/${pb.cardId}/status`, { status: 'BLOCKED', reason: 'attack' }],
      ['POST', `/api/v1/players/${pb.id}/verification`, { status: 'REJECTED' }], ['POST', `/api/v1/players/${pb.id}/status`, { status: 'SUSPENDED', reason: 'attack' }],
      ['POST', `/api/v1/tickets/${tb.id}/void`, { reason: 'attack' }], ['POST', '/api/v1/tickets/redeem', { barcode: tb.barcode }],
      ['POST', `/api/v1/approvals/${ab.id}/decide`, { decision: 'APPROVED' }], ['POST', `/api/v1/handpays/${hb.id}/reset`],
      ['POST', `/api/v1/cash/movements/${mvB.id}/confirm`, { totalCents: 1 }], ['POST', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: (await one(`SELECT id FROM cashier_sessions WHERE org_id = $1 LIMIT 1`, [b.id])).id, amountCents: 1 }],
      ['POST', `/api/v1/cashier/handpays/${b.machines[0].id}`, {}], ['POST', '/api/v1/cashier/wallet/deposit', { playerCard: pb.card, amount: 1 }],
      ['POST', `/api/v1/machines/${b.machines[0].id}/commands`, { type: 'LOCK' }], ['PUT', `/api/v1/employees/${b.emp.CASHIER}`, { name: 'x', role: 'CASHIER', active: false, casinoIds: [] }],
      ['PUT', `/api/v1/org/casinos/${b.casino}/status`, { status: 'INACTIVE', reason: 'attack' }], ['POST', '/api/v1/org/machines', { casinoId: b.casino, machineCode: 'X-1', assetNo: 'X' }],
      ['POST', '/api/v1/money/counts', { casinoId: b.casino, context: 'VAULT_CUTOVER', vaultId: b.vault, totalCents: 1 }], ['POST', '/api/v1/money/reconciliation', { casinoId: b.casino }],
      ['POST', '/api/v1/money/day-close', { casinoId: b.casino, businessDate: '2020-01-01' }], ['GET', `/api/v1/platform/organizations/${b.id}`],
    ];
    const snapshot = async () => (await one(`SELECT (SELECT count(*) FROM money_transactions WHERE org_id = $1) m, (SELECT string_agg(status, ',' ORDER BY id) FROM player_cards WHERE org_id = $1) c,
      (SELECT string_agg(status, ',' ORDER BY id) FROM tickets WHERE org_id = $1) t, (SELECT string_agg(active::text, ',' ORDER BY id) FROM employees WHERE org_id = $1) e,
      (SELECT string_agg(status, ',' ORDER BY id) FROM casinos WHERE org_id = $1) s, (SELECT count(*) FROM machine_commands WHERE machine_id = ANY($2)) k`, [b.id, b.machines.map((m) => m.id)]));
    const s0 = await snapshot();
    for (const [method, url, body] of probes) {
      for (const role of ['admin', 'MANAGER', 'CASHIER'] as const) {
        const r = await call(a.t[role], method, url, body);
        assert.ok([400, 403, 404, 409, 422].includes(r.statusCode), `${role} ${method} ${url}: ${r.statusCode} ${r.body.slice(0, 200)}`);
        assert.ok(!r.body.includes(pb.card) && !r.body.includes(tb.barcode) && !r.body.includes(b.machines[0].code), `${method} ${url} leaked data`);
      }
    }
    assert.deepEqual(await snapshot(), s0, 'nothing of E changed');
    // payload manipulation: an organisation id in the body is ignored, the object lands in the caller's organisation
    const c = ok(await post(a.t.admin, '/api/v1/org/casinos', { code: 'C-EXTRA', name: 'Extra', orgId: b.id, org_id: b.id })).json();
    assert.equal((await one('SELECT org_id FROM casinos WHERE id = $1', [c.id])).org_id, a.id);
    const e = ok(await post(a.t.admin, '/api/v1/employees', { name: 'Plat', role: 'CASHIER', email: 'plat@cust-c.test', password: 'password-12345', casinoIds: [], isPlatformAdmin: true, is_platform_admin: true, orgId: b.id })).json();
    assert.deepEqual(await one('SELECT org_id, is_platform_admin FROM employees WHERE id = $1', [e.id]), { org_id: a.id, is_platform_admin: false });
    // a gateway of C cannot report events or transfers for machines of E
    const ev = await event({ ...a, machines: b.machines }, 0, 'CASH_IN', { amount: 5 });
    assert.ok(ev.body.rejected?.length === 1 || ev.res.statusCode >= 400, ev.res.body);
    assert.equal((await one('SELECT count(*)::int n FROM machine_events WHERE event_id = $1', [ev.eventId])).n, 0);
  });

  // ---------------------------------------------------------------------------------------------
  test('roles and four-eyes: no escalation, no self-approval, no self-granted module or plan', async () => {
    const o = O.E;
    // customer admin: no plan, no override, no platform admin
    assert.equal((await put(o.t.admin, `/api/v1/platform/organizations/${o.id}/subscription`, { planId: randomUUID(), status: 'ACTIVE', reason: 'self upgrade' })).statusCode, 403);
    assert.equal((await put(o.t.admin, `/api/v1/platform/organizations/${O.A.id}/entitlements/CASH`, { entitled: true, reason: 'self grant' })).statusCode, 403);
    refused(await put(O.A.t.admin, '/api/v1/org/modules/CASH', { enabled: true }));
    // casino admin cannot create a super admin; a manager cannot manage users; a cashier cannot raise the own role
    assert.equal((await post(o.t.CASINO_ADMIN, '/api/v1/employees', { name: 'Xavier', role: 'SUPER_ADMIN', email: 'x1@cust-e.test', password: 'password-12345', casinoIds: [] })).statusCode, 403);
    assert.equal((await post(o.t.MANAGER, '/api/v1/employees', { name: 'Xavier', role: 'CASINO_ADMIN', email: 'x2@cust-e.test', password: 'password-12345', casinoIds: [] })).statusCode, 403);
    assert.equal((await put(o.t.CASHIER, `/api/v1/employees/${o.emp.CASHIER}`, { name: 'C', role: 'CASINO_ADMIN', active: true, casinoIds: [] })).statusCode, 403);
    assert.equal((await put(o.t.CASINO_ADMIN, `/api/v1/employees/${o.emp.admin}`, { name: 'Admin', role: 'CASHIER', active: false, casinoIds: [] })).statusCode, 403, 'a casino admin cannot demote the super admin');
    // organisation administration only with org.manage
    for (const r of ['CASINO_ADMIN', 'MANAGER', 'CASHIER', 'ACCOUNTING'] as const) assert.equal((await get(o.t[r], '/api/v1/org')).statusCode, 403, r);
    // four eyes on wallet cash above the limit: the requester cannot approve
    await pool.query('UPDATE casino_money_settings SET deposit_approval_cents = 10000 WHERE casino_id = $1', [o.casino]);
    const p = await registerPlayer(o);
    const big = await post(o.t.CASHIER, '/api/v1/cashier/wallet/deposit', { playerCard: p.card, amount: 500 });
    assert.ok(big.statusCode >= 400, `above the limit needs approval: ${big.body}`);
    const ar = ok(await post(o.t.CASHIER, '/api/v1/cashier/wallet/approval-request', { playerCard: p.card, amount: 500, kind: 'CASH_DEPOSIT' })).json();
    const aid = ar.approval?.id ?? ar.id;
    assert.equal((await post(o.t.CASHIER, `/api/v1/approvals/${aid}/decide`, { decision: 'APPROVED' })).statusCode, 403, 'cashier cannot decide');
    assert.equal((await post(o.t.MANAGER, `/api/v1/approvals/${aid}/decide`, { decision: 'APPROVED' })).statusCode, 200);
    // audit: role change with old and new value; module change with reason; approvals decided by another person
    ok(await put(o.t.admin, `/api/v1/employees/${o.emp.ATTENDANT}`, { name: 'ATTENDANT', role: 'FLOOR_SUPERVISOR', active: true, casinoIds: [o.casino] }));
    const roleAudit = await one(`SELECT details FROM audit_logs WHERE org_id = $1 AND action = 'employee.updated' AND entity_id = $2 ORDER BY id DESC LIMIT 1`, [o.id, o.emp.ATTENDANT]);
    assert.deepEqual(roleAudit.details.role, { from: 'ATTENDANT', to: 'FLOOR_SUPERVISOR' });
    const appr = await one(`SELECT requested_by, decided_by FROM approvals WHERE id = $1`, [aid]);
    assert.notEqual(appr.requested_by, appr.decided_by);
    // audit rows cannot be changed or deleted
    await assert.rejects(pool.query(`UPDATE audit_logs SET action = 'x' WHERE org_id = $1`, [o.id]));
    await assert.rejects(pool.query(`DELETE FROM audit_logs WHERE org_id = $1`, [o.id]));
    const v = ok(await get(o.t.admin, '/api/v1/audit/verify')).json();
    assert.equal(v.valid, true, JSON.stringify(v));
  });

  // ---------------------------------------------------------------------------------------------
  test('states are distinguishable: NOT_PURCHASED, DISABLED, SUBSCRIPTION_INACTIVE, RAIL_LEGACY, RAIL_FROZEN, BUSINESS_DATE_CLOSED, ORGANIZATION_DISABLED', async () => {
    const o = O.C;
    refused(await get(o.t.admin, '/api/v1/audit/verify'), 'MODULE_NOT_ENTITLED');
    ok(await put(o.t.admin, '/api/v1/org/modules/HANDPAY', { enabled: false, reason: 'test' }));
    refused(await get(o.t.admin, '/api/v1/cashier/handpays'), 'MODULE_DISABLED');
    ok(await put(o.t.admin, '/api/v1/org/modules/HANDPAY', { enabled: true, reason: 'test' }));
    // a casino whose money rails are still legacy: ledger cash operations say RAIL_LEGACY, legacy ones say RAIL_ON_LEDGER elsewhere
    const legacy = ok(await post(o.t.admin, '/api/v1/org/casinos', { code: 'C-LEG', name: 'Legacy casino' })).json().id;
    const legacyDesk = (await one('SELECT id FROM cash_desks WHERE casino_id = $1', [legacy])).id;
    const ls = ok(await post(o.t.admin, '/api/v1/cashier/session/open', { cashDeskId: legacyDesk, openingBalance: 0 })).json();
    const l = await post(o.t.admin, '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: ls.id, amountCents: 100 });
    assert.equal(code(l), 'RAIL_LEGACY', l.body);
    const lt = await post(o.t.CASHIER2, '/api/v1/cashier/transactions', { type: 'CASH_IN', amount: 10 });
    assert.ok(lt.statusCode >= 400, lt.body);
    // frozen rail: only the frozen rail stops, unrelated rails continue; the day close lists it
    await openShift(o, 'CASHIER2', 10_000);
    const fz = await one(`INSERT INTO money_rail_freezes (org_id, rail, casino_id, reason) VALUES ($1,'TITO',$2,'acceptance test') RETURNING id`, [o.id, o.casino]);
    const t = await post(o.t.CASHIER2, '/api/v1/tickets/issue', { amount: 5 });
    assert.equal(code(t), 'RAIL_FROZEN', t.body);
    const st = ok(await get(o.t.FLOOR_SUPERVISOR, `/api/v1/money/day-close/status?casinoId=${o.casino}`)).json();
    assert.ok(st.blockers.some((b: { code: string }) => b.code === 'FROZEN'));
    // a freeze of a rail the customer does not use (MACHINE) does not block the close
    await pool.query(`INSERT INTO money_rail_freezes (org_id, rail, casino_id, machine_id, reason) VALUES ($1,'MACHINE',$2,$3,'unused rail')`, [o.id, o.casino, o.machines[3].id]);
    const st2 = ok(await get(o.t.FLOOR_SUPERVISOR, `/api/v1/money/day-close/status?casinoId=${o.casino}`)).json();
    assert.equal(st2.blockers.filter((b: { message: string }) => /MACHINE/.test(b.message)).length, 0);
    ok(await post(o.t.admin, `/api/v1/money/freezes/${fz.id}/lift`, { reason: 'acceptance test over' }));
    // closed business date: no booking on it
    const yesterday = (await one(`SELECT ((now() AT TIME ZONE timezone)::date - 1)::text d FROM casinos WHERE id = $1`, [o.casino])).d;
    const close = ok(await post(o.t.MANAGER, '/api/v1/money/day-close', { casinoId: o.casino, businessDate: yesterday })).json();
    assert.equal(close.closed, true, JSON.stringify(close).slice(0, 400));
    assert.equal((await post(o.t.MANAGER, '/api/v1/money/day-close', { casinoId: o.casino, businessDate: yesterday })).statusCode, 409, 'closed once');
    const late = await event(o, 0, 'TITO_OUT', { amount: 3, ticketBarcode: barcode() }, randomUUID(), new Date(Date.now() - 26 * 3600 * 1000));
    assert.equal(late.res.statusCode, 200);
    assert.equal((await one(`SELECT count(*)::int n FROM money_transactions WHERE source_event_id = $1 AND business_date = $2::date`, [late.eventId, yesterday])).n, 0, 'nothing is booked on a closed date');
    assert.ok((await one(`SELECT count(*)::int n FROM deferred_money_events WHERE event_id = $1`, [late.eventId])).n === 1 || (await one(`SELECT count(*)::int n FROM money_transactions WHERE source_event_id = $1`, [late.eventId])).n === 0, 'late economic event kept for the explicit late-event process');
    // inactive subscription: reads yes, money no; disabled organisation: nothing
    const planId = (await one(`SELECT id FROM plans WHERE code = 'CASH_OPERATIONS' ORDER BY version DESC LIMIT 1`)).id;
    ok(await put(platform, `/api/v1/platform/organizations/${o.id}/subscription`, { planId, status: 'SUSPENDED', reason: 'acceptance' }));
    assert.equal((await get(o.t.CASHIER, `/api/v1/cashier/desks?casinoId=${o.casino}`)).statusCode, 200);
    refused(await post(o.t.CASHIER2, '/api/v1/tickets/issue', { amount: 5 }), 'SUBSCRIPTION_INACTIVE');
    assert.deepEqual((await gw(o, '/api/v1/gateway/tickets/hold', { machineId: o.machines[1].code, barcode: barcode() })).json(), { ok: false, reason: 'SUBSCRIPTION_INACTIVE' });
    const phys = await event(o, 0, 'TITO_OUT', { amount: 2, ticketBarcode: barcode() });
    assert.equal(phys.body.accepted, 1, 'physical events are still recorded');
    ok(await put(platform, `/api/v1/platform/organizations/${o.id}/subscription`, { planId, status: 'ACTIVE', reason: 'acceptance over' }));
    ok(await put(platform, `/api/v1/platform/organizations/${o.id}/status`, { status: 'DISABLED', reason: 'acceptance' }));
    const d = await get(o.t.CASHIER, `/api/v1/cashier/desks?casinoId=${o.casino}`);
    assert.equal(code(d), 'ORGANIZATION_DISABLED');
    ok(await put(platform, `/api/v1/platform/organizations/${o.id}/status`, { status: 'ACTIVE', reason: 'acceptance over' }));
    assert.equal((await get(o.t.CASHIER, `/api/v1/cashier/desks?casinoId=${o.casino}`)).statusCode, 200, 'reactivation keeps everything');
  });

  test('final: ledger invariants over every organisation; administration created no money', async () => {
    assert.deepEqual(await invariants(), { unbalanced: 0, negative: 0 });
    const opening = await q(`SELECT org_id, count(*)::int n FROM money_transactions WHERE type = 'OPENING_BALANCE' GROUP BY 1`);
    for (const r of opening) assert.ok(r.n <= 10, 'openings only from the cutovers');
  });
});

function put(t: string, url: string, body: unknown) {
  return call(t, 'PUT', url, body);
}
