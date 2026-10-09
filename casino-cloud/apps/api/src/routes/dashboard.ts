import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { computeGgr, round2 } from '@m1/shared';
import { guard, scopeCasino } from '../auth';
import { pool } from '../db';

const q = z.object({ casinoId: z.string().uuid().optional() });

/** Start of the current business day in the casino's timezone. */
const TODAY = `(date_trunc('day', now() AT TIME ZONE c.timezone) AT TIME ZONE c.timezone)`;

export async function financialSummary(orgId: string, casinoId: string, fromSql: string, params: unknown[] = []) {
  const r = await pool.query(
    `SELECT
       COALESCE(sum(t.amount) FILTER (WHERE t.type = 'WAGER'), 0) coin_in,
       COALESCE(sum(t.amount) FILTER (WHERE t.type = 'WIN'), 0) coin_out,
       COALESCE(sum(t.amount) FILTER (WHERE t.type = 'JACKPOT'), 0) jackpots,
       COALESCE(sum(t.amount) FILTER (WHERE t.type = 'TICKET_IN'), 0) tickets_in,
       COALESCE(sum(t.amount) FILTER (WHERE t.type = 'TICKET_OUT'), 0) tickets_out,
       COALESCE(sum(t.amount) FILTER (WHERE t.type = 'CASH_IN'), 0) cash_in,
       COALESCE(sum(t.amount) FILTER (WHERE t.type = 'CASH_OUT'), 0) cash_out,
       COALESCE(sum(t.amount) FILTER (WHERE t.type = 'ADJUSTMENT'), 0) adjustments,
       count(*) FILTER (WHERE t.type = 'WAGER') wagers
     FROM gaming_transactions t JOIN casinos c ON c.id = t.casino_id
     WHERE t.org_id = $1 AND t.casino_id = $2 AND t.occurred_at >= ${fromSql}`,
    [orgId, casinoId, ...params],
  );
  const s = r.rows[0];
  const ggr = computeGgr(s.coin_in, s.coin_out, s.jackpots);
  return {
    coinIn: s.coin_in, coinOut: s.coin_out, jackpots: s.jackpots, ggr, ngr: round2(ggr + s.adjustments),
    ticketsIn: s.tickets_in, ticketsOut: s.tickets_out, cashIn: s.cash_in, cashOut: s.cash_out,
    adjustments: s.adjustments, gamesPlayed: s.wagers,
  };
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/api/v1/dashboard', { preHandler: guard('dashboard.view') }, async (req) => {
    const casinoId = scopeCasino(req, q.parse(req.query).casinoId);
    const org = req.auth.orgId;
    const [machines, financial, players, jackpots, alerts, hourly, topMachines, topPlayers, recent, gateways, cashier, tickets] = await Promise.all([
      pool.query(
        `SELECT count(*) total,
           count(*) FILTER (WHERE status NOT IN ('OFFLINE','MAINTENANCE')) online,
           count(*) FILTER (WHERE status = 'OFFLINE') offline,
           count(*) FILTER (WHERE status = 'MAINTENANCE') maintenance,
           count(*) FILTER (WHERE status = 'WARNING') warning,
           count(*) FILTER (WHERE status = 'ERROR') error,
           count(*) FILTER (WHERE status = 'DISABLED') disabled,
           count(*) FILTER (WHERE status = 'JACKPOT') jackpot
         FROM machines WHERE org_id = $1 AND casino_id = $2`,
        [org, casinoId],
      ),
      financialSummary(org, casinoId, TODAY),
      pool.query(
        `SELECT
           (SELECT count(*) FROM player_sessions s WHERE s.org_id = $1 AND s.casino_id = $2 AND s.ended_at IS NULL) sessions,
           (SELECT count(DISTINCT s.player_id) FROM player_sessions s JOIN casinos c ON c.id = s.casino_id
              WHERE s.org_id = $1 AND s.casino_id = $2 AND s.started_at >= ${TODAY}) players_today,
           (SELECT COALESCE(floor(sum(points)), 0) FROM players WHERE org_id = $1) points,
           (SELECT count(*) FROM players WHERE org_id = $1) registered`,
        [org, casinoId],
      ),
      pool.query(`SELECT id, name, type, current_value, max_value FROM jackpots WHERE org_id = $1 AND casino_id = $2 AND status = 'ACTIVE' ORDER BY current_value DESC`, [org, casinoId]),
      pool.query(
        `SELECT a.id, a.type, a.severity, a.message, a.status, a.created_at, m.asset_no
         FROM alerts a LEFT JOIN machines m ON m.id = a.machine_id
         WHERE a.org_id = $1 AND a.casino_id = $2 AND a.status <> 'RESOLVED' ORDER BY a.created_at DESC LIMIT 50`,
        [org, casinoId],
      ),
      pool.query(
        `SELECT h.ts AS hour,
           COALESCE(sum(t.amount) FILTER (WHERE t.type = 'WAGER'), 0) coin_in,
           COALESCE(sum(t.amount) FILTER (WHERE t.type = 'WAGER'), 0) - COALESCE(sum(t.amount) FILTER (WHERE t.type IN ('WIN','JACKPOT')), 0) ggr
         FROM generate_series(date_trunc('hour', now()) - interval '23 hours', date_trunc('hour', now()), interval '1 hour') h(ts)
         LEFT JOIN gaming_transactions t ON t.org_id = $1 AND t.casino_id = $2 AND t.occurred_at >= h.ts AND t.occurred_at < h.ts + interval '1 hour'
         GROUP BY h.ts ORDER BY h.ts`,
        [org, casinoId],
      ),
      pool.query(
        `SELECT m.id, m.asset_no, m.game, mm.manufacturer, m.status,
           COALESCE(sum(t.amount) FILTER (WHERE t.type = 'WAGER'), 0) coin_in,
           COALESCE(sum(t.amount) FILTER (WHERE t.type = 'WAGER'), 0) - COALESCE(sum(t.amount) FILTER (WHERE t.type IN ('WIN','JACKPOT')), 0) ggr
         FROM machines m JOIN casinos c ON c.id = m.casino_id LEFT JOIN machine_models mm ON mm.id = m.model_id
         LEFT JOIN gaming_transactions t ON t.machine_id = m.id AND t.occurred_at >= ${TODAY}
         WHERE m.org_id = $1 AND m.casino_id = $2 GROUP BY m.id, mm.manufacturer ORDER BY coin_in DESC LIMIT 5`,
        [org, casinoId],
      ),
      pool.query(`SELECT id, card_number, first_name, last_name, tier, floor(points) points, total_coin_in FROM players WHERE org_id = $1 ORDER BY total_coin_in DESC LIMIT 5`, [org]),
      pool.query(
        `SELECT t.id, t.type, t.amount, t.occurred_at, m.asset_no FROM gaming_transactions t LEFT JOIN machines m ON m.id = t.machine_id
         WHERE t.org_id = $1 AND t.casino_id = $2 AND t.type <> 'WAGER' ORDER BY t.id DESC LIMIT 10`,
        [org, casinoId],
      ),
      pool.query(`SELECT id, device_id, name, status, last_heartbeat_at FROM gateways WHERE org_id = $1 AND casino_id = $2`, [org, casinoId]),
      pool.query(
        `SELECT d.name AS desk, d.kind, e.name AS employee, s.opened_at,
           s.opening_balance + COALESCE((SELECT sum(amount) FROM cash_transactions ct WHERE ct.session_id = s.id), 0) AS balance
         FROM cashier_sessions s JOIN cash_desks d ON d.id = s.cash_desk_id JOIN employees e ON e.id = s.employee_id
         WHERE s.org_id = $1 AND s.casino_id = $2 AND s.status = 'OPEN' ORDER BY d.name`,
        [org, casinoId],
      ),
      pool.query(`SELECT count(*) n, COALESCE(sum(amount), 0) liability FROM tickets WHERE org_id = $1 AND casino_id = $2 AND status = 'VALID'`, [org, casinoId]),
    ]);
    const jp = jackpots.rows;
    return {
      machines: machines.rows[0],
      financial,
      players: {
        activeSessions: players.rows[0].sessions,
        playersToday: players.rows[0].players_today,
        loyaltyPoints: players.rows[0].points,
        registered: players.rows[0].registered,
      },
      jackpots: { active: jp.length, totalValue: round2(jp.reduce((s, j) => s + j.current_value, 0)), items: jp },
      alerts: alerts.rows,
      hourly: hourly.rows,
      topMachines: topMachines.rows,
      topPlayers: topPlayers.rows,
      recentTransactions: recent.rows,
      gateways: gateways.rows,
      cashier: cashier.rows,
      tickets: tickets.rows[0],
    };
  });
}
