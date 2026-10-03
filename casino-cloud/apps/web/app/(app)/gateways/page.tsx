'use client';
import { formatDateTime, formatNumber, timeAgo } from '@m1/ui';
import { useApi } from '@/lib/api';
import { useLiveRefresh } from '@/lib/live';
import { useSession } from '@/lib/session';
import { Card, ErrorNote, PageHeader, Stat, StatusBadge } from '@/components/ui';

export default function GatewaysPage() {
  const { casino } = useSession();
  const { data, error, reload } = useApi<any[]>(`/gateways?casinoId=${casino.id}`, { refreshMs: 5000 });
  useLiveRefresh(() => void reload(), 500, ['gateway.status']);
  return (
    <div>
      <PageHeader title="Edge Gateways" subtitle="Raspberry Pi / Rock Pi / industrial Linux devices that connect machines to the cloud." />
      <ErrorNote error={error} />
      <div className="grid gap-6 lg:grid-cols-2">
        {data?.map((g) => (
          <Card key={g.id} title={<span>{g.name} <span className="ml-2 font-mono text-xs text-sub">{g.device_id}</span></span>} actions={<StatusBadge status={g.status} />}>
            <Stat label="Hardware" value={g.hardware ?? '-'} />
            <Stat label="Software version" value={g.version ?? '-'} />
            <Stat label="Last heartbeat" value={timeAgo(g.last_heartbeat_at)} hint={formatDateTime(g.last_heartbeat_at)} />
            <Stat label="IP" value={g.last_ip ?? '-'} />
            <Stat label="Machines" value={g.machines} />
            <Stat label="Events / minute" value={formatNumber(g.events_last_minute)} />
            <Stat label="Offline queue" value={formatNumber(g.stats?.queueSize ?? 0)} tone={(g.stats?.queueSize ?? 0) > 50 ? 'warn' : undefined} />
            <Stat label="Sent since start" value={formatNumber(g.stats?.sentTotal ?? 0)} />
            <Stat label="Uptime" value={g.stats?.uptimeSec != null ? `${Math.floor(g.stats.uptimeSec / 60)} min` : '-'} />
            <Stat label="Simulation" value={g.config?.simulation?.running ? `on · ${g.config.simulation.eventsPerSecond} ev/s` : 'off'} />
          </Card>
        ))}
      </div>
    </div>
  );
}
