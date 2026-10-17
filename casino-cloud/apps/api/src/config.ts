export const config = {
  port: Number(process.env.API_PORT ?? 4000),
  host: process.env.API_HOST ?? '0.0.0.0',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  jwtTtl: 12 * 3600, // seconds
  autoSeed: (process.env.AUTO_SEED ?? 'true') !== 'false',
  /** Key for hashing identity document numbers (keyed hash, never reversible). Set in production. */
  piiHashSecret: process.env.PII_HASH_SECRET ?? 'dev-pii-hash-secret-change-me',
  gatewayTimeoutSec: Number(process.env.GATEWAY_TIMEOUT_SEC ?? 30),
};

/**
 * Audit finding C3: never run a production API with a default or weak secret. The demo stack
 * (docker-compose, DEMO_MODE=true) is the only exception and logs a warning on every start.
 */
const KNOWN_DEFAULTS = new Set(['dev-secret-change-me', 'local-demo-secret-change-me', 'dev-pii-hash-secret-change-me']);
export function checkProductionSecrets(env = process.env, warn: (m: string) => void = console.warn): void {
  if (env.NODE_ENV !== 'production') return;
  const weak = [['JWT_SECRET', env.JWT_SECRET], ['PII_HASH_SECRET', env.PII_HASH_SECRET]]
    .filter(([, v]) => !v || KNOWN_DEFAULTS.has(v) || v.length < 32).map(([k]) => k);
  if (!weak.length) {
    if (!env.CORS_ORIGIN) warn('[security] CORS_ORIGIN is not set: every origin is accepted (set it in production)');
    return;
  }
  if (env.DEMO_MODE === 'true') {
    warn(`[security] DEMO_MODE: weak or default ${weak.join(', ')} accepted. Never use this configuration in production.`);
    return;
  }
  throw new Error(`[security] refusing to start: set strong (32+ characters) ${weak.join(', ')} or DEMO_MODE=true for a demo`);
}
