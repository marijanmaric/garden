import { randomUUID } from 'node:crypto';
import { withTransaction, writeAudit, type Pool, type PoolClient } from '@m1/database';
import {
  ACCOUNT_KIND_RAIL, CASHBOX_IN_EVENT_TYPES, CUTOVER_PREREQUISITES, CUTOVER_SCOPE, MACHINE_MONEY_EVENT_TYPES, cents,
  type AccountKind, type AccountRef, type BackfillSource, type CutoverRail,
} from '@m1/shared';
import { HttpError } from '../auth';
import { executeMoneyTransaction, getBalance, type MoneyActor } from './ledger';
import { railOnLedger } from './rails';
import { unexplainedFloorClearing } from './tito';
import { countTotal, recordCashCount, type CountInput } from './vault';

/**
 * Rail cutover (migration 006): LEGACY money -> LEDGER money, one rail at a time, in ONE database
 * transaction. Nothing here guesses: every opening balance comes from a deterministic legacy source
 * (a verified physical count, an outstanding ticket, an unpaid handpay), every check that fails
 * aborts the whole cutover, and a committed cutover is final (forward-only).
 *
 * Lock order (fixed):
 *   1. the rail's legacy tables, LOCK ... IN SHARE ROW EXCLUSIVE MODE, alphabetical
 *      (blocks concurrent legacy money writes and other cutovers of the rail, reads continue);
 *   2. the organisation's audit advisory lock (same lock as the ledger and the audit chain);
 *   3. ledger balance rows by ascending account id (inside the ledger service).
 * Legacy writers take row locks first and the audit lock last, so the order is the same everywhere.
 */

type Db = Pick<PoolClient, 'query'>;

export interface CutoverActor {
  orgId: string;
  /** null / undefined = SYSTEM (fresh database only). */
  employeeId?: string | null;
  employeeEmail?: string | null;
  ip?: string | null;
  /** Casinos the employee may act on (HTTP routes). */
  casinoIds?: string[];
}

export interface CutoverTarget {
  rail: CutoverRail;
  casinoId?: string | null;
  machineId?: string | null;
}

export interface CutoverCheck {
  name: string;
  ok: boolean;
  detail?: unknown;
}

export interface CutoverOpening {
  sourceTable: BackfillSource['table'];
  sourceId: string;
  accountKind: AccountKind;
  amountCents: number;
  transactionId: string | null;
}

export interface CutoverReport {
  ok: boolean;
  dryRun: boolean;
  replayed: boolean;
  cutoverId: string | null;
  rail: CutoverRail;
  orgId: string;
  casinoId: string | null;
  machineId: string | null;
  asOf: string | null;
  businessDate: string | null;
  checks: CutoverCheck[];
  legacy: Record<string, number>;
  ledger: Record<string, number>;
  openings: CutoverOpening[];
}

/** A failed check: the transaction rolls back, nothing is posted, the rail stays LEGACY. */
export class CutoverAborted extends HttpError {
  constructor(public report: CutoverReport) {
    super(409, `${report.rail} cutover aborted: ${report.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`);
    this.body = { report };
  }
}

class DryRunComplete extends Error {
  constructor(public report: CutoverReport) {
    super('dry run');
  }
}

/** Legacy tables per rail, locked for the snapshot. Alphabetical = the global lock order. */
const LOCK_TABLES: Record<CutoverRail, string[]> = {
  VAULT: ['cash_counts', 'vault_sessions'],
  CASH: ['approvals', 'cash_counts', 'cash_transactions', 'cashier_sessions', 'handpays', 'tickets', 'vault_sessions'],
  HANDPAY: ['cash_transactions', 'handpays', 'machines'],
  TITO: ['cash_transactions', 'ticket_events', 'tickets'],
  CASHLESS: ['cashless_sessions', 'wallet_transfers', 'wallets'],
  MACHINE: ['cash_collections', 'cash_counts', 'cashless_sessions', 'machine_events', 'wallet_transfers'],
};
for (const tables of Object.values(LOCK_TABLES))
  if (tables.join() !== [...tables].sort().join()) throw new Error('cutover lock tables must be alphabetical');

/** Deterministic exactly-once key of an opening balance. */
export function backfillDedupeKey(rail: CutoverRail, source: BackfillSource) {
  return `backfill:006:${rail}:${source.table}:${source.id}`;
}

interface PlannedOpening {
  source: BackfillSource;
  /** The rail account that receives the opening balance (the other side is OPENING_EQUITY). */
  account: AccountRef;
  amountCents: number;
  /** Which side the account is booked on; default: assets (vault) debit, liabilities credit. */
  side?: 'DEBIT' | 'CREDIT';
  refs: { vaultId?: string; cashierSessionId?: string; machineId?: string; ticketId?: string; handpayId?: string };
}

interface RailPlan {
  openings: PlannedOpening[];
  /** Verifies the ledger after the openings (reconciliation against the legacy values). */
  reconcile: () => Promise<void>;
}

interface Ctx {
  db: Db;
  orgId: string;
  casinoId: string | null;
  machineId: string | null;
  checks: CutoverCheck[];
  legacy: Record<string, number>;
  ledger: Record<string, number>;
}

const check = (ctx: Ctx, name: string, ok: boolean, detail?: unknown) => {
  ctx.checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
  return ok;
};

const one = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[]): Promise<T> => (await db.query(sql, params)).rows[0];

/** Latest count of an object (vault / desk / machine) with its blind verification. */
async function latestCount(db: Db, orgId: string, casinoId: string, context: string, column: 'vault_id' | 'cash_desk_id' | 'machine_id', id: string) {
  return one<{ id: string; total_cents: number; created_at: string; counted_by: string; verified: boolean; used: boolean } | undefined>(
    db,
    `SELECT c.id, c.total_cents, c.created_at, c.counted_by,
       EXISTS (SELECT 1 FROM cash_count_verifications v WHERE v.count_id = c.id AND v.matches) AS verified,
       EXISTS (SELECT 1 FROM money_backfill_items i WHERE i.source_table = 'cash_counts' AND i.source_id = c.id::text) AS used
     FROM cash_counts c WHERE c.org_id = $1 AND c.casino_id = $2 AND c.context = $3 AND c.${column} = $4
     ORDER BY c.created_at DESC, c.id DESC LIMIT 1`,
    [orgId, casinoId, context, id],
  );
}

