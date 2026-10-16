import { writeAudit, type PoolClient } from '@m1/database';
import { cents, type CashMovementKind } from '@m1/shared';
import { HttpError } from '../auth';
import { consumeApproval, decideApproval, requestApproval } from './approvals';
import { type SessionRow } from './cashier';
import { entityDedupeKey, executeMoneyTransaction, getBalance, type MoneyActor } from './ledger';
import { projectDrawerMovement, projectShiftClosed, projectShiftCounted, projectShiftCounting } from './legacy-projection';
import { railOnLedger } from './rails';
import { countTotal, recordCashCount, type CountInput } from './vault';

/**
 * Ledger-backed vault and cash drawer operations (Step 7a). Only for casinos whose VAULT and CASH
 * rails are on the ledger; legacy casinos keep the legacy cashier flows unchanged.
 *
 *   Vault  -> Drawer   FILL:  requested by the vault, confirmed by the cashier with a count
 *   Drawer -> Vault    DROP:  requested by the cashier, confirmed by the vault with a count
 *   Shift open         float 0, cash arrives only as a confirmed fill
 *   Shift close        blind count -> short / over (approval above the limit) -> final drop -> closed
 *   Vault open / close blind count + blind second count by another employee -> difference booked
 *
 * Money moves exactly once, when the receiving side confirms (REQUESTED moves nothing). Every
 * money transaction carries the actor, the approver / confirmer, the casino and its business date,
 * is idempotent (entity dedupe key) and is projected into the legacy tables in the same transaction.
 * Lock order: movement / count row -> cashier session -> (ledger) org audit lock -> balances.
 */

type Db = Pick<PoolClient, 'query'>;
export interface CashActor {
  orgId: string;
  employeeId: string;
  employeeEmail?: string | null;
  ip?: string | null;
  casinoIds: string[];
}

const moneyActor = (employeeId: string, name?: string | null): MoneyActor => ({ type: 'EMPLOYEE', employeeId, name: name ?? null });

async function one<T = Record<string, any>>(db: Db, sql: string, params: unknown[]): Promise<T> {
  return (await db.query(sql, params)).rows[0];
}

async function audit(db: Db, a: CashActor, casinoId: string, action: string, entityType: string, entityId: string, details: Record<string, unknown>) {
  await writeAudit(db as PoolClient, { orgId: a.orgId, casinoId, actorType: 'EMPLOYEE', actorId: a.employeeId, actorName: a.employeeEmail ?? null, ip: a.ip ?? null, action, entityType, entityId, details });
}

/** VAULT and CASH must both be on the ledger for ledger cash operations. */
export async function cashOnLedger(db: Db, orgId: string, casinoId: string) {
  return (await railOnLedger(db, orgId, 'CASH', casinoId)) && (await railOnLedger(db, orgId, 'VAULT', casinoId));
}

async function requireCashOnLedger(db: Db, orgId: string, casinoId: string) {
  if (!(await cashOnLedger(db, orgId, casinoId))) throw new HttpError(409, 'Cash and vault of this casino are not on the ledger yet');
}

const drawerBalance = (db: Db, orgId: string, casinoId: string, sessionId: string) => getBalance(db, orgId, { kind: 'DRAWER', casinoId, cashierSessionId: sessionId });
const vaultBalance = (db: Db, orgId: string, casinoId: string, vaultId: string) => getBalance(db, orgId, { kind: 'VAULT', casinoId, vaultId });

async function lockSession(db: Db, orgId: string, sessionId: string): Promise<SessionRow & { status: string }> {
  const s = await one<SessionRow & { status: string }>(db, 'SELECT * FROM cashier_sessions WHERE id = $1 AND org_id = $2 FOR UPDATE', [sessionId, orgId]);
  if (!s) throw new HttpError(404, 'Cashier session not found');
  return s;
}

// ---- vault sessions and counts ---------------------------------------------------------------

/** The vault's current session, usable for money only after its opening count was verified. */
export async function readyVaultSession(db: Db, vaultId: string) {
  const s = await one(db,
    `SELECT s.*, EXISTS (SELECT 1 FROM cash_counts c JOIN count_settlements cs ON cs.count_id = c.id
                         WHERE c.vault_session_id = s.id AND c.context = 'VAULT_OPEN') AS verified
     FROM vault_sessions s WHERE s.vault_id = $1 AND s.status IN ('OPEN', 'COUNTING')`, [vaultId]);
  if (!s) throw new HttpError(409, 'The vault is not open');
  if (!s.verified) throw new HttpError(409, 'The vault opening count is not verified yet');
  if (s.status !== 'OPEN') throw new HttpError(409, 'The vault is being counted');
  return s;
}

