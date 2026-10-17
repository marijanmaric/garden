import { writeAudit, type PoolClient } from '@m1/database';
import { cents } from '@m1/shared';
import { HttpError } from '../auth';
import type { BusMessage } from '../bus';
import { openAlert } from './alerts';
import { confirmTransfer, markTransferSent, type TransferRow } from './cashless';
import { recordEventException } from './event-exceptions';
import { eventDedupeKey, executeMoneyTransaction, getBalance, type LatePosting, type MoneyActor } from './ledger';
import { railOnLedger } from './rails';

/**
 * Step 7d: machine money of a machine on the MACHINE ledger, booked in the ingest transaction.
 *
 *   CASH_IN       MACHINE_CASH_IN     cashbox -> machine credit
 *   CASH_OUT      MACHINE_CASH_OUT    machine credit -> hopper (insufficient hopper = exception, never forced)
 *   CASHLESS_IN   ack of a wallet -> machine transfer: WALLET_TO_MACHINE_CONFIRM (reserved -> machine credit);
 *                 after FAILED / EXPIRED: WALLET_TO_MACHINE_LATE_CONFIRM (CASHLESS_EXCEPTION -> machine credit)
 *   CASHLESS_OUT  ack of a machine -> wallet transfer: MACHINE_TO_WALLET with the amount the machine released
 *   CREDIT_METER  D3 gaming settlement: only with a reliable credit meter or at a verified zero-credit state,
 *                 only when no later money event of the machine is booked; otherwise unreconciled (no booking)
 *
 * Exactly once: event id dedupe keys, transfer state + one confirmation per transfer. A frozen MACHINE
 * (or, for cashless acks, CASHLESS) rail and an event of another business date than today go through
 * deferred_money_events (rail MACHINE) exactly as jackpots and tickets: booked on the date of occurred_at
 * or kept pending; a closed date is never bypassed.
 */

type Db = Pick<PoolClient, 'query'>;

export interface MachineMoneyEvent {
  orgId: string;
  casinoId: string;
  machineId: string;
  label: string;
  eventId: string;
  type: 'CASH_IN' | 'CASH_OUT' | 'CASHLESS_IN' | 'CASHLESS_OUT';
  amountCents: number | null;
  transferId: string | null;
  occurredAt: string;
}

const GATEWAY: MoneyActor = { type: 'GATEWAY', name: 'machine' };
const SYSTEM_ACTOR = (orgId: string) => ({ orgId });

export const machineOnLedger = (db: Db, orgId: string, casinoId: string, machineId: string) => railOnLedger(db, orgId, 'MACHINE', casinoId, machineId);

async function machineFrozen(db: Db, ev: Pick<MachineMoneyEvent, 'orgId' | 'casinoId' | 'machineId' | 'type'>) {
  return (await db.query(
    `SELECT money_rail_frozen($1, $2, 'MACHINE', $3) OR ($4 AND money_rail_frozen($1, $2, 'CASHLESS', NULL)) AS f`,
    [ev.orgId, ev.casinoId, ev.machineId, ev.type === 'CASHLESS_IN' || ev.type === 'CASHLESS_OUT'],
  )).rows[0].f as boolean;
}

