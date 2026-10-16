import { writeAudit, type PoolClient } from '@m1/database';
import { HANDPAY_TRANSITIONS, WALLET_STATUS_OPERATIONS, cents, playerCan, type HandpayStatus } from '@m1/shared';
import { HttpError } from '../auth';
import { consumeApproval, decideApproval, requestApproval } from './approvals';
import { addCashTx, requireOpenSession } from './cashier';
import { entityDedupeKey, eventDedupeKey, executeMoneyTransaction, reverseMoneyTransaction, type MoneyActor } from './ledger';
import { projectHandpayCash } from './legacy-projection';
import type { Actor } from './players';
import { railOnLedger } from './rails';

/**
 * Handpay entity: one per jackpot event (unique source_event_id).
 * PENDING -> APPROVED -> PAID -> MACHINE_RESET, or VOIDED before payment.
 *
 * Payment and machine reset are independent: a payment is final when it commits, the reset is
 * requested separately, retried on failure / timeout and confirmed later. A reset never books money.
 *
 * HANDPAY rail LEDGER (Step 7b): the jackpot creates the liability (HANDPAY_CREATE_JACKPOT), the
 * payment is HANDPAY_PAY (payable -> drawer or wallet), both in the same database transaction as the
 * handpay state change; a cash payment is projected into the legacy drawer rows by LegacyProjection.
 * HANDPAY rail LEGACY: the legacy cash flow (Step 1) unchanged. The two are never mixed.
 *
 * Exactly once: one handpay per jackpot event, one payment per handpay (ledger dedupe key and a
 * unique index), and the Step 1 index on the cash row (one cash payment per jackpot event).
 */

type Db = Pick<PoolClient, 'query'>;

export interface HandpayRow {
  id: string;
  org_id: string;
  casino_id: string;
  machine_id: string;
  source_event_id: string;
  amount_cents: number;
  status: HandpayStatus;
  approved_by: string | null;
  approval_id: string | null;
  paid_by: string | null;
  reset_confirmed_at: string | null;
}

export type HandpayPayTo = 'CASH' | 'WALLET';

async function event(db: Db, h: { id: string; org_id: string }, action: string, from: string | null, to: string | null, employeeId?: string | null, details: Record<string, unknown> = {}) {
  await db.query('INSERT INTO handpay_events (org_id, handpay_id, action, from_status, to_status, employee_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    h.org_id, h.id, action, from, to, employeeId ?? null, details,
  ]);
}

function audit(db: Db, a: Actor, action: string, h: HandpayRow, details: Record<string, unknown> = {}) {
  return writeAudit(db as PoolClient, {
    orgId: a.orgId, casinoId: h.casino_id, actorType: a.employeeId ? 'EMPLOYEE' : 'SYSTEM', actorId: a.employeeId ?? null, actorName: a.employeeEmail ?? 'system',
    action, entityType: 'handpay', entityId: h.id, details: { machineId: h.machine_id, amountCents: h.amount_cents, ...details },
  });
}

function assertTransition(h: HandpayRow, to: HandpayStatus) {
  if (h.status === to) throw new HttpError(409, `Handpay is already ${to}`);
  if (h.status === 'PAID' || h.status === 'MACHINE_RESET') throw new HttpError(409, 'Handpay already paid');
  if (!HANDPAY_TRANSITIONS.can(h.status, to)) throw new HttpError(409, `Handpay cannot change from ${h.status} to ${to}`);
}

const handpayOnLedger = (db: Db, h: { org_id: string; casino_id: string }) => railOnLedger(db, h.org_id, 'HANDPAY', h.casino_id);

/**
 * Creates the handpay for a jackpot event (idempotent: one handpay per event). On a ledger HANDPAY
 * rail the liability is booked in the same transaction (expense -> payable), keyed by the event.
 */
