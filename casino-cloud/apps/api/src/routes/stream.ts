import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { bus } from '../bus';

/**
 * Server-Sent Events stream. EventSource cannot send headers, so the JWT is passed as a
 * query parameter. Messages are filtered by tenant and casino access.
 */
export async function streamRoutes(app: FastifyInstance) {
  app.get('/api/v1/stream', async (req, reply) => {
    const qs = z.object({ token: z.string(), casinoId: z.string().uuid().optional() }).parse(req.query);
    const auth = await authenticate(req, qs.token);
    const allowed = new Set(qs.casinoId ? auth.casinoIds.filter((c) => c === qs.casinoId) : auth.casinoIds);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': (req.headers.origin as string) ?? '*',
    });
    res.write(`event: ready\ndata: {}\n\n`);

    const unsubscribe = bus.subscribe((msg) => {
      if (msg.orgId !== auth.orgId || !allowed.has(msg.casinoId)) return;
      const { orgId: _o, ...payload } = msg;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });
}
