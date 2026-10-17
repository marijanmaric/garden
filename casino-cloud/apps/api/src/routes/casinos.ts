import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard, scopeCasino } from '../auth';
import { pool } from '../db';

export async function casinoRoutes(app: FastifyInstance) {
  app.get('/api/v1/casinos', { config: { feature: 'core' }, preHandler: guard('casino.view') }, async (req) => {
    const r = await pool.query(
      `SELECT c.id, c.code, c.name, c.city, c.country, c.timezone, c.currency,
         (SELECT count(*) FROM floors f WHERE f.casino_id = c.id) floors,
         (SELECT count(*) FROM machines m WHERE m.casino_id = c.id) machines,
         (SELECT count(*) FROM machines m WHERE m.casino_id = c.id AND m.status NOT IN ('OFFLINE','MAINTENANCE')) online,
         (SELECT count(*) FROM alerts a WHERE a.casino_id = c.id AND a.status <> 'RESOLVED') open_alerts,
         (SELECT json_agg(json_build_object('id', f.id, 'name', f.name, 'machines', (SELECT count(*) FROM machines m WHERE m.floor_id = f.id)) ORDER BY f.sort_order)
            FROM floors f WHERE f.casino_id = c.id) floor_list
       FROM casinos c WHERE c.org_id = $1 AND c.id = ANY($2) ORDER BY c.name`,
      [req.auth.orgId, req.auth.casinoIds],
    );
    return r.rows;
  });

  // Per-casino module switches were removed (audit findings C1 / C2): what a customer may use is decided by its
  // commercial entitlements (platform), switched by the organisation admin (/api/v1/org/modules).

  /**
   * Player search. Cards come from player_cards (any card number of the player matches, the
   * active card is returned), names from player_profiles. Response shape kept for the UI.
   */
  app.get('/api/v1/players', { config: { feature: 'core' }, preHandler: guard('player.view') }, async (req) => {
    const qs = z.object({ search: z.string().optional() }).parse(req.query);
    const r = await pool.query(
      `SELECT p.id, p.player_no, p.status, p.verification_status, ac.card_number, ac.status AS card_status,
         pr.first_name, pr.last_name, p.tier, floor(p.points) points, p.total_coin_in, p.visits, p.last_visit_at,
         m.asset_no AS current_machine
       FROM players p
       LEFT JOIN player_profiles pr ON pr.player_id = p.id
       LEFT JOIN LATERAL (
         SELECT c.card_number, c.status FROM player_cards c WHERE c.player_id = p.id
         ORDER BY (c.status = 'ACTIVE') DESC, c.issued_at DESC LIMIT 1
       ) ac ON true
       LEFT JOIN machines m ON m.current_player_id = p.id
       WHERE p.org_id = $1 AND (
         $2::text IS NULL OR p.player_no ILIKE $2 OR concat_ws(' ', pr.first_name, pr.last_name) ILIKE $2
         OR EXISTS (SELECT 1 FROM player_cards c WHERE c.player_id = p.id AND c.card_number ILIKE $2)
       )
       ORDER BY p.total_coin_in DESC LIMIT 200`,
      [req.auth.orgId, qs.search ? `%${qs.search}%` : null],
    );
    return r.rows;
  });

  app.get('/api/v1/jackpots', { config: { feature: 'core' }, preHandler: guard('jackpot.view') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    const r = await pool.query('SELECT * FROM jackpots WHERE org_id = $1 AND casino_id = $2 ORDER BY current_value DESC', [req.auth.orgId, casinoId]);
    return r.rows;
  });
}
