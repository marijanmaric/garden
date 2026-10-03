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
