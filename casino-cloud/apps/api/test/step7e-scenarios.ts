import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { createCasinoShell, createLedgerCasino, cutoverCasinoRails, ensureVaultOpen, openLedgerShift, type LedgerCasino } from './ledger-casino';

/**
 * Step 7e scenarios: the operator read views (cashier shift, player / wallet, vault, approvals inbox,
 * day-close status, deferred events, machine money, ledger <-> meters) and the reconciliation check
 * machine.ledger_matches_meters. The operator flows run end to end through the same API the screens
 * use: every money action with an Idempotency-Key, approvals before execution, blind counts.
 * Also: the read views write nothing, and accounting behaviour of 7a-7d is unchanged.
 */
export interface Ctx7e {
  app: FastifyInstance;
  pool: Pool;
  orgId: string;
  casino: LedgerCasino;
  emp: Record<string, string>;
  tokens: Record<string, string>;
}

export function registerStep7eScenarios(get: () => Ctx7e) {
  let c: Ctx7e;
  const st: Record<string, any> = {};
  const auth = (email: string) => ({ authorization: `Bearer ${c.tokens[email]}` });
  const post = (email: string, url: string, payload: unknown = {}, key: string = randomUUID()) =>
    c.app.inject({ method: 'POST', url, payload: payload as object, headers: { ...auth(email), 'idempotency-key': key } });
  const get_ = (email: string, url: string) => c.app.inject({ method: 'GET', url, headers: auth(email) });
  const getJ = async (email: string, url: string) => {
    const r = await get_(email, url);
    assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
    return r.json();
  };
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
  const cid = () => c.casino.id;
  const m = (i: number) => c.casino.machines[i];
  const gw = (url: string, payload: unknown) =>
    c.app.inject({ method: 'POST', url, payload: payload as object, headers: { 'x-gateway-id': c.casino.gateway!.deviceId, 'x-gateway-key': c.casino.gateway!.key } });
  async function event(i: number, type: string, fields: Record<string, unknown> = {}) {
    const eventId = randomUUID();
    const res = await gw('/api/v1/gateway/events', { events: [{ eventId, type, machineId: m(i).code, timestamp: new Date().toISOString(), ...fields }] });
    assert.equal(res.statusCode, 200, res.body);
    return { eventId, body: res.json() };
  }
  const counts = async () => one(`SELECT (SELECT count(*) FROM money_transactions)::int AS tx, (SELECT count(*) FROM ledger_entries)::int AS le,
    (SELECT count(*) FROM approvals)::int AS ap, (SELECT count(*) FROM cash_movements)::int AS mv, (SELECT count(*) FROM idempotency_keys)::int AS ik`);

  describe('Step 7e: operator views and ledger <-> meters', () => {
    test('setup: ledger casino, verified open vault, limits for four eyes, a player with a card', async () => {
      c = get();
      await ensureVaultOpen(c.pool as never, c.casino);
      await c.pool.query(`UPDATE casino_money_settings SET deposit_approval_cents = 100000, withdrawal_approval_cents = 100000, ticket_payout_approval_cents = 50000, short_over_approval_cents = 1000 WHERE casino_id = $1`, [cid()]);
      const players = await import('../src/services/players');
      st.card = `7E-${randomUUID().slice(0, 8)}`;
      const p = await tx((db) => players.createPlayer(db as never, { orgId: c.orgId, employeeId: c.emp['admin@example.com'], employeeEmail: 'admin@example.com' }, { homeCasinoId: cid(), profile: { firstName: 'Erika', lastName: 'Muster' }, card: { cardNumber: st.card } }));
      st.player = p.player.id;
      // the cashier works in this casino only for these scenarios
      const login = await c.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'cashier@example.com', password: 'demo' } });
      assert.equal(login.statusCode, 200);
    });

    test('operator context: rail modes, active freezes and approval limits for the screen (any employee)', async () => {
      const ctx = await getJ('cashier@example.com', `/api/v1/operator/context?casinoId=${cid()}`);
      assert.deepEqual(ctx.rails, { VAULT: 'LEDGER', CASH: 'LEDGER', HANDPAY: 'LEDGER', TITO: 'LEDGER', CASHLESS: 'LEDGER' });
      assert.equal(ctx.ledgerMachines.length, c.casino.machines.length);
      assert.deepEqual(ctx.limits, { handpay: ctx.limits.handpay, deposit: 100000, withdrawal: 100000, ticketPayout: 50000, shortOver: 1000 });
      assert.match(ctx.today, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Array.isArray(ctx.freezes));
    });

    test('cashier flow: empty shift, blind fill confirmation (amount hidden from the receiver), drop pending; idempotent replay is marked', async () => {
      const desk = (await one(`INSERT INTO cash_desks (org_id, casino_id, name) VALUES ($1,$2,$3) RETURNING id`, [c.orgId, cid(), `7E desk ${Date.now()}`])).id;
      assert.equal((await post('cashier@example.com', '/api/v1/cashier/session/open', { cashDeskId: desk, openingBalance: 50 })).statusCode, 409, 'ledger shift opens empty');
      const open = await post('cashier@example.com', '/api/v1/cashier/session/open', { cashDeskId: desk, openingBalance: 0 });
      assert.equal(open.statusCode, 200, open.body);
      st.session = open.json().id;
      const fill = await post('manager@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: st.session, amountCents: 300_000 });
      assert.equal(fill.statusCode, 200, fill.body);
      let shift = await getJ('cashier@example.com', '/api/v1/cashier/shift');
      assert.equal(shift.session.status, 'OPEN');
      assert.equal(shift.session.ledger, true);
      assert.equal(shift.movements.length, 1);
      assert.equal(shift.movements[0].kind, 'FILL');
      assert.equal(shift.movements[0].amount_cents, null, 'the receiving cashier counts blind');
      assert.equal(shift.movements[0].requested_by_name, (await one('SELECT name FROM employees WHERE id = $1', [c.emp['manager@example.com']])).name);
      const key = randomUUID();
      const conf = await post('cashier@example.com', `/api/v1/cash/movements/${fill.json().movement.id}/confirm`, { totalCents: 300_000 }, key);
      assert.equal(conf.json().movement.status, 'CONFIRMED');
      const again = await post('cashier@example.com', `/api/v1/cash/movements/${fill.json().movement.id}/confirm`, { totalCents: 300_000 }, key);
      assert.equal(again.headers['idempotent-replayed'], 'true', 'the same intent replays (the screen shows "already done")');
      assert.equal((await q(`SELECT 1 FROM money_transactions WHERE cashier_session_id = $1`, [st.session])).length, 1, 'booked once');
      const drop = await post('cashier@example.com', '/api/v1/cash/movements', { kind: 'DROP', amountCents: 10_000 });
      assert.equal(drop.statusCode, 200, drop.body);
      shift = await getJ('cashier@example.com', '/api/v1/cashier/shift');
      assert.deepEqual(shift.movements.map((x: any) => [x.kind, x.amount_cents]), [['DROP', 10_000]], 'the requester sees the own amount');
      const vault = await getJ('manager@example.com', `/api/v1/vault/status?casinoId=${cid()}`);
      assert.ok(vault.movements.some((x: any) => x.id === drop.json().movement.id && x.kind === 'DROP' && x.cashier_name));
      assert.ok(vault.shifts.some((x: any) => x.id === st.session));
      assert.equal((await post('manager@example.com', `/api/v1/cash/movements/${drop.json().movement.id}/confirm`, { totalCents: 10_000 })).json().movement.status, 'CONFIRMED');
    });

    test('CORS exposes Idempotent-Replayed so the browser can show a replay', async () => {
      const r = await c.app.inject({ method: 'OPTIONS', url: '/api/v1/cashier/wallet/deposit', headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' } });
      const g = await c.app.inject({ method: 'GET', url: '/api/v1/operator/context', headers: { ...auth('cashier@example.com'), origin: 'http://localhost:3000' } });
      assert.ok(r.statusCode < 400);
      assert.match(String(g.headers['access-control-expose-headers']), /Idempotent-Replayed/);
    });

    test('player / wallet: lookup by card with ledger balances and history; deposit and withdrawal; four eyes above the limit; blocked card', async () => {
      assert.equal((await get_('cashier@example.com', '/api/v1/players/lookup/NOPE-0000')).statusCode, 404);
      let p = await getJ('cashier@example.com', `/api/v1/players/lookup/${st.card}`);
      assert.equal(p.usable, true);
      assert.equal(p.player.first_name, 'Erika');
      assert.deepEqual([p.wallet.availableCents, p.wallet.reservedCents, p.wallet.history.length], [0, 0, 0]);
      assert.equal((await post('cashier@example.com', '/api/v1/cashier/wallet/deposit', { playerCard: st.card, amount: 250.5 })).statusCode, 200);
      assert.equal((await post('cashier@example.com', '/api/v1/cashier/wallet/withdraw', { playerCard: st.card, amount: 50 })).statusCode, 200);
      p = await getJ('cashier@example.com', `/api/v1/players/lookup/${st.card}`);
      assert.equal(p.wallet.availableCents, 20_050);
      assert.deepEqual(p.wallet.history.map((h: any) => [h.type, Number(h.available_delta_cents)]), [['CASH_WITHDRAWAL', -5_000], ['CASH_DEPOSIT', 25_050]]);
      // above the limit: refused without approval; requested; the cashier cannot decide it; a supervisor approves; then booked once
      const big = { playerCard: st.card, amount: 1000 };
      assert.match((await post('cashier@example.com', '/api/v1/cashier/wallet/deposit', big)).json().error, /Supervisor approval required/);
      const ap = await post('cashier@example.com', '/api/v1/cashier/wallet/approval-request', { ...big, kind: 'CASH_DEPOSIT' });
      assert.equal(ap.statusCode, 200, ap.body);
      let shift = await getJ('cashier@example.com', '/api/v1/cashier/shift');
      assert.deepEqual(shift.myApprovals.filter((a: any) => a.id === ap.json().id).map((a: any) => [a.action, a.status, Number(a.amount_cents)]), [['CASH_DEPOSIT', 'PENDING', 100_000]]);
      assert.equal((await get_('cashier@example.com', `/api/v1/approvals?casinoId=${cid()}`)).statusCode, 403, 'the inbox needs cashier.supervise');
      const inbox = await getJ('floor@example.com', `/api/v1/approvals?casinoId=${cid()}`);
      const item = inbox.find((a: any) => a.id === ap.json().id);
      assert.equal(item.requested_by_name, (await one('SELECT name FROM employees WHERE id = $1', [c.emp['cashier@example.com']])).name);
      assert.equal(item.player_name, 'Erika Muster');
      assert.equal(item.own, false);
      assert.equal(Number(item.amount_cents), 100_000);
      assert.equal((await post('floor@example.com', `/api/v1/approvals/${ap.json().id}/decide`, { decision: 'APPROVED' })).statusCode, 200);
      shift = await getJ('cashier@example.com', '/api/v1/cashier/shift');
      assert.equal(shift.myApprovals.find((a: any) => a.id === ap.json().id).status, 'APPROVED');
      assert.ok(shift.myApprovals.find((a: any) => a.id === ap.json().id).decided_by_name);
      assert.equal((await post('cashier@example.com', '/api/v1/cashier/wallet/deposit', big)).statusCode, 200);
      p = await getJ('cashier@example.com', `/api/v1/players/lookup/${st.card}`);
      assert.equal(p.wallet.availableCents, 120_050);
      // blocked card: visible before any action, operations refused by the API
      const players = await import('../src/services/players');
      await tx((db) => players.setCardStatus(db as never, { orgId: c.orgId, employeeId: c.emp['admin@example.com'] }, p.card.id, 'BLOCKED', 'lost wallet'));
      p = await getJ('cashier@example.com', `/api/v1/players/lookup/${st.card}`);
      assert.deepEqual([p.usable, p.card.status, p.rejection], [false, 'BLOCKED', 'Player card is blocked']);
      assert.equal(p.wallet.availableCents, 120_050, 'balance still shown');
      assert.equal((await post('cashier@example.com', '/api/v1/cashier/wallet/withdraw', { playerCard: st.card, amount: 5 })).statusCode, 409);
      await tx((db) => players.setCardStatus(db as never, { orgId: c.orgId, employeeId: c.emp['admin@example.com'] }, p.card.id, 'ACTIVE', 'found'));
    });

    test('approvals inbox: own request flagged, self-approval refused, history keeps decider and note', async () => {
      // a ticket above the payout limit, sold at the cage, payout requested by the cashier
      const sold = await post('cashier@example.com', '/api/v1/tickets/issue', { amount: 600 });
      assert.equal(sold.statusCode, 200, sold.body);
      const t = sold.json();
      assert.match((await post('cashier@example.com', '/api/v1/tickets/redeem', { barcode: t.barcode })).json().error, /approval required/);
      const req = await post('cashier@example.com', `/api/v1/tickets/${t.id}/approval-request`);
      assert.equal(req.statusCode, 200, req.body);
      // a supervisor who also asks for something sees it as own
      const own = await post('floor@example.com', '/api/v1/money/resolutions', { casinoId: cid(), itemKey: `test:${randomUUID()}`, explanation: 'Own request of the supervisor for the inbox test' });
      const inbox = await getJ('floor@example.com', `/api/v1/approvals?casinoId=${cid()}`);
      const ticketItem = inbox.find((a: any) => a.id === req.json().id);
      assert.deepEqual([ticketItem.action, ticketItem.barcode, ticketItem.own], ['TITO_REDEEM_CASHIER', t.barcode, false]);
      assert.equal(inbox.find((a: any) => a.id === own.json().id).own, true);
      assert.match((await post('floor@example.com', `/api/v1/approvals/${own.json().id}/decide`, { decision: 'APPROVED' })).json().error, /requester cannot approve/);
      assert.equal((await post('manager@example.com', `/api/v1/approvals/${req.json().id}/decide`, { decision: 'APPROVED', note: 'checked slip' })).statusCode, 200);
      const paid = await post('cashier@example.com', '/api/v1/tickets/redeem', { barcode: t.barcode });
      assert.equal(paid.statusCode, 200, paid.body);
      const hist = await getJ('floor@example.com', `/api/v1/approvals?casinoId=${cid()}&status=ALL`);
      const h = hist.find((a: any) => a.id === req.json().id);
      assert.deepEqual([h.status, h.decision_note, !!h.decided_by_name, !!h.executed_at], ['EXECUTED', 'checked slip', true, true]);
      assert.equal((await post('accounting@example.com', `/api/v1/approvals/${own.json().id}/decide`, { decision: 'REJECTED' })).statusCode, 200);
    });

    test('vault view: no vault balance for the counting roles (blind), counts pending for a second person, no amounts for blind counts', async () => {
      const v = await getJ('manager@example.com', `/api/v1/vault/status?casinoId=${cid()}`);
      assert.equal(v.session.status, 'OPEN');
      assert.equal(v.session.verified, true);
      const ledger = await import('../src/services/ledger');
      assert.equal(v.balanceCents, null, 'blind: the vault balance is disclosed only in the review of a submitted count');
      assert.ok(await ledger.getBalance(c.pool as never, c.orgId, { kind: 'VAULT', casinoId: cid(), vaultId: c.casino.vault } as never) > 0);
      assert.equal((await get_('cashier@example.com', `/api/v1/vault/status?casinoId=${cid()}`)).statusCode, 403);
      // collection count waiting for the second person; the view carries no amount
      await event(0, 'CASH_IN', { amount: 40 });
      const cnt = await post('manager@example.com', `/api/v1/machines/${m(0).id}/collections/count`, { totalCents: 4_000 });
      assert.equal(cnt.statusCode, 200, cnt.body);
      const v2 = await getJ('admin@example.com', `/api/v1/vault/status?casinoId=${cid()}`);
      const pending = v2.collectionCounts.find((x: any) => x.id === cnt.json().id);
      assert.ok(pending);
      assert.equal(pending.total_cents, undefined);
      assert.equal((await post('admin@example.com', `/api/v1/machines/collections/counts/${cnt.json().id}/verify`, { totalCents: 4_000 })).json().matches, true);
      assert.ok(!(await getJ('admin@example.com', `/api/v1/vault/status?casinoId=${cid()}`)).collectionCounts.some((x: any) => x.id === cnt.json().id));
      // hopper fill requested by the vault, pending at the machine view, confirmed there
      const hf = await post('manager@example.com', `/api/v1/machines/${m(1).id}/hopper-fills`, { amountCents: 5_000 });
      const mm = await getJ('attendant@example.com', `/api/v1/machines/${m(1).id}/money`);
      assert.equal(mm.rail, 'LEDGER');
      assert.deepEqual(mm.hopperFills.filter((h: any) => h.status === 'REQUESTED').map((h: any) => h.id), [hf.json().movement.id]);
      assert.equal(mm.cashboxCents, undefined, 'no cashbox / hopper balance on the machine view (blind counts)');
      assert.equal((await post('attendant@example.com', `/api/v1/machines/hopper-fills/${hf.json().movement.id}/confirm`, { totalCents: 5_000 })).json().movement.status, 'CONFIRMED');
    });

    test('cutover counts view: verification state without amounts', async () => {
      const list = await getJ('manager@example.com', `/api/v1/money/counts?casinoId=${cid()}`);
      assert.ok(list.length >= 1);
      for (const x of list) {
        assert.equal(x.total_cents, undefined);
        assert.equal(typeof x.verified, 'boolean');
      }
      assert.ok(list.some((x: any) => x.context === 'VAULT_CUTOVER' && x.verified && x.used));
    });

    test('ledger <-> meters: per machine and money type, meters = ledger; exceptions explain differences; a booked amount that differs from the meter freezes only that machine', async () => {
      const e1 = await event(2, 'CASH_IN', { amount: 30 });
      // matching ledger / meters: the check is clean and nothing is frozen
      const clean = (await post('floor@example.com', '/api/v1/money/reconciliation', { casinoId: cid() })).json();
      assert.equal(clean.checks.find((x: any) => x.key === 'machine.ledger_matches_meters').ok, true);
      assert.equal(clean.ok, true, JSON.stringify(clean.checks.filter((x: any) => !x.ok)));
      assert.deepEqual(await q(`SELECT 1 FROM money_rail_freezes WHERE casino_id = $1 AND lifted_at IS NULL`, [cid()]), []);
      const e2 = await event(2, 'CASH_OUT', { amount: 500 }); // empty hopper -> exception, no money
      assert.equal(e2.body.exceptions.length, 1);
      const meters = await getJ('floor@example.com', `/api/v1/money/reconciliation/meters?casinoId=${cid()}`);
      const mc = meters.machines.find((x: any) => x.machineId === m(2).id);
      const line = (t: string) => mc.lines.find((l: any) => l.type === t);
      assert.deepEqual([line('CASH_IN').meterCents, line('CASH_IN').ledgerCents, line('CASH_IN').unexplainedCents], [3_000, 3_000, 0]);
      assert.deepEqual([line('CASH_OUT').meterCents, line('CASH_OUT').ledgerCents, line('CASH_OUT').exceptionCents, line('CASH_OUT').unexplainedCents], [50_000, 0, 50_000, 0]);
      assert.equal(mc.ok, true);
      let run = (await post('floor@example.com', '/api/v1/money/reconciliation', { casinoId: cid() })).json();
      assert.equal(run.checks.find((x: any) => x.key === 'machine.ledger_matches_meters').ok, true);
      // explain the exception (four eyes) so the casino reconciles clean again
      const r = await post('manager@example.com', '/api/v1/money/resolutions', { casinoId: cid(), itemKey: `machine_event:${e2.eventId}`, explanation: 'Hopper was empty; attendant paid nothing, verified' });
      await post('accounting@example.com', `/api/v1/approvals/${r.json().id}/decide`, { decision: 'APPROVED' });
      run = (await post('floor@example.com', '/api/v1/money/reconciliation', { casinoId: cid() })).json();
      assert.equal(run.ok, true, JSON.stringify(run.checks.filter((x: any) => !x.ok)));
      // the first run froze machine 2 (unexplained exception at that time): lifted now that the run is clean
      for (const f of await q(`SELECT id FROM money_rail_freezes WHERE casino_id = $1 AND machine_id = $2 AND lifted_at IS NULL`, [cid(), m(2).id]))
        assert.equal((await post('admin@example.com', `/api/v1/money/freezes/${f.id}/lift`, { reason: 'exception explained' })).json().lifted, true);
      // A mismatch cannot arise through the supported ingest (the booking takes the event's amount). To prove
      // the check, a faulty booking is simulated through the production booking path itself (MoneyService:
      // balanced, rail-guarded, DB-checked): the machine reports 30.00, the ledger books 31.00. No row is edited.
      const invBefore = await one(`SELECT COALESCE(sum(amount_cents), 0)::bigint AS s FROM ledger_entries WHERE org_id = $1`, [c.orgId]);
      const ledgerSvc = await import('../src/services/ledger');
      const bad = randomUUID();
      await tx(async (db) => {
        await db.query(`INSERT INTO machine_events (event_id, org_id, casino_id, machine_id, type, amount, occurred_at) VALUES ($1,$2,$3,$4,'CASH_IN',30,now())`, [bad, c.orgId, cid(), m(2).id]);
        await ledgerSvc.executeMoneyTransaction(db as never, {
          orgId: c.orgId, type: 'MACHINE_CASH_IN', dedupeKey: ledgerSvc.eventDedupeKey(bad, 'MACHINE_CASH_IN'), sourceEventId: bad,
          actor: { type: 'GATEWAY', name: 'machine' }, ctx: { casinoId: cid(), machineId: m(2).id, amountCents: 3_100 },
        } as never);
      });
      run = (await post('floor@example.com', '/api/v1/money/reconciliation', { casinoId: cid() })).json();
      const chk = run.checks.find((x: any) => x.key === 'machine.ledger_matches_meters');
      assert.deepEqual(chk.items, [`meters:${m(2).id}:CASH_IN`]);
      const frozen = await q(`SELECT machine_id FROM money_rail_freezes WHERE casino_id = $1 AND rail = 'MACHINE' AND lifted_at IS NULL`, [cid()]);
      assert.deepEqual(frozen.map((f) => f.machine_id), [m(2).id], 'only this machine is frozen');
      assert.deepEqual(run.frozen.map((f: any) => f.rail), ['MACHINE'], 'no other rail is frozen');
      // no money silently created or destroyed: every booking balanced, the difference is visible, not hidden
      assert.equal((await one(`SELECT COALESCE(sum(amount_cents), 0)::bigint AS s FROM ledger_entries WHERE org_id = $1`, [c.orgId])).s, invBefore.s);
      assert.equal((await import('../src/services/ledger').then((l) => l.checkLedgerInvariants(c.pool as never, c.orgId))).ok, true);
      // the unrelated machine keeps booking; the frozen machine's money event is kept (deferred), not lost
      const other = await event(3, 'CASH_IN', { amount: 4 });
      assert.deepEqual((await q('SELECT type FROM money_transactions WHERE source_event_id = $1', [other.eventId])).map((x) => x.type), ['MACHINE_CASH_IN']);
      const held = await event(2, 'CASH_IN', { amount: 2 });
      assert.equal((await one('SELECT status FROM deferred_money_events WHERE event_id = $1', [held.eventId])).status, 'PENDING');
      assert.equal((await q('SELECT 1 FROM money_transactions WHERE source_event_id = $1', [held.eventId])).length, 0);
      // unrelated rails keep working (CASHLESS deposit at the cage, TITO sale)
      assert.equal((await post('cashier@example.com', '/api/v1/cashier/wallet/deposit', { playerCard: st.card, amount: 1 })).statusCode, 200);
      assert.equal((await post('cashier@example.com', '/api/v1/tickets/issue', { amount: 2 })).statusCode, 200);
      const after = await getJ('floor@example.com', `/api/v1/money/reconciliation/meters?casinoId=${cid()}`);
      assert.equal(after.machines.find((x: any) => x.machineId === m(2).id).lines.find((l: any) => l.type === 'CASH_IN').unexplainedCents, -100);
      // the screens show it: freeze in the operator context, blocker in the day-close status, machine view
      const ctx = await getJ('cashier@example.com', `/api/v1/operator/context?casinoId=${cid()}`);
      assert.ok(ctx.freezes.some((f: any) => f.rail === 'MACHINE' && f.machine_id === m(2).id && f.asset_no === m(2).asset));
      const dc = await getJ('floor@example.com', `/api/v1/money/day-close/status?casinoId=${cid()}`);
      assert.equal(dc.canClose, false);
      assert.ok(dc.blockers.some((b: any) => b.code === 'FROZEN' && b.message.includes(m(2).asset)));
      assert.ok(dc.blockers.some((b: any) => b.code === 'RECONCILIATION' && b.message.startsWith('machine.ledger_matches_meters')));
      const mm = await getJ('attendant@example.com', `/api/v1/machines/${m(2).id}/money`);
      assert.equal(mm.freezes.length, 1);
      // explained by two people (the difference cannot be undone: the ledger is immutable), then lifted after a clean run
      const ex = await post('manager@example.com', '/api/v1/money/resolutions', { casinoId: cid(), itemKey: `meters:${m(2).id}:CASH_IN`, explanation: 'Faulty booking of 1.00 investigated, corrected by adjustment' });
      assert.equal((await post('accounting@example.com', `/api/v1/approvals/${ex.json().id}/decide`, { decision: 'APPROVED' })).statusCode, 200);
      const fz = (await one(`SELECT id FROM money_rail_freezes WHERE casino_id = $1 AND machine_id = $2 AND lifted_at IS NULL`, [cid(), m(2).id])).id;
      assert.equal((await post('admin@example.com', `/api/v1/money/freezes/${fz}/lift`, { reason: 'explained by two people' })).json().lifted, true);
      assert.deepEqual((await q('SELECT type FROM money_transactions WHERE source_event_id = $1', [held.eventId])).map((x) => x.type), ['MACHINE_CASH_IN'], 'replayed exactly once after the lift');
      assert.equal((await getJ('floor@example.com', `/api/v1/money/day-close/status?casinoId=${cid()}`)).canClose, true);
    });

    test('deferred events view: a machine event while the machine is frozen is listed (all rails) with its business date state', async () => {
      const fz = await one(`INSERT INTO money_rail_freezes (org_id, rail, casino_id, machine_id, reason) VALUES ($1,'MACHINE',$2,$3,'7e test') RETURNING id`, [c.orgId, cid(), m(3).id]);
      const e = await event(3, 'CASH_IN', { amount: 12 });
      const list = await getJ('floor@example.com', `/api/v1/money/deferred?casinoId=${cid()}`);
      const d = list.find((x: any) => x.event_id === e.eventId);
      assert.deepEqual([d.rail, d.kind, Number(d.amount_cents), d.reason, d.date_closed, d.explained, d.asset_no], ['MACHINE', 'CASH_IN', 1_200, 'FROZEN', false, false, m(3).asset]);
      const dc = await getJ('floor@example.com', `/api/v1/money/day-close/status?casinoId=${cid()}`);
      assert.ok(dc.blockers.some((b: any) => b.code === 'DEFERRED_EVENTS'));
      assert.equal(dc.pendingDeferred, 1);
      const mm = await getJ('attendant@example.com', `/api/v1/machines/${m(3).id}/money`);
      assert.deepEqual(mm.deferred.map((x: any) => x.event_id), [e.eventId]);
      const lifted = (await post('admin@example.com', `/api/v1/money/freezes/${fz.id}/lift`, { reason: '7e test over' })).json();
      assert.equal(lifted.lifted, true);
      assert.deepEqual((await getJ('floor@example.com', `/api/v1/money/deferred?casinoId=${cid()}`)).filter((x: any) => x.event_id === e.eventId), []);
      assert.equal((await getJ('floor@example.com', `/api/v1/money/deferred?casinoId=${cid()}&status=PROCESSED`)).filter((x: any) => x.event_id === e.eventId).length, 1);
    });

    test('close flow on the screen: blind close count above the short/over limit waits for a supervisor, the shift state says so; final drop confirmed by the vault', async () => {
      const close = await post('cashier@example.com', '/api/v1/cashier/session/close', { countedBalance: 1 });
      assert.equal(close.statusCode, 200, close.body);
      assert.equal(close.json().status, 'PENDING_APPROVAL');
      let shift = await getJ('cashier@example.com', '/api/v1/cashier/shift');
      assert.deepEqual([shift.session.status, shift.closeApproval.status], ['COUNTING', 'PENDING']);
      const inbox = await getJ('floor@example.com', `/api/v1/approvals?casinoId=${cid()}`);
      const so = inbox.find((a: any) => a.action === 'DRAWER_SHORT_OVER' && a.payload.cashierSessionId === st.session);
      assert.ok(so.desk_name && so.cashier_name);
      assert.ok(so.payload.differenceCents < 0);
      assert.equal((await post('floor@example.com', `/api/v1/approvals/${so.id}/decide`, { decision: 'APPROVED' })).json().status, 'PENDING_DROP');
      shift = await getJ('cashier@example.com', '/api/v1/cashier/shift');
      assert.deepEqual(shift.movements.map((x: any) => [x.kind, x.purpose]), [['DROP', 'CLOSE']]);
      const drop = shift.movements[0];
      assert.equal((await post('manager@example.com', `/api/v1/cash/movements/${drop.id}/confirm`, { totalCents: 100 })).json().movement.status, 'CONFIRMED');
      assert.equal((await getJ('cashier@example.com', '/api/v1/cashier/shift')).session, null);
      assert.equal((await one('SELECT status FROM cashier_sessions WHERE id = $1', [st.session])).status, 'CLOSED');
    });

    test('expected collection, one definition: ledger machine = CASHBOX ledger balance; hopper, cash and vault movements do not change it; the reviewer sees exactly the amount the settlement uses', async () => {
      const L = await createLedgerCasino(c.pool as never, { orgId: c.orgId, code: `7EC${Date.now() % 100000}`, machines: 2, gateway: true });
      await ensureVaultOpen(c.pool as never, L);
      const ledger = await import('../src/services/ledger');
      const coll = await import('../src/services/collections');
      const ev = async (i: number, type: string, amount: number) => {
        const r = await c.app.inject({ method: 'POST', url: '/api/v1/gateway/events', headers: { 'x-gateway-id': L.gateway!.deviceId, 'x-gateway-key': L.gateway!.key },
          payload: { events: [{ eventId: randomUUID(), type, machineId: L.machines[i].code, timestamp: new Date().toISOString(), amount }] } });
        assert.equal(r.json().accepted, 1, r.body);
        return r.json();
      };
      const cashbox = (i: number) => ledger.getBalance(c.pool as never, c.orgId, { kind: 'CASHBOX', casinoId: L.id, machineId: L.machines[i].id } as never);
      const same = async (i: number, cents: number) => {
        const e = await coll.expectedCollection(c.pool as never, c.orgId, L.machines[i].id);
        assert.deepEqual([e.basis, e.cashCents], ['LEDGER_CASHBOX', cents]);
        assert.equal(e.cashCents, await cashbox(i), 'authoritative expected = CASHBOX ledger balance');
        const api = await getJ('manager@example.com', `/api/v1/cash/collections/expected/${L.machines[i].id}`);
        assert.deepEqual([api.blind, api.cashCents, api.basis], [true, null, 'LEDGER_CASHBOX'], 'no pending count: blind for every counting role');
      };
      await same(0, 0);
      await ev(0, 'CASH_IN', 30); await ev(1, 'CASH_IN', 20); await ev(0, 'CASH_IN', 5);
      await same(0, 3_500); await same(1, 2_000);
      const hf = await post('manager@example.com', `/api/v1/machines/${L.machines[0].id}/hopper-fills`, { amountCents: 10_000 });
      assert.equal((await post('attendant@example.com', `/api/v1/machines/hopper-fills/${hf.json().movement.id}/confirm`, { totalCents: 10_000 })).json().movement.status, 'CONFIRMED');
      assert.deepEqual((await ev(0, 'CASH_OUT', 10)).exceptions, []);
      await same(0, 3_500);
      await openLedgerShift(c.pool as never, L, { cashierEmail: 'attendant@example.com', vaultEmail: 'manager@example.com', floatCents: 50_000 });
      await same(0, 3_500); await same(1, 2_000);
      // first count (manager, blind) -> the reviewer (admin) sees counted, expected and difference from the same calculation
      const cnt = await post('manager@example.com', `/api/v1/machines/${L.machines[0].id}/collections/count`, { totalCents: 3_400 });
      const review = await getJ('admin@example.com', `/api/v1/counts/${cnt.json().id}/review`);
      assert.deepEqual([review.basis, review.countedCents, review.expectedCents, review.differenceCents], ['LEDGER_CASHBOX', 3_400, 3_500, -100]);
      const shown = await getJ('admin@example.com', `/api/v1/cash/collections/expected/${L.machines[0].id}`);
      assert.deepEqual([shown.blind, shown.cashCents, shown.countedCents, shown.differenceCents], [false, 3_500, 3_400, -100], 'the collection screen of the reviewer shows the same values');
      const v = (await post('admin@example.com', `/api/v1/machines/collections/counts/${cnt.json().id}/verify`, { totalCents: 3_400 })).json();
      assert.deepEqual([v.matches, Number(v.settlement.ledger_cents), Number(v.settlement.difference_cents)], [true, 3_500, -100], 'settled against the amount the reviewer saw');
      assert.equal(Number(v.collection.expected_cash) * 100, 3_500);
      await same(0, 0); await same(1, 2_000);
      await ev(0, 'CASH_IN', 7);
      await same(0, 700);
      const run = (await post('floor@example.com', '/api/v1/money/reconciliation', { casinoId: L.id })).json();
      assert.equal(run.ok, true, JSON.stringify(run.checks.filter((x: any) => !x.ok)));
      assert.match((await post('manager@example.com', '/api/v1/cash/collections', { machineId: L.machines[1].id, countedCash: 20, countedTickets: 0 })).json().error, /on the ledger/);
    });

    test('expected collection, legacy machines: machine-reported cash since the last collection; the legacy booking, the cutover review and the MACHINE cutover use exactly that amount', async () => {
      const L = await createCasinoShell(c.pool as never, { orgId: c.orgId, code: `7EL${Date.now() % 100000}`, machines: 2, gateway: true });
      await cutoverCasinoRails(c.pool as never, L, ['VAULT', 'CASH', 'HANDPAY', 'TITO']);
      const coll = await import('../src/services/collections');
      const ev = async (i: number, type: string, amount: number) => {
        const r = await c.app.inject({ method: 'POST', url: '/api/v1/gateway/events', headers: { 'x-gateway-id': L.gateway!.deviceId, 'x-gateway-key': L.gateway!.key },
          payload: { events: [{ eventId: randomUUID(), type, machineId: L.machines[i].code, timestamp: new Date().toISOString(), amount }] } });
        assert.equal(r.json().accepted, 1, r.body);
      };
      const truth = async (i: number) => (await coll.expectedCollection(c.pool as never, c.orgId, L.machines[i].id)).cashCents;
      await ev(0, 'CASH_IN', 12); await ev(0, 'CASH_IN', 8); await ev(1, 'CASH_IN', 3);
      assert.deepEqual([await truth(0), await truth(1)], [2_000, 300]);
      assert.equal((await getJ('manager@example.com', `/api/v1/cash/collections/expected/${L.machines[0].id}`)).cashCents, null, 'blind');
      // legacy booking (single step, legacy compatibility): the expectation comes back only with the saved count
      const col = await post('manager@example.com', '/api/v1/cash/collections', { machineId: L.machines[1].id, countedCash: 3, countedTickets: 0 });
      assert.deepEqual([Number(col.json().expected_cash), Number(col.json().difference)], [3, 0]);
      assert.equal(await truth(1), 0);
      // MACHINE cutover: blind count, review by a second person shows the same expectation, dry run hidden until verified
      const exp = await truth(0);
      const cnt = await post('manager@example.com', '/api/v1/money/counts', { casinoId: L.id, context: 'MACHINE_DROP', machineId: L.machines[0].id, totalCents: exp + 100 });
      const pre = (await post('admin@example.com', '/api/v1/money/cutover/dry-run', { rail: 'MACHINE', machineId: L.machines[0].id })).json();
      assert.deepEqual([pre.blind, pre.legacy], [true, {}], 'no legacy amount before the second count');
      assert.ok(pre.checks.every((x: any) => x.detail === undefined || x.detail === 'hidden until the counts are verified (blind count)'));
      const rv = await getJ('admin@example.com', `/api/v1/counts/${cnt.json().id}/review`);
      assert.deepEqual([rv.basis, rv.countedCents, rv.expectedCents, rv.differenceCents], ['MACHINE_EVENTS', exp + 100, exp, 100]);
      // the reviewer rejects with the own count: nothing verified, nothing booked
      assert.equal((await post('admin@example.com', `/api/v1/money/counts/${cnt.json().id}/verify`, { totalCents: exp })).json().matches, false);
      const ok = await post('manager@example.com', '/api/v1/money/counts', { casinoId: L.id, context: 'MACHINE_DROP', machineId: L.machines[0].id, totalCents: exp });
      assert.equal((await getJ('admin@example.com', `/api/v1/counts/${ok.json().id}/review`)).differenceCents, 0);
      assert.equal((await post('admin@example.com', `/api/v1/money/counts/${ok.json().id}/verify`, { totalCents: exp })).json().matches, true);
      const dry = (await post('admin@example.com', '/api/v1/money/cutover/dry-run', { rail: 'MACHINE', machineId: L.machines[0].id })).json();
      assert.equal(dry.legacy.cashbox_expected, exp, 'cutover expectation = reviewed expectation');
      assert.equal(dry.checks.find((x: any) => x.name.endsWith(':collection_matches_legacy_cash_in')).ok, true);
      assert.equal((await post('admin@example.com', '/api/v1/money/cutover', { rail: 'MACHINE', machineId: L.machines[0].id })).json().ok, true);
      assert.deepEqual([(await coll.expectedCollection(c.pool as never, c.orgId, L.machines[0].id)).basis, await truth(0)], ['LEDGER_CASHBOX', 0]);
    });

    test('expected collection, pure legacy casino: blind before the count, the legacy booking returns the same expectation with the saved count', async () => {
      const L = await createCasinoShell(c.pool as never, { orgId: c.orgId, code: `7EP${Date.now() % 100000}`, machines: 1, gateway: true });
      const r = await c.app.inject({ method: 'POST', url: '/api/v1/gateway/events', headers: { 'x-gateway-id': L.gateway!.deviceId, 'x-gateway-key': L.gateway!.key },
        payload: { events: [{ eventId: randomUUID(), type: 'CASH_IN', machineId: L.machines[0].code, timestamp: new Date().toISOString(), amount: 45 }] } });
      assert.equal(r.json().accepted, 1);
      const e = await getJ('manager@example.com', `/api/v1/cash/collections/expected/${L.machines[0].id}`);
      assert.deepEqual([e.basis, e.blind, e.cashCents], ['MACHINE_EVENTS', true, null]);
      const col = await post('manager@example.com', '/api/v1/cash/collections', { machineId: L.machines[0].id, countedCash: 44, countedTickets: 0 });
      assert.deepEqual([Number(col.json().expected_cash), Number(col.json().difference)], [45, -1], 'legacy difference against the same expectation (alert raised as before)');
      assert.equal((await q(`SELECT 1 FROM money_transactions WHERE machine_id = $1`, [L.machines[0].id])).length, 0, 'legacy: no ledger money');
    });

    test('blind count enforced by the API: the first counter gets no expected amount anywhere; a different authorized employee reviews; reject books nothing; approve follows the settlement; audit has both people', async () => {
      const L = await createLedgerCasino(c.pool as never, { orgId: c.orgId, code: `7EB${Date.now() % 100000}`, machines: 2, gateway: true });
      await ensureVaultOpen(c.pool as never, L);
      const ledger = await import('../src/services/ledger');
      const r = await c.app.inject({ method: 'POST', url: '/api/v1/gateway/events', headers: { 'x-gateway-id': L.gateway!.deviceId, 'x-gateway-key': L.gateway!.key },
        payload: { events: [{ eventId: randomUUID(), type: 'CASH_IN', machineId: L.machines[0].code, timestamp: new Date().toISOString(), amount: 80 }] } });
      assert.equal(r.json().accepted, 1);
      const mId = L.machines[0].id;
      const counter = 'manager@example.com';
      // before the count: nothing reveals the cashbox / vault to a counting role
      assert.equal((await getJ(counter, `/api/v1/cash/collections/expected/${mId}`)).cashCents, null);
      assert.equal((await getJ(counter, `/api/v1/vault/status?casinoId=${L.id}`)).balanceCents, null);
      const accounts = await getJ(counter, `/api/v1/ledger/accounts?casinoId=${L.id}`);
      for (const a of accounts.filter((x: any) => ['VAULT', 'CASHBOX', 'DRAWER'].includes(x.kind))) assert.deepEqual([a.balance_cents, a.blind], [null, true], a.kind);
      assert.ok(accounts.some((x: any) => x.kind === 'TICKET_LIABILITY' || x.kind === 'GAMING_RESULT' || x.balance_cents !== null), 'other accounts stay visible');
      const meters = await getJ(counter, `/api/v1/money/reconciliation/meters?casinoId=${L.id}`);
      const line = meters.machines.find((x: any) => x.machineId === mId).lines.find((l: any) => l.type === 'CASH_IN');
      assert.deepEqual([meters.blind, line.meterCents, line.ledgerCents, line.unexplainedCents], [true, null, null, 0]);
      const floorView = await getJ('floor@example.com', `/api/v1/money/reconciliation/meters?casinoId=${L.id}`);
      assert.equal(floorView.machines.find((x: any) => x.machineId === mId).lines.find((l: any) => l.type === 'CASH_IN').meterCents, 8_000, 'a non-counting supervisor sees the amounts');
      // the first counter can submit the physical count
      const before = await q('SELECT count(*)::int n FROM money_transactions WHERE machine_id = $1', [mId]);
      const cnt = await post(counter, `/api/v1/machines/${mId}/collections/count`, { totalCents: 7_900 });
      assert.equal(cnt.statusCode, 200, cnt.body);
      assert.equal(cnt.json().total_cents, 7_900);
      assert.equal(cnt.json().expected_cents, undefined, 'the count response carries no expectation');
      // ... and still cannot see the expectation of the own count
      assert.equal((await get_(counter, `/api/v1/counts/${cnt.json().id}/review`)).statusCode, 403);
      assert.equal((await getJ(counter, `/api/v1/cash/collections/expected/${mId}`)).cashCents, null);
      // an unauthorized role can neither review nor verify
      assert.equal((await get_('cashier@example.com', `/api/v1/counts/${cnt.json().id}/review`)).statusCode, 403);
      assert.equal((await post('cashier@example.com', `/api/v1/machines/collections/counts/${cnt.json().id}/verify`, { totalCents: 7_900 })).statusCode, 403);
      // the counter cannot approve the own count
      assert.match((await post(counter, `/api/v1/machines/collections/counts/${cnt.json().id}/verify`, { totalCents: 7_900 })).json().error, /different employee/);
      // the second verifier sees count, expectation and difference
      const rv = await getJ('admin@example.com', `/api/v1/counts/${cnt.json().id}/review`);
      assert.deepEqual([rv.countedCents, rv.expectedCents, rv.differenceCents, rv.countedByName], [7_900, 8_000, -100, (await one('SELECT name FROM employees WHERE id = $1', [c.emp[counter]])).name]);
      // reject (own different count): nothing booked, cashbox unchanged, audit with both people
      const rej = (await post('admin@example.com', `/api/v1/machines/collections/counts/${cnt.json().id}/verify`, { totalCents: 8_000 })).json();
      assert.equal(rej.matches, false);
      assert.deepEqual(await q('SELECT count(*)::int n FROM money_transactions WHERE machine_id = $1', [mId]), before, 'a rejected count books nothing');
      assert.equal(await ledger.getBalance(c.pool as never, c.orgId, { kind: 'CASHBOX', casinoId: L.id, machineId: mId } as never), 8_000);
      const ra = await one(`SELECT actor_id, details FROM audit_logs WHERE action = 'machine.collection_count_mismatch' AND entity_id = $1`, [cnt.json().id]);
      assert.deepEqual([ra.actor_id, ra.details.countedBy, ra.details.verifiedBy, ra.details.counted, ra.details.verified], [c.emp['admin@example.com'], c.emp[counter], c.emp['admin@example.com'], 7_900, 8_000]);
      // recount (blind again), approve: the existing settlement (difference + drop, reviewer as approver)
      const cnt2 = await post(counter, `/api/v1/machines/${mId}/collections/count`, { totalCents: 7_950 });
      assert.equal((await getJ('admin@example.com', `/api/v1/counts/${cnt2.json().id}/review`)).differenceCents, -50);
      const ok = (await post('admin@example.com', `/api/v1/machines/collections/counts/${cnt2.json().id}/verify`, { totalCents: 7_950 })).json();
      assert.deepEqual([ok.matches, Number(ok.settlement.difference_cents)], [true, -50]);
      const txs = await q('SELECT type, amount_cents, actor_id, approved_by FROM money_transactions WHERE machine_id = $1 AND type IN ($2, $3) ORDER BY type', [mId, 'MACHINE_DROP', 'MACHINE_DROP_DIFFERENCE']);
      assert.deepEqual(txs.map((t) => [t.type, Number(t.amount_cents), t.actor_id, t.approved_by]), [
        ['MACHINE_DROP', 7_950, c.emp[counter], c.emp['admin@example.com']],
        ['MACHINE_DROP_DIFFERENCE', -50, c.emp[counter], c.emp['admin@example.com']],
      ]);
      const sa = await one(`SELECT details FROM audit_logs WHERE action = 'machine.collection_settled' AND entity_id = $1`, [cnt2.json().id]);
      assert.deepEqual([sa.details.countedBy, sa.details.verifiedBy, sa.details.ledgerCents, sa.details.countedCents], [c.emp[counter], c.emp['admin@example.com'], 8_000, 7_950]);
      assert.equal((await get_('admin@example.com', `/api/v1/counts/${cnt2.json().id}/review`)).statusCode, 409, 'nothing to review after verification');
      // vault close count: blind for the counter, reviewed by a second person (vault balance disclosed there only)
      const vs = await getJ(counter, `/api/v1/vault/status?casinoId=${L.id}`);
      const vaultLedger = await ledger.getBalance(c.pool as never, c.orgId, { kind: 'VAULT', casinoId: L.id, vaultId: L.vault } as never);
      const close = await post(counter, `/api/v1/vault/sessions/${vs.session.id}/close`, { totalCents: vaultLedger });
      assert.equal(close.statusCode, 200, close.body);
      const vc = (await getJ(counter, `/api/v1/vault/status?casinoId=${L.id}`)).pendingCounts[0];
      assert.equal(vc.total_cents, undefined);
      assert.equal((await get_(counter, `/api/v1/counts/${vc.id}/review`)).statusCode, 403);
      const vr = await getJ('admin@example.com', `/api/v1/counts/${vc.id}/review`);
      assert.deepEqual([vr.basis, vr.expectedCents, vr.differenceCents], ['LEDGER_VAULT', vaultLedger, 0]);
      assert.equal((await post('admin@example.com', `/api/v1/vault/counts/${vc.id}/verify`, { totalCents: vaultLedger })).json().matches, true);
      const va = await one(`SELECT details FROM audit_logs WHERE action = 'vault.count_settled' AND entity_id = $1`, [vc.id]);
      assert.deepEqual([va.details.countedBy, va.details.verifiedBy], [c.emp[counter], c.emp['admin@example.com']]);
    });

    test('blind drawer and movements: the cashier gets no own drawer balance from any view, supervisors do; the receiver of an open fill / drop / hopper fill gets no amount', async () => {
      const L = await createLedgerCasino(c.pool as never, { orgId: c.orgId, code: `7ED${Date.now() % 100000}`, machines: 1, gateway: true });
      await ensureVaultOpen(c.pool as never, L);
      // a supervisor working a drawer (manager) is blind on the own drawer too
      const shift = await openLedgerShift(c.pool as never, L, { cashierEmail: 'manager@example.com', vaultEmail: 'admin@example.com', floatCents: 30_000 });
      const own = (await getJ('manager@example.com', '/api/v1/cashier/session')).session;
      assert.deepEqual([own.blind, own.expected], [true, null]);
      assert.equal((await getJ('manager@example.com', `/api/v1/cashier/desks?casinoId=${L.id}`)).find((d: any) => d.session_id === shift).balance, null);
      assert.equal((await getJ('manager@example.com', `/api/v1/cashier/sessions?casinoId=${L.id}`)).find((x: any) => x.id === shift).current_balance, null);
      const ov = await getJ('manager@example.com', `/api/v1/cash/overview?casinoId=${L.id}`);
      assert.equal(Number(ov.open.in_drawers), 0, 'own drawer left out of the overview');
      assert.ok(ov.today.every((t: any) => t.type !== 'FILL'), 'own drawer movements left out');
      // another supervisor sees it
      assert.equal(Number((await getJ('floor@example.com', `/api/v1/cashier/desks?casinoId=${L.id}`)).find((d: any) => d.session_id === shift).balance), 300);
      assert.equal(Number((await getJ('admin@example.com', `/api/v1/cash/overview?casinoId=${L.id}`)).open.in_drawers), 300);
      // open fill: the receiving cashier gets no amount, the issuer does
      const fill = await post('admin@example.com', '/api/v1/cash/movements', { kind: 'FILL', cashierSessionId: shift, amountCents: 12_300 });
      const mine = (await getJ('manager@example.com', `/api/v1/cash/movements?casinoId=${L.id}&status=REQUESTED`)).find((x: any) => x.id === fill.json().movement.id);
      assert.equal(mine.amount_cents, null);
      assert.equal((await getJ('admin@example.com', `/api/v1/cash/movements?casinoId=${L.id}&status=REQUESTED`)).find((x: any) => x.id === fill.json().movement.id).amount_cents, 12_300);
      assert.equal((await post('manager@example.com', `/api/v1/cash/movements/${fill.json().movement.id}/confirm`, { totalCents: 12_300 })).json().movement.status, 'CONFIRMED');
      // open drop: the vault (confirming side) gets no amount
      const drop = await post('manager@example.com', '/api/v1/cash/movements', { kind: 'DROP', amountCents: 5_000 });
      assert.equal((await getJ('admin@example.com', `/api/v1/vault/status?casinoId=${L.id}`)).movements.find((x: any) => x.id === drop.json().movement.id).amount_cents, null);
      assert.equal((await getJ('admin@example.com', `/api/v1/cash/movements?casinoId=${L.id}&status=REQUESTED`)).find((x: any) => x.id === drop.json().movement.id).amount_cents, null);
      assert.equal((await post('admin@example.com', `/api/v1/cash/movements/${drop.json().movement.id}/confirm`, { totalCents: 5_000 })).json().movement.status, 'CONFIRMED');
      // open hopper fill: hidden from the confirming side, shown to the requester
      const hf = await post('manager@example.com', `/api/v1/machines/${L.machines[0].id}/hopper-fills`, { amountCents: 2_000 });
      assert.equal((await getJ('admin@example.com', `/api/v1/vault/status?casinoId=${L.id}`)).movements.find((x: any) => x.id === hf.json().movement.id).amount_cents, null);
      assert.equal((await getJ('manager@example.com', `/api/v1/vault/status?casinoId=${L.id}`)).movements.find((x: any) => x.id === hf.json().movement.id).amount_cents, 2_000);
      assert.equal((await getJ('attendant@example.com', `/api/v1/machines/${L.machines[0].id}/money`)).hopperFills[0].amount_cents, undefined);
      // the close count is still blind and the approved short / over flow follows
      const closeCount = await post('manager@example.com', '/api/v1/cashier/session/close', { countedBalance: 373 });
      assert.equal(closeCount.statusCode, 200, closeCount.body);
      assert.equal(closeCount.json().expected, undefined);
    });

    test('read views write nothing and every one of them is permission-guarded', async () => {
      const before = await counts();
      const urls: Array<[string, string, number]> = [
        ['cashier@example.com', `/api/v1/operator/context?casinoId=${cid()}`, 200],
        ['cashier@example.com', '/api/v1/cashier/shift', 200],
        ['cashier@example.com', `/api/v1/players/lookup/${st.card}`, 200],
        ['manager@example.com', `/api/v1/vault/status?casinoId=${cid()}`, 200],
        ['floor@example.com', `/api/v1/money/deferred?casinoId=${cid()}&status=ALL`, 200],
        ['floor@example.com', `/api/v1/money/day-close/status?casinoId=${cid()}`, 200],
        ['floor@example.com', `/api/v1/money/reconciliation/meters?casinoId=${cid()}`, 200],
        ['attendant@example.com', `/api/v1/machines/${m(0).id}/money`, 200],
        ['manager@example.com', `/api/v1/money/counts?casinoId=${cid()}`, 200],
        ['floor@example.com', `/api/v1/approvals?casinoId=${cid()}&status=ALL`, 200],
        ['floor@example.com', `/api/v1/machines/event-exceptions?casinoId=${cid()}`, 200],
        ['cashier@example.com', `/api/v1/money/day-close/status?casinoId=${cid()}`, 403],
        ['cashier@example.com', `/api/v1/money/reconciliation/meters?casinoId=${cid()}`, 403],
        ['cashier@example.com', `/api/v1/money/deferred?casinoId=${cid()}`, 403],
        ['cashier@example.com', `/api/v1/money/counts?casinoId=${cid()}`, 403],
        ['floor@example.com', '/api/v1/cashier/shift', 403],
        ['floor@example.com', `/api/v1/vault/status?casinoId=${cid()}`, 403],
      ];
      for (const [email, url, code] of urls) assert.equal((await get_(email, url)).statusCode, code, `${email} ${url}`);
      assert.equal((await c.app.inject({ method: 'GET', url: '/api/v1/operator/context' })).statusCode, 401);
      assert.deepEqual(await counts(), before);
      const ledger = await import('../src/services/ledger');
      assert.equal((await ledger.checkLedgerInvariants(c.pool as never, c.orgId)).ok, true);
    });
  });
}
