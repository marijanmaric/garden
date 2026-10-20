import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { withTransaction, type Pool } from '@m1/database';
import { setupTestDatabase } from './helpers';

let app: FastifyInstance;
let pool: Pool;
let svc: typeof import('../src/services/players');
let ingestEvents: typeof import('../src/services/ingest').ingestEvents;
let orgId: string;
let orgB: string;
let casinoId: string;
let gw: { id: string; orgId: string; casinoId: string; deviceId: string };
let machines: Record<string, { id: string; code: string }>;
let actor: { orgId: string; employeeId: string; employeeEmail: string };
let cashierToken: string;
let adminToken: string;

const tx = <T>(fn: (db: import('@m1/database').PoolClient) => Promise<T>) => withTransaction(pool, fn);
const uniqueCard = () => `T-${randomUUID().slice(0, 8)}`;

async function login(email: string) {
  return (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'demo' } })).json().token as string;
}

async function machineEvent(asset: string, type: string, extra: Record<string, unknown> = {}) {
  const r = await ingestEvents(gw, [{ eventId: randomUUID(), type: type as never, machineId: machines[asset].code, timestamp: new Date().toISOString(), ...extra }]);
  assert.equal(r.accepted, 1);
}

async function openSessionOf(asset: string) {
  return (await pool.query('SELECT ps.* FROM machines m JOIN player_sessions ps ON ps.id = m.current_session_id WHERE m.id = $1', [machines[asset].id])).rows[0];
}

async function newPlayer(cardNumber = uniqueCard()) {
  return tx((db) => svc.createPlayer(db, actor, { homeCasinoId: casinoId, profile: { firstName: 'Test', lastName: 'Player' }, card: { cardNumber } }));
}

before(async () => {
  ({ app, pool } = await setupTestDatabase());
  svc = await import('../src/services/players');
  ({ ingestEvents } = await import('../src/services/ingest'));
  const g = (await pool.query(`SELECT id, org_id, casino_id, device_id FROM gateways WHERE device_id = 'GW-VIE-001'`)).rows[0];
  gw = { id: g.id, orgId: g.org_id, casinoId: g.casino_id, deviceId: g.device_id };
  orgId = g.org_id;
  casinoId = g.casino_id;
  orgB = (await pool.query(`SELECT id FROM organizations WHERE slug = 'riverside'`)).rows[0].id;
  const m = await pool.query('SELECT id, machine_code, asset_no FROM machines WHERE org_id = $1', [orgId]);
  machines = Object.fromEntries(m.rows.map((r) => [r.asset_no, { id: r.id, code: r.machine_code }]));
  const admin = (await pool.query(`SELECT id, email FROM employees WHERE email = 'admin@example.com'`)).rows[0];
  actor = { orgId, employeeId: admin.id, employeeEmail: admin.email };
  cashierToken = await login('cashier@example.com');
  adminToken = await login('admin@example.com');
});

after(async () => {
  await app?.close();
  await pool?.end();
});

