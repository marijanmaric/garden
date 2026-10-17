import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hasPermission } from '@m1/shared';
import { HttpError, guard, scopeCasino } from '../auth';
import { pool } from '../db';
import { cardRejectionMessage, resolveCard } from '../services/players';
import { walletBalances } from '../services/wallets';
import { countsTargets, reviewCount } from '../services/blind-count';
import { railsInUse } from '../services/reconciliation';
import { loadEntitlements, requireFeature } from '../services/entitlements';

/**
 * Step 7e: read-only views for the operator screens (cashier, vault, approvals, admin, reconciliation,
 * machines, players). Nothing here writes, books or decides: every money action of these screens goes
 * through the existing idempotent routes, so the accounting stays where it was approved (7a-7d).
 * Balances shown here come from the ledger (ledger_balances / wallet_balances), never computed by the UI.
 */
const casinoQuery = z.object({ casinoId: z.string().uuid().optional() });

/**
 * Amount of an open vault movement as seen by the viewer ($3 employee, $4 may confirm drops (cash.manage),
 * $5 may confirm hopper fills (cash.transact)): the receiving side confirms with its own blind count, so a
 * requested amount is hidden from whoever could confirm it; the requester always sees it.
 */
const MOVEMENT_AMOUNT = `CASE WHEN m.status <> 'REQUESTED' OR m.requested_by = $3 THEN m.amount_cents
  WHEN m.kind = 'FILL' AND m.cashier_session_id IS NOT NULL AND (SELECT employee_id FROM cashier_sessions WHERE id = m.cashier_session_id) = $3 THEN NULL
  WHEN m.kind = 'DROP' AND $4::boolean THEN NULL
  WHEN m.kind = 'HOPPER_FILL' AND $5::boolean THEN NULL
  ELSE m.amount_cents END`;
const rows = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows;

/** Machine money event types and the ledger transaction types that book them (ledger <-> meters). */
const METER_TYPES: Record<string, string[]> = {
  CASH_IN: ['MACHINE_CASH_IN'],
  CASH_OUT: ['MACHINE_CASH_OUT'],
  TITO_IN: ['TITO_REDEEM_MACHINE'],
  TITO_OUT: ['TITO_ISSUE_MACHINE'],
  CASHLESS_IN: ['WALLET_TO_MACHINE_CONFIRM', 'WALLET_TO_MACHINE_LATE_CONFIRM'],
  CASHLESS_OUT: ['MACHINE_TO_WALLET'],
};

async function casinoToday(casinoId: string): Promise<string> {
  return (await rows(`SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM casinos WHERE id = $1`, [casinoId]))[0].d;
}

async function railModes(orgId: string, casinoId: string) {
  const cut = await rows(`SELECT rail, machine_id FROM money_rail_cutovers WHERE org_id = $1 AND (casino_id = $2 OR rail = 'CASHLESS')`, [orgId, casinoId]);
  const mode = (rail: string) => (cut.some((r) => r.rail === rail) ? 'LEDGER' : 'LEGACY');
  return {
    rails: { VAULT: mode('VAULT'), CASH: mode('CASH'), HANDPAY: mode('HANDPAY'), TITO: mode('TITO'), CASHLESS: mode('CASHLESS') },
    ledgerMachines: cut.filter((r) => r.rail === 'MACHINE').map((r) => r.machine_id as string),
  };
}

async function activeFreezes(orgId: string, casinoId: string) {
  return rows(
    `SELECT f.id, f.rail, f.casino_id, f.machine_id, m.asset_no, f.reason, f.frozen_at, f.reconciliation_run_id
     FROM money_rail_freezes f LEFT JOIN machines m ON m.id = f.machine_id
     WHERE f.org_id = $1 AND f.lifted_at IS NULL AND (f.casino_id = $2 OR f.casino_id IS NULL) ORDER BY f.frozen_at`,
    [orgId, casinoId]);
}

