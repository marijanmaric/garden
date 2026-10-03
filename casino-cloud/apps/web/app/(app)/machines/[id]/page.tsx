'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { ArrowLeft, Lock, RotateCcw, Unlock, Wrench } from 'lucide-react';
import { formatDateTime, formatEuro, formatNumber, timeAgo } from '@m1/ui';
import { api, useApi } from '@/lib/api';
import { useLiveRefresh } from '@/lib/live';
import { useSession } from '@/lib/session';
import { Card, ErrorNote, PageHeader, Stat, StatusBadge } from '@/components/ui';
import { EventFeed } from '@/components/EventFeed';

export default function MachineDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const { data: m, error, reload } = useApi<any>(`/machines/${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useLiveRefresh(() => void reload(), 1500);

  if (!m) return <div className="text-sub">{error ? <ErrorNote error={error} /> : 'Loading machine...'}</div>;

  const command = async (type: string) => {
    setBusy(type);
    try {
      await api(`/machines/${id}/commands`, { method: 'POST', json: { type } });
      setNote(`${type} queued, the gateway executes it on its next heartbeat.`);
      setTimeout(reload, 2500);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const maintenance = async () => {
    setBusy('MAINT');
    try {
      await api(`/machines/${id}/maintenance`, { method: 'PUT', json: { maintenance: !m.maintenance } });
      await reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <Link href="/machines" className="inline-flex items-center gap-1 text-sm text-sub hover:text-fg"><ArrowLeft className="h-4 w-4" /> Machines</Link>
      <PageHeader
        title={`${m.asset_no} · ${m.game}`}
        subtitle={<span className="font-mono">{m.machine_code}</span>}
        actions={
          <>
            <StatusBadge status={m.status} />
            {can('machine.command') && (
              <>
                {m.disabled ? (
                  <button className="btn" disabled={!!busy} onClick={() => command('UNLOCK')}><Unlock className="h-4 w-4" /> Unlock</button>
                ) : (
                  <button className="btn" disabled={!!busy} onClick={() => command('LOCK')}><Lock className="h-4 w-4" /> Lock</button>
                )}
                {m.error_code && <button className="btn" disabled={!!busy} onClick={() => command('RESET_ERROR')}><RotateCcw className="h-4 w-4" /> Reset error</button>}
                {m.status === 'JACKPOT' && <button className="btn" disabled={!!busy} onClick={() => command('RESET_JACKPOT')}>Handpay done</button>}
              </>
            )}
            {can('machine.configure') && (
              <button className="btn" disabled={!!busy} onClick={maintenance}><Wrench className="h-4 w-4" /> {m.maintenance ? 'End maintenance' : 'Maintenance'}</button>
            )}
          </>
        }
      />
      {note && <div className="rounded-lg bg-muted px-3 py-2 text-sm">{note}</div>}

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        <Card title="Machine">
          <Stat label="Manufacturer" value={m.manufacturer} />
          <Stat label="Model" value={m.model} />
          <Stat label="Serial Number" value={m.serial_number} />
          <Stat label="Game" value={m.game} />
          <Stat label="Denomination" value={formatEuro(m.denomination)} />
          <Stat label="Adapter" value={m.adapter_key} />
        </Card>
        <Card title="Location & Communication">
          <Stat label="Floor" value={m.floor_name} />
          <Stat label="Zone" value={m.zone_name ?? '-'} />
          <Stat label="Position" value={m.position_label} />
          <Stat label="Last Communication" value={timeAgo(m.last_communication_at)} />
          <Stat label="Last Error" value={m.last_error ?? '-'} hint={m.last_error_at ? timeAgo(m.last_error_at) : undefined} />
          <Stat label="Conditions" value={[m.door_open && 'Door open', m.cashbox_open && 'Cashbox open', m.printer_error && 'Printer', m.error_code].filter(Boolean).join(', ') || 'OK'} />
        </Card>
        <Card title="Meters (lifetime)">
          <Stat label="Coin In" value={formatEuro(m.coin_in)} />
          <Stat label="Coin Out" value={formatEuro(m.coin_out)} />
          <Stat label="Games Played" value={formatNumber(m.games_played)} />
          <Stat label="Jackpot Wins" value={`${m.jackpot_wins} · ${formatEuro(m.jackpot)}`} />
          <Stat label="Tickets In" value={formatEuro(m.tickets_in)} />
          <Stat label="Tickets Out" value={formatEuro(m.tickets_out)} />
          <Stat label="Cash In" value={formatEuro(m.cash_in)} />
        </Card>
        <Card title="Today & Player">
          <Stat label="Coin In today" value={formatEuro(m.today.coin_in)} />
          <Stat label="GGR today" value={formatEuro(m.today.coin_in - m.today.coin_out - m.today.jackpots)} tone={m.today.coin_in - m.today.coin_out - m.today.jackpots >= 0 ? 'good' : 'bad'} />
          <Stat label="Current Player" value={m.player_name ?? '-'} hint={m.player_tier ?? undefined} />
          <Stat label="Player Card" value={m.player_card ?? '-'} />
          <Stat label="Session since" value={m.session ? timeAgo(m.session.started_at) : '-'} />
          <Stat label="Session Coin In" value={m.session ? formatEuro(m.session.coin_in) : '-'} />
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Event history" className="xl:col-span-2" bodyClass="max-h-[420px] overflow-auto">
          <table className="table">
            <thead><tr><th>Time</th><th>Event</th><th className="text-right">Amount</th><th className="text-right">Win</th><th>Details</th></tr></thead>
            <tbody>
              {m.events.map((e: any) => (
                <tr key={e.event_id}>
                  <td className="text-xs text-sub">{formatDateTime(e.occurred_at)}</td>
                  <td className="font-medium">{e.type}</td>
                  <td className="text-right tabular-nums">{e.amount != null ? formatEuro(e.amount) : ''}</td>
                  <td className="text-right tabular-nums">{e.win ? formatEuro(e.win) : ''}</td>
                  <td className="text-xs text-sub">{e.payload.errorCode ?? e.payload.playerCardId ?? e.payload.message ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <div className="space-y-6">
          <Card title="Live" bodyClass="max-h-64 overflow-y-auto"><EventFeed machineId={m.machine_code} limit={20} /></Card>
          <Card title="Commands">
            {!m.commands.length && <div className="text-sm text-sub">No commands sent yet.</div>}
            {m.commands.map((c: any) => (
              <div key={c.id} className="flex items-center justify-between py-1 text-sm">
                <span>{c.type}</span>
                <span className="text-xs text-sub">{c.status} · {timeAgo(c.created_at)}</span>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}
