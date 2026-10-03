import { join } from 'node:path';
import { CloudClient } from './cloud';
import { Gateway } from './gateway';
import { OfflineQueue } from './queue';

const cloud = new CloudClient({
  baseUrl: process.env.CLOUD_URL ?? 'http://localhost:4000',
  gatewayId: process.env.GATEWAY_ID ?? 'GW-VIE-001',
  gatewayKey: process.env.GATEWAY_KEY ?? 'demo-gateway-key',
});
const queue = new OfflineQueue(process.env.QUEUE_FILE ?? join(process.cwd(), 'data', 'queue.jsonl'));
const gateway = new Gateway(cloud, queue);
gateway.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    await gateway.stop();
    process.exit(0);
  });
