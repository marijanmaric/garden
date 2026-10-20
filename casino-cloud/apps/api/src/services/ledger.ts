import { createHash } from 'node:crypto';
import { writeAudit, type PoolClient } from '@m1/database';
import {
  ACCOUNT_KINDS, ACCOUNT_KIND_RAIL, CORRECTION_TYPES, MONEY_TRANSACTIONS, MoneyError, accountKey, cents, postings as buildPostings,
  type AccountKind, type AccountRef, type MoneyContext, type MoneyTransactionType, type Posting,
} from '@m1/shared';
import { HttpError, stateError } from '../auth';

/**
 * The ledger service: the ONE execution path for money. Every money movement is a balanced,
 * immutable money transaction built from the shared transaction matrix (postings()).
 *
 * Runs inside the caller's database transaction (for HTTP routes: the Step 1 idempotent()
 * wrapper). Lock order, always: org audit lock -> ledger balance rows by ascending account id.
 */

type Db = Pick<PoolClient, 'query'>;

export interface MoneyActor {
  type: 'EMPLOYEE' | 'GATEWAY' | 'SYSTEM';
  employeeId?: string | null;
  name?: string | null;
  ip?: string | null;
}

export interface ExecuteMoneyInput {
  orgId: string;
  type: MoneyTransactionType;
  ctx: MoneyContext;
  /** Exactly-once key, unique per organisation. Build it with clientDedupeKey / eventDedupeKey / entityDedupeKey. */
  dedupeKey: string;
  actor: MoneyActor;
  approvedBy?: string | null;
  reason?: string | null;
  sourceEventId?: string | null;
  /**
   * The casino business date the money belongs to, when it is not today: only for the controlled
   * replay of a deferred event. It must equal the business date of the source event's occurred_at and
   * of its pending deferred record; a closed date is still refused. Not exposed by any API request.
   */
  businessDate?: string | null;
  /**
   * Step 7d: an approved late-event posting (D4). The booking lands on today's open business date, but the
   * transaction itself records the original event, its occurred_at / received_at, the original (closed)
   * business date, the reason and both people (requester = actor, decider = approver). Validated against
   * the approved LATE_EVENT_BOOKING approval and the pending deferred record; never a free override.
   */
  latePosting?: LatePosting | null;
}

export interface LatePosting {
  approvalId: string;
  originalBusinessDate: string;
  occurredAt: string;
  receivedAt: string;
  reason: string;
  requestedBy: string;
  approvedBy: string;
}

export interface MoneyTransactionRow {
  id: string;
  org_id: string;
  casino_id: string | null;
  type: MoneyTransactionType;
  amount_cents: number;
  dedupe_key: string;
  reversal_of: string | null;
  business_date: string;
  created_at: string;
  [k: string]: unknown;
}

export interface LedgerEntryRow {
  id: number;
  account_id: string;
  kind: AccountKind;
  amount_cents: number;
}

export interface ExecuteMoneyResult {
  transaction: MoneyTransactionRow;
  entries: LedgerEntryRow[];
  replayed: boolean;
}

// ---- dedupe keys ---------------------------------------------------------------------------

/** Operator action: the Step 1 Idempotency-Key, scoped to the employee and the transaction type. */
export function clientDedupeKey(employeeId: string, idempotencyKey: string, type: MoneyTransactionType, part?: string) {
  return ['client', employeeId, idempotencyKey, type, part].filter(Boolean).join(':');
}

/** Machine event from a gateway. */
export function eventDedupeKey(eventId: string, type: MoneyTransactionType) {
  return `event:${eventId}:${type}`;
}

/** Domain entity or background job, e.g. entityDedupeKey('ticket', id, 'expiry'). */
export function entityDedupeKey(...parts: string[]) {
  return ['entity', ...parts].join(':');
}

// ---- execution -----------------------------------------------------------------------------

const REF_COLUMNS = {
  playerId: 'player_id', walletId: 'wallet_id', cardId: 'card_id', machineId: 'machine_id', cashierSessionId: 'cashier_session_id',
  vaultId: 'vault_id', ticketId: 'ticket_id', handpayId: 'handpay_id', transferId: 'transfer_id',
} as const;

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
}

