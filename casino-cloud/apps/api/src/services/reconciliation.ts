import { withTransaction, writeAudit, type Pool, type PoolClient } from '@m1/database';
import type { FreezeRail } from '@m1/shared';
import { HttpError } from '../auth';
import type { BusMessage } from '../bus';
import { openAlert } from './alerts';
import { consumeApproval, decideApproval, requestApproval } from './approvals';
import type { CashActor } from './cash-ops';
import { checkLedgerInvariants } from './ledger';
import { replayDeferredHandpays } from './handpays';

/**
 * Continuous reconciliation (Step 7a: CASH, VAULT and the global ledger invariants; Step 7b: HANDPAY).
 *
 * Every failed check is CRITICAL: an alert is raised and the affected rail is FROZEN for the
 * casino (a global invariant freezes the whole organisation). A frozen rail takes only corrections;
 * other rails continue. Day close is blocked while anything is frozen or unreconciled. A freeze is
 * lifted only after a clean run of its rail; a discrepancy that is understood but cannot be undone
 * (e.g. a wrong legacy projection row) is explained by two different employees, never ignored.
 */

type Db = Pick<PoolClient, 'query'>;

export interface ReconCheck {
  key: string;
  rail: 'CASH' | 'VAULT' | 'HANDPAY' | 'GLOBAL';
  ok: boolean;
  items: string[];
  resolved: string[];
}

export interface ReconResult {
  runId: string;
  ok: boolean;
  checks: ReconCheck[];
  frozen: Array<{ id: string; rail: FreezeRail }>;
}

const rows = async (db: Db, sql: string, params: unknown[]) => (await db.query(sql, params)).rows;

async function cutoverTime(db: Db, orgId: string, casinoId: string, rail: 'CASH' | 'VAULT' | 'HANDPAY'): Promise<string | null> {
  const r = await rows(db, `SELECT as_of FROM money_rail_cutovers WHERE org_id = $1 AND casino_id = $2 AND rail = $3 AND created_txid <> pg_current_xact_id()`, [orgId, casinoId, rail]);
  return r[0]?.as_of ?? null;
}

async function cashChecks(db: Db, casinoId: string, since: string) {
  const p = [casinoId, since];
  const ids = async (sql: string, prefix: string) => (await rows(db, sql, p)).map((r) => `${prefix}:${r.id}`);
  return [
    {
      key: 'cash.projection_linked',
      items: await ids(`SELECT id FROM cash_transactions WHERE casino_id = $1 AND created_at > $2 AND money_transaction_id IS NULL ORDER BY id`, 'cash_tx'),
    },
    {
      key: 'cash.projection_amount',
      items: await ids(
        `SELECT ct.id FROM cash_transactions ct WHERE ct.casino_id = $1 AND ct.created_at > $2 AND ct.money_transaction_id IS NOT NULL
           AND round(ct.amount * 100)::bigint <> COALESCE((SELECT sum(e.amount_cents) FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
                                                             WHERE e.transaction_id = ct.money_transaction_id AND a.kind = 'DRAWER' AND a.cashier_session_id = ct.session_id), 0)
         ORDER BY ct.id`, 'cash_tx'),
    },
    {
      key: 'cash.ledger_projected',
      items: await ids(
        `SELECT t.id FROM money_transactions t WHERE t.casino_id = $1 AND t.created_at > $2 AND t.type <> 'DRAWER_SHORT_OVER'
           AND EXISTS (SELECT 1 FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.transaction_id = t.id AND a.kind = 'DRAWER')
           AND NOT EXISTS (SELECT 1 FROM cash_transactions ct WHERE ct.money_transaction_id = t.id)
         ORDER BY t.created_at, t.id`, 'money_tx'),
    },
    {
      // legacy drawer formula = ledger drawer, for every shift opened on the ledger
      key: 'cash.shift_balances',
      items: await ids(
        `SELECT s.id FROM cashier_sessions s WHERE s.casino_id = $1 AND s.opened_at > $2
           AND round((s.opening_balance + COALESCE((SELECT sum(ct.amount) FROM cash_transactions ct WHERE ct.session_id = s.id), 0) + COALESCE(s.difference, 0)) * 100)::bigint
               <> COALESCE((SELECT b.balance_cents FROM ledger_accounts a JOIN ledger_balances b ON b.account_id = a.id WHERE a.kind = 'DRAWER' AND a.cashier_session_id = s.id), 0)
         ORDER BY s.opened_at, s.id`, 'session'),
    },
    {
      key: 'cash.closed_shifts_empty',
      items: await ids(
        `SELECT s.id FROM cashier_sessions s JOIN ledger_accounts a ON a.kind = 'DRAWER' AND a.cashier_session_id = s.id JOIN ledger_balances b ON b.account_id = a.id
         WHERE s.casino_id = $1 AND s.opened_at > $2 AND s.status = 'CLOSED' AND b.balance_cents <> 0 ORDER BY s.id`, 'session'),
    },
  ];
}

