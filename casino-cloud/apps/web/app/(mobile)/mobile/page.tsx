'use client';
import Link from 'next/link';
import { useState } from 'react';
import { AlertTriangle, ArrowLeft, Coins, Lock, Monitor, Ticket, Trophy, Unlock, User, Wallet } from 'lucide-react';
import { SEVERITY_BADGE, formatEuro, timeAgo } from '@m1/ui';
import { api, useApi } from '@/lib/api';
import { useCashier } from '@/lib/cashier';
import { useLiveRefresh } from '@/lib/live';
import { useSession } from '@/lib/session';
import { Notice, StatusBadge } from '@/components/ui';
import { CashActions, Handpays, ScanButton, ShiftPanel, TicketPayout, TransactionList } from '@/components/cashier';
import { LiveDot } from '@/components/EventFeed';
import { clsx } from '@/components/clsx';

type Tab = 'ticket' | 'handpay' | 'player' | 'cash' | 'machines' | 'alerts' | 'shift';

function PlayerLookup() {
  const [card, setCard] = useState('');
  const [result, setResult] = useState<any[] | null>(null);
  const search = async (c = card) => setResult(await api(`/players?search=${encodeURIComponent(c.trim())}`));
  return (
    <div className="space-y-3">
      <form onSubmit={(e) => { e.preventDefault(); void search(); }} className="flex gap-2">
        <input className="input py-4 text-lg" placeholder="Player card or name" value={card} onChange={(e) => setCard(e.target.value)} />
        <button className="btn-primary px-6 text-base">Find</button>
        <ScanButton large onScan={(c) => { setCard(c); void search(c); }} />
      </form>
      {result && !result.length && <Notice tone="bad">No player found.</Notice>}
      {result?.slice(0, 5).map((p) => (
        <div key={p.id} className="card p-4">
          <div className="flex items-center justify-between">
            <div className="text-xl font-bold">{p.first_name} {p.last_name}</div>
            <span className="badge bg-brand/10 text-brand ring-brand/30">{p.tier}</span>
          </div>
          <div className="font-mono text-sm text-sub">{p.card_number}</div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-muted p-2"><div className="text-xs text-sub">Points</div><div className="text-lg font-bold">{p.points}</div></div>
            <div className="rounded-lg bg-muted p-2"><div className="text-xs text-sub">Coin In</div><div className="text-lg font-bold">{formatEuro(p.total_coin_in, true)}</div></div>
            <div className="rounded-lg bg-muted p-2"><div className="text-xs text-sub">Playing</div><div className="text-lg font-bold">{p.current_machine ?? '-'}</div></div>
          </div>
          <div className="mt-2 text-xs text-sub">{p.visits} visits · last {timeAgo(p.last_visit_at)} · Wallet balance arrives with Cashless (Phase 3)</div>
        </div>
      ))}
    </div>
  );
}

function MachineService() {
  const { casino, can } = useSession();
  const list = useApi<any[]>(can('machine.view') ? `/machines?casinoId=${casino.id}` : null);
  const [msg, setMsg] = useState<string | null>(null);
  useLiveRefresh(() => void list.reload(), 2000, ['machine.status']);
  if (!can('machine.view')) return <Notice>Your role has no machine access.</Notice>;
  const attention = (list.data ?? []).filter((m) => m.status !== 'ONLINE');
  const command = async (id: string, type: string) => {
    try { await api(`/machines/${id}/commands`, { method: 'POST', json: { type } }); setMsg(`${type} sent`); } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <div className="space-y-2">
      {msg && <Notice>{msg}</Notice>}
      <div className="text-sm text-sub">{attention.length} machines need attention</div>
      {attention.map((m) => (
        <div key={m.id} className="card flex items-center gap-3 p-3">
          <div className="flex-1">
            <div className="text-lg font-bold">{m.asset_no} <span className="text-xs font-normal text-sub">{m.manufacturer} · {m.floor_name} {m.position_label}</span></div>
            <div className="mt-1 flex items-center gap-2"><StatusBadge status={m.status} /><span className="text-xs text-sub">{m.error_code ?? (m.door_open ? 'Door open' : m.cashbox_open ? 'Cashbox open' : m.printer_error ? 'Printer' : '')}</span></div>
          </div>
          {can('machine.command') && (m.disabled
            ? <button className="btn px-4 py-3" onClick={() => command(m.id, 'UNLOCK')}><Unlock className="h-5 w-5" /></button>
            : <button className="btn px-4 py-3" onClick={() => command(m.id, 'LOCK')}><Lock className="h-5 w-5" /></button>)}
        </div>
      ))}
    </div>
  );
}

