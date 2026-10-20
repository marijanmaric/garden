import { writeAudit, type PoolClient } from '@m1/database';
import { cents } from '@m1/shared';
import { HttpError, stateError } from '../auth';
import type { BusMessage } from '../bus';
import { openAlert } from './alerts';
import { recordEventException } from './event-exceptions';
import { consumeApproval, decideApproval, requestApproval } from './approvals';
import { newBarcode, requireOpenSession, type SessionRow } from './cashier';
import { entityDedupeKey, eventDedupeKey, executeMoneyTransaction, reverseMoneyTransaction, type LatePosting, type MoneyActor } from './ledger';
import { projectTicketCash, projectTicketVoid } from './legacy-projection';
import type { Actor } from './players';
import { railOnLedger } from './rails';
import { assertWalletOperation, walletOfPlayer } from './wallets';

/**
 * Step 7c: TITO on the ledger. The ticket is the entity, the ledger the money:
 *
 *   machine prints (TITO_OUT)       TITO_ISSUE_MACHINE   machine side -> TICKET_LIABILITY
 *   cashier sells                   TITO_ISSUE_CASHIER   drawer / wallet -> TICKET_LIABILITY
 *   VALID <-> HELD                  no money (hold for one machine, released on reject / timeout)
 *   machine accepts (TITO_IN)       TITO_REDEEM_MACHINE  TICKET_LIABILITY -> machine side, on the accept ack
 *   cashier pays                    TITO_REDEEM_CASHIER  TICKET_LIABILITY -> drawer / wallet (approval above the limit)
 *   expiry (job)                    TITO_EXPIRY          TICKET_LIABILITY -> EXPIRED_TICKET_INCOME
 *   cancel (four eyes)              TITO_CANCEL          TICKET_LIABILITY -> TITO_ADJUSTMENT
 *   void (four eyes, cashier sale)  REVERSAL of the sale (printer failure, never valid)
 *   accepted without liability      TITO_EXCEPTION       TITO_EXCEPTION -> machine side (investigation)
 *
 * Machine side = MACHINE_CREDIT of a machine on the ledger, or (D1) the machine's
 * LEGACY_FLOOR_CLEARING account while the machine is still LEGACY.
 *
 * Exactly once: dedupe keys (event id for machine events, ticket id for ticket steps), unique indexes
 * (one issue and one final booking per ticket, migration 010), the ticket row lock and the ticket
 * state machine. A ticket machine event is never lost: while TITO is frozen it is recorded as a
 * deferred money event and replayed after the lift (as jackpots in 7b); an event of an earlier business
 * date is booked on that date through the same validated path, or stays pending if the date is closed.
 */

type Db = Pick<PoolClient, 'query'>;

export interface TicketRow {
  id: string;
  org_id: string;
  casino_id: string;
  barcode: string;
  amount: string;
  amount_cents: number;
  status: string;
  issued_by_machine_id: string | null;
  issued_by_employee: string | null;
  expires_at: string;
  hold_id: string | null;
  hold_machine_id: string | null;
  hold_source: string | null;
  source_event_id: string | null;
}

export type TicketApprovalAction = 'TITO_REDEEM_CASHIER' | 'TITO_CANCEL' | 'TITO_VOID';

export const titoOnLedger = (db: Db, orgId: string, casinoId: string) => railOnLedger(db, orgId, 'TITO', casinoId);

async function titoFrozen(db: Db, orgId: string, casinoId: string, machineId?: string | null): Promise<boolean> {
  // 7d: the ticket side of a machine on the MACHINE ledger is its MACHINE_CREDIT, so a frozen machine defers too
  return (await db.query(
    `SELECT money_rail_frozen($1, $2, 'TITO', NULL)
       OR ($3::uuid IS NOT NULL AND money_rail_ledger($1, $2, 'MACHINE', $3) AND money_rail_frozen($1, $2, 'MACHINE', $3)) AS f`,
    [orgId, casinoId, machineId ?? null])).rows[0].f;
}

/** D1: a machine that is not on the ledger yet books its ticket side on its LEGACY_FLOOR_CLEARING account. */
async function floorClearing(db: Db, orgId: string, casinoId: string, machineId: string) {
  return !(await railOnLedger(db, orgId, 'MACHINE', casinoId, machineId));
}

async function ticketEvent(db: Db, t: { id: string; org_id: string }, action: string, x: { machineId?: string | null; employeeId?: string | null; details?: Record<string, unknown>; at?: string | null } = {}) {
  await db.query(
    'INSERT INTO ticket_events (org_id, ticket_id, action, machine_id, employee_id, details, created_at) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()))',
    [t.org_id, t.id, action, x.machineId ?? null, x.employeeId ?? null, x.details ?? {}, x.at ?? null],
  );
}

function auditTicket(db: Db, a: { orgId: string; employeeId?: string | null; employeeEmail?: string | null; ip?: string | null }, casinoId: string, action: string, ticketId: string, details: Record<string, unknown>) {
  return writeAudit(db as PoolClient, {
    orgId: a.orgId, casinoId, actorType: a.employeeId ? 'EMPLOYEE' : 'SYSTEM', actorId: a.employeeId ?? null, actorName: a.employeeEmail ?? 'tito', ip: a.ip ?? null,
    action, entityType: 'ticket', entityId: ticketId, details,
  });
}