export async function operatorRoutes(app: FastifyInstance) {
  /** Rail modes, active freezes and approval limits: lets every screen show guards before an action. */
  app.get('/api/v1/operator/context', { config: { feature: 'core' }, preHandler: guard() }, async (req) => {
    const casinoId = scopeCasino(req, casinoQuery.parse(req.query).casinoId);
    const [modes, freezes, settings, today] = await Promise.all([
      railModes(req.auth.orgId, casinoId),
      activeFreezes(req.auth.orgId, casinoId),
      rows(`SELECT handpay_approval_cents, deposit_approval_cents, withdrawal_approval_cents, ticket_payout_approval_cents, short_over_approval_cents
            FROM casino_money_settings WHERE casino_id = $1`, [casinoId]),
      casinoToday(casinoId),
    ]);
    const s = settings[0] ?? {};
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return {
      casinoId, today, ...modes, freezes,
      limits: {
        handpay: n(s.handpay_approval_cents), deposit: n(s.deposit_approval_cents), withdrawal: n(s.withdrawal_approval_cents),
        ticketPayout: n(s.ticket_payout_approval_cents), shortOver: n(s.short_over_approval_cents),
      },
    };
  });

  /**
   * The signed-in cashier's shift including the close states (COUNTING), the fills / drops waiting for a
   * confirmation and the cashier's own approval requests (so the screen can show "waiting for supervisor").
   */
  app.get('/api/v1/cashier/shift', { config: { feature: 'cash' }, preHandler: guard('cash.transact') }, async (req) => {
    const s = (await rows(
      `SELECT s.id, s.status, s.casino_id, s.opened_at, s.cash_desk_id, d.name AS desk_name,
         EXISTS (SELECT 1 FROM money_rail_cutovers c WHERE c.org_id = s.org_id AND c.casino_id = s.casino_id AND c.rail = 'CASH') AS ledger
       FROM cashier_sessions s JOIN cash_desks d ON d.id = s.cash_desk_id
       WHERE s.org_id = $1 AND s.employee_id = $2 AND s.status IN ('OPEN', 'COUNTING')`, [req.auth.orgId, req.auth.sub]))[0] ?? null;
    const myApprovals = await rows(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.amount_cents, a.status, a.created_at, a.expires_at, a.decided_at, a.decision_note,
         a.payload, e.name AS decided_by_name, t.barcode, m.asset_no
       FROM approvals a LEFT JOIN employees e ON e.id = a.decided_by
       LEFT JOIN tickets t ON a.entity_type = 'ticket' AND t.id::text = a.entity_id
       LEFT JOIN handpays h ON a.entity_type = 'handpay' AND h.id::text = a.entity_id
       LEFT JOIN machines m ON m.id = h.machine_id
       WHERE a.org_id = $1 AND a.requested_by = $2 AND a.created_at > now() - interval '12 hours'
       ORDER BY a.created_at DESC LIMIT 30`, [req.auth.orgId, req.auth.sub]);
    if (!s) return { session: null, movements: [], closeApproval: null, myApprovals };
    const movements = await rows(
      `SELECT m.id, m.kind, m.purpose, m.status, m.requested_at, m.expires_at, m.requested_by, e.name AS requested_by_name,
         CASE WHEN m.requested_by = $2 THEN m.amount_cents END AS amount_cents
       FROM cash_movements m JOIN employees e ON e.id = m.requested_by
       WHERE m.cashier_session_id = $1 AND m.status = 'REQUESTED' ORDER BY m.requested_at`, [s.id, req.auth.sub]);
    const closeApproval = (await rows(
      `SELECT a.id, a.status, a.created_at, a.decision_note FROM approvals a JOIN cash_counts c ON a.entity_id = c.id::text
       WHERE c.cashier_session_id = $1 AND a.action = 'DRAWER_SHORT_OVER' ORDER BY a.created_at DESC LIMIT 1`, [s.id]))[0] ?? null;
    return { session: s, movements, closeApproval, myApprovals };
  });

  /** Player / card lookup with the wallet from the ledger and its recent history (per ledger transaction). */
  app.get('/api/v1/players/lookup/:card', { config: { feature: 'core' }, preHandler: guard() }, async (req) => {
    if (!hasPermission(req.auth.role, 'player.view') && !hasPermission(req.auth.role, 'cash.transact')) throw new HttpError(403, 'Missing permission player.view');
    const { card } = z.object({ card: z.string().trim().min(1).max(40) }).parse(req.params);
    const res = await resolveCard(pool, req.auth.orgId, card);
    if (!res.card || !res.player) throw new HttpError(404, 'Unknown player card');
    const player = (await rows(
      `SELECT p.id, p.player_no, p.status, p.verification_status, p.tier, pr.first_name, pr.last_name, m.asset_no AS current_machine
       FROM players p LEFT JOIN player_profiles pr ON pr.player_id = p.id LEFT JOIN machines m ON m.current_player_id = p.id
       WHERE p.id = $1`, [res.player.id]))[0];
    // the wallet is part of the Cashless module: without it the lookup shows the player and card only
    const cashless = (await loadEntitlements(req.auth.orgId)).inUse.has('CASHLESS');
    const walletRow = cashless ? (await rows('SELECT id, status, status_reason FROM wallets WHERE player_id = $1 AND org_id = $2', [res.player.id, req.auth.orgId]))[0] : undefined;
    let wallet = null;
    if (walletRow) {
      const b = await walletBalances(pool, req.auth.orgId, walletRow.id);
      const [history, transfers, session] = await Promise.all([
        rows(
          `SELECT t.id, t.type, t.amount_cents, t.business_date, t.created_at, m.asset_no, tk.barcode,
             (SELECT sum(le.amount_cents * b.normal_sign) FROM ledger_entries le JOIN ledger_accounts a ON a.id = le.account_id JOIN ledger_balances b ON b.account_id = a.id
               WHERE le.transaction_id = t.id AND a.wallet_id = $1 AND a.kind = 'WALLET_AVAILABLE')::bigint AS available_delta_cents,
             (SELECT sum(le.amount_cents * b.normal_sign) FROM ledger_entries le JOIN ledger_accounts a ON a.id = le.account_id JOIN ledger_balances b ON b.account_id = a.id
               WHERE le.transaction_id = t.id AND a.wallet_id = $1 AND a.kind = 'WALLET_RESERVED')::bigint AS reserved_delta_cents
           FROM money_transactions t LEFT JOIN machines m ON m.id = t.machine_id LEFT JOIN tickets tk ON tk.id = t.ticket_id
           WHERE t.org_id = $2 AND EXISTS (SELECT 1 FROM ledger_entries le JOIN ledger_accounts a ON a.id = le.account_id WHERE le.transaction_id = t.id AND a.wallet_id = $1)
           ORDER BY t.created_at DESC, t.id DESC LIMIT 25`, [walletRow.id, req.auth.orgId]),
        rows(
          `SELECT t.id, t.direction, t.status, t.amount_cents, t.requested_at, m.asset_no FROM wallet_transfers t JOIN machines m ON m.id = t.machine_id
           WHERE t.wallet_id = $1 AND t.status IN ('REQUESTED', 'SENT') ORDER BY t.requested_at`, [walletRow.id]),
        rows(`SELECT s.id, s.opened_at, m.asset_no FROM cashless_sessions s JOIN machines m ON m.id = s.machine_id WHERE s.wallet_id = $1 AND s.status = 'OPEN'`, [walletRow.id]),
      ]);
      wallet = {
        id: walletRow.id, status: walletRow.status, statusReason: walletRow.status_reason,
        availableCents: Number(b.available_cents), reservedCents: Number(b.reserved_cents), pendingInCents: Number(b.pending_in_cents),
        cashlessSession: session[0] ?? null, activeTransfers: transfers, history,
      };
    }
    return {
      card: { id: res.card.id, number: res.card.card_number, type: res.card.card_type, status: res.card.status, expiresAt: res.card.expires_at },
      usable: res.ok, rejection: res.ok ? null : cardRejectionMessage(res.reason),
      player, wallet,
    };
  });

  /** Vault screen: session, counts waiting for the second count, open movements, shifts, collections. */
  app.get('/api/v1/vault/status', { config: { feature: 'vault' }, preHandler: guard('cash.manage') }, async (req) => {
    const casinoId = scopeCasino(req, casinoQuery.parse(req.query).casinoId);
    const vault = (await rows('SELECT id, name FROM vaults WHERE casino_id = $1 AND active ORDER BY created_at, id LIMIT 1', [casinoId]))[0] ?? null;
    const modes = await railModes(req.auth.orgId, casinoId);
    if (!vault) return { vault: null, ...modes, session: null, pendingCounts: [], balanceCents: null, movements: [], shifts: [], collectionCounts: [] };
    const session = (await rows(
      `SELECT s.id, s.status, s.business_date, s.opened_at, s.opened_by, e.name AS opened_by_name,
         EXISTS (SELECT 1 FROM cash_counts c JOIN count_settlements cs ON cs.count_id = c.id WHERE c.vault_session_id = s.id AND c.context = 'VAULT_OPEN') AS verified
       FROM vault_sessions s LEFT JOIN employees e ON e.id = s.opened_by WHERE s.vault_id = $1 AND s.status IN ('OPEN', 'COUNTING')`, [vault.id]))[0] ?? null;
    const pendingCounts = session ? await rows(
      `SELECT c.id, c.context, c.counted_by, e.name AS counted_by_name, c.created_at,
         (SELECT count(*)::int FROM cash_count_verifications v WHERE v.count_id = c.id AND NOT v.matches) AS mismatches
       FROM cash_counts c JOIN employees e ON e.id = c.counted_by
       WHERE c.vault_session_id = $1 AND c.context IN ('VAULT_OPEN', 'VAULT_CLOSE') AND NOT EXISTS (SELECT 1 FROM count_settlements cs WHERE cs.count_id = c.id)
         AND c.id = (SELECT c2.id FROM cash_counts c2 WHERE c2.vault_session_id = $1 AND c2.context = c.context ORDER BY c2.created_at DESC, c2.id DESC LIMIT 1)
       ORDER BY c.created_at`, [session.id]) : [];
    // Blind counting (enforced here): everyone on this screen may count the vault, so its balance is never
    // returned; it is disclosed only in the review of a count submitted by someone else (/counts/:id/review).
    const balanceCents = null;
    const [movements, shifts, collectionCounts] = await Promise.all([
      rows(
        `SELECT m.id, m.kind, m.purpose, m.status, ${MOVEMENT_AMOUNT} AS amount_cents, m.requested_at, m.expires_at, m.requested_by, e.name AS requested_by_name,
           d.name AS desk_name, ce.name AS cashier_name, mc.asset_no
         FROM cash_movements m JOIN employees e ON e.id = m.requested_by
         LEFT JOIN cashier_sessions s ON s.id = m.cashier_session_id LEFT JOIN cash_desks d ON d.id = s.cash_desk_id LEFT JOIN employees ce ON ce.id = s.employee_id
         LEFT JOIN machines mc ON mc.id = m.machine_id
         WHERE m.org_id = $1 AND m.casino_id = $2 AND m.status = 'REQUESTED' ORDER BY m.requested_at`, [req.auth.orgId, casinoId, req.auth.sub, true, hasPermission(req.auth.role, 'cash.transact')]),
      rows(
        `SELECT s.id, s.status, s.opened_at, d.name AS desk_name, e.name AS employee, s.employee_id FROM cashier_sessions s
         JOIN cash_desks d ON d.id = s.cash_desk_id JOIN employees e ON e.id = s.employee_id
         WHERE s.org_id = $1 AND s.casino_id = $2 AND s.status IN ('OPEN', 'COUNTING') ORDER BY d.name`, [req.auth.orgId, casinoId]),
      rows(
        `SELECT c.id, c.machine_id, m.asset_no, c.counted_by, e.name AS counted_by_name, c.created_at,
           (SELECT count(*)::int FROM cash_count_verifications v WHERE v.count_id = c.id AND NOT v.matches) AS mismatches
         FROM cash_counts c JOIN machines m ON m.id = c.machine_id JOIN employees e ON e.id = c.counted_by
         JOIN money_rail_cutovers mc ON mc.rail = 'MACHINE' AND mc.machine_id = c.machine_id
         WHERE c.org_id = $1 AND c.casino_id = $2 AND c.context = 'MACHINE_DROP' AND c.created_at > mc.as_of
           AND NOT EXISTS (SELECT 1 FROM count_settlements cs WHERE cs.count_id = c.id)
           AND c.id = (SELECT c2.id FROM cash_counts c2 WHERE c2.machine_id = c.machine_id AND c2.context = 'MACHINE_DROP' ORDER BY c2.created_at DESC, c2.id DESC LIMIT 1)
         ORDER BY c.created_at`, [req.auth.orgId, casinoId]),
    ]);
    return { vault, ...modes, session, pendingCounts, balanceCents, movements, shifts, collectionCounts };
  });

  /**
   * Blind count review: the submitted count, the authoritative expected amount and the difference, for a
   * different employee with cash.manage (403 for the counter). Confirm with POST .../verify (same total),
   * reject with a different count of your own (nothing booked, the counter counts again).
   */
  app.get('/api/v1/counts/:id/review', { config: { feature: 'money.admin' }, preHandler: guard('cash.manage') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // a count of the vault needs Vault, a collection of a ledger machine needs Machine Money; cutover counts are infrastructure
    const c = (await rows(`SELECT c.context, EXISTS (SELECT 1 FROM money_rail_cutovers mc WHERE mc.rail = 'MACHINE' AND mc.machine_id = c.machine_id) AS ledger_machine
                           FROM cash_counts c WHERE c.id = $1 AND c.org_id = $2`, [id, req.auth.orgId]))[0];
    if (c) {
      const ent = await loadEntitlements(req.auth.orgId);
      if (c.context === 'VAULT_OPEN' || c.context === 'VAULT_CLOSE') requireFeature(ent, 'vault', { read: true });
      if (c.context === 'MACHINE_DROP' && c.ledger_machine) requireFeature(ent, 'machine', { read: true });
    }
    return reviewCount(pool, { orgId: req.auth.orgId, employeeId: req.auth.sub, role: req.auth.role, casinoIds: req.auth.casinoIds }, id);
  });

  /** Deferred money events of all rails (HANDPAY / TITO / MACHINE) with the state of their business date. */
  app.get('/api/v1/money/deferred', { config: { feature: 'reconciliation' }, preHandler: guard('cashier.supervise') }, async (req) => {
    const qs = casinoQuery.extend({ status: z.enum(['PENDING', 'PROCESSED', 'ALL']).default('PENDING') }).parse(req.query);
    const casinoId = scopeCasino(req, qs.casinoId);
    return rows(
      `SELECT d.event_id, d.rail, d.kind, d.amount_cents, d.reason, d.status, d.occurred_at, d.received_at, d.replayed_at, d.business_date, d.booked_business_date,
         d.attempts, d.last_error, d.late_approval_id, d.money_transaction_id, m.asset_no, d.machine_id,
         EXISTS (SELECT 1 FROM business_day_closes c WHERE c.casino_id = d.casino_id AND c.business_date = d.business_date) AS date_closed,
         (SELECT a.status FROM approvals a WHERE a.action = 'LATE_EVENT_BOOKING' AND a.entity_id = d.event_id::text ORDER BY a.created_at DESC LIMIT 1) AS late_request_status,
         EXISTS (SELECT 1 FROM reconciliation_resolutions r WHERE r.org_id = d.org_id AND r.item_key = 'deferred_event:' || d.event_id) AS explained
       FROM deferred_money_events d JOIN machines m ON m.id = d.machine_id
       WHERE d.org_id = $1 AND d.casino_id = $2 AND ($3 = 'ALL' OR d.status = $3) ORDER BY d.occurred_at DESC LIMIT 200`,
      [req.auth.orgId, casinoId, qs.status]);
  });

  /**
   * What blocks the business-day close, read-only. The close itself (POST /money/day-close) checks the
   * same conditions and runs a fresh reconciliation; this view uses the latest run.
   */
  app.get('/api/v1/money/day-close/status', { config: { feature: 'reconciliation' }, preHandler: guard('cashier.supervise') }, async (req) => {
    const casinoId = scopeCasino(req, casinoQuery.parse(req.query).casinoId);
    const today = await casinoToday(casinoId);
    // Entitlement-aware (H4): only rails of modules the organisation uses block the close; global invariants always.
    const inUse = await railsInUse(pool, req.auth.orgId);
    const [allFreezes, deferred, lastRun, closes, openDates, pendingApprovals, openShifts] = await Promise.all([
      activeFreezes(req.auth.orgId, casinoId),
      rows(`SELECT count(*)::int n, COALESCE(sum(amount_cents), 0)::bigint cents FROM deferred_money_events d WHERE d.casino_id = $1 AND d.status = 'PENDING' AND d.rail = ANY($2)
              AND NOT EXISTS (SELECT 1 FROM reconciliation_resolutions r WHERE r.org_id = d.org_id AND r.item_key = 'deferred_event:' || d.event_id)`, [casinoId, [...inUse]]),
      rows('SELECT id, trigger, ok, checks, created_at FROM reconciliation_runs WHERE org_id = $1 AND casino_id = $2 ORDER BY created_at DESC LIMIT 1', [req.auth.orgId, casinoId]),
      rows('SELECT business_date::text, closed_at FROM business_day_closes WHERE casino_id = $1 ORDER BY business_date DESC LIMIT 10', [casinoId]),
      rows(
        `SELECT DISTINCT t.business_date::text AS d FROM money_transactions t
         WHERE t.casino_id = $1 AND t.business_date < $2::date AND NOT EXISTS (SELECT 1 FROM business_day_closes c WHERE c.casino_id = $1 AND c.business_date = t.business_date)
         ORDER BY 1 DESC LIMIT 14`, [casinoId, today]),
      rows(`SELECT count(*)::int n FROM approvals WHERE org_id = $1 AND casino_id = $2 AND status = 'PENDING' AND expires_at > now()`, [req.auth.orgId, casinoId]),
      rows(`SELECT count(*)::int n FROM cashier_sessions WHERE org_id = $1 AND casino_id = $2 AND status IN ('OPEN', 'COUNTING')`, [req.auth.orgId, casinoId]),
    ]);
    const freezes = allFreezes.filter((f) => f.rail === 'GLOBAL' || inUse.has(f.rail));
    const run = lastRun[0] ?? null;
    const blockers: Array<{ code: string; message: string }> = [];
    for (const f of freezes) blockers.push({ code: 'FROZEN', message: `${f.rail}${f.asset_no ? ` (machine ${f.asset_no})` : ''} is frozen: ${f.reason}` });
    if (deferred[0].n) blockers.push({ code: 'DEFERRED_EVENTS', message: `${deferred[0].n} deferred money event(s) not processed yet` });
    if (!run) blockers.push({ code: 'NO_RECONCILIATION', message: 'No reconciliation run yet' });
    else for (const c of (run.checks as Array<{ key: string; ok: boolean; items: string[]; advisory?: boolean; rail: string }>).filter((x) => !x.ok && !x.advisory && (x.rail === 'GLOBAL' || inUse.has(x.rail))))
      blockers.push({ code: 'RECONCILIATION', message: `${c.key}: ${c.items.length} unresolved item(s)` });
    // Shown but not blocking: approvals execute on the open date, shifts book on the open date.
    const info: Array<{ code: string; message: string }> = [];
    if (pendingApprovals[0].n) info.push({ code: 'PENDING_APPROVALS', message: `${pendingApprovals[0].n} approval request(s) pending (they book on the open business date)` });
    if (openShifts[0].n) info.push({ code: 'OPEN_SHIFTS', message: `${openShifts[0].n} cashier shift(s) open (they book on the open business date)` });
    const advisory = run ? (run.checks as Array<{ ok: boolean; advisory?: boolean }>).filter((x) => !x.ok && x.advisory).length : 0;
    if (advisory) info.push({ code: 'ADVISORY', message: `${advisory} check(s) of modules not in use failed (recorded, not blocking)` });
    return { today, freezes, pendingDeferred: deferred[0].n, pendingDeferredCents: Number(deferred[0].cents), lastRun: run, closed: closes, openDates: openDates.map((r) => r.d), blockers, info, railsInUse: [...inUse], canClose: blockers.length === 0 };
  });

  /**
   * Ledger <-> meters per machine and period (plan section 5): the money the machine reported (machine
   * events, business date of occurred_at) against what the ledger booked for that machine (original
   * business date for late postings). Differences are explained by exception records or pending
   * deferred events; anything else is a reconciliation finding.
   */
  app.get('/api/v1/money/reconciliation/meters', { config: { feature: 'reconciliation.meters' }, preHandler: guard('cashier.supervise') }, async (req) => {
    const qs = casinoQuery.extend({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
    const casinoId = scopeCasino(req, qs.casinoId);
    const today = await casinoToday(casinoId);
    const from = qs.from ?? today;
    const to = qs.to ?? today;
    const txTypes = Object.values(METER_TYPES).flat();
    const [machines, events, ledger, exceptions, deferred] = await Promise.all([
      rows(
        `SELECT m.id, m.asset_no, m.credit_meter_reliable, mc.as_of AS ledger_since FROM machines m
         JOIN money_rail_cutovers mc ON mc.rail = 'MACHINE' AND mc.machine_id = m.id WHERE m.org_id = $1 AND m.casino_id = $2 ORDER BY m.asset_no`, [req.auth.orgId, casinoId]),
      rows(
        `SELECT e.machine_id, e.type, sum(round(e.amount * 100))::bigint AS cents, count(*)::int n
         FROM machine_events e JOIN casinos c ON c.id = e.casino_id JOIN money_rail_cutovers mc ON mc.rail = 'MACHINE' AND mc.machine_id = e.machine_id
         WHERE e.org_id = $1 AND e.casino_id = $2 AND e.type = ANY($3) AND e.received_at > mc.as_of
           AND (e.occurred_at AT TIME ZONE c.timezone)::date BETWEEN $4::date AND $5::date
         GROUP BY 1, 2`, [req.auth.orgId, casinoId, Object.keys(METER_TYPES), from, to]),
      rows(
        `SELECT t.machine_id, t.type, sum(t.amount_cents)::bigint AS cents, count(*)::int n FROM money_transactions t
         WHERE t.org_id = $1 AND t.casino_id = $2 AND t.type = ANY($3) AND t.machine_id IS NOT NULL
           AND COALESCE((t.options->'lateEvent'->>'originalBusinessDate')::date, t.business_date) BETWEEN $4::date AND $5::date
         GROUP BY 1, 2`, [req.auth.orgId, casinoId, txTypes, from, to]),
      rows(
        `SELECT x.machine_id, x.event_type AS type, sum(round(COALESCE(e.amount, 0) * 100))::bigint AS cents, count(*)::int n
         FROM machine_event_exceptions x JOIN machine_events e ON e.event_id = x.event_id JOIN casinos c ON c.id = x.casino_id
         WHERE x.org_id = $1 AND x.casino_id = $2 AND (e.occurred_at AT TIME ZONE c.timezone)::date BETWEEN $3::date AND $4::date
           AND NOT EXISTS (SELECT 1 FROM money_transactions t WHERE t.source_event_id = x.event_id)
         GROUP BY 1, 2`, [req.auth.orgId, casinoId, from, to]),
      rows(
        `SELECT d.machine_id, d.kind AS type, sum(d.amount_cents)::bigint AS cents, count(*)::int n FROM deferred_money_events d
         WHERE d.org_id = $1 AND d.casino_id = $2 AND d.status = 'PENDING' AND d.business_date BETWEEN $3::date AND $4::date GROUP BY 1, 2`,
        [req.auth.orgId, casinoId, from, to]),
    ]);
    const pick = (list: any[], machineId: string, type: string) => list.find((r) => r.machine_id === machineId && r.type === type);
    const result = machines.map((m) => {
      const lines = Object.keys(METER_TYPES).map((type) => {
        const meterCents = Number(pick(events, m.id, type)?.cents ?? 0);
        const ledgerCents = METER_TYPES[type].reduce((s, t) => s + Number(pick(ledger, m.id, t)?.cents ?? 0), 0);
        const exceptionCents = Number(pick(exceptions, m.id, type)?.cents ?? 0);
        const deferredCents = Number(pick(deferred, m.id, type)?.cents ?? 0);
        const unexplainedCents = meterCents - ledgerCents - exceptionCents - deferredCents;
        return { type, meterCents, ledgerCents, differenceCents: meterCents - ledgerCents, exceptionCents, deferredCents, unexplainedCents };
      });
      return { machineId: m.id, assetNo: m.asset_no, creditMeterReliable: m.credit_meter_reliable, ledgerSince: m.ledger_since, lines, ok: lines.every((l) => l.unexplainedCents === 0) };
    });
    // Cash-in / cash-out amounts per machine reveal the cashbox (blind collection count): roles that count
    // (cash.manage) get the reconciliation result and differences, not the absolute amounts.
    const blind = countsTargets(req.auth.role);
    const out = blind
      ? result.map((m) => ({ ...m, lines: m.lines.map((l) => (l.type === 'CASH_IN' || l.type === 'CASH_OUT' ? { ...l, meterCents: null, ledgerCents: null, exceptionCents: null, deferredCents: null } : l)) }))
      : result;
    return { from, to, machines: out, ok: result.every((m) => m.ok), blind };
  });

  /**
   * Cutover counts of the casino with their verification state (admin screen). No amounts: the second
   * count is blind, and the cutover itself compares the verified count with the legacy balance.
   */
  app.get('/api/v1/money/counts', { config: { feature: 'money.admin' }, preHandler: guard('cash.manage') }, async (req) => {
    const casinoId = scopeCasino(req, casinoQuery.parse(req.query).casinoId);
    return rows(
      `SELECT c.id, c.context, c.vault_id, c.cash_desk_id, c.machine_id, v.name AS vault_name, d.name AS desk_name, m.asset_no,
         c.counted_by, e.name AS counted_by_name, c.created_at,
         EXISTS (SELECT 1 FROM cash_count_verifications x WHERE x.count_id = c.id AND x.matches) AS verified,
         (SELECT count(*)::int FROM cash_count_verifications x WHERE x.count_id = c.id AND NOT x.matches) AS mismatches,
         EXISTS (SELECT 1 FROM money_backfill_items i WHERE i.source_table = 'cash_counts' AND i.source_id = c.id::text) AS used
       FROM cash_counts c JOIN employees e ON e.id = c.counted_by
       LEFT JOIN vaults v ON v.id = c.vault_id LEFT JOIN cash_desks d ON d.id = c.cash_desk_id LEFT JOIN machines m ON m.id = c.machine_id
       WHERE c.org_id = $1 AND c.casino_id = $2 AND (c.context IN ('VAULT_CUTOVER', 'DRAWER_CUTOVER')
         OR (c.context = 'MACHINE_DROP' AND NOT EXISTS (SELECT 1 FROM money_rail_cutovers mc WHERE mc.rail = 'MACHINE' AND mc.machine_id = c.machine_id AND mc.as_of < c.created_at)))
       ORDER BY c.created_at DESC LIMIT 100`, [req.auth.orgId, casinoId]);
  });

  /** Machine money status: rail, freeze, credit meter, pending / deferred events, exceptions, open handpays. */
  app.get('/api/v1/machines/:id/money', { config: { feature: 'machine' }, preHandler: guard('machine.view') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const m = (await rows('SELECT id, casino_id, asset_no, credit_meter_reliable FROM machines WHERE id = $1 AND org_id = $2 AND casino_id = ANY($3)', [id, req.auth.orgId, req.auth.casinoIds]))[0];
    if (!m) throw new HttpError(404, 'Machine not found');
    const [cut, freezes, deferred, exceptions, handpays, hopperFills, counts, lastMeter] = await Promise.all([
      rows(`SELECT as_of FROM money_rail_cutovers WHERE rail = 'MACHINE' AND machine_id = $1`, [id]),
      rows(`SELECT id, rail, reason, frozen_at FROM money_rail_freezes WHERE org_id = $1 AND lifted_at IS NULL AND (machine_id = $2 OR (rail IN ('GLOBAL', 'CASHLESS') AND machine_id IS NULL AND (casino_id IS NULL OR casino_id = $3)))`, [req.auth.orgId, id, m.casino_id]),
      rows(`SELECT event_id, rail, kind, amount_cents, reason, business_date, occurred_at, last_error FROM deferred_money_events WHERE machine_id = $1 AND status = 'PENDING' ORDER BY occurred_at`, [id]),
      rows(`SELECT x.event_id, x.rail, x.event_type, x.code, x.message, x.created_at,
              EXISTS (SELECT 1 FROM reconciliation_resolutions r WHERE r.org_id = x.org_id AND r.item_key = 'machine_event:' || x.event_id) AS explained
            FROM machine_event_exceptions x WHERE x.machine_id = $1 ORDER BY x.created_at DESC LIMIT 20`, [id]),
      rows(`SELECT id, status, amount_cents, created_at FROM handpays WHERE machine_id = $1 AND status IN ('PENDING', 'APPROVED', 'PAID') ORDER BY created_at DESC LIMIT 10`, [id]),
      rows(`SELECT id, status, requested_at, expires_at, requested_by FROM cash_movements WHERE machine_id = $1 AND kind = 'HOPPER_FILL' ORDER BY requested_at DESC LIMIT 10`, [id]),
      rows(`SELECT c.id, c.counted_by, c.created_at, EXISTS (SELECT 1 FROM count_settlements cs WHERE cs.count_id = c.id) AS settled
            FROM cash_counts c WHERE c.machine_id = $1 AND c.context = 'MACHINE_DROP' ORDER BY c.created_at DESC LIMIT 5`, [id]),
      rows(`SELECT event_id, occurred_at, received_at, (payload->>'creditCents') AS credit_cents FROM machine_events WHERE machine_id = $1 AND type = 'CREDIT_METER' ORDER BY occurred_at DESC LIMIT 1`, [id]),
    ]);
    return {
      machineId: id, assetNo: m.asset_no, rail: cut.length ? 'LEDGER' : 'LEGACY', ledgerSince: cut[0]?.as_of ?? null,
      creditMeterReliable: m.credit_meter_reliable, lastCreditMeter: lastMeter[0] ?? null,
      freezes, deferred, exceptions, handpays,
      // No cashbox / hopper balance here: collection counts and hopper fill confirmations stay blind.
      hopperFills, collectionCounts: counts,
    };
  });
}
