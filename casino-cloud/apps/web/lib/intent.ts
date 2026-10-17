/**
 * Step 7e: one Idempotency-Key per operator intent (path + request, key order irrelevant). Re-submitting
 * the same intent after an unclear outcome reuses the key, so the API replays the stored result instead of
 * executing twice; settle() releases it after a success so the next identical action is a new one.
 */
const intents = new Map<string, string>();

const stable = (v: unknown): string =>
  JSON.stringify(v ?? null, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

function randomKey(prefix: string) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function intentKey(path: string, body: unknown): string {
  const sig = `${path} ${stable(body)}`;
  let k = intents.get(sig);
  if (!k) intents.set(sig, (k = randomKey('op')));
  return k;
}

export function settleIntent(path: string, body: unknown) {
  intents.delete(`${path} ${stable(body)}`);
}
