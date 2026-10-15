import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_EVENT_ALIASES, MACHINE_EVENT_TYPES, normalizeEvent, normalizeEventType } from './events';

test('legacy event names map to canonical names', () => {
  assert.equal(normalizeEventType('COIN_IN'), 'CASH_IN');
  assert.equal(normalizeEventType('COIN_OUT'), 'CASH_OUT');
  assert.equal(normalizeEventType('TICKET_IN'), 'TITO_IN');
  assert.equal(normalizeEventType('TICKET_OUT'), 'TITO_OUT');
  assert.equal(normalizeEventType('GAME_PLAYED'), 'GAME_PLAYED');
});

test('normalizeEvent keeps the original legacy name for traceability', () => {
  const e = normalizeEvent({ eventId: 'x', type: 'TICKET_OUT', machineId: 'M', timestamp: 't', amount: 5 });
  assert.equal(e.type, 'TITO_OUT');
  assert.equal(e.legacyType, 'TICKET_OUT');
  const c = normalizeEvent({ eventId: 'y', type: 'CASH_IN', machineId: 'M', timestamp: 't' });
  assert.equal(c.legacyType, undefined);
});

test('canonical event types contain no COIN names', () => {
  for (const t of MACHINE_EVENT_TYPES) assert.ok(!t.includes('COIN'), t);
  for (const target of Object.values(LEGACY_EVENT_ALIASES)) assert.ok(MACHINE_EVENT_TYPES.includes(target));
});
