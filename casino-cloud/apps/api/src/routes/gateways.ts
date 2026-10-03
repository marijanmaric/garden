import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@m1/database';
import { MACHINE_EVENT_TYPES, MACHINE_STATUSES } from '@m1/shared';
import { actor, guard, scopeCasino } from '../auth';
import { bus } from '../bus';
import { pool } from '../db';
import { ingestEvents } from '../services/ingest';
import { authenticateGateway, heartbeat } from '../services/gateway';

const eventSchema = z.object({
  eventId: z.string().uuid(),
  type: z.enum(MACHINE_EVENT_TYPES),
  machineId: z.string().min(1).max(64),
  timestamp: z.string().datetime(),
  amount: z.number().min(0).max(10_000_000).optional(),
  win: z.number().min(0).max(10_000_000).optional(),
  playerCardId: z.string().max(64).optional(),
  ticketBarcode: z.string().max(64).optional(),
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

  app.post('/api/v1/gateway/commands/:id/result', async (req) => {
    const gw = await gatewayAuth(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ success: z.boolean(), message: z.string().max(500).optional() }).parse(req.body);
    await pool.query(
      `UPDATE machine_commands SET status = $3, result_message = $4, completed_at = now() WHERE id = $1 AND gateway_id = $2`,
      [id, gw.id, body.success ? 'SUCCEEDED' : 'FAILED', body.message ?? null],
    );
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