/** A count must exist, be the latest one, be verified blind by a second person and not be used before. */
function checkCount(ctx: Ctx, label: string, count: Awaited<ReturnType<typeof latestCount>>, after?: string | null) {
  if (!check(ctx, `${label}:count_exists`, !!count)) return false;
  let ok = check(ctx, `${label}:count_verified`, count!.verified, { countId: count!.id });
  ok = check(ctx, `${label}:count_unused`, !count!.used, { countId: count!.id }) && ok;
  if (after) ok = check(ctx, `${label}:count_current`, new Date(count!.created_at) > new Date(after), { countedAt: count!.created_at, after }) && ok;
  return ok;
}

async function mainVault(ctx: Ctx) {
  const v = await one<{ id: string } | undefined>(ctx.db, 'SELECT id FROM vaults WHERE casino_id = $1 AND active ORDER BY created_at, id LIMIT 1', [ctx.casinoId]);
  check(ctx, 'vault_exists', !!v);
  return v?.id;
}

const balance = (ctx: Ctx, ref: AccountRef) => getBalance(ctx.db, ctx.orgId, ref);

// ---- rails ----------------------------------------------------------------------------------

/** VAULT: ledger VAULT = the verified opening count of every active vault. No legacy vault balance exists. */
async function planVault(ctx: Ctx): Promise<RailPlan> {
  const { db, orgId, casinoId } = ctx;
  const counting = await one<{ n: number }>(db, `SELECT count(*)::int n FROM vault_sessions WHERE casino_id = $1 AND status = 'COUNTING'`, [casinoId]);
  check(ctx, 'no_active_vault_count', counting.n === 0, counting);
  const vaults = (await db.query('SELECT id, name FROM vaults WHERE casino_id = $1 AND active ORDER BY created_at, id', [casinoId])).rows;
  check(ctx, 'vault_exists', vaults.length > 0);
  const openings: PlannedOpening[] = [];
  for (const v of vaults) {
    const count = await latestCount(db, orgId, casinoId!, 'VAULT_CUTOVER', 'vault_id', v.id);
    if (!checkCount(ctx, `vault:${v.name}`, count)) continue;
    ctx.legacy[`vault:${v.id}:counted`] = count!.total_cents;
    openings.push({ source: { table: 'cash_counts', id: count!.id }, account: { kind: 'VAULT', casinoId: casinoId!, vaultId: v.id }, amountCents: count!.total_cents, refs: { vaultId: v.id } });
  }
  return {
    openings,
    reconcile: async () => {
      for (const o of openings) {
        const b = await balance(ctx, o.account);
        ctx.ledger[`vault:${o.refs.vaultId}`] = b;
        check(ctx, `reconcile:vault:${o.refs.vaultId}`, b === o.amountCents, { ledger: b, counted: o.amountCents });
      }
    },
  };
}

/**
 * CASH: no shift open, nothing pending, and every desk counted (verified, after its last close).
 * Legacy desk balance = opening_balance + sum(cash_transactions.amount) + difference of the desk's
 * last session (the cash left in the drawer at close). It must equal the verified count. The desk
 * cash is handed to the vault: ledger drawers stay 0, the vault receives the counted amounts.
 */
async function planCash(ctx: Ctx): Promise<RailPlan> {
  const { db, orgId, casinoId } = ctx;
  const p = [casinoId];
  const pending = await one<{ sessions: number; approvals: number; handpays: number; holds: number; vault_counts: number }>(
    db,
    `SELECT (SELECT count(*)::int FROM cashier_sessions WHERE casino_id = $1 AND status IN ('OPEN', 'COUNTING')) AS sessions,
       (SELECT count(*)::int FROM approvals WHERE casino_id = $1 AND status IN ('PENDING', 'APPROVED')) AS approvals,
       (SELECT count(*)::int FROM handpays WHERE casino_id = $1 AND status = 'APPROVED') AS handpays,
       (SELECT count(*)::int FROM tickets WHERE casino_id = $1 AND status = 'HELD' AND hold_source = 'CASHIER') AS holds,
       (SELECT count(*)::int FROM vault_sessions WHERE casino_id = $1 AND status = 'COUNTING') AS vault_counts`,
    p,
  );
  check(ctx, 'no_open_cashier_sessions', pending.sessions === 0, { open: pending.sessions });
  check(ctx, 'no_pending_approvals', pending.approvals === 0, { pending: pending.approvals });
  check(ctx, 'no_pending_cash_operations', pending.handpays === 0 && pending.holds === 0, { approvedHandpays: pending.handpays, cashierHolds: pending.holds });
  check(ctx, 'no_active_cash_count', pending.vault_counts === 0, { vaultCounting: pending.vault_counts });
  const vaultId = await mainVault(ctx);

  const desks = (await db.query(
    `SELECT d.id, d.name, s.id AS session_id, s.closed_at,
       round(s.opening_balance * 100)::bigint AS opening_cents,
       round(s.expected_balance * 100)::bigint AS expected_cents,
       round(s.counted_balance * 100)::bigint AS counted_cents,
       round(s.difference * 100)::bigint AS difference_cents,
       round(COALESCE((SELECT sum(ct.amount) FROM cash_transactions ct WHERE ct.session_id = s.id), 0) * 100)::bigint AS movement_cents
     FROM cash_desks d
     LEFT JOIN LATERAL (SELECT * FROM cashier_sessions x WHERE x.cash_desk_id = d.id ORDER BY x.opened_at DESC, x.id DESC LIMIT 1) s ON true
     WHERE d.casino_id = $1 AND (d.active OR s.id IS NOT NULL) ORDER BY d.name, d.id`,
    p,
  )).rows;

  const openings: PlannedOpening[] = [];
  let legacyTotal = 0;
  for (const d of desks) {
    const label = `drawer:${d.name}`;
    let legacy = 0;
    if (d.session_id) {
      const calculated = d.opening_cents + d.movement_cents;
      check(ctx, `${label}:expected_consistent`, d.expected_cents === calculated, { stored: d.expected_cents, calculated });
      check(ctx, `${label}:counted_consistent`, d.counted_cents === d.expected_cents + d.difference_cents, { counted: d.counted_cents, expected: d.expected_cents, difference: d.difference_cents });
      legacy = calculated + (d.difference_cents ?? 0);
    }
    legacyTotal += legacy;
    ctx.legacy[`${label}:balance`] = legacy;
    const count = await latestCount(db, orgId, casinoId!, 'DRAWER_CUTOVER', 'cash_desk_id', d.id);
    if (!checkCount(ctx, label, count, d.closed_at)) continue;
    if (!check(ctx, `${label}:count_matches_legacy`, count!.total_cents === legacy, { legacy, counted: count!.total_cents })) continue;
    if (vaultId)
      openings.push({
        source: { table: 'cash_counts', id: count!.id }, account: { kind: 'VAULT', casinoId: casinoId!, vaultId },
        amountCents: count!.total_cents, refs: { vaultId, cashierSessionId: d.session_id ?? undefined },
      });
  }
  ctx.legacy.drawers_total = legacyTotal;
  const vaultBefore = vaultId ? await balance(ctx, { kind: 'VAULT', casinoId: casinoId!, vaultId }) : 0;

  return {
    openings,
    reconcile: async () => {
      const drawers = await one<{ total: number }>(db,
        `SELECT COALESCE(sum(b.balance_cents), 0)::bigint AS total FROM ledger_accounts a JOIN ledger_balances b ON b.account_id = a.id WHERE a.casino_id = $1 AND a.kind = 'DRAWER'`, p);
      ctx.ledger.drawers_total = drawers.total;
      check(ctx, 'reconcile:ledger_drawers_zero', drawers.total === 0, drawers);
      const moved = vaultId ? (await balance(ctx, { kind: 'VAULT', casinoId: casinoId!, vaultId })) - vaultBefore : 0;
      ctx.ledger.vault_received = moved;
      check(ctx, 'reconcile:desk_cash_in_vault', moved === legacyTotal, { ledger: moved, legacy: legacyTotal });
    },
  };
}

