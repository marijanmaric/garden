import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { cents } from '@m1/shared';
import { createCasinoShell, createLedgerCasino, cutoverCasinoRails, ensureVaultOpen, type LedgerCasino } from './ledger-casino';

/**
 * Step 7b scenarios: HANDPAY on the ledger. The same scenarios run on a fresh seeded database and on
 * a realistic upgraded one. The casino's VAULT, CASH and HANDPAY rails were cut over through the
 * real mechanism; jackpots arrive through the gateway API, resets go through gateway commands.
 */
export interface Ctx7b {
  app: FastifyInstance;
  pool: Pool;
  orgId: string;
  casino: LedgerCasino;
  emp: Record<string, string>;
  tokens: Record<string, string>;
}

export function registerStep7bScenarios(get: () => Ctx7b) {
  let c: Ctx7b;
  let svc: {
    ledger: typeof import('../src/services/ledger');
    handpays: typeof import('../src/services/handpays');
    players: typeof import('../src/services/players');
    recon: typeof import('../src/services/reconciliation');
  };
  const st: Record<string, string> = {};

  const headers = (email: string, key: string = randomUUID()) => ({ authorization: `Bearer ${c.tokens[email]}`, 'idempotency-key': key });
  const post = (email: string, url: string, payload: unknown = {}, key?: string) => c.app.inject({ method: 'POST', url, payload: payload as object, headers: headers(email, key) });
  const gw = (url: string, payload: unknown) => c.app.inject({ method: 'POST', url, payload: payload as object, headers: { 'x-gateway-id': c.casino.gateway!.deviceId, 'x-gateway-key': c.casino.gateway!.key } });
  const q = async (sql: string, p: unknown[] = []) => (await c.pool.query(sql, p)).rows;
  const one = async (sql: string, p: unknown[] = []) => (await c.pool.query(sql, p)).rows[0];
  const tx = async <T>(fn: (db: PoolClient) => Promise<T>, pool: Pool = c.pool) => {
    const client = await pool.connect();
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
  const bal = (ref: Record<string, unknown>, casinoId = c.casino.id) => svc.ledger.getBalance(c.pool as never, c.orgId, { casinoId, ...ref } as never);
  const payable = (casinoId = c.casino.id) => bal({ kind: 'HANDPAY_PAYABLE' }, casinoId);
  const actor = (email: string, casinoIds = [c.casino.id]) => ({ orgId: c.orgId, employeeId: c.emp[email], employeeEmail: email, casinoIds });
  const m = (i: number) => c.casino.machines[i];

  async function jackpot(i: number, amount: number, eventId = randomUUID()) {
    const r = await gw('/api/v1/gateway/events', { events: [{ eventId, type: 'JACKPOT', machineId: m(i).code, timestamp: new Date().toISOString(), amount }] });
    return { res: r, eventId };
  }
  const handpayOf = async (eventId: string) => one('SELECT * FROM handpays WHERE source_event_id = $1', [eventId]);
  const pay = (email: string, i: number, body: Record<string, unknown> = {}, key?: string) => post(email, `/api/v1/cashier/handpays/${m(i).id}`, body, key);
  const txsOf = async (handpayId: string) => (await q('SELECT type FROM money_transactions WHERE handpay_id = $1 ORDER BY created_at', [handpayId])).map((r) => r.type);
  const commands = (handpayId: string) => q(`SELECT id, status, result_message FROM machine_commands WHERE handpay_id = $1 ORDER BY created_at`, [handpayId]);
  const heartbeat = async () => (await gw('/api/v1/gateway/heartbeat', {})).json().pendingCommands as Array<{ id: string; type: string }>;
  const result = (id: string, success: boolean, message?: string) => gw(`/api/v1/gateway/commands/${id}/result`, { success, message });
  const retryJob = () => tx((db) => svc.handpays.retryFailedHandpayResets(db as never));

  async function openShift(email: string, floatCents: number) {
    const desk = (await one(`INSERT INTO cash_desks (org_id, casino_id, name) VALUES ($1,$2,$3) RETURNING id`, [c.orgId, c.casino.id, `7b ${email} ${Date.now()}`])).id;
    const s = await post(email, '/api/v1/cashier/session/open', { cashDeskId: desk, openingBalance: 0 });
    assert.equal(s.statusCode, 200, s.body);
    const f = await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: s.json().id, amountCents: floatCents });
    assert.equal((await post(email, `/api/v1/cash/movements/${f.json().movement.id}/confirm`, { totalCents: floatCents })).json().movement.status, 'CONFIRMED');
    return s.json().id as string;
  }

  describe('Step 7b: HANDPAY on the ledger', () => {
    test('setup: VAULT, CASH and HANDPAY on the ledger; cashier shift with a float', async () => {
      c = get();
      svc = {
        ledger: await import('../src/services/ledger'), handpays: await import('../src/services/handpays'),
        players: await import('../src/services/players'), recon: await import('../src/services/reconciliation'),
      };
      const r = await one(`SELECT money_rail_ledger($1,$2,'HANDPAY',NULL) h, money_rail_ledger($1,$2,'CASH',NULL) c, money_rail_ledger($1,NULL,'CASHLESS',NULL) w, money_rail_ledger($1,$2,'TITO',NULL) t`, [c.orgId, c.casino.id]);
      // TITO stays LEGACY in this whole suite: HANDPAY works completely without it (no technical dependency)
      assert.deepEqual([r.h, r.c, r.w, r.t], [true, true, true, false]);
      await ensureVaultOpen(c.pool as never, c.casino);
      st.shift = await openShift('cashier@example.com', 1_000_000);
    });

    test('a jackpot creates exactly one handpay and books the liability once; a duplicate event changes nothing', async () => {
      const before = await payable();
      const { res, eventId } = await jackpot(0, 250);
      assert.equal(res.json().accepted, 1, res.body);
      const h = await handpayOf(eventId);
      assert.deepEqual([h.status, h.amount_cents], ['PENDING', 25_000]);
      assert.equal(await payable(), before + 25_000);
      const create = await one(`SELECT type, amount_cents, source_event_id, machine_id FROM money_transactions WHERE handpay_id = $1`, [h.id]);
      assert.deepEqual(create, { type: 'HANDPAY_CREATE_JACKPOT', amount_cents: 25_000, source_event_id: eventId, machine_id: m(0).id });
      const dup = await jackpot(0, 250, eventId);
      assert.equal(dup.res.json().duplicates, 1);
      assert.equal((await q('SELECT 1 FROM handpays WHERE source_event_id = $1', [eventId])).length, 1);
      assert.deepEqual(await txsOf(h.id), ['HANDPAY_CREATE_JACKPOT']);
      st.h0 = h.id;
      st.e0 = eventId;
    });

    test('cash payment below the limit: one HANDPAY_PAY, projected cash row, Step 1 protections, idempotency', async () => {
      const drawerBefore = await bal({ kind: 'DRAWER', cashierSessionId: st.shift });
      const key = randomUUID();
      const r = await pay('cashier@example.com', 0, {}, key);
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual([r.json().status, r.json().amountCents, r.json().payTo], ['PAID', 25_000, 'CASH']);
      assert.equal(await bal({ kind: 'DRAWER', cashierSessionId: st.shift }), drawerBefore - 25_000);
      assert.equal(await payable(), (await q(`SELECT COALESCE(sum(amount_cents), 0)::int s FROM handpays WHERE casino_id = $1 AND status IN ('PENDING', 'APPROVED')`, [c.casino.id]))[0].s);
      const mt = await one(`SELECT id, type, amount_cents, handpay_id, source_event_id, actor_id, cashier_session_id, business_date FROM money_transactions WHERE id = $1`, [r.json().moneyTransactionId]);
      assert.deepEqual([mt.type, mt.amount_cents, mt.handpay_id, mt.source_event_id, mt.actor_id, mt.cashier_session_id], ['HANDPAY_PAY', 25_000, st.h0, st.e0, c.emp['cashier@example.com'], st.shift]);
      assert.ok(mt.business_date);
      const entries = await q(`SELECT a.kind, e.amount_cents FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.transaction_id = $1 ORDER BY a.kind`, [mt.id]);
      assert.deepEqual(entries, [{ kind: 'DRAWER', amount_cents: -25_000 }, { kind: 'HANDPAY_PAYABLE', amount_cents: 25_000 }], 'double entry, sums to 0');
      // LegacyProjection: the legacy drawer row with the ledger transaction and the jackpot event (Step 1 index)
      const ct = await one(`SELECT type, amount, money_transaction_id, source_event_id FROM cash_transactions WHERE source_event_id = $1`, [st.e0]);
      assert.deepEqual(ct, { type: 'HANDPAY', amount: -250, money_transaction_id: mt.id, source_event_id: st.e0 });
      // same key + same request: replay; same key + other request: refused; other key: already paid
      const replay = await pay('cashier@example.com', 0, {}, key);
      assert.equal(replay.headers['idempotent-replayed'], 'true');
      assert.deepEqual(replay.json(), r.json());
      assert.equal((await pay('cashier@example.com', 0, { payTo: 'WALLET' }, key)).statusCode, 422);
      const again = await pay('cashier@example.com', 0);
      assert.equal(again.statusCode, 409);
      assert.match(again.json().error, /already paid/);
      assert.deepEqual(await txsOf(st.h0), ['HANDPAY_CREATE_JACKPOT', 'HANDPAY_PAY']);
      // database: a second payment booking of the same handpay or a second cash row of the event is impossible
      await assert.rejects(c.pool.query(`INSERT INTO cash_transactions (org_id, casino_id, session_id, employee_id, type, amount, source_event_id, money_transaction_id) VALUES ($1,$2,$3,$4,'HANDPAY',-250,$5,$6)`,
        [c.orgId, c.casino.id, st.shift, c.emp['cashier@example.com'], st.e0, mt.id]), /same database transaction|one_payment_per_event/);
      assert.ok((await q(`SELECT 1 FROM pg_indexes WHERE indexname IN ('money_transactions_one_handpay_payment', 'money_transactions_one_handpay_creation', 'cash_transactions_one_payment_per_event')`)).length === 3);
    });

    test('reset A: the reset is a separate gateway command; success -> MACHINE_RESET; a duplicate response changes nothing', async () => {
      const cmds = await commands(st.h0);
      assert.equal(cmds.length, 1);
      const pending = await heartbeat();
      assert.ok(pending.some((p) => p.id === cmds[0].id && p.type === 'RESET_JACKPOT'));
      assert.equal((await result(cmds[0].id, true)).statusCode, 200);
      assert.equal((await handpayOf(st.e0)).status, 'MACHINE_RESET');
      await result(cmds[0].id, true);
      assert.equal((await handpayOf(st.e0)).status, 'MACHINE_RESET');
      assert.deepEqual(await txsOf(st.h0), ['HANDPAY_CREATE_JACKPOT', 'HANDPAY_PAY'], 'a reset never books money');
    });

    test('concurrent payments with different keys pay once; reset B: failure keeps PAID and is retried', async () => {
      const { eventId } = await jackpot(1, 99.5);
      const h = await handpayOf(eventId);
      const results = await Promise.all(Array.from({ length: 5 }, () => pay('cashier@example.com', 1)));
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409, 409, 409, 409]);
      assert.deepEqual(await txsOf(h.id), ['HANDPAY_CREATE_JACKPOT', 'HANDPAY_PAY']);
      assert.equal((await q(`SELECT 1 FROM cash_transactions WHERE source_event_id = $1`, [eventId])).length, 1);
      const [cmd] = await commands(h.id);
      await heartbeat();
      await result(cmd.id, false, 'door open');
      assert.equal((await handpayOf(eventId)).status, 'PAID', 'payment stays successful');
      assert.equal(await retryJob(), 1);
      const cmds = await commands(h.id);
      assert.deepEqual(cmds.map((x) => x.status), ['FAILED', 'PENDING']);
      await heartbeat();
      await result(cmds[1].id, true);
      assert.equal((await handpayOf(eventId)).status, 'MACHINE_RESET');
      assert.deepEqual(await txsOf(h.id), ['HANDPAY_CREATE_JACKPOT', 'HANDPAY_PAY']);
    });

    test('reset C/D/E/F: timeout (gateway offline / response lost), manual retry, duplicate retry, late success', async () => {
      const { eventId } = await jackpot(2, 120);
      const h = await handpayOf(eventId);
      assert.equal((await pay('cashier@example.com', 2)).statusCode, 200);
      const [first] = await commands(h.id);
      // gateway offline: the command is never picked up; while open, a manual retry returns it instead of a second one
      const open = await post('cashier@example.com', `/api/v1/handpays/${h.id}/reset`);
      assert.deepEqual([open.json().status, open.json().commandId], ['IN_PROGRESS', first.id]);
      await q(`UPDATE machine_commands SET created_at = now() - interval '1 hour' WHERE id = $1`, [first.id]);
      await retryJob(); // timeout -> FAILED -> retried
      let cmds = await commands(h.id);
      assert.deepEqual(cmds.map((x) => [x.status, x.result_message]), [['FAILED', 'timeout'], ['PENDING', null]]);
      await q(`UPDATE machine_commands SET status = 'FAILED', result_message = 'rejected' WHERE id = $1`, [cmds[1].id]);
      // duplicate manual retries with different keys: one new command
      const both = await Promise.all([post('cashier@example.com', `/api/v1/handpays/${h.id}/reset`), post('cashier@example.com', `/api/v1/handpays/${h.id}/reset`)]);
      assert.deepEqual(both.map((r) => r.json().status).sort(), ['IN_PROGRESS', 'REQUESTED']);
      assert.equal(new Set(both.map((r) => r.json().commandId)).size, 1);
      cmds = await commands(h.id);
      assert.equal(cmds.length, 3);
      // the response of the very first command arrives late: it still confirms the reset, once
      await result(first.id, true);
      assert.equal((await handpayOf(eventId)).status, 'MACHINE_RESET');
      await result(cmds[2].id, true);
      assert.equal((await handpayOf(eventId)).status, 'MACHINE_RESET');
      assert.equal((await post('cashier@example.com', `/api/v1/handpays/${h.id}/reset`)).json().status, 'ALREADY_RESET');
      assert.deepEqual(await txsOf(h.id), ['HANDPAY_CREATE_JACKPOT', 'HANDPAY_PAY']);
    });

    test('approval above the limit: four eyes through the approvals system; self-approval, race and approver-pays are refused', async () => {
      await q('UPDATE casino_money_settings SET handpay_approval_cents = 100000 WHERE casino_id = $1', [c.casino.id]);
      const { eventId } = await jackpot(3, 1500);
      const h = await handpayOf(eventId);
      assert.match((await pay('cashier@example.com', 3)).json().error, /Supervisor approval required/);
      await assert.rejects(tx((db) => svc.handpays.approveHandpay(db as never, actor('floor@example.com'), h.id)), /approval request/);
      const req1 = await post('cashier@example.com', `/api/v1/handpays/${h.id}/approval-request`);
      assert.equal(req1.json().status, 'PENDING', req1.body);
      assert.equal((await post('cashier@example.com', `/api/v1/handpays/${h.id}/approval-request`)).json().id, req1.json().id);
      assert.equal((await post('cashier@example.com', `/api/v1/approvals/${req1.json().id}/decide`, { decision: 'APPROVED' })).statusCode, 403);
      const race = await Promise.all(['floor@example.com', 'accounting@example.com'].map((e) => post(e, `/api/v1/approvals/${req1.json().id}/decide`, { decision: 'APPROVED' })));
      assert.deepEqual(race.map((r) => r.statusCode).sort(), [200, 409]);
      const approved = await handpayOf(eventId);
      assert.equal(approved.status, 'APPROVED');
      const approverEmail = approved.approved_by === c.emp['floor@example.com'] ? 'floor@example.com' : 'accounting@example.com';
      await assert.rejects(tx((db) => svc.handpays.payHandpay(db as never, actor(approverEmail), h.id)), /approver cannot pay/);
      const paid = await pay('cashier@example.com', 3);
      assert.equal(paid.statusCode, 200, paid.body);
      const mt = await one('SELECT actor_id, approved_by FROM money_transactions WHERE id = $1', [paid.json().moneyTransactionId]);
      assert.deepEqual([mt.actor_id, mt.approved_by], [c.emp['cashier@example.com'], approved.approved_by]);
      const ap = await one('SELECT status, money_transaction_id FROM approvals WHERE id = $1', [req1.json().id]);
      assert.deepEqual([ap.status, ap.money_transaction_id], ['EXECUTED', paid.json().moneyTransactionId]);
      assert.ok(await one(`SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'approval.approved'`, [req1.json().id]));
      // self-approval: the requester cannot decide; a rejection keeps the handpay unpaid
      const { eventId: e2 } = await jackpot(3, 1600);
      const h2 = await handpayOf(e2);
      const req2 = await post('manager@example.com', `/api/v1/handpays/${h2.id}/approval-request`); // may request and decide, but not both
      assert.equal(req2.statusCode, 200, req2.body);
      assert.match((await post('manager@example.com', `/api/v1/approvals/${req2.json().id}/decide`, { decision: 'APPROVED' })).json().error, /requester cannot approve/);
      await post('accounting@example.com', `/api/v1/approvals/${req2.json().id}/decide`, { decision: 'REJECTED' });
      assert.equal((await handpayOf(e2)).status, 'PENDING');
      assert.match((await pay('cashier@example.com', 3)).json().error, /Supervisor approval required/);
      await q('UPDATE casino_money_settings SET handpay_approval_cents = NULL WHERE casino_id = $1', [c.casino.id]);
      assert.equal((await pay('cashier@example.com', 3)).statusCode, 200, 'below the (removed) limit the payment approves implicitly');
    });

    test('verification (KYC) above the threshold, then wallet payment (no balance column, no reservation)', async () => {
      await q('UPDATE organizations SET verification_threshold_cents = 200000 WHERE id = $1', [c.orgId]);
      const { eventId } = await jackpot(4, 2500);
      assert.match((await pay('cashier@example.com', 4)).json().error, /identified, verified player/);
      const cardNumber = `7B-${randomUUID().slice(0, 8)}`;
      const p = await tx((db) => svc.players.createPlayer(db as never, actor('admin@example.com'), { homeCasinoId: c.casino.id, card: { cardNumber } }));
      assert.match((await pay('cashier@example.com', 4, { playerCard: cardNumber })).json().error, /not verified/);
      await q(`UPDATE players SET verification_status = 'VERIFIED' WHERE id = $1`, [p.player.id]);
      const ok = await pay('cashier@example.com', 4, { playerCard: cardNumber });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal((await one('SELECT player_id FROM money_transactions WHERE id = $1', [ok.json().moneyTransactionId])).player_id, p.player.id);
      assert.equal((await handpayOf(eventId)).player_id, p.player.id);
      await q('UPDATE organizations SET verification_threshold_cents = NULL WHERE id = $1', [c.orgId]);

      // wallet: the handpay credits the player's wallet; no cash row
      const { eventId: e2 } = await jackpot(4, 80);
      assert.equal((await pay('cashier@example.com', 4, { payTo: 'WALLET' })).statusCode, 400);
      const w = await pay('cashier@example.com', 4, { payTo: 'WALLET', playerCard: cardNumber });
      assert.equal(w.statusCode, 200, w.body);
      const wb = await one('SELECT available_cents, reserved_cents FROM wallet_balances WHERE player_id = $1', [p.player.id]);
      assert.deepEqual([wb.available_cents, wb.reserved_cents], [8_000, 0]);
      const entries = await q(`SELECT a.kind, e.amount_cents FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.transaction_id = $1 ORDER BY a.kind`, [w.json().moneyTransactionId]);
      assert.deepEqual(entries, [{ kind: 'HANDPAY_PAYABLE', amount_cents: 8_000 }, { kind: 'WALLET_AVAILABLE', amount_cents: -8_000 }]);
      assert.equal((await q(`SELECT 1 FROM cash_transactions WHERE source_event_id = $1`, [e2])).length, 0);
      assert.equal((await handpayOf(e2)).pay_method, 'WALLET');
      assert.ok(!(await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'wallets'`)).some((r) => /balance/.test(r.column_name)));
      // a blocked wallet takes no handpay (the handpay stays payable in cash)
      await q(`UPDATE wallets SET status = 'BLOCKED' WHERE player_id = $1`, [p.player.id]);
      const { eventId: e3 } = await jackpot(4, 60);
      assert.match((await pay('cashier@example.com', 4, { payTo: 'WALLET', playerCard: cardNumber })).json().error, /Wallet status BLOCKED/);
      assert.equal((await handpayOf(e3)).status, 'PENDING');
      st.openOnM4 = (await handpayOf(e3)).id;
    });

    test('wallet handpay = HANDPAY_PAYABLE -> WALLET_AVAILABLE: no reservation, no transfer, no balance needed, exactly once', async () => {
      const cardNumber = `7BW-${randomUUID().slice(0, 8)}`;
      const p = await tx((db) => svc.players.createPlayer(db as never, actor('admin@example.com'), { homeCasinoId: c.casino.id, card: { cardNumber } }));
      assert.equal((await one('SELECT available_cents FROM wallet_balances WHERE player_id = $1', [p.player.id])).available_cents, 0, 'an empty wallet can receive a handpay');
      const { eventId } = await jackpot(5, 77.77);
      const h = await handpayOf(eventId);
      const key = randomUUID();
      const results = await Promise.all([
        pay('cashier@example.com', 5, { payTo: 'WALLET', playerCard: cardNumber }, key),
        ...Array.from({ length: 4 }, () => pay('cashier@example.com', 5, { payTo: 'WALLET', playerCard: cardNumber })),
      ]);
      assert.equal(results.filter((r) => r.statusCode === 200).length, 1, results.map((r) => r.body).join('\n'));
      assert.ok(results.filter((r) => r.statusCode !== 200).every((r) => r.statusCode === 409));
      const ok = results.find((r) => r.statusCode === 200)!;
      if (ok === results[0]) assert.deepEqual((await pay('cashier@example.com', 5, { payTo: 'WALLET', playerCard: cardNumber }, key)).json(), ok.json());
      assert.equal(ok.json().payTo, 'WALLET');
      assert.match((await pay('cashier@example.com', 5, { payTo: 'CASH' })).json().error, /already paid/, 'no second payment by another method');
      const mt = await one(`SELECT type, amount_cents, wallet_id, player_id, handpay_id, source_event_id, transfer_id, cashier_session_id FROM money_transactions WHERE handpay_id = $1 AND type = 'HANDPAY_PAY'`, [h.id]);
      const wallet = (await one('SELECT id FROM wallets WHERE player_id = $1', [p.player.id])).id;
      assert.deepEqual(mt, { type: 'HANDPAY_PAY', amount_cents: 7_777, wallet_id: wallet, player_id: p.player.id, handpay_id: h.id, source_event_id: eventId, transfer_id: null, cashier_session_id: null });
      assert.ok(Number.isSafeInteger(mt.amount_cents));
      const entries = await q(`SELECT a.kind, e.amount_cents FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id JOIN money_transactions t ON t.id = e.transaction_id
        WHERE t.handpay_id = $1 AND t.type = 'HANDPAY_PAY' ORDER BY a.kind`, [h.id]);
      assert.deepEqual(entries, [{ kind: 'HANDPAY_PAYABLE', amount_cents: 7_777 }, { kind: 'WALLET_AVAILABLE', amount_cents: -7_777 }]);
      const wb = await one('SELECT available_cents, reserved_cents FROM wallet_balances WHERE player_id = $1', [p.player.id]);
      assert.deepEqual([wb.available_cents, wb.reserved_cents], [7_777, 0]);
      assert.equal((await q(`SELECT 1 FROM ledger_accounts WHERE wallet_id = $1 AND kind = 'WALLET_RESERVED'`, [wallet])).length, 0, 'the reservation account is never touched');
      assert.equal((await q('SELECT 1 FROM wallet_transfers WHERE wallet_id = $1', [wallet])).length, 0, 'no wallet <-> machine transfer');
      assert.deepEqual((await q('SELECT type FROM money_transactions WHERE wallet_id = $1', [wallet])).map((r) => r.type), ['HANDPAY_PAY'], 'one credit, no duplicate');
      assert.equal((await q('SELECT 1 FROM cash_transactions WHERE source_event_id = $1', [eventId])).length, 0);
    });

    test('insufficient cash and a rolled back transaction leave no trace', async () => {
      const small = await openShift('attendant@example.com', 1_000);
      const { eventId } = await jackpot(5, 50);
      const h = await handpayOf(eventId);
      const r = await pay('attendant@example.com', 5);
      assert.equal(r.statusCode, 409);
      assert.match(r.json().error, /Insufficient balance on DRAWER/);
      assert.equal((await handpayOf(eventId)).status, 'PENDING');
      assert.deepEqual(await txsOf(h.id), ['HANDPAY_CREATE_JACKPOT']);
      await assert.rejects(tx(async (db) => {
        await svc.handpays.payHandpay(db as never, actor('cashier@example.com'), h.id);
        throw new Error('crash after the booking');
      }), /crash/);
      assert.equal((await handpayOf(eventId)).status, 'PENDING');
      assert.deepEqual(await txsOf(h.id), ['HANDPAY_CREATE_JACKPOT']);
      assert.equal((await q(`SELECT 1 FROM cash_transactions WHERE source_event_id = $1`, [eventId])).length, 0);
      assert.equal((await commands(h.id)).length, 0);
      assert.equal((await pay('cashier@example.com', 5)).statusCode, 200);
      const close = await post('attendant@example.com', '/api/v1/cashier/session/close', { countedBalance: 10 });
      await post('manager@example.com', `/api/v1/cash/movements/${close.json().movementId}/confirm`, { totalCents: 1_000 });
      assert.equal((await one('SELECT status FROM cashier_sessions WHERE id = $1', [small])).status, 'CLOSED');
    });

    test('void before payment reverses the liability (supervisor); a voided handpay cannot be paid', async () => {
      const { eventId } = await jackpot(6, 30);
      const h = await handpayOf(eventId);
      const before = await payable();
      const v = await post('floor@example.com', `/api/v1/handpays/${h.id}/void`, { reason: 'test jackpot, machine in demo mode' });
      assert.equal(v.json().status, 'VOIDED', v.body);
      assert.equal(await payable(), before - 3_000);
      assert.deepEqual(await txsOf(h.id), ['HANDPAY_CREATE_JACKPOT', 'REVERSAL']);
      assert.match((await pay('cashier@example.com', 6)).json().error, /No pending jackpot/);
    });

    test('frozen HANDPAY: the jackpot is stored and deferred (no handpay, no booking); the lift replays it exactly once', async () => {
      await q(`INSERT INTO money_rail_freezes (org_id, rail, casino_id, reason) VALUES ($1,'HANDPAY',$2,'test freeze')`, [c.orgId, c.casino.id]);
      const r = await pay('cashier@example.com', 4);
      assert.equal(r.statusCode, 409);
      assert.match(r.json().error, /HANDPAY is frozen/);
      const eventId = randomUUID();
      const j = await jackpot(6, 40, eventId);
      assert.equal(j.res.json().accepted, 1, j.res.body);
      // the authoritative event is stored, the handpay processing is deferred, nothing is booked
      assert.equal((await q('SELECT 1 FROM machine_events WHERE event_id = $1', [eventId])).length, 1);
      const d = await one('SELECT status, reason, amount_cents, business_date, occurred_at, received_at, replayed_at FROM deferred_money_events WHERE event_id = $1', [eventId]);
      const ev = await one('SELECT occurred_at, received_at FROM machine_events WHERE event_id = $1', [eventId]);
      assert.deepEqual([d.occurred_at, d.received_at, d.replayed_at], [ev.occurred_at, ev.received_at, null]);
      const today = (await one(`SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM casinos WHERE id = $1`, [c.casino.id])).d;
      assert.deepEqual([d.status, d.reason, Number(d.amount_cents), d.business_date], ['PENDING', 'FROZEN', 4_000, today]);
      assert.equal(await handpayOf(eventId), undefined);
      assert.equal((await q('SELECT 1 FROM money_transactions WHERE source_event_id = $1', [eventId])).length, 0);
      assert.ok(await one(`SELECT 1 FROM alerts WHERE casino_id = $1 AND type = 'HANDPAY_DEFERRED'`, [c.casino.id]));
      // a gateway resend is a duplicate; a replay while frozen does nothing
      assert.equal((await jackpot(6, 40, eventId)).res.json().duplicates, 1);
      assert.deepEqual((await post('floor@example.com', '/api/v1/handpays/deferred/replay', { casinoId: c.casino.id })).json().replayed, []);
      // CASH continues while HANDPAY is frozen
      const f = await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: st.shift, amountCents: 500 });
      assert.equal((await post('cashier@example.com', `/api/v1/cash/movements/${f.json().movement.id}/confirm`, { totalCents: 500 })).json().movement.status, 'CONFIRMED');
      // the lift replays the deferred jackpot in the same transaction, on the business date of occurred_at
      const freezeId = (await one(`SELECT id FROM money_rail_freezes WHERE casino_id = $1 AND rail = 'HANDPAY' AND lifted_at IS NULL`, [c.casino.id])).id;
      const lift = await post('admin@example.com', `/api/v1/money/freezes/${freezeId}/lift`, { reason: 'test over' });
      assert.equal(lift.json().lifted, true, JSON.stringify(lift.json().result?.checks?.filter((x: { ok: boolean }) => !x.ok) ?? lift.json()));
      assert.deepEqual(lift.json().replayed.map((x: { eventId: string }) => x.eventId), [eventId]);
      const h = await handpayOf(eventId);
      assert.equal(h.status, 'PENDING');
      const created = await q(`SELECT business_date::text AS d FROM money_transactions WHERE handpay_id = $1 AND type = 'HANDPAY_CREATE_JACKPOT'`, [h.id]);
      assert.deepEqual(created, [{ d: today }], 'exactly one creation booking, original business date');
      assert.deepEqual(await one('SELECT status, handpay_id, replayed_at IS NOT NULL AS replayed FROM deferred_money_events WHERE event_id = $1', [eventId]), { status: 'PROCESSED', handpay_id: h.id, replayed: true });
      assert.deepEqual((await q(`SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY created_at, id`, [eventId])).map((r) => r.action), ['handpay.deferred', 'handpay.deferred_replayed']);
      // repeated replay, maintenance job and gateway resend: still one handpay, one booking
      assert.deepEqual((await post('floor@example.com', '/api/v1/handpays/deferred/replay', { casinoId: c.casino.id })).json().replayed, []);
      assert.deepEqual(await tx((db) => svc.handpays.replayDeferredHandpays(db as never)), []);
      assert.equal((await jackpot(6, 40, eventId)).res.json().duplicates, 1);
      assert.deepEqual(await txsOf(h.id), ['HANDPAY_CREATE_JACKPOT']);
      assert.equal((await pay('cashier@example.com', 6)).statusCode, 200);
    });

    test('frozen HANDPAY on a machine whose MACHINE rail is on the ledger: the event is still stored (deferred record satisfies the guard)', async () => {
      const all = await createLedgerCasino(c.pool as never, { orgId: c.orgId, code: `7BM${Date.now() % 100000}`, machines: 1, gateway: true });
      await q(`INSERT INTO money_rail_freezes (org_id, rail, casino_id, reason) VALUES ($1,'HANDPAY',$2,'test freeze')`, [c.orgId, all.id]);
      const eventId = randomUUID();
      const r = await c.app.inject({ method: 'POST', url: '/api/v1/gateway/events', headers: { 'x-gateway-id': all.gateway!.deviceId, 'x-gateway-key': all.gateway!.key },
        payload: { events: [{ eventId, type: 'JACKPOT', machineId: all.machines[0].code, timestamp: new Date().toISOString(), amount: 15 }] } });
      assert.equal(r.json().accepted, 1, r.body);
      assert.equal((await one('SELECT status FROM deferred_money_events WHERE event_id = $1', [eventId])).status, 'PENDING');
      assert.equal(await handpayOf(eventId), undefined);
      const freezeId = (await one(`SELECT id FROM money_rail_freezes WHERE casino_id = $1 AND lifted_at IS NULL`, [all.id])).id;
      const lift = await post('admin@example.com', `/api/v1/money/freezes/${freezeId}/lift`, { reason: 'test over' });
      assert.equal(lift.json().replayed.length, 1, lift.body);
      assert.deepEqual(await txsOf((await handpayOf(eventId)).id), ['HANDPAY_CREATE_JACKPOT']);
    });

    test('deferred replay is concurrency-safe: parallel replays of the same events book each event once', async () => {
      await q(`INSERT INTO money_rail_freezes (org_id, rail, casino_id, reason) VALUES ($1,'HANDPAY',$2,'test freeze 2')`, [c.orgId, c.casino.id]);
      const events = [randomUUID(), randomUUID()];
      for (const e of events) assert.equal((await jackpot(7, 12.34, e)).res.json().accepted, 1);
      // lift the freeze without the in-transaction replay, so that independent replays race
      const run = (await one(`INSERT INTO reconciliation_runs (org_id, casino_id, trigger, ok, checks) VALUES ($1,$2,'MANUAL',true,'[]') RETURNING id`, [c.orgId, c.casino.id])).id;
      await q(`UPDATE money_rail_freezes SET lifted_at = now(), lifted_by = $2, lift_reason = 'race test', lift_run_id = $3 WHERE casino_id = $1 AND rail = 'HANDPAY' AND lifted_at IS NULL`, [c.casino.id, c.emp['admin@example.com'], run]);
      const results = await Promise.all(Array.from({ length: 4 }, () => tx((db) => svc.handpays.replayDeferredHandpays(db as never, { casinoId: c.casino.id }))));
      assert.equal(results.flat().length, 2);
      for (const e of events) {
        const h = await handpayOf(e);
        assert.deepEqual(await txsOf(h.id), ['HANDPAY_CREATE_JACKPOT']);
        assert.equal((await one('SELECT status FROM deferred_money_events WHERE event_id = $1', [e])).status, 'PROCESSED');
      }
      // pay both (the route pays the newest open handpay of the machine first)
      assert.equal((await pay('cashier@example.com', 7)).statusCode, 200);
      assert.equal((await pay('cashier@example.com', 7)).statusCode, 200);
    });

    test('business date: a deferred jackpot is booked on the date of occurred_at, not on the replay day; the date cannot be overridden', async () => {
      const b = await createLedgerCasino(c.pool as never, { orgId: c.orgId, code: `7BD${Date.now() % 100000}`, rails: ['VAULT', 'CASH', 'HANDPAY'], machines: 1, gateway: true });
      const send = (eventId: string, timestamp: string, amount: number) => c.app.inject({ method: 'POST', url: '/api/v1/gateway/events', headers: { 'x-gateway-id': b.gateway!.deviceId, 'x-gateway-key': b.gateway!.key },
        payload: { events: [{ eventId, type: 'JACKPOT', machineId: b.machines[0].code, timestamp, amount }] } });
      const day = async (offset: number) => (await one(`SELECT ((now() AT TIME ZONE timezone)::date + $2::int)::text AS d FROM casinos WHERE id = $1`, [b.id, offset])).d as string;
      const [today, yesterday] = [await day(0), await day(-1)];
      await q(`INSERT INTO money_rail_freezes (org_id, rail, casino_id, reason) VALUES ($1,'HANDPAY',$2,'test freeze')`, [c.orgId, b.id]);
      const eventId = randomUUID();
      const occurred = new Date(Date.now() - 24 * 3600_000).toISOString();
      assert.equal((await send(eventId, occurred, 25)).json().accepted, 1);
      const d = await one('SELECT business_date::text AS bd, occurred_at, received_at FROM deferred_money_events WHERE event_id = $1', [eventId]);
      assert.equal(d.bd, yesterday, 'business date of occurred_at, not of received_at');
      assert.ok(d.received_at > d.occurred_at);
      // the recorded event is immutable and taken from the machine event, never supplied freely
      await assert.rejects(c.pool.query(`UPDATE deferred_money_events SET business_date = $2 WHERE event_id = $1`, [eventId, today]), /immutable/);
      await assert.rejects(c.pool.query(`DELETE FROM deferred_money_events WHERE event_id = $1`, [eventId]));
      const other = (await one(`INSERT INTO machine_events (event_id, org_id, casino_id, machine_id, type, amount, occurred_at) VALUES (gen_random_uuid(),$1,$2,$3,'JACKPOT',0,now()) RETURNING event_id`, [c.orgId, b.id, b.machines[0].id])).event_id; // amount 0: no handpay due
      await assert.rejects(c.pool.query(`INSERT INTO deferred_money_events (event_id, org_id, casino_id, machine_id, rail, kind, amount_cents, reason, business_date) VALUES ($1,$2,$3,$4,'HANDPAY','JACKPOT',999,'FROZEN',$5)`,
        [other, c.orgId, b.id, b.machines[0].id, today]), /does not match machine event/);
      // an explicit business date is only accepted for a pending deferred record of that event and date
      const book = (sourceEventId: string, businessDate: string) => tx((db) => svc.ledger.executeMoneyTransaction(db as never, {
        orgId: c.orgId, type: 'HANDPAY_CREATE_JACKPOT', dedupeKey: `bd-${randomUUID()}`, sourceEventId, businessDate, actor: { type: 'GATEWAY', name: 'test' },
        ctx: { casinoId: b.id, amountCents: cents(1_000), machineId: b.machines[0].id, handpayId: randomUUID() },
      }));
      await assert.rejects(book(other, today), /does not match a pending deferred event/);
      await assert.rejects(book(eventId, today), /does not match a pending deferred event/);
      assert.equal((await q('SELECT 1 FROM money_transactions WHERE source_event_id = ANY($1)', [[eventId, other]])).length, 0);
      // lift: one creation booking on the original business date (yesterday), replayed_at set
      const freezeId = (await one(`SELECT id FROM money_rail_freezes WHERE casino_id = $1 AND lifted_at IS NULL`, [b.id])).id;
      const lift = await post('admin@example.com', `/api/v1/money/freezes/${freezeId}/lift`, { reason: 'test over' });
      assert.deepEqual(lift.json().replayed.map((x: { eventId: string }) => x.eventId), [eventId], lift.body);
      const h = await handpayOf(eventId);
      assert.deepEqual(await q(`SELECT business_date::text AS d FROM money_transactions WHERE source_event_id = $1`, [eventId]), [{ d: yesterday }]);
      assert.ok((await one('SELECT replayed_at FROM deferred_money_events WHERE event_id = $1', [eventId])).replayed_at);
      await assert.rejects(c.pool.query(`UPDATE deferred_money_events SET attempts = attempts + 1 WHERE event_id = $1`, [eventId]), /immutable/);
      const run = (await post('floor@example.com', '/api/v1/money/reconciliation', { casinoId: b.id })).json();
      assert.equal(run.ok, true, JSON.stringify(run.checks.filter((x: { ok: boolean }) => !x.ok)));
      assert.deepEqual(await txsOf(h.id), ['HANDPAY_CREATE_JACKPOT']);
    });

    test('business date: a deferred jackpot whose original date is closed is not booked (guard not bypassed); reconciliation reports it until explained by four eyes', async () => {
      const b = await createLedgerCasino(c.pool as never, { orgId: c.orgId, code: `7BC${Date.now() % 100000}`, rails: ['VAULT', 'CASH', 'HANDPAY'], machines: 1, gateway: true });
      const twoDaysAgo = (await one(`SELECT ((now() AT TIME ZONE timezone)::date - 2)::text AS d FROM casinos WHERE id = $1`, [b.id])).d;
      const runId = (await one(`INSERT INTO reconciliation_runs (org_id, casino_id, trigger, ok, checks) VALUES ($1,$2,'MANUAL',true,'[]') RETURNING id`, [c.orgId, b.id])).id;
      await q(`INSERT INTO business_day_closes (casino_id, business_date, org_id, closed_by, reconciliation_run_id) VALUES ($1,$2,$3,$4,$5)`, [b.id, twoDaysAgo, c.orgId, c.emp['manager@example.com'], runId]);
      await q(`INSERT INTO money_rail_freezes (org_id, rail, casino_id, reason) VALUES ($1,'HANDPAY',$2,'test freeze')`, [c.orgId, b.id]);
      const eventId = randomUUID();
      const r = await c.app.inject({ method: 'POST', url: '/api/v1/gateway/events', headers: { 'x-gateway-id': b.gateway!.deviceId, 'x-gateway-key': b.gateway!.key },
        payload: { events: [{ eventId, type: 'JACKPOT', machineId: b.machines[0].code, timestamp: new Date(Date.now() - 48 * 3600_000).toISOString(), amount: 33 }] } });
      assert.equal(r.json().accepted, 1, r.body);
      assert.equal((await one('SELECT business_date::text AS d FROM deferred_money_events WHERE event_id = $1', [eventId])).d, twoDaysAgo);
      // the lift succeeds; the replay of this record is refused by the closed-date guard and kept
      let freezeId = (await one(`SELECT id FROM money_rail_freezes WHERE casino_id = $1 AND lifted_at IS NULL`, [b.id])).id;
      const lift = await post('admin@example.com', `/api/v1/money/freezes/${freezeId}/lift`, { reason: 'test over' });
      assert.deepEqual([lift.json().lifted, lift.json().replayed], [true, []], lift.body);
      const d = await one('SELECT status, attempts, last_error, replayed_at FROM deferred_money_events WHERE event_id = $1', [eventId]);
      assert.deepEqual([d.status, d.attempts, d.replayed_at], ['PENDING', 1, null]);
      assert.match(d.last_error, /Business date .* is closed/);
      assert.equal(await handpayOf(eventId), undefined);
      assert.equal((await q('SELECT 1 FROM money_transactions WHERE source_event_id = $1', [eventId])).length, 0, 'never moved to today');
      assert.ok(await one(`SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'handpay.deferred_replay_failed'`, [eventId]));
      // the maintenance safety net does not retry it on every tick
      assert.deepEqual(await tx((db) => svc.handpays.replayDeferredHandpays(db as never, { casinoId: b.id })), []);
      assert.equal((await one('SELECT attempts FROM deferred_money_events WHERE event_id = $1', [eventId])).attempts, 1);
      // reconciliation detects the unresolved deferred event, freezes HANDPAY and blocks the day close
      const run = (await post('floor@example.com', '/api/v1/money/reconciliation', { casinoId: b.id })).json();
      const stale = run.checks.find((x: { key: string }) => x.key === 'handpay.no_stale_deferred_events');
      assert.deepEqual(stale.items, [`deferred_event:${eventId}`]);
      assert.deepEqual(run.frozen.map((f: { rail: string }) => f.rail), ['HANDPAY']);
      const yesterday = (await one(`SELECT ((now() AT TIME ZONE timezone)::date - 1)::text AS d FROM casinos WHERE id = $1`, [b.id])).d;
      assert.equal((await post('manager@example.com', '/api/v1/money/day-close', { casinoId: b.id, businessDate: yesterday })).json().closed, false);
      // explicit handling: a four-eyes explanation (late-event process); the event stays recorded and unbooked
      const req = await post('manager@example.com', '/api/v1/money/resolutions', { casinoId: b.id, itemKey: `deferred_event:${eventId}`, explanation: 'Late jackpot for a closed date, handled by the late-event process' });
      assert.equal(req.statusCode, 200, req.body);
      assert.ok((await post('accounting@example.com', `/api/v1/approvals/${req.json().id}/decide`, { decision: 'APPROVED' })).json().resolution);
      freezeId = run.frozen[0].id;
      assert.equal((await post('admin@example.com', `/api/v1/money/freezes/${freezeId}/lift`, { reason: 'explained' })).json().lifted, true);
      assert.equal((await one('SELECT status FROM deferred_money_events WHERE event_id = $1', [eventId])).status, 'PENDING');
      assert.equal((await q('SELECT 1 FROM money_transactions WHERE source_event_id = $1', [eventId])).length, 0);
    });

    test('reconciliation: HANDPAY checks clean; a payable mismatch freezes only HANDPAY; a four-eyes correction repairs it', async () => {
      let run = (await post('floor@example.com', '/api/v1/money/reconciliation', { casinoId: c.casino.id })).json();
      assert.equal(run.ok, true, JSON.stringify(run.checks.filter((x: { ok: boolean }) => !x.ok)));
      assert.deepEqual(run.checks.filter((x: { rail: string }) => x.rail === 'HANDPAY').map((x: { key: string }) => x.key).sort(),
        ['handpay.bookings_match_state', 'handpay.creations_booked', 'handpay.deferred_business_date', 'handpay.jackpots_accounted', 'handpay.no_stale_deferred_events', 'handpay.payable_matches_open_handpays', 'handpay.payments_booked_once']);
      const adjust = (debit: Record<string, unknown>, credit: Record<string, unknown>) => tx((db) => svc.ledger.executeMoneyTransaction(db as never, {
        orgId: c.orgId, type: 'ADJUSTMENT', dedupeKey: `adj-${randomUUID()}`, reason: 'test', actor: { type: 'EMPLOYEE', employeeId: c.emp['manager@example.com'] }, approvedBy: c.emp['accounting@example.com'],
        ctx: { casinoId: c.casino.id, amountCents: cents(100), debit: debit as never, credit: credit as never },
      }));
      await adjust({ kind: 'CASH_SHORT_OVER' }, { kind: 'HANDPAY_PAYABLE' });
      run = (await post('floor@example.com', '/api/v1/money/reconciliation', { casinoId: c.casino.id })).json();
      assert.deepEqual(run.frozen.map((f: { rail: string }) => f.rail), ['HANDPAY']);
      assert.match((await pay('cashier@example.com', 4)).json().error, /HANDPAY is frozen/);
      await adjust({ kind: 'HANDPAY_PAYABLE' }, { kind: 'CASH_SHORT_OVER' }); // correction allowed while frozen
      assert.equal((await post('admin@example.com', `/api/v1/money/freezes/${run.frozen[0].id}/lift`, { reason: 'corrected' })).json().lifted, true);
      assert.equal((await pay('cashier@example.com', 4)).statusCode, 200);
    });

    test('a LEGACY HANDPAY rail with CASH on the ledger refuses payment (no mixing); production cutover released once TITO is implemented (7c)', async () => {
      const l = await createLedgerCasino(c.pool as never, { orgId: c.orgId, code: `7BL${Date.now() % 100000}`, rails: ['VAULT', 'CASH'], machines: 1 });
      const ev = (await one(`INSERT INTO machine_events (event_id, org_id, casino_id, machine_id, type, amount, occurred_at) VALUES (gen_random_uuid(),$1,$2,$3,'JACKPOT',20,now()) RETURNING event_id`, [c.orgId, l.id, l.machines[0].id])).event_id;
      const h = await tx((db) => svc.handpays.ensureHandpayForJackpot(db as never, { orgId: c.orgId, casinoId: l.id, machineId: l.machines[0].id, eventId: ev, amountCents: 2_000 }));
      assert.deepEqual(await txsOf(h!.id), [], 'legacy rail: no ledger booking');
      await assert.rejects(tx((db) => svc.handpays.payHandpay(db as never, actor('manager@example.com', [l.id]), h!.id)), /HANDPAY is not: cut over the HANDPAY rail first/);
      // 7b: refused with "maintenance window ... missing for TITO"; since 7c the window is complete: the release gate
      // passes and the real cutover runs its data checks (here it aborts on the test handpay, nothing is booked)
      const cut = await post('admin@example.com', '/api/v1/money/cutover', { rail: 'HANDPAY', casinoId: l.id });
      assert.equal(cut.statusCode, 409);
      assert.doesNotMatch(cut.json().error, /not released yet/);
      assert.match(cut.json().error, /HANDPAY cutover aborted/);
      assert.deepEqual(await txsOf(h!.id), [], 'an aborted cutover books nothing');
    });

    test('historical handpays: unmapped legacy payments block the cutover until classified by four eyes with evidence', async () => {
      const x = await createCasinoShell(c.pool as never, { orgId: c.orgId, code: `7BX${Date.now() % 100000}`, machines: 2 });
      const tech = c.emp['tech@example.com'];
      const session = (await one(`INSERT INTO cashier_sessions (org_id, casino_id, cash_desk_id, employee_id, opening_balance, opened_at) VALUES ($1,$2,$3,$4,1000, now() - interval '5 hours') RETURNING id`, [c.orgId, x.id, x.desk, tech])).id;
      const j1 = (await one(`INSERT INTO machine_events (event_id, org_id, casino_id, machine_id, type, amount, occurred_at) VALUES (gen_random_uuid(),$1,$2,$3,'JACKPOT',300, now() - interval '3 hours') RETURNING event_id`, [c.orgId, x.id, x.machines[0].id])).event_id;
      const hj1 = await tx((db) => svc.handpays.ensureHandpayForJackpot(db as never, { orgId: c.orgId, casinoId: x.id, machineId: x.machines[0].id, eventId: j1, amountCents: 30_000 }));
      await q('UPDATE machines SET jackpot_pending = true WHERE id = $1', [x.machines[0].id]);
      const ins = async (amount: number, machine: string | null) => (await one(
        `INSERT INTO cash_transactions (org_id, casino_id, session_id, employee_id, type, amount, machine_id, created_at) VALUES ($1,$2,$3,$4,'HANDPAY',$5,$6, now() - interval '2 hours') RETURNING id`,
        [c.orgId, x.id, session, tech, amount, machine])).id as number;
      const ct300 = await ins(-300, x.machines[0].id);
      const ct120 = await ins(-120, x.machines[1].id);
      const ct77 = await ins(-77, null);
      await q(`UPDATE cashier_sessions SET status = 'CLOSED', closed_at = now() - interval '1 hour', expected_balance = 503, counted_balance = 503, difference = 0 WHERE id = $1`, [session]);
      const cashRows = (await q('SELECT count(*)::int n FROM cash_transactions WHERE casino_id = $1', [x.id]))[0].n;
      await cutoverCasinoRails(c.pool as never, x, ['VAULT', 'CASH'], { deskCents: 50_300 });
      const cutover = await import('../src/services/cutover');
      let dry = await cutover.dryRunCutover(c.pool as never, actor('admin@example.com', [x.id]), { rail: 'HANDPAY', casinoId: x.id });
      const detail = dry.checks.find((k) => k.name === 'handpay_payments_have_jackpot_event')!.detail as { unmappedCashTransactionIds: number[] };
      assert.deepEqual(detail.unmappedCashTransactionIds, [ct300, ct120, ct77]);

      const det = await post('floor@example.com', '/api/v1/handpays/legacy-exceptions/detect', { casinoId: x.id });
      const exc = Object.fromEntries(det.json().map((e: { cash_transaction_id: number; id: string }) => [e.cash_transaction_id, e.id]));
      const propose = (id: string, body: Record<string, unknown>) => post('floor@example.com', `/api/v1/handpays/legacy-exceptions/${id}/propose`, body);
      const evidence = { evidenceReference: 'Jackpot slip 2023-114, scan DMS-8811', justification: 'Slip signed by cashier and attendant, machine log confirms the hit' };
      // LINK only when fully determined: amount mismatch refused, no evidence refused
      assert.match((await propose(exc[ct120], { resolution: 'LINK', jackpotEventId: j1, ...evidence })).json().error, /different machines|amount differs/);
      assert.equal((await propose(exc[ct300], { resolution: 'LINK', jackpotEventId: j1, evidenceReference: 'x', justification: 'short' })).statusCode, 400);
      const link = await propose(exc[ct300], { resolution: 'LINK', jackpotEventId: j1, ...evidence });
      assert.equal(link.json().status, 'PROPOSED', link.body);
      assert.match((await post('floor@example.com', `/api/v1/approvals/${link.json().approval_id}/decide`, { decision: 'APPROVED' })).json().error, /requester cannot approve/);
      const linked = await post('accounting@example.com', `/api/v1/approvals/${link.json().approval_id}/decide`, { decision: 'APPROVED' });
      assert.equal(linked.json().exception.status, 'APPROVED', linked.body);
      const h = await one('SELECT status, legacy_cash_transaction_id, pay_method FROM handpays WHERE id = $1', [hj1!.id]);
      assert.deepEqual([h.status, Number(h.legacy_cash_transaction_id), h.pay_method], ['PAID', ct300, 'CASH']);
      // HISTORICAL: rejected first, then proposed again and approved
      const hist = await propose(exc[ct120], { resolution: 'HISTORICAL', ...evidence });
      await post('accounting@example.com', `/api/v1/approvals/${hist.json().approval_id}/decide`, { decision: 'REJECTED' });
      assert.equal((await one('SELECT status FROM handpay_legacy_exceptions WHERE id = $1', [exc[ct120]])).status, 'REJECTED');
      const hist2 = await propose(exc[ct120], { resolution: 'HISTORICAL', ...evidence });
      await post('accounting@example.com', `/api/v1/approvals/${hist2.json().approval_id}/decide`, { decision: 'APPROVED' });
      const disp = await propose(exc[ct77], { resolution: 'DISPUTED', evidenceReference: 'Incident report IR-77', justification: 'No machine recorded on the payment; investigation opened' });
      await post('accounting@example.com', `/api/v1/approvals/${disp.json().approval_id}/decide`, { decision: 'APPROVED' });
      await assert.rejects(c.pool.query(`UPDATE handpay_legacy_exceptions SET resolution = 'HISTORICAL' WHERE id = $1`, [exc[ct77]]), /final/);
      const events = (await q('SELECT action FROM handpay_exception_events WHERE exception_id = $1 ORDER BY id', [exc[ct120]])).map((r) => r.action);
      assert.deepEqual(events, ['DETECTED', 'PROPOSED', 'REJECTED', 'PROPOSED', 'APPROVED']);

      dry = await cutover.dryRunCutover(c.pool as never, actor('admin@example.com', [x.id]), { rail: 'HANDPAY', casinoId: x.id });
      assert.equal(dry.ok, true, JSON.stringify(dry.checks.filter((k) => !k.ok)));
      const done = await cutover.runCutover(c.pool as never, actor('admin@example.com', [x.id]), { rail: 'HANDPAY', casinoId: x.id });
      assert.deepEqual([done.ok, done.openings.length, done.legacy.unpaid_total], [true, 0, 0], 'the linked jackpot is history: no payable opened');
      assert.equal(await payable(x.id), 0);
      assert.equal((await q('SELECT count(*)::int n FROM cash_transactions WHERE casino_id = $1', [x.id]))[0].n, cashRows, 'no cash movement invented');
      assert.deepEqual((await q(`SELECT DISTINCT type FROM money_transactions WHERE casino_id = $1`, [x.id])).map((r) => r.type), ['OPENING_BALANCE'], 'no ledger money for history');
    });

    test('closed business date: no payment and no new liability (clear 409); history untouched', async () => {
      const { eventId } = await jackpot(7, 45);
      const runId = (await one(`INSERT INTO reconciliation_runs (org_id, casino_id, trigger, ok, checks) VALUES ($1,$2,'MANUAL',true,'[]') RETURNING id`, [c.orgId, c.casino.id])).id;
      await q(`INSERT INTO business_day_closes (casino_id, business_date, org_id, closed_by, reconciliation_run_id) SELECT $1, (now() AT TIME ZONE timezone)::date, $2, $3, $4 FROM casinos WHERE id = $1`, [c.casino.id, c.orgId, c.emp['manager@example.com'], runId]);
      const r = await pay('cashier@example.com', 7);
      assert.equal(r.statusCode, 409);
      assert.match(r.json().error, /Business date .* is closed/);
      assert.equal((await handpayOf(eventId)).status, 'PENDING');
      // 7b: the jackpot event was refused with HTTP 409; since 7d the event is kept and its money part is a
      // recorded, deterministic business rejection (no handpay, no booking, reported by reconciliation)
      const closed = await jackpot(7, 46);
      assert.equal(closed.res.statusCode, 200);
      assert.equal(closed.res.json().exceptions[0].code, 'HTTP_409');
      assert.match(closed.res.json().exceptions[0].message, /Business date .* is closed/);
      assert.equal(await handpayOf(closed.eventId), undefined);
      assert.equal((await q('SELECT 1 FROM money_transactions WHERE source_event_id = $1', [closed.eventId])).length, 0);
    });

    test('business date of a live jackpot = occurred_at (not received_at): delayed by one and three days, same day, closed day', async () => {
      const b = await createLedgerCasino(c.pool as never, { orgId: c.orgId, code: `7BJ${Date.now() % 100000}`, rails: ['VAULT', 'CASH', 'HANDPAY'], machines: 1, gateway: true });
      const send = async (hoursAgo: number, amount: number) => {
        const eventId = randomUUID();
        const r = await c.app.inject({ method: 'POST', url: '/api/v1/gateway/events', headers: { 'x-gateway-id': b.gateway!.deviceId, 'x-gateway-key': b.gateway!.key },
          payload: { events: [{ eventId, type: 'JACKPOT', machineId: b.machines[0].code, timestamp: new Date(Date.now() - hoursAgo * 3600_000).toISOString(), amount }] } });
        assert.equal(r.json().accepted, 1, r.body);
        return eventId;
      };
      const day = async (offset: number) => (await one(`SELECT ((now() AT TIME ZONE timezone)::date + $2::int)::text AS d FROM casinos WHERE id = $1`, [b.id, offset])).d as string;
      const booked = async (eventId: string) => (await q(`SELECT t.business_date::text AS d FROM money_transactions t JOIN handpays h ON h.id = t.handpay_id
        WHERE h.source_event_id = $1 AND t.type = 'HANDPAY_CREATE_JACKPOT'`, [eventId])).map((r) => r.d);
      const dates = async (eventId: string) => one(`SELECT (e.occurred_at AT TIME ZONE c.timezone)::date::text AS occurred, (e.received_at AT TIME ZONE c.timezone)::date::text AS received
        FROM machine_events e JOIN casinos c ON c.id = e.casino_id WHERE e.event_id = $1`, [eventId]);
      // occurred on business day A (yesterday), received on business day B (today): booked on A
      const a = await send(24, 31);
      assert.deepEqual(await dates(a), { occurred: await day(-1), received: await day(0) });
      assert.deepEqual(await booked(a), [await day(-1)], 'booked on the occurred day, not on the receipt day');
      const da = await one(`SELECT status, reason, business_date::text AS bd, received_at IS NOT NULL AS r, replayed_at IS NOT NULL AS p FROM deferred_money_events WHERE event_id = $1`, [a]);
      assert.deepEqual(da, { status: 'PROCESSED', reason: 'LATE_EVENT', bd: await day(-1), r: true, p: true });
      // delayed by three days
      const late3 = await send(72, 32);
      assert.deepEqual(await booked(late3), [await day(-3)]);
      // same day: booked today, no deferred record
      const now = await send(0, 33);
      assert.deepEqual(await booked(now), [await day(0)]);
      assert.equal((await q('SELECT 1 FROM deferred_money_events WHERE event_id = $1', [now])).length, 0);
      // a resend is a duplicate: still exactly one creation booking
      assert.equal((await q(`SELECT 1 FROM money_transactions WHERE source_event_id = $1`, [a])).length, 1);
      // a closed occurred day is never bypassed: recorded, not booked, reported
      const closedDay = await day(-5);
      const runId = (await one(`INSERT INTO reconciliation_runs (org_id, casino_id, trigger, ok, checks) VALUES ($1,$2,'MANUAL',true,'[]') RETURNING id`, [c.orgId, b.id])).id;
      await q(`INSERT INTO business_day_closes (casino_id, business_date, org_id, closed_by, reconciliation_run_id) VALUES ($1,$2,$3,$4,$5)`, [b.id, closedDay, c.orgId, c.emp['manager@example.com'], runId]);
      const closed = await send(120, 34);
      assert.equal(await handpayOf(closed), undefined);
      assert.equal((await q('SELECT 1 FROM money_transactions WHERE source_event_id = $1', [closed])).length, 0, 'never moved to the receipt day');
      const dc = await one(`SELECT status, reason, business_date::text AS bd, last_error FROM deferred_money_events WHERE event_id = $1`, [closed]);
      assert.deepEqual([dc.status, dc.reason, dc.bd], ['PENDING', 'LATE_EVENT', closedDay]);
      assert.match(dc.last_error, /Business date .* is closed/);
      assert.match((await one(`SELECT message FROM alerts WHERE casino_id = $1 AND type = 'HANDPAY_DEFERRED'`, [b.id])).message, /pending explicit handling/);
      const run = (await post('floor@example.com', '/api/v1/money/reconciliation', { casinoId: b.id })).json();
      assert.deepEqual(run.checks.find((k: { key: string }) => k.key === 'handpay.no_stale_deferred_events').items, [`deferred_event:${closed}`]);
      assert.deepEqual(run.checks.find((k: { key: string }) => k.key === 'handpay.deferred_business_date').items, []);
    });

    test('end state: ledger invariants hold; every paid handpay has exactly one payment booking', async () => {
      assert.equal((await svc.ledger.checkLedgerInvariants(c.pool as never, c.orgId)).ok, true);
      const bad = await q(`SELECT h.id FROM handpays h WHERE h.casino_id = $1 AND h.status IN ('PAID', 'MACHINE_RESET')
        AND (SELECT count(*) FROM money_transactions t WHERE t.handpay_id = h.id AND t.type = 'HANDPAY_PAY') <> 1`, [c.casino.id]);
      assert.deepEqual(bad, []);
    });
  });
}
