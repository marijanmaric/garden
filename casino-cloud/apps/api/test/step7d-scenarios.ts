import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { cents } from '@m1/shared';
import { createLedgerCasino, ensureVaultOpen, openLedgerShift, type LedgerCasino } from './ledger-casino';

/**
 * Step 7d scenarios: machine money and cashless on the ledger. The same scenarios run on a fresh seeded
 * database and on a realistic upgraded one. The casino has every rail on the ledger, its machines were
 * cut over one by one after a verified (empty) collection; machine events arrive through the gateway API.
 */
export interface Ctx7d {
  app: FastifyInstance;
  pool: Pool;
  orgId: string;
  casino: LedgerCasino;
  emp: Record<string, string>;
  tokens: Record<string, string>;
}

export function registerStep7dScenarios(get: () => Ctx7d) {
  let c: Ctx7d;
  let svc: {
    ledger: typeof import('../src/services/ledger');
    players: typeof import('../src/services/players');
    cashless: typeof import('../src/services/cashless');
    machine: typeof import('../src/services/machine-money');
  };
  const st: Record<string, string> = {};

  const headers = (email: string, key: string = randomUUID()) => ({ authorization: `Bearer ${c.tokens[email]}`, 'idempotency-key': key });
  const post = (email: string, url: string, payload: unknown = {}, key?: string) => c.app.inject({ method: 'POST', url, payload: payload as object, headers: headers(email, key) });
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
  const m = (i: number, casino: LedgerCasino = c.casino) => casino.machines[i];
  const bal = (kind: string, ref: Record<string, unknown> = {}, casinoId = c.casino.id) => svc.ledger.getBalance(c.pool as never, c.orgId, { kind, casinoId, ...ref } as never);
  const credit = (i: number) => bal('MACHINE_CREDIT', { machineId: m(i).id });
  const gwOf = (casino: LedgerCasino) => (url: string, payload: unknown) =>
    c.app.inject({ method: 'POST', url, payload: payload as object, headers: { 'x-gateway-id': casino.gateway!.deviceId, 'x-gateway-key': casino.gateway!.key } });
  const gw = (url: string, payload: unknown) => gwOf(c.casino)(url, payload);
  async function event(i: number, type: string, fields: Record<string, unknown> = {}, opts: { eventId?: string; at?: Date; casino?: LedgerCasino } = {}) {
    const casino = opts.casino ?? c.casino;
    const eventId = opts.eventId ?? randomUUID();
    const res = await gwOf(casino)('/api/v1/gateway/events', { events: [{ eventId, type, machineId: m(i, casino).code, timestamp: (opts.at ?? new Date()).toISOString(), ...fields }] });
    return { res, eventId, body: res.json() };
  }
  const txOf = (eventId: string) => q('SELECT type, amount_cents, business_date::text AS d FROM money_transactions WHERE source_event_id = $1 ORDER BY created_at', [eventId]);
  const wallet = async (playerId: string) => one('SELECT available_cents::bigint AS a, reserved_cents::bigint AS r FROM wallet_balances WHERE player_id = $1', [playerId]).then((r) => ({ a: Number(r.a), r: Number(r.r) }));
  const recon = async (casinoId = c.casino.id) => (await post('floor@example.com', '/api/v1/money/reconciliation', { casinoId })).json();
  const lift = (freezeId: string, reason = 'test over') => post('admin@example.com', `/api/v1/money/freezes/${freezeId}/lift`, { reason });
  const day = async (offset: number, casinoId = c.casino.id) => (await one(`SELECT ((now() AT TIME ZONE timezone)::date + $2::int)::text AS d FROM casinos WHERE id = $1`, [casinoId, offset])).d as string;
  /** Four-eyes explanation of reconciliation items (manager requests, accounting approves). */
  async function explain(keys: string[], casinoId = c.casino.id, explanation = 'Investigated: duplicate machine ack, no money moved') {
    for (const key of keys) {
      // V1 (migration 014): an exception that changed a ledger machine's credit needs a disposition, not an explanation
      const eventId = /^(?:machine_event|ticket_event):(.+)$/.exec(key)?.[1];
      const x = eventId ? await one(`SELECT x.event_type, e.amount, machine_exception_needs_disposition(x.event_id) AS needs,
          EXISTS (SELECT 1 FROM machine_event_dispositions d WHERE d.event_id = x.event_id) AS done
        FROM machine_event_exceptions x JOIN machine_events e ON e.event_id = x.event_id WHERE x.event_id = $1`, [eventId]) : null;
      if (x?.needs) {
        if (x.done) continue;
        const cents = Math.round(Number(x.amount ?? 0) * 100);
        const kind = ['TITO_IN', 'TITO_OUT'].includes(x.event_type) && cents > 0 ? 'CORRECTION' : 'NO_MONEY_MOVED';
        const r = await post('manager@example.com', `/api/v1/machines/event-exceptions/${eventId}/disposition`, { kind, reason: explanation, evidenceRef: 'meters and gateway log checked', amountCents: kind === 'CORRECTION' ? cents : undefined });
        assert.equal(r.statusCode, 200, r.body);
        assert.ok((await post('accounting@example.com', `/api/v1/approvals/${r.json().id}/decide`, { decision: 'APPROVED' })).json().disposition, key);
        continue;
      }
      const r = await post('manager@example.com', '/api/v1/money/resolutions', { casinoId, itemKey: key, explanation });
      assert.ok((await post('accounting@example.com', `/api/v1/approvals/${r.json().id}/decide`, { decision: 'APPROVED' })).json().resolution, key);
    }
  }
  const newCasino = (prefix: string) => createLedgerCasino(c.pool as never, { orgId: c.orgId, code: `${prefix}${Date.now() % 100000}`, machines: 2, gateway: true });
  async function player() {
    const cardNumber = `7D-${randomUUID().slice(0, 8)}`;
    const p = await tx((db) => svc.players.createPlayer(db as never, { orgId: c.orgId, employeeId: c.emp['admin@example.com'], employeeEmail: 'admin@example.com' }, { homeCasinoId: c.casino.id, card: { cardNumber } }));
    return { id: p.player.id as string, cardNumber };
  }
  const session = async (i: number, cardNumber: string) => (await gw('/api/v1/gateway/cashless/sessions', { machineId: m(i).code, cardNumber, requestKey: randomUUID() })).json().session;
  const transfer = async (sessionId: string, direction: 'TO_MACHINE' | 'FROM_MACHINE', amountCents: number) => gw('/api/v1/gateway/cashless/transfers', { sessionId, direction, amountCents, requestKey: randomUUID() });

  describe('Step 7d: machine money and cashless on the ledger', () => {
    test('setup: every rail on the ledger, machines cut over one by one; vault open; cashier shift', async () => {
      c = get();
      svc = {
        ledger: await import('../src/services/ledger'), players: await import('../src/services/players'),
        cashless: await import('../src/services/cashless'), machine: await import('../src/services/machine-money'),
      };
      const r = await one(`SELECT money_rail_ledger($1,$2,'MACHINE',$3) m, money_rail_ledger($1,$2,'TITO',NULL) t, money_rail_ledger($1,NULL,'CASHLESS',NULL) w`, [c.orgId, c.casino.id, m(0).id]);
      assert.deepEqual([r.m, r.t, r.w], [true, true, true]);
      await ensureVaultOpen(c.pool as never, c.casino);
      st.shift = await openLedgerShift(c.pool as never, c.casino, { cashierEmail: 'cashier@example.com', floatCents: 500_000 });
    });

    test('cash in books MACHINE_CASH_IN once; a hopper payout without hopper money is a recorded exception (no HTTP 500, no money); a confirmed hopper fill makes it bookable', async () => {
      const cashIn = await event(0, 'CASH_IN', { amount: 20 });
      assert.equal(cashIn.body.accepted, 1, cashIn.res.body);
      assert.deepEqual(await txOf(cashIn.eventId), [{ type: 'MACHINE_CASH_IN', amount_cents: 2_000, d: await day(0) }]);
      assert.equal(await bal('CASHBOX', { machineId: m(0).id }), 2_000);
      assert.equal(await credit(0), 2_000);
      assert.equal((await event(0, 'CASH_IN', { amount: 20 }, { eventId: cashIn.eventId })).body.duplicates, 1);
      // hopper empty: the payout is a physical fact but cannot be booked -> exception, event kept
      const out = await event(0, 'CASH_OUT', { amount: 5 });
      assert.equal(out.res.statusCode, 200);
      assert.deepEqual([out.body.accepted, out.body.exceptions[0].code], [1, 'HTTP_409']);
      assert.match(out.body.exceptions[0].message, /Insufficient balance on HOPPER/);
      assert.equal((await q('SELECT 1 FROM machine_events WHERE event_id = $1', [out.eventId])).length, 1);
      assert.deepEqual(await txOf(out.eventId), []);
      assert.ok(await one(`SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'machine_event.rejected'`, [out.eventId]));
      assert.ok(await one(`SELECT 1 FROM alerts WHERE machine_id = $1 AND type = 'MACHINE_EVENT_REJECTED' AND severity = 'CRITICAL'`, [m(0).id]));
      assert.equal((await event(0, 'CASH_OUT', { amount: 5 }, { eventId: out.eventId })).body.duplicates, 1, 'a resend is a duplicate');
      // hopper fill: requested by the vault, a count mismatch at the machine rejects, then confirmed
      const fill = await post('manager@example.com', `/api/v1/machines/${m(0).id}/hopper-fills`, { amountCents: 10_000 });
      assert.equal(fill.statusCode, 200, fill.body);
      assert.match((await post('manager@example.com', `/api/v1/machines/hopper-fills/${fill.json().movement.id}/confirm`, { totalCents: 10_000 })).json().error, /requester cannot confirm/);
      assert.equal((await post('attendant@example.com', `/api/v1/machines/hopper-fills/${fill.json().movement.id}/confirm`, { totalCents: 9_000 })).json().movement.status, 'REJECTED');
      assert.equal(await bal('HOPPER', { machineId: m(0).id }), 0);
      const fill2 = await post('manager@example.com', `/api/v1/machines/${m(0).id}/hopper-fills`, { amountCents: 10_000 });
      assert.equal((await post('attendant@example.com', `/api/v1/machines/hopper-fills/${fill2.json().movement.id}/confirm`, { totalCents: 10_000 })).json().movement.status, 'CONFIRMED');
      assert.equal(await bal('HOPPER', { machineId: m(0).id }), 10_000);
      const out2 = await event(0, 'CASH_OUT', { amount: 5 });
      assert.deepEqual([out2.body.exceptions.length, (await txOf(out2.eventId))[0].type], [0, 'MACHINE_CASH_OUT']);
      assert.equal(await bal('HOPPER', { machineId: m(0).id }), 9_500);
      st.exceptionEvent = out.eventId;
    });

    test('duplicate / invalid machine events: deterministic business rejection, auditable, idempotent, no money', async () => {
      const code = String(Math.floor(1e17 + Math.random() * 8e17));
      const first = await event(1, 'TITO_OUT', { amount: 3, ticketBarcode: code });
      assert.equal(first.body.exceptions.length, 0);
      const dup = await event(1, 'TITO_OUT', { amount: 4, ticketBarcode: code });
      assert.deepEqual([dup.res.statusCode, dup.body.accepted, dup.body.exceptions[0].code], [200, 1, 'DUPLICATE_BARCODE']);
      assert.deepEqual(await txOf(dup.eventId), []);
      const unknown = await event(1, 'CASHLESS_IN', { amount: 4, transferId: randomUUID() });
      assert.deepEqual([unknown.res.statusCode, unknown.body.exceptions[0].code], [200, 'HTTP_409']);
      assert.match(unknown.body.exceptions[0].message, /unknown transfer/);
      const noAmount = await event(1, 'CASH_IN', {});
      assert.equal(noAmount.body.exceptions[0].code, 'NO_AMOUNT');
      for (const e of [dup.eventId, unknown.eventId, noAmount.eventId]) {
        assert.equal((await q('SELECT 1 FROM money_transactions WHERE source_event_id = $1', [e])).length, 0);
        assert.ok(await one(`SELECT 1 FROM machine_event_exceptions WHERE event_id = $1`, [e]));
        assert.equal((await event(1, 'CASH_IN', {}, { eventId: e })).body.duplicates, 1);
      }
      await assert.rejects(c.pool.query(`UPDATE machine_event_exceptions SET code = 'X' WHERE event_id = $1`, [dup.eventId]));
      // reconciliation reports every exception until explained: MACHINE per machine, TITO for the ticket
      const run = await recon();
      const items = (key: string) => run.checks.find((k: { key: string }) => k.key === key).items as string[];
      assert.ok(items('machine.events_accounted').includes(`machine_event:${unknown.eventId}`));
      assert.ok(items('machine.events_accounted').includes(`machine_event:${st.exceptionEvent}`));
      assert.ok(items('tito.machine_events_accounted').includes(`ticket_event:${dup.eventId}`));
      assert.ok(run.frozen.some((f: { rail: string }) => f.rail === 'MACHINE'));
      const machineFreezes = await q(`SELECT machine_id FROM money_rail_freezes WHERE casino_id = $1 AND rail = 'MACHINE' AND lifted_at IS NULL ORDER BY machine_id`, [c.casino.id]);
      assert.deepEqual(machineFreezes.map((f) => f.machine_id).sort(), [m(0).id, m(1).id].sort(), 'only the affected machines are frozen');
      // other machines continue
      const other = await event(2, 'CASH_IN', { amount: 1 });
      assert.equal((await txOf(other.eventId))[0].type, 'MACHINE_CASH_IN');
      // explained by four eyes -> lifted
      await explain([`machine_event:${unknown.eventId}`, `machine_event:${st.exceptionEvent}`, `machine_event:${noAmount.eventId}`, `ticket_event:${dup.eventId}`], c.casino.id, 'Investigated: no money moved, physical cash counted');
      for (const f of await q(`SELECT id FROM money_rail_freezes WHERE casino_id = $1 AND lifted_at IS NULL`, [c.casino.id]))
        assert.equal((await lift(f.id, 'explained')).json().lifted, true);
    });

    test('cashier <-> wallet: deposit and withdrawal are one immediate booking each with a linked drawer row; exactly once per key', async () => {
      const p = await player();
      st.player = p.id;
      st.card = p.cardNumber;
      const key = randomUUID();
      const d = await post('cashier@example.com', '/api/v1/cashier/wallet/deposit', { playerCard: p.cardNumber, amount: 100 }, key);
      assert.equal(d.statusCode, 200, d.body);
      assert.deepEqual((await post('cashier@example.com', '/api/v1/cashier/wallet/deposit', { playerCard: p.cardNumber, amount: 100 }, key)).json(), d.json());
      assert.deepEqual(await wallet(p.id), { a: 10_000, r: 0 });
      const row = await one(`SELECT type, amount, money_transaction_id FROM cash_transactions WHERE money_transaction_id = $1`, [d.json().moneyTransaction.id]);
      assert.deepEqual([row.type, Number(row.amount)], ['CASH_IN', 100]);
      const w = await post('cashier@example.com', '/api/v1/cashier/wallet/withdraw', { playerCard: p.cardNumber, amount: 20 });
      assert.equal(w.statusCode, 200, w.body);
      assert.deepEqual(await wallet(p.id), { a: 8_000, r: 0 });
      assert.match((await post('cashier@example.com', '/api/v1/cashier/wallet/withdraw', { playerCard: p.cardNumber, amount: 1_000 })).json().error, /Insufficient balance on WALLET_AVAILABLE/);
    });

    test('wallet cash above the limit needs a four-eyes approval bound to wallet and amount; KYC above the threshold', async () => {
      await q('UPDATE casino_money_settings SET deposit_approval_cents = 50000 WHERE casino_id = $1', [c.casino.id]);
      try {
        assert.match((await post('cashier@example.com', '/api/v1/cashier/wallet/deposit', { playerCard: st.card, amount: 600 })).json().error, /Supervisor approval required/);
        const req = await post('cashier@example.com', '/api/v1/cashier/wallet/approval-request', { playerCard: st.card, amount: 600, kind: 'CASH_DEPOSIT' });
        assert.equal(req.statusCode, 200, req.body);
        assert.equal((await post('cashier@example.com', `/api/v1/approvals/${req.json().id}/decide`, { decision: 'APPROVED' })).statusCode, 403);
        await post('manager@example.com', `/api/v1/approvals/${req.json().id}/decide`, { decision: 'APPROVED' });
        assert.match((await post('cashier@example.com', '/api/v1/cashier/wallet/deposit', { playerCard: st.card, amount: 700 })).json().error, /Supervisor approval required/, 'bound to the amount');
        assert.equal((await post('cashier@example.com', '/api/v1/cashier/wallet/deposit', { playerCard: st.card, amount: 600 })).statusCode, 200);
        assert.match((await post('cashier@example.com', '/api/v1/cashier/wallet/deposit', { playerCard: st.card, amount: 600 })).json().error, /Supervisor approval required/, 'used once');
        await q('UPDATE organizations SET verification_threshold_cents = 1000 WHERE id = $1', [c.orgId]);
        assert.match((await post('cashier@example.com', '/api/v1/cashier/wallet/deposit', { playerCard: st.card, amount: 20 })).json().error, /not verified/);
      } finally {
        await q('UPDATE casino_money_settings SET deposit_approval_cents = NULL WHERE casino_id = $1', [c.casino.id]);
        await q('UPDATE organizations SET verification_threshold_cents = NULL WHERE id = $1', [c.orgId]);
      }
    });

    test('wallet -> machine: request reserves only; the machine ack (CASHLESS_IN) moves it; machine -> wallet with the released amount; acks exactly once', async () => {
      const s = await session(3, st.card);
      assert.ok(s?.id, 'session opened');
      const before = await wallet(st.player);
      const t = (await transfer(s.id, 'TO_MACHINE', 3_000)).json().transfer;
      assert.equal(t.status, 'REQUESTED');
      assert.deepEqual(await wallet(st.player), { a: before.a - 3_000, r: 3_000 });
      assert.equal(await credit(3), 0, 'a reservation is not on the machine');
      const ack = await event(3, 'CASHLESS_IN', { amount: 30, transferId: t.id });
      assert.equal(ack.body.exceptions.length, 0, ack.res.body);
      assert.deepEqual((await txOf(ack.eventId)).map((x) => x.type), ['WALLET_TO_MACHINE_CONFIRM']);
      assert.deepEqual(await wallet(st.player), { a: before.a - 3_000, r: 0 });
      assert.equal(await credit(3), 3_000);
      assert.equal((await one('SELECT status FROM wallet_transfers WHERE id = $1', [t.id])).status, 'CONFIRMED');
      // a second ack (other event id) is rejected as an exception, nothing moves twice
      const again = await event(3, 'CASHLESS_IN', { amount: 30, transferId: t.id });
      assert.match(again.body.exceptions[0].message, /already confirmed/);
      await explain([`machine_event:${again.eventId}`]);
      // machine -> wallet: the machine released 8 of 10 requested
      const back = (await transfer(s.id, 'FROM_MACHINE', 1_000)).json().transfer;
      await gw(`/api/v1/gateway/cashless/transfers/${back.id}/sent`, {});
      const out = await event(3, 'CASHLESS_OUT', { amount: 8, transferId: back.id });
      assert.deepEqual(await txOf(out.eventId), [{ type: 'MACHINE_TO_WALLET', amount_cents: 800, d: await day(0) }]);
      assert.deepEqual(await wallet(st.player), { a: before.a - 2_200, r: 0 });
      assert.equal(await credit(3), 2_200);
      assert.equal((await gw(`/api/v1/gateway/cashless/sessions/${s.id}/close`, {})).json().status, 'CLOSED');
    });

    test('late confirmation after FAILED / EXPIRED: LATE_CONFIRMED from CASHLESS_EXCEPTION, the wallet is not charged twice, alerted', async () => {
      const s = await session(4, st.card);
      const before = await wallet(st.player);
      const failed = (await transfer(s.id, 'TO_MACHINE', 1_500)).json().transfer;
      assert.equal((await gw(`/api/v1/gateway/cashless/transfers/${failed.id}/fail`, { reason: 'machine busy' })).json().status, 'FAILED');
      assert.deepEqual(await wallet(st.player), before, 'released');
      const late = await event(4, 'CASHLESS_IN', { amount: 15, transferId: failed.id });
      assert.equal(late.body.exceptions.length, 0, late.res.body);
      assert.deepEqual((await txOf(late.eventId)).map((x) => x.type), ['WALLET_TO_MACHINE_LATE_CONFIRM']);
      assert.equal((await one('SELECT status FROM wallet_transfers WHERE id = $1', [failed.id])).status, 'LATE_CONFIRMED');
      assert.deepEqual(await wallet(st.player), before, 'the wallet is not charged again');
      assert.equal(await credit(4), 1_500);
      assert.ok(await one(`SELECT 1 FROM alerts WHERE casino_id = $1 AND type = 'CASHLESS_LATE_CONFIRM'`, [c.casino.id]));
      // expiry by the job, then a late ack
      const expiring = (await transfer(s.id, 'TO_MACHINE', 500)).json().transfer;
      await q(`UPDATE wallet_transfers SET expires_at = now() - interval '1 minute' WHERE id = $1`, [expiring.id]);
      await tx((db) => svc.cashless.expireStaleTransfers(db as never));
      assert.equal((await one('SELECT status FROM wallet_transfers WHERE id = $1', [expiring.id])).status, 'EXPIRED');
      const late2 = await event(4, 'CASHLESS_IN', { amount: 5, transferId: expiring.id });
      assert.deepEqual((await txOf(late2.eventId)).map((x) => x.type), ['WALLET_TO_MACHINE_LATE_CONFIRM']);
      await gw(`/api/v1/gateway/cashless/sessions/${s.id}/close`, {});
    });

    test('concurrency: parallel acks of one transfer confirm it once; parallel transfer requests on one machine keep one active', async () => {
      const s = await session(5, st.card);
      const t = (await transfer(s.id, 'TO_MACHINE', 700)).json().transfer;
      const acks = await Promise.all(Array.from({ length: 4 }, () => event(5, 'CASHLESS_IN', { amount: 7, transferId: t.id })));
      assert.equal(acks.filter((a) => a.body.exceptions.length === 0).length, 1);
      await explain(acks.filter((a) => a.body.exceptions.length).map((a) => `machine_event:${a.eventId}`));
      assert.equal((await q(`SELECT 1 FROM money_transactions WHERE transfer_id = $1 AND type = 'WALLET_TO_MACHINE_CONFIRM'`, [t.id])).length, 1);
      const reqs = await Promise.all(Array.from({ length: 4 }, () => transfer(s.id, 'TO_MACHINE', 100)));
      assert.equal(reqs.filter((r) => r.statusCode === 200).length, 1);
      assert.ok(reqs.filter((r) => r.statusCode !== 200).every((r) => r.statusCode === 409), 'a business refusal, never a 500');
      const active = reqs.find((r) => r.statusCode === 200)!.json().transfer;
      await gw(`/api/v1/gateway/cashless/transfers/${active.id}/fail`, { reason: 'test' });
      await gw(`/api/v1/gateway/cashless/sessions/${s.id}/close`, {});
    });

    test('machine collection: blind count, blind second count by another employee; difference and drop booked; nothing on a mismatch', async () => {
      await event(6, 'CASH_IN', { amount: 50 });
      const vaultBefore = await bal('VAULT', { vaultId: c.casino.vault });
      const count = await post('manager@example.com', `/api/v1/machines/${m(6).id}/collections/count`, { totalCents: 4_900 });
      assert.equal(count.statusCode, 200, count.body);
      assert.match((await post('manager@example.com', `/api/v1/machines/collections/counts/${count.json().id}/verify`, { totalCents: 4_900 })).json().error, /different employee/);
      const mismatch = await post('admin@example.com', `/api/v1/machines/collections/counts/${count.json().id}/verify`, { totalCents: 4_800 });
      assert.equal(mismatch.json().matches, false);
      assert.equal(await bal('CASHBOX', { machineId: m(6).id }), 5_000, 'a mismatch books nothing');
      const recount = await post('manager@example.com', `/api/v1/machines/${m(6).id}/collections/count`, { totalCents: 4_900 });
      const ok = await post('accounting@example.com', `/api/v1/machines/collections/counts/${recount.json().id}/verify`, { totalCents: 4_900 });
      assert.equal(ok.json().matches, true, ok.body);
      assert.equal(await bal('CASHBOX', { machineId: m(6).id }), 0);
      assert.equal(await bal('VAULT', { vaultId: c.casino.vault }), vaultBefore + 4_900);
      assert.equal(await bal('DROP_SHORT_OVER'), -(-100), 'short 100 cents booked as drop difference');
      const coll = await one('SELECT counted_cash, expected_cash, difference, money_transaction_id FROM cash_collections WHERE count_id = $1', [recount.json().id]);
      assert.deepEqual([Number(coll.counted_cash), Number(coll.expected_cash), Number(coll.difference), !!coll.money_transaction_id], [49, 50, -1, true]);
      // legacy collection route is refused for a ledger machine; cash after the count needs a recount
      assert.match((await post('manager@example.com', '/api/v1/cash/collections', { machineId: m(6).id, countedCash: 1, countedTickets: 0 })).json().error, /on the ledger/);
      const late = await post('manager@example.com', `/api/v1/machines/${m(6).id}/collections/count`, { totalCents: 0 });
      await event(6, 'CASH_IN', { amount: 1 });
      assert.match((await post('admin@example.com', `/api/v1/machines/collections/counts/${late.json().id}/verify`, { totalCents: 0 })).json().error, /accepted cash after the count/);
    });

    test('D3 gaming settlement: at a zero-credit state or with a reliable meter only; never estimated; stale meters are not settled', async () => {
      const result = () => bal('GAMING_RESULT');
      await event(7, 'CASH_IN', { amount: 12 });
      const r0 = await result();
      // unreliable meter, non-zero report: unreconciled, nothing booked
      const skip = await event(7, 'CREDIT_METER', { creditCents: 700 });
      assert.deepEqual(await txOf(skip.eventId), []);
      assert.ok(await one(`SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'machine.settlement_skipped'`, [skip.eventId]));
      // zero-credit state: the whole machine credit is the gaming result
      const zero = await event(7, 'CREDIT_METER', { creditCents: 0 });
      assert.deepEqual((await txOf(zero.eventId)).map((x) => [x.type, x.amount_cents]), [['GAMING_SETTLEMENT', 1_200]]);
      assert.equal(await credit(7), 0);
      assert.equal(await result(), r0 + 1_200);
      // reliable meter: settles the difference (players won 3)
      await q('UPDATE machines SET credit_meter_reliable = true WHERE id = $1', [m(7).id]);
      await event(7, 'CASH_IN', { amount: 10 });
      const won = await event(7, 'CREDIT_METER', { creditCents: 1_300 });
      assert.deepEqual((await txOf(won.eventId)).map((x) => [x.type, x.amount_cents]), [['GAMING_SETTLEMENT', -300]]);
      assert.equal(await credit(7), 1_300);
      // a meter older than a booked money event is not settled
      const stale = await event(7, 'CREDIT_METER', { creditCents: 0 }, { at: new Date(Date.now() - 60_000) });
      assert.deepEqual(await txOf(stale.eventId), []);
    });

    test('frozen machine: its money and ticket events are deferred (other machines continue), transfers refused; the lift replays exactly once', async () => {
      const x = await newCasino('7DF');
      const freezeId = (await one(`INSERT INTO money_rail_freezes (org_id, rail, casino_id, machine_id, reason) VALUES ($1,'MACHINE',$2,$3,'test freeze') RETURNING id`, [c.orgId, x.id, m(0, x).id])).id;
      const cashIn = await event(0, 'CASH_IN', { amount: 9 }, { casino: x });
      const ticket = await event(0, 'TITO_OUT', { amount: 2, ticketBarcode: String(Math.floor(1e17 + Math.random() * 8e17)) }, { casino: x });
      for (const e of [cashIn, ticket]) {
        assert.deepEqual([e.body.accepted, e.body.exceptions.length], [1, 0], e.res.body);
        assert.equal((await one('SELECT status, reason FROM deferred_money_events WHERE event_id = $1', [e.eventId])).status, 'PENDING');
        assert.deepEqual(await txOf(e.eventId), []);
      }
      const other = await event(1, 'CASH_IN', { amount: 4 }, { casino: x });
      assert.equal((await txOf(other.eventId))[0].type, 'MACHINE_CASH_IN', 'the other machine continues');
      await assert.rejects(tx((db) => svc.ledger.executeMoneyTransaction(db, { orgId: c.orgId, type: 'MACHINE_CASH_IN', dedupeKey: `f-${randomUUID()}`, actor: { type: 'SYSTEM' },
        ctx: { casinoId: x.id, machineId: m(0, x).id, amountCents: cents(100) } })), /MACHINE is frozen/, 'no booking on the frozen machine, even directly');
      const l = await lift(freezeId);
      assert.equal(l.json().lifted, true, l.body);
      assert.deepEqual(l.json().replayedMachine.map((r: { eventId: string }) => r.eventId), [cashIn.eventId]);
      assert.deepEqual(l.json().replayedTickets.map((r: { eventId: string }) => r.eventId), [ticket.eventId]);
      assert.deepEqual((await txOf(cashIn.eventId)).map((t) => t.type), ['MACHINE_CASH_IN']);
      assert.deepEqual((await txOf(ticket.eventId)).map((t) => t.type), ['TITO_ISSUE_MACHINE']);
      assert.deepEqual(await tx((db) => svc.machine.replayDeferredMachine(db as never)), []);
      assert.equal((await event(0, 'CASH_IN', { amount: 9 }, { eventId: cashIn.eventId, casino: x })).body.duplicates, 1);
      const run = await recon(x.id);
      assert.equal(run.ok, true, JSON.stringify(run.checks.filter((k: { ok: boolean }) => !k.ok)));
    });

    test('business date: a late machine event is booked on its occurred day; a closed day needs the four-eyes late-event booking (never moved silently)', async () => {
      const x = await newCasino('7DL');
      const yesterday = await day(-1, x.id);
      const late = await event(0, 'CASH_IN', { amount: 6 }, { casino: x, at: new Date(Date.now() - 24 * 3600_000) });
      assert.deepEqual(await txOf(late.eventId), [{ type: 'MACHINE_CASH_IN', amount_cents: 600, d: yesterday }]);
      // closed day
      const closedDay = await day(-3, x.id);
      const runId = (await one(`INSERT INTO reconciliation_runs (org_id, casino_id, trigger, ok, checks) VALUES ($1,$2,'MANUAL',true,'[]') RETURNING id`, [c.orgId, x.id])).id;
      await q(`INSERT INTO business_day_closes (casino_id, business_date, org_id, closed_by, reconciliation_run_id) VALUES ($1,$2,$3,$4,$5)`, [x.id, closedDay, c.orgId, c.emp['manager@example.com'], runId]);
      const old = await event(0, 'CASH_IN', { amount: 7 }, { casino: x, at: new Date(Date.now() - 72 * 3600_000) });
      const d = await one(`SELECT status, business_date::text AS bd, last_error FROM deferred_money_events WHERE event_id = $1`, [old.eventId]);
      assert.deepEqual([d.status, d.bd], ['PENDING', closedDay]);
      assert.match(d.last_error, /Business date .* is closed/);
      assert.deepEqual(await txOf(old.eventId), []);
      // the open date of a normal event cannot be booked late; the closed one only by two people
      assert.match((await post('floor@example.com', `/api/v1/money/deferred/${late.eventId}/late-booking`, { reason: 'test reason long enough' })).json().error, /already processed/);
      const req = await post('floor@example.com', `/api/v1/money/deferred/${old.eventId}/late-booking`, { reason: 'Gateway offline for three days, day already closed' });
      assert.equal(req.statusCode, 200, req.body);
      assert.match((await post('floor@example.com', `/api/v1/approvals/${req.json().id}/decide`, { decision: 'APPROVED' })).json().error, /requester cannot approve/);
      const ok = await post('accounting@example.com', `/api/v1/approvals/${req.json().id}/decide`, { decision: 'APPROVED' });
      assert.equal(ok.statusCode, 200, ok.body);
      const today = await day(0, x.id);
      assert.deepEqual(ok.json().booking.originalBusinessDate, closedDay);
      assert.deepEqual(await txOf(old.eventId), [{ type: 'MACHINE_CASH_IN', amount_cents: 700, d: today }]);
      const after = await one(`SELECT status, business_date::text AS bd, booked_business_date::text AS booked, late_approval_id FROM deferred_money_events WHERE event_id = $1`, [old.eventId]);
      assert.deepEqual([after.status, after.bd, after.booked, after.late_approval_id], ['PROCESSED', closedDay, today, req.json().id]);
      assert.ok(await one(`SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'money.late_event_booked'`, [old.eventId]));
      assert.equal((await one('SELECT status FROM approvals WHERE id = $1', [req.json().id])).status, 'EXECUTED');
      const run = await recon(x.id);
      assert.equal(run.ok, true, JSON.stringify(run.checks.filter((k: { ok: boolean }) => !k.ok)));
    });

    test('late event A / B / C: occurred on closed day A, received on day B, posted on open day C only through the approved late-event booking', async () => {
      const x = await newCasino('7DA');
      const [dayA, dayB, dayC] = [await day(-3, x.id), await day(-1, x.id), await day(0, x.id)];
      const runId = (await one(`INSERT INTO reconciliation_runs (org_id, casino_id, trigger, ok, checks) VALUES ($1,$2,'MANUAL',true,'[]') RETURNING id`, [c.orgId, x.id])).id;
      await q(`INSERT INTO business_day_closes (casino_id, business_date, org_id, closed_by, reconciliation_run_id) VALUES ($1,$2,$3,$4,$5)`, [x.id, dayA, c.orgId, c.emp['manager@example.com'], runId]);
      // received on day B (yesterday): the ingestion stored the event with its deferred record (day A closed, not booked)
      const eventId = randomUUID();
      await tx(async (db) => {
        await db.query(`INSERT INTO machine_events (event_id, org_id, casino_id, machine_id, type, amount, occurred_at, received_at) VALUES ($1,$2,$3,$4,'CASH_IN',7,now() - interval '72 hours', now() - interval '24 hours')`,
          [eventId, c.orgId, x.id, m(0, x).id]);
        await db.query(`INSERT INTO deferred_money_events (event_id, org_id, casino_id, machine_id, rail, kind, amount_cents, reason) VALUES ($1,$2,$3,$4,'MACHINE','CASH_IN',700,'LATE_EVENT')`, [eventId, c.orgId, x.id, m(0, x).id]);
      });
      await tx((db) => svc.machine.replayDeferredMachine(db as never, { eventId }));
      const original = await one(`SELECT to_jsonb(e) AS j FROM machine_events e WHERE event_id = $1`, [eventId]);
      const dates = await one(`SELECT (occurred_at AT TIME ZONE 'UTC')::text AS o, (received_at AT TIME ZONE 'UTC')::text AS r, business_date::text AS bd, last_error FROM deferred_money_events WHERE event_id = $1`, [eventId]);
      assert.equal(dates.bd, dayA);
      assert.match(dates.last_error, /Business date .* is closed/);
      assert.deepEqual(await txOf(eventId), [], 'no money before approval');
      // a late posting cannot be forced around the approval
      await assert.rejects(tx((db) => svc.ledger.executeMoneyTransaction(db, {
        orgId: c.orgId, type: 'MACHINE_CASH_IN', dedupeKey: `late-${randomUUID()}`, sourceEventId: eventId, actor: { type: 'SYSTEM' }, ctx: { casinoId: x.id, machineId: m(0, x).id, amountCents: cents(700) },
        latePosting: { approvalId: randomUUID(), originalBusinessDate: dayA, occurredAt: 'x', receivedAt: 'x', reason: 'forced', requestedBy: c.emp['floor@example.com'], approvedBy: c.emp['accounting@example.com'] },
      })), /approved four-eyes late-event booking/);
      // unauthorized request / decision, one-person approval, a rejection: nothing moves
      assert.equal((await post('cashier@example.com', `/api/v1/money/deferred/${eventId}/late-booking`, { reason: 'cashier may not request this' })).statusCode, 403);
      const r1 = await post('floor@example.com', `/api/v1/money/deferred/${eventId}/late-booking`, { reason: 'Gateway offline, day A already closed' });
      assert.equal(r1.statusCode, 200, r1.body);
      assert.equal((await post('cashier@example.com', `/api/v1/approvals/${r1.json().id}/decide`, { decision: 'APPROVED' })).statusCode, 403);
      assert.match((await post('floor@example.com', `/api/v1/approvals/${r1.json().id}/decide`, { decision: 'APPROVED' })).json().error, /requester cannot approve/);
      assert.equal((await post('manager@example.com', `/api/v1/approvals/${r1.json().id}/decide`, { decision: 'REJECTED' })).json().booking, null);
      assert.deepEqual(await txOf(eventId), []);
      assert.equal((await one('SELECT status FROM deferred_money_events WHERE event_id = $1', [eventId])).status, 'PENDING');
      // approved by a second person: posted on C, explicitly as a late event of A
      const r2 = await post('floor@example.com', `/api/v1/money/deferred/${eventId}/late-booking`, { reason: 'Gateway offline, day A already closed' });
      const ok = await post('accounting@example.com', `/api/v1/approvals/${r2.json().id}/decide`, { decision: 'APPROVED' });
      assert.equal(ok.statusCode, 200, ok.body);
      const mt = await one(`SELECT id, type, amount_cents, business_date::text AS d, source_event_id, actor_type, actor_id, approved_by, reason, options FROM money_transactions WHERE source_event_id = $1`, [eventId]);
      assert.deepEqual([mt.type, mt.amount_cents, mt.d, mt.source_event_id], ['MACHINE_CASH_IN', 700, dayC, eventId], 'posted on C');
      assert.deepEqual([mt.actor_type, mt.actor_id, mt.approved_by], ['EMPLOYEE', c.emp['floor@example.com'], c.emp['accounting@example.com']], 'both people on the posting');
      assert.match(mt.reason, new RegExp(`Late event ${eventId}: occurred .* on closed business date ${dayA}, received .*approved late posting \\(Gateway offline`));
      assert.deepEqual([mt.options.lateEvent.originalBusinessDate, mt.options.lateEvent.approvalId, mt.options.lateEvent.requestedBy, mt.options.lateEvent.approvedBy, mt.options.lateEvent.sourceEventId],
        [dayA, r2.json().id, c.emp['floor@example.com'], c.emp['accounting@example.com'], eventId]);
      assert.equal(new Date(mt.options.lateEvent.occurredAt).toISOString().slice(0, 10) <= dayB, true);
      // the original event and its dates are untouched; the deferred record keeps A and records C
      assert.deepEqual((await one(`SELECT to_jsonb(e) AS j FROM machine_events e WHERE event_id = $1`, [eventId])).j, original.j);
      await assert.rejects(c.pool.query(`UPDATE machine_events SET occurred_at = now() WHERE event_id = $1`, [eventId]));
      const d = await one(`SELECT status, business_date::text AS bd, booked_business_date::text AS booked, (occurred_at AT TIME ZONE 'UTC')::text AS o, (received_at AT TIME ZONE 'UTC')::text AS r, replayed_at IS NOT NULL AS replayed, late_approval_id FROM deferred_money_events WHERE event_id = $1`, [eventId]);
      assert.deepEqual([d.status, d.bd, d.booked, d.o, d.r, d.replayed, d.late_approval_id], ['PROCESSED', dayA, dayC, dates.o, dates.r, true, r2.json().id]);
      await assert.rejects(c.pool.query(`UPDATE deferred_money_events SET business_date = $2 WHERE event_id = $1`, [eventId, dayC]));
      // audit names it a late event with both people; reconciliation sees economic date A and posting date C
      const audit = await one(`SELECT actor_id, details FROM audit_logs WHERE entity_id = $1 AND action = 'money.late_event_booked'`, [eventId]);
      assert.deepEqual([audit.actor_id, audit.details.requestedBy, audit.details.originalBusinessDate, audit.details.bookedBusinessDate], [c.emp['accounting@example.com'], c.emp['floor@example.com'], dayA, dayC]);
      assert.deepEqual(await one(`SELECT d.business_date::text AS economic, t.business_date::text AS posted FROM deferred_money_events d JOIN money_transactions t ON t.id = d.money_transaction_id WHERE d.event_id = $1`, [eventId]), { economic: dayA, posted: dayC });
      const run = await recon(x.id);
      assert.equal(run.ok, true, JSON.stringify(run.checks.filter((k: { ok: boolean }) => !k.ok)));
      // the approval is used once
      assert.equal((await one('SELECT status FROM approvals WHERE id = $1', [r2.json().id])).status, 'EXECUTED');
      assert.match((await post('floor@example.com', `/api/v1/money/deferred/${eventId}/late-booking`, { reason: 'again, should be refused' })).json().error, /already processed/);
    });

    test('credit meter from the future (machine clock ahead): no settlement, durable recorded exception, only this machine frozen until explained', async () => {
      const x = await newCasino('7DC');
      await event(0, 'CASH_IN', { amount: 5 }, { casino: x });
      const future = await event(0, 'CREDIT_METER', { creditCents: 0 }, { casino: x, at: new Date(Date.now() + 2 * 24 * 3600_000) });
      assert.deepEqual([future.res.statusCode, future.body.accepted, future.body.exceptions[0]?.code], [200, 1, 'CLOCK_AHEAD']);
      assert.deepEqual(await txOf(future.eventId), [], 'no settlement booked');
      assert.equal((await q('SELECT 1 FROM machine_events WHERE event_id = $1', [future.eventId])).length, 1);
      assert.ok(await one(`SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'machine_event.rejected'`, [future.eventId]));
      assert.equal(await bal('MACHINE_CREDIT', { machineId: m(0, x).id }, x.id), 500, 'machine credit stays unsettled');
      const run = await recon(x.id);
      assert.deepEqual(run.checks.find((k: { key: string }) => k.key === 'machine.events_accounted').items, [`machine_event:${future.eventId}`]);
      assert.deepEqual((await q(`SELECT machine_id FROM money_rail_freezes WHERE casino_id = $1 AND lifted_at IS NULL`, [x.id])).map((f) => f.machine_id), [m(0, x).id]);
      const other = await event(1, 'CASH_IN', { amount: 2 }, { casino: x });
      assert.equal((await txOf(other.eventId))[0].type, 'MACHINE_CASH_IN', 'other machines continue');
      await explain([`machine_event:${future.eventId}`], x.id);
      assert.equal((await lift(run.frozen[0].id, 'clock fixed')).json().lifted, true);
      // the next valid meter settles the full machine credit: nothing was lost by not replaying the stale report
      const valid = await event(0, 'CREDIT_METER', { creditCents: 0 }, { casino: x });
      assert.deepEqual((await txOf(valid.eventId)).map((t) => [t.type, t.amount_cents]), [['GAMING_SETTLEMENT', 500]]);
      assert.equal((await event(0, 'CREDIT_METER', { creditCents: 0 }, { casino: x, eventId: future.eventId })).body.duplicates, 1);
    });

    test('reconciliation: MACHINE and CASHLESS checks clean; a reservation mismatch freezes only CASHLESS', async () => {
      let run = await recon();
      assert.equal(run.ok, true, JSON.stringify(run.checks.filter((k: { ok: boolean }) => !k.ok)));
      assert.deepEqual(run.checks.filter((k: { rail: string }) => k.rail === 'MACHINE' || k.rail === 'CASHLESS').map((k: { key: string }) => k.key).sort(), [
        'cashless.reserved_matches_active_transfers', 'cashless.transfers_booked', 'machine.collections_booked', 'machine.deferred_business_date',
        'machine.events_accounted', 'machine.ledger_matches_meters', 'machine.no_stale_deferred_events', // + Step 7e: ledger <-> meters
      ]);
      // a legitimate transfer in flight (another player, another machine)
      const p2 = await player();
      await post('cashier@example.com', '/api/v1/cashier/wallet/deposit', { playerCard: p2.cardNumber, amount: 50 });
      const s2 = await session(1, p2.cardNumber);
      const legit = (await transfer(s2.id, 'TO_MACHINE', 500)).json().transfer;
      // an active transfer row without its reservation booking (written around the service): CASHLESS mismatch
      const s = await session(2, st.card);
      const t = (await one(
        `INSERT INTO wallet_transfers (org_id, casino_id, wallet_id, player_id, card_id, machine_id, cashless_session_id, direction, amount_cents, request_key, expires_at)
         SELECT org_id, casino_id, wallet_id, player_id, card_id, machine_id, id, 'TO_MACHINE', 100, $2, now() + interval '1 hour' FROM cashless_sessions WHERE id = $1 RETURNING id`, [s.id, randomUUID()])).id;
      run = await recon();
      assert.deepEqual(run.frozen.map((f: { rail: string }) => f.rail), ['CASHLESS']);
      assert.match((await post('cashier@example.com', '/api/v1/cashier/wallet/deposit', { playerCard: st.card, amount: 1 })).json().error, /CASHLESS is frozen/);
      assert.equal((await txOf((await event(2, 'CASH_IN', { amount: 1 })).eventId))[0].type, 'MACHINE_CASH_IN', 'machine cash continues');
      // the machine's ack of the legitimate transfer is kept and deferred while CASHLESS is frozen (no booking)
      const ack = await event(1, 'CASHLESS_IN', { amount: 5, transferId: legit.id });
      assert.deepEqual([ack.body.accepted, ack.body.exceptions.length], [1, 0]);
      assert.deepEqual(await txOf(ack.eventId), []);
      assert.equal((await one('SELECT status, reason FROM deferred_money_events WHERE event_id = $1', [ack.eventId])).status, 'PENDING');
      const walletId = (await one('SELECT id FROM wallets WHERE player_id = $1', [st.player])).id;
      await assert.rejects(tx((db) => svc.ledger.executeMoneyTransaction(db, { orgId: c.orgId, type: 'CASH_DEPOSIT', dedupeKey: `f-${randomUUID()}`, actor: { type: 'SYSTEM' },
        ctx: { casinoId: c.casino.id, amountCents: cents(100), playerId: st.player, walletId, cashierSessionId: st.shift } })), /CASHLESS is frozen/);
      await q(`UPDATE wallet_transfers SET status = 'FAILED', failure_reason = 'test' WHERE id = $1`, [t]);
      const l = await lift(run.frozen[0].id, 'corrected');
      assert.equal(l.json().lifted, true, l.body);
      assert.deepEqual(l.json().replayedMachine.map((r: { eventId: string }) => r.eventId), [ack.eventId]);
      assert.deepEqual((await txOf(ack.eventId)).map((x) => x.type), ['WALLET_TO_MACHINE_CONFIRM']);
      assert.equal((await event(1, 'CASHLESS_IN', { amount: 5, transferId: legit.id }, { eventId: ack.eventId })).body.duplicates, 1);
      await gw(`/api/v1/gateway/cashless/sessions/${s.id}/close`, {});
      await gw(`/api/v1/gateway/cashless/sessions/${s2.id}/close`, {});
    });

    test('guards: a legacy machine takes no transfer and no machine money; ingest of an unknown machine is still rejected', async () => {
      const x = await createLedgerCasino(c.pool as never, { orgId: c.orgId, code: `7DG${Date.now() % 100000}`, rails: ['VAULT', 'CASH', 'HANDPAY', 'TITO'], machines: 1, gateway: true });
      const s = (await gwOf(x)('/api/v1/gateway/cashless/sessions', { machineId: m(0, x).code, cardNumber: st.card, requestKey: randomUUID() })).json().session;
      const r = await gwOf(x)('/api/v1/gateway/cashless/transfers', { sessionId: s.id, direction: 'TO_MACHINE', amountCents: 100, requestKey: randomUUID() });
      assert.equal(r.statusCode, 409);
      assert.match(r.json().error, /MACHINE money is not on the ledger/);
      const legacyCash = await event(0, 'CASH_IN', { amount: 3 }, { casino: x });
      assert.deepEqual([legacyCash.body.accepted, legacyCash.body.exceptions.length], [1, 0]);
      assert.deepEqual(await txOf(legacyCash.eventId), [], 'legacy machine cash stays legacy');
      await gwOf(x)(`/api/v1/gateway/cashless/sessions/${s.id}/close`, {});
      const unknown = await gwOf(x)('/api/v1/gateway/events', { events: [{ eventId: randomUUID(), type: 'CASH_IN', machineId: 'NO-SUCH', timestamp: new Date().toISOString(), amount: 1 }] });
      assert.equal(unknown.json().rejected.length, 1);
      // a direct ledger booking on a legacy machine is refused by the rail guard
      await assert.rejects(tx((db) => svc.ledger.executeMoneyTransaction(db, { orgId: c.orgId, type: 'MACHINE_CASH_IN', dedupeKey: `g-${randomUUID()}`, actor: { type: 'SYSTEM' }, ctx: { casinoId: x.id, machineId: m(0, x).id, amountCents: cents(100) } })), /MACHINE money is not on the ledger/);
    });

    test('end state: ledger invariants hold; reconciliation clean', async () => {
      assert.equal((await svc.ledger.checkLedgerInvariants(c.pool as never, c.orgId)).ok, true);
      const run = await recon();
      assert.equal(run.ok, true, JSON.stringify(run.checks.filter((k: { ok: boolean }) => !k.ok)));
    });
  });
}
