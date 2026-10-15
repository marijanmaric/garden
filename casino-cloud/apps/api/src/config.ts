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