/**
 * HANDPAY: the legacy payment of a handpay is identified ONLY by the jackpot event id
 * (cash_transactions.source_event_id, Step 1) and handpays.legacy_cash_transaction_id. No matching by
 * amount or time: a legacy payment without an event id stops the cutover.
 */
async function planHandpay(ctx: Ctx): Promise<RailPlan> {
  const { db, casinoId } = ctx;
  const p = [casinoId];
  const ids = async (sql: string) => (await db.query(sql, p)).rows.map((r) => r.id);

  // Legacy payments without jackpot event id: only a four-eyes classification (handpay exception) maps them.
  const unmapped = (await db.query(
    `SELECT ct.id, x.id AS exception_id, x.status FROM cash_transactions ct LEFT JOIN handpay_legacy_exceptions x ON x.cash_transaction_id = ct.id
     WHERE ct.casino_id = $1 AND ct.type = 'HANDPAY' AND ct.source_event_id IS NULL AND (x.status IS DISTINCT FROM 'APPROVED') ORDER BY ct.id`, p)).rows;
  check(ctx, 'handpay_payments_have_jackpot_event', unmapped.length === 0, unmapped.length ? {
    unmappedCashTransactionIds: unmapped.map((u) => u.id),
    exceptions: unmapped.map((u) => ({ cashTransactionId: u.id, exceptionId: u.exception_id, status: u.status ?? 'NOT_DETECTED' })),
    reason: 'legacy handpay payment without jackpot event id: cannot be mapped deterministically',
    action: 'detect and classify them (LINK / HISTORICAL / DISPUTED, four eyes, evidence) under /api/v1/handpays/legacy-exceptions',
  } : undefined);
  const badPayments = await ids(
    `SELECT ct.id FROM cash_transactions ct LEFT JOIN handpays h ON h.source_event_id = ct.source_event_id
     WHERE ct.casino_id = $1 AND ct.type = 'HANDPAY' AND ct.source_event_id IS NOT NULL
       AND NOT (h.id IS NOT NULL AND h.legacy_cash_transaction_id = ct.id AND h.status IN ('PAID', 'MACHINE_RESET')
                AND h.machine_id = ct.machine_id AND h.amount_cents = -round(ct.amount * 100)::bigint)
     ORDER BY ct.id`,
  );
  check(ctx, 'handpay_payments_mapped_one_to_one', badPayments.length === 0, badPayments.length ? { cashTransactionIds: badPayments } : undefined);
  const badPaid = await ids(
    `SELECT h.id FROM handpays h LEFT JOIN cash_transactions ct ON ct.id = h.legacy_cash_transaction_id
     WHERE h.casino_id = $1 AND h.status IN ('PAID', 'MACHINE_RESET')
       AND (ct.id IS NULL OR ct.type <> 'HANDPAY' OR (ct.source_event_id IS DISTINCT FROM h.source_event_id
            AND NOT EXISTS (SELECT 1 FROM handpay_legacy_exceptions x WHERE x.cash_transaction_id = ct.id AND x.status = 'APPROVED'
                            AND x.resolution = 'LINK' AND x.linked_event_id = h.source_event_id)))
     ORDER BY h.id`,
  );
  check(ctx, 'paid_handpays_have_legacy_payment', badPaid.length === 0, badPaid.length ? { handpayIds: badPaid } : undefined);
  const paidOpen = await ids(
    `SELECT h.id FROM handpays h WHERE h.casino_id = $1 AND h.status IN ('PENDING', 'APPROVED')
       AND EXISTS (SELECT 1 FROM cash_transactions ct WHERE ct.source_event_id = h.source_event_id)`,
  );
  check(ctx, 'unpaid_handpays_have_no_payment', paidOpen.length === 0, paidOpen.length ? { handpayIds: paidOpen } : undefined);
  // A disputed historical payment must not possibly concern a handpay that would be opened as payable.
  const disputed = await ids(
    `SELECT h.id FROM handpay_legacy_exceptions x JOIN cash_transactions ct ON ct.id = x.cash_transaction_id
     JOIN handpays h ON h.casino_id = x.casino_id AND h.status IN ('PENDING', 'APPROVED') AND (ct.machine_id IS NULL OR h.machine_id = ct.machine_id)
     JOIN machine_events e ON e.event_id = h.source_event_id AND e.occurred_at <= ct.created_at
     WHERE x.casino_id = $1 AND x.status = 'APPROVED' AND x.resolution = 'DISPUTED' ORDER BY h.id`,
  );
  check(ctx, 'disputed_payments_clear_of_open_handpays', disputed.length === 0, disputed.length ? { handpayIds: disputed, action: 'LINK or VOID these handpays before the cutover' } : undefined);
  const orphanJackpots = await ids(
    `SELECT m.id FROM machines m WHERE m.casino_id = $1 AND m.jackpot_pending
       AND (SELECT count(*) FROM handpays h WHERE h.machine_id = m.id AND h.status IN ('PENDING', 'APPROVED', 'PAID')) <> 1`,
  );
  check(ctx, 'pending_jackpots_have_one_handpay', orphanJackpots.length === 0, orphanJackpots.length ? { machineIds: orphanJackpots } : undefined);
  const stale = await ids(
    `SELECT h.id FROM handpays h JOIN machines m ON m.id = h.machine_id WHERE h.casino_id = $1 AND h.status IN ('PENDING', 'APPROVED') AND NOT m.jackpot_pending`,
  );
  check(ctx, 'unpaid_handpays_on_pending_machines', stale.length === 0, stale.length ? { handpayIds: stale } : undefined);

  const open = (await db.query(
    `SELECT id, machine_id, amount_cents FROM handpays WHERE casino_id = $1 AND status IN ('PENDING', 'APPROVED') ORDER BY created_at, id`, p,
  )).rows;
  const paid = await one<{ n: number }>(db, `SELECT count(*)::int n FROM handpays WHERE casino_id = $1 AND status IN ('PAID', 'MACHINE_RESET')`, p);
  const total = open.reduce((s, h) => s + h.amount_cents, 0);
  Object.assign(ctx.legacy, { unpaid_count: open.length, unpaid_total: total, paid_count: paid.n, legacy_payments_mapped: paid.n });
  const openings: PlannedOpening[] = open.map((h) => ({
    source: { table: 'handpays', id: h.id }, account: { kind: 'HANDPAY_PAYABLE', casinoId: casinoId! }, amountCents: h.amount_cents, refs: { handpayId: h.id, machineId: h.machine_id },
  }));
  return {
    openings,
    reconcile: async () => {
      const b = await balance(ctx, { kind: 'HANDPAY_PAYABLE', casinoId: casinoId! });
      ctx.ledger.handpay_payable = b;
      check(ctx, 'reconcile:handpay_payable', b === total, { ledger: b, legacy: total });
    },
  };
}