describe('migration state', () => {
  test('fresh database: 003 applied (004 ledger and 005 entities since Steps 3/4), no backfill migration (006) yet', async () => {
    const applied = (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
    assert.deepEqual(applied, ['001_init.sql', '002_phase2_cash_tickets.sql', '002a_hotfix_handpay_idempotency.sql', '003_player_identity.sql', '004_money_ledger.sql', '005_money_entities.sql', '006_money_cutover.sql', '007_ledger_cash_ops.sql', '008_handpay_ledger.sql', '009_deferred_money_events.sql', '010_tito_ledger.sql', '011_machine_cashless_ledger.sql', '012_saas_entitlements.sql', '013_handpay_ticket_payout.sql']);
  });

  test('seed writes identity tables only, never the legacy columns', async () => {
    const legacy = (await pool.query('SELECT count(*)::int n FROM players WHERE card_number IS NOT NULL OR first_name IS NOT NULL OR last_name IS NOT NULL')).rows[0].n;
    assert.equal(legacy, 0);
    const counts = (await pool.query(`SELECT (SELECT count(*)::int FROM players WHERE org_id = $1) p, (SELECT count(*)::int FROM player_cards WHERE org_id = $1 AND status = 'ACTIVE') c, (SELECT count(*)::int FROM player_profiles WHERE org_id = $1) pr`, [orgId])).rows[0];
    assert.equal(counts.p, 60);
    assert.equal(counts.c, 60);
    assert.equal(counts.pr, 60);
  });
});

describe('players and cards', () => {
  test('creating a player creates identity, profile and card with a unique player_no', async () => {
    const a = await newPlayer();
    const b = await newPlayer();
    assert.match(a.player.player_no, /^P\d{8}$/);
    assert.notEqual(a.player.player_no, b.player.player_no);
    assert.equal(a.card?.status, 'ACTIVE');
    const profile = (await pool.query('SELECT first_name FROM player_profiles WHERE player_id = $1', [a.player.id])).rows[0];
    assert.equal(profile.first_name, 'Test');
  });

  test('player_no is unique per organisation', async () => {
    const a = await newPlayer();
    await assert.rejects(pool.query('INSERT INTO players (org_id, player_no) VALUES ($1, $2)', [orgId, a.player.player_no]), /players_org_player_no_key/);
    await pool.query('INSERT INTO players (org_id, player_no) VALUES ($1, $2)', [orgB, a.player.player_no]);
  });

  test('card number is unique per organisation, reusable in another organisation', async () => {
    const number = uniqueCard();
    await newPlayer(number);
    await assert.rejects(newPlayer(number), /Card number already in use/);
    const other = await tx((db) => svc.createPlayer(db, { orgId: orgB }, { card: { cardNumber: number } }));
    assert.equal(other.card?.card_number, number);
  });

  test('a card number resolves to exactly one player', async () => {
    const res = await svc.resolveCard(pool, orgId, 'PC-00001');
    assert.equal(res.ok, true);
    const rows = (await pool.query(`SELECT player_id FROM player_cards WHERE org_id = $1 AND card_number = 'PC-00001'`, [orgId])).rows;
    assert.equal(rows.length, 1);
    assert.equal(res.ok && res.player.id, rows[0].player_id);
    assert.deepEqual(await svc.resolveCard(pool, orgId, 'NOPE-1234'), { ok: false, reason: 'UNKNOWN_CARD' });
  });

  test('blocked, lost and replaced cards cannot be used; blocked can be unblocked', async () => {
    const { card } = await newPlayer();
    await tx((db) => svc.setCardStatus(db, actor, card!.id, 'BLOCKED', 'player request'));
    assert.equal((await svc.resolveCard(pool, orgId, card!.card_number)).ok, false);
    await tx((db) => svc.setCardStatus(db, actor, card!.id, 'ACTIVE', 'found'));
    assert.equal((await svc.resolveCard(pool, orgId, card!.card_number)).ok, true);
    await tx((db) => svc.setCardStatus(db, actor, card!.id, 'LOST', 'reported lost'));
    const lost = await svc.resolveCard(pool, orgId, card!.card_number);
    assert.equal(!lost.ok && lost.reason, 'CARD_LOST');
    await assert.rejects(tx((db) => svc.setCardStatus(db, actor, card!.id, 'ACTIVE')), /cannot change/);
    await assert.rejects(pool.query(`UPDATE player_cards SET status = 'ACTIVE' WHERE id = $1`, [card!.id]), /terminal status/);
  });

  test('a replacement card resolves to the same player; the old card is retired', async () => {
    const { player, card } = await newPlayer();
    const newNumber = uniqueCard();
    const r = await tx((db) => svc.replaceCard(db, actor, card!.id, { cardNumber: newNumber }, 'worn out'));
    const fresh = await svc.resolveCard(pool, orgId, newNumber);
    assert.equal(fresh.ok && fresh.player.id, player.id);
    const old = await svc.resolveCard(pool, orgId, card!.card_number);
    assert.equal(!old.ok && old.reason, 'CARD_REPLACED');
    const oldRow = (await pool.query('SELECT replaced_by_card_id FROM player_cards WHERE id = $1', [card!.id])).rows[0];
    assert.equal(oldRow.replaced_by_card_id, r.card.id);
    await assert.rejects(pool.query('UPDATE player_cards SET player_id = $2 WHERE id = $1', [r.card.id, randomUUID()]), /immutable/);
    await assert.rejects(pool.query('DELETE FROM player_cards WHERE id = $1', [r.card.id]), /append-only/);
  });

  test('a lost card can be replaced and stays LOST', async () => {
    const { player, card } = await newPlayer();
    await tx((db) => svc.setCardStatus(db, actor, card!.id, 'LOST'));
    const r = await tx((db) => svc.replaceCard(db, actor, card!.id, { cardNumber: uniqueCard() }));
    assert.equal(r.card.player_id, player.id);
    assert.equal((await pool.query('SELECT status FROM player_cards WHERE id = $1', [card!.id])).rows[0].status, 'LOST');
  });

  test('only one active card per player', async () => {
    const { player } = await newPlayer();
    await assert.rejects(tx((db) => svc.issueCard(db, actor, player.id, { cardNumber: uniqueCard() })), /already has an active card/);
  });

  test('blocking a card does not change the player or money records linked to the player', async () => {
    const { player, card } = await newPlayer();
    const desks = (await app.inject({ method: 'GET', url: `/api/v1/cashier/desks?casinoId=${casinoId}`, headers: { authorization: `Bearer ${cashierToken}` } })).json();
    const open = await app.inject({ method: 'POST', url: '/api/v1/cashier/session/open', headers: { authorization: `Bearer ${cashierToken}`, 'idempotency-key': `k-${randomUUID()}` }, payload: { cashDeskId: desks[0].id, openingBalance: 1000 } });
    assert.equal(open.statusCode, 200, open.body);
    const cashIn = (cardNumber: string) =>
      app.inject({ method: 'POST', url: '/api/v1/cashier/transactions', headers: { authorization: `Bearer ${cashierToken}`, 'idempotency-key': `k-${randomUUID()}` }, payload: { type: 'CASH_IN', amount: 40, playerCard: cardNumber } });
    assert.equal((await cashIn(card!.card_number)).statusCode, 200);
    const before = (await pool.query('SELECT id, amount, player_id FROM cash_transactions WHERE player_id = $1', [player.id])).rows;
    await tx((db) => svc.setCardStatus(db, actor, card!.id, 'BLOCKED'));
    const blocked = await cashIn(card!.card_number);
    assert.equal(blocked.statusCode, 409);
    assert.match(blocked.json().error, /blocked/);
    const afterRows = (await pool.query('SELECT id, amount, player_id FROM cash_transactions WHERE player_id = $1', [player.id])).rows;
    assert.deepEqual(afterRows, before);
  });
});

describe('player status', () => {
  test('ACTIVE card login starts a carded session with the card id', async () => {
    const { player, card } = await newPlayer();
    await machineEvent('M013', 'PLAYER_LOGIN', { playerCardId: card!.card_number });
    const s = await openSessionOf('M013');
    assert.equal(s.player_id, player.id);
    assert.equal(s.card_id, card!.id);
    await machineEvent('M013', 'PLAYER_LOGOUT', { playerCardId: card!.card_number });
  });

  for (const status of ['SUSPENDED', 'EXCLUDED'] as const) {
    test(`${status} player cannot log in with a card and cannot get a new card`, async () => {
      const { player, card } = await newPlayer();
      await tx((db) => svc.changePlayerStatus(db, actor, player.id, status, 'test case'));
      await machineEvent('M014', 'PLAYER_LOGIN', { playerCardId: card!.card_number });
      assert.equal(await openSessionOf('M014'), undefined);
      const alert = (await pool.query(`SELECT message FROM alerts WHERE machine_id = $1 AND type = 'CARD_REJECTED' AND status <> 'RESOLVED'`, [machines.M014.id])).rows[0];
      assert.match(alert.message, new RegExp(status));
      await pool.query(`UPDATE alerts SET status = 'RESOLVED' WHERE machine_id = $1 AND type = 'CARD_REJECTED'`, [machines.M014.id]);
      await assert.rejects(tx((db) => svc.replaceCard(db, actor, card!.id, { cardNumber: uniqueCard() })), /does not allow CARD_ISSUE/);
      assert.throws(() => svc.assertCapability({ status }, 'WALLET_DEPOSIT'), /does not allow/);
      assert.throws(() => svc.assertCapability({ status }, 'CASHLESS_TO_MACHINE'), /does not allow/);
    });
  }

  test('EXCLUDED may still withdraw an existing wallet balance (as documented)', () => {
    svc.assertCapability({ status: 'EXCLUDED' }, 'WALLET_WITHDRAW');
    assert.throws(() => svc.assertCapability({ status: 'SUSPENDED' }, 'WALLET_WITHDRAW'));
  });

  test('CLOSED is terminal and allows no financial activity', async () => {
    const { player } = await newPlayer();
    await tx((db) => svc.changePlayerStatus(db, actor, player.id, 'CLOSED', 'account closed'));
    await assert.rejects(tx((db) => svc.changePlayerStatus(db, actor, player.id, 'ACTIVE', 'reopen')), /cannot change/);
    await assert.rejects(pool.query(`UPDATE players SET status = 'ACTIVE' WHERE id = $1`, [player.id]), /terminal/);
    for (const c of ['WALLET_DEPOSIT', 'WALLET_WITHDRAW', 'CASHLESS_TO_MACHINE', 'CASHLESS_FROM_MACHINE', 'HANDPAY_TO_WALLET', 'CASH_ADVANCE'] as const)
      assert.throws(() => svc.assertCapability({ status: 'CLOSED' }, c));
    const history = (await pool.query('SELECT from_status, to_status FROM player_status_history WHERE player_id = $1 ORDER BY id', [player.id])).rows;
    assert.deepEqual(history.map((h) => h.to_status), ['ACTIVE', 'CLOSED']);
  });

  test('status changes need a reason', async () => {
    const { player } = await newPlayer();
    await assert.rejects(tx((db) => svc.changePlayerStatus(db, actor, player.id, 'SUSPENDED', '')), /reason/);
  });
});

describe('verification and personal data', () => {
  test('only masked and hashed document numbers are stored', async () => {
    const { player } = await newPlayer();
    const raw = 'X1234567Z';
    await tx((db) => svc.recordVerification(db, actor, player.id, { status: 'VERIFIED', documentType: 'PASSPORT', documentCountry: 'AT', documentNumber: raw }));
    const row = (await pool.query('SELECT * FROM player_verifications WHERE player_id = $1', [player.id])).rows[0];
    assert.equal(row.document_number_masked, '*****567Z');
    assert.equal(row.document_number_hash, svc.hashDocumentNumber(orgId, raw));
    assert.ok(!JSON.stringify(row).includes(raw), 'raw number never stored');
    const audit = (await pool.query(`SELECT details FROM audit_logs WHERE entity_id = $1 AND action = 'player.verification_recorded'`, [player.id])).rows[0];
    assert.ok(!JSON.stringify(audit).includes(raw));
    assert.equal((await pool.query('SELECT verification_status FROM players WHERE id = $1', [player.id])).rows[0].verification_status, 'VERIFIED');
    await assert.rejects(pool.query('UPDATE player_verifications SET status = $2 WHERE id = $1', [row.id, 'REJECTED']), /append-only/);
  });

  test('verification threshold is configurable and not set by default', async () => {
    const row = (await pool.query('SELECT verification_threshold_cents FROM organizations WHERE id = $1', [orgId])).rows[0];
    assert.equal(row.verification_threshold_cents, null);
  });

  test('deleting a profile keeps money and gaming records valid', async () => {
    const { player, card } = await newPlayer();
    await machineEvent('M015', 'PLAYER_LOGIN', { playerCardId: card!.card_number });
    await machineEvent('M015', 'GAME_PLAYED', { amount: 2, win: 0 });
    await machineEvent('M015', 'PLAYER_LOGOUT', { playerCardId: card!.card_number });
    const tx1 = (await pool.query('SELECT count(*)::int n FROM gaming_transactions WHERE player_id = $1', [player.id])).rows[0].n;
    await pool.query('DELETE FROM player_profiles WHERE player_id = $1', [player.id]);
    assert.equal((await pool.query('SELECT count(*)::int n FROM gaming_transactions WHERE player_id = $1', [player.id])).rows[0].n, tx1);
    assert.ok(tx1 > 0);
    assert.equal((await svc.resolveCard(pool, orgId, card!.card_number)).ok, true);
  });

  test('legacy columns are read-only', async () => {
    await assert.rejects(pool.query(`INSERT INTO players (org_id, card_number) VALUES ($1, 'LEG-1')`, [orgId]), /legacy read-only/);
    const { player } = await newPlayer();
    await assert.rejects(pool.query(`UPDATE players SET card_number = 'LEG-2' WHERE id = $1`, [player.id]), /legacy read-only/);
    await assert.rejects(pool.query(`UPDATE players SET first_name = 'X' WHERE id = $1`, [player.id]), /legacy read-only/);
  });
});

describe('existing gaming and player functionality', () => {
  test('carded play updates session and legacy loyalty counters as before', async () => {
    await machineEvent('M016', 'PLAYER_LOGIN', { playerCardId: 'PC-00002' });
    const s = await openSessionOf('M016');
    const before = (await pool.query('SELECT points, total_coin_in FROM players WHERE id = $1', [s.player_id])).rows[0];
    await machineEvent('M016', 'GAME_PLAYED', { amount: 5, win: 0 });
    const after = (await pool.query('SELECT points, total_coin_in FROM players WHERE id = $1', [s.player_id])).rows[0];
    assert.equal(after.points - before.points, 5);
    assert.equal((await pool.query('SELECT coin_in FROM player_sessions WHERE id = $1', [s.id])).rows[0].coin_in, 5);
    const machine = (await app.inject({ method: 'GET', url: `/api/v1/machines/${machines.M016.id}`, headers: { authorization: `Bearer ${adminToken}` } })).json();
    assert.equal(machine.player_card, 'PC-00002');
    assert.ok(machine.player_name);
  });

  test('player search finds players by card and name with the same response shape', async () => {
    const byCard = (await app.inject({ method: 'GET', url: '/api/v1/players?search=PC-00003', headers: { authorization: `Bearer ${adminToken}` } })).json();
    assert.equal(byCard.length, 1);
    for (const k of ['id', 'card_number', 'first_name', 'last_name', 'tier', 'points', 'total_coin_in', 'visits', 'player_no', 'status']) assert.ok(k in byCard[0], k);
    const byName = (await app.inject({ method: 'GET', url: `/api/v1/players?search=${encodeURIComponent(byCard[0].last_name)}`, headers: { authorization: `Bearer ${adminToken}` } })).json();
    assert.ok(byName.some((p: { id: string }) => p.id === byCard[0].id));
    const dash = (await app.inject({ method: 'GET', url: '/api/v1/dashboard', headers: { authorization: `Bearer ${adminToken}` } })).json();
    assert.ok(dash.topPlayers[0].card_number && dash.topPlayers[0].first_name);
  });

  test('legacy event names from old gateways are normalised (stored canonical, original kept)', async () => {
    const before = (await pool.query('SELECT cash_in, tickets_out FROM machine_meters WHERE machine_id = $1', [machines.M017.id])).rows[0];
    await machineEvent('M017', 'COIN_IN', { amount: 20 });
    await machineEvent('M017', 'TICKET_OUT', { amount: 15, ticketBarcode: '123456789012345678' });
    const ev = (await pool.query(`SELECT type, payload FROM machine_events WHERE machine_id = $1 ORDER BY id DESC LIMIT 2`, [machines.M017.id])).rows;
    assert.deepEqual(ev.map((e) => e.type).sort(), ['CASH_IN', 'TITO_OUT']);
    assert.deepEqual(ev.map((e) => e.payload.legacyType).sort(), ['COIN_IN', 'TICKET_OUT']);
    const after = (await pool.query('SELECT cash_in, tickets_out FROM machine_meters WHERE machine_id = $1', [machines.M017.id])).rows[0];
    assert.equal(after.cash_in - before.cash_in, 20);
    assert.equal(after.tickets_out - before.tickets_out, 15);
    assert.equal((await pool.query(`SELECT status FROM tickets WHERE barcode = '123456789012345678'`)).rows[0].status, 'VALID');
  });
});
