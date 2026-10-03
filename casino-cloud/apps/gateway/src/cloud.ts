import type { GatewayRemoteConfig, MachineEvent, MachineStatus } from '@m1/shared';

export interface CloudClientOptions {
  baseUrl: string;
  gatewayId: string;
  gatewayKey: string;
  timeoutMs?: number;
}

/** HTTPS client towards the cloud API. Swap for MQTT later without touching the rest of the gateway. */
export class CloudClient {
  constructor(private opts: CloudClientOptions) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gateway-id': this.opts.gatewayId,
        'x-gateway-key': this.opts.gatewayKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10000),
    });
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  heartbeat(body: { version: string; stats: Record<string, unknown>; machines: Array<{ machineId: string; status: MachineStatus }> }) {
    return this.post<GatewayRemoteConfig>('/api/v1/gateway/heartbeat', body);
  }

  sendEvents(events: MachineEvent[]) {
    return this.post<{ accepted: number; duplicates: number; rejected: string[] }>('/api/v1/gateway/events', { events });
  }

  commandResult(id: string, success: boolean, message?: string) {
    return this.post(`/api/v1/gateway/commands/${id}/result`, { success, message });
  }
}
