import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulatorAdapter } from './index';

const machine = {
  machineId: 'VIE-001-000001', assetNo: 'M001', manufacturer: 'Novomatic', model: 'X', game: 'Y',
  denomination: 0.01, adapter: 'simulator', adapterConfig: {},
};

test('simulator produces events and drains its buffer', async () => {
  const sim = new SimulatorAdapter(machine);
  await sim.connect();
  for (let i = 0; i < 200; i++) sim.tick();
  const events = await sim.getEvents();
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => e.machineId === machine.machineId && e.eventId));
  assert.equal((await sim.getEvents()).length, 0);
});

test('game meters match emitted GAME_PLAYED events', async () => {
  const sim = new SimulatorAdapter(machine);
  await sim.connect();
  const all = [];
  for (let i = 0; i < 500; i++) {
    sim.tick();
    all.push(...(await sim.getEvents()));
  }
  const games = all.filter((e) => e.type === 'GAME_PLAYED');
  const meters = await sim.getMeters();
  assert.equal(meters.gamesPlayed, games.length);
});

test('lock command disables machine', async () => {
  const sim = new SimulatorAdapter(machine, { random: () => 0.9 });
  await sim.connect();
  const res = await sim.sendCommand({ id: 'c1', type: 'LOCK' });
  assert.equal(res.success, true);
  assert.equal(await sim.getStatus(), 'DISABLED');
  const events = await sim.getEvents();
  assert.equal(events[0].type, 'MACHINE_DISABLED');
});

/** Random source that returns the given values first, then a fixed fallback. */
function scripted(values: number[], fallback = 0.5) {
  let i = 0;
  return () => (i < values.length ? values[i++] : fallback);
}

test('jackpot is never reset automatically, only by RESET_JACKPOT', async () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  // 0.0252 lands in the jackpot branch of tick(); 0.5 sets the amount.
  const sim = new SimulatorAdapter(machine, { random: scripted([0.0252, 0.5]), now: () => now });
  await sim.connect();
  sim.tick();
  const first = await sim.getEvents();
  assert.deepEqual(first.map((e) => e.type), ['JACKPOT']);
  assert.equal(await sim.getStatus(), 'JACKPOT');

  // Hours later and with more ticks: still locked, no reset event, no play.
  now += 6 * 3600 * 1000;
  for (let i = 0; i < 50; i++) sim.tick();
  const later = await sim.getEvents();
  assert.equal(later.length, 0);
  assert.equal(await sim.getStatus(), 'JACKPOT');

  const res = await sim.sendCommand({ id: 'c1', type: 'RESET_JACKPOT' });
  assert.equal(res.success, true);
  const afterReset = await sim.getEvents();
  assert.deepEqual(afterReset.map((e) => e.type), ['JACKPOT_RESET']);
  assert.equal(await sim.getStatus(), 'ONLINE');
});