/**
 * TITO: inside the cutover transaction, stale holds are released and due tickets expire first
 * (legacy rules). Then every VALID or HELD ticket is one outstanding liability; REDEEMED, EXPIRED,
 * CANCELLED and VOID tickets are history and get nothing.
 */
async function planTito(ctx: Ctx): Promise<RailPlan> {
  const { db, orgId, casinoId } = ctx;
  const p = [casinoId];
  const released = (await db.query(
    `UPDATE tickets t SET status = 'VALID', hold_id = NULL, hold_until = NULL, hold_machine_id = NULL, hold_source = NULL
     WHERE t.casino_id = $1 AND t.status = 'HELD'
       AND t.hold_until + make_interval(secs => COALESCE((SELECT tito_hold_grace_seconds FROM casino_money_settings s WHERE s.casino_id = t.casino_id), 120)) < now()
     RETURNING t.id`, p,
  )).rows;
  for (const r of released) await db.query(`INSERT INTO ticket_events (org_id, ticket_id, action, details) VALUES ($1,$2,'HOLD_EXPIRED','{"source": "cutover"}')`, [orgId, r.id]);
  const expired = (await db.query(
    `UPDATE tickets SET status = 'EXPIRED', status_reason = 'Expiry date reached' WHERE casino_id = $1 AND status = 'VALID' AND expires_at <= now() RETURNING id`, p,
  )).rows;
  for (const r of expired) await db.query(`INSERT INTO ticket_events (org_id, ticket_id, action, details) VALUES ($1,$2,'EXPIRED','{"source": "cutover"}')`, [orgId, r.id]);

  // D1: an unexplained LEGACY_FLOOR_CLEARING balance anywhere in the organisation blocks further TITO cutovers.
  const clearing = (await unexplainedFloorClearing(db, { orgId })).map((r) => r.id);
  const explained = clearing.length
    ? (await db.query(`SELECT item_key FROM reconciliation_resolutions WHERE org_id = $1 AND item_key = ANY($2)`, [orgId, clearing.map((m) => `floor_clearing:${m}`)])).rows.map((r) => r.item_key)
    : [];
  const unexplained = clearing.filter((m) => !explained.includes(`floor_clearing:${m}`));
  check(ctx, 'floor_clearing_explained', unexplained.length === 0, { machines: unexplained });

  const outstanding = (await db.query(
    `SELECT id, status, amount_cents FROM tickets WHERE casino_id = $1 AND status IN ('VALID', 'HELD') ORDER BY issued_at, id`, p,
  )).rows;
  const total = outstanding.reduce((s, t) => s + t.amount_cents, 0);
  check(ctx, 'tickets_positive', outstanding.every((t) => t.amount_cents > 0));
  Object.assign(ctx.legacy, {
    valid_count: outstanding.filter((t) => t.status === 'VALID').length, held_count: outstanding.filter((t) => t.status === 'HELD').length,
    outstanding_total: total, expired_at_cutover: expired.length, holds_released_at_cutover: released.length,
  });
  const openings: PlannedOpening[] = outstanding.map((t) => ({
    source: { table: 'tickets', id: t.id }, account: { kind: 'TICKET_LIABILITY', casinoId: casinoId! }, amountCents: t.amount_cents, refs: { ticketId: t.id },
  }));
  return {
    openings,
    reconcile: async () => {
      const b = await balance(ctx, { kind: 'TICKET_LIABILITY', casinoId: casinoId! });
      ctx.ledger.ticket_liability = b;
      check(ctx, 'reconcile:ticket_liability', b === total, { ledger: b, legacy: total });
      const after = await one<{ total: number; n: number }>(db,
        `SELECT COALESCE(sum(amount_cents), 0)::bigint AS total, count(*)::int AS n FROM tickets WHERE casino_id = $1 AND status IN ('VALID', 'HELD')`, p);
      check(ctx, 'reconcile:ticket_snapshot_stable', after.total === total && after.n === outstanding.length, after);
    },
  };
}