export async function ensureHandpayForJackpot(db: Db, input: { orgId: string; casinoId: string; machineId: string; eventId: string; amountCents: number; businessDate?: string | null }) {
  const r = await db.query(
    `INSERT INTO handpays (org_id, casino_id, machine_id, source_event_id, kind, amount_cents) VALUES ($1,$2,$3,$4,'JACKPOT',$5)
     ON CONFLICT ON CONSTRAINT handpays_one_per_event DO NOTHING RETURNING *`,
    [input.orgId, input.casinoId, input.machineId, input.eventId, input.amountCents],
  );
  const h = r.rows[0] as HandpayRow | undefined;
  if (!h) return undefined;
  await event(db, h, 'CREATED', null, 'PENDING');
  if (await handpayOnLedger(db, h)) {
    const tx = await executeMoneyTransaction(db, {
      orgId: input.orgId, type: 'HANDPAY_CREATE_JACKPOT', dedupeKey: eventDedupeKey(input.eventId, 'HANDPAY_CREATE_JACKPOT'), sourceEventId: input.eventId,
      actor: { type: 'GATEWAY', name: 'jackpot' }, businessDate: input.businessDate ?? null,
      ctx: { casinoId: input.casinoId, amountCents: cents(input.amountCents), machineId: input.machineId, handpayId: h.id },
    });
    await event(db, h, 'LIABILITY_BOOKED', null, null, null, { transactionId: tx.transaction.id });
  }
  return h;
}

/**
 * Entry point for a jackpot machine event (ingestion). The machine event itself is already stored.
 * HANDPAY rail on the ledger and frozen: the jackpot is recorded as a deferred money event (no handpay,
 * no booking); it is replayed after the freeze is lifted. Otherwise the handpay is created now.
 * The deferred record takes occurred_at / received_at / business_date from the machine event (009 trigger).
 */
export async function handleJackpotEvent(db: Db, input: { orgId: string; casinoId: string; machineId: string; eventId: string; amountCents: number }) {
  if (await handpayOnLedger(db, { org_id: input.orgId, casino_id: input.casinoId })) {
    const frozen = (await db.query(`SELECT money_rail_frozen($1, $2, 'HANDPAY', NULL) AS f`, [input.orgId, input.casinoId])).rows[0].f;
    if (frozen) {
      const r = await db.query(
        `INSERT INTO deferred_money_events (event_id, org_id, casino_id, machine_id, rail, kind, amount_cents, reason)
         VALUES ($1, $2, $3, $4, 'HANDPAY', 'JACKPOT', $5, 'FROZEN')
         ON CONFLICT (event_id) DO NOTHING RETURNING *`,
        [input.eventId, input.orgId, input.casinoId, input.machineId, input.amountCents],
      );
      const d = r.rows[0];
      if (d)
        await writeAudit(db as PoolClient, {
          orgId: input.orgId, casinoId: input.casinoId, actorType: 'SYSTEM', actorId: null, actorName: 'jackpot',
          action: 'handpay.deferred', entityType: 'machine_event', entityId: input.eventId,
          details: { machineId: input.machineId, amountCents: input.amountCents, reason: d.reason, occurredAt: d.occurred_at, receivedAt: d.received_at, businessDate: d.business_date },
        });
      return { deferred: r.rowCount === 1, handpay: undefined };
    }
  }
  return { deferred: false, handpay: await ensureHandpayForJackpot(db, input) };
}

/**
 * Replays deferred jackpot events whose HANDPAY rail is no longer frozen: creates the handpay and its
 * liability booking on the original business date of the event (never silently today). Idempotent and
 * concurrency-safe: the event id is the key (one handpay per event, one creation booking per handpay),
 * rows are locked. Each record runs in its own savepoint: a record that cannot be booked (e.g. its
 * business date is already closed) stays PENDING with last_error - the closed-date guard is never
 * bypassed - and reconciliation reports it (handpay.no_stale_deferred_events) for explicit handling.
 */