async function vaultChecks(db: Db, casinoId: string, since: string) {
  const p = [casinoId, since];
  const ids = async (sql: string, prefix: string) => (await rows(db, sql, p)).map((r) => `${prefix}:${r.id}`);
  return [
    {
      key: 'vault.movements_booked',
      items: await ids(
        `SELECT m.id FROM cash_movements m JOIN money_transactions t ON t.id = m.money_transaction_id
         WHERE m.casino_id = $1 AND m.requested_at > $2 AND m.status = 'CONFIRMED'
           AND (t.amount_cents <> m.amount_cents OR t.type <> CASE m.kind WHEN 'FILL' THEN 'VAULT_FILL' ELSE 'VAULT_DROP' END
                OR t.cashier_session_id <> m.cashier_session_id OR t.vault_id <> m.vault_id)
         ORDER BY m.id`, 'movement'),
    },
    {
      key: 'vault.ledger_explained',
      items: await ids(
        `SELECT t.id FROM money_transactions t WHERE t.casino_id = $1 AND t.created_at > $2 AND t.type IN ('VAULT_FILL', 'VAULT_DROP')
           AND NOT EXISTS (SELECT 1 FROM cash_movements m WHERE m.money_transaction_id = t.id) ORDER BY t.created_at, t.id`, 'money_tx'),
    },
    {
      key: 'vault.count_differences_booked',
      items: await ids(
        `SELECT x.count_id AS id FROM count_settlements x JOIN cash_counts c ON c.id = x.count_id LEFT JOIN money_transactions t ON t.id = x.money_transaction_id
         WHERE x.casino_id = $1 AND x.created_at > $2 AND c.context IN ('VAULT_OPEN', 'VAULT_CLOSE')
           AND COALESCE(t.amount_cents, 0) <> x.difference_cents ORDER BY x.count_id`, 'count'),
    },
  ];
}

/**
 * HANDPAY (Step 7b): payable = open handpays; every payment and every creation since the cutover
 * booked exactly once with the handpay amount; a void reverses its creation.
 */