/** CASHLESS (organisation): wallets start at zero. Never derived from points, tier, play history or any player field. */
async function planCashless(ctx: Ctx): Promise<RailPlan> {
  const { db, orgId } = ctx;
  const s = await one<{ sessions: number; transfers: number; missing: number; wallets: number }>(
    db,
    `SELECT (SELECT count(*)::int FROM cashless_sessions WHERE org_id = $1 AND status = 'OPEN') AS sessions,
       (SELECT count(*)::int FROM wallet_transfers WHERE org_id = $1 AND status IN ('REQUESTED', 'SENT')) AS transfers,
       (SELECT count(*)::int FROM players p WHERE p.org_id = $1 AND p.status <> 'CLOSED' AND NOT EXISTS (SELECT 1 FROM wallets w WHERE w.player_id = p.id)) AS missing,
       (SELECT count(*)::int FROM wallets WHERE org_id = $1) AS wallets`,
    [orgId],
  );
  check(ctx, 'no_open_cashless_sessions', s.sessions === 0, { open: s.sessions });
  check(ctx, 'no_active_transfers', s.transfers === 0, { active: s.transfers });
  check(ctx, 'every_player_has_wallet', s.missing === 0, { missing: s.missing });
  Object.assign(ctx.legacy, { wallets: s.wallets, wallet_money: 0 });
  return {
    openings: [],
    reconcile: async () => {
      const w = await one<{ total: number }>(db,
        `SELECT COALESCE(sum(abs(b.balance_cents)), 0)::bigint AS total FROM ledger_accounts a JOIN ledger_balances b ON b.account_id = a.id
         WHERE a.org_id = $1 AND a.kind IN ('WALLET_AVAILABLE', 'WALLET_RESERVED')`, [orgId]);
      ctx.ledger.wallet_money = w.total;
      check(ctx, 'reconcile:wallets_zero', w.total === 0, w);
    },
  };
}

/**
 * MACHINE: after a verified collection (counted after the vault cutover) the cashbox is empty;
 * machine credit, cashbox and hopper start at 0. The collected cash (= legacy cash inserted since the
 * previous legacy collection) goes into the vault. Bets and wins are never ledger money.
 */
async function planMachine(ctx: Ctx): Promise<RailPlan> {
  const { db, orgId, casinoId, machineId } = ctx;
  const m = await one<{ asset_no: string }>(db, 'SELECT asset_no FROM machines WHERE id = $1', [machineId]);
  const vaultCutover = await one<{ as_of: string } | undefined>(db, `SELECT as_of FROM money_rail_cutovers WHERE org_id = $1 AND rail = 'VAULT' AND casino_id = $2`, [orgId, casinoId]);
  const vaultId = await mainVault(ctx);
  const label = `machine:${m.asset_no}`;
  const count = await latestCount(db, orgId, casinoId!, 'MACHINE_DROP', 'machine_id', machineId!);
  const countOk = checkCount(ctx, label, count, vaultCutover?.as_of ?? null);
  const busy = await one<{ sessions: number; transfers: number }>(db,
    `SELECT (SELECT count(*)::int FROM cashless_sessions WHERE machine_id = $1 AND status = 'OPEN') AS sessions,
       (SELECT count(*)::int FROM wallet_transfers WHERE machine_id = $1 AND status IN ('REQUESTED', 'SENT')) AS transfers`, [machineId]);
  check(ctx, `${label}:no_cashless_activity`, busy.sessions === 0 && busy.transfers === 0, busy);
  // 7d: nothing of the machine may wait: no pending deferred money event, no unexplained event exception
  const waiting = await one<{ deferred: number; exceptions: number }>(db,
    `SELECT (SELECT count(*)::int FROM deferred_money_events WHERE machine_id = $1 AND status = 'PENDING') AS deferred,
       (SELECT count(*)::int FROM machine_event_exceptions x WHERE x.machine_id = $1
          AND NOT EXISTS (SELECT 1 FROM reconciliation_resolutions r WHERE r.org_id = x.org_id AND r.item_key IN ('machine_event:' || x.event_id, 'ticket_event:' || x.event_id))) AS exceptions`, [machineId]);
  check(ctx, `${label}:no_pending_machine_events`, waiting.deferred === 0 && waiting.exceptions === 0, waiting);

  const openings: PlannedOpening[] = [];
  let collected = 0;
  if (countOk) {
    const legacy = await one<{ since: string | null; cash_cents: number; later_events: number }>(db,
      `WITH last AS (SELECT max(period_end) AS since FROM cash_collections WHERE machine_id = $1)
       SELECT (SELECT since FROM last) AS since,
         round(COALESCE((SELECT sum(e.amount) FROM machine_events e WHERE e.machine_id = $1 AND e.type = ANY($2)
           AND e.received_at > COALESCE((SELECT since FROM last), '-infinity') AND e.received_at <= $3), 0) * 100)::bigint AS cash_cents,
         (SELECT count(*)::int FROM machine_events e WHERE e.machine_id = $1 AND e.type = ANY($4) AND e.received_at > $3) AS later_events`,
      [machineId, [...CASHBOX_IN_EVENT_TYPES], count!.created_at, [...MACHINE_MONEY_EVENT_TYPES]],
    );
    Object.assign(ctx.legacy, { cashbox_expected: legacy.cash_cents, collected: count!.total_cents, money_events_after_collection: legacy.later_events });
    check(ctx, `${label}:collection_matches_legacy_cash_in`, count!.total_cents === legacy.cash_cents, { legacy: legacy.cash_cents, counted: count!.total_cents, since: legacy.since });
    check(ctx, `${label}:idle_since_collection`, legacy.later_events === 0, { events: legacy.later_events });
    collected = count!.total_cents;
    if (vaultId)
      openings.push({ source: { table: 'cash_counts', id: count!.id }, account: { kind: 'VAULT', casinoId: casinoId!, vaultId }, amountCents: collected, refs: { vaultId, machineId: machineId! } });
  }
  // D1 (7c): the machine's floor clearing (tickets printed / accepted while it was LEGACY) is closed by this
  // cutover against opening equity, like the collected cash: target balance 0 once the machine is on the ledger.
  const clearing = await one<{ id: string; balance_cents: number } | undefined>(db,
    `SELECT a.id, b.balance_cents::bigint AS balance_cents FROM ledger_accounts a JOIN ledger_balances b ON b.account_id = a.id
     WHERE a.org_id = $1 AND a.kind = 'LEGACY_FLOOR_CLEARING' AND a.machine_id = $2`, [orgId, machineId]);
  const clearingCents = Number(clearing?.balance_cents ?? 0);
  const unexplained = (await unexplainedFloorClearing(db, { casinoId: casinoId! })).filter((r) => r.id === machineId);
  check(ctx, `${label}:floor_clearing_attributable`, unexplained.length === 0, { machine: machineId });
  ctx.legacy.floor_clearing = clearingCents;
  if (clearing && clearingCents !== 0)
    openings.push({
      source: { table: 'ledger_accounts', id: clearing.id }, account: { kind: 'LEGACY_FLOOR_CLEARING', casinoId: casinoId!, machineId: machineId! },
      amountCents: Math.abs(clearingCents), side: clearingCents > 0 ? 'CREDIT' : 'DEBIT', refs: { machineId: machineId! },
    });
  const vaultBefore = vaultId ? await balance(ctx, { kind: 'VAULT', casinoId: casinoId!, vaultId }) : 0;
  return {
    openings,
    reconcile: async () => {
      for (const kind of ['MACHINE_CREDIT', 'CASHBOX', 'HOPPER'] as const) {
        const b = await balance(ctx, { kind, casinoId: casinoId!, machineId: machineId! });
        ctx.ledger[kind.toLowerCase()] = b;
        check(ctx, `reconcile:${kind.toLowerCase()}_zero`, b === 0, { ledger: b });
      }
      const gaming = await one<{ n: number }>(db, `SELECT count(*)::int n FROM money_transactions WHERE machine_id = $1 AND type = 'GAMING_SETTLEMENT'`, [machineId]);
      check(ctx, 'reconcile:no_gaming_in_ledger', gaming.n === 0, gaming);
      const left = await one<{ b: number } | undefined>(db,
        `SELECT b.balance_cents::bigint AS b FROM ledger_accounts a JOIN ledger_balances b ON b.account_id = a.id WHERE a.kind = 'LEGACY_FLOOR_CLEARING' AND a.machine_id = $1`, [machineId]);
      check(ctx, 'reconcile:floor_clearing_zero', Number(left?.b ?? 0) === 0, { ledger: Number(left?.b ?? 0) });
      const moved = vaultId ? (await balance(ctx, { kind: 'VAULT', casinoId: casinoId!, vaultId })) - vaultBefore : 0;
      ctx.ledger.vault_received = moved;
      check(ctx, 'reconcile:collection_in_vault', moved === collected, { ledger: moved, collected });
    },
  };
}

