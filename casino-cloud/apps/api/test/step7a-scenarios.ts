import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { ACCOUNT_KIND_KEYS, ACCOUNT_KIND_RAIL, cents } from '@m1/shared';

/**
 * Step 7a scenarios: final ledger guard, legacy write protection, LegacyProjection, vault / drawer
 * operations, counts, short / over, four eyes, reconciliation, freezes and day close. The same
 * scenarios run on a fresh seeded database and on a realistic upgraded one (D7).
 *
 * Roles: manager = vault (cash.manage), accounting = second counter / supervisor, cashier and
 * attendant = cashiers, floor = shift supervisor (cashier.supervise), admin = freeze lift.
 */
export interface Ctx7a {
  app: FastifyInstance;
  pool: Pool;
  orgId: string;
  casinoId: string;
  vaultId: string;
  desks: string[];
  emp: Record<string, string>;
  tokens: Record<string, string>;
}

export function registerStep7aScenarios(get: () => Ctx7a) {
  let c: Ctx7a;
  let svc: {
    ledger: typeof import('../src/services/ledger');
    ops: typeof import('../src/services/cash-ops');
    recon: typeof import('../src/services/reconciliation');
  };
  const state: Record<string, string> = {};

  const headers = (email: string, key: string = randomUUID()) => ({ authorization: `Bearer ${c.tokens[email]}`, 'idempotency-key': key });
  const post = (email: string, url: string, payload: unknown = {}, key?: string) => c.app.inject({ method: 'POST', url, payload: payload as object, headers: headers(email, key) });
  const get_ = (email: string, url: string) => c.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${c.tokens[email]}` } });
  const q = async (sql: string, p: unknown[] = []) => (await c.pool.query(sql, p)).rows;
  const one = async (sql: string, p: unknown[] = []) => (await c.pool.query(sql, p)).rows[0];
  const tx = async <T>(fn: (db: PoolClient) => Promise<T>) => {
    const client = await c.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn(client);
      await client.query('COMMIT');
      return r;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };
  const bal = (ref: Record<string, unknown>) => svc.ledger.getBalance(c.pool as never, c.orgId, { casinoId: c.casinoId, ...ref } as never);
  const vault = () => bal({ kind: 'VAULT', vaultId: c.vaultId });
  const drawer = (sessionId: string) => bal({ kind: 'DRAWER', cashierSessionId: sessionId });
  const actor = (email: string) => ({ orgId: c.orgId, employeeId: c.emp[email], employeeEmail: email, casinoIds: [c.casinoId] });

  async function openShift(email: string, desk: string) {
    const r = await post(email, '/api/v1/cashier/session/open', { cashDeskId: desk, openingBalance: 0 });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().id as string;
  }
  async function fill(sessionId: string, cashierEmail: string, amountCents: number) {
    const m = await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: sessionId, amountCents });
    assert.equal(m.statusCode, 200, m.body);
    const r = await post(cashierEmail, `/api/v1/cash/movements/${m.json().movement.id}/confirm`, { totalCents: amountCents });
    assert.equal(r.json().movement.status, 'CONFIRMED', r.body);
    return r.json().movement;
  }
  async function closeShift(email: string, countedCents: number) {
    const r = await post(email, '/api/v1/cashier/session/close', { countedBalance: countedCents / 100 });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  }
  async function confirmFinalDrop(movementId: string, cents_: number) {
    const r = await post('manager@example.com', `/api/v1/cash/movements/${movementId}/confirm`, { totalCents: cents_ });
    assert.equal(r.json().movement.status, 'CONFIRMED', r.body);
  }
  const yesterday = async () => (await one(`SELECT ((now() AT TIME ZONE timezone)::date - 1)::text AS d FROM casinos WHERE id = $1`, [c.casinoId])).d as string;

  describe('Step 7a: ledger cash and vault', () => {
    test('setup', async () => {
      c = get();
      svc = { ledger: await import('../src/services/ledger'), ops: await import('../src/services/cash-ops'), recon: await import('../src/services/reconciliation') };
      const modes = await one(`SELECT money_rail_ledger($1,$2,'CASH',NULL) a, money_rail_ledger($1,$2,'VAULT',NULL) b, money_rail_ledger($1,$2,'TITO',NULL) t`, [c.orgId, c.casinoId]);
      assert.deepEqual([modes.a, modes.b, modes.t], [true, true, false]);
      // the database guard uses the rail of each account kind exactly as the shared model defines it
      const kinds = Object.fromEntries((await q('SELECT code, cutover_rail FROM ledger_account_kinds')).map((r) => [r.code, r.cutover_rail]));
      for (const k of ACCOUNT_KIND_KEYS) assert.equal(kinds[k], ACCOUNT_KIND_RAIL[k] ?? null, k);
    });

    test('rail guard: a LEGACY rail takes no ledger booking (service and database); openings only in a cutover', async () => {
      state.s1 = await openShift('cashier@example.com', c.desks[0]);
      const ticket = (await one(`INSERT INTO tickets (org_id, casino_id, barcode, amount, expires_at) VALUES ($1,$2,$3,12.5, now() + interval '30 days') RETURNING id, barcode`, [c.orgId, c.casinoId, `7${String(Date.now()).padStart(17, '0')}`]));
      state.ticket = ticket.barcode;
      await assert.rejects(tx((db) => svc.ledger.executeMoneyTransaction(db as never, {
        orgId: c.orgId, type: 'TITO_ISSUE_CASHIER', dedupeKey: `g-${randomUUID()}`, actor: { type: 'SYSTEM' },
        ctx: { casinoId: c.casinoId, amountCents: cents(1_250), cashierSessionId: state.s1, ticketId: ticket.id },
      })), /TITO money is not on the ledger/);
      // database layer, bypassing the service
      const equity = (await one(`SELECT id FROM ledger_accounts WHERE casino_id = $1 AND kind = 'OPENING_EQUITY'`, [c.casinoId])).id;
      const vaultAcc = (await one(`SELECT id FROM ledger_accounts WHERE vault_id = $1 AND kind = 'VAULT'`, [c.vaultId])).id;
      await c.pool.query(`INSERT INTO ledger_accounts (org_id, kind, casino_id) VALUES ($1,'TICKET_LIABILITY',$2) ON CONFLICT DO NOTHING`, [c.orgId, c.casinoId]);
      const liability = (await one(`SELECT id FROM ledger_accounts WHERE casino_id = $1 AND kind = 'TICKET_LIABILITY'`, [c.casinoId])).id;
      const raw = (type: string, account: string) => tx(async (db) => {
        const h = (await db.query(`INSERT INTO money_transactions (org_id, casino_id, type, amount_cents, dedupe_key, request_hash, actor_type, business_date) VALUES ($1,$2,$3,100,$4,'x','SYSTEM',current_date) RETURNING id`, [c.orgId, c.casinoId, type, `raw-${randomUUID()}`])).rows[0].id;
        await db.query('INSERT INTO ledger_entries (transaction_id, account_id, amount_cents, org_id) VALUES ($1,$2,-100,$4),($1,$3,100,$4)', [h, account, equity, c.orgId]);
      });
      await assert.rejects(raw('PETTY_CASH', liability), /TITO is not on the ledger/);
      await assert.rejects(raw('OPENING_BALANCE', vaultAcc), /only created by a rail cutover/);
    });

    test('legacy money writes on LEDGER rails are refused; generic cash in / out is gone (D2)', async () => {
      const opened = await post('attendant@example.com', '/api/v1/cashier/session/open', { cashDeskId: c.desks[1], openingBalance: 100 });
      assert.equal(opened.statusCode, 409);
      assert.match(opened.json().error, /float comes from the vault/);
      for (const type of ['CASH_IN', 'CASH_OUT']) {
        const r = await post('cashier@example.com', '/api/v1/cashier/transactions', { type, amount: 10 });
        assert.equal(r.statusCode, 409);
        assert.match(r.json().error, /Generic cash in \/ out/);
      }
      await assert.rejects(c.pool.query(`INSERT INTO cash_transactions (org_id, casino_id, session_id, employee_id, type, amount) VALUES ($1,$2,$3,$4,'CASH_IN',10)`, [c.orgId, c.casinoId, state.s1, c.emp['cashier@example.com']]), /CASH money is on the ledger/);
      const redeem = await post('cashier@example.com', '/api/v1/tickets/redeem', { barcode: state.ticket });
      assert.equal(redeem.statusCode, 409, 'a cashier ticket payout moves drawer money: refused until TITO runs on the ledger (7c)');
      assert.equal((await one('SELECT status FROM tickets WHERE barcode = $1', [state.ticket])).status, 'VALID');
      await assert.rejects(c.pool.query(`INSERT INTO cashier_sessions (org_id, casino_id, cash_desk_id, employee_id, opening_balance) VALUES ($1,$2,$3,$4,500)`, [c.orgId, c.casinoId, c.desks[2], c.emp['tech@example.com']]), /CASH is on the ledger/);
    });

    test('vault opening: blind count, a second blind count by another employee, mismatch books nothing, difference booked once', async () => {
      const early = await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: state.s1, amountCents: 1_000 });
      assert.match(early.json().error, /vault is not open/);
      const ledger = await vault();
      const opened = await post('manager@example.com', '/api/v1/vault/sessions', { casinoId: c.casinoId, count: { totalCents: ledger + 500 } });
      assert.equal(opened.statusCode, 200, opened.body);
      state.vs = opened.json().session.id;
      assert.match((await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: state.s1, amountCents: 1_000 })).json().error, /not verified/);
      assert.match((await post('manager@example.com', `/api/v1/vault/counts/${opened.json().count.id}/verify`, { totalCents: ledger + 500 })).json().error, /different employee/);
      const wrong = await post('accounting@example.com', `/api/v1/vault/counts/${opened.json().count.id}/verify`, { totalCents: ledger + 400 });
      assert.equal(wrong.json().matches, false);
      assert.equal(await vault(), ledger, 'a mismatching second count books nothing');
      const recount = await post('manager@example.com', `/api/v1/vault/sessions/${state.vs}/recount`, { totalCents: ledger + 500 });
      assert.match((await post('accounting@example.com', `/api/v1/vault/counts/${opened.json().count.id}/verify`, { totalCents: ledger + 500 })).json().error, /newer count/);
      const ok = await post('accounting@example.com', `/api/v1/vault/counts/${recount.json().id}/verify`, { totalCents: ledger + 500 });
      assert.equal(ok.json().matches, true, ok.body);
      assert.equal(ok.json().settlement.difference_cents, 500);
      assert.equal(await vault(), ledger + 500);
      const mt = await one('SELECT type, amount_cents, actor_id, approved_by FROM money_transactions WHERE id = $1', [ok.json().settlement.money_transaction_id]);
      assert.deepEqual([mt.type, mt.amount_cents, mt.actor_id, mt.approved_by], ['VAULT_COUNT_DIFFERENCE', 500, c.emp['manager@example.com'], c.emp['accounting@example.com']]);
      assert.match((await post('accounting@example.com', `/api/v1/vault/counts/${recount.json().id}/verify`, { totalCents: ledger + 500 })).json().error, /already settled/);
    });

    test('fill: issued by the vault, confirmed by the receiving cashier with a count; a mismatch moves nothing', async () => {
      const v0 = await vault();
      const m = (await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: state.s1, amountCents: 100_000 })).json().movement;
      assert.equal(m.status, 'REQUESTED');
      assert.deepEqual([await drawer(state.s1), await vault()], [0, v0], 'REQUESTED moves nothing');
      assert.match((await post('manager@example.com', `/api/v1/cash/movements/${m.id}/confirm`, { totalCents: 100_000 })).json().error, /requester cannot confirm/);
      assert.equal((await post('attendant@example.com', `/api/v1/cash/movements/${m.id}/confirm`, { totalCents: 100_000 })).statusCode, 403);
      const rejected = await post('cashier@example.com', `/api/v1/cash/movements/${m.id}/confirm`, { totalCents: 99_000 });
      assert.equal(rejected.json().movement.status, 'REJECTED');
      assert.deepEqual([await drawer(state.s1), await vault()], [0, v0]);
      const m2 = (await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: state.s1, amountCents: 100_000 })).json().movement;
      const done = await post('cashier@example.com', `/api/v1/cash/movements/${m2.id}/confirm`, { denominations: { '5000': 20 } });
      assert.equal(done.json().movement.status, 'CONFIRMED', done.body);
      assert.deepEqual([await drawer(state.s1), await vault()], [100_000, v0 - 100_000]);
      const mt = await one('SELECT type, actor_id, approved_by, cashier_session_id, vault_id, business_date FROM money_transactions WHERE id = $1', [done.json().movement.money_transaction_id]);
      assert.deepEqual([mt.type, mt.actor_id, mt.approved_by, mt.cashier_session_id, mt.vault_id], ['VAULT_FILL', c.emp['manager@example.com'], c.emp['cashier@example.com'], state.s1, c.vaultId]);
      assert.ok(mt.business_date);
      // LegacyProjection: the legacy drawer row references the ledger transaction
      const proj = await q('SELECT type, amount, money_transaction_id FROM cash_transactions WHERE session_id = $1', [state.s1]);
      assert.deepEqual(proj, [{ type: 'FILL', amount: 1000, money_transaction_id: done.json().movement.money_transaction_id }]);
      // Step 7e blind count: the cashier never gets the own drawer balance; a supervisor sees it
      const desks = (await get_('cashier@example.com', `/api/v1/cashier/desks?casinoId=${c.casinoId}`)).json();
      assert.equal(desks.find((d: { session_id: string }) => d.session_id === state.s1).balance, null);
      const sup = (await get_('manager@example.com', `/api/v1/cashier/desks?casinoId=${c.casinoId}`)).json();
      assert.equal(sup.find((d: { session_id: string }) => d.session_id === state.s1).balance, 1000);
    });

    test('drop: handed in by the cashier, confirmed by the vault; never more than the drawer', async () => {
      const d = (await post('cashier@example.com', '/api/v1/cash/movements', { kind: 'DROP', amountCents: 20_000 })).json().movement;
      assert.equal((await post('cashier@example.com', `/api/v1/cash/movements/${d.id}/confirm`, { totalCents: 20_000 })).statusCode, 403);
      await confirmFinalDrop(d.id, 20_000);
      assert.equal(await drawer(state.s1), 80_000);
      assert.match((await post('cashier@example.com', '/api/v1/cash/movements', { kind: 'DROP', amountCents: 999_999 })).json().error, /exceeds the drawer/);
    });

    test('timeout / offline: an unconfirmed request expires and moves nothing; only the requester cancels', async () => {
      const before = await drawer(state.s1);
      const a = (await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: state.s1, amountCents: 5_000 })).json().movement;
      await q(`UPDATE cash_movements SET expires_at = now() - interval '1 second' WHERE id = $1`, [a.id]);
      assert.equal((await post('cashier@example.com', `/api/v1/cash/movements/${a.id}/confirm`, { totalCents: 5_000 })).json().movement.status, 'EXPIRED');
      const b = (await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: state.s1, amountCents: 6_000 })).json().movement;
      await q(`UPDATE cash_movements SET expires_at = now() - interval '1 second' WHERE id = $1`, [b.id]);
      assert.ok((await tx((db) => svc.ops.expireMovements(db as never))) >= 1);
      assert.equal((await one('SELECT status FROM cash_movements WHERE id = $1', [b.id])).status, 'EXPIRED');
      const cx = (await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: state.s1, amountCents: 7_000 })).json().movement;
      assert.equal((await post('cashier@example.com', `/api/v1/cash/movements/${cx.id}/cancel`)).statusCode, 403);
      assert.equal((await post('manager@example.com', `/api/v1/cash/movements/${cx.id}/cancel`)).json().status, 'CANCELLED');
      assert.equal(await drawer(state.s1), before);
    });

    test('duplicates: Idempotency-Key replay, request keys and a double confirmation book once', async () => {
      const key = randomUUID();
      const a = await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: state.s1, amountCents: 2_000 }, key);
      const b = await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: state.s1, amountCents: 2_000 }, key);
      assert.equal(b.headers['idempotent-replayed'], 'true');
      assert.equal(a.json().movement.id, b.json().movement.id);
      await assert.rejects(tx((db) => svc.ops.requestMovement(db as never, actor('manager@example.com'), { kind: 'FILL', cashierSessionId: state.s1, amountCents: 2_001, requestKey: a.json().movement.request_key })), /different movement/);
      const id = a.json().movement.id;
      const c1 = await post('cashier@example.com', `/api/v1/cash/movements/${id}/confirm`, { totalCents: 2_000 });
      const c2 = await post('cashier@example.com', `/api/v1/cash/movements/${id}/confirm`, { totalCents: 2_000 });
      assert.equal(c1.json().movement.money_transaction_id, c2.json().movement.money_transaction_id);
      assert.equal(c2.json().replayed, true);
      assert.equal((await one(`SELECT count(*)::int n FROM money_transactions WHERE dedupe_key = $1`, [`entity:cash_movement:${id}`])).n, 1);
      assert.equal(await drawer(state.s1), 82_000);
    });

    test('concurrency: parallel confirmations book once; parallel drops never overdraw the drawer', async () => {
      const m = (await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: state.s1, amountCents: 3_000 })).json().movement;
      const results = await Promise.all(Array.from({ length: 5 }, () => post('cashier@example.com', `/api/v1/cash/movements/${m.id}/confirm`, { totalCents: 3_000 })));
      assert.ok(results.every((r) => r.statusCode === 200), results.map((r) => r.body).join());
      assert.equal(new Set(results.map((r) => r.json().movement.money_transaction_id)).size, 1);
      assert.equal(await drawer(state.s1), 85_000);

      state.s2 = await openShift('attendant@example.com', c.desks[1]);
      await fill(state.s2, 'attendant@example.com', 10_000);
      const d1 = (await post('attendant@example.com', '/api/v1/cash/movements', { kind: 'DROP', amountCents: 10_000 })).json().movement;
      const d2 = (await post('attendant@example.com', '/api/v1/cash/movements', { kind: 'DROP', amountCents: 10_000 })).json().movement;
      const both = await Promise.all([d1, d2].map((d) => post('manager@example.com', `/api/v1/cash/movements/${d.id}/confirm`, { totalCents: 10_000 })));
      assert.deepEqual(both.map((r) => r.statusCode).sort(), [200, 409]);
      assert.match(both.find((r) => r.statusCode === 409)!.json().error, /Insufficient balance on DRAWER/);
      assert.equal(await drawer(state.s2), 0);
      await post('attendant@example.com', `/api/v1/cash/movements/${both[0].statusCode === 409 ? d1.id : d2.id}/cancel`);
    });

    test('blind shift close: no expected balance for the cashier; exact count -> final drop -> closed, drawer 0', async () => {
      const view = (await get_('cashier@example.com', '/api/v1/cashier/session')).json();
      assert.deepEqual([view.session.blind, view.session.expected], [true, null]);
      assert.ok(view.transactions.every((t: Record<string, unknown>) => !('amount' in t)));
      const zero = await closeShift('attendant@example.com', 0);
      assert.equal(zero.status, 'CLOSED');
      const r = await closeShift('cashier@example.com', 85_000);
      assert.equal(r.status, 'PENDING_DROP');
      assert.equal((await one('SELECT status FROM cashier_sessions WHERE id = $1', [state.s1])).status, 'COUNTING');
      assert.match((await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: state.s1, amountCents: 1 })).json().error, /not open/);
      await confirmFinalDrop(r.movementId, 85_000);
      const s = await one('SELECT status, opening_balance, expected_balance, counted_balance, difference FROM cashier_sessions WHERE id = $1', [state.s1]);
      assert.deepEqual(s, { status: 'CLOSED', opening_balance: 0, expected_balance: 850, counted_balance: 850, difference: 0 });
      assert.equal(await drawer(state.s1), 0);
      const legacy = await one('SELECT COALESCE(sum(amount), 0) AS m FROM cash_transactions WHERE session_id = $1', [state.s1]);
      assert.equal(legacy.m, 0, 'legacy drawer formula = ledger drawer = 0');
    });

    test('short / over below the limit is booked at the close (no approval)', async () => {
      const s = await openShift('cashier@example.com', c.desks[0]);
      await fill(s, 'cashier@example.com', 50_000);
      const shortBefore = await bal({ kind: 'CASH_SHORT_OVER' });
      const r = await closeShift('cashier@example.com', 49_500);
      assert.equal(r.status, 'PENDING_DROP');
      assert.equal(await bal({ kind: 'CASH_SHORT_OVER' }), shortBefore + 500);
      await confirmFinalDrop(r.movementId, 49_500);
      assert.deepEqual(await one('SELECT expected_balance, counted_balance, difference, status FROM cashier_sessions WHERE id = $1', [s]), { expected_balance: 500, counted_balance: 495, difference: -5, status: 'CLOSED' });
    });

    test('short / over above the limit: a different supervisor decides; rejection forces a recount', async () => {
      await q('UPDATE casino_money_settings SET short_over_approval_cents = 1000 WHERE casino_id = $1', [c.casinoId]);
      const s = await openShift('cashier@example.com', c.desks[0]);
      await fill(s, 'cashier@example.com', 50_000);
      const r = await closeShift('cashier@example.com', 48_000);
      assert.equal(r.status, 'PENDING_APPROVAL');
      assert.equal(await drawer(s), 50_000, 'nothing booked before the decision');
      assert.equal((await post('cashier@example.com', `/api/v1/approvals/${r.approvalId}/decide`, { decision: 'APPROVED' })).statusCode, 403);
      await assert.rejects(tx((db) => svc.ops.decideShortOver(db as never, actor('cashier@example.com'), r.approvalId, 'APPROVED')), /cannot approve/);
      assert.match((await post('cashier@example.com', '/api/v1/cashier/session/close', { countedBalance: 480 })).json().error, /waiting for supervisor approval/);
      assert.equal((await post('floor@example.com', `/api/v1/approvals/${r.approvalId}/decide`, { decision: 'REJECTED' })).json().status, 'RECOUNT');
      const recount = await closeShift('cashier@example.com', 50_000);
      assert.equal(recount.status, 'PENDING_DROP');
      await confirmFinalDrop(recount.movementId, 50_000);
      assert.equal((await one('SELECT difference FROM cashier_sessions WHERE id = $1', [s])).difference, 0);

      const s2 = await openShift('cashier@example.com', c.desks[0]);
      await fill(s2, 'cashier@example.com', 50_000);
      const r2 = await closeShift('cashier@example.com', 47_000);
      const decided = await post('floor@example.com', `/api/v1/approvals/${r2.approvalId}/decide`, { decision: 'APPROVED' });
      assert.equal(decided.json().status, 'PENDING_DROP', decided.body);
      const ap = await one('SELECT status, money_transaction_id, decided_by FROM approvals WHERE id = $1', [r2.approvalId]);
      assert.equal(ap.status, 'EXECUTED');
      const mt = await one('SELECT type, amount_cents, actor_id, approved_by FROM money_transactions WHERE id = $1', [ap.money_transaction_id]);
      assert.deepEqual([mt.type, mt.amount_cents, mt.actor_id, mt.approved_by], ['DRAWER_SHORT_OVER', -3_000, c.emp['cashier@example.com'], c.emp['floor@example.com']]);
      await confirmFinalDrop(decided.json().movementId, 47_000);
      assert.equal(await drawer(s2), 0);
      await q('UPDATE casino_money_settings SET short_over_approval_cents = NULL WHERE casino_id = $1', [c.casinoId]);
    });

    test('vault close: blind closing count, verified by a second employee; the difference is booked, then the session closes', async () => {
      assert.equal((await q(`SELECT 1 FROM cash_movements WHERE vault_session_id = $1 AND status = 'REQUESTED'`, [state.vs])).length, 0);
      const ledger = await vault();
      const closing = await post('manager@example.com', `/api/v1/vault/sessions/${state.vs}/close`, { totalCents: ledger - 300 });
      assert.equal(closing.json().pendingVerification, true, closing.body);
      assert.equal((await one('SELECT status FROM vault_sessions WHERE id = $1', [state.vs])).status, 'COUNTING');
      const sTmp = await openShift('cashier@example.com', c.desks[0]);
      assert.match((await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: sTmp, amountCents: 100 })).json().error, /being counted/);
      assert.match((await post('manager@example.com', `/api/v1/vault/counts/${closing.json().count.id}/verify`, { totalCents: ledger - 300 })).json().error, /different employee/);
      const ok = await post('accounting@example.com', `/api/v1/vault/counts/${closing.json().count.id}/verify`, { totalCents: ledger - 300 });
      assert.equal(ok.json().session.status, 'CLOSED', ok.body);
      assert.equal(await vault(), ledger - 300);
      assert.equal((await closeShift('cashier@example.com', 0)).status, 'CLOSED');
    });

    test('reconciliation is clean after all operations', async () => {
      const r = await post('floor@example.com', '/api/v1/money/reconciliation', { casinoId: c.casinoId });
      assert.equal(r.json().ok, true, JSON.stringify(r.json().checks.filter((x: { ok: boolean }) => !x.ok)));
      assert.ok(r.json().checks.some((x: { key: string }) => x.key === 'cash.shift_balances'));
      assert.ok(r.json().checks.some((x: { key: string }) => x.key === 'vault.movements_booked'));
    });

    test('CASH mismatch: alert, CASH frozen, VAULT continues, day close blocked, four-eyes resolution, lift', async () => {
      const ledger = await vault();
      const vs = (await post('manager@example.com', '/api/v1/vault/sessions', { casinoId: c.casinoId, count: { totalCents: ledger } })).json();
      await post('accounting@example.com', `/api/v1/vault/counts/${vs.count.id}/verify`, { totalCents: ledger });
      state.vs = vs.session.id;
      const s = await openShift('attendant@example.com', c.desks[1]);
      await fill(s, 'attendant@example.com', 10_000);
      // a ledger booking on the drawer without its legacy projection (what a buggy writer would leave behind)
      await tx((db) => svc.ledger.executeMoneyTransaction(db as never, {
        orgId: c.orgId, type: 'DRAWER_SHORT_OVER', dedupeKey: `bug-${randomUUID()}`, actor: { type: 'SYSTEM' },
        ctx: { casinoId: c.casinoId, amountCents: cents(-100), cashierSessionId: s },
      }));
      const run = (await post('floor@example.com', '/api/v1/money/reconciliation', { casinoId: c.casinoId })).json();
      assert.equal(run.ok, false);
      assert.deepEqual(run.checks.filter((x: { ok: boolean }) => !x.ok).map((x: { key: string; items: string[] }) => [x.key, x.items]), [['cash.shift_balances', [`session:${s}`]]]);
      assert.deepEqual(run.frozen.map((f: { rail: string }) => f.rail), ['CASH']);
      assert.ok(await one(`SELECT 1 FROM alerts WHERE org_id = $1 AND type = 'RECONCILIATION_CASH' AND severity = 'CRITICAL' AND status <> 'RESOLVED'`, [c.orgId]));
      // CASH frozen: no new drawer money; VAULT unaffected
      const pending = (await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: s, amountCents: 1_000 })).json().movement;
      assert.match((await post('attendant@example.com', `/api/v1/cash/movements/${pending.id}/confirm`, { totalCents: 1_000 })).json().error, /CASH is frozen/);
      await tx((db) => svc.ledger.executeMoneyTransaction(db as never, {
        orgId: c.orgId, type: 'VAULT_COUNT_DIFFERENCE', dedupeKey: `vault-${randomUUID()}`, actor: { type: 'EMPLOYEE', employeeId: c.emp['manager@example.com'] },
        approvedBy: c.emp['accounting@example.com'], ctx: { casinoId: c.casinoId, amountCents: cents(100), vaultId: c.vaultId },
      }));
      const closeDay = await post('manager@example.com', '/api/v1/money/day-close', { casinoId: c.casinoId, businessDate: await yesterday() });
      assert.equal(closeDay.statusCode, 409);
      assert.match(closeDay.json().reason, /Frozen: CASH/);
      const freezeId = run.frozen[0].id;
      const early = await post('admin@example.com', `/api/v1/money/freezes/${freezeId}/lift`, { reason: 'checked' });
      assert.equal(early.statusCode, 409);
      // four eyes: requester cannot approve the own explanation
      const res = await post('floor@example.com', '/api/v1/money/resolutions', { casinoId: c.casinoId, itemKey: `session:${s}`, explanation: 'Test booking without projection, cash counted and confirmed' });
      assert.equal(res.statusCode, 200, res.body);
      assert.match((await post('floor@example.com', `/api/v1/approvals/${res.json().id}/decide`, { decision: 'APPROVED' })).json().error, /requester cannot approve/);
      assert.ok((await post('accounting@example.com', `/api/v1/approvals/${res.json().id}/decide`, { decision: 'APPROVED' })).json().resolution);
      const lifted = await post('admin@example.com', `/api/v1/money/freezes/${freezeId}/lift`, { reason: 'explained by two employees' });
      assert.equal(lifted.json().lifted, true, lifted.body);
      assert.equal((await post('attendant@example.com', `/api/v1/cash/movements/${pending.id}/confirm`, { totalCents: 1_000 })).json().movement.status, 'CONFIRMED');
      const r = await closeShift('attendant@example.com', 10_900);
      await confirmFinalDrop(r.movementId, 10_900);
    });

    test('global invariant mismatch freezes all rails; corrections stay possible; lift after the repair', async () => {
      const vaultAcc = (await one(`SELECT id FROM ledger_accounts WHERE vault_id = $1 AND kind = 'VAULT'`, [c.vaultId])).id;
      const corrupt = (delta: number) => tx(async (db) => {
        await db.query(`SELECT set_config('m1.ledger_posting', 'on', true)`);
        await db.query('UPDATE ledger_balances SET balance_cents = balance_cents + $2 WHERE account_id = $1', [vaultAcc, delta]);
      });
      await corrupt(1);
      const run = (await post('floor@example.com', '/api/v1/money/reconciliation', { casinoId: c.casinoId })).json();
      assert.deepEqual(run.frozen.map((f: { rail: string }) => f.rail), ['GLOBAL']);
      const s = await openShift('cashier@example.com', c.desks[0]);
      const m = (await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: s, amountCents: 1_000 })).json().movement;
      assert.match((await post('cashier@example.com', `/api/v1/cash/movements/${m.id}/confirm`, { totalCents: 1_000 })).json().error, /frozen/);
      await assert.rejects(tx((db) => svc.ledger.executeMoneyTransaction(db as never, {
        orgId: c.orgId, type: 'VAULT_COUNT_DIFFERENCE', dedupeKey: `vault-${randomUUID()}`, actor: { type: 'EMPLOYEE', employeeId: c.emp['manager@example.com'] },
        approvedBy: c.emp['accounting@example.com'], ctx: { casinoId: c.casinoId, amountCents: cents(1), vaultId: c.vaultId },
      })), /frozen/);
      // a four-eyes correction is still possible while frozen
      await tx((db) => svc.ledger.executeMoneyTransaction(db as never, {
        orgId: c.orgId, type: 'ADJUSTMENT', dedupeKey: `adj-${randomUUID()}`, actor: { type: 'EMPLOYEE', employeeId: c.emp['manager@example.com'] }, approvedBy: c.emp['accounting@example.com'], reason: 'test correction',
        ctx: { casinoId: c.casinoId, amountCents: cents(1), debit: { kind: 'VAULT', vaultId: c.vaultId }, credit: { kind: 'VAULT_SHORT_OVER' } },
      }));
      assert.equal((await post('admin@example.com', `/api/v1/money/freezes/${run.frozen[0].id}/lift`, { reason: 'too early' })).statusCode, 409);
      await corrupt(-1);
      assert.equal((await post('admin@example.com', `/api/v1/money/freezes/${run.frozen[0].id}/lift`, { reason: 'balance cache repaired' })).json().lifted, true);
      assert.equal((await post('cashier@example.com', `/api/v1/cash/movements/${m.id}/confirm`, { totalCents: 1_000 })).json().movement.status, 'CONFIRMED');
      const r = await closeShift('cashier@example.com', 1_000);
      await confirmFinalDrop(r.movementId, 1_000);
    });

    test('day close: only a past date, only when clean; a closed date takes no money transaction', async () => {
      const today = await one(`SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM casinos WHERE id = $1`, [c.casinoId]);
      assert.match((await post('manager@example.com', '/api/v1/money/day-close', { casinoId: c.casinoId, businessDate: today.d })).json().error, /past business date/);
      const d = await yesterday();
      const closed = await post('manager@example.com', '/api/v1/money/day-close', { casinoId: c.casinoId, businessDate: d });
      assert.equal(closed.json().closed, true, closed.body);
      await assert.rejects(c.pool.query(
        `INSERT INTO money_transactions (org_id, casino_id, type, amount_cents, dedupe_key, request_hash, actor_type, business_date) VALUES ($1,$2,'PETTY_CASH',1,$3,'x','SYSTEM',$4)`,
        [c.orgId, c.casinoId, `late-${randomUUID()}`, d]), /is closed/);
      assert.match((await post('manager@example.com', '/api/v1/money/day-close', { casinoId: c.casinoId, businessDate: d })).json().error, /already closed/);
    });

    test('end state: ledger invariants hold, reconciliation clean, every drawer of a closed shift is 0', async () => {
      assert.equal((await svc.ledger.checkLedgerInvariants(c.pool as never, c.orgId)).ok, true);
      const r = (await post('floor@example.com', '/api/v1/money/reconciliation', { casinoId: c.casinoId })).json();
      assert.equal(r.ok, true, JSON.stringify(r.checks.filter((x: { ok: boolean }) => !x.ok)));
      const open = await q(`SELECT id FROM cashier_sessions WHERE casino_id = $1 AND status <> 'CLOSED'`, [c.casinoId]);
      assert.deepEqual(open, []);
    });
  });
}