const employeeActor = (a: Actor): MoneyActor => ({ type: 'EMPLOYEE', employeeId: a.employeeId, name: a.employeeEmail ?? null, ip: a.ip ?? null });
const GATEWAY: MoneyActor = { type: 'GATEWAY', name: 'tito' };

// ---- machine events --------------------------------------------------------------------------

export interface TitoMachineEvent {
  orgId: string;
  casinoId: string;
  machineId: string;
  label: string;
  eventId: string;
  type: 'TITO_OUT' | 'TITO_IN';
  barcode: string | null;
  holdId: string | null;
  /** Machine-reported amount in integer cents (converted once at the boundary); null if not reported. */
  amountCents: number | null;
  occurredAt: string;
}

/** A ticket machine event that moves money: a printed ticket with an amount, or an accepted ticket. */
export function titoEventMovesMoney(ev: Pick<TitoMachineEvent, 'type' | 'barcode' | 'amountCents'>) {
  return !!ev.barcode && (ev.type === 'TITO_IN' || (ev.amountCents ?? 0) > 0);
}

/**
 * Entry point from ingestion (TITO on the ledger). The machine event is already stored.
 * Frozen TITO: recorded as a deferred money event (no ticket change, no booking). An event whose
 * occurred_at is on another business date than today: recorded with reason LATE_EVENT / EARLY_EVENT and
 * booked now on the date of occurred_at (validated by the ledger), or kept pending if that date is closed
 * (or still in the future). Otherwise booked now (today = the occurred date).
 */
export async function handleTitoMachineEvent(db: PoolClient, ev: TitoMachineEvent, out: BusMessage[]) {
  if (!titoEventMovesMoney(ev)) return { deferred: false as const, outcome: 'NO_MONEY' };
  const frozen = await titoFrozen(db, ev.orgId, ev.casinoId, ev.machineId);
  const day: number = frozen ? 0 : (await db.query(
    `SELECT sign(($2::timestamptz AT TIME ZONE timezone)::date - (now() AT TIME ZONE timezone)::date)::int AS day FROM casinos WHERE id = $1`, [ev.casinoId, ev.occurredAt],
  )).rows[0].day;
  if (frozen || day !== 0) {
    const amount = await deferredAmount(db, ev);
    if (!amount) {
      // Never estimated: without an amount the event stays unbooked; reconciliation reports it.
      await openAlert(db, { orgId: ev.orgId, casinoId: ev.casinoId, machineId: ev.machineId, type: 'TICKET_EVENT_UNBOOKED', severity: 'CRITICAL', message: `${ev.label} ${ev.type} ${ev.barcode} without amount could not be recorded` }, out);
      return { deferred: false as const, outcome: 'UNBOOKED' };
    }
    const r = await db.query(
      `INSERT INTO deferred_money_events (event_id, org_id, casino_id, machine_id, rail, kind, amount_cents, reason)
       VALUES ($1,$2,$3,$4,'TITO',$5,$6,$7) ON CONFLICT (event_id) DO NOTHING RETURNING *`,
      [ev.eventId, ev.orgId, ev.casinoId, ev.machineId, ev.type, amount, frozen ? 'FROZEN' : day < 0 ? 'LATE_EVENT' : 'EARLY_EVENT'],
    );
    const d = r.rows[0];
    if (d)
      await writeAudit(db as PoolClient, {
        orgId: ev.orgId, casinoId: ev.casinoId, actorType: 'SYSTEM', actorId: null, actorName: 'tito',
        action: 'ticket.event_deferred', entityType: 'machine_event', entityId: ev.eventId,
        details: { type: ev.type, machineId: ev.machineId, barcode: ev.barcode, amountCents: amount, reason: d.reason, occurredAt: d.occurred_at, receivedAt: d.received_at, businessDate: d.business_date },
      });
    if (frozen) {
      await openAlert(db, { orgId: ev.orgId, casinoId: ev.casinoId, machineId: ev.machineId, type: 'TICKET_DEFERRED', severity: 'WARNING', message: `${ev.label} ${ev.type === 'TITO_OUT' ? 'printed' : 'accepted'} ticket ${ev.barcode} recorded; booking deferred while TITO is frozen` }, out);
      return { deferred: true as const, outcome: 'DEFERRED' };
    }
    const done = await replayDeferredTito(db, { eventId: ev.eventId }, out);
    return { deferred: !done.length, outcome: done.length ? 'LATE_BOOKED' : 'LATE_PENDING' };
  }
  return { deferred: false as const, ...(await processTitoEvent(db, ev, null, out)) };
}

/** Amount of a deferred ticket event: the machine-reported amount, else the ticket's amount. */
async function deferredAmount(db: Db, ev: TitoMachineEvent): Promise<number | null> {
  if (ev.amountCents && ev.amountCents > 0) return ev.amountCents;
  if (ev.type !== 'TITO_IN' || !ev.barcode) return null;
  return (await db.query('SELECT amount_cents FROM tickets WHERE org_id = $1 AND barcode = $2', [ev.orgId, ev.barcode])).rows[0]?.amount_cents ?? null;
}

