import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { HttpError } from './auth';
import { pool } from './db';
import { authRoutes } from './routes/auth';
import { dashboardRoutes } from './routes/dashboard';
import { machineRoutes } from './routes/machines';
import { floorRoutes } from './routes/floors';
import { accountingRoutes } from './routes/accounting';
import { alertRoutes } from './routes/alerts';
import { auditRoutes } from './routes/audit';
import { gatewayRoutes } from './routes/gateways';
import { casinoRoutes } from './routes/casinos';
import { streamRoutes } from './routes/stream';
import { ticketRoutes } from './routes/tickets';
import { cashierRoutes } from './routes/cashier';
import { cashRoutes } from './routes/cash';
import { employeeRoutes } from './routes/employees';
import { reportRoutes } from './routes/reports';

export async function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });

  // Bearer tokens (no cookies), so reflecting the origin is safe and lets LAN tablets connect.
  await app.register(cors, { origin: process.env.CORS_ORIGIN?.split(',') ?? true, exposedHeaders: ['Content-Disposition'] });
  await app.register(rateLimit, { max: 1200, timeWindow: '1 minute' });

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: 'Validation failed', issues: err.issues });
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: err.message });
    app.log.error(err);
    return reply.status(500).send({ error: 'Internal server error' });
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true, service: 'm1-casino-api' };
  });

  for (const routes of [authRoutes, dashboardRoutes, machineRoutes, floorRoutes, accountingRoutes, alertRoutes, auditRoutes, gatewayRoutes, casinoRoutes, streamRoutes,
    ticketRoutes, cashierRoutes, cashRoutes, employeeRoutes, reportRoutes])
    await app.register(routes);

  return app;
}
