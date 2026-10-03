'use client';
import Link from 'next/link';
import { AlertTriangle, Coins, Monitor, Router, TrendingUp, Trophy, Users } from 'lucide-react';
import { formatDateTime, formatEuro, formatNumber, statusColor, timeAgo, SEVERITY_BADGE } from '@m1/ui';
import { useApi } from '@/lib/api';
import { useLiveRefresh } from '@/lib/live';
import { useSession } from '@/lib/session';
import { BarChart, Card, Empty, ErrorNote, Kpi, PageHeader, Stat, StatusBadge } from '@/components/ui';
import { EventFeed } from '@/components/EventFeed';
import { clsx } from '@/components/clsx';

export default function DashboardPage() {
  const { casino, can } = useSession();
  const { data: d, error, reload } = useApi<any>(`/dashboard?casinoId=${casino.id}`, { refreshMs: 15000 });
  const floors = useApi<any[]>(can('floor.view') ? `/floors?casinoId=${casino.id}` : null);
  useLiveRefresh(() => {
    void reload();
    void floors.reload();
  }, 2000);

  if (!d) return <div className="text-sub">{error ? <ErrorNote error={error} /> : 'Loading dashboard...'}</div>;
  const m = d.machines;
  const f = d.financial;
  const critical = d.alerts.filter((a: any) => a.severity === 'CRITICAL').length;

  return (
    <div className="space-y-6">
      <PageHeader title="Casino Overview" subtitle={`${casino.name} · ${casino.city} · Business day figures in ${casino.timezone}`} />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Machines" icon={Monitor} value={`${m.online}/${m.total}`} sub={`${m.offline} offline · ${m.maintenance} maintenance`} />
        <Kpi label="Coin In" icon={Coins} value={formatEuro(f.coinIn, true)} sub={`${formatNumber(f.gamesPlayed)} games today`} />
        <Kpi label="GGR" icon={TrendingUp} value={formatEuro(f.ggr, true)} accent="bg-emerald-500/10 text-emerald-600" sub={`Hold ${f.coinIn ? ((f.ggr / f.coinIn) * 100).toFixed(1) : '0.0'}%`} />
        <Kpi label="Active Sessions" icon={Users} value={formatNumber(d.players.activeSessions)} sub={`${d.players.playersToday} players today`} accent="bg-sky-500/10 text-sky-600" />
        <Kpi label="Jackpots" icon={Trophy} value={formatEuro(d.jackpots.totalValue, true)} sub={`${d.jackpots.active} active`} accent="bg-yellow-500/10 text-yellow-600" />
        <Kpi label="Alerts" icon={AlertTriangle} value={d.alerts.length} sub={`${critical} critical`} accent={critical ? 'bg-red-500/10 text-red-600' : undefined} />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Coin In · last 24 hours" className="xl:col-span-2">
          <BarChart
            height={250}
            format={(n) => formatEuro(n)}
            data={d.hourly.map((h: any) => ({ label: new Date(h.hour).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }), value: h.coin_in }))}
          />
        </Card>
        <Card title="Machines">
          <Stat label="Total Machines" value={m.total} />
          <Stat label="Online" value={m.online} tone="good" />
          <Stat label="Offline" value={m.offline} tone={m.offline ? 'bad' : undefined} />
          <Stat label="Maintenance" value={m.maintenance} />
          <Stat label="Warning" value={m.warning} tone={m.warning ? 'warn' : undefined} />
          <Stat label="Error" value={m.error} tone={m.error ? 'bad' : undefined} />
          <Stat label="Jackpot (handpay)" value={m.jackpot} />
          <Stat label="Disabled" value={m.disabled} />
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Live Machine Status" className="xl:col-span-2" actions={<Link href="/floor" className="text-xs font-medium text-brand">Floor map →</Link>}>
          {floors.data ? (
            <div className="space-y-4">
              {floors.data.map((fl: any) => (
                <div key={fl.id}>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-sub">{fl.name}</div>
                  <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8 xl:grid-cols-10">
                    {fl.machines.map((mc: any) => {
                      const c = statusColor(mc.status);
                      return (
                        <Link key={mc.id} href={`/machines/${mc.id}`} title={`${mc.asset_no} · ${mc.manufacturer} · ${mc.status}`}
                          className="rounded-lg border border-line p-2 text-center transition hover:scale-105" style={{ background: `${c.hex}1f`, borderColor: `${c.hex}66` }}>
                          <div className="text-xs font-bold">{mc.asset_no}</div>
                          <div className="truncate text-[10px] text-sub">{mc.manufacturer}</div>
                          <div className="mx-auto mt-1 h-1.5 w-6 rounded-full" style={{ background: c.hex }} />
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty>No floor access</Empty>
          )}
        </Card>
        <Card title="Live Events" bodyClass="max-h-[340px] overflow-y-auto" actions={<Link href="/simulation" className="text-xs font-medium text-brand">Simulation →</Link>}>
          <EventFeed limit={40} />
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        <Card title="Financial · today">
          <Stat label="Coin In" value={formatEuro(f.coinIn)} />
          <Stat label="Coin Out" value={formatEuro(f.coinOut)} />
          <Stat label="Jackpots" value={formatEuro(f.jackpots)} />
          <Stat label="GGR" value={formatEuro(f.ggr)} tone={f.ggr >= 0 ? 'good' : 'bad'} />
          <Stat label="Tickets Out" value={formatEuro(f.ticketsOut)} />
          <Stat label="Tickets In" value={formatEuro(f.ticketsIn)} />
          <Stat label="Cash In" value={formatEuro(f.cashIn)} />
        </Card>
        <Card title="Players">
          <Stat label="Active Sessions" value={d.players.activeSessions} />
          <Stat label="Players today" value={d.players.playersToday} />
          <Stat label="Registered" value={formatNumber(d.players.registered)} />
          <Stat label="Loyalty Points" value={formatNumber(d.players.loyaltyPoints)} />
        </Card>
        <Card title="Jackpots" actions={<Link href="/jackpots" className="text-xs font-medium text-brand">All →</Link>}>
          {d.jackpots.items.slice(0, 5).map((j: any) => (
            <Stat key={j.id} label={j.name} value={formatEuro(j.current_value)} hint={j.type} />
          ))}
        </Card>
        <Card title="Active Alerts" bodyClass="max-h-64 overflow-y-auto" actions={<Link href="/alerts" className="text-xs font-medium text-brand">All →</Link>}>
          {!d.alerts.length && <Empty>No active alerts</Empty>}
          {d.alerts.slice(0, 8).map((a: any) => (
            <div key={a.id} className="flex items-center gap-2 border-b border-line/60 py-1.5 text-sm last:border-0">
              <span className={clsx('badge', SEVERITY_BADGE[a.severity])}>{a.severity[0]}</span>
              <span className="flex-1 truncate">{a.message}</span>
              <span className="text-xs text-sub">{timeAgo(a.created_at)}</span>
            </div>
          ))}
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        <Card title="Top Machines · today" bodyClass="">
          <table className="table">
            <tbody>
              {d.topMachines.map((t: any) => (
                <tr key={t.id}>
                  <td><Link href={`/machines/${t.id}`} className="font-semibold">{t.asset_no}</Link><div className="text-xs text-sub">{t.manufacturer}</div></td>
                  <td className="text-right tabular-nums">{formatEuro(t.coin_in, true)}<div className="text-xs text-sub">GGR {formatEuro(t.ggr, true)}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Top Players" bodyClass="">
          <table className="table">
            <tbody>
              {d.topPlayers.map((p: any) => (
                <tr key={p.id}>
                  <td>{p.first_name} {p.last_name}<div className="text-xs text-sub">{p.card_number} · {p.tier}</div></td>
                  <td className="text-right tabular-nums">{formatEuro(p.total_coin_in, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Recent Transactions" bodyClass="max-h-72 overflow-y-auto">
          {d.recentTransactions.map((t: any) => (
            <div key={t.id} className="flex items-center gap-2 py-1 text-sm">
              <span className="w-10 font-semibold">{t.asset_no ?? '-'}</span>
              <span className="flex-1 text-xs text-sub">{t.type}</span>
              <span className="tabular-nums">{formatEuro(t.amount)}</span>
            </div>
          ))}
        </Card>
        <Card title="Gateways & Cashier">
          {d.gateways.map((g: any) => (
            <div key={g.id} className="flex items-center gap-2 py-1 text-sm">
              <Router className="h-4 w-4 text-sub" />
              <span className="flex-1">{g.device_id}</span>
              <StatusBadge status={g.status} />
            </div>
          ))}
          <div className="mt-3 rounded-lg bg-muted p-3 text-xs text-sub">
            Cashier status arrives with the Cashier module (Phase 2). Last gateway heartbeat: {formatDateTime(d.gateways[0]?.last_heartbeat_at)}
          </div>
        </Card>
      </div>
    </div>
  );
}
