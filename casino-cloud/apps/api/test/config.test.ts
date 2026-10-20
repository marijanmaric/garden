import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProductionConfig, corsOrigins } from '../src/config';
import { redactUrl } from '../src/app';

/** Production configuration gate (final acceptance, Part 2): fail closed instead of running open. */
const strong = 'x'.repeat(40);
const prod = (over: Record<string, string | undefined> = {}) =>
  ({ NODE_ENV: 'production', JWT_SECRET: strong, PII_HASH_SECRET: `${strong}y`, CORS_ORIGIN: 'https://casino.example.com', ...over }) as NodeJS.ProcessEnv;
const refuses = (env: NodeJS.ProcessEnv, re: RegExp) => assert.throws(() => checkProductionConfig(env, () => {}), re);

test('production starts only with strong secrets, an explicit CORS origin and no demo seed', () => {
  assert.doesNotThrow(() => checkProductionConfig(prod(), () => assert.fail('no warning expected')));
  assert.doesNotThrow(() => checkProductionConfig(prod({ CORS_ORIGIN: 'https://a.example.com, https://b.example.com:8443' }), () => {}));
  refuses(prod({ CORS_ORIGIN: undefined }), /CORS_ORIGIN/);
  refuses(prod({ CORS_ORIGIN: '' }), /CORS_ORIGIN/);
  refuses(prod({ CORS_ORIGIN: '*' }), /not \*/);
  refuses(prod({ CORS_ORIGIN: 'https://casino.example.com/app' }), /not an origin/);
  refuses(prod({ JWT_SECRET: undefined }), /JWT_SECRET/);
  refuses(prod({ JWT_SECRET: 'dev-secret-change-me' }), /JWT_SECRET/);
  refuses(prod({ JWT_SECRET: 'local-demo-secret-change-me' }), /JWT_SECRET/);
  refuses(prod({ JWT_SECRET: 'short-secret' }), /JWT_SECRET/);
  refuses(prod({ PII_HASH_SECRET: 'dev-pii-hash-secret-change-me' }), /PII_HASH_SECRET/);
  refuses(prod({ AUTO_SEED: 'true' }), /AUTO_SEED/);
  assert.doesNotThrow(() => checkProductionConfig(prod({ AUTO_SEED: 'false' }), () => {}));
});

test('the refusal never contains a secret value', () => {
  try {
    checkProductionConfig(prod({ JWT_SECRET: 'my-actual-weak-secret' }), () => {});
    assert.fail('expected a refusal');
  } catch (e) {
    assert.ok(!(e as Error).message.includes('my-actual-weak-secret'));
  }
});

test('DEMO_MODE warns instead of refusing; development and tests are not gated', () => {
  const warnings: string[] = [];
  assert.doesNotThrow(() => checkProductionConfig(prod({ DEMO_MODE: 'true', CORS_ORIGIN: undefined, JWT_SECRET: undefined, AUTO_SEED: 'true' }), (m) => warnings.push(m)));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /DEMO_MODE/);
  assert.doesNotThrow(() => checkProductionConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv, () => assert.fail()));
  assert.doesNotThrow(() => checkProductionConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv, () => assert.fail()));
});

test('CORS allow-list and log redaction of the SSE token', () => {
  assert.deepEqual(corsOrigins({ CORS_ORIGIN: 'https://a.example.com,https://b.example.com' } as NodeJS.ProcessEnv), ['https://a.example.com', 'https://b.example.com']);
  assert.equal(corsOrigins({} as NodeJS.ProcessEnv), true);
  assert.equal(corsOrigins({ CORS_ORIGIN: '*' } as NodeJS.ProcessEnv), true);
  assert.equal(redactUrl('/api/v1/stream?token=eyJabc.def.ghi&casinoId=1'), '/api/v1/stream?token=[redacted]&casinoId=1');
  assert.equal(redactUrl('/api/v1/stream?casinoId=1&token=eyJ'), '/api/v1/stream?casinoId=1&token=[redacted]');
});
