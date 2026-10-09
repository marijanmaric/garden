import { withTransaction, writeAudit, type PoolClient } from '@m1/database';
import { deriveMachineStatus, type MachineEvent, type MachineFlags, type MachineStatus } from '@m1/shared';
import { bus, type BusMessage } from '../bus';
import { pool } from '../db';
import { openAlert, resolveAlerts } from './alerts';

export interface GatewayIdentity {
  id: string;
  orgId: string;
  casinoId: string;
  deviceId: string;
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: string[];
}

/** Maps a financial event onto the ledger entry type it produces. */
const LEDGER_MAP: Partial<Record<MachineEvent['type'], string>> = {
  COIN_IN: 'CASH_IN',
  COIN_OUT: 'CASH_OUT',
  TICKET_IN: 'TICKET_IN',
  TICKET_OUT: 'TICKET_OUT',
  JACKPOT: 'JACKPOT',
};

const METER_MAP: Partial<Record<MachineEvent['type'], string>> = {
  COIN_IN: 'cash_in',
  COIN_OUT: 'cash_out',
  TICKET_IN: 'tickets_in',
  TICKET_OUT: 'tickets_out',
};

/**
 * Ingests a batch of events from an edge gateway. Each event is processed in its own
 * transaction and is idempotent on eventId, so a gateway can safely resend its offline queue.
 */
export async function ingestEvents(gw: GatewayIdentity, events: MachineEvent[]): Promise<IngestResult> {
  const result: IngestResult = { accepted: 0, duplicates: 0, rejected: [] };
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const ev of sorted) {
    const out: BusMessage[] = [];
    const outcome = await withTransaction(pool, (db) => processEvent(db, gw, ev, out));
    if (outcome === 'accepted') {
      result.accepted++;
      out.forEach((m) => bus.publish(m));
    } else if (outcome === 'duplicate') result.duplicates++;
    else result.rejected.push(ev.eventId);
  }
  if (result.rejected.length) {
    await writeAudit(pool, {
      orgId: gw.orgId, casinoId: gw.casinoId, actorType: 'GATEWAY', actorName: gw.deviceId,
      action: 'events.rejected', entityType: 'gateway', entityId: gw.id,
      details: { reason: 'unknown machine', eventIds: result.rejected.slice(0, 50), count: result.rejected.length },
    });
  }
  return result;
}

type Outcome = 'accepted' | 'duplicate' | 'rejected';