/** Books one ticket machine event. businessDate only for the replay of a deferred record (validated by the ledger). */
export async function processTitoEvent(db: PoolClient, ev: TitoMachineEvent, businessDate: string | null, out: BusMessage[], late: LatePosting | null = null): Promise<{ outcome: string; ticketId: string | null; moneyTransactionId: string | null }> {
  const clearing = await floorClearing(db, ev.orgId, ev.casinoId, ev.machineId);
  const machineCtx = { casinoId: ev.casinoId, machineId: ev.machineId, floorClearing: clearing || undefined };

  if (ev.type === 'TITO_OUT') {
    const t = (await db.query(
      `INSERT INTO tickets (org_id, casino_id, barcode, amount, issued_by_machine_id, issued_at, expires_at, source_event_id)
       SELECT $1, $2, $3, $4::bigint / 100.0, $5, $6, $6::timestamptz + make_interval(days => c.ticket_expiry_days), $7 FROM casinos c WHERE c.id = $2
       ON CONFLICT (org_id, barcode) DO NOTHING RETURNING *`,
      [ev.orgId, ev.casinoId, ev.barcode, ev.amountCents, ev.machineId, ev.occurredAt, ev.eventId],
    )).rows[0] as TicketRow | undefined;
    if (!t) {
      // A barcode that already exists belongs to another ticket: never merged, never guessed. The event
      // stays unbooked and reconciliation (tito.machine_events_accounted) reports it for explicit handling.
      // Open for 7d: on a machine whose MACHINE rail is on the ledger the machine-event guard then fails the ingest
      // transaction (HTTP 500, no money). 7d turns this into a deterministic, audited business rejection.
      await openAlert(db, { orgId: ev.orgId, casinoId: ev.casinoId, machineId: ev.machineId, type: 'TICKET_DUPLICATE_BARCODE', severity: 'CRITICAL', message: `${ev.label} printed ticket ${ev.barcode}, a barcode that already exists` }, out);
      return { outcome: 'DUPLICATE_BARCODE', ticketId: null, moneyTransactionId: null };
    }
    const r = await executeMoneyTransaction(db, {
      orgId: ev.orgId, type: 'TITO_ISSUE_MACHINE', dedupeKey: eventDedupeKey(ev.eventId, 'TITO_ISSUE_MACHINE'), sourceEventId: ev.eventId, actor: GATEWAY, businessDate, latePosting: late,
      ctx: { ...machineCtx, amountCents: cents(t.amount_cents), ticketId: t.id },
    });
    await ticketEvent(db, t, 'ISSUED', { machineId: ev.machineId, at: ev.occurredAt, details: { transactionId: r.transaction.id, floorClearing: clearing } });
    return { outcome: 'ISSUED', ticketId: t.id, moneyTransactionId: r.transaction.id };
  }

  // TITO_IN: the machine accepted a ticket (the accept ack). Money moves only now.
  const t = (await db.query('SELECT * FROM tickets WHERE org_id = $1 AND barcode = $2 FOR UPDATE', [ev.orgId, ev.barcode])).rows[0] as TicketRow | undefined;
  const ownHold = t && t.status === 'HELD' && t.hold_id === ev.holdId && t.hold_machine_id === ev.machineId;
  const validHere = t && t.casino_id === ev.casinoId && (ownHold || t.status === 'VALID');
  if (t && validHere) {
    const policy = (await db.query('SELECT tito_offline_policy FROM casino_money_settings WHERE casino_id = $1', [ev.casinoId])).rows[0]?.tito_offline_policy ?? 'REJECT';
    const r = await executeMoneyTransaction(db, {
      orgId: ev.orgId, type: 'TITO_REDEEM_MACHINE', dedupeKey: entityDedupeKey('ticket', t.id, 'redeem'), sourceEventId: ev.eventId, actor: GATEWAY, businessDate, latePosting: late,
      ctx: { ...machineCtx, amountCents: cents(t.amount_cents), ticketId: t.id },
    });
    await db.query(
      `UPDATE tickets SET status = 'REDEEMED', redeemed_at = $2, redeemed_machine_id = $3, hold_id = NULL, hold_until = NULL, hold_source = NULL, hold_machine_id = NULL WHERE id = $1`,
      [t.id, ev.occurredAt, ev.machineId],
    );
    await ticketEvent(db, t, 'REDEEMED', { machineId: ev.machineId, at: ev.occurredAt, details: { transactionId: r.transaction.id, holdId: ownHold ? ev.holdId : null, withoutHold: !ownHold, floorClearing: clearing } });
    if (!ownHold)
      // Accepted without a committed hold (machine offline or protocol deviation): the liability still
      // existed, so redeeming it is exact and prevents a second payout; the deviation is alerted.
      await openAlert(db, {
        orgId: ev.orgId, casinoId: ev.casinoId, machineId: ev.machineId, type: 'TICKET_ACCEPTED_WITHOUT_HOLD', severity: policy === 'ACCEPT_WITH_EXCEPTION' ? 'WARNING' : 'CRITICAL',
        message: `${ev.label} accepted ticket ${ev.barcode} without a committed hold (offline policy ${policy})`,
      }, out);
    if (ev.amountCents !== null && ev.amountCents !== t.amount_cents)
      await openAlert(db, { orgId: ev.orgId, casinoId: ev.casinoId, machineId: ev.machineId, type: 'TICKET_AMOUNT_MISMATCH', severity: 'CRITICAL', message: `${ev.label} reported ${ev.amountCents} cents for ticket ${ev.barcode} of ${t.amount_cents} cents` }, out);
    return { outcome: 'REDEEMED', ticketId: t.id, moneyTransactionId: r.transaction.id };
  }

  // No liability to extinguish (unknown, other casino, already final, held for someone else): the
  // machine nevertheless gave credit. Booked as TITO_EXCEPTION with the machine-reported amount.
  const reason = !t ? 'unknown ticket' : t.casino_id !== ev.casinoId ? 'ticket of another casino' : t.status === 'HELD' ? 'ticket held for another machine or cashier' : `ticket already ${t.status}`;
  if (t) await ticketEvent(db, t, 'REJECTED', { machineId: ev.machineId, at: ev.occurredAt, details: { status: t.status, reason } });
  await openAlert(db, { orgId: ev.orgId, casinoId: ev.casinoId, machineId: ev.machineId, type: 'TICKET_REJECTED', severity: 'CRITICAL', message: `${ev.label} accepted ${reason} ${ev.barcode}` }, out);
  const amount = ev.amountCents ?? 0;
  if (amount <= 0) return { outcome: 'EXCEPTION_UNBOOKED', ticketId: t?.id ?? null, moneyTransactionId: null };
  const r = await executeMoneyTransaction(db, {
    orgId: ev.orgId, type: 'TITO_EXCEPTION', dedupeKey: eventDedupeKey(ev.eventId, 'TITO_EXCEPTION'), sourceEventId: ev.eventId, actor: GATEWAY, businessDate, latePosting: late,
    reason, ctx: { ...machineCtx, amountCents: cents(amount), ticketId: t?.id },
  });
  return { outcome: 'EXCEPTION', ticketId: t?.id ?? null, moneyTransactionId: r.transaction.id };
}

