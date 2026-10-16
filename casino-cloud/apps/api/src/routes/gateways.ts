import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTransaction, writeAudit } from '@m1/database';
import { MACHINE_STATUSES, WIRE_EVENT_TYPES } from '@m1/shared';
import { actor, guard, scopeCasino } from '../auth';
import { bus } from '../bus';
import { pool } from '../db';
import { ingestEvents } from '../services/ingest';
import { authenticateGateway, heartbeat } from '../services/gateway';
import { confirmHandpayReset } from '../services/handpays';
import { holdTicket, releaseTicketHold } from '../services/ticket-holds';
import { assertHoldAllowed } from '../services/tito';

const eventSchema = z.object({
  eventId: z.string().uuid(),
  type: z.enum(WIRE_EVENT_TYPES), // canonical names plus legacy aliases, normalised at ingestion
  machineId: z.string().min(1).max(64),
  timestamp: z.string().datetime(),
  amount: z.number().min(0).max(10_000_000).optional(),
  win: z.number().min(0).max(10_000_000).optional(),
  playerCardId: z.string().max(64).optional(),
  ticketBarcode: z.string().max(64).optional(),
  holdId: z.string().uuid().optional(),
  errorCode: z.string().max(64).optional(),
  message: z.string().max(500).optional(),
  source: z.string().max(40).optional(),
});

function gatewayAuth(req: FastifyRequest) {
  return authenticateGateway(req.headers['x-gateway-id'] as string | undefined, req.headers['x-gateway-key'] as string | undefined);
}

export async function gatewayRoutes(app: FastifyInstance) {
  // ---- Device API (used by the edge gateway, authenticated with device id + key) ----
  app.post('/api/v1/gateway/heartbeat', async (req) => {
    const gw = await gatewayAuth(req);
    const body = z.object({
      version: z.string().max(40).optional(),
      stats: z.record(z.unknown()).optional(),
      machines: z.array(z.object({ machineId: z.string(), status: z.enum(MACHINE_STATUSES) })).max(5000).optional(),
    }).parse(req.body ?? {});
    return heartbeat(gw, body, req.ip);
  });

  app.post('/api/v1/gateway/events', { bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const gw = await gatewayAuth(req);
    const { events } = z.object({ events: z.array(eventSchema).max(1000) }).parse(req.body);
    return ingestEvents(gw, events);
  });

  // ---- TITO validation: a machine scans a ticket, the system holds it for that machine (no money).
  // The machine commits with its TITO_IN event (holdId = the accept ack) or releases the hold on reject.
  app.post('/api/v1/gateway/tickets/hold', async (req) => {
    const gw = await gatewayAuth(req);
    const body = z.object({ machineId: z.string().min(1).max(64), barcode: z.string().trim().regex(/^\d{6,30}$/) }).parse(req.body);
    return withTransaction(pool, async (db) => {
      const m = (await db.query('SELECT id FROM machines WHERE org_id = $1 AND casino_id = $2 AND machine_code = $3', [gw.orgId, gw.casinoId, body.machineId])).rows[0];
      if (!m) return { ok: false, reason: 'UNKNOWN_MACHINE' };
      const blocked = await assertHoldAllowed(db, gw.orgId, gw.casinoId);
      if (blocked) return { ok: false, reason: blocked };
      return holdTicket(db, { orgId: gw.orgId, barcode: body.barcode, machineId: m.id });
    });
  });

  app.post('/api/v1/gateway/tickets/release', async (req) => {
    const gw = await gatewayAuth(req);
    const body = z.object({ holdId: z.string().uuid(), reason: z.string().max(200).default('machine rejected') }).parse(req.body);
    return { released: await withTransaction(pool, (db) => releaseTicketHold(db, { orgId: gw.orgId, holdId: body.holdId, reason: body.reason })) };
  });

  app.post('/api/v1/gateway/commands/:id/result', async (req) => {
    const gw = await gatewayAuth(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ success: z.boolean(), message: z.string().max(500).optional() }).parse(req.body);
    await withTransaction(pool, async (db) => {
      const r = await db.query(
        `UPDATE machine_commands SET status = $3, result_message = $4, completed_at = now() WHERE id = $1 AND gateway_id = $2 RETURNING type, machine_id, handpay_id`,
        [id, gw.id, body.success ? 'SUCCEEDED' : 'FAILED', body.message ?? null],
      );
      const cmd = r.rows[0];
      // A confirmed handpay reset completes the handpay (PAID -> MACHINE_RESET).
      if (cmd && body.success && cmd.type === 'RESET_JACKPOT' && cmd.handpay_id)
        await confirmHandpayReset(db, { orgId: gw.orgId, machineId: cmd.machine_id, handpayId: cmd.handpay_id });
    });
    return { ok: true };
  });

  // ---- Management API ----
  app.get('/api/v1/gateways', { preHandler: guard('gateway.view') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    const r = await pool.query(
      `SELECT g.id, g.device_id, g.name, g.hardware, g.status, g.last_heartbeat_at, g.last_ip, g.version, g.stats, g.config, g.created_at,
         (SELECT count(*) FROM machines m WHERE m.gateway_id = g.id) machines,
         (SELECT count(*) FROM machine_events e WHERE e.gateway_id = g.id AND e.received_at > now() - interval '1 minute') events_last_minute
       FROM gateways g WHERE g.org_id = $1 AND g.casino_id = $2 ORDER BY g.device_id`,
      [req.auth.orgId, casinoId],
    );
    return r.rows;
  });

  // ---- Simulation controller (remote configuration pushed to the casino's gateways) ----
  app.get('/api/v1/simulation', { preHandler: guard('dashboard.view') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    const r = await pool.query(
      `SELECT g.config, (SELECT count(*) FROM machines m WHERE m.casino_id = $2 AND m.adapter_key = 'simulator') machines
       FROM gateways g WHERE g.org_id = $1 AND g.casino_id = $2 ORDER BY g.device_id LIMIT 1`,
      [req.auth.orgId, casinoId],
    );
    const sim = r.rows[0]?.config?.simulation ?? { running: false, eventsPerSecond: 2 };
    return { running: !!sim.running, eventsPerSecond: sim.eventsPerSecond ?? 2, machines: r.rows[0]?.machines ?? 0, gateways: r.rowCount };
  });

  app.put('/api/v1/simulation', { preHandler: guard('simulation.control') }, async (req) => {
    const body = z.object({ casinoId: z.string().uuid().optional(), running: z.boolean(), eventsPerSecond: z.number().min(1).max(5) }).parse(req.body);
    const casinoId = scopeCasino(req, body.casinoId);
    const sim = { running: body.running, eventsPerSecond: body.eventsPerSecond };
    await pool.query(
      `UPDATE gateways SET config = jsonb_set(config, '{simulation}', $3::jsonb) WHERE org_id = $1 AND casino_id = $2`,
      [req.auth.orgId, casinoId, JSON.stringify(sim)],
    );
    await writeAudit(pool, { ...actor(req), casinoId, action: body.running ? 'simulation.started' : 'simulation.stopped', entityType: 'casino', entityId: casinoId, details: sim });
    bus.publish({ kind: 'simulation.updated', orgId: req.auth.orgId, casinoId, ...sim });
    return sim;
  });
}