/** Hash of everything that defines the money movement (used to detect dedupe key reuse). */
function requestHash(input: ExecuteMoneyInput, list: Posting[], reversalOf: string | null) {
  const refs = Object.fromEntries(Object.keys(REF_COLUMNS).map((k) => [k, input.ctx[k as keyof typeof REF_COLUMNS] ?? null]));
  return createHash('sha256')
    .update(stable({
      type: input.type, amount: input.ctx.amountCents, casino: input.ctx.casinoId, refs, reversalOf, sourceEventId: input.sourceEventId ?? null,
      backfillSource: input.ctx.backfillSource ?? null,
      postings: list.map((p) => [accountKey(p.account), p.amountCents]),
    }))
    .digest('hex');
}

/** Finds or creates the account for a reference. Scope comes from the shared kind definition. */
async function ensureAccount(db: Db, orgId: string, ref: AccountRef): Promise<string> {
  const def = ACCOUNT_KINDS[ref.kind];
  const values = [
    orgId, ref.kind, def.scope === 'CASINO' ? ref.casinoId : null,
    def.owner === 'MACHINE' ? ref.machineId : null, def.owner === 'WALLET' ? ref.walletId : null,
    def.owner === 'CASHIER_SESSION' ? ref.cashierSessionId : null, def.owner === 'VAULT' ? ref.vaultId : null,
  ];
  const ins = await db.query(
    `INSERT INTO ledger_accounts (org_id, kind, casino_id, machine_id, wallet_id, cashier_session_id, vault_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT ON CONSTRAINT ledger_accounts_identity DO NOTHING RETURNING id`,
    values,
  );
  if (ins.rowCount) return ins.rows[0].id;
  const sel = await db.query(
    `SELECT id FROM ledger_accounts WHERE org_id = $1 AND kind = $2 AND casino_id IS NOT DISTINCT FROM $3 AND machine_id IS NOT DISTINCT FROM $4
       AND wallet_id IS NOT DISTINCT FROM $5 AND cashier_session_id IS NOT DISTINCT FROM $6 AND vault_id IS NOT DISTINCT FROM $7`,
    values,
  );
  return sel.rows[0].id;
}

async function loadEntries(db: Db, transactionId: string): Promise<LedgerEntryRow[]> {
  const r = await db.query(
    `SELECT e.id, e.account_id, a.kind, e.amount_cents FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
     WHERE e.transaction_id = $1 ORDER BY e.id`,
    [transactionId],
  );
  return r.rows;
}

