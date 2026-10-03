'use client';
import { Trophy } from 'lucide-react';
import { formatEuro } from '@m1/ui';
import { useApi } from '@/lib/api';
import { useLiveRefresh } from '@/lib/live';
import { useSession } from '@/lib/session';
import { Card, ErrorNote, PageHeader, Stat } from '@/components/ui';

export default function JackpotsPage() {
  const { casino } = useSession();
  const { data, error, reload } = useApi<any[]>(`/jackpots?casinoId=${casino.id}`);
  useLiveRefresh(() => void reload(), 2000, ['machine.event']);
  return (
    <div>
      <PageHeader title="Jackpots" subtitle="Progressive values grow with every wager. Triggering, mystery and time logic arrive with the Jackpot Engine (Phase 4)." />
      <ErrorNote error={error} />
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {data?.map((j) => {
          const pct = j.max_value ? Math.min(100, ((j.current_value - j.base_value) / (j.max_value - j.base_value)) * 100) : 50;
          return (
            <Card key={j.id} title={<span className="flex items-center gap-2"><Trophy className="h-4 w-4 text-yellow-500" />{j.name}</span>} actions={<span className="badge bg-muted ring-line">{j.type}</span>}>
              <div className="mb-3 text-3xl font-bold tabular-nums text-yellow-600 dark:text-yellow-400">{formatEuro(j.current_value)}</div>
              <div className="mb-3 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-gradient-to-r from-yellow-400 to-orange-500" style={{ width: `${pct}%` }} /></div>
              <Stat label="Base / Reset" value={formatEuro(j.base_value)} />
              <Stat label="Maximum" value={j.max_value ? formatEuro(j.max_value) : 'none'} />
              <Stat label="Contribution" value={`${(j.contribution_rate * 100).toFixed(2)}% of bet`} />
            </Card>
          );
        })}
      </div>
    </div>
  );
}
