'use client';
import { useState } from 'react';
import { formatEuro, formatNumber, timeAgo } from '@m1/ui';
import { useApi } from '@/lib/api';
import { Card, ErrorNote, PageHeader } from '@/components/ui';

const TIER: Record<string, string> = { BRONZE: 'text-orange-700 dark:text-orange-400', SILVER: 'text-slate-500', GOLD: 'text-yellow-600', PLATINUM: 'text-cyan-600', VIP: 'text-fuchsia-600' };

export default function PlayersPage() {
  const [search, setSearch] = useState('');
  const { data, error } = useApi<any[]>(`/players${search ? `?search=${encodeURIComponent(search)}` : ''}`, { refreshMs: 5000 });
  return (
    <div>
      <PageHeader title="Players" subtitle="Player accounts. Loyalty rules, rewards and the player app follow in Phase 3." />
      <ErrorNote error={error} />
      <input className="input mb-4 max-w-xs" placeholder="Search name or card..." value={search} onChange={(e) => setSearch(e.target.value)} />
      <Card bodyClass="overflow-x-auto">
        <table className="table">
          <thead><tr><th>Card</th><th>Name</th><th>Tier</th><th className="text-right">Points</th><th className="text-right">Coin In</th><th className="text-right">Visits</th><th>Last visit</th><th>Now playing</th></tr></thead>
          <tbody>
            {data?.map((p) => (
              <tr key={p.id}>
                <td className="font-mono text-xs">{p.card_number}</td>
                <td>{p.first_name} {p.last_name}</td>
                <td className={`text-xs font-bold ${TIER[p.tier]}`}>{p.tier}</td>
                <td className="text-right tabular-nums">{formatNumber(p.points)}</td>
                <td className="text-right tabular-nums">{formatEuro(p.total_coin_in)}</td>
                <td className="text-right">{p.visits}</td>
                <td className="text-xs text-sub">{timeAgo(p.last_visit_at)}</td>
                <td>{p.current_machine ? <span className="badge bg-sky-500/15 text-sky-600 ring-sky-500/30">{p.current_machine}</span> : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