async function execute(db: Db, input: ExecuteMoneyInput, reversalOf: string | null): Promise<ExecuteMoneyResult> {
  let list: Posting[];
  try {
    list = buildPostings(input.type, input.ctx);
  } catch (err) {
    if (err instanceof MoneyError) throw new HttpError(400, err.message);
    throw err;
  }
  if (!input.dedupeKey || input.dedupeKey.length > 300) throw new HttpError(400, 'Invalid dedupe key');
  const hash = requestHash(input, list, reversalOf);

  // 1. Org lock (the same lock writeAudit takes): keeps the lock order fixed and the audit chain linear.
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${input.orgId}`]);

  // An explicit business date only for the replay of a pending deferred record, validated against the
  // original machine event (occurred_at in the casino time zone), never a free override.
  if (input.businessDate != null) {
    if (!input.sourceEventId) throw new HttpError(409, 'An explicit business date needs its source event');
    const ok = await db.query(
      `SELECT 1 FROM deferred_money_events d JOIN machine_events e ON e.event_id = d.event_id JOIN casinos c ON c.id = d.casino_id
       WHERE d.event_id = $1 AND d.org_id = $2 AND d.casino_id = $3 AND d.status = 'PENDING'
         AND d.business_date = $4::date AND (e.occurred_at AT TIME ZONE c.timezone)::date = $4::date
         AND $4::date <= (now() AT TIME ZONE c.timezone)::date`,
      [input.sourceEventId, input.orgId, input.ctx.casinoId, input.businessDate]);
    if (!ok.rowCount) throw new HttpError(409, `Business date ${input.businessDate} does not match a pending deferred event`);
  }

  // An approved late-event posting: only through the four-eyes LATE_EVENT_BOOKING of this very event, whose
  // original business date is closed. The booking is attributed to both people and references the event.
  if (input.latePosting) {
    const lp = input.latePosting;
    if (!input.sourceEventId || input.businessDate != null) throw new HttpError(409, 'A late-event posting needs its source event and books on the open business date');
    const ok = await db.query(
      `SELECT 1 FROM approvals ap JOIN deferred_money_events d ON d.event_id::text = ap.entity_id
       WHERE ap.id = $1 AND ap.org_id = $2 AND ap.action = 'LATE_EVENT_BOOKING' AND ap.status = 'APPROVED' AND ap.entity_id = $3::text
         AND ap.requested_by = $4 AND ap.decided_by = $5 AND ap.requested_by <> ap.decided_by
         AND d.status = 'PENDING' AND d.business_date = $6::date
         AND EXISTS (SELECT 1 FROM business_day_closes b WHERE b.casino_id = d.casino_id AND b.business_date = d.business_date)`,
      [lp.approvalId, input.orgId, input.sourceEventId, lp.requestedBy, lp.approvedBy, lp.originalBusinessDate]);
    if (!ok.rowCount) throw new HttpError(409, 'A late-event posting needs an approved four-eyes late-event booking of this event and its closed business date');
    input = {
      ...input, actor: { type: 'EMPLOYEE', employeeId: lp.requestedBy }, approvedBy: lp.approvedBy,
      reason: `Late event ${input.sourceEventId}: occurred ${lp.occurredAt} on closed business date ${lp.originalBusinessDate}, received ${lp.receivedAt}; approved late posting (${lp.reason})`,
    };
  }

  // A closed business date takes no money (the database refuses it too); answer with a clear 409.
  const closed = await db.query(
    `SELECT d.business_date::text AS d FROM business_day_closes d JOIN casinos c ON c.id = d.casino_id
     WHERE d.casino_id = $1 AND d.business_date = COALESCE($2::date, (now() AT TIME ZONE c.timezone)::date)`, [input.ctx.casinoId, input.businessDate ?? null]);
  if (closed.rowCount) throw stateError(409, 'BUSINESS_DATE_CLOSED', `Business date ${closed.rows[0].d} of this casino is closed`);

  // 2. Exactly once per dedupe key.
  // Same order as the reference columns in the INSERT below.
  const refs = (Object.keys(REF_COLUMNS) as Array<keyof typeof REF_COLUMNS>).map((k) => input.ctx[k] ?? null);
  const options = {
    payTo: input.ctx.payTo, payFrom: input.ctx.payFrom, source: input.ctx.source, feeCents: input.ctx.feeCents, backfillSource: input.ctx.backfillSource, floorClearing: input.ctx.floorClearing,
    lateEvent: input.latePosting ? { sourceEventId: input.sourceEventId, ...input.latePosting } : undefined,
  };
  const inserted = await db.query(
    `INSERT INTO money_transactions (org_id, casino_id, type, amount_cents, dedupe_key, request_hash,
       player_id, wallet_id, card_id, machine_id, cashier_session_id, vault_id, ticket_id, handpay_id, transfer_id,
       source_event_id, options, reversal_of, reason, actor_type, actor_id, approved_by, business_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
       COALESCE($23::date, (now() AT TIME ZONE COALESCE((SELECT timezone FROM casinos WHERE id = $2), 'UTC'))::date))
     ON CONFLICT ON CONSTRAINT money_transactions_dedupe DO NOTHING RETURNING *`,
    [input.orgId, input.ctx.casinoId, input.type, input.ctx.amountCents, input.dedupeKey, hash, ...refs,
      input.sourceEventId ?? null, JSON.stringify(options), reversalOf, input.reason ?? null, input.actor.type,
      input.actor.employeeId ?? null, input.approvedBy ?? null, input.businessDate ?? null],
  );
  if (!inserted.rowCount) {
    const prev = (await db.query('SELECT * FROM money_transactions WHERE org_id = $1 AND dedupe_key = $2', [input.orgId, input.dedupeKey])).rows[0];
    if (prev.request_hash !== hash) throw stateError(409, 'IDEMPOTENCY_CONFLICT', 'This money transaction key was already used for a different transaction');
    return { transaction: prev, entries: await loadEntries(db, prev.id), replayed: true };
  }
  const tx: MoneyTransactionRow = inserted.rows[0];

  // Final rail rule (also enforced by the database): money moves only on rails that are on the ledger
  // and not frozen. A replay of an existing transaction (above) is always answered.
  await assertRails(db, input.orgId, input.type, input.ctx.casinoId, list);

  // 3. Accounts, then 4. lock their balances in ascending id order.
  const withIds = [];
  for (const p of list) withIds.push({ ...p, accountId: await ensureAccount(db, input.orgId, p.account) });
  withIds.sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  const ids = [...new Set(withIds.map((p) => p.accountId))];
  const locked = await db.query(
    'SELECT account_id, balance_cents, allow_negative, normal_sign FROM ledger_balances WHERE account_id = ANY($1) ORDER BY account_id FOR UPDATE',
    [ids],
  );
  const balances = new Map(locked.rows.map((r) => [r.account_id, r]));

  // 5. Clear error before the database CHECK (which remains the final guarantee).
  const delta = new Map<string, number>();
  for (const p of withIds) delta.set(p.accountId, (delta.get(p.accountId) ?? 0) + p.amountCents);
  for (const p of withIds) {
    const b = balances.get(p.accountId);
    const after = b.balance_cents + delta.get(p.accountId)!;
    if (!b.allow_negative && after * b.normal_sign < 0) throw stateError(409, 'INSUFFICIENT_BALANCE', `Insufficient balance on ${p.account.kind}`);
  }

  // 6. Entries (the posting trigger updates the balances).
  for (const p of withIds) {
    try {
      await db.query('INSERT INTO ledger_entries (transaction_id, account_id, amount_cents, org_id) VALUES ($1,$2,$3,$4)', [tx.id, p.accountId, p.amountCents, input.orgId]);
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'ledger_balances_sufficient') throw stateError(409, 'INSUFFICIENT_BALANCE', `Insufficient balance on ${p.account.kind}`);
      throw err;
    }
  }

  // 7. Audit in the same transaction: ids, kinds and amounts only, no personal data.
  await writeAudit(db as PoolClient, {
    orgId: input.orgId, casinoId: input.ctx.casinoId, actorType: input.actor.type, actorId: input.actor.employeeId ?? null,
    actorName: input.actor.name ?? null, ip: input.actor.ip ?? null, action: `money.${input.type.toLowerCase()}`,
    entityType: 'money_transaction', entityId: tx.id,
    details: {
      type: input.type, amountCents: input.ctx.amountCents, reversalOf,
      entries: withIds.map((p) => ({ kind: p.account.kind, amountCents: p.amountCents })),
      refs: Object.fromEntries(Object.entries(REF_COLUMNS).map(([k]) => [k, input.ctx[k as keyof typeof REF_COLUMNS] ?? null]).filter(([, v]) => v)),
    },
  });

  return { transaction: tx, entries: await loadEntries(db, tx.id), replayed: false };
}

/**
 * The ledger guard at the service layer, with clear errors before the database guard:
 *  - LEGACY rail: no ledger booking on its accounts;
 *  - frozen rail (reconciliation mismatch) or GLOBAL freeze: only corrections;
 *  - OPENING_BALANCE: only inside a rail cutover.
 */
async function assertRails(db: Db, orgId: string, type: MoneyTransactionType, casinoId: string, list: Posting[]) {
  const correction = (CORRECTION_TYPES as readonly string[]).includes(type);
  if (type === 'OPENING_BALANCE') {
    const inCutover = (await db.query(`SELECT current_setting('m1.cutover_id', true) AS id`)).rows[0].id;
    if (!inCutover) throw new HttpError(409, 'Opening balances are only created by a rail cutover');
  }
  const seen = new Set<string>();
  const targets: Array<{ rail: string | null; casinoId: string | null; machineId: string | null }> = [{ rail: null, casinoId, machineId: null }];
  for (const p of list) {
    const rail = ACCOUNT_KIND_RAIL[p.account.kind];
    if (rail) targets.push({ rail, casinoId: p.account.casinoId ?? casinoId, machineId: p.account.machineId ?? null });
  }
  for (const t of targets) {
    const key = `${t.rail}:${t.casinoId}:${t.machineId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = (await db.query(
      'SELECT CASE WHEN $3::text IS NULL THEN true ELSE money_rail_ledger($1, $2, $3, $4) END AS ledger, money_rail_frozen($1, $2, $3, $4) AS frozen',
      [orgId, t.casinoId, t.rail, t.machineId],
    )).rows[0];
    if (!correction && r.frozen) throw stateError(409, 'RAIL_FROZEN', `${t.rail ?? 'Money'} is frozen after a reconciliation mismatch: only corrections are allowed`);
    if (type !== 'OPENING_BALANCE' && !r.ledger) throw stateError(409, 'RAIL_LEGACY', `${t.rail} money is not on the ledger for this ${t.rail === 'MACHINE' ? 'machine' : t.rail === 'CASHLESS' ? 'organisation' : 'casino'} (cutover pending)`);
  }
}