/**
 * Replays deferred ticket events (rail TITO) whose rail is no longer frozen, each exactly once, on the
 * business date of occurred_at. Every record runs in its own savepoint: one that cannot be booked (e.g.
 * its business date is closed) stays PENDING with last_error; the closed-date guard is never bypassed
 * and reconciliation reports the record (tito.no_stale_deferred_events) for explicit handling.
 */
export async function replayDeferredTito(db: PoolClient, filter: { orgId?: string; casinoId?: string; eventId?: string } = {}, out: BusMessage[] = []) {
  const due = (await db.query(
    `SELECT d.*, d.business_date::text AS business_date, e.payload, m.asset_no FROM deferred_money_events d
     JOIN machine_events e ON e.event_id = d.event_id JOIN machines m ON m.id = d.machine_id
     WHERE d.status = 'PENDING' AND d.rail = 'TITO' AND ($1::uuid IS NULL OR d.org_id = $1) AND ($2::uuid IS NULL OR d.casino_id = $2) AND ($3::uuid IS NULL OR d.event_id = $3)
       AND NOT money_rail_frozen(d.org_id, d.casino_id, 'TITO', NULL)
       AND NOT (money_rail_ledger(d.org_id, d.casino_id, 'MACHINE', d.machine_id) AND money_rail_frozen(d.org_id, d.casino_id, 'MACHINE', d.machine_id))
       AND NOT (d.last_error IS NOT NULL AND EXISTS (SELECT 1 FROM business_day_closes b WHERE b.casino_id = d.casino_id AND b.business_date = d.business_date))
     ORDER BY d.occurred_at, d.event_id FOR UPDATE OF d SKIP LOCKED`,
    [filter.orgId ?? null, filter.casinoId ?? null, filter.eventId ?? null],
  )).rows;
  const done = [];
  for (const d of due) {
    const ev: TitoMachineEvent = {
      orgId: d.org_id, casinoId: d.casino_id, machineId: d.machine_id, label: d.asset_no, eventId: d.event_id, type: d.kind,
      barcode: d.payload?.ticketBarcode ?? null, holdId: d.payload?.holdId ?? null, amountCents: Number(d.amount_cents), occurredAt: d.occurred_at,
    };
    await db.query('SAVEPOINT deferred_tito');
    try {
      const r = await processTitoEvent(db, ev, d.business_date, out);
      // 7d: a replayed ticket event that cannot be booked is a recorded exception (reported until explained)
      if (r.outcome === 'DUPLICATE_BARCODE' || r.outcome === 'EXCEPTION_UNBOOKED')
        await recordEventException(db, { ...ev, label: ev.label }, 'TITO', r.outcome, r.outcome === 'DUPLICATE_BARCODE' ? `ticket barcode ${ev.barcode} already exists` : 'ticket event without a bookable amount', out);
      await db.query(
        `UPDATE deferred_money_events SET status = 'PROCESSED', replayed_at = now(), ticket_id = $2, money_transaction_id = $3, attempts = attempts + 1, last_error = NULL WHERE event_id = $1`,
        [d.event_id, r.ticketId, r.moneyTransactionId],
      );
      await writeAudit(db, {
        orgId: d.org_id, casinoId: d.casino_id, actorType: 'SYSTEM', actorId: null, actorName: 'tito',
        action: 'ticket.event_replayed', entityType: 'machine_event', entityId: d.event_id,
        details: { type: d.kind, outcome: r.outcome, ticketId: r.ticketId, moneyTransactionId: r.moneyTransactionId, businessDate: d.business_date, occurredAt: d.occurred_at, reason: d.reason, attempts: d.attempts + 1 },
      });
      await db.query('RELEASE SAVEPOINT deferred_tito');
      done.push({ eventId: d.event_id as string, outcome: r.outcome, ticketId: r.ticketId, moneyTransactionId: r.moneyTransactionId });
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT deferred_tito');
      const message = err instanceof Error ? err.message : String(err);
      await db.query('UPDATE deferred_money_events SET attempts = attempts + 1, last_error = $2 WHERE event_id = $1', [d.event_id, message]);
      await writeAudit(db, {
        orgId: d.org_id, casinoId: d.casino_id, actorType: 'SYSTEM', actorId: null, actorName: 'tito',
        action: 'ticket.event_replay_failed', entityType: 'machine_event', entityId: d.event_id,
        details: { type: d.kind, businessDate: d.business_date, error: message, attempts: d.attempts + 1 },
      });
    }
  }
  return done;
}

