import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction, writeAudit } from '@m1/database';
import { MACHINE_COMMANDS, deriveMachineStatus } from '@m1/shared';
import { HttpError, actor, guard, scopeCasino } from '../auth';
import { bus } from '../bus';
import { pool } from '../db';

const MACHINE_SELECT = `
  SELECT m.id, m.machine_code, m.asset_no, m.serial_number, m.game, m.denomination, m.position_label, m.pos_x, m.pos_y,
    m.status, m.error_code, m.door_open, m.cashbox_open, m.printer_error, m.disabled, m.maintenance, m.adapter_key,
    m.last_communication_at, m.last_error, m.last_error_at, m.floor_id, m.casino_id, m.gateway_id,
    f.name AS floor_name, z.name AS zone_name, mm.manufacturer, mm.name AS model,
    p.card_number AS player_card, p.first_name || ' ' || p.last_name AS player_name, p.tier AS player_tier,
    me.coin_in, me.coin_out, me.jackpot, me.games_played, me.games_won, me.jackpot_wins, me.tickets_in, me.tickets_out, me.cash_in, me.cash_out
  FROM machines m
  LEFT JOIN floors f ON f.id = m.floor_id
  LEFT JOIN zones z ON z.id = m.zone_id
  LEFT JOIN machine_models mm ON mm.id = m.model_id
  LEFT JOIN players p ON p.id = m.current_player_id
  LEFT JOIN machine_meters me ON me.machine_id = m.id`;

async function loadMachine(orgId: string, casinoIds: string[], id: string) {
  const r = await pool.query(`${MACHINE_SELECT} WHERE m.id = $1 AND m.org_id = $2 AND m.casino_id = ANY($3)`, [id, orgId, casinoIds]);
  if (!r.rowCount) throw new HttpError(404, 'Machine not found');
  return r.rows[0];
}

export async function machineRoutes(app: FastifyInstance) {
  app.get('/api/v1/machines', { preHandler: guard('machine.view') }, async (req) => {
    const qs = z.object({ casinoId: z.string().uuid().optional(), status: z.string().optional(), search: z.string().optional() }).parse(req.query);
    const casinoId = scopeCasino(req, qs.casinoId);
    const params: unknown[] = [req.auth.orgId, casinoId];
    let where = 'WHERE m.org_id = $1 AND m.casino_id = $2';
    if (qs.status) {
      params.push(qs.status);
      where += ` AND m.status = $${params.length}`;
    }
    if (qs.search) {
      params.push(`%${qs.search}%`);
      where += ` AND (m.asset_no ILIKE $${params.length} OR m.machine_code ILIKE $${params.length} OR m.game ILIKE $${params.length} OR mm.manufacturer ILIKE $${params.length})`;
    }
    return (await pool.query(`${MACHINE_SELECT} ${where} ORDER BY m.asset_no`, params)).rows;
  });

  app.get('/api/v1/machines/:id', { preHandler: guard('machine.view') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const machine = await loadMachine(req.auth.orgId, req.auth.casinoIds, id);
    const [events, session, today, commands] = await Promise.all([
      pool.query(`SELECT event_id, type, amount, win, payload, occurred_at FROM machine_events WHERE machine_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 50`, [id]),
      pool.query(`SELECT id, started_at, coin_in, games_played FROM player_sessions WHERE machine_id = $1 AND ended_at IS NULL LIMIT 1`, [id]),
      pool.query(
        `SELECT COALESCE(sum(amount) FILTER (WHERE type = 'WAGER'), 0) coin_in,
                COALESCE(sum(amount) FILTER (WHERE type = 'WIN'), 0) coin_out,
                COALESCE(sum(amount) FILTER (WHERE type = 'JACKPOT'), 0) jackpots
         FROM gaming_transactions t JOIN casinos c ON c.id = t.casino_id
         WHERE t.machine_id = $1 AND t.occurred_at >= (date_trunc('day', now() AT TIME ZONE c.timezone) AT TIME ZONE c.timezone)`,
        [id],
      ),
      pool.query(`SELECT id, type, status, result_message, created_at, completed_at FROM machine_commands WHERE machine_id = $1 ORDER BY created_at DESC LIMIT 10`, [id]),
    ]);
    return { ...machine, events: events.rows, session: session.rows[0] ?? null, today: today.rows[0], commands: commands.rows };
  });

  /** Remote command, delivered to the edge gateway on its next heartbeat. */
  app.post('/api/v1/machines/:id/commands', { preHandler: guard('machine.command') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { type } = z.object({ type: z.enum(MACHINE_COMMANDS) }).parse(req.body);
    const m = await loadMachine(req.auth.orgId, req.auth.casinoIds, id);
    if (!m.gateway_id) throw new HttpError(409, 'Machine has no gateway assigned');
    const r = await pool.query(
      `INSERT INTO machine_commands (org_id, machine_id, gateway_id, type, requested_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, status`,
      [req.auth.orgId, id, m.gateway_id, type, req.auth.sub],
    );
    await writeAudit(pool, { ...actor(req), casinoId: m.casino_id, action: 'machine.command', entityType: 'machine', entityId: id, details: { type, assetNo: m.asset_no } });
    return r.rows[0];
  });

  app.put('/api/v1/machines/:id/maintenance', { preHandler: guard('machine.configure') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { maintenance } = z.object({ maintenance: z.boolean() }).parse(req.body);
    const status = await withTransaction(pool, async (db) => {
      const r = await db.query('SELECT * FROM machines WHERE id = $1 AND org_id = $2 AND casino_id = ANY($3) FOR NO KEY UPDATE', [id, req.auth.orgId, req.auth.casinoIds]);
      const m = r.rows[0];
      if (!m) throw new HttpError(404, 'Machine not found');
      const s = deriveMachineStatus({
        online: m.online, disabled: m.disabled, maintenance, errorCode: m.error_code, doorOpen: m.door_open,
        cashboxOpen: m.cashbox_open, printerError: m.printer_error, jackpotPending: m.jackpot_pending,
      });
      await db.query('UPDATE machines SET maintenance = $2, status = $3, status_changed_at = now() WHERE id = $1', [id, maintenance, s]);
      await writeAudit(db, { ...actor(req), casinoId: m.casino_id, action: maintenance ? 'machine.maintenance_on' : 'machine.maintenance_off', entityType: 'machine', entityId: id, details: { assetNo: m.asset_no } });
      bus.publish({ kind: 'machine.status', orgId: req.auth.orgId, casinoId: m.casino_id, machineId: id, assetNo: m.asset_no, status: s });
      return s;
    });
    return { status };
  });
}
