import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { HttpError } from './auth';
import { corsOrigins } from './config';
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
import { ledgerRoutes } from './routes/ledger';
import { moneyRoutes } from './routes/money';
import { cashOpsRoutes } from './routes/cash-ops';
import { handpayRoutes } from './routes/handpays';
import { machineMoneyRoutes } from './routes/machine-money';
import { operatorRoutes } from './routes/operator';
import { orgRoutes } from './routes/org';
import { platformRoutes } from './routes/platform';

export const redactUrl = (url: string) => url.replace(/([?&]token=)[^&]*/gi, '$1[redacted]');

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // the SSE stream carries its JWT in the query string: never write it to the logs
      serializers: { req: (r) => ({ method: r.method, url: redactUrl(r.url), host: r.host, remoteAddress: r.ip }) },
    },
    trustProxy: true,
  });

  // Bearer tokens (no cookies), so reflecting the origin is safe and lets LAN tablets connect.
  await app.register(cors, { origin: corsOrigins(), exposedHeaders: ['Content-Disposition', 'Idempotent-Replayed'] });
  await app.register(rateLimit, { max: 1200, timeWindow: '1 minute' });

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: 'Validation failed', issues: err.issues });
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message, ...(err.body ?? {}) });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: err.message });
    app.log.error(err);
    // database not reachable: a temporary condition the client may retry (money calls keep their Idempotency-Key)
    const pg = err as { code?: string };
    if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '57P01', '57P03', '08006', '08001', '53300'].includes(pg.code ?? '') || /Connection terminated|timeout exceeded when trying to connect/i.test(err.message))
      return reply.status(503).send({ error: 'Temporarily unavailable, please retry', code: 'TEMPORARILY_UNAVAILABLE' });
    return reply.status(500).send({ error: 'Internal server error', code: 'OPERATIONAL_ERROR' });
  });

  // Production readiness: every API route must declare its commercial feature (enforced by the guard).
  // A route without one is a programming error and stops the start (fail closed, audit finding C1).
  app.addHook('onRoute', (route) => {
    if (route.url.startsWith('/api/v1/') && !(route.config as { feature?: string } | undefined)?.feature)
      throw new Error(`Route ${route.method} ${route.url} declares no entitlement feature`);
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true, service: 'm1-casino-api' };
  });

  for (const routes of [authRoutes, dashboardRoutes, machineRoutes, floorRoutes, accountingRoutes, alertRoutes, auditRoutes, gatewayRoutes, casinoRoutes, streamRoutes,
    ticketRoutes, cashierRoutes, cashRoutes, employeeRoutes, reportRoutes, ledgerRoutes, moneyRoutes, cashOpsRoutes, handpayRoutes, machineMoneyRoutes, operatorRoutes,
    orgRoutes, platformRoutes])
    await app.register(routes);

  return app;
}