/** Machine hold request (no money). Refused while TITO is frozen: no ticket is reserved for a booking that cannot happen. */
export async function assertHoldAllowed(db: Db, orgId: string, casinoId: string) {
  if ((await titoOnLedger(db, orgId, casinoId)) && (await titoFrozen(db, orgId, casinoId))) return 'TITO_FROZEN' as const;
  return null;
}

// ---- cashier ---------------------------------------------------------------------------------

async function lockTicketByBarcode(db: Db, orgId: string, casinoId: string, barcode: string): Promise<TicketRow> {
  const t = (await db.query('SELECT * FROM tickets WHERE org_id = $1 AND casino_id = $2 AND barcode = $3 FOR UPDATE', [orgId, casinoId, barcode])).rows[0];
  if (!t) throw new HttpError(404, 'Unknown ticket');
  return t;
}

async function lockTicket(db: Db, a: Actor & { casinoIds?: string[] }, ticketId: string): Promise<TicketRow> {
  const t = (await db.query('SELECT * FROM tickets WHERE id = $1 AND org_id = $2 FOR UPDATE', [ticketId, a.orgId])).rows[0];
  if (!t || (a.casinoIds && !a.casinoIds.includes(t.casino_id))) throw new HttpError(404, 'Ticket not found');
  return t;
}

function assertPayable(t: TicketRow) {
  if (t.status === 'HELD') throw new HttpError(409, `Ticket is held (${t.hold_source === 'MACHINE' ? 'by a machine' : 'at a cashier'})`);
  if (t.status !== 'VALID') throw new HttpError(409, `Ticket is ${t.status}`);
  if (new Date(t.expires_at) <= new Date()) throw new HttpError(409, 'Ticket expired');
}

async function requireTitoLedger(db: Db, orgId: string, casinoId: string) {
  if (!(await titoOnLedger(db, orgId, casinoId))) throw stateError(409, 'RAIL_LEGACY', 'TITO is not on the ledger for this casino');
}

async function walletFor(db: Db, orgId: string, playerId: string | null | undefined, op: 'DEPOSIT' | 'WITHDRAW') {
  if (!playerId) throw new HttpError(400, 'A wallet ticket operation needs the player (card)');
  const w = await walletOfPlayer(db, orgId, playerId);
  assertWalletOperation(w, op);
  return w;
}