async function processEvent(db: PoolClient, gw: GatewayIdentity, ev: MachineEvent, out: BusMessage[]): Promise<Outcome> {
  const mRes = await db.query(
    `SELECT * FROM machines WHERE org_id = $1 AND casino_id = $2 AND machine_code = $3 FOR NO KEY UPDATE`,
    [gw.orgId, gw.casinoId, ev.machineId],
  );
  const m = mRes.rows[0];
  if (!m) return 'rejected';

  const { eventId, type, machineId: _code, timestamp, amount, win, ...rest } = ev;
  const ins = await db.query(
    `INSERT INTO machine_events (event_id, org_id, casino_id, machine_id, gateway_id, type, amount, win, payload, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (event_id) DO NOTHING RETURNING id`,
    [eventId, gw.orgId, gw.casinoId, m.id, gw.id, type, amount ?? null, win ?? null, rest, timestamp],
  );
  if (!ins.rowCount) return 'duplicate';

  const ctx = { orgId: gw.orgId, casinoId: gw.casinoId, machineId: m.id };
  const label = m.asset_no as string;
  const ts = new Date(timestamp);
  // Out-of-order events (e.g. replayed offline queue) must not overwrite a newer state.
  const isNewer = !m.status_changed_at || ts >= new Date(m.status_changed_at);

  const flags: MachineFlags = {
    online: m.online,
    disabled: m.disabled,
    maintenance: m.maintenance,
    errorCode: m.error_code,
    doorOpen: m.door_open,
    cashboxOpen: m.cashbox_open,
    printerError: m.printer_error,
    jackpotPending: m.jackpot_pending,
  };
  let lastError: string | null = null;

  const ledger = async (ledgerType: string, value: number) =>
    db.query(
      `INSERT INTO gaming_transactions (org_id, casino_id, machine_id, player_id, type, amount, source_event_id, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [gw.orgId, gw.casinoId, m.id, m.current_player_id, ledgerType, value, eventId, timestamp],
    );

  // Any event proves the machine communicates.
  if (isNewer && type !== 'MACHINE_OFFLINE' && !flags.online) {
    flags.online = true;
    await resolveAlerts(db, { ...ctx, type: 'MACHINE_OFFLINE' }, out);
  }

  switch (type) {
    case 'GAME_PLAYED': {
      const bet = amount ?? 0;
      const won = win ?? 0;
      await ledger('WAGER', bet);
      if (won > 0) await ledger('WIN', won);
      await db.query(
        `UPDATE machine_meters SET coin_in = coin_in + $2, coin_out = coin_out + $3, games_played = games_played + 1,
           games_won = games_won + $4, updated_at = now() WHERE machine_id = $1`,
        [m.id, bet, won, won > 0 ? 1 : 0],
      );
      if (m.current_session_id) {
        await db.query('UPDATE player_sessions SET coin_in = coin_in + $2, games_played = games_played + 1 WHERE id = $1', [m.current_session_id, bet]);
        // Basic loyalty rule for the MVP: EUR 1 Coin In = 1 point (configurable rules follow in Phase 3).
        await db.query('UPDATE players SET total_coin_in = total_coin_in + $2, points = points + $2 WHERE id = $1', [m.current_player_id, bet]);
      }
      // Progressive contribution (jackpot engine with triggering follows in Phase 4).
      await db.query(
        `UPDATE jackpots SET current_value = LEAST(COALESCE(max_value, 1e12), current_value + $2 * contribution_rate)
         WHERE casino_id = $1 AND org_id = $3 AND status = 'ACTIVE' AND type <> 'LOCAL'`,
        [gw.casinoId, bet, gw.orgId],
      );
      if (isNewer) flags.jackpotPending = false;
      break;
    }
    case 'COIN_IN':
    case 'COIN_OUT':
    case 'TICKET_IN':
    case 'TICKET_OUT': {
      await ledger(LEDGER_MAP[type]!, amount ?? 0);
      await db.query(`UPDATE machine_meters SET ${METER_MAP[type]} = ${METER_MAP[type]} + $2, updated_at = now() WHERE machine_id = $1`, [m.id, amount ?? 0]);
      if (type === 'TICKET_OUT' && ev.ticketBarcode && (amount ?? 0) > 0) await issueMachineTicket(db, ctx, ev);
      if (type === 'TICKET_IN' && ev.ticketBarcode) await redeemMachineTicket(db, ctx, ev, label, out);
      break;
    }
    case 'JACKPOT': {
      await ledger('JACKPOT', amount ?? 0);
      await db.query('UPDATE machine_meters SET jackpot = jackpot + $2, jackpot_wins = jackpot_wins + 1, updated_at = now() WHERE machine_id = $1', [m.id, amount ?? 0]);
      if (isNewer) flags.jackpotPending = true;
      await openAlert(db, { ...ctx, type: 'JACKPOT', severity: 'INFO', message: `Jackpot €${(amount ?? 0).toFixed(2)} on ${label}, handpay required` }, out);
      break;
    }
    case 'JACKPOT_RESET':
      if (isNewer) flags.jackpotPending = false;
      await resolveAlerts(db, { ...ctx, type: 'JACKPOT' }, out);
      break;
    case 'MACHINE_ERROR':
      if (isNewer) flags.errorCode = ev.errorCode ?? 'UNKNOWN';
      lastError = ev.errorCode ?? ev.message ?? 'UNKNOWN';
      await openAlert(db, { ...ctx, type: 'MACHINE_ERROR', severity: 'CRITICAL', message: `${label} error ${lastError}` }, out);
      break;
    case 'MACHINE_ERROR_CLEARED':
      if (isNewer) flags.errorCode = null;
      await resolveAlerts(db, { ...ctx, type: 'MACHINE_ERROR' }, out);
      break;
    case 'MACHINE_DOOR_OPEN':
      if (isNewer) flags.doorOpen = true;
      await openAlert(db, { ...ctx, type: 'DOOR_OPEN', severity: 'WARNING', message: `${label} main door open` }, out);
      break;
    case 'MACHINE_DOOR_CLOSED':
      if (isNewer) flags.doorOpen = false;
      await resolveAlerts(db, { ...ctx, type: 'DOOR_OPEN' }, out);
      break;
    case 'CASHBOX_OPEN':
      if (isNewer) flags.cashboxOpen = true;
      await openAlert(db, { ...ctx, type: 'CASHBOX_OPEN', severity: 'WARNING', message: `${label} cashbox open` }, out);
      break;
    case 'CASHBOX_CLOSED':
      if (isNewer) flags.cashboxOpen = false;
      await resolveAlerts(db, { ...ctx, type: 'CASHBOX_OPEN' }, out);
      break;
    case 'PRINTER_ERROR':
      if (isNewer) flags.printerError = true;
      await openAlert(db, { ...ctx, type: 'TICKET_PRINTER_ERROR', severity: 'WARNING', message: `${label} ticket printer error ${ev.errorCode ?? ''}`.trim() }, out);
      break;
    case 'PRINTER_OK':
      if (isNewer) flags.printerError = false;
      await resolveAlerts(db, { ...ctx, type: 'TICKET_PRINTER_ERROR' }, out);
      break;
    case 'MACHINE_OFFLINE':
      if (isNewer) {
        flags.online = false;
        await endSession(db, m);
        m.current_player_id = null;
        m.current_session_id = null;
      }
      await openAlert(db, { ...ctx, type: 'MACHINE_OFFLINE', severity: 'CRITICAL', message: `Machine ${label} offline` }, out);
      break;
    case 'MACHINE_ONLINE':
      break; // handled by the generic "any event proves communication" rule above
    case 'MACHINE_DISABLED':
      if (isNewer) flags.disabled = true;
      break;
    case 'MACHINE_ENABLED':
      if (isNewer) flags.disabled = false;
      break;
    case 'PLAYER_LOGIN': {
      const p = await db.query('SELECT id FROM players WHERE org_id = $1 AND card_number = $2', [gw.orgId, ev.playerCardId]);
      if (p.rowCount && isNewer) {
        await endSession(db, m);
        const s = await db.query(
          `INSERT INTO player_sessions (org_id, casino_id, player_id, machine_id, started_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [gw.orgId, gw.casinoId, p.rows[0].id, m.id, timestamp],
        );
        await db.query('UPDATE players SET visits = visits + 1, last_visit_at = $2 WHERE id = $1', [p.rows[0].id, timestamp]);
        m.current_player_id = p.rows[0].id;
        m.current_session_id = s.rows[0].id;
      }
      break;
    }
    case 'PLAYER_LOGOUT':
      if (isNewer) {
        await endSession(db, m, timestamp);
        m.current_player_id = null;
        m.current_session_id = null;
      }
      break;
  }

  const status: MachineStatus = deriveMachineStatus(flags);
  await db.query(
    `UPDATE machines SET online = $2, disabled = $3, error_code = $4, door_open = $5, cashbox_open = $6, printer_error = $7,
       jackpot_pending = $8, status = $9, current_player_id = $10, current_session_id = $11,
       last_communication_at = GREATEST(last_communication_at, $12::timestamptz),
       status_changed_at = CASE WHEN $13 THEN $12::timestamptz ELSE status_changed_at END,
       last_error = COALESCE($14, last_error), last_error_at = CASE WHEN $14::text IS NULL THEN last_error_at ELSE $12::timestamptz END
     WHERE id = $1`,
    [m.id, flags.online, flags.disabled, flags.errorCode, flags.doorOpen, flags.cashboxOpen, flags.printerError,
      flags.jackpotPending, status, m.current_player_id, m.current_session_id, timestamp, isNewer && status !== m.status, lastError],
  );

  out.unshift({
    kind: 'machine.event',
    orgId: gw.orgId,
    casinoId: gw.casinoId,
    event: { ...ev, assetNo: label, status },
  });
  if (status !== m.status)
    out.push({ kind: 'machine.status', orgId: gw.orgId, casinoId: gw.casinoId, machineId: m.id, assetNo: label, status });
  return 'accepted';
}