/** Executes one money transaction from the shared matrix. Not for REVERSAL (use reverseMoneyTransaction). */
export async function executeMoneyTransaction(db: Db, input: ExecuteMoneyInput): Promise<ExecuteMoneyResult> {
  if (input.type === 'REVERSAL') throw new HttpError(400, 'Use reverseMoneyTransaction for reversals');
  return execute(db, input, null);
}

/**
 * Reverses a transaction with a NEW transaction that negates its entries exactly.
 * The original is never modified. One reversal per original; reversals cannot be reversed.
 */
export async function reverseMoneyTransaction(
  db: Db,
  input: { orgId: string; transactionId: string; dedupeKey: string; actor: MoneyActor; reason: string; approvedBy?: string | null },
): Promise<ExecuteMoneyResult> {
  if (!input.reason || input.reason.trim().length < 3) throw new HttpError(400, 'A reason is required');
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${input.orgId}`]);
  const o = await db.query('SELECT * FROM money_transactions WHERE id = $1 AND org_id = $2 FOR UPDATE', [input.transactionId, input.orgId]);
  const original: MoneyTransactionRow | undefined = o.rows[0];
  if (!original) throw new HttpError(404, 'Money transaction not found');
  const rule = MONEY_TRANSACTIONS[original.type].reversal;
  if (rule.kind !== 'REVERSAL')
    throw new HttpError(409, rule.kind === 'VIA' ? `${original.type} is undone with ${rule.type}, not reversed` : `${original.type} cannot be reversed`);
  const existing = (await db.query('SELECT * FROM money_transactions WHERE reversal_of = $1', [original.id])).rows[0];
  if (existing) {
    if (existing.dedupe_key === input.dedupeKey) return { transaction: existing, entries: await loadEntries(db, existing.id), replayed: true };
    throw new HttpError(409, 'Transaction was already reversed');
  }
  const accounts = await db.query(
    `SELECT e.amount_cents, a.kind, a.casino_id, a.machine_id, a.wallet_id, a.cashier_session_id, a.vault_id
     FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.transaction_id = $1 ORDER BY e.id`,
    [original.id],
  );
  const originalPostings: Posting[] = accounts.rows.map((r) => ({
    amountCents: cents(r.amount_cents),
    account: {
      kind: r.kind, casinoId: r.casino_id ?? undefined, machineId: r.machine_id ?? undefined, walletId: r.wallet_id ?? undefined,
      cashierSessionId: r.cashier_session_id ?? undefined, vaultId: r.vault_id ?? undefined,
    },
  }));
  return execute(
    db,
    {
      orgId: input.orgId, type: 'REVERSAL', dedupeKey: input.dedupeKey, actor: input.actor, reason: input.reason, approvedBy: input.approvedBy,
      ctx: {
        casinoId: original.casino_id!, amountCents: cents(Math.abs(original.amount_cents)), original: originalPostings,
        playerId: (original.player_id as string) ?? undefined, walletId: (original.wallet_id as string) ?? undefined, cardId: (original.card_id as string) ?? undefined,
        machineId: (original.machine_id as string) ?? undefined, cashierSessionId: (original.cashier_session_id as string) ?? undefined,
        vaultId: (original.vault_id as string) ?? undefined, ticketId: (original.ticket_id as string) ?? undefined,
        handpayId: (original.handpay_id as string) ?? undefined, transferId: (original.transfer_id as string) ?? undefined,
      },
    },
    original.id,
  );
}

// ---- reading -------------------------------------------------------------------------------

/** Displayed balance of one account reference (0 if the account does not exist yet). */
export async function getBalance(db: Db, orgId: string, ref: AccountRef): Promise<number> {
  const def = ACCOUNT_KINDS[ref.kind];
  const r = await db.query(
    `SELECT b.balance_cents * b.normal_sign AS balance FROM ledger_accounts a JOIN ledger_balances b ON b.account_id = a.id
     WHERE a.org_id = $1 AND a.kind = $2 AND a.casino_id IS NOT DISTINCT FROM $3 AND a.machine_id IS NOT DISTINCT FROM $4
       AND a.wallet_id IS NOT DISTINCT FROM $5 AND a.cashier_session_id IS NOT DISTINCT FROM $6 AND a.vault_id IS NOT DISTINCT FROM $7`,
    [orgId, ref.kind, def.scope === 'CASINO' ? ref.casinoId : null, ref.machineId ?? null, ref.walletId ?? null, ref.cashierSessionId ?? null, ref.vaultId ?? null],
  );
  return r.rows[0]?.balance ?? 0;
}

export interface LedgerInvariants {
  ok: boolean;
  transactions: number;
  entries: number;
  accounts: number;
  totalSumCents: number;
  unbalancedTransactions: number;
  balanceMismatches: number;
  overdrawnAccounts: number;
  reversalMismatches: number;
  scopeViolations: number;
}

/** Recomputes the ledger invariants for an organisation (or all organisations). */
export async function checkLedgerInvariants(db: Db, orgId?: string): Promise<LedgerInvariants> {
  const org = orgId ?? null;
  const r = await db.query(
    `SELECT
       (SELECT count(*) FROM money_transactions WHERE $1::uuid IS NULL OR org_id = $1) AS transactions,
       (SELECT count(*) FROM ledger_entries WHERE $1::uuid IS NULL OR org_id = $1) AS entries,
       (SELECT count(*) FROM ledger_accounts WHERE $1::uuid IS NULL OR org_id = $1) AS accounts,
       (SELECT COALESCE(sum(amount_cents), 0) FROM ledger_entries WHERE $1::uuid IS NULL OR org_id = $1) AS total_sum,
       (SELECT count(*) FROM (
          SELECT t.id FROM money_transactions t LEFT JOIN ledger_entries e ON e.transaction_id = t.id
          WHERE $1::uuid IS NULL OR t.org_id = $1 GROUP BY t.id HAVING count(e.id) < 2 OR COALESCE(sum(e.amount_cents), 0) <> 0) x) AS unbalanced,
       (SELECT count(*) FROM ledger_balances b
          WHERE ($1::uuid IS NULL OR b.org_id = $1)
            AND b.balance_cents <> COALESCE((SELECT sum(e.amount_cents) FROM ledger_entries e WHERE e.account_id = b.account_id), 0)) AS mismatches,
       (SELECT count(*) FROM ledger_balances b WHERE ($1::uuid IS NULL OR b.org_id = $1) AND NOT b.allow_negative AND b.balance_cents * b.normal_sign < 0) AS overdrawn,
       (SELECT count(*) FROM (
          SELECT r.id FROM money_transactions r
          JOIN ledger_entries e ON e.transaction_id IN (r.id, r.reversal_of)
          WHERE r.reversal_of IS NOT NULL AND ($1::uuid IS NULL OR r.org_id = $1)
          GROUP BY r.id, e.account_id HAVING sum(e.amount_cents) <> 0) x) AS reversal_mismatches,
       (SELECT count(*) FROM ledger_accounts a JOIN ledger_account_kinds k ON k.code = a.kind
          WHERE ($1::uuid IS NULL OR a.org_id = $1) AND ((k.scope = 'ORG') <> (a.casino_id IS NULL))) AS scope_violations`,
    [org],
  );
  const x = r.rows[0];
  const result = {
    transactions: x.transactions, entries: x.entries, accounts: x.accounts, totalSumCents: x.total_sum, unbalancedTransactions: x.unbalanced,
    balanceMismatches: x.mismatches, overdrawnAccounts: x.overdrawn, reversalMismatches: x.reversal_mismatches, scopeViolations: x.scope_violations,
  };
  return {
    ok: result.totalSumCents === 0 && !result.unbalancedTransactions && !result.balanceMismatches && !result.overdrawnAccounts && !result.reversalMismatches && !result.scopeViolations,
    ...result,
  };
}