/** Cashier sells a ticket, paid with cash (drawer) or from the player's wallet. */
export async function sellTicket(db: PoolClient, a: Actor, input: { amountCents: number; payFrom?: 'CASH' | 'WALLET'; playerId?: string | null; cardId?: string | null }) {
  if (!a.employeeId) throw new HttpError(400, 'An employee must sell');
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new HttpError(400, 'Amount must be a positive number of cents');
  const payFrom = input.payFrom ?? 'CASH';
  const session = await requireOpenSession(db, a.orgId, a.employeeId);
  await requireTitoLedger(db, a.orgId, session.casino_id);
  const w = payFrom === 'WALLET' ? await walletFor(db, a.orgId, input.playerId, 'WITHDRAW') : null;
  const t = (await db.query(
    `INSERT INTO tickets (org_id, casino_id, barcode, amount, issued_by_employee, expires_at)
     SELECT $1, $2, $3, $4::bigint / 100.0, $5, now() + make_interval(days => c.ticket_expiry_days) FROM casinos c WHERE c.id = $2 RETURNING *`,
    [a.orgId, session.casino_id, newBarcode(), input.amountCents, a.employeeId],
  )).rows[0] as TicketRow;
  const r = await executeMoneyTransaction(db, {
    orgId: a.orgId, type: 'TITO_ISSUE_CASHIER', dedupeKey: entityDedupeKey('ticket', t.id, 'issue'), actor: employeeActor(a),
    ctx: { casinoId: session.casino_id, amountCents: cents(input.amountCents), ticketId: t.id, cashierSessionId: session.id, payFrom, walletId: w?.id, playerId: input.playerId ?? undefined, cardId: input.cardId ?? undefined },
  });
  const cashTx = payFrom === 'CASH'
    ? await projectTicketCash(db, session, { type: 'TICKET_ISSUE', amountCents: input.amountCents, moneyTransactionId: r.transaction.id, ticketId: t.id, reference: t.barcode, playerId: input.playerId })
    : null;
  await ticketEvent(db, t, 'ISSUED', { employeeId: a.employeeId, details: { sessionId: session.id, payFrom, transactionId: r.transaction.id } });
  await auditTicket(db, a, session.casino_id, 'ticket.issued', t.id, { barcode: t.barcode, amountCents: input.amountCents, payFrom, transactionId: r.transaction.id });
  return { ticket: t, moneyTransaction: r.transaction, transaction: cashTx };
}

async function payoutLimit(db: Db, casinoId: string): Promise<number | null> {
  const v = (await db.query('SELECT ticket_payout_approval_cents FROM casino_money_settings WHERE casino_id = $1', [casinoId])).rows[0]?.ticket_payout_approval_cents;
  return v === null || v === undefined ? null : Number(v);
}

/**
 * Cashier pays a ticket: the row lock is the hold (no machine can commit it meanwhile), the booking
 * the redemption. Above ticket_payout_approval_cents an approved four-eyes request for this ticket is
 * needed, and the approver may not pay it.
 */
export async function redeemTicket(db: PoolClient, a: Actor, input: { barcode: string; payTo?: 'CASH' | 'WALLET'; playerId?: string | null; cardId?: string | null }) {
  if (!a.employeeId) throw new HttpError(400, 'An employee must pay');
  const payTo = input.payTo ?? 'CASH';
  const session = await requireOpenSession(db, a.orgId, a.employeeId);
  await requireTitoLedger(db, a.orgId, session.casino_id);
  const t = await lockTicketByBarcode(db, a.orgId, session.casino_id, input.barcode);
  assertPayable(t);
  let approval: { id: string; decided_by: string } | null = null;
  const limit = await payoutLimit(db, t.casino_id);
  if (limit !== null && t.amount_cents >= limit) {
    approval = (await db.query(
      `SELECT id, decided_by FROM approvals WHERE action = 'TITO_REDEEM_CASHIER' AND entity_id = $1 AND status = 'APPROVED' AND expires_at > now() ORDER BY decided_at DESC LIMIT 1 FOR UPDATE`, [t.id],
    )).rows[0] ?? null;
    if (!approval) throw new HttpError(409, 'Supervisor approval required for this ticket');
    if (approval.decided_by === a.employeeId) throw new HttpError(409, 'The approver cannot pay the same ticket');
  }
  const w = payTo === 'WALLET' ? await walletFor(db, a.orgId, input.playerId, 'DEPOSIT') : null;
  const r = await executeMoneyTransaction(db, {
    orgId: a.orgId, type: 'TITO_REDEEM_CASHIER', dedupeKey: entityDedupeKey('ticket', t.id, 'redeem'), actor: employeeActor(a), approvedBy: approval?.decided_by ?? null,
    ctx: { casinoId: t.casino_id, amountCents: cents(t.amount_cents), ticketId: t.id, cashierSessionId: session.id, payTo, walletId: w?.id, playerId: input.playerId ?? undefined, cardId: input.cardId ?? undefined },
  });
  if (r.replayed) throw new HttpError(409, 'Ticket already redeemed');
  const ticket = (await db.query(
    `UPDATE tickets SET status = 'REDEEMED', redeemed_at = now(), redeemed_by_employee = $2, redeemed_session_id = $3 WHERE id = $1 RETURNING *`,
    [t.id, a.employeeId, session.id],
  )).rows[0];
  const cashTx = payTo === 'CASH'
    ? await projectTicketCash(db, session, { type: 'TICKET_PAYOUT', amountCents: t.amount_cents, moneyTransactionId: r.transaction.id, ticketId: t.id, reference: t.barcode, playerId: input.playerId })
    : null;
  if (approval) await consumeApproval(db, a, approval.id, { action: 'TITO_REDEEM_CASHIER', entityId: t.id, moneyTransactionId: r.transaction.id });
  await ticketEvent(db, t, 'REDEEMED', { employeeId: a.employeeId, details: { sessionId: session.id, payTo, transactionId: r.transaction.id, approvalId: approval?.id ?? null } });
  await auditTicket(db, a, t.casino_id, 'ticket.redeemed', t.id, { barcode: t.barcode, amountCents: t.amount_cents, payTo, transactionId: r.transaction.id, approvalId: approval?.id ?? null });
  return { ticket, moneyTransaction: r.transaction, transaction: cashTx };
}