async function handpayChecks(db: Db, casinoId: string, since: string) {
  const p = [casinoId, since];
  const ids = async (sql: string, prefix: string, params: unknown[] = p) => (await rows(db, sql, params)).map((r) => `${prefix}:${r.id}`);
  return [
    {
      key: 'handpay.payable_matches_open_handpays',
      items: await ids(
        `SELECT c.id FROM casinos c WHERE c.id = $1
           AND COALESCE((SELECT sum(amount_cents) FROM handpays WHERE casino_id = c.id AND status IN ('PENDING', 'APPROVED')), 0)
           <> COALESCE((SELECT -b.balance_cents FROM ledger_accounts a JOIN ledger_balances b ON b.account_id = a.id WHERE a.casino_id = c.id AND a.kind = 'HANDPAY_PAYABLE'), 0)`,
        'handpay_payable', [casinoId]),
    },
    {
      key: 'handpay.payments_booked_once',
      items: await ids(
        `SELECT h.id FROM handpays h WHERE h.casino_id = $1 AND h.paid_at > $2 AND h.status IN ('PAID', 'MACHINE_RESET')
           AND (SELECT count(*) FROM money_transactions t WHERE t.handpay_id = h.id AND t.type = 'HANDPAY_PAY' AND t.amount_cents = h.amount_cents) <> 1
         ORDER BY h.id`, 'handpay'),
    },
    {
      key: 'handpay.bookings_match_state',
      items: await ids(
        `SELECT t.id FROM money_transactions t JOIN handpays h ON h.id = t.handpay_id WHERE t.casino_id = $1 AND t.created_at > $2
           AND ((t.type = 'HANDPAY_PAY' AND (h.status NOT IN ('PAID', 'MACHINE_RESET') OR t.amount_cents <> h.amount_cents))
             OR (t.type = 'HANDPAY_CREATE_JACKPOT' AND t.amount_cents <> h.amount_cents))
         ORDER BY t.created_at, t.id`, 'money_tx'),
    },
    {
      // durability: every jackpot received since the cutover has a handpay or a deferred record
      key: 'handpay.jackpots_accounted',
      items: await ids(
        `SELECT e.event_id AS id FROM machine_events e WHERE e.casino_id = $1 AND e.received_at > $2 AND e.type = 'JACKPOT' AND e.amount > 0
           AND NOT EXISTS (SELECT 1 FROM handpays h WHERE h.source_event_id = e.event_id)
           AND NOT EXISTS (SELECT 1 FROM deferred_money_events d WHERE d.event_id = e.event_id)
         ORDER BY e.event_id`, 'jackpot_event'),
    },
    {
      // a deferred jackpot must not stay pending once its rail is no longer frozen
      key: 'handpay.no_stale_deferred_events',
      items: await ids(
        `SELECT d.event_id AS id FROM deferred_money_events d WHERE d.casino_id = $1 AND d.status = 'PENDING'
           AND NOT money_rail_frozen(d.org_id, d.casino_id, 'HANDPAY', NULL) ORDER BY d.event_id`, 'deferred_event', [casinoId]),
    },
    {
      // a replayed jackpot is booked on the business date of its occurred_at, never moved to the replay day
      key: 'handpay.deferred_business_date',
      items: await ids(
        `SELECT d.event_id AS id FROM deferred_money_events d WHERE d.casino_id = $1 AND d.status = 'PROCESSED'
           AND NOT EXISTS (SELECT 1 FROM money_transactions t WHERE t.source_event_id = d.event_id AND t.type = 'HANDPAY_CREATE_JACKPOT'
                             AND t.handpay_id = d.handpay_id AND t.business_date = d.business_date AND t.amount_cents = d.amount_cents)
         ORDER BY d.event_id`, 'deferred_event', [casinoId]),
    },
    {
      key: 'handpay.creations_booked',
      items: await ids(
        `SELECT h.id FROM handpays h WHERE h.casino_id = $1 AND h.created_at > $2
           AND NOT EXISTS (SELECT 1 FROM money_transactions t WHERE t.handpay_id = h.id AND t.type = 'HANDPAY_CREATE_JACKPOT')
            OR (h.casino_id = $1 AND h.created_at > $2 AND h.status = 'VOIDED' AND NOT EXISTS (
                 SELECT 1 FROM money_transactions r JOIN money_transactions c ON c.id = r.reversal_of WHERE c.handpay_id = h.id AND c.type = 'HANDPAY_CREATE_JACKPOT'))
         ORDER BY h.id`, 'handpay'),
    },
  ];
}