const PLANNERS: Record<CutoverRail, (ctx: Ctx) => Promise<RailPlan>> = {
  VAULT: planVault,
  CASH: planCash,
  HANDPAY: planHandpay,
  TITO: planTito,
  CASHLESS: planCashless,
  MACHINE: planMachine,
};

// ---- execution ------------------------------------------------------------------------------

async function resolveTarget(db: Db, actor: CutoverActor, target: CutoverTarget) {
  const scope = CUTOVER_SCOPE[target.rail];
  if (!scope) throw new HttpError(400, 'Unknown rail');
  if (scope === 'ORG') return { casinoId: null, machineId: null };
  if (scope === 'MACHINE') {
    if (!target.machineId) throw new HttpError(400, 'machineId required');
    const m = await one<{ casino_id: string } | undefined>(db, 'SELECT casino_id FROM machines WHERE id = $1 AND org_id = $2', [target.machineId, actor.orgId]);
    if (!m || (actor.casinoIds && !actor.casinoIds.includes(m.casino_id))) throw new HttpError(404, 'Machine not found');
    return { casinoId: m.casino_id, machineId: target.machineId };
  }
  if (!target.casinoId) throw new HttpError(400, 'casinoId required');
  const c = await one<{ id: string } | undefined>(db, 'SELECT id FROM casinos WHERE id = $1 AND org_id = $2', [target.casinoId, actor.orgId]);
  if (!c || (actor.casinoIds && !actor.casinoIds.includes(c.id))) throw new HttpError(404, 'Casino not found');
  return { casinoId: target.casinoId, machineId: null };
}

/** Accounts of the rail in scope must be empty before the openings (no ledger money existed on it). */
async function ledgerEmpty(ctx: Ctx, rail: CutoverRail) {
  const kinds = Object.entries(ACCOUNT_KIND_RAIL).filter(([, r]) => r === rail).map(([k]) => k);
  const r = await one<{ total: number; accounts: number }>(ctx.db,
    `SELECT COALESCE(sum(abs(b.balance_cents)), 0)::bigint AS total, count(*)::int AS accounts FROM ledger_accounts a JOIN ledger_balances b ON b.account_id = a.id
     WHERE a.org_id = $1 AND a.kind = ANY($2) AND ($3::uuid IS NULL OR a.casino_id = $3) AND ($4::uuid IS NULL OR a.machine_id = $4)`,
    [ctx.orgId, kinds, ctx.casinoId, ctx.machineId]);
  check(ctx, 'ledger_empty_before_cutover', r.total === 0, r);
}

async function replay(db: Db, row: Record<string, any>): Promise<CutoverReport> {
  const items = (await db.query(
    'SELECT source_table, source_id, account_kind, amount_cents, money_transaction_id FROM money_backfill_items WHERE cutover_id = $1 ORDER BY id', [row.id],
  )).rows;
  return {
    ok: true, dryRun: false, replayed: true, cutoverId: row.id, rail: row.rail, orgId: row.org_id, casinoId: row.casino_id, machineId: row.machine_id,
    asOf: row.as_of, businessDate: row.business_date, checks: row.checks, legacy: row.legacy_totals, ledger: row.ledger_totals,
    openings: items.map((i) => ({ sourceTable: i.source_table, sourceId: i.source_id, accountKind: i.account_kind, amountCents: i.amount_cents, transactionId: i.money_transaction_id })),
  };
}