/**
 * Step 1 of a four-eyes ticket action: payout above the limit, cancellation, or void (printer failure
 * of a cashier sale). Nothing moves; an open request for the same ticket and action is returned.
 */
export async function requestTicketApproval(db: Db, a: Actor & { casinoIds?: string[] }, ticketId: string, action: TicketApprovalAction, reason?: string | null) {
  const t = await lockTicket(db, a, ticketId);
  await requireTitoLedger(db, a.orgId, t.casino_id);
  if (action === 'TITO_REDEEM_CASHIER') {
    assertPayable(t);
    const limit = await payoutLimit(db, t.casino_id);
    if (limit === null || t.amount_cents < limit) throw new HttpError(409, 'This ticket is below the payout approval limit');
  } else {
    if (!reason || reason.trim().length < 3) throw new HttpError(400, 'A reason is required');
    if (t.status !== 'VALID') throw new HttpError(409, `Ticket is ${t.status}`);
    if (action === 'TITO_VOID') await voidableSale(db, t);
  }
  const open = await db.query(`SELECT * FROM approvals WHERE action = $1 AND entity_id = $2 AND status IN ('PENDING', 'APPROVED') AND expires_at > now()`, [action, t.id]);
  if (open.rowCount) return open.rows[0];
  return requestApproval(db, a, { casinoId: t.casino_id, action, entityType: 'ticket', entityId: t.id, amountCents: t.amount_cents, payload: { barcode: t.barcode, reason: reason ?? null } });
}

/** The cashier sale a void reverses: only a ticket sold at a cashier, while that shift is still open. */
async function voidableSale(db: Db, t: TicketRow) {
  const sale = (await db.query(`SELECT * FROM money_transactions WHERE ticket_id = $1 AND type = 'TITO_ISSUE_CASHIER'`, [t.id])).rows[0];
  if (!sale) throw new HttpError(409, 'Only a ticket sold at a cashier can be voided; cancel a machine ticket instead');
  if (sale.cashier_session_id) {
    const s = (await db.query(`SELECT status FROM cashier_sessions WHERE id = $1`, [sale.cashier_session_id])).rows[0];
    if (sale.options?.payFrom !== 'WALLET' && s?.status !== 'OPEN') throw new HttpError(409, 'A void is only possible while the selling shift is open');
  }
  return sale;
}

/**
 * Step 2: a different employee decides. A payout approval is used by the payment; a cancellation or
 * void is executed now (TITO_CANCEL, or the REVERSAL of the sale), booked by the requester and
 * approved by the decider.
 */
export async function decideTicketApproval(db: PoolClient, a: Actor & { casinoIds?: string[] }, approvalId: string, decision: 'APPROVED' | 'REJECTED', note?: string) {
  const ap = await decideApproval(db, a, approvalId, decision, note);
  if (!['TITO_REDEEM_CASHIER', 'TITO_CANCEL', 'TITO_VOID'].includes(ap.action)) throw new HttpError(409, 'Not a ticket approval');
  if (decision === 'REJECTED' || ap.action === 'TITO_REDEEM_CASHIER') return { approval: ap, ticket: null };
  const t = await lockTicket(db, a, ap.entity_id);
  if (t.status !== 'VALID') throw new HttpError(409, `Ticket is ${t.status}`);
  const requester: MoneyActor = { type: 'EMPLOYEE', employeeId: ap.requested_by };
  const reason = ap.payload?.reason ?? 'ticket correction';
  let moneyTransactionId: string;
  let status: 'CANCELLED' | 'VOID';
  if (ap.action === 'TITO_CANCEL') {
    const r = await executeMoneyTransaction(db, {
      orgId: a.orgId, type: 'TITO_CANCEL', dedupeKey: entityDedupeKey('ticket', t.id, 'cancel'), actor: requester, approvedBy: a.employeeId, reason,
      ctx: { casinoId: t.casino_id, amountCents: cents(t.amount_cents), ticketId: t.id, machineId: t.issued_by_machine_id ?? undefined },
    });
    moneyTransactionId = r.transaction.id;
    status = 'CANCELLED';
  } else {
    const sale = await voidableSale(db, t);
    const r = await reverseMoneyTransaction(db, { orgId: a.orgId, transactionId: sale.id, dedupeKey: entityDedupeKey('ticket', t.id, 'void'), actor: requester, approvedBy: a.employeeId, reason });
    moneyTransactionId = r.transaction.id;
    status = 'VOID';
    if (sale.options?.payFrom !== 'WALLET') {
      const session = (await db.query('SELECT * FROM cashier_sessions WHERE id = $1', [sale.cashier_session_id])).rows[0] as SessionRow;
      await projectTicketVoid(db, session, { amountCents: t.amount_cents, moneyTransactionId, ticketId: t.id, reference: t.barcode });
    }
  }
  const ticket = (await db.query('UPDATE tickets SET status = $2, status_reason = $3 WHERE id = $1 RETURNING *', [t.id, status, reason])).rows[0];
  await consumeApproval(db, a, ap.id, { action: ap.action, entityId: t.id, moneyTransactionId });
  await ticketEvent(db, t, status === 'CANCELLED' ? 'CANCELLED' : 'VOIDED', { employeeId: a.employeeId, details: { reason, approvalId: ap.id, requestedBy: ap.requested_by, transactionId: moneyTransactionId } });
  await auditTicket(db, a, t.casino_id, status === 'CANCELLED' ? 'ticket.cancel' : 'ticket.void', t.id, { barcode: t.barcode, amountCents: t.amount_cents, reason, approvalId: ap.id, transactionId: moneyTransactionId });
  return { approval: ap, ticket };
}