function Alerts() {
  const { casino, can } = useSession();
  const list = useApi<any[]>(`/alerts?casinoId=${casino.id}`);
  useLiveRefresh(() => void list.reload(), 1000, ['alert.created', 'alert.updated']);
  return (
    <div className="space-y-2">
      {!list.data?.length && <div className="py-6 text-center text-sub">No active alerts.</div>}
      {list.data?.map((a) => (
        <div key={a.id} className="card flex items-center gap-3 p-3">
          <span className={clsx('badge', SEVERITY_BADGE[a.severity])}>{a.severity}</span>
          <div className="flex-1"><div className="font-medium">{a.message}</div><div className="text-xs text-sub">{timeAgo(a.created_at)} · {a.status}</div></div>
          {can('alert.manage') && a.status === 'OPEN' && (
            <button className="btn px-4 py-3" onClick={async () => { await api(`/alerts/${a.id}/acknowledge`, { method: 'POST' }); void list.reload(); }}>Ack</button>
          )}
        </div>
      ))}
    </div>
  );
}

const TABS: Array<{ key: Tab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'ticket', label: 'Ticket', icon: Ticket },
  { key: 'handpay', label: 'Handpay', icon: Trophy },
  { key: 'cash', label: 'Cash', icon: Coins },
  { key: 'player', label: 'Player', icon: User },
  { key: 'machines', label: 'Machines', icon: Monitor },
  { key: 'alerts', label: 'Alerts', icon: AlertTriangle },
  { key: 'shift', label: 'Shift', icon: Wallet },
];

export default function MobileCashierPage() {
  const { me, casino, can } = useSession();
  const cashier = useCashier();
  const [tab, setTab] = useState<Tab>('ticket');
  if (!can('cash.transact')) return <div className="p-6"><Notice tone="bad">Your role cannot use the mobile cashier.</Notice></div>;
  const s = cashier.session;

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-panel px-4 py-3">
        <Link href="/cashier" className="btn px-3 py-3" aria-label="Back"><ArrowLeft className="h-5 w-5" /></Link>
        <div className="flex-1 leading-tight">
          <div className="text-xs font-bold tracking-widest text-brand">MOBILE CASHIER</div>
          <div className="text-sm text-sub">{casino.name} · {me.user.name}</div>
        </div>
        <LiveDot />
        <button onClick={() => setTab('shift')} className={clsx('rounded-xl px-4 py-2 text-right', s ? 'bg-emerald-500/10' : 'bg-red-500/10')}>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-sub">{s ? s.desk_name : 'No shift'}</div>
          <div className="text-xl font-bold tabular-nums">{s ? formatEuro(s.expected) : 'Open shift'}</div>
        </button>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 p-4 pb-28">
        {!s && tab !== 'shift' && tab !== 'player' && tab !== 'machines' && tab !== 'alerts' && (
          <div className="mb-4"><Notice tone="bad">No open shift: open one under Shift before paying.</Notice></div>
        )}
        {tab === 'ticket' && <TicketPayout cashier={cashier} big />}
        {tab === 'handpay' && <Handpays cashier={cashier} big />}
        {tab === 'cash' && <CashActions cashier={cashier} big />}
        {tab === 'player' && <PlayerLookup />}
        {tab === 'machines' && <MachineService />}
        {tab === 'alerts' && <Alerts />}
        {tab === 'shift' && (
          <div className="space-y-6">
            <div className="card p-4"><ShiftPanel cashier={cashier} big /></div>
            {s && <div className="card px-4 py-2"><TransactionList items={cashier.transactions} /></div>}
          </div>
        )}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-7 border-t border-line bg-panel pb-[env(safe-area-inset-bottom)]">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} className={clsx('flex flex-col items-center gap-1 py-3 text-[11px] font-medium', tab === t.key ? 'text-brand' : 'text-sub')}>
            <t.icon className="h-6 w-6" />
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