async function freeze(db: Db, orgId: string, casinoId: string | null, rail: FreezeRail, reason: string, runId: string) {
  const r = await rows(db,
    `INSERT INTO money_rail_freezes (org_id, rail, casino_id, reason, reconciliation_run_id)
     SELECT $1, $2, $3, $4, $5 WHERE NOT EXISTS (
       SELECT 1 FROM money_rail_freezes WHERE org_id = $1 AND rail = $2 AND casino_id IS NOT DISTINCT FROM $3 AND machine_id IS NULL AND lifted_at IS NULL)
     RETURNING id`,
    [orgId, rail, casinoId, reason, runId]);
  return r[0]?.id as string | undefined;
}

/**
 * Runs the CASH / VAULT checks of a casino (only for rails on the ledger) plus the global ledger
 * invariants. Mismatches freeze the affected rail and raise an alert, in the same transaction.
 */
export async function runReconciliation(
  db: Db,
  input: { orgId: string; casinoId: string | null; trigger: 'SCHEDULE' | 'MANUAL' | 'DAY_CLOSE' | 'LIFT'; employeeId?: string | null },
  out: BusMessage[] = [],
): Promise<ReconResult> {
  const { orgId, casinoId } = input;
  const raw: Array<{ key: string; rail: ReconCheck['rail']; items: string[] }> = [];
  if (casinoId) {
    const cashSince = await cutoverTime(db, orgId, casinoId, 'CASH');
    if (cashSince) for (const c of await cashChecks(db, casinoId, cashSince)) raw.push({ ...c, rail: 'CASH' });
    const vaultSince = await cutoverTime(db, orgId, casinoId, 'VAULT');
    if (vaultSince) for (const c of await vaultChecks(db, casinoId, vaultSince)) raw.push({ ...c, rail: 'VAULT' });
    const handpaySince = await cutoverTime(db, orgId, casinoId, 'HANDPAY');
    if (handpaySince) for (const c of await handpayChecks(db, casinoId, handpaySince)) raw.push({ ...c, rail: 'HANDPAY' });
  }
  const inv = await checkLedgerInvariants(db, orgId);
  raw.push({ key: 'global.ledger_invariants', rail: 'GLOBAL', items: inv.ok ? [] : [`ledger:${orgId}`] });

  const keys = raw.flatMap((c) => c.items);
  const resolved = new Set(keys.length ? (await rows(db, 'SELECT item_key FROM reconciliation_resolutions WHERE org_id = $1 AND item_key = ANY($2)', [orgId, keys])).map((r) => r.item_key) : []);
  const checks: ReconCheck[] = raw.map((c) => {
    const open = c.items.filter((i) => !resolved.has(i));
    return { key: c.key, rail: c.rail, ok: open.length === 0, items: open, resolved: c.items.filter((i) => resolved.has(i)) };
  });
  const ok = checks.every((c) => c.ok);
  const run = (await rows(db,
    'INSERT INTO reconciliation_runs (org_id, casino_id, trigger, ok, checks, employee_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [orgId, casinoId, input.trigger, ok, JSON.stringify(checks), input.employeeId ?? null]))[0];

  const frozen: ReconResult['frozen'] = [];
  for (const rail of ['CASH', 'VAULT', 'HANDPAY', 'GLOBAL'] as const) {
    const failed = checks.filter((c) => c.rail === rail && !c.ok);
    if (!failed.length) continue;
    const reason = failed.map((c) => `${c.key} (${c.items.length})`).join(', ');
    const id = await freeze(db, orgId, rail === 'GLOBAL' ? null : casinoId, rail, reason, run.id);
    if (id) frozen.push({ id, rail });
    const alertCasino = casinoId ?? (await rows(db, 'SELECT id FROM casinos WHERE org_id = $1 ORDER BY created_at, id LIMIT 1', [orgId]))[0]?.id;
    if (alertCasino)
      await openAlert(db as PoolClient, {
        orgId, casinoId: alertCasino, type: `RECONCILIATION_${rail}`, severity: 'CRITICAL',
        message: `${rail === 'GLOBAL' ? 'Ledger invariants violated: all money frozen' : `${rail} reconciliation mismatch: ${rail} frozen`} (${reason})`,
      }, out);
  }
  await writeAudit(db as PoolClient, {
    orgId, casinoId, actorType: input.employeeId ? 'EMPLOYEE' : 'SYSTEM', actorId: input.employeeId ?? null, actorName: input.employeeId ? null : 'reconciliation',
    action: 'money.reconciliation', entityType: 'reconciliation_run', entityId: run.id,
    details: { ok, failed: checks.filter((c) => !c.ok).map((c) => c.key), frozen: frozen.map((f) => f.rail) },
  });
  return { runId: run.id, ok, checks, frozen };
}

/** Lifts a freeze after a clean run of its rail (and of the global invariants). */
export async function liftFreeze(db: Db, a: CashActor, freezeId: string, reason: string, out: BusMessage[] = []) {
  if (!reason || reason.trim().length < 5) throw new HttpError(400, 'A reason is required');
  const f = (await rows(db, 'SELECT * FROM money_rail_freezes WHERE id = $1 AND org_id = $2 FOR UPDATE', [freezeId, a.orgId]))[0];
  if (!f || (f.casino_id && !a.casinoIds.includes(f.casino_id))) throw new HttpError(404, 'Freeze not found');
  if (f.lifted_at) throw new HttpError(409, 'Freeze already lifted');
  const result = await runReconciliation(db, { orgId: a.orgId, casinoId: f.casino_id, trigger: 'LIFT', employeeId: a.employeeId }, out);
  const blocking = result.checks.filter((c) => !c.ok && (c.rail === f.rail || c.rail === 'GLOBAL'));
  if (blocking.length) return { lifted: false as const, result };
  await rows(db, 'UPDATE money_rail_freezes SET lifted_at = now(), lifted_by = $2, lift_reason = $3, lift_run_id = $4 WHERE id = $1', [freezeId, a.employeeId, reason, result.runId]);
  // Money events deferred while frozen continue now, in the same transaction (before any day close).
  const replayed = f.rail === 'HANDPAY' || f.rail === 'GLOBAL' ? await replayDeferredHandpays(db, { orgId: a.orgId, casinoId: f.casino_id ?? undefined }) : [];
  await writeAudit(db as PoolClient, { orgId: a.orgId, casinoId: f.casino_id, actorType: 'EMPLOYEE', actorId: a.employeeId, actorName: a.employeeEmail ?? null, ip: a.ip ?? null, action: 'money.freeze_lifted', entityType: 'money_rail_freeze', entityId: freezeId, details: { rail: f.rail, reason, runId: result.runId } });
  return { lifted: true as const, result, replayed };
}

/** Step 1 of a four-eyes explanation of one reconciliation item. */
export async function requestResolution(db: Db, a: CashActor, input: { casinoId: string; itemKey: string; explanation: string }) {
  if (!a.casinoIds.includes(input.casinoId)) throw new HttpError(404, 'Casino not found');
  if (!input.explanation || input.explanation.trim().length < 10) throw new HttpError(400, 'An explanation of at least 10 characters is required');
  if ((await rows(db, 'SELECT 1 FROM reconciliation_resolutions WHERE org_id = $1 AND item_key = $2', [a.orgId, input.itemKey])).length) throw new HttpError(409, 'Item already resolved');
  return requestApproval(db, a, { casinoId: input.casinoId, action: 'RECONCILIATION_RESOLUTION', entityType: 'reconciliation_item', entityId: input.itemKey, payload: { explanation: input.explanation } });
}

/** Step 2: a different employee approves; the item counts as explained from then on. */
export async function decideResolution(db: Db, a: CashActor, approvalId: string, decision: 'APPROVED' | 'REJECTED', note?: string) {
  const ap = await decideApproval(db, a, approvalId, decision, note);
  if (ap.action !== 'RECONCILIATION_RESOLUTION') throw new HttpError(409, 'Not a reconciliation resolution');
  if (decision === 'REJECTED') return { approval: ap, resolution: null };
  const resolution = (await rows(db,
    `INSERT INTO reconciliation_resolutions (org_id, casino_id, item_key, explanation, requested_by, approved_by, approval_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [a.orgId, ap.casino_id, ap.entity_id, ap.payload.explanation, ap.requested_by, a.employeeId, ap.id]))[0];
  await consumeApproval(db, a, ap.id, { action: 'RECONCILIATION_RESOLUTION', entityId: ap.entity_id });
  return { approval: ap, resolution };
}

/**
 * Closes a past business date of a casino: nothing frozen, a clean reconciliation run, and the date
 * must be over. Afterwards the date takes no money transaction (database guard).
 */
export async function closeBusinessDay(db: Db, a: CashActor, input: { casinoId: string; businessDate: string }, out: BusMessage[] = []) {
  if (!a.casinoIds.includes(input.casinoId)) throw new HttpError(404, 'Casino not found');
  const today = (await rows(db, `SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM casinos WHERE id = $1`, [input.casinoId]))[0].d;
  if (input.businessDate >= today) throw new HttpError(409, 'Only a past business date can be closed');
  if ((await rows(db, 'SELECT 1 FROM business_day_closes WHERE casino_id = $1 AND business_date = $2', [input.casinoId, input.businessDate])).length)
    throw new HttpError(409, 'Business date already closed');
  const frozen = await rows(db,
    `SELECT id, rail FROM money_rail_freezes WHERE org_id = $1 AND lifted_at IS NULL AND (casino_id = $2 OR casino_id IS NULL)`, [a.orgId, input.casinoId]);
  if (frozen.length) return { closed: false as const, reason: `Frozen: ${frozen.map((f) => f.rail).join(', ')}`, result: null };
  // A pending deferred event blocks the close unless it was explicitly explained (four eyes), e.g. one
  // whose original business date is already closed and that goes through the late-event process.
  const deferred = await rows(db,
    `SELECT count(*)::int n FROM deferred_money_events d WHERE d.casino_id = $1 AND d.status = 'PENDING'
       AND NOT EXISTS (SELECT 1 FROM reconciliation_resolutions r WHERE r.org_id = d.org_id AND r.item_key = 'deferred_event:' || d.event_id)`, [input.casinoId]);
  if (deferred[0].n) return { closed: false as const, reason: `${deferred[0].n} deferred money event(s) not processed yet`, result: null };
  const result = await runReconciliation(db, { orgId: a.orgId, casinoId: input.casinoId, trigger: 'DAY_CLOSE', employeeId: a.employeeId }, out);
  if (!result.ok) return { closed: false as const, reason: 'Reconciliation mismatch', result };
  await rows(db, 'INSERT INTO business_day_closes (casino_id, business_date, org_id, closed_by, reconciliation_run_id) VALUES ($1,$2,$3,$4,$5)',
    [input.casinoId, input.businessDate, a.orgId, a.employeeId, result.runId]);
  await writeAudit(db as PoolClient, { orgId: a.orgId, casinoId: input.casinoId, actorType: 'EMPLOYEE', actorId: a.employeeId, actorName: a.employeeEmail ?? null, ip: a.ip ?? null, action: 'money.day_closed', entityType: 'casino', entityId: input.casinoId, details: { businessDate: input.businessDate, runId: result.runId } });
  return { closed: true as const, reason: null, result };
}

/** Scheduled: every casino with CASH or VAULT on the ledger, each in its own transaction. */
export async function reconcileLedgerCasinos(pool: Pool, publish: (m: BusMessage) => void = () => {}) {
  const casinos = (await pool.query(`SELECT DISTINCT org_id, casino_id FROM money_rail_cutovers WHERE rail IN ('CASH', 'VAULT', 'HANDPAY')`)).rows;
  const results = [];
  for (const c of casinos) {
    const out: BusMessage[] = [];
    results.push(await withTransaction(pool, (db) => runReconciliation(db, { orgId: c.org_id, casinoId: c.casino_id, trigger: 'SCHEDULE' }, out)));
    out.forEach(publish);
  }
  return results;
}