// ---- background ------------------------------------------------------------------------------

/**
 * Expiry of VALID tickets past their expiry date on ledger casinos (TITO_EXPIRY). HELD tickets never
 * expire; a frozen TITO rail waits. Each ticket in its own savepoint; exactly once per ticket.
 */
export async function expireTicketsLedger(db: PoolClient, filter: { casinoId?: string } = {}) {
  const due = (await db.query(
    `SELECT t.* FROM tickets t
     WHERE t.status = 'VALID' AND t.expires_at <= now() AND ($1::uuid IS NULL OR t.casino_id = $1)
       AND money_rail_ledger(t.org_id, t.casino_id, 'TITO', NULL) AND NOT money_rail_frozen(t.org_id, t.casino_id, 'TITO', NULL)
     ORDER BY t.expires_at, t.id LIMIT 500 FOR UPDATE OF t SKIP LOCKED`,
    [filter.casinoId ?? null],
  )).rows as TicketRow[];
  const expired = [];
  for (const t of due) {
    await db.query('SAVEPOINT ticket_expiry');
    try {
      const r = await executeMoneyTransaction(db, {
        orgId: t.org_id, type: 'TITO_EXPIRY', dedupeKey: entityDedupeKey('ticket', t.id, 'expiry'), actor: { type: 'SYSTEM', name: 'ticket-expiry' },
        ctx: { casinoId: t.casino_id, amountCents: cents(t.amount_cents), ticketId: t.id },
      });
      await db.query(`UPDATE tickets SET status = 'EXPIRED', status_reason = 'Expiry date reached' WHERE id = $1`, [t.id]);
      await ticketEvent(db, t, 'EXPIRED', { details: { transactionId: r.transaction.id } });
      await db.query('RELEASE SAVEPOINT ticket_expiry');
      expired.push({ ticketId: t.id, moneyTransactionId: r.transaction.id });
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT ticket_expiry');
      console.error('[tito] expiry failed', t.id, err instanceof Error ? err.message : err);
    }
  }
  return expired;
}

// ---- D1 clearing -----------------------------------------------------------------------------

/**
 * Machines whose LEGACY_FLOOR_CLEARING balance is not fully attributable to their own ticket events:
 * an entry from anything but a ticket event of that machine (or a four-eyes correction / reversal),
 * or a balance left on a machine that is already on the ledger (target 0 after its cutover).
 */
export async function unexplainedFloorClearing(db: Db, scope: { orgId?: string; casinoId?: string }) {
  return (await db.query(
    `SELECT a.machine_id AS id, a.casino_id, b.balance_cents FROM ledger_accounts a JOIN ledger_balances b ON b.account_id = a.id
     WHERE a.kind = 'LEGACY_FLOOR_CLEARING' AND ($1::uuid IS NULL OR a.org_id = $1) AND ($2::uuid IS NULL OR a.casino_id = $2)
       AND ((b.balance_cents <> 0 AND money_rail_ledger(a.org_id, a.casino_id, 'MACHINE', a.machine_id))
         OR EXISTS (
           SELECT 1 FROM ledger_entries le JOIN money_transactions t ON t.id = le.transaction_id
           WHERE le.account_id = a.id AND NOT (
             (t.type IN ('TITO_ISSUE_MACHINE', 'TITO_REDEEM_MACHINE', 'TITO_EXCEPTION') AND t.machine_id = a.machine_id
               AND EXISTS (SELECT 1 FROM machine_events e WHERE e.event_id = t.source_event_id AND e.machine_id = a.machine_id
                             AND e.type = CASE t.type WHEN 'TITO_ISSUE_MACHINE' THEN 'TITO_OUT' ELSE 'TITO_IN' END))
             OR (t.type = 'ADJUSTMENT' AND t.approved_by IS NOT NULL)
             OR t.type = 'REVERSAL'
             -- 7d: the closing opening balance of the machine's own MACHINE cutover
             OR (t.type = 'OPENING_BALANCE' AND EXISTS (SELECT 1 FROM money_backfill_items i
                   WHERE i.money_transaction_id = t.id AND i.source_table = 'ledger_accounts' AND i.source_id = a.id::text)))))
     ORDER BY a.machine_id`,
    [scope.orgId ?? null, scope.casinoId ?? null],
  )).rows as Array<{ id: string; casino_id: string; balance_cents: number }>;
}