/** A machine printed a ticket: it becomes a VALID ticket in the TITO system. */
async function issueMachineTicket(db: PoolClient, ctx: { orgId: string; casinoId: string; machineId: string }, ev: MachineEvent) {
  const t = await db.query(
    `INSERT INTO tickets (org_id, casino_id, barcode, amount, issued_by_machine_id, issued_at, expires_at, source_event_id)
     SELECT $1, $2, $3, $4, $5, $6, $6::timestamptz + make_interval(days => c.ticket_expiry_days), $7 FROM casinos c WHERE c.id = $2
     ON CONFLICT (org_id, barcode) DO NOTHING RETURNING id`,
    [ctx.orgId, ctx.casinoId, ev.ticketBarcode, ev.amount, ctx.machineId, ev.timestamp, ev.eventId],
  );
  if (t.rowCount)
    await db.query(`INSERT INTO ticket_events (org_id, ticket_id, action, machine_id, created_at) VALUES ($1,$2,'ISSUED',$3,$4)`, [ctx.orgId, t.rows[0].id, ctx.machineId, ev.timestamp]);
}

/**
 * A machine accepted a ticket. In production the machine asks the system before accepting;
 * a ticket that is not VALID here therefore indicates fraud or a sync problem and raises an alert.
 */
async function redeemMachineTicket(db: PoolClient, ctx: { orgId: string; casinoId: string; machineId: string }, ev: MachineEvent, label: string, out: BusMessage[]) {
  const r = await db.query(
    `UPDATE tickets SET status = 'REDEEMED', redeemed_at = $3, redeemed_machine_id = $4
     WHERE org_id = $1 AND barcode = $2 AND status = 'VALID' RETURNING id`,
    [ctx.orgId, ev.ticketBarcode, ev.timestamp, ctx.machineId],
  );
  if (r.rowCount) {
    await db.query(`INSERT INTO ticket_events (org_id, ticket_id, action, machine_id, created_at) VALUES ($1,$2,'REDEEMED',$3,$4)`, [ctx.orgId, r.rows[0].id, ctx.machineId, ev.timestamp]);
    return;
  }
  const existing = await db.query('SELECT id, status FROM tickets WHERE org_id = $1 AND barcode = $2', [ctx.orgId, ev.ticketBarcode]);
  const t = existing.rows[0];
  if (t) await db.query(`INSERT INTO ticket_events (org_id, ticket_id, action, machine_id, details) VALUES ($1,$2,'REJECTED',$3,$4)`, [ctx.orgId, t.id, ctx.machineId, { status: t.status }]);
  await openAlert(db, {
    ...ctx, type: 'TICKET_REJECTED', severity: 'CRITICAL',
    message: t ? `${label} accepted ticket ${ev.ticketBarcode} that is already ${t.status}` : `${label} accepted unknown ticket ${ev.ticketBarcode}`,
  }, out);
}

async function endSession(db: PoolClient, m: { current_session_id: string | null }, at?: string) {
  if (!m.current_session_id) return;
  await db.query('UPDATE player_sessions SET ended_at = COALESCE($2::timestamptz, now()) WHERE id = $1 AND ended_at IS NULL', [m.current_session_id, at ?? null]);
}
