'use client';
import Link from 'next/link';
import { useState } from 'react';
import { MACHINE_STATUSES } from '@m1/shared';
import { formatEuro, formatNumber, timeAgo } from '@m1/ui';
import { useApi } from '@/lib/api';
import { useLiveRefresh } from '@/lib/live';
import { useSession } from '@/lib/session';
import { Card, ErrorNote, PageHeader, StatusBadge } from '@/components/ui';

export default function MachinesPage() {
  const { casino } = useSession();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const qs = new URLSearchParams({ casinoId: casino.id, ...(status && { status }), ...(search && { search }) });
  const { data, error, reload } = useApi<any[]>(`/machines?${qs}`);
  useLiveRefresh(() => void reload(), 3000);

  return (
    <div>
      <PageHeader title="Machines" subtitle="All gaming machines of this casino, with live status and cumulative meters." />
      <ErrorNote error={error} />
      <div className="mb-4 flex flex-wrap gap-2">
        <input className="input max-w-xs" placeholder="Search asset, ID, game, manufacturer..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {MACHINE_STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <Card bodyClass="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Asset</th><th>Machine ID</th><th>Manufacturer / Model</th><th>Game</th><th>Location</th><th>Status</th>
              <th className="text-right">Coin In</th><th className="text-right">Coin Out</th><th className="text-right">Games</th><th>Player</th><th>Last comm.</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((m) => (
              <tr key={m.id}>
                <td><Link href={`/machines/${m.id}`} className="font-semibold text-brand">{m.asset_no}</Link></td>
                <td className="font-mono text-xs">{m.machine_code}</td>
                <td>{m.manufacturer}<div className="text-xs text-sub">{m.model}</div></td>
                <td>{m.game}<div className="text-xs text-sub">Denom {formatEuro(m.denomination)}</div></td>
                <td>{m.floor_name}<div className="text-xs text-sub">{m.position_label}</div></td>
                <td><StatusBadge status={m.status} /></td>
                <td className="text-right tabular-nums">{formatEuro(m.coin_in)}</td>
                <td className="text-right tabular-nums">{formatEuro(m.coin_out)}</td>
                <td className="text-right tabular-nums">{formatNumber(m.games_played)}</td>
                <td className="text-xs">{m.player_card ?? <span className="text-sub">-</span>}</td>
                <td className="text-xs text-sub">{timeAgo(m.last_communication_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