/** Entry point from ingestion for a machine on the MACHINE ledger. The machine event is already stored. */
export async function handleMachineMoneyEvent(db: PoolClient, ev: MachineMoneyEvent, out: BusMessage[]) {
  if (!ev.amountCents || ev.amountCents <= 0) {
    await recordEventException(db, ev, ev.type.startsWith('CASHLESS') ? 'CASHLESS' : 'MACHINE', 'NO_AMOUNT', 'money event without amount', out);
    return { outcome: 'EXCEPTION' };
  }
  const frozen = await machineFrozen(db, ev);
  const day: number = frozen ? 0 : (await db.query(
    `SELECT sign(($2::timestamptz AT TIME ZONE timezone)::date - (now() AT TIME ZONE timezone)::date)::int AS day FROM casinos WHERE id = $1`, [ev.casinoId, ev.occurredAt],
  )).rows[0].day;
  if (!frozen && day === 0) return processMachineEvent(db, ev, null, out);

  const r = await db.query(
    `INSERT INTO deferred_money_events (event_id, org_id, casino_id, machine_id, rail, kind, amount_cents, reason)
     VALUES ($1,$2,$3,$4,'MACHINE',$5,$6,$7) ON CONFLICT (event_id) DO NOTHING RETURNING *`,
    [ev.eventId, ev.orgId, ev.casinoId, ev.machineId, ev.type, ev.amountCents, frozen ? 'FROZEN' : day < 0 ? 'LATE_EVENT' : 'EARLY_EVENT'],
  );
  const d = r.rows[0];
  if (d)
    await writeAudit(db, {
      orgId: ev.orgId, casinoId: ev.casinoId, actorType: 'SYSTEM', actorId: null, actorName: 'machine',
      action: 'machine.event_deferred', entityType: 'machine_event', entityId: ev.eventId,
      details: { type: ev.type, machineId: ev.machineId, amountCents: ev.amountCents, reason: d.reason, occurredAt: d.occurred_at, receivedAt: d.received_at, businessDate: d.business_date },
    });
  if (frozen) {
    await openAlert(db, { orgId: ev.orgId, casinoId: ev.casinoId, machineId: ev.machineId, type: 'MACHINE_MONEY_DEFERRED', severity: 'WARNING', message: `${ev.label} ${ev.type} recorded; booking deferred while the machine is frozen` }, out);
    return { outcome: 'DEFERRED' };
  }
  const done = await replayDeferredMachine(db, { eventId: ev.eventId }, out);
  return { outcome: done.length ? 'LATE_BOOKED' : 'LATE_PENDING' };
}

/**
 * Books one machine money event. businessDate only for the replay of a deferred record (validated by the
 * ledger against the event). Throws HttpError for a business refusal (the caller records an exception).
 */
export async function processMachineEvent(db: PoolClient, ev: MachineMoneyEvent, businessDate: string | null, out: BusMessage[], late: LatePosting | null = null): Promise<{ outcome: string; moneyTransactionId: string | null }> {
  const base = { casinoId: ev.casinoId, machineId: ev.machineId, amountCents: cents(ev.amountCents!) };
  if (ev.type === 'CASH_IN' || ev.type === 'CASH_OUT') {
    const type = ev.type === 'CASH_IN' ? 'MACHINE_CASH_IN' as const : 'MACHINE_CASH_OUT' as const;
    const r = await executeMoneyTransaction(db, { orgId: ev.orgId, type, dedupeKey: eventDedupeKey(ev.eventId, type), sourceEventId: ev.eventId, actor: GATEWAY, businessDate, latePosting: late, ctx: base });
    return { outcome: type, moneyTransactionId: r.transaction.id };
  }
  // cashless acks: the transfer they confirm
  if (!ev.transferId) throw new HttpError(409, `${ev.type} without transfer id`);
  const t = (await db.query('SELECT * FROM wallet_transfers WHERE id = $1 AND org_id = $2', [ev.transferId, ev.orgId])).rows[0] as TransferRow | undefined;
  if (!t || t.machine_id !== ev.machineId) throw new HttpError(409, `${ev.type} for an unknown transfer of this machine`);
  if ((t.direction === 'TO_MACHINE') !== (ev.type === 'CASHLESS_IN')) throw new HttpError(409, `${ev.type} does not match the transfer direction ${t.direction}`);
  // the machine's ack proves the delivery: a transfer whose "sent" report was lost is SENT now (no money)
  if (t.status === 'REQUESTED') await markTransferSent(db, SYSTEM_ACTOR(ev.orgId), t.id);
  const r = await confirmTransfer(db, SYSTEM_ACTOR(ev.orgId), { transferId: t.id, ackEventId: ev.eventId, confirmedAmountCents: ev.amountCents!, businessDate, latePosting: late });
  if (r.late)
    await openAlert(db, { orgId: ev.orgId, casinoId: ev.casinoId, machineId: ev.machineId, type: 'CASHLESS_LATE_CONFIRM', severity: 'CRITICAL', message: `${ev.label} confirmed transfer ${t.id} after it was ${t.status}: booked as exception` }, out);
  return { outcome: r.late ? 'LATE_CONFIRMED' : 'CONFIRMED', moneyTransactionId: r.moneyTransactionId };
}