export async function replayDeferredHandpays(db: Db, filter: { orgId?: string; casinoId?: string } = {}) {
  const due = (await db.query(
    `SELECT d.*, d.business_date::text AS business_date FROM deferred_money_events d
     WHERE d.status = 'PENDING' AND d.rail = 'HANDPAY' AND ($1::uuid IS NULL OR d.org_id = $1) AND ($2::uuid IS NULL OR d.casino_id = $2)
       AND NOT money_rail_frozen(d.org_id, d.casino_id, 'HANDPAY', NULL)
       -- a record already refused for a closed date is not retried on every tick (reconciliation reports it)
       AND NOT (d.last_error IS NOT NULL AND EXISTS (SELECT 1 FROM business_day_closes b WHERE b.casino_id = d.casino_id AND b.business_date = d.business_date))
     ORDER BY d.occurred_at, d.event_id FOR UPDATE OF d SKIP LOCKED`,
    [filter.orgId ?? null, filter.casinoId ?? null],
  )).rows;
  const done = [];
  for (const d of due) {
    await db.query('SAVEPOINT deferred_replay');
    try {
      let h = await ensureHandpayForJackpot(db, { orgId: d.org_id, casinoId: d.casino_id, machineId: d.machine_id, eventId: d.event_id, amountCents: Number(d.amount_cents), businessDate: d.business_date });
      if (!h) h = (await db.query('SELECT * FROM handpays WHERE source_event_id = $1', [d.event_id])).rows[0];
      await db.query(`UPDATE deferred_money_events SET status = 'PROCESSED', replayed_at = now(), handpay_id = $2, attempts = attempts + 1, last_error = NULL WHERE event_id = $1`, [d.event_id, h!.id]);
      await event(db, h!, 'DEFERRED_REPLAYED', null, null, null, { businessDate: d.business_date, occurredAt: d.occurred_at, receivedAt: d.received_at, reason: d.reason });
      await writeAudit(db as PoolClient, {
        orgId: d.org_id, casinoId: d.casino_id, actorType: 'SYSTEM', actorId: null, actorName: 'jackpot',
        action: 'handpay.deferred_replayed', entityType: 'machine_event', entityId: d.event_id,
        details: { handpayId: h!.id, amountCents: Number(d.amount_cents), businessDate: d.business_date, occurredAt: d.occurred_at, attempts: d.attempts + 1 },
      });
      await db.query('RELEASE SAVEPOINT deferred_replay');
      done.push({ eventId: d.event_id as string, handpayId: h!.id });
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT deferred_replay');
      const message = err instanceof Error ? err.message : String(err);
      await db.query('UPDATE deferred_money_events SET attempts = attempts + 1, last_error = $2 WHERE event_id = $1', [d.event_id, message]);
      await writeAudit(db as PoolClient, {
        orgId: d.org_id, casinoId: d.casino_id, actorType: 'SYSTEM', actorId: null, actorName: 'jackpot',
        action: 'handpay.deferred_replay_failed', entityType: 'machine_event', entityId: d.event_id,
        details: { businessDate: d.business_date, error: message, attempts: d.attempts + 1 },
      });
    }
  }
  return done;
}

export async function lockHandpay(db: Db, orgId: string, handpayId: string): Promise<HandpayRow> {
  const r = await db.query('SELECT * FROM handpays WHERE id = $1 AND org_id = $2 FOR UPDATE', [handpayId, orgId]);
  if (!r.rowCount) throw new HttpError(404, 'Handpay not found');
  return r.rows[0];
}

/** Supervisor approval. The approver may not be the person who pays (database check). */
export async function approveHandpay(db: Db, a: Actor, handpayId: string, approvalId?: string | null) {
  if (!a.employeeId) throw new HttpError(400, 'An employee must approve');
  const h = await lockHandpay(db, a.orgId, handpayId);
  assertTransition(h, 'APPROVED');
  // On the ledger an approval above the limit goes through the four-eyes approval request.
  if (!approvalId && (await handpayOnLedger(db, h)) && (await approvalRequired(db, h)))
    throw new HttpError(409, 'Approval above the limit goes through an approval request (four eyes)');
  const r = await db.query(
    `UPDATE handpays SET status = 'APPROVED', approved_by = $2, approved_at = now(), approval_id = $3 WHERE id = $1 RETURNING *`,
    [h.id, a.employeeId, approvalId ?? null],
  );
  await event(db, h, 'APPROVED', h.status, 'APPROVED', a.employeeId, approvalId ? { approvalId } : {});
  await audit(db, a, 'handpay.approved', h, approvalId ? { approvalId } : {});
  return r.rows[0] as HandpayRow;
}

