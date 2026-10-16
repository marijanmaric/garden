import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { cents } from '@m1/shared';
import { createCasinoShell, createLedgerCasino, cutoverCasinoRails, ensureVaultOpen, openLedgerShift, type LedgerCasino } from './ledger-casino';

/**
 * Step 7c scenarios: TITO on the ledger. The same scenarios run on a fresh seeded database and on a
 * realistic upgraded one. The casino's VAULT, CASH, HANDPAY and TITO rails were cut over through the
 * real mechanism; its machines stay LEGACY (D1: LEGACY_FLOOR_CLEARING). Machine tickets arrive through
 * the gateway API (hold -> TITO_IN with the hold id = accept ack), cashier operations through HTTP.
 */
export interface Ctx7c {
  app: FastifyInstance;
  pool: Pool;
  orgId: string;
  casino: LedgerCasino;
  emp: Record<string, string>;
  tokens: Record<string, string>;
}

export function registerStep7cScenarios(get: () => Ctx7c) {
  let c: Ctx7c;
  let svc: {
    ledger: typeof import('../src/services/ledger');
    tito: typeof import('../src/services/tito');
    holds: typeof import('../src/services/ticket-holds');
    players: typeof import('../src/services/players');
    cutover: typeof import('../src/services/cutover');
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
  const bal = (ref: Record<string, unknown>, casinoId = c.casino.id) => svc.ledger.getBalance(c.pool as never, c.orgId, { casinoId, ...ref } as never);
  const liability = (casinoId = c.casino.id) => bal({ kind: 'TICKET_LIABILITY' }, casinoId);
  const clearing = (machineId: string, casinoId = c.casino.id) => bal({ kind: 'LEGACY_FLOOR_CLEARING', machineId }, casinoId);
  const outstanding = async (casinoId = c.casino.id) => Number((await one(`SELECT COALESCE(sum(amount_cents), 0) s FROM tickets WHERE casino_id = $1 AND status IN ('VALID', 'HELD')`, [casinoId])).s);

  const gwOf = (casino: LedgerCasino) => (url: string, payload: unknown) =>
    c.app.inject({ method: 'POST', url, payload: payload as object, headers: { 'x-gateway-id': casino.gateway!.deviceId, 'x-gateway-key': casino.gateway!.key } });
  const gw = (url: string, payload: unknown) => gwOf(c.casino)(url, payload);
  const barcode = () => String(Math.floor(1e17 + Math.random() * 8e17));
  const m = (i: number, casino: LedgerCasino = c.casino) => casino.machines[i];

  async function printed(i: number, amount: number, opts: { code?: string; eventId?: string; at?: Date; casino?: LedgerCasino } = {}) {
    const casino = opts.casino ?? c.casino;
    const code = opts.code ?? barcode();
    const eventId = opts.eventId ?? randomUUID();
    const res = await gwOf(casino)('/api/v1/gateway/events', { events: [{ eventId, type: 'TITO_OUT', machineId: m(i, casino).code, timestamp: (opts.at ?? new Date()).toISOString(), amount, ticketBarcode: code }] });
    return { res, code, eventId };
  }
  async function accepted(i: number, code: string, opts: { holdId?: string; amount?: number; eventId?: string; casino?: LedgerCasino; at?: Date } = {}) {
    const casino = opts.casino ?? c.casino;
    const eventId = opts.eventId ?? randomUUID();
    const res = await gwOf(casino)('/api/v1/gateway/events', {
      events: [{ eventId, type: 'TITO_IN', machineId: m(i, casino).code, timestamp: (opts.at ?? new Date()).toISOString(), ticketBarcode: code, ...(opts.amount !== undefined ? { amount: opts.amount } : {}), ...(opts.holdId ? { holdId: opts.holdId } : {}) }],
    });
    return { res, eventId };
  }
  const hold = async (i: number, code: string, casino: LedgerCasino = c.casino) => (await gwOf(casino)('/api/v1/gateway/tickets/hold', { machineId: m(i, casino).code, barcode: code })).json();
  const ticket = (code: string) => one('SELECT * FROM tickets WHERE barcode = $1', [code]);
  const txsOf = async (ticketId: string) => (await q('SELECT type FROM money_transactions WHERE ticket_id = $1 ORDER BY created_at, id', [ticketId])).map((r) => r.type);
  const entries = async (txId: string) => (await q(
    `SELECT a.kind, e.amount_cents FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.transaction_id = $1 ORDER BY e.amount_cents DESC`, [txId]))
    .map((r) => `${r.kind}${Number(r.amount_cents) > 0 ? '+' : ''}${r.amount_cents}`);
  const alert = (casinoId: string, type: string) => one(`SELECT severity, message FROM alerts WHERE casino_id = $1 AND type = $2 ORDER BY created_at DESC LIMIT 1`, [casinoId, type]);
  const freeze = async (casinoId: string) => (await one(`INSERT INTO money_rail_freezes (org_id, rail, casino_id, reason) VALUES ($1,'TITO',$2,'test freeze') RETURNING id`, [c.orgId, casinoId])).id as string;
  const lift = (freezeId: string, reason = 'test over') => post('admin@example.com', `/api/v1/money/freezes/${freezeId}/lift`, { reason });
  const recon = async (casinoId = c.casino.id) => (await post('floor@example.com', '/api/v1/money/reconciliation', { casinoId })).json();
  const newCasino = (prefix: string, rails: Array<'VAULT' | 'CASH' | 'HANDPAY' | 'TITO' | 'CASHLESS' | 'MACHINE'> = ['VAULT', 'CASH', 'HANDPAY', 'TITO']) =>
    createLedgerCasino(c.pool as never, { orgId: c.orgId, code: `${prefix}${Date.now() % 100000}`, rails, machines: 2, gateway: true });

  describe('Step 7c: TITO on the ledger', () => {
    test('setup: VAULT, CASH, HANDPAY, TITO on the ledger, machines LEGACY; two cashier shifts with a float', async () => {
      c = get();
      svc = {
        ledger: await import('../src/services/ledger'), tito: await import('../src/services/tito'), holds: await import('../src/services/ticket-holds'),
        players: await import('../src/services/players'), cutover: await import('../src/services/cutover'),
      };
      const r = await one(`SELECT money_rail_ledger($1,$2,'TITO',NULL) t, money_rail_ledger($1,$2,'CASH',NULL) c, money_rail_ledger($1,$2,'MACHINE',$3) m`, [c.orgId, c.casino.id, m(0).id]);
      assert.deepEqual([r.t, r.c, r.m], [true, true, false]);
      await ensureVaultOpen(c.pool as never, c.casino);
      st.shift = await openLedgerShift(c.pool as never, c.casino, { cashierEmail: 'cashier@example.com', floatCents: 500_000 });
      st.shift2 = await openLedgerShift(c.pool as never, c.casino, { cashierEmail: 'attendant@example.com', floatCents: 500_000 });
      assert.equal(await liability(), await outstanding());
    });

    test('machine prints a ticket: VALID ticket, one TITO_ISSUE_MACHINE (D1 clearing -> liability); a resend changes nothing', async () => {
      const before = await liability();
      const { res, code, eventId } = await printed(0, 12.5);
      assert.equal(res.json().accepted, 1, res.body);
      const t = await ticket(code);
      assert.deepEqual([t.status, t.amount_cents, t.issued_by_machine_id, t.source_event_id], ['VALID', 1_250, m(0).id, eventId]);
      const mt = await one(`SELECT id, type, source_event_id, business_date::text AS d, options FROM money_transactions WHERE ticket_id = $1`, [t.id]);
      assert.deepEqual([mt.type, mt.source_event_id, mt.options.floorClearing], ['TITO_ISSUE_MACHINE', eventId, true]);
      assert.deepEqual(await entries(mt.id), ['LEGACY_FLOOR_CLEARING+1250', 'TICKET_LIABILITY-1250']);
      assert.equal(await liability(), before + 1_250);
      assert.equal((await printed(0, 12.5, { code, eventId })).res.json().duplicates, 1);
      assert.deepEqual(await txsOf(t.id), ['TITO_ISSUE_MACHINE']);
      st.t1 = code;
    });

    test('hold (no money) -> accept ack: TITO_REDEEM_MACHINE once; a second machine cannot hold; reject releases', async () => {
      const t = await ticket(st.t1);
      const before = await liability();
      const h = await hold(1, st.t1);
      assert.equal(h.ok, true, JSON.stringify(h));
      assert.equal((await ticket(st.t1)).status, 'HELD');
      assert.equal(await liability(), before, 'a hold moves no money');
      assert.deepEqual(await hold(2, st.t1), { ok: false, reason: 'TICKET_NOT_VALID' });
      // the machine rejects: back to VALID, no money
      assert.equal((await gw('/api/v1/gateway/tickets/release', { holdId: h.holdId, reason: 'stacker full' })).json().released, true);
      assert.equal((await ticket(st.t1)).status, 'VALID');
      // hold again and commit with the accept ack
      const h2 = await hold(1, st.t1);
      const ack = await accepted(1, st.t1, { holdId: h2.holdId, amount: 12.5 });
      assert.equal(ack.res.json().accepted, 1, ack.res.body);
      const after = await ticket(st.t1);
      assert.deepEqual([after.status, after.redeemed_machine_id, after.hold_id], ['REDEEMED', m(1).id, null]);
      assert.deepEqual(await txsOf(t.id), ['TITO_ISSUE_MACHINE', 'TITO_REDEEM_MACHINE']);
      const redeem = await one(`SELECT id, source_event_id FROM money_transactions WHERE ticket_id = $1 AND type = 'TITO_REDEEM_MACHINE'`, [t.id]);
      assert.equal(redeem.source_event_id, ack.eventId);
      assert.deepEqual(await entries(redeem.id), ['TICKET_LIABILITY+1250', 'LEGACY_FLOOR_CLEARING-1250']);
      assert.equal(await liability(), before - 1_250);
      assert.equal((await accepted(1, st.t1, { holdId: h2.holdId, amount: 12.5, eventId: ack.eventId })).res.json().duplicates, 1);
      assert.deepEqual(await txsOf(t.id), ['TITO_ISSUE_MACHINE', 'TITO_REDEEM_MACHINE']);
    });

    test('hold timeout releases the ticket (no money); a HELD ticket never expires', async () => {
      const { code } = await printed(2, 7);
      const h = await hold(2, code);
      await q(`UPDATE tickets SET hold_until = now() - interval '1 hour', expires_at = now() - interval '1 minute' WHERE barcode = $1`, [code]);
      assert.deepEqual(await tx((db) => svc.tito.expireTicketsLedger(db, { casinoId: c.casino.id })), [], 'HELD tickets do not expire');
      assert.ok((await tx((db) => svc.holds.releaseExpiredHolds(db))) >= 1);
      const t = await ticket(code);
      assert.deepEqual([t.status, t.hold_id], ['VALID', null]);
      assert.equal(h.ok, true);
      // VALID and past its expiry: TITO_EXPIRY, exactly once
      const before = await liability();
      const done = await tx((db) => svc.tito.expireTicketsLedger(db, { casinoId: c.casino.id }));
      assert.deepEqual(done.map((d) => d.ticketId), [t.id]);
      assert.equal((await ticket(code)).status, 'EXPIRED');
      assert.deepEqual(await txsOf(t.id), ['TITO_ISSUE_MACHINE', 'TITO_EXPIRY']);
      assert.equal(await liability(), before - 700);
      assert.deepEqual(await tx((db) => svc.tito.expireTicketsLedger(db, { casinoId: c.casino.id })), []);
      assert.equal((await hold(1, code)).reason, 'TICKET_NOT_VALID');
    });

    test('accepted without a committed hold: a VALID ticket is redeemed (no second payout possible) and alerted', async () => {
      const { code } = await printed(3, 20);
      const ack = await accepted(4, code, { amount: 20 });
      assert.equal(ack.res.json().accepted, 1);
      const t = await ticket(code);
      assert.equal(t.status, 'REDEEMED');
      assert.deepEqual(await txsOf(t.id), ['TITO_ISSUE_MACHINE', 'TITO_REDEEM_MACHINE']);
      assert.equal((await alert(c.casino.id, 'TICKET_ACCEPTED_WITHOUT_HOLD')).severity, 'CRITICAL', 'offline policy REJECT');
      const r = await post('cashier@example.com', '/api/v1/tickets/redeem', { barcode: code });
      assert.equal(r.statusCode, 409);
      assert.match(r.json().error, /Ticket is REDEEMED/);
    });

    test('accepted without a liability (already redeemed, unknown, held elsewhere): TITO_EXCEPTION with the machine amount', async () => {
      const { code } = await printed(0, 30);
      const h = await hold(1, code);
      const exceptionsBefore = await bal({ kind: 'TITO_EXCEPTION' });
      // machine 2 accepts a ticket held for machine 1
      const wrong = await accepted(2, code, { amount: 30 });
      assert.equal(wrong.res.json().accepted, 1);
      const ex = await one(`SELECT id, type, ticket_id, amount_cents FROM money_transactions WHERE source_event_id = $1`, [wrong.eventId]);
      assert.deepEqual([ex.type, ex.amount_cents], ['TITO_EXCEPTION', 3_000]);
      assert.deepEqual(await entries(ex.id), ['TITO_EXCEPTION+3000', 'LEGACY_FLOOR_CLEARING-3000']);
      assert.match((await alert(c.casino.id, 'TICKET_REJECTED')).message, /held for another machine/);
      assert.equal((await ticket(code)).status, 'HELD', 'the ticket is untouched');
      // the holder commits normally
      await accepted(1, code, { holdId: h.holdId, amount: 30 });
      assert.equal((await ticket(code)).status, 'REDEEMED');
      // already redeemed and unknown tickets
      const again = await accepted(3, code, { amount: 30 });
      assert.equal((await one(`SELECT type FROM money_transactions WHERE source_event_id = $1`, [again.eventId])).type, 'TITO_EXCEPTION');
      const unknown = await accepted(3, barcode(), { amount: 5 });
      const ux = await one(`SELECT type, ticket_id, amount_cents FROM money_transactions WHERE source_event_id = $1`, [unknown.eventId]);
      assert.deepEqual([ux.type, ux.ticket_id, ux.amount_cents], ['TITO_EXCEPTION', null, 500]);
      assert.equal(await bal({ kind: 'TITO_EXCEPTION' }), exceptionsBefore + 3_000 + 3_000 + 500);
      assert.deepEqual(await txsOf((await ticket(code)).id), ['TITO_ISSUE_MACHINE', 'TITO_EXCEPTION', 'TITO_REDEEM_MACHINE', 'TITO_EXCEPTION']);
    });

    test('cashier sale and payout in cash: ledger + linked drawer projection, HTTP idempotency, no second payout', async () => {
      const drawer = () => bal({ kind: 'DRAWER', cashierSessionId: st.shift });
      const d0 = await drawer();
      const key = randomUUID();
      const sold = await post('cashier@example.com', '/api/v1/tickets/issue', { amount: 40 }, key);
      assert.equal(sold.statusCode, 200, sold.body);
      assert.deepEqual((await post('cashier@example.com', '/api/v1/tickets/issue', { amount: 40 }, key)).json(), sold.json(), 'same key -> same ticket');
      const t = await ticket(sold.json().barcode);
      assert.deepEqual(await txsOf(t.id), ['TITO_ISSUE_CASHIER']);
      assert.equal(await drawer(), d0 + 4_000);
      const proj = await one(`SELECT type, amount, money_transaction_id FROM cash_transactions WHERE ticket_id = $1`, [t.id]);
      assert.deepEqual([proj.type, Number(proj.amount), proj.money_transaction_id], ['TICKET_ISSUE', 40, sold.json().moneyTransactionId]);
      const paid = await post('attendant@example.com', '/api/v1/tickets/redeem', { barcode: t.barcode });
      assert.equal(paid.statusCode, 200, paid.body);
      assert.deepEqual(await txsOf(t.id), ['TITO_ISSUE_CASHIER', 'TITO_REDEEM_CASHIER']);
      const out = await one(`SELECT type, amount, session_id FROM cash_transactions WHERE ticket_id = $1 AND type = 'TICKET_PAYOUT'`, [t.id]);
      assert.deepEqual([Number(out.amount), out.session_id], [-40, st.shift2]);
      assert.match((await post('cashier@example.com', '/api/v1/tickets/redeem', { barcode: t.barcode })).json().error, /Ticket is REDEEMED/);
      assert.match((await post('cashier@example.com', '/api/v1/tickets/redeem', { barcode: '999999999999999999' })).json().error, /Unknown ticket/);
    });

    test('concurrency: parallel cashier payouts and a machine accept of one ticket book exactly one redemption', async () => {
      for (let round = 0; round < 3; round++) {
        const { code } = await printed(5, 15);
        const results = await Promise.all([
          post('cashier@example.com', '/api/v1/tickets/redeem', { barcode: code }),
          post('attendant@example.com', '/api/v1/tickets/redeem', { barcode: code }),
          post('cashier@example.com', '/api/v1/tickets/redeem', { barcode: code }),
          accepted(6, code, { amount: 15 }).then((r) => r.res),
        ]);
        const t = await ticket(code);
        assert.equal(t.status, 'REDEEMED');
        const finals = (await txsOf(t.id)).filter((x) => x.startsWith('TITO_REDEEM'));
        assert.equal(finals.length, 1, `round ${round}: ${finals}`);
        const cashierOk = results.slice(0, 3).filter((r) => r.statusCode === 200).length;
        assert.equal(cashierOk + (finals[0] === 'TITO_REDEEM_MACHINE' ? 1 : 0), 1);
        assert.equal(results[3].json().accepted, 1, 'the machine event is always recorded');
      }
      assert.equal(await liability(), await outstanding());
    });

    test('payout above the limit needs a four-eyes approval; the approver cannot pay; the approval is used once', async () => {
      await q('UPDATE casino_money_settings SET ticket_payout_approval_cents = 10000 WHERE casino_id = $1', [c.casino.id]);
      try {
        const { code } = await printed(0, 150);
        const t = await ticket(code);
        assert.match((await post('cashier@example.com', '/api/v1/tickets/redeem', { barcode: code })).json().error, /Supervisor approval required/);
        const req = await post('cashier@example.com', `/api/v1/tickets/${t.id}/approval-request`);
        assert.equal(req.statusCode, 200, req.body);
        assert.equal((await post('cashier@example.com', `/api/v1/approvals/${req.json().id}/decide`, { decision: 'APPROVED' })).statusCode, 403);
        const ok = await post('manager@example.com', `/api/v1/approvals/${req.json().id}/decide`, { decision: 'APPROVED' });
        assert.equal(ok.json().approval.status, 'APPROVED', ok.body);
        // the approver cannot pay it
        await openLedgerShift(c.pool as never, c.casino, { cashierEmail: 'manager@example.com', vaultEmail: 'admin@example.com', floatCents: 100_000 });
        assert.match((await post('manager@example.com', '/api/v1/tickets/redeem', { barcode: code })).json().error, /approver cannot pay/);
        const paid = await post('cashier@example.com', '/api/v1/tickets/redeem', { barcode: code });
        assert.equal(paid.statusCode, 200, paid.body);
        const mt = await one(`SELECT approved_by FROM money_transactions WHERE ticket_id = $1 AND type = 'TITO_REDEEM_CASHIER'`, [t.id]);
        assert.equal(mt.approved_by, c.emp['manager@example.com']);
        assert.equal((await one('SELECT status FROM approvals WHERE id = $1', [req.json().id])).status, 'EXECUTED');
        // below the limit: no approval
        const small = await printed(0, 20);
        assert.match((await post('cashier@example.com', `/api/v1/tickets/${(await ticket(small.code)).id}/approval-request`)).json().error, /below the payout approval limit/);
        assert.equal((await post('cashier@example.com', '/api/v1/tickets/redeem', { barcode: small.code })).statusCode, 200);
      } finally {
        await q('UPDATE casino_money_settings SET ticket_payout_approval_cents = NULL WHERE casino_id = $1', [c.casino.id]);
      }
    });

    test('wallet: payout into the wallet and a sale from it (capability + wallet state checked, exactly once)', async () => {
      const cardNumber = `7C-${Date.now()}`;
      const p = await tx((db) => svc.players.createPlayer(db as never, { orgId: c.orgId, employeeId: c.emp['admin@example.com'], employeeEmail: 'admin@example.com' }, { homeCasinoId: c.casino.id, card: { cardNumber } }));
      const wallet = () => one('SELECT available_cents FROM wallet_balances WHERE player_id = $1', [p.player.id]);
      const { code } = await printed(1, 60);
      assert.match((await post('cashier@example.com', '/api/v1/tickets/redeem', { barcode: code, payTo: 'WALLET' })).json().error, /needs the player/);
      const r = await post('cashier@example.com', '/api/v1/tickets/redeem', { barcode: code, payTo: 'WALLET', playerCard: cardNumber });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(Number((await wallet()).available_cents), 6_000);
      const t = await ticket(code);
      assert.equal((await q(`SELECT 1 FROM cash_transactions WHERE ticket_id = $1`, [t.id])).length, 0, 'no drawer row for a wallet payout');
      // a sale from the wallet: more than available is refused, then a sale of 25
      assert.match((await post('cashier@example.com', '/api/v1/tickets/issue', { amount: 100, payFrom: 'WALLET', playerCard: cardNumber })).json().error, /Insufficient balance on WALLET_AVAILABLE/);
      const sold = await post('cashier@example.com', '/api/v1/tickets/issue', { amount: 25, payFrom: 'WALLET', playerCard: cardNumber });
      assert.equal(sold.statusCode, 200, sold.body);
      assert.equal(Number((await wallet()).available_cents), 3_500);
      // a blocked wallet: no further wallet ticket operations
      await q(`UPDATE wallets SET status = 'BLOCKED' WHERE player_id = $1`, [p.player.id]);
      assert.equal((await post('cashier@example.com', '/api/v1/tickets/issue', { amount: 5, payFrom: 'WALLET', playerCard: cardNumber })).statusCode, 409);
      await q(`UPDATE wallets SET status = 'ACTIVE' WHERE player_id = $1`, [p.player.id]);
    });

    test('cancel (four eyes): TITO_CANCEL booked by the requester, approved by a second person; HELD tickets cannot be cancelled', async () => {
      const { code } = await printed(2, 33);
      const t = await ticket(code);
      const before = await liability();
      const req = await post('manager@example.com', `/api/v1/tickets/${t.id}/cancel`, { reason: 'printer misfeed, duplicate print' });
      assert.equal(req.statusCode, 200, req.body);
      assert.equal((await ticket(code)).status, 'VALID', 'nothing happens before the approval');
      assert.match((await post('manager@example.com', `/api/v1/approvals/${req.json().approval.id}/decide`, { decision: 'APPROVED' })).json().error, /requester cannot approve/);
      const ok = await post('accounting@example.com', `/api/v1/approvals/${req.json().approval.id}/decide`, { decision: 'APPROVED' });
      assert.equal(ok.json().ticket.status, 'CANCELLED', ok.body);
      const mt = await one(`SELECT type, actor_id, approved_by FROM money_transactions WHERE ticket_id = $1 AND type = 'TITO_CANCEL'`, [t.id]);
      assert.deepEqual([mt.actor_id, mt.approved_by], [c.emp['manager@example.com'], c.emp['accounting@example.com']]);
      assert.equal(await liability(), before - 3_300);
      const held = await printed(2, 9);
      await hold(3, held.code);
      assert.match((await post('manager@example.com', `/api/v1/tickets/${(await ticket(held.code)).id}/cancel`, { reason: 'test reason' })).json().error, /Ticket is HELD/);
      // amount corrections on the ledger are cancel + new sale
      assert.match((await post('manager@example.com', `/api/v1/tickets/${(await ticket(held.code)).id}/adjust`, { amount: 5, reason: 'wrong amount' })).json().error, /four-eyes cancellation plus a new ticket sale/);
    });

    test('void (four eyes): REVERSAL of a cashier sale with a negative drawer projection; machine tickets cannot be voided', async () => {
      const drawer = () => bal({ kind: 'DRAWER', cashierSessionId: st.shift });
      const sold = await post('cashier@example.com', '/api/v1/tickets/issue', { amount: 18 });
      const t = await ticket(sold.json().barcode);
      const d0 = await drawer();
      const req = await post('manager@example.com', `/api/v1/tickets/${t.id}/void`, { reason: 'printer failure at sale' });
      assert.equal(req.statusCode, 200, req.body);
      const ok = await post('accounting@example.com', `/api/v1/approvals/${req.json().approval.id}/decide`, { decision: 'APPROVED' });
      assert.equal(ok.json().ticket.status, 'VOID', ok.body);
      assert.deepEqual(await txsOf(t.id), ['TITO_ISSUE_CASHIER', 'REVERSAL']);
      assert.equal(await drawer(), d0 - 1_800);
      const proj = await one(`SELECT type, amount FROM cash_transactions WHERE ticket_id = $1 AND type = 'ADJUSTMENT'`, [t.id]);
      assert.equal(Number(proj.amount), -18);
      const machineTicket = await printed(0, 4);
      assert.match((await post('manager@example.com', `/api/v1/tickets/${(await ticket(machineTicket.code)).id}/void`, { reason: 'printer failure' })).json().error, /Only a ticket sold at a cashier can be voided/);
    });

    test('guards: final states, one final booking per ticket, no ticket money without the ledger, D1 clearing only for its machine', async () => {
      const { code } = await printed(4, 11);
      const t = await ticket(code);
      await accepted(4, code, { amount: 11 });
      await assert.rejects(c.pool.query(`UPDATE tickets SET status = 'VALID' WHERE id = $1`, [t.id]), /status cannot change from REDEEMED to VALID/);
      // a second final booking for the same ticket (different key) is refused by the database
      await assert.rejects(tx((db) => svc.ledger.executeMoneyTransaction(db, {
        orgId: c.orgId, type: 'TITO_EXPIRY', dedupeKey: `x-${randomUUID()}`, actor: { type: 'SYSTEM' }, ctx: { casinoId: c.casino.id, amountCents: cents(1_100), ticketId: t.id },
      })), /money_transactions_one_ticket_final|duplicate key/);
      // ticket money without a ledger transaction is refused (006 guard)
      const v = await printed(4, 3);
      await assert.rejects(c.pool.query(`UPDATE tickets SET status = 'CANCELLED' WHERE barcode = $1`, [v.code]), /TITO is on the ledger/);
      // a clearing correction needs four eyes; other transaction types cannot use the clearing account
      await assert.rejects(tx((db) => svc.ledger.executeMoneyTransaction(db, {
        orgId: c.orgId, type: 'ADJUSTMENT', dedupeKey: `x-${randomUUID()}`, reason: 'test', actor: { type: 'EMPLOYEE', employeeId: c.emp['manager@example.com'] },
        ctx: { casinoId: c.casino.id, amountCents: cents(100), debit: { kind: 'LEGACY_FLOOR_CLEARING', machineId: m(4).id } as never, credit: { kind: 'TITO_ADJUSTMENT' } },
      })), /four eyes/);
      // the clearing of a machine equals its own issued minus accepted tickets
      const own = await one(
        `SELECT COALESCE(sum(CASE t.type WHEN 'TITO_ISSUE_MACHINE' THEN t.amount_cents ELSE -t.amount_cents END), 0) s FROM money_transactions t
         WHERE t.machine_id = $1 AND t.type IN ('TITO_ISSUE_MACHINE', 'TITO_REDEEM_MACHINE', 'TITO_EXCEPTION') AND (t.options->>'floorClearing')::boolean`, [m(4).id]);
      assert.equal(await clearing(m(4).id), Number(own.s));
    });

    test('a machine on the MACHINE ledger books MACHINE_CREDIT (no clearing); the clearing guard refuses it there', async () => {
      const all = await newCasino('7CM', ['VAULT', 'CASH', 'HANDPAY', 'TITO', 'CASHLESS', 'MACHINE']);
      const { res, code } = await printed(0, 9, { casino: all });
      assert.equal(res.json().accepted, 1, res.body);
      const t = await ticket(code);
      const mt = await one(`SELECT id FROM money_transactions WHERE ticket_id = $1`, [t.id]);
      assert.deepEqual(await entries(mt.id), ['MACHINE_CREDIT+900', 'TICKET_LIABILITY-900']);
      const h = await hold(1, code, all);
      await accepted(1, code, { holdId: h.holdId, amount: 9, casino: all });
      assert.equal(await bal({ kind: 'MACHINE_CREDIT', machineId: m(1, all).id }, all.id), 900, 'the accepting machine holds the credit');
      await assert.rejects(tx((db) => svc.ledger.executeMoneyTransaction(db, {
        orgId: c.orgId, type: 'TITO_ISSUE_MACHINE', dedupeKey: `x-${randomUUID()}`, actor: { type: 'SYSTEM' }, ctx: { casinoId: all.id, amountCents: cents(100), machineId: m(0, all).id, ticketId: t.id, floorClearing: true },
      })), /LEGACY_FLOOR_CLEARING is only for a machine that is not on the ledger|one_ticket_issue|duplicate key/);
    });

    test('frozen TITO: ticket events are recorded and deferred (no ticket change, no booking); the lift replays them once', async () => {
      const x = await newCasino('7CF');
      const before = await liability(x.id);
      // a ticket printed before the freeze and held for machine 1
      const pre = await printed(0, 10, { casino: x });
      const h = await hold(1, pre.code, x);
      const freezeId = await freeze(x.id);
      // holds and cashier operations stop; the machine events are stored
      assert.deepEqual(await hold(0, pre.code, x), { ok: false, reason: 'TITO_FROZEN' });
      const out = await printed(0, 22, { casino: x });
      assert.equal(out.res.json().accepted, 1, out.res.body);
      const ack = await accepted(1, pre.code, { holdId: h.holdId, amount: 10, casino: x });
      assert.equal(ack.res.json().accepted, 1, ack.res.body);
      for (const e of [out.eventId, ack.eventId]) {
        const d = await one(`SELECT status, reason, rail, business_date::text AS d FROM deferred_money_events WHERE event_id = $1`, [e]);
        assert.deepEqual([d.status, d.reason, d.rail], ['PENDING', 'FROZEN', 'TITO']);
        assert.equal((await q('SELECT 1 FROM machine_events WHERE event_id = $1', [e])).length, 1);
        assert.equal((await q('SELECT 1 FROM money_transactions WHERE source_event_id = $1', [e])).length, 0);
      }
      assert.equal(await ticket(out.code), undefined, 'no ticket before the replay');
      assert.equal((await ticket(pre.code)).status, 'HELD');
      assert.ok(await alert(x.id, 'TICKET_DEFERRED'));
      // the hold of a deferred accept ack is not released by the timeout job
      await q(`UPDATE tickets SET hold_until = now() - interval '1 hour' WHERE barcode = $1`, [pre.code]);
      await tx((db) => svc.holds.releaseExpiredHolds(db));
      assert.equal((await ticket(pre.code)).status, 'HELD');
      // a resend is a duplicate; a replay while frozen does nothing
      assert.equal((await printed(0, 22, { casino: x, code: out.code, eventId: out.eventId })).res.json().duplicates, 1);
      assert.deepEqual(await tx((db) => svc.tito.replayDeferredTito(db, { casinoId: x.id })), []);
      // lift: both replayed in the same transaction, exactly once, in occurred order
      const l = await lift(freezeId);
      assert.equal(l.json().lifted, true, l.body);
      assert.deepEqual(l.json().replayedTickets.map((r: { eventId: string; outcome: string }) => `${r.eventId}:${r.outcome}`), [`${out.eventId}:ISSUED`, `${ack.eventId}:REDEEMED`]);
      assert.equal((await ticket(out.code)).status, 'VALID');
      assert.equal((await ticket(pre.code)).status, 'REDEEMED');
      assert.equal(await liability(x.id), before + 2_200);
      for (const e of [out.eventId, ack.eventId]) {
        const d = await one(`SELECT status, replayed_at IS NOT NULL AS r, money_transaction_id FROM deferred_money_events WHERE event_id = $1`, [e]);
        assert.deepEqual([d.status, d.r, !!d.money_transaction_id], ['PROCESSED', true, true]);
      }
      assert.deepEqual(await tx((db) => svc.tito.replayDeferredTito(db)), []);
      assert.deepEqual((await q(`SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY id`, [out.eventId])).map((r) => r.action), ['ticket.event_deferred', 'ticket.event_replayed']);
      const run = await recon(x.id);
      assert.equal(run.ok, true, JSON.stringify(run.checks.filter((k: { ok: boolean }) => !k.ok)));
    });

    test('concurrency: parallel replays of deferred ticket events book each event once', async () => {
      const x = await newCasino('7CR');
      const freezeId = await freeze(x.id);
      const events = [];
      for (let i = 0; i < 3; i++) events.push(await printed(i % 2, 5 + i, { casino: x }));
      const run = (await one(`INSERT INTO reconciliation_runs (org_id, casino_id, trigger, ok, checks) VALUES ($1,$2,'MANUAL',true,'[]') RETURNING id`, [c.orgId, x.id])).id;
      await q(`UPDATE money_rail_freezes SET lifted_at = now(), lifted_by = $2, lift_reason = 'race test', lift_run_id = $3 WHERE id = $1`, [freezeId, c.emp['admin@example.com'], run]);
      const results = await Promise.all(Array.from({ length: 4 }, () => tx((db) => svc.tito.replayDeferredTito(db, { casinoId: x.id }))));
      assert.equal(results.flat().length, 3);
      for (const e of events) assert.deepEqual(await txsOf((await ticket(e.code)).id), ['TITO_ISSUE_MACHINE']);
    });

    test('business date: a late ticket event is booked on the date of occurred_at; a closed date is not bypassed and is reported', async () => {
      const x = await newCasino('7CD');
      const day = async (offset: number) => (await one(`SELECT ((now() AT TIME ZONE timezone)::date + $2::int)::text AS d FROM casinos WHERE id = $1`, [x.id, offset])).d as string;
      const yesterday = await day(-1);
      const late = await printed(0, 14, { casino: x, at: new Date(Date.now() - 24 * 3600_000) });
      assert.equal(late.res.json().accepted, 1, late.res.body);
      const d = await one(`SELECT status, reason, business_date::text AS bd FROM deferred_money_events WHERE event_id = $1`, [late.eventId]);
      assert.deepEqual([d.status, d.reason, d.bd], ['PROCESSED', 'LATE_EVENT', yesterday]);
      assert.deepEqual(await q(`SELECT business_date::text AS d FROM money_transactions WHERE source_event_id = $1`, [late.eventId]), [{ d: yesterday }], 'never moved to today');
      // closed original date
      const twoDaysAgo = await day(-2);
      const runId = (await one(`INSERT INTO reconciliation_runs (org_id, casino_id, trigger, ok, checks) VALUES ($1,$2,'MANUAL',true,'[]') RETURNING id`, [c.orgId, x.id])).id;
      await q(`INSERT INTO business_day_closes (casino_id, business_date, org_id, closed_by, reconciliation_run_id) VALUES ($1,$2,$3,$4,$5)`, [x.id, twoDaysAgo, c.orgId, c.emp['manager@example.com'], runId]);
      const old = await printed(1, 8, { casino: x, at: new Date(Date.now() - 48 * 3600_000) });
      assert.equal(old.res.json().accepted, 1, old.res.body);
      const p = await one(`SELECT status, attempts, last_error, business_date::text AS bd FROM deferred_money_events WHERE event_id = $1`, [old.eventId]);
      assert.deepEqual([p.status, p.attempts, p.bd], ['PENDING', 1, twoDaysAgo]);
      assert.match(p.last_error, /Business date .* is closed/);
      assert.equal(await ticket(old.code), undefined);
      assert.equal((await q(`SELECT 1 FROM money_transactions WHERE source_event_id = $1`, [old.eventId])).length, 0);
      assert.deepEqual(await tx((db) => svc.tito.replayDeferredTito(db, { casinoId: x.id })), [], 'not retried on every tick');
      // reconciliation reports it and freezes TITO; a four-eyes explanation is the explicit handling
      const run = await recon(x.id);
      assert.deepEqual(run.checks.find((k: { key: string }) => k.key === 'tito.no_stale_deferred_events').items, [`deferred_event:${old.eventId}`]);
      assert.deepEqual(run.frozen.map((f: { rail: string }) => f.rail), ['TITO']);
      const req = await post('manager@example.com', '/api/v1/money/resolutions', { casinoId: x.id, itemKey: `deferred_event:${old.eventId}`, explanation: 'Late ticket for a closed date, handled by the late-event process' });
      assert.ok((await post('accounting@example.com', `/api/v1/approvals/${req.json().id}/decide`, { decision: 'APPROVED' })).json().resolution);
      assert.equal((await lift(run.frozen[0].id, 'explained')).json().lifted, true);
      assert.equal((await one(`SELECT status FROM deferred_money_events WHERE event_id = $1`, [old.eventId])).status, 'PENDING');
    });

    test('reconciliation: TITO checks clean; a liability mismatch freezes only TITO (HANDPAY and CASH continue); a four-eyes correction repairs it', async () => {
      let run = await recon();
      assert.equal(run.ok, true, JSON.stringify(run.checks.filter((k: { ok: boolean }) => !k.ok)));
      assert.deepEqual(run.checks.filter((k: { rail: string }) => k.rail === 'TITO').map((k: { key: string }) => k.key).sort(), [
        'tito.deferred_business_date', 'tito.floor_clearing_attributable', 'tito.liability_matches_tickets', 'tito.machine_events_accounted',
        'tito.no_stale_deferred_events', 'tito.ticket_bookings_match_state',
      ]);
      const adjust = (debit: Record<string, unknown>, credit: Record<string, unknown>) => tx((db) => svc.ledger.executeMoneyTransaction(db, {
        orgId: c.orgId, type: 'ADJUSTMENT', dedupeKey: `adj-${randomUUID()}`, reason: 'test', actor: { type: 'EMPLOYEE', employeeId: c.emp['manager@example.com'] }, approvedBy: c.emp['accounting@example.com'],
        ctx: { casinoId: c.casino.id, amountCents: cents(100), debit: debit as never, credit: credit as never },
      }));
      await adjust({ kind: 'TITO_ADJUSTMENT' }, { kind: 'TICKET_LIABILITY' });
      run = await recon();
      assert.deepEqual(run.frozen.map((f: { rail: string }) => f.rail), ['TITO']);
      assert.match((await post('cashier@example.com', '/api/v1/tickets/issue', { amount: 5 })).json().error, /TITO is frozen/);
      // other rails continue: a cash fill to the drawer
      const f = await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: st.shift, amountCents: 1_000 });
      assert.equal((await post('cashier@example.com', `/api/v1/cash/movements/${f.json().movement.id}/confirm`, { totalCents: 1_000 })).json().movement.status, 'CONFIRMED');
      await adjust({ kind: 'TICKET_LIABILITY' }, { kind: 'TITO_ADJUSTMENT' }); // correction allowed while frozen
      assert.equal((await lift(run.frozen[0].id, 'corrected')).json().lifted, true);
      assert.equal((await post('cashier@example.com', '/api/v1/tickets/issue', { amount: 5 })).statusCode, 200);
    });

    test('D1: clearing left on a machine that moved to the ledger is unexplained, blocks further TITO cutovers until explained by four eyes', async () => {
      const x = await newCasino('7CX');
      await printed(0, 6, { casino: x });
      assert.equal(await clearing(m(0, x).id, x.id), 600);
      await cutoverCasinoRails(c.pool as never, x, ['CASHLESS', 'MACHINE']);
      assert.deepEqual((await svc.tito.unexplainedFloorClearing(c.pool as never, { casinoId: x.id })).map((r) => r.id), [m(0, x).id]);
      const run = await recon(x.id);
      assert.deepEqual(run.checks.find((k: { key: string }) => k.key === 'tito.floor_clearing_attributable').items, [`floor_clearing:${m(0, x).id}`]);
      const y = await createCasinoShell(c.pool as never, { orgId: c.orgId, code: `7CY${Date.now() % 100000}`, machines: 1 });
      const admin = { orgId: c.orgId, employeeId: c.emp['admin@example.com'], casinoIds: [y.id] };
      let dry = await svc.cutover.dryRunCutover(c.pool as never, admin, { rail: 'TITO', casinoId: y.id });
      assert.deepEqual(dry.checks.find((k) => k.name === 'floor_clearing_explained'), { name: 'floor_clearing_explained', ok: false, detail: { machines: [m(0, x).id] } });
      const req = await post('manager@example.com', '/api/v1/money/resolutions', { casinoId: x.id, itemKey: `floor_clearing:${m(0, x).id}`, explanation: 'Ticket printed while the machine was legacy; transferred in the machine cutover (7d)' });
      assert.ok((await post('accounting@example.com', `/api/v1/approvals/${req.json().id}/decide`, { decision: 'APPROVED' })).json().resolution);
      dry = await svc.cutover.dryRunCutover(c.pool as never, admin, { rail: 'TITO', casinoId: y.id });
      assert.equal(dry.checks.find((k) => k.name === 'floor_clearing_explained')!.ok, true);
      assert.equal((await lift(run.frozen[0].id, 'explained')).json().lifted, true);
    });

    test('end state: ledger invariants hold; liability = outstanding tickets; every ticket booked to its state', async () => {
      assert.equal((await svc.ledger.checkLedgerInvariants(c.pool as never, c.orgId)).ok, true);
      assert.equal(await liability(), await outstanding());
      const run = await recon();
      assert.equal(run.ok, true, JSON.stringify(run.checks.filter((k: { ok: boolean }) => !k.ok)));
    });
  });
}