/**
 * Replays deferred machine money events (rail MACHINE) whose machine (and, for cashless acks, CASHLESS)
 * is no longer frozen: exactly once, on the business date of occurred_at, each in its own savepoint. A
 * record that cannot be booked stays PENDING with last_error (closed date: never bypassed).
 */
export async function replayDeferredMachine(db: PoolClient, filter: { orgId?: string; casinoId?: string; eventId?: string } = {}, out: BusMessage[] = []) {
  const due = (await db.query(
    `SELECT d.*, d.business_date::text AS business_date, e.payload, m.asset_no FROM deferred_money_events d
     JOIN machine_events e ON e.event_id = d.event_id JOIN machines m ON m.id = d.machine_id
     WHERE d.status = 'PENDING' AND d.rail = 'MACHINE' AND ($1::uuid IS NULL OR d.org_id = $1) AND ($2::uuid IS NULL OR d.casino_id = $2) AND ($3::uuid IS NULL OR d.event_id = $3)
       AND NOT money_rail_frozen(d.org_id, d.casino_id, 'MACHINE', d.machine_id)
       AND NOT (d.kind IN ('CASHLESS_IN', 'CASHLESS_OUT') AND money_rail_frozen(d.org_id, d.casino_id, 'CASHLESS', NULL))
       AND NOT (d.last_error IS NOT NULL AND EXISTS (SELECT 1 FROM business_day_closes b WHERE b.casino_id = d.casino_id AND b.business_date = d.business_date))
     ORDER BY d.occurred_at, d.event_id FOR UPDATE OF d SKIP LOCKED`,
    [filter.orgId ?? null, filter.casinoId ?? null, filter.eventId ?? null],
  )).rows;
  const done = [];
  for (const d of due) {
    const ev = deferredToEvent(d);
    await db.query('SAVEPOINT deferred_machine');
    try {
      const r = await processMachineEvent(db, ev, d.business_date, out);
      await markProcessed(db, d, r.moneyTransactionId, 'machine.event_replayed', r.outcome);
      await db.query('RELEASE SAVEPOINT deferred_machine');
      done.push({ eventId: d.event_id as string, outcome: r.outcome, moneyTransactionId: r.moneyTransactionId });
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT deferred_machine');
      const message = err instanceof Error ? err.message : String(err);
      await db.query('UPDATE deferred_money_events SET attempts = attempts + 1, last_error = $2 WHERE event_id = $1', [d.event_id, message]);
      await writeAudit(db, {
        orgId: d.org_id, casinoId: d.casino_id, actorType: 'SYSTEM', actorId: null, actorName: 'machine',
        action: 'machine.event_replay_failed', entityType: 'machine_event', entityId: d.event_id, details: { type: d.kind, businessDate: d.business_date, error: message, attempts: d.attempts + 1 },
      });
    }
  }
  return done;
}

export function deferredToEvent(d: Record<string, any>): MachineMoneyEvent {
  return {
    orgId: d.org_id, casinoId: d.casino_id, machineId: d.machine_id, label: d.asset_no, eventId: d.event_id, type: d.kind,
    amountCents: Number(d.amount_cents), transferId: d.payload?.transferId ?? null, occurredAt: d.occurred_at,
  };
}

async function markProcessed(db: Db, d: Record<string, any>, moneyTransactionId: string | null, action: string, outcome: string) {
  await db.query(
    `UPDATE deferred_money_events SET status = 'PROCESSED', replayed_at = now(), money_transaction_id = $2, attempts = attempts + 1, last_error = NULL WHERE event_id = $1`,
    [d.event_id, moneyTransactionId],
  );
  await writeAudit(db as PoolClient, {
    orgId: d.org_id, casinoId: d.casino_id, actorType: 'SYSTEM', actorId: null, actorName: 'machine', action, entityType: 'machine_event', entityId: d.event_id,
    details: { type: d.kind, outcome, moneyTransactionId, businessDate: d.business_date, occurredAt: d.occurred_at, reason: d.reason, attempts: d.attempts + 1 },
  });
}

// ---- D3 gaming settlement --------------------------------------------------------------------