export interface CutoverOptions {
  dryRun?: boolean;
  /** Test hook: fail after the opening balances were posted (interrupted cutover). */
  failAfterOpenings?: boolean;
}

/**
 * Cuts one rail over to the ledger. Runs inside the caller's database transaction: on any error the
 * caller's ROLLBACK undoes everything. Idempotent: an existing cutover is returned unchanged.
 */
export async function cutoverRail(db: Db, actor: CutoverActor, target: CutoverTarget, opts: CutoverOptions = {}): Promise<CutoverReport> {
  const rail = target.rail;
  const { casinoId, machineId } = await resolveTarget(db, actor, target);
  const orgId = actor.orgId;

  // 1. Legacy tables, 2. org audit lock.
  await db.query(`LOCK TABLE ${LOCK_TABLES[rail].join(', ')} IN SHARE ROW EXCLUSIVE MODE`);
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${orgId}`]);

  const existing = await one<Record<string, any> | undefined>(db,
    `SELECT * FROM money_rail_cutovers WHERE org_id = $1 AND rail = $2 AND casino_id IS NOT DISTINCT FROM $3 AND machine_id IS NOT DISTINCT FROM $4`,
    [orgId, rail, casinoId, machineId]);
  if (existing) return replay(db, existing);

  const cutoverId = randomUUID();
  const snapshot = await one<{ as_of: string; business_date: string }>(db,
    `SELECT now() AS as_of, (now() AT TIME ZONE COALESCE((SELECT timezone FROM casinos WHERE id = $1), 'UTC'))::date::text AS business_date`, [casinoId]);
  const ctx: Ctx = { db, orgId, casinoId, machineId, checks: [], legacy: {}, ledger: {} };
  const report = (ok: boolean, openings: CutoverOpening[]): CutoverReport => ({
    ok, dryRun: !!opts.dryRun, replayed: false, cutoverId: ok && !opts.dryRun ? cutoverId : null, rail, orgId, casinoId, machineId,
    asOf: snapshot.as_of, businessDate: snapshot.business_date, checks: ctx.checks, legacy: ctx.legacy, ledger: ctx.ledger, openings,
  });

  // 3. Preconditions.
  for (const pre of CUTOVER_PREREQUISITES[rail])
    check(ctx, `prerequisite:${pre}`, await railOnLedger(db, orgId, pre, casinoId), { rail: pre });
  await ledgerEmpty(ctx, rail);
  const plan = await PLANNERS[rail](ctx);
  if (ctx.checks.some((c) => !c.ok)) throw new CutoverAborted(report(false, []));

  // 4. Opening balances, each from its legacy source, exactly once.
  await db.query(`SELECT set_config('m1.cutover_id', $1, true)`, [cutoverId]);
  const moneyActor: MoneyActor = actor.employeeId
    ? { type: 'EMPLOYEE', employeeId: actor.employeeId, name: actor.employeeEmail ?? null, ip: actor.ip ?? null }
    : { type: 'SYSTEM', name: 'cutover' };
  const openings: CutoverOpening[] = [];
  for (const o of plan.openings) {
    let transactionId: string | null = null;
    if (o.amountCents > 0) {
      const r = await executeMoneyTransaction(db, {
        orgId, type: 'OPENING_BALANCE', dedupeKey: backfillDedupeKey(rail, o.source), actor: moneyActor,
        reason: `Opening balance, ${rail} cutover (migration 006), from ${o.source.table} ${o.source.id}`,
        ctx: {
          casinoId: casinoId!, amountCents: cents(o.amountCents), backfillSource: o.source, ...o.refs,
          // Assets (vault) are debited, liabilities (tickets, handpays) credited; OPENING_EQUITY is the other side.
          ...((o.side ?? (o.account.kind === 'VAULT' ? 'DEBIT' : 'CREDIT')) === 'DEBIT' ? { debit: o.account, credit: { kind: 'OPENING_EQUITY' } } : { debit: { kind: 'OPENING_EQUITY' }, credit: o.account }),
        },
      });
      if (r.replayed) throw new HttpError(409, `Opening balance for ${o.source.table} ${o.source.id} already exists`);
      transactionId = r.transaction.id;
    }
    await db.query(
      `INSERT INTO money_backfill_items (cutover_id, org_id, source_table, source_id, account_kind, amount_cents, money_transaction_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [cutoverId, orgId, o.source.table, o.source.id, o.account.kind, o.amountCents, transactionId],
    );
    openings.push({ sourceTable: o.source.table, sourceId: o.source.id, accountKind: o.account.kind, amountCents: o.amountCents, transactionId });
  }
  if (opts.failAfterOpenings) throw new Error('Injected failure after opening balances');

  // 5. Reconciliation: ledger = legacy, or nothing happened.
  await plan.reconcile();
  const totalCents = openings.reduce((s, o) => s + o.amountCents, 0);
  check(ctx, 'reconcile:openings_balanced', openings.length === plan.openings.length, { openings: openings.length, planned: plan.openings.length });
  if (ctx.checks.some((c) => !c.ok)) throw new CutoverAborted(report(false, openings));
  if (opts.dryRun) throw new DryRunComplete(report(true, openings));

  // 6. The rail is on the ledger from the commit of this transaction.
  await db.query(
    `INSERT INTO money_rail_cutovers (id, org_id, rail, casino_id, machine_id, as_of, business_date, actor_type, executed_by, opening_count, opening_total_cents, legacy_totals, ledger_totals, checks)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [cutoverId, orgId, rail, casinoId, machineId, snapshot.as_of, snapshot.business_date, actor.employeeId ? 'EMPLOYEE' : 'SYSTEM', actor.employeeId ?? null,
      openings.filter((o) => o.transactionId).length, totalCents, JSON.stringify(ctx.legacy), JSON.stringify(ctx.ledger), JSON.stringify(ctx.checks)],
  );
  await db.query(`SELECT set_config('m1.cutover_id', '', true)`);
  await writeAudit(db as PoolClient, {
    orgId, casinoId, actorType: actor.employeeId ? 'EMPLOYEE' : 'SYSTEM', actorId: actor.employeeId ?? null, actorName: actor.employeeEmail ?? 'cutover', ip: actor.ip ?? null,
    action: 'money.cutover', entityType: 'money_rail_cutover', entityId: cutoverId,
    details: { rail, machineId, openingCount: openings.length, openingTotalCents: totalCents, legacy: ctx.legacy, ledger: ctx.ledger },
  });
  return report(true, openings);
}

/** Runs a cutover in its own transaction. */
export function runCutover(pool: Pool, actor: CutoverActor, target: CutoverTarget, opts: Omit<CutoverOptions, 'dryRun'> = {}) {
  return withTransaction(pool, (db) => cutoverRail(db, actor, target, opts));
}

/** Executes the full cutover and rolls it back: the report shows exactly what a real run would do. */
export async function dryRunCutover(pool: Pool, actor: CutoverActor, target: CutoverTarget): Promise<CutoverReport> {
  try {
    return await withTransaction(pool, (db) => cutoverRail(db, actor, target, { dryRun: true }));
  } catch (err) {
    if (err instanceof DryRunComplete) return err.report;
    if (err instanceof CutoverAborted) return { ...err.report, dryRun: true };
    throw err;
  }
}

/** Current mode of every rail of a casino (and the organisation's cashless rail). */
export async function railStatus(db: Db, orgId: string, casinoId: string) {
  const rows = (await db.query(
    `SELECT id, rail, casino_id, machine_id, as_of, business_date, actor_type, executed_by, opening_count, opening_total_cents
     FROM money_rail_cutovers WHERE org_id = $1 AND (casino_id = $2 OR rail = 'CASHLESS') ORDER BY as_of`,
    [orgId, casinoId],
  )).rows;
  const rails = (['VAULT', 'CASH', 'HANDPAY', 'TITO', 'CASHLESS'] as const).map((rail) => ({ rail, mode: rows.some((r) => r.rail === rail) ? 'LEDGER' : 'LEGACY' }));
  return { rails, machinesOnLedger: rows.filter((r) => r.rail === 'MACHINE').length, cutovers: rows };
}

// ---- cutover counts (four eyes) --------------------------------------------------------------

type ScopedActor = CutoverActor & { casinoIds: string[] };
export type CutoverCountContext = 'VAULT_CUTOVER' | 'DRAWER_CUTOVER' | 'MACHINE_DROP';

/** First, blind physical count of a vault, a cash desk or a machine collection for a cutover. */
export async function recordCutoverCount(
  db: Db,
  a: ScopedActor,
  input: CountInput & { casinoId: string; context: CutoverCountContext; vaultId?: string; cashDeskId?: string; machineId?: string },
) {
  const refs = { VAULT_CUTOVER: input.vaultId, DRAWER_CUTOVER: input.cashDeskId, MACHINE_DROP: input.machineId };
  if (!refs[input.context]) throw new HttpError(400, `${input.context} needs ${input.context === 'VAULT_CUTOVER' ? 'vaultId' : input.context === 'DRAWER_CUTOVER' ? 'cashDeskId' : 'machineId'}`);
  const count = await recordCashCount(db, a, {
    ...input, blind: true,
    vaultId: input.context === 'VAULT_CUTOVER' ? input.vaultId : undefined,
    cashDeskId: input.context === 'DRAWER_CUTOVER' ? input.cashDeskId : undefined,
    machineId: input.context === 'MACHINE_DROP' ? input.machineId : undefined,
  });
  await writeAudit(db as PoolClient, {
    orgId: a.orgId, casinoId: input.casinoId, actorType: 'EMPLOYEE', actorId: a.employeeId ?? null, actorName: a.employeeEmail ?? null, ip: a.ip ?? null,
    action: 'cash_count.recorded', entityType: 'cash_count', entityId: count.id, details: { context: input.context, totalCents: count.total_cents },
  });
  return count;
}

/**
 * Second, independent blind count by a different employee. The database decides whether it matches;
 * a mismatch is recorded too (audit), and the count stays unverified.
 */
export async function verifyCutoverCount(db: Db, a: ScopedActor, countId: string, input: CountInput) {
  if (!a.employeeId) throw new HttpError(400, 'An employee must verify');
  const c = await one<{ id: string; casino_id: string; context: string } | undefined>(db, 'SELECT id, casino_id, context FROM cash_counts WHERE id = $1 AND org_id = $2', [countId, a.orgId]);
  if (!c || !a.casinoIds.includes(c.casino_id)) throw new HttpError(404, 'Count not found');
  const total = countTotal(input);
  let v;
  try {
    v = (await db.query(
      'INSERT INTO cash_count_verifications (org_id, count_id, total_cents, matches, verified_by, note) VALUES ($1,$2,$3,false,$4,$5) RETURNING *',
      [a.orgId, countId, total, a.employeeId, input.note ?? null],
    )).rows[0];
  } catch (err) {
    if (/different employee/.test((err as Error).message)) throw new HttpError(409, 'The second count must be done by a different employee');
    throw err;
  }
  await writeAudit(db as PoolClient, {
    orgId: a.orgId, casinoId: c.casino_id, actorType: 'EMPLOYEE', actorId: a.employeeId, actorName: a.employeeEmail ?? null, ip: a.ip ?? null,
    action: v.matches ? 'cash_count.verified' : 'cash_count.verification_mismatch', entityType: 'cash_count', entityId: countId, details: { totalCents: total, matches: v.matches },
  });
  return v as { id: number; matches: boolean; total_cents: number };
}

/** Fresh database only: rails without legacy money and without legacy writers start on the ledger. */
export async function cutoverFreshRails(pool: Pool) {
  const orgs = (await pool.query('SELECT id FROM organizations ORDER BY created_at, id')).rows;
  const reports = [];
  for (const o of orgs) reports.push(await runCutover(pool, { orgId: o.id }, { rail: 'CASHLESS' }));
  return reports;
}
