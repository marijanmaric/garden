import { EventEmitter } from 'node:events';
import type { StreamMessage } from '@m1/shared';

export type BusMessage = StreamMessage & { orgId: string };

/**
 * In-process event bus feeding the realtime stream. The interface is deliberately tiny
 * so it can be replaced by Redis / NATS / MQTT when the API runs on several instances.
 */
class EventBus {
  private emitter = new EventEmitter().setMaxListeners(0);
  publish(msg: BusMessage) {
    this.emitter.emit('msg', msg);
  }
  subscribe(fn: (msg: BusMessage) => void): () => void {
    this.emitter.on('msg', fn);
    return () => this.emitter.off('msg', fn);
  }
}

export const bus = new EventBus();
