import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Pool } from '@m1/database';
import { setupTestDatabase } from './helpers';

/**
 * Real-time stream (final acceptance, Part 22): authentication, organisation and casino isolation, expired and
 * invalid tokens, reconnect. A real HTTP server is used because the stream never ends.
 */
let app: FastifyInstance;
let pool: Pool;
let base: string;

before(async () => {
  ({ app, pool } = await setupTestDatabase());
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app?.close();
  await pool?.end();
});

async function token(email: string, expiresIn?: number) {
  const jwt = (await import('jsonwebtoken')).default;
  const { config } = await import('../src/config');
  const e = (await pool.query('SELECT id, org_id, role, name, email FROM employees WHERE email = $1', [email])).rows[0];
  return jwt.sign({ sub: e.id, orgId: e.org_id, role: e.role, name: e.name, email: e.email }, config.jwtSecret, { expiresIn: expiresIn ?? 600, algorithm: 'HS256' });
}

/** Opens the stream, publishes the given messages once it is ready, returns what the client received. */
async function receive(url: string, publish: () => void, ms = 600) {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal });
  if (res.status !== 200) return { status: res.status, data: [] as unknown[] };
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  let published = false;
  const read = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value);
        if (text.includes('event: ready') && !published) {
          published = true;
          publish();
        }
      }
    } catch { /* aborted */ }
  })();
  await new Promise((r) => setTimeout(r, ms));
  ctrl.abort();
  await read;
  const data = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((d) => Object.keys(d).length);
  return { status: 200, data };
}

test('stream: only events of the own organisation and accessible casinos; invalid / expired tokens refused; reconnect works', async () => {
  const { bus } = await import('../src/bus');
  const m1 = (await pool.query(`SELECT org_id, id FROM casinos WHERE code = 'VIE-001'`)).rows[0];
  const other = (await pool.query(`SELECT org_id, id FROM casinos WHERE org_id <> $1 LIMIT 1`, [m1.org_id])).rows[0];
  const otherCasinoSameOrg = '00000000-0000-4000-8000-000000000001';
  const publish = () => {
    bus.publish({ orgId: m1.org_id, casinoId: m1.id, type: 'alert.created', data: { n: 'own' } } as never);
    bus.publish({ orgId: other.org_id, casinoId: other.id, type: 'alert.created', data: { n: 'foreign-org' } } as never);
    bus.publish({ orgId: m1.org_id, casinoId: otherCasinoSameOrg, type: 'alert.created', data: { n: 'foreign-casino' } } as never);
  };
  const t = await token('admin@example.com');
  const r = await receive(`${base}/api/v1/stream?token=${t}`, publish);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.map((d) => (d as { data: { n: string } }).data.n), ['own'], JSON.stringify(r.data));
  assert.ok(r.data.every((d) => !('orgId' in (d as object))), 'the organisation id is not sent');
  // casino filter: a casino the user cannot access yields nothing
  const f = await receive(`${base}/api/v1/stream?token=${t}&casinoId=${other.id}`, publish);
  assert.deepEqual(f.data, []);
  // the other tenant sees only its own events
  const riverside = (await pool.query(`SELECT email FROM employees WHERE org_id = $1 AND role = 'SUPER_ADMIN' LIMIT 1`, [other.org_id])).rows[0].email;
  const o = await receive(`${base}/api/v1/stream?token=${await token(riverside)}`, publish);
  assert.deepEqual(o.data.map((d) => (d as { data: { n: string } }).data.n), ['foreign-org']);
  // invalid, tampered and expired tokens
  assert.equal((await fetch(`${base}/api/v1/stream`)).status, 400);
  assert.equal((await fetch(`${base}/api/v1/stream?token=garbage`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/stream?token=${t.slice(0, -2)}xx`)).status, 401);
  const expired = await token('admin@example.com', -10);
  assert.equal((await fetch(`${base}/api/v1/stream?token=${expired}`)).status, 401);
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' + t.split('.')[1] + '.';
  assert.equal((await fetch(`${base}/api/v1/stream?token=${none}`)).status, 401, 'alg=none is refused');
  // reconnect: a new connection with the same token works again
  const again = await receive(`${base}/api/v1/stream?token=${t}`, publish);
  assert.equal(again.data.length, 1);
  // a deactivated employee's token stops working at once
  await pool.query(`UPDATE employees SET active = false WHERE email = 'cashier@example.com'`);
  assert.equal((await fetch(`${base}/api/v1/stream?token=${await token('cashier@example.com')}`)).status, 401);
  await pool.query(`UPDATE employees SET active = true WHERE email = 'cashier@example.com'`);
});
