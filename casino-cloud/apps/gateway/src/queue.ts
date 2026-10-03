import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MachineEvent } from '@m1/shared';

/**
 * Durable offline queue. Every event is appended to a JSONL file *before* it is sent,
 * and only removed after the cloud acknowledged it. Survives restarts and power loss
 * (up to the OS write cache). The cloud ingests idempotently, so resends are harmless.
 */
export class OfflineQueue {
  private items: MachineEvent[] = [];

  constructor(private file: string) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.items.push(JSON.parse(line));
        } catch {
          // a torn last line after a crash: skip it
        }
      }
    }
  }

  get size() {
    return this.items.length;
  }

  push(events: MachineEvent[]) {
    if (!events.length) return;
    appendFileSync(this.file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    this.items.push(...events);
  }

  peek(max: number): MachineEvent[] {
    return this.items.slice(0, max);
  }

  /** Removes the first n items (acknowledged by the cloud) and compacts the file atomically. */
  ack(n: number) {
    this.items = this.items.slice(n);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, this.items.map((e) => JSON.stringify(e)).join('\n') + (this.items.length ? '\n' : ''));
    renameSync(tmp, this.file);
  }
}
