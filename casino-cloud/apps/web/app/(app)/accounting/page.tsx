'use client';
import Link from 'next/link';
import { useState } from 'react';
import { LEDGER_TYPES } from '@m1/shared';
import { formatDateTime, formatEuro, formatNumber } from '@m1/ui';
import { api, useApi } from '@/lib/api';
import { useLiveRefresh } from '@/lib/live';
import { useSession } from '@/lib/session';
import { BarChart, Card, ErrorNote, Kpi, PageHeader } from '@/components/ui';

const PERIODS = [[1, 'Today'], [7, '7 days'], [30, '30 days']] as const;

export default function AccountingPage() {
  const { casino, can } = useSession();
  const [days, setDays] = useState(1);
  const [type, setType] = useState('');
  const sum = useApi<any>(`/accounting/summary?casinoId=${casino.id}&days=${days}`);
  const tx = useApi<any[]>(`/transactions?casinoId=${casino.id}&limit=100${type ? `&type=${type}` : ''}`);
  useLiveRefresh(() => { void sum.reload(); void tx.reload(); }, 3000, ['machine.event']);
  const s = sum.data?.summary;

  const adjust = async () => {
    const amount = Number(prompt('Adjustment amount in EUR (negative to reduce)', '-10'));
    if (!amount) return;
    const reason = prompt('Reason (mandatory, stored in the audit log)');
    if (!reason) return;
    try {
      await api('/transactions/adjustments', { method: 'POST', json: { casinoId: casino.id, amount, reason } });
      await Promise.all([sum.reload(), tx.reload()]);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Accounting"
        subtitle="Immutable ledger. Corrections are appended as adjustments, never edited."
        actions={
          <>
            {PERIODS.map(([d, l]) => (
              <button key={d} onClick={() => setDays(d)} className={days === d ? 'btn-primary' : 'btn'}>{l}</button>
            ))}
            {can('casino.manage') && <button className="btn" onClick={adjust}>+ Adjustment</button>}
          </>
        }
      />
      <ErrorNote error={sum.error} />
      {s && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-8">
          <Kpi label="Coin In" value={formatEuro(s.coinIn, true)} />
          <Kpi label="Coin Out" value={formatEuro(s.coinOut, true)} />
          <Kpi label="Jackpots" value={formatEuro(s.jackpots, true)} />
          <Kpi label="GGR" value={formatEuro(s.ggr, true)} sub={`Hold ${s.coinIn ? ((s.ggr / s.coinIn) * 100).toFixed(2) : 0}%`} />
          <Kpi label="NGR" value={formatEuro(s.ngr, true)} sub={`Adj. ${formatEuro(s.adjustments)}`} />
          <Kpi label="Tickets In" value={formatEuro(s.ticketsIn, true)} />
          <Kpi label="Tickets Out" value={formatEuro(s.ticketsOut, true)} />
          <Kpi label="Cash In" value={formatEuro(s.cashIn, true)} />
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="GGR per day · last 14 days">
          {sum.data && <BarChart height={170} format={(n) => formatEuro(n)} color="#10b981" data={sum.data.daily.map((d: any) => ({ label: String(d.day).slice(5, 10), value: d.ggr }))} />}
        </Card>
        <Card title="Per machine" bodyClass="max-h-[260px] overflow-auto">
          <table className="table">
            <thead><tr><th>Asset</th><th>Manufacturer</th><th className="text-right">Coin In</th><th className="text-right">Coin Out</th><th className="text-right">GGR</th></tr></thead>
            <tbody>
              {sum.data?.byMachine.map((m: any) => (
                <tr key={m.id}>
                  <td><Link className="font-semibold text-brand" href={`/machines/${m.id}`}>{m.asset_no}</Link></td>
                  <td>{m.manufacturer}</td>
                  <td className="text-right tabular-nums">{formatEuro(m.coin_in)}</td>
                  <td className="text-right tabular-nums">{formatEuro(m.coin_out)}</td>
                  <td className="text-right tabular-nums">{formatEuro(m.ggr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      <Card
        title="Ledger (latest 100)"
        bodyClass="overflow-x-auto"
        actions={
          <select className="input w-auto py-1 text-xs" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            {LEDGER_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        }
      >
        <table className="table">
          <thead><tr><th>#</th><th>Occurred</th><th>Type</th><th>Machine</th><th className="text-right">Amount</th><th>Reference</th><th>Source event</th></tr></thead>
          <tbody>
            {tx.data?.map((t) => (
              <tr key={t.id}>
                <td className="font-mono text-xs text-sub">{formatNumber(t.id)}</td>
                <td className="text-xs">{formatDateTime(t.occurred_at)}</td>
                <td className="font-medium">{t.type}</td>
                <td>{t.asset_no ?? '-'}</td>
                <td className="text-right tabular-nums">{formatEuro(t.amount)}</td>
                <td className="text-xs text-sub">{t.reference ?? ''}{t.created_by ? ` · ${t.created_by}` : ''}</td>
                <td className="font-mono text-[10px] text-sub">{t.source_event_id?.slice(0, 8) ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