/** Whether a handpay of this amount needs supervisor approval (casino setting; NULL = never). */
async function approvalRequired(db: Db, h: HandpayRow) {
  const limit = (await db.query('SELECT handpay_approval_cents FROM casino_money_settings WHERE casino_id = $1', [h.casino_id])).rows[0]?.handpay_approval_cents;
  return limit !== null && limit !== undefined && h.amount_cents >= limit;
}

/** Step 1 of the four-eyes approval: requested by the cashier (or any employee) for one handpay. */
export async function requestHandpayApproval(db: Db, a: Actor, handpayId: string) {
  const h = await lockHandpay(db, a.orgId, handpayId);
  if (h.status !== 'PENDING') throw new HttpError(409, `Handpay is ${h.status}`);
  if (!(await approvalRequired(db, h))) throw new HttpError(409, 'This handpay is below the approval limit');
  const open = await db.query(`SELECT * FROM approvals WHERE action = 'HANDPAY_PAY' AND entity_id = $1 AND status IN ('PENDING', 'APPROVED') AND expires_at > now()`, [h.id]);
  if (open.rowCount) return open.rows[0];
  return requestApproval(db, a, { casinoId: h.casino_id, action: 'HANDPAY_PAY', entityType: 'handpay', entityId: h.id, amountCents: h.amount_cents, payload: { machineId: h.machine_id, sourceEventId: h.source_event_id } });
}

/** Step 2: a different employee decides (approvals table, audited); approval sets the handpay APPROVED. */
export async function decideHandpayApproval(db: Db, a: Actor, approvalId: string, decision: 'APPROVED' | 'REJECTED', note?: string) {
  const ap = await decideApproval(db, a, approvalId, decision, note);
  if (ap.action !== 'HANDPAY_PAY') throw new HttpError(409, 'Not a handpay approval');
  if (decision === 'REJECTED') return { approval: ap, handpay: null };
  const handpay = await approveHandpay(db, a, ap.entity_id, approvalId);
  return { approval: ap, handpay };
}

/**
 * Pays a handpay. LEDGER rail: HANDPAY_PAY to cash (open shift) or to the player's wallet.
 * LEGACY rail: the legacy cash flow (cash only). Below the approval limit a PENDING handpay is
 * approved implicitly; above it an approved four-eyes request is required.
 */
export async function payHandpay(db: Db, a: Actor, handpayId: string, opts: { playerId?: string | null; cardId?: string | null; payTo?: HandpayPayTo } = {}) {
  if (!a.employeeId) throw new HttpError(400, 'An employee must pay');
  const peek = await db.query('SELECT org_id, casino_id FROM handpays WHERE id = $1 AND org_id = $2', [handpayId, a.orgId]);
  if (!peek.rowCount) throw new HttpError(404, 'Handpay not found');
  if (await handpayOnLedger(db, peek.rows[0])) return payHandpayLedger(db, a, handpayId, opts);
  if ((opts.payTo ?? 'CASH') !== 'CASH') throw new HttpError(409, 'Wallet handpays need the HANDPAY rail on the ledger');
  if (await railOnLedger(db, a.orgId, 'CASH', peek.rows[0].casino_id))
    throw new HttpError(409, 'Cash is on the ledger but HANDPAY is not: cut over the HANDPAY rail first (no mixed legacy / ledger booking)');
  return payHandpayLegacy(db, a, handpayId, opts);
}

