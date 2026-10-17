'use client';
import { useState } from 'react';
import { formatEuro, formatNumber, timeAgo } from '@m1/ui';
import { ApiError, api, useApi } from '@/lib/api';
import { Card, ErrorNote, Notice, PageHeader } from '@/components/ui';
import { PlayerWalletCard, type PlayerLookup } from '@/components/player-wallet';

/** Step 7e: player / card lookup with the CASHLESS wallet (balances and history from the ledger). */
function CardLookup({ initial }: { initial?: string }) {
  const [card, setCard] = useState(initial ?? '');
  const [p, setP] = useState<PlayerLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const look = async (c = card) => {
    setError(null); setP(null);
    if (!c.trim()) return;
    try { setP(await api(`/players/lookup/${encodeURIComponent(c.trim())}`)); } catch (e) { setError(e instanceof ApiError && e.status === 404 ? 'Unknown player card' : (e as Error).message); }
  };
  return (
    <Card title="Player card lookup">
      <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void look(); }}>
        <input className="input max-w-xs font-mono" placeholder="Scan or type player card" value={card} onChange={(e) => setCard(e.target.value)} data-testid="player-card-input" />
        <button className="btn-primary" data-testid="player-card-go">Look up</button>
      </form>
      {error && <Notice tone="bad">{error}</Notice>}
      {p && <PlayerWalletCard p={p} />}
    </Card>
  );
}

const TIER: Record<string, string> = { BRONZE: 'text-orange-700 dark:text-orange-400', SILVER: 'text-slate-500', GOLD: 'text-yellow-600', PLATINUM: 'text-cyan-600', VIP: 'text-fuchsia-600' };

export default function PlayersPage() {
  const [search, setSearch] = useState('');
  const { data, error } = useApi<any[]>(`/players${search ? `?search=${encodeURIComponent(search)}` : ''}`, { refreshMs: 5000 });
  return (
    <div>
      <PageHeader title="Players" subtitle="Player accounts, cards and CASHLESS wallets. Loyalty rules, rewards and the player app follow in Phase 3." />
      <ErrorNote error={error} />
      <div className="mb-6"><CardLookup /></div>
      <input className="input mb-4 max-w-xs" placeholder="Search name or card..." value={search} onChange={(e) => setSearch(e.target.value)} />
      <Card bodyClass="overflow-x-auto">
        <table className="table">
          <thead><tr><th>Card</th><th>Name</th><th>Status</th><th>Tier</th><th className="text-right">Points</th><th className="text-right">Bets</th><th className="text-right">Visits</th><th>Last visit</th><th>Now playing</th></tr></thead>
          <tbody>
            {data?.map((p) => (
              <tr key={p.id}>
                <td className="font-mono text-xs">{p.card_number}</td>
                <td>{p.first_name} {p.last_name}</td>
                <td className="text-xs">{p.status}{p.card_status && p.card_status !== 'ACTIVE' ? ` · card ${p.card_status}` : ''}</td>
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