export async function mainVaultOf(db: Db, casinoId: string): Promise<string> {
  const v = await one(db, 'SELECT id FROM vaults WHERE casino_id = $1 AND active ORDER BY created_at, id LIMIT 1', [casinoId]);
  if (!v) throw new HttpError(409, 'Casino has no vault');
  return v.id;
}

/** A new blind count of the vault session (after a mismatching verification). */
export async function recountVault(db: Db, a: CashActor, sessionId: string, count: CountInput) {
  const s = await one(db, 'SELECT * FROM vault_sessions WHERE id = $1 AND org_id = $2 FOR UPDATE', [sessionId, a.orgId]);
  if (!s || !a.casinoIds.includes(s.casino_id)) throw new HttpError(404, 'Vault session not found');
  const context = s.status === 'OPEN' ? 'VAULT_OPEN' : s.status === 'COUNTING' ? 'VAULT_CLOSE' : null;
  if (!context) throw new HttpError(409, 'Vault session is closed');
  if (context === 'VAULT_OPEN' && (await one(db, `SELECT 1 FROM cash_counts c JOIN count_settlements x ON x.count_id = c.id WHERE c.vault_session_id = $1 AND c.context = 'VAULT_OPEN'`, [sessionId])))
    throw new HttpError(409, 'The opening count is already settled');
  return recordCashCount(db, a, { ...count, blind: true, casinoId: s.casino_id, context, vaultSessionId: sessionId });
}

/**
 * Blind second count of a vault open / close count by a different employee. A match settles the
 * count against the ledger: any difference is booked as VAULT_COUNT_DIFFERENCE (counter = actor,
 * verifier = approver). A closing count then closes the vault session. A mismatch books nothing.
 */