/**
 * A credit meter report. Settles MACHINE_CREDIT against the reported credit (GAMING_SETTLEMENT, signed)
 * only if the machine's credit meter is reliable or the report is a verified zero-credit state, the
 * machine is on the ledger and not frozen, the report is from today, and no later money event of the
 * machine is already booked. Otherwise nothing is booked (unreconciled, audited). Never estimated.
 */
export async function handleCreditMeter(db: PoolClient, ev: { orgId: string; casinoId: string; machineId: string; label: string; eventId: string; creditCents: number | null; occurredAt: string }, out: BusMessage[] = []) {
  const skip = async (reason: string) => {
    await writeAudit(db, {
      orgId: ev.orgId, casinoId: ev.casinoId, actorType: 'SYSTEM', actorId: null, actorName: 'machine', action: 'machine.settlement_skipped',
      entityType: 'machine_event', entityId: ev.eventId, details: { machineId: ev.machineId, creditCents: ev.creditCents, reason },
    });
    return { outcome: 'UNRECONCILED', reason, moneyTransactionId: null as string | null };
  };
  if (ev.creditCents === null || !Number.isInteger(ev.creditCents) || ev.creditCents < 0) return skip('no valid credit meter value');
  // A meter report from the future means the machine clock is wrong: no settlement, a recorded exception
  // (durable, audited, alerted; reconciliation freezes only this machine until two people explain it). A
  // meter is a measurement, never replayed later: the next valid report settles the machine credit in full.
  const ahead = (await db.query(
    `SELECT $2::timestamptz > now() + interval '5 minutes' OR ($2::timestamptz AT TIME ZONE timezone)::date > (now() AT TIME ZONE timezone)::date AS ahead FROM casinos WHERE id = $1`,
    [ev.casinoId, ev.occurredAt])).rows[0].ahead;
  if (ahead) {
    await recordEventException(db, { ...ev, type: 'CREDIT_METER' }, 'MACHINE', 'CLOCK_AHEAD', `credit meter report dated ${ev.occurredAt} is in the future: not settled`, out);
    return { outcome: 'EXCEPTION', reason: 'clock ahead', moneyTransactionId: null as string | null };
  }
  const m = (await db.query(
    `SELECT m.credit_meter_reliable, money_rail_frozen(m.org_id, m.casino_id, 'MACHINE', m.id) AS frozen,
       ($2::timestamptz AT TIME ZONE c.timezone)::date = (now() AT TIME ZONE c.timezone)::date AS today,
       EXISTS (SELECT 1 FROM money_transactions t JOIN machine_events e ON e.event_id = t.source_event_id
               WHERE t.machine_id = m.id AND e.occurred_at > $2::timestamptz) AS later_booked,
       EXISTS (SELECT 1 FROM deferred_money_events d WHERE d.machine_id = m.id AND d.status = 'PENDING') AS pending
     FROM machines m JOIN casinos c ON c.id = m.casino_id WHERE m.id = $1`, [ev.machineId, ev.occurredAt])).rows[0];
  if (!m.credit_meter_reliable && ev.creditCents !== 0) return skip('credit meter not reliable and not a zero-credit state');
  if (m.frozen) return skip('machine frozen');
  if (!m.today) return skip('meter report of another business date');
  if (m.later_booked || m.pending) return skip('later or pending money events of the machine');
  const ledgerCredit = await getBalance(db, ev.orgId, { kind: 'MACHINE_CREDIT', casinoId: ev.casinoId, machineId: ev.machineId });
  const result = ledgerCredit - ev.creditCents; // positive: players lost it, negative: players won it
  if (result === 0) return { outcome: 'SETTLED_ZERO', reason: null, moneyTransactionId: null };
  const r = await executeMoneyTransaction(db, {
    orgId: ev.orgId, type: 'GAMING_SETTLEMENT', dedupeKey: eventDedupeKey(ev.eventId, 'GAMING_SETTLEMENT'), sourceEventId: ev.eventId, actor: GATEWAY,
    reason: `Credit meter ${ev.creditCents} cents vs. ledger ${ledgerCredit} cents`,
    ctx: { casinoId: ev.casinoId, machineId: ev.machineId, amountCents: cents(result) },
  });
  return { outcome: 'SETTLED', reason: null, moneyTransactionId: r.transaction.id };
}
