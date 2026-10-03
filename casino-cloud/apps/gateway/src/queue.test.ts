import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OfflineQueue } from './queue';

const ev = (n: number) => ({ eventId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, type: 'GAME_PLAYED' as const, machineId: 'M', timestamp: new Date().toISOString() });

test('queue survives restart and only drops acknowledged events', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'q-')), 'queue.jsonl');
  const q = new OfflineQueue(file);
  q.push([ev(1), ev(2), ev(3)]);
  q.ack(1);
  const reloaded = new OfflineQueue(file);
  assert.equal(reloaded.size, 2);
  assert.equal(reloaded.peek(10)[0].eventId, ev(2).eventId);
});