export async function verifyVaultCount(db: Db, a: CashActor, countId: string, input: CountInput) {
  const c = await one(db, 'SELECT * FROM cash_counts WHERE id = $1 AND org_id = $2 FOR UPDATE', [countId, a.orgId]);
  if (!c || !a.casinoIds.includes(c.casino_id)) throw new HttpError(404, 'Count not found');
  if (c.context !== 'VAULT_OPEN' && c.context !== 'VAULT_CLOSE') throw new HttpError(409, 'Not a vault session count');
  await requireCashOnLedger(db, a.orgId, c.casino_id);
  if (await one(db, 'SELECT 1 FROM count_settlements WHERE count_id = $1', [countId])) throw new HttpError(409, 'Count already settled');
  const latest = await one(db, `SELECT id FROM cash_counts WHERE vault_session_id = $1 AND context = $2 ORDER BY created_at DESC, id DESC LIMIT 1`, [c.vault_session_id, c.context]);
  if (latest.id !== countId) throw new HttpError(409, 'A newer count exists for this vault session');
  const s = await one(db, 'SELECT * FROM vault_sessions WHERE id = $1 FOR UPDATE', [c.vault_session_id]);
  if ((c.context === 'VAULT_OPEN' && s.status !== 'OPEN') || (c.context === 'VAULT_CLOSE' && s.status !== 'COUNTING')) throw new HttpError(409, 'Vault session is not in the state of this count');

  const total = countTotal(input);
  let v;
  try {
    v = (await db.query('INSERT INTO cash_count_verifications (org_id, count_id, total_cents, matches, verified_by, note) VALUES ($1,$2,$3,false,$4,$5) RETURNING *',
      [a.orgId, countId, total, a.employeeId, input.note ?? null])).rows[0];
  } catch (err) {
    if (/different employee/.test((err as Error).message)) throw new HttpError(409, 'The second count must be done by a different employee');
    throw err;
  }
  if (!v.matches) {
    await audit(db, a, c.casino_id, 'vault.count_mismatch', 'cash_count', countId, { counted: c.total_cents, verified: total });
    return { matches: false as const, settlement: null, session: s };
  }

  const ledger = await vaultBalance(db, a.orgId, c.casino_id, s.vault_id);
  const difference = c.total_cents - ledger;
  let txId: string | null = null;
  if (difference !== 0) {
    const r = await executeMoneyTransaction(db, {
      orgId: a.orgId, type: 'VAULT_COUNT_DIFFERENCE', dedupeKey: entityDedupeKey('count', countId, 'difference'),
      actor: moneyActor(c.counted_by), approvedBy: a.employeeId, reason: `Vault ${c.context === 'VAULT_OPEN' ? 'opening' : 'closing'} count difference`,
      ctx: { casinoId: c.casino_id, amountCents: cents(difference), vaultId: s.vault_id },
    });
    txId = r.transaction.id;
  }
  const settlement = (await db.query(
    `INSERT INTO count_settlements (count_id, org_id, casino_id, ledger_cents, counted_cents, difference_cents, money_transaction_id, settled_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [countId, a.orgId, c.casino_id, ledger, c.total_cents, difference, txId, a.employeeId],
  )).rows[0];
  let session = s;
  if (c.context === 'VAULT_CLOSE')
    session = (await db.query(`UPDATE vault_sessions SET status = 'CLOSED', closed_by = $2, closed_at = now() WHERE id = $1 RETURNING *`, [s.id, c.counted_by])).rows[0];
  await audit(db, a, c.casino_id, 'vault.count_settled', 'cash_count', countId, { context: c.context, ledger, counted: c.total_cents, difference, transactionId: txId });
  return { matches: true as const, settlement, session };
}

// ---- vault <-> drawer movements ------------------------------------------------------------

export interface MovementRow {
  id: string;
  casino_id: string;
  kind: CashMovementKind;
  status: string;
  amount_cents: number;
  purpose: 'SHIFT' | 'CLOSE';
  cashier_session_id: string;
  vault_id: string;
  vault_session_id: string;
  requested_by: string;
  decided_by: string | null;
  money_transaction_id: string | null;
  expires_at: string;
  [k: string]: unknown;
}

/**
 * Requests a fill (by the vault, for a cashier's open shift) or a drop (by the cashier, from the own
 * shift). Nothing moves yet. Idempotent per requestKey.
 */
export async function requestMovement(
  db: Db,
  a: CashActor,
  input: { kind: CashMovementKind; cashierSessionId: string; amountCents: number; requestKey: string; note?: string; purpose?: 'SHIFT' | 'CLOSE' },
): Promise<{ movement: MovementRow; replayed: boolean }> {
  if (!input.requestKey || input.requestKey.length > 200) throw new HttpError(400, 'requestKey required');
  const amount = cents(input.amountCents);
  if (amount <= 0) throw new HttpError(400, 'Amount must be positive');
  const prev = await one<MovementRow>(db, 'SELECT * FROM cash_movements WHERE org_id = $1 AND request_key = $2', [a.orgId, input.requestKey]);
  if (prev) {
    if (prev.kind === input.kind && prev.cashier_session_id === input.cashierSessionId && prev.amount_cents === amount) return { movement: prev, replayed: true };
    throw new HttpError(409, 'This request key was already used for a different movement');
  }
  const session = await lockSession(db, a.orgId, input.cashierSessionId);
  if (!a.casinoIds.includes(session.casino_id)) throw new HttpError(404, 'Cashier session not found');
  await requireCashOnLedger(db, a.orgId, session.casino_id);
  const purpose = input.purpose ?? 'SHIFT';
  if (purpose === 'SHIFT' && session.status !== 'OPEN') throw new HttpError(409, 'The shift is not open');
  if (input.kind === 'DROP' && session.employee_id !== a.employeeId) throw new HttpError(403, 'Only the cashier of the shift can hand in a drop');
  if (input.kind === 'FILL' && session.employee_id === a.employeeId) throw new HttpError(409, 'A fill is issued by the vault, not by the receiving cashier');
  if (input.kind === 'DROP' && amount > (await drawerBalance(db, a.orgId, session.casino_id, session.id))) throw new HttpError(409, 'Drop exceeds the drawer balance');
  const vaultId = await mainVaultOf(db, session.casino_id);
  const vs = await readyVaultSession(db, vaultId);
  const m = (await db.query(
    `INSERT INTO cash_movements (org_id, casino_id, kind, vault_id, vault_session_id, cashier_session_id, amount_cents, purpose, request_key, requested_by, note, expires_at)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + make_interval(secs => COALESCE((SELECT cash_movement_timeout_seconds FROM casino_money_settings WHERE casino_id = $2), 900))
     RETURNING *`,
    [a.orgId, session.casino_id, input.kind, vaultId, vs.id, session.id, amount, purpose, input.requestKey, a.employeeId, input.note ?? null],
  )).rows[0];
  await audit(db, a, session.casino_id, 'cash.movement_requested', 'cash_movement', m.id, { kind: input.kind, purpose, amountCents: amount, cashierSessionId: session.id });
  return { movement: m, replayed: false };
}

/**
 * Confirmation by the receiving side with its own count. Count = amount: exactly one ledger
 * transaction (VAULT_FILL / VAULT_DROP, requester = actor, confirmer = approver) plus its legacy
 * projection. Count differs: REJECTED, nothing moves. Expired: EXPIRED, nothing moves.
 */
export async function confirmMovement(db: Db, a: CashActor, movementId: string, count: CountInput) {
  const m = await one<MovementRow>(db, 'SELECT * FROM cash_movements WHERE id = $1 AND org_id = $2 FOR UPDATE', [movementId, a.orgId]);
  if (!m || !a.casinoIds.includes(m.casino_id)) throw new HttpError(404, 'Movement not found');
  if (m.status === 'CONFIRMED' && m.decided_by === a.employeeId) return { movement: m, replayed: true };
  if (m.status !== 'REQUESTED') throw new HttpError(409, `Movement is ${m.status}`);
  if (m.requested_by === a.employeeId) throw new HttpError(409, 'The requester cannot confirm the own movement');
  if ((m.kind as string) === 'HOPPER_FILL') throw new HttpError(409, 'A hopper fill is confirmed at the machine (/api/v1/machines/hopper-fills/:id/confirm)');
  const session = await lockSession(db, a.orgId, m.cashier_session_id);
  if (m.kind === 'FILL' && session.employee_id !== a.employeeId) throw new HttpError(403, 'Only the receiving cashier can confirm a fill');
  if (m.kind === 'DROP' && session.employee_id === a.employeeId) throw new HttpError(409, 'A drop is confirmed by the vault');
  if (new Date(m.expires_at) <= new Date()) {
    const expired = (await db.query(`UPDATE cash_movements SET status = 'EXPIRED' WHERE id = $1 RETURNING *`, [m.id])).rows[0];
    return { movement: expired as MovementRow, replayed: false };
  }
  await requireCashOnLedger(db, a.orgId, m.casino_id);
  const counted = countTotal(count);
  if (counted !== m.amount_cents) {
    const rejected = (await db.query(
      `UPDATE cash_movements SET status = 'REJECTED', decided_by = $2, decided_at = now(), confirmed_count_cents = $3, note = COALESCE(note || ' / ', '') || 'count mismatch' WHERE id = $1 RETURNING *`,
      [m.id, a.employeeId, counted],
    )).rows[0];
    await audit(db, a, m.casino_id, 'cash.movement_count_mismatch', 'cash_movement', m.id, { amountCents: m.amount_cents, countedCents: counted });
    return { movement: rejected as MovementRow, replayed: false };
  }
  const vs = await one(db, 'SELECT status FROM vault_sessions WHERE id = $1', [m.vault_session_id]);
  if (vs.status !== 'OPEN') throw new HttpError(409, 'The vault session is not open');
  if (m.purpose === 'SHIFT' && session.status !== 'OPEN') throw new HttpError(409, 'The shift is not open');

  const r = await executeMoneyTransaction(db, {
    orgId: a.orgId, type: m.kind === 'FILL' ? 'VAULT_FILL' : 'VAULT_DROP', dedupeKey: entityDedupeKey('cash_movement', m.id),
    actor: moneyActor(m.requested_by), approvedBy: a.employeeId, reason: m.purpose === 'CLOSE' ? 'Final drop of the shift' : null,
    ctx: { casinoId: m.casino_id, amountCents: cents(m.amount_cents), cashierSessionId: m.cashier_session_id, vaultId: m.vault_id },
  });
  await projectDrawerMovement(db, session, m.kind, m.amount_cents, r.transaction.id, `${m.kind === 'FILL' ? 'Vault fill' : 'Drop to vault'} ${m.id}`);
  const confirmed = (await db.query(
    `UPDATE cash_movements SET status = 'CONFIRMED', decided_by = $2, decided_at = now(), confirmed_count_cents = $3, money_transaction_id = $4 WHERE id = $1 RETURNING *`,
    [m.id, a.employeeId, counted, r.transaction.id],
  )).rows[0] as MovementRow;
  if (m.purpose === 'CLOSE') {
    const left = await drawerBalance(db, a.orgId, m.casino_id, session.id);
    if (left !== 0) throw new HttpError(409, 'Drawer is not empty after the final drop');
    await projectShiftClosed(db, session.id);
  }
  await audit(db, a, m.casino_id, 'cash.movement_confirmed', 'cash_movement', m.id, { kind: m.kind, amountCents: m.amount_cents, transactionId: r.transaction.id });
  return { movement: confirmed, replayed: false };
}

/** The requester withdraws a request that was not confirmed yet. */
export async function cancelMovement(db: Db, a: CashActor, movementId: string) {
  const m = await one<MovementRow>(db, 'SELECT * FROM cash_movements WHERE id = $1 AND org_id = $2 FOR UPDATE', [movementId, a.orgId]);
  if (!m || !a.casinoIds.includes(m.casino_id)) throw new HttpError(404, 'Movement not found');
  if (m.status === 'CANCELLED') return m;
  if (m.status !== 'REQUESTED') throw new HttpError(409, `Movement is ${m.status}`);
  if (m.requested_by !== a.employeeId) throw new HttpError(403, 'Only the requester can cancel');
  return (await db.query(`UPDATE cash_movements SET status = 'CANCELLED', decided_at = now() WHERE id = $1 RETURNING *`, [m.id])).rows[0];
}

/** Background job: requests not confirmed in time expire (no money moved). */
export async function expireMovements(db: Db) {
  return (await db.query(`UPDATE cash_movements SET status = 'EXPIRED' WHERE status = 'REQUESTED' AND expires_at <= now() RETURNING id`)).rowCount ?? 0;
}

// ---- shift close -------------------------------------------------------------------------------

async function shortOverNeedsApproval(db: Db, casinoId: string, difference: number) {
  const limit = (await one(db, 'SELECT short_over_approval_cents FROM casino_money_settings WHERE casino_id = $1', [casinoId]))?.short_over_approval_cents;
  return limit !== null && limit !== undefined && Math.abs(difference) >= limit;
}

/**
 * Books a close count: DRAWER_SHORT_OVER for the difference (cashier = actor, supervisor = approver
 * when required), the legacy projection of expected / counted / difference, and the final drop
 * request (or the close when nothing is left).
 */
async function settleDrawerCount(db: Db, a: CashActor, session: SessionRow & { status: string }, count: Record<string, any>, approval: { id: string; by: string } | null) {
  const ledger = await drawerBalance(db, a.orgId, session.casino_id, session.id);
  const difference = count.total_cents - ledger;
  let txId: string | null = null;
  if (difference !== 0) {
    const r = await executeMoneyTransaction(db, {
      orgId: a.orgId, type: 'DRAWER_SHORT_OVER', dedupeKey: entityDedupeKey('count', count.id, 'short_over'),
      actor: moneyActor(count.counted_by), approvedBy: approval?.by ?? null, reason: difference > 0 ? 'Drawer over' : 'Drawer short',
      ctx: { casinoId: session.casino_id, amountCents: cents(difference), cashierSessionId: session.id },
    });
    txId = r.transaction.id;
  }
  await db.query(
    `INSERT INTO count_settlements (count_id, org_id, casino_id, ledger_cents, counted_cents, difference_cents, approval_id, money_transaction_id, settled_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [count.id, a.orgId, session.casino_id, ledger, count.total_cents, difference, approval?.id ?? null, txId, a.employeeId],
  );
  if (approval) await consumeApproval(db, a, approval.id, { action: 'DRAWER_SHORT_OVER', entityId: count.id, moneyTransactionId: txId });

  // Projection: expected = drawer before the first short / over of this close, difference cumulative.
  const all = await one(db,
    `SELECT (SELECT x.ledger_cents FROM count_settlements x JOIN cash_counts c ON c.id = x.count_id WHERE c.cashier_session_id = $1 AND c.context = 'DRAWER_CLOSE' ORDER BY x.created_at, c.created_at LIMIT 1) AS expected,
       (SELECT COALESCE(sum(x.difference_cents), 0)::bigint FROM count_settlements x JOIN cash_counts c ON c.id = x.count_id WHERE c.cashier_session_id = $1 AND c.context = 'DRAWER_CLOSE') AS difference`,
    [session.id]);
  await projectShiftCounted(db, session.id, { expectedCents: all.expected, countedCents: count.total_cents, differenceCents: all.difference });

  if (count.total_cents === 0) {
    await projectShiftClosed(db, session.id);
    return { status: 'CLOSED' as const, difference, movement: null };
  }
  const { movement } = await requestMovement(db, { ...a, employeeId: session.employee_id }, {
    kind: 'DROP', purpose: 'CLOSE', cashierSessionId: session.id, amountCents: count.total_cents, requestKey: `close:${count.id}`,
  });
  return { status: 'PENDING_DROP' as const, difference, movement };
}

/**
 * Shift close, step 1: the cashier's blind count of the drawer. The expected balance is never
 * shown to the cashier before the count. Above the short / over limit a supervisor must approve.
 */
export async function submitCloseCount(db: Db, a: CashActor, count: CountInput & { note?: string }) {
  const s = await one<SessionRow & { status: string }>(db,
    `SELECT * FROM cashier_sessions WHERE org_id = $1 AND employee_id = $2 AND status IN ('OPEN', 'COUNTING') FOR UPDATE`, [a.orgId, a.employeeId]);
  if (!s) throw new HttpError(409, 'Open a cashier session (shift) first');
  await requireCashOnLedger(db, a.orgId, s.casino_id);
  const pending = await one(db,
    `SELECT (SELECT count(*)::int FROM cash_movements WHERE cashier_session_id = $1 AND status = 'REQUESTED') AS movements,
       (SELECT count(*)::int FROM approvals ap JOIN cash_counts c ON ap.entity_id = c.id::text
          WHERE c.cashier_session_id = $1 AND ap.action = 'DRAWER_SHORT_OVER' AND ap.status IN ('PENDING', 'APPROVED')) AS approvals`, [s.id]);
  if (pending.movements) throw new HttpError(409, 'Pending fills / drops must be confirmed or cancelled before the close count');
  if (pending.approvals) throw new HttpError(409, 'The close count is waiting for supervisor approval');

  const c = await recordCashCount(db, a, { ...count, blind: true, casinoId: s.casino_id, context: 'DRAWER_CLOSE', cashierSessionId: s.id });
  await projectShiftCounting(db, s.id);
  const ledger = await drawerBalance(db, a.orgId, s.casino_id, s.id);
  const difference = c.total_cents - ledger;
  await audit(db, a, s.casino_id, 'cashier.close_count', 'cashier_session', s.id, { countId: c.id, countedCents: c.total_cents });
  if (difference !== 0 && (await shortOverNeedsApproval(db, s.casino_id, difference))) {
    const ap = await requestApproval(db, a, {
      casinoId: s.casino_id, action: 'DRAWER_SHORT_OVER', entityType: 'cash_count', entityId: c.id, amountCents: Math.abs(difference),
      payload: { cashierSessionId: s.id, countedCents: c.total_cents, ledgerCents: ledger, differenceCents: difference },
    });
    return { sessionId: s.id, countId: c.id, countedCents: c.total_cents, status: 'PENDING_APPROVAL' as const, approvalId: ap.id };
  }
  const r = await settleDrawerCount(db, a, s, c, null);
  return { sessionId: s.id, countId: c.id, countedCents: c.total_cents, status: r.status, movementId: r.movement?.id ?? null };
}

/** Shift close, step 2 (only above the limit): a supervisor approves or rejects the short / over. */
export async function decideShortOver(db: Db, a: CashActor, approvalId: string, decision: 'APPROVED' | 'REJECTED', note?: string) {
  const ap = await one(db, 'SELECT * FROM approvals WHERE id = $1 AND org_id = $2', [approvalId, a.orgId]);
  if (!ap || ap.action !== 'DRAWER_SHORT_OVER' || !a.casinoIds.includes(ap.casino_id)) throw new HttpError(404, 'Approval not found');
  const count = await one(db, 'SELECT * FROM cash_counts WHERE id = $1', [ap.entity_id]);
  const session = await lockSession(db, a.orgId, count.cashier_session_id);
  if (session.employee_id === a.employeeId) throw new HttpError(409, 'The cashier cannot approve the own short / over');
  const decided = await decideApproval(db, a, approvalId, decision, note);
  if (decision === 'REJECTED') return { status: 'RECOUNT' as const, approval: decided };
  // The drawer cannot have moved since the count (no fills / drops while COUNTING); settle it now.
  const r = await settleDrawerCount(db, a, session, count, { id: approvalId, by: a.employeeId });
  return { status: r.status, approval: decided, movementId: r.movement?.id ?? null };
}
