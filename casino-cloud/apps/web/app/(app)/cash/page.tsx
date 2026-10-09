'use client';
import { useState } from 'react';
import { formatDateTime, formatEuro } from '@m1/ui';
import { api, useApi } from '@/lib/api';
import { CASH_TX_LABEL } from '@/lib/cashier';
import { useSession } from '@/lib/session';
import { Card, ErrorNote, Field, Kpi, Notice, PageHeader, Stat } from '@/components/ui';
import { clsx } from '@/components/clsx';

function Collection({ onDone }: { onDone: () => void }) {
  const { casino } = useSession();
  const machines = useApi<any[]>(`/machines?casinoId=${casino.id}`);
  const [machineId, setMachineId] = useState('');
  const [exp, setExp] = useState<any>(null);
  const [cash, setCash] = useState('');
  const [tickets, setTickets] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const select = async (id: string) => {
    setMachineId(id);
    setExp(null);
    setMsg(null);
    if (id) setExp(await api(`/cash/collections/expected/${id}`));
  };
  const diff = exp && cash !== '' && tickets !== '' ? Number(cash) + Number(tickets) - exp.cash - exp.tickets : null;
  const save = async () => {
    try {
      const r = await api('/cash/collections', { method: 'POST', json: { machineId, countedCash: Number(cash), countedTickets: Number(tickets), note: note || undefined } });
      setMsg({ tone: r.difference ? 'bad' : 'good', text: r.difference ? `Saved with difference ${formatEuro(r.difference)}, alert raised.` : 'Saved, drop matches the meters.' });
      setCash(''); setTickets(''); setNote(''); setExp(null); setMachineId('');
      onDone();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  };
  return (
    <div className="space-y-3">
      <Field label="Machine">
        <select className="input" value={machineId} onChange={(e) => select(e.target.value)}>
          <option value="">Select machine...</option>
          {machines.data?.map((m) => <option key={m.id} value={m.id}>{m.asset_no} · {m.manufacturer} · {m.floor_name}</option>)}
        </select>
      </Field>
      {exp && (
        <>
          <Notice>Expected since {formatDateTime(exp.since)}: cash <b>{formatEuro(exp.cash)}</b>, tickets <b>{formatEuro(exp.tickets)}</b></Notice>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Counted cash"><input className="input" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} /></Field>
            <Field label="Counted tickets"><input className="input" inputMode="decimal" value={tickets} onChange={(e) => setTickets(e.target.value)} /></Field>
          </div>
          <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          {diff !== null && <Notice tone={Math.abs(diff) < 0.005 ? 'good' : 'bad'}>Difference: {formatEuro(diff)}</Notice>}
          <button className="btn-primary w-full" disabled={cash === '' || tickets === ''} onClick={save}>Save collection</button>
        </>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}

export default function CashPage() {
  const { casino, can } = useSession();
  const { data, error, reload } = useApi<any>(`/cash/overview?casinoId=${casino.id}`, { refreshMs: 10000 });
  return (
    <div className="space-y-6">
      <PageHeader title="Cash Management" subtitle="Drawer movements, outstanding ticket liability and machine drop collections." />
      <ErrorNote error={error} />
      {data && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Kpi label="Cash in drawers" value={formatEuro(data.open.in_drawers)} sub={`${data.open.sessions} open shifts`} />
          <Kpi label="Ticket liability" value={formatEuro(data.tickets.liability)} sub={`${data.tickets.n} valid tickets`} />
          <Kpi label="Net drawer movement today" value={formatEuro(data.today.reduce((s: number, r: any) => s + r.total, 0))} />
          <Kpi label="Collections" value={data.collections.length} sub="latest 50" />
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Drawer movements today">
          {!data?.today.length && <div className="text-sm text-sub">No movements yet today.</div>}
          {data?.today.map((r: any) => <Stat key={r.type} label={`${CASH_TX_LABEL[r.type] ?? r.type} (${r.n})`} value={formatEuro(r.total)} tone={r.total < 0 ? 'bad' : 'good'} />)}
        </Card>
        {can('cash.manage') && <Card title="New drop collection"><Collection onDone={reload} /></Card>}
        <Card title="Recent collections" bodyClass="max-h-[420px] overflow-auto" className={can('cash.manage') ? '' : 'xl:col-span-2'}>
          <table className="table">
            <thead><tr><th>Time</th><th>Machine</th><th className="text-right">Expected</th><th className="text-right">Counted</th><th className="text-right">Diff.</th></tr></thead>
            <tbody>
              {data?.collections.map((c: any) => (
                <tr key={c.id}>
                  <td className="text-xs">{formatDateTime(c.created_at)}<div className="text-sub">{c.collected_by_name}</div></td>
                  <td className="font-semibold">{c.asset_no}</td>
                  <td className="text-right tabular-nums">{formatEuro(c.expected_cash + c.expected_tickets)}</td>
                  <td className="text-right tabular-nums">{formatEuro(c.counted_cash + c.counted_tickets)}</td>
                  <td className={clsx('text-right font-semibold tabular-nums', c.difference ? 'text-red-600 dark:text-red-400' : 'text-emerald-600')}>{formatEuro(c.difference)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
