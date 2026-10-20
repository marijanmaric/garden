export const config = {
  port: Number(process.env.API_PORT ?? 4000),
  host: process.env.API_HOST ?? '0.0.0.0',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtTtl: 12 * 3600, // seconds
  /** Demo seed on an empty database: on by default in development and the demo stack, never in production. */
  autoSeed: process.env.AUTO_SEED ? process.env.AUTO_SEED === 'true' : process.env.NODE_ENV !== 'production' || process.env.DEMO_MODE === 'true',
  /** Key for hashing identity document numbers (keyed hash, never reversible). Set in production. */
  piiHashSecret: process.env.PII_HASH_SECRET || 'dev-pii-hash-secret-change-me',
  gatewayTimeoutSec: Number(process.env.GATEWAY_TIMEOUT_SEC ?? 30),
};

/**
 * Production configuration gate (audit findings C3, M2 and the final acceptance review). With NODE_ENV=production
 * the API refuses to start with: a default, known or short (< 32 characters) JWT / PII secret, a missing or open
 * CORS_ORIGIN, or AUTO_SEED=true (the demo seed creates accounts with the password "demo", including a platform
 * administrator). The demo stack (docker-compose, DEMO_MODE=true) is the only exception and warns on every start.
 * Development and tests (NODE_ENV not production) stay convenient. Secret values are never logged.
 */
const KNOWN_DEFAULTS = new Set(['dev-secret-change-me', 'local-demo-secret-change-me', 'dev-pii-hash-secret-change-me', 'demo', 'changeme', 'secret']);

/** Allowed browser origins: the explicit CORS_ORIGIN list, or every origin (true) outside production. */
export function corsOrigins(env = process.env): string[] | true {
  const list = (env.CORS_ORIGIN ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  return list.length && !list.includes('*') ? list : true;
}

export function checkProductionConfig(env = process.env, warn: (m: string) => void = console.warn): void {
  if (env.NODE_ENV !== 'production') return;
  const demo = env.DEMO_MODE === 'true';
  const problems: string[] = [];
  const weak = [['JWT_SECRET', env.JWT_SECRET], ['PII_HASH_SECRET', env.PII_HASH_SECRET]]
    .filter(([, v]) => !v || KNOWN_DEFAULTS.has(v) || v.length < 32).map(([k]) => k);
  if (weak.length) problems.push(`set strong (32+ characters, not a default) ${weak.join(', ')}`);
  const origins = (env.CORS_ORIGIN ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (!origins.length) problems.push('set CORS_ORIGIN to the web origin(s), e.g. https://casino.example.com');
  else if (origins.includes('*')) problems.push('CORS_ORIGIN must list explicit origins, not *');
  else for (const o of origins) if (!/^https?:\/\/[^/\s]+$/.test(o)) problems.push(`CORS_ORIGIN entry "${o}" is not an origin (scheme://host[:port], no path)`);
  if (env.AUTO_SEED === 'true') problems.push('AUTO_SEED=true creates demo accounts with known passwords: remove it');
  if (!problems.length) return;
  if (demo) {
    warn(`[security] DEMO_MODE: production checks not enforced (${problems.join('; ')}). Never use this configuration in production.`);
    return;
  }
  throw new Error(`[security] refusing to start in production: ${problems.join('; ')}`);
}