/** Legacy (Step 1) cash payment, unchanged: used only while the HANDPAY rail is LEGACY. */
async function payHandpayLegacy(db: Db, a: Actor, handpayId: string, opts: { playerId?: string | null }) {
  const session = await requireOpenSession(db as PoolClient, a.orgId, a.employeeId!);
  let h = await lockHandpay(db, a.orgId, handpayId);
  if (h.casino_id !== session.casino_id) throw new HttpError(409, 'Handpay belongs to another casino');
  if (h.status === 'PENDING') {
    if (await approvalRequired(db, h)) throw new HttpError(409, 'Supervisor approval required for this handpay');
    h = (await db.query(`UPDATE handpays SET status = 'APPROVED', approved_at = now() WHERE id = $1 RETURNING *`, [h.id])).rows[0];
    await event(db, h, 'APPROVED', 'PENDING', 'APPROVED', null, { automatic: true, reason: 'below approval limit' });
  }
  assertTransition(h, 'PAID');
  if (h.approved_by && h.approved_by === a.employeeId) throw new HttpError(409, 'The approver cannot pay the same handpay');
  const machine = (await db.query('SELECT asset_no, gateway_id FROM machines WHERE id = $1', [h.machine_id])).rows[0];
  let tx;
  try {
    tx = await addCashTx(db as PoolClient, session, 'HANDPAY', h.amount_cents / 100, {
      machineId: h.machine_id, playerId: opts.playerId ?? undefined, reference: `Jackpot ${machine.asset_no}`, sourceEventId: h.source_event_id,
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'Handpay already paid');
    throw err;
  }
  let paid = (await db.query(
    `UPDATE handpays SET status = 'PAID', paid_by = $2, paid_at = now(), pay_method = 'CASH', cashier_session_id = $3, legacy_cash_transaction_id = $4, player_id = COALESCE($5, player_id)
     WHERE id = $1 RETURNING *`,
    [h.id, a.employeeId, session.id, tx.id, opts.playerId ?? null],
  )).rows[0] as HandpayRow;
  await event(db, h, 'PAID', 'APPROVED', 'PAID', a.employeeId, { cashTransactionId: tx.id });
  paid = await afterPayment(db, paid, machine.gateway_id, a.employeeId!);
  await audit(db, a, 'handpay.paid', paid, { cashTransactionId: tx.id });
  return { handpay: paid, transaction: tx };
}

/** Verification (KYC) above the organisation's threshold: an identified, VERIFIED player. */
async function assertVerification(db: Db, orgId: string, h: HandpayRow, playerId: string | null | undefined) {
  const t = (await db.query('SELECT verification_threshold_cents FROM organizations WHERE id = $1', [orgId])).rows[0]?.verification_threshold_cents;
  if (t === null || t === undefined || h.amount_cents < t) return;
  if (!playerId) throw new HttpError(409, 'This handpay needs an identified, verified player (verification threshold)');
  const p = (await db.query('SELECT verification_status FROM players WHERE id = $1 AND org_id = $2', [playerId, orgId])).rows[0];
  if (p?.verification_status !== 'VERIFIED') throw new HttpError(409, 'The player is not verified (verification threshold)');
}

async function payHandpayLedger(db: Db, a: Actor, handpayId: string, opts: { playerId?: string | null; cardId?: string | null; payTo?: HandpayPayTo }) {
  const payTo = opts.payTo ?? 'CASH';
  let h = await lockHandpay(db, a.orgId, handpayId);
  if (h.status === 'PAID' || h.status === 'MACHINE_RESET') throw new HttpError(409, 'Handpay already paid');
  if (h.status === 'VOIDED') throw new HttpError(409, 'Handpay is VOIDED');

  // Approval: above the limit an approved four-eyes request; below it the payment approves implicitly.
  let approvalId: string | null = null;
  if (await approvalRequired(db, h)) {
    if (h.status !== 'APPROVED' || !h.approval_id) throw new HttpError(409, 'Supervisor approval required for this handpay');
    const ap = (await db.query('SELECT status FROM approvals WHERE id = $1 FOR UPDATE', [h.approval_id])).rows[0];
    if (ap?.status !== 'APPROVED') throw new HttpError(409, `The approval is ${ap?.status ?? 'missing'}`);
    approvalId = h.approval_id;
  } else if (h.status === 'PENDING') {
    h = (await db.query(`UPDATE handpays SET status = 'APPROVED', approved_at = now() WHERE id = $1 RETURNING *`, [h.id])).rows[0];
    await event(db, h, 'APPROVED', 'PENDING', 'APPROVED', null, { automatic: true, reason: 'below approval limit' });
  }
  if (h.approved_by && h.approved_by === a.employeeId) throw new HttpError(409, 'The approver cannot pay the same handpay');
  await assertVerification(db, a.orgId, h, opts.playerId);

  const machine = (await db.query('SELECT asset_no, gateway_id FROM machines WHERE id = $1', [h.machine_id])).rows[0];
  const base = { casinoId: h.casino_id, amountCents: cents(h.amount_cents), machineId: h.machine_id, handpayId: h.id, playerId: opts.playerId ?? undefined, cardId: opts.cardId ?? undefined, payTo };
  const moneyActor: MoneyActor = { type: 'EMPLOYEE', employeeId: a.employeeId, name: a.employeeEmail ?? null, ip: a.ip ?? null };
  const common = { orgId: a.orgId, type: 'HANDPAY_PAY' as const, dedupeKey: entityDedupeKey('handpay', h.id, 'pay'), sourceEventId: h.source_event_id, actor: moneyActor, approvedBy: approvalId ? h.approved_by : null };

  let r;
  let session: Awaited<ReturnType<typeof requireOpenSession>> | null = null;
  let walletId: string | null = null;
  if (payTo === 'CASH') {
    session = await requireOpenSession(db as PoolClient, a.orgId, a.employeeId!);
    if (h.casino_id !== session.casino_id) throw new HttpError(409, 'Handpay belongs to another casino');
    r = await executeMoneyTransaction(db, { ...common, ctx: { ...base, cashierSessionId: session.id } });
  } else {
    if (!opts.playerId) throw new HttpError(400, 'A wallet handpay needs the player (card)');
    const w = (await db.query(
      `SELECT w.id, w.status, p.status AS player_status FROM wallets w JOIN players p ON p.id = w.player_id WHERE w.player_id = $1 AND w.org_id = $2 FOR NO KEY UPDATE OF w`,
      [opts.playerId, a.orgId])).rows[0];
    if (!w) throw new HttpError(409, 'Player has no wallet');
    if (!WALLET_STATUS_OPERATIONS[w.status as keyof typeof WALLET_STATUS_OPERATIONS].includes('DEPOSIT')) throw new HttpError(409, `Wallet status ${w.status} does not allow a handpay to the wallet`);
    if (!playerCan(w.player_status, 'HANDPAY_TO_WALLET')) throw new HttpError(409, `Player status ${w.player_status} does not allow HANDPAY_TO_WALLET`);
    walletId = w.id;
    r = await executeMoneyTransaction(db, { ...common, ctx: { ...base, walletId: w.id } });
  }
  if (r.replayed) throw new HttpError(409, 'Handpay already paid');

  let cashTx = null;
  if (session)
    cashTx = await projectHandpayCash(db, session, {
      amountCents: h.amount_cents, moneyTransactionId: r.transaction.id, sourceEventId: h.source_event_id, machineId: h.machine_id, playerId: opts.playerId, reference: `Jackpot ${machine.asset_no}`,
    });
  let paid = (await db.query(
    `UPDATE handpays SET status = 'PAID', paid_by = $2, paid_at = now(), pay_method = $3, cashier_session_id = $4, legacy_cash_transaction_id = $5, player_id = COALESCE($6, player_id), card_id = COALESCE($7, card_id)
     WHERE id = $1 RETURNING *`,
    [h.id, a.employeeId, payTo, session?.id ?? null, cashTx?.id ?? null, opts.playerId ?? null, opts.cardId ?? null],
  )).rows[0] as HandpayRow;
  if (approvalId) await consumeApproval(db, a, approvalId, { action: 'HANDPAY_PAY', entityId: h.id, moneyTransactionId: r.transaction.id });
  await event(db, h, 'PAID', 'APPROVED', 'PAID', a.employeeId, { transactionId: r.transaction.id, payTo, walletId, cashTransactionId: cashTx?.id ?? null });
  paid = await afterPayment(db, paid, machine.gateway_id, a.employeeId!);
  await audit(db, a, 'handpay.paid', paid, { transactionId: r.transaction.id, payTo, approvalId });
  return { handpay: paid, transaction: cashTx, moneyTransaction: r.transaction };
}

/** After a payment: MACHINE_RESET if the machine was already reset, otherwise request the reset. */
async function afterPayment(db: Db, paid: HandpayRow, gatewayId: string | null, employeeId: string) {
  if (paid.reset_confirmed_at) {
    const r = (await db.query(`UPDATE handpays SET status = 'MACHINE_RESET' WHERE id = $1 RETURNING *`, [paid.id])).rows[0];
    await event(db, paid, 'RESET_CONFIRMED', 'PAID', 'MACHINE_RESET', null, { before: 'payment' });
    return r as HandpayRow;
  }
  await requestReset(db, paid, gatewayId, employeeId);
  return paid;
}

async function requestReset(db: Db, h: HandpayRow, gatewayId: string | null, employeeId: string | null) {
  if (!gatewayId) return null;
  const c = await db.query(
    `INSERT INTO machine_commands (org_id, machine_id, gateway_id, type, payload, requested_by, handpay_id) VALUES ($1,$2,$3,'RESET_JACKPOT',$4,$5,$6) RETURNING id`,
    [h.org_id, h.machine_id, gatewayId, { jackpotEventId: h.source_event_id }, employeeId, h.id],
  );
  await db.query('UPDATE handpays SET reset_requested_at = now(), reset_attempts = reset_attempts + 1 WHERE id = $1', [h.id]);
  await event(db, h, 'RESET_REQUESTED', null, null, employeeId, { commandId: c.rows[0].id });
  return c.rows[0].id as string;
}

/**
 * Manual reset retry of a paid handpay. Never touches money. Idempotent: while a reset command is
 * still open it is returned instead of a second one; a confirmed reset is a no-op.
 */
export async function retryHandpayReset(db: Db, a: Actor, handpayId: string) {
  const h = await lockHandpay(db, a.orgId, handpayId);
  if (h.status === 'MACHINE_RESET' || h.reset_confirmed_at) return { handpay: h, commandId: null, status: 'ALREADY_RESET' as const };
  if (h.status !== 'PAID') throw new HttpError(409, 'Only a paid handpay is reset from here');
  const open = await db.query(`SELECT id FROM machine_commands WHERE handpay_id = $1 AND status IN ('PENDING', 'SENT') ORDER BY created_at DESC LIMIT 1`, [h.id]);
  if (open.rowCount) return { handpay: h, commandId: open.rows[0].id as string, status: 'IN_PROGRESS' as const };
  const gw = (await db.query('SELECT gateway_id FROM machines WHERE id = $1', [h.machine_id])).rows[0]?.gateway_id;
  if (!gw) throw new HttpError(409, 'The machine has no gateway');
  const commandId = await requestReset(db, h, gw, a.employeeId ?? null);
  await audit(db, a, 'handpay.reset_retried', h, { commandId });
  return { handpay: h, commandId, status: 'REQUESTED' as const };
}

/**
 * The machine was reset (JACKPOT_RESET event or confirmed command). A paid handpay becomes
 * MACHINE_RESET; an unpaid one only records the reset and stays payable. Repeated confirmations
 * (duplicate / late responses) change nothing.
 */
export async function confirmHandpayReset(db: Db, input: { orgId: string; machineId: string; handpayId?: string | null }) {
  const r = await db.query(
    `SELECT * FROM handpays WHERE org_id = $1 AND machine_id = $2 AND ($3::uuid IS NULL OR id = $3) AND reset_confirmed_at IS NULL
       AND status IN ('PENDING', 'APPROVED', 'PAID') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [input.orgId, input.machineId, input.handpayId ?? null],
  );
  const h = r.rows[0] as HandpayRow | undefined;
  if (!h) return null;
  const next = h.status === 'PAID' ? 'MACHINE_RESET' : h.status;
  const u = await db.query('UPDATE handpays SET reset_confirmed_at = now(), status = $2 WHERE id = $1 RETURNING *', [h.id, next]);
  await event(db, h, 'RESET_CONFIRMED', h.status, next);
  return u.rows[0] as HandpayRow;
}

/** Void before payment. On the ledger the liability is released by reversing its creation booking. */
export async function voidHandpay(db: Db, a: Actor, handpayId: string, reason: string) {
  if (!reason || reason.trim().length < 3) throw new HttpError(400, 'A reason is required');
  const h = await lockHandpay(db, a.orgId, handpayId);
  assertTransition(h, 'VOIDED');
  let reversalId: string | null = null;
  if (await handpayOnLedger(db, h)) {
    const created = (await db.query(`SELECT id FROM money_transactions WHERE handpay_id = $1 AND type = 'HANDPAY_CREATE_JACKPOT'`, [h.id])).rows[0];
    if (!created) throw new HttpError(409, 'This handpay was opened by the cutover: voiding it needs a four-eyes adjustment');
    const rev = await reverseMoneyTransaction(db, {
      orgId: a.orgId, transactionId: created.id, dedupeKey: entityDedupeKey('handpay', h.id, 'void'), reason,
      actor: { type: a.employeeId ? 'EMPLOYEE' : 'SYSTEM', employeeId: a.employeeId ?? null, name: a.employeeEmail ?? null },
    });
    reversalId = rev.transaction.id;
  }
  const r = await db.query(`UPDATE handpays SET status = 'VOIDED', voided_by = $2, voided_at = now(), void_reason = $3 WHERE id = $1 RETURNING *`, [h.id, a.employeeId ?? null, reason]);
  await event(db, h, 'VOIDED', h.status, 'VOIDED', a.employeeId, { reason, reversalId });
  await audit(db, a, 'handpay.voided', h, { reason, reversalId });
  return r.rows[0] as HandpayRow;
}

/**
 * Background job: a reset command that is neither confirmed nor failed in time counts as FAILED
 * (gateway offline / response lost); failed resets of paid handpays are requested again. A late
 * success of an old command still confirms the reset (once).
 */
export async function retryFailedHandpayResets(db: Db, maxAttempts = 10) {
  await db.query(
    `UPDATE machine_commands c SET status = 'FAILED', result_message = 'timeout', completed_at = now()
     FROM handpays h WHERE h.id = c.handpay_id AND c.type = 'RESET_JACKPOT' AND c.status IN ('PENDING', 'SENT')
       AND c.created_at < now() - make_interval(secs => COALESCE((SELECT handpay_reset_timeout_seconds FROM casino_money_settings s WHERE s.casino_id = h.casino_id), 120))`,
  );
  const due = await db.query(
    `SELECT h.*, m.gateway_id FROM handpays h JOIN machines m ON m.id = h.machine_id
     WHERE h.status = 'PAID' AND h.reset_confirmed_at IS NULL AND h.reset_attempts < $1
       AND NOT EXISTS (SELECT 1 FROM machine_commands c WHERE c.handpay_id = h.id AND c.status IN ('PENDING', 'SENT'))
       AND EXISTS (SELECT 1 FROM machine_commands c WHERE c.handpay_id = h.id AND c.status = 'FAILED')
     FOR UPDATE OF h SKIP LOCKED`,
    [maxAttempts],
  );
  for (const h of due.rows) await requestReset(db, h, h.gateway_id, null);
  return due.rowCount ?? 0;
}
