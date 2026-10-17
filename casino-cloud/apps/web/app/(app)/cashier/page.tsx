'use client';
import Link from 'next/link';
import { Smartphone } from 'lucide-react';
import { formatDateTime, formatEuro, timeAgo } from '@m1/ui';
import { useApi } from '@/lib/api';
import { useCashier } from '@/lib/cashier';
import { useSession } from '@/lib/session';
import { Card, PageHeader } from '@/components/ui';
import { CashActions, Handpays, ShiftPanel, TicketPayout, TransactionList } from '@/components/cashier';
import { clsx } from '@/components/clsx';
import { LedgerWorkstation } from '@/components/ledger-cashier';
import { RailBadge, useOperatorContext } from '@/components/money-ui';

function Workstation() {
  const { sees } = useSession();
  const cashier = useCashier();
  if (cashier.loading) return <div className="text-sub">Loading shift...</div>;
  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <div className="space-y-6">
        <Card title="My shift"><ShiftPanel cashier={cashier} /></Card>
        <Card title="Shift transactions" bodyClass="max-h-96 overflow-y-auto px-4 py-2"><TransactionList items={cashier.transactions} /></Card>
      </div>
      <div className="space-y-6">
        {sees('tito.cashier') && <Card title="Ticket payout"><TicketPayout cashier={cashier} /></Card>}
        {sees('handpay.pay') && <Card title="Jackpot handpays"><Handpays cashier={cashier} /></Card>}
      </div>
      <Card title="Cash & tickets"><CashActions cashier={cashier} /></Card>
    </div>
  );
}

function Supervisor() {
  const { casino } = useSession();
  const desks = useApi<any[]>(`/cashier/desks?casinoId=${casino.id}`, { refreshMs: 5000 });
  const sessions = useApi<any[]>(`/cashier/sessions?casinoId=${casino.id}`, { refreshMs: 10000 });
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        {desks.data?.map((d) => (
          <div key={d.id} className="card p-4">
            <div className="flex items-center justify-between">
              <span className="font-semibold">{d.name}</span>
              <span className={clsx('badge', d.session_id ? 'bg-emerald-500/15 text-emerald-600 ring-emerald-500/30' : 'bg-slate-500/15 text-slate-500 ring-slate-500/30')}>{d.session_id ? 'OPEN' : 'CLOSED'}</span>
            </div>
            <div className="mt-1 text-xs text-sub">{d.kind === 'MOBILE' ? 'Mobile device' : 'Cage desk'}</div>
            {d.session_id ? (
              <>
                <div className="mt-3 text-2xl font-bold tabular-nums">{d.balance === null ? 'blind' : formatEuro(d.balance)}</div>
                <div className="text-xs text-sub">{d.employee} · since {timeAgo(d.opened_at)} · {d.transactions} transactions</div>
              </>
            ) : (
              <div className="mt-3 text-sm text-sub">Closed</div>
            )}
          </div>
        ))}
      </div>
      <Card title="Shift history" bodyClass="overflow-x-auto">
        <table className="table">
          <thead><tr><th>Opened</th><th>Closed</th><th>Desk</th><th>Employee</th><th className="text-right">Opening</th><th className="text-right">Expected</th><th className="text-right">Counted</th><th className="text-right">Difference</th></tr></thead>
          <tbody>
            {sessions.data?.map((s) => (
              <tr key={s.id}>
                <td className="text-xs">{formatDateTime(s.opened_at)}</td>
                <td className="text-xs">{s.closed_at ? formatDateTime(s.closed_at) : <span className="font-semibold text-emerald-600">open</span>}</td>
                <td>{s.desk}</td>
                <td>{s.employee}</td>
                <td className="text-right tabular-nums">{formatEuro(s.opening_balance)}</td>
                <td className="text-right tabular-nums">{s.expected_balance === null && s.current_balance === null ? 'blind' : formatEuro(s.expected_balance ?? s.current_balance)}</td>
                <td className="text-right tabular-nums">{s.counted_balance != null ? formatEuro(s.counted_balance) : '-'}</td>
                <td className={clsx('text-right font-semibold tabular-nums', s.difference ? 'text-red-600 dark:text-red-400' : '')}>{s.difference != null ? formatEuro(s.difference) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export default function CashierPage() {
  const { can } = useSession();
  const ctx = useOperatorContext();
  const ledger = ctx.data?.rails.CASH === 'LEDGER';
  return (
    <div className="space-y-8">
      <PageHeader
        title="Cashier"
        subtitle="Cage workstation: shifts, TITO, HANDPAY and CASHLESS wallet. Every movement is immutable and audited."
        actions={<>
          {ctx.data && <span className="text-xs text-sub">CASH rail <RailBadge mode={ctx.data.rails.CASH} /></span>}
          {can('cash.transact') && <Link href="/mobile" className="btn"><Smartphone className="h-4 w-4" /> Mobile Cashier</Link>}
        </>}
      />
      {can('cash.transact') && ctx.data && (ledger ? <LedgerWorkstation /> : <Workstation />)}
      {can('cashier.supervise') && (
        <div>
          <h2 className="mb-4 text-lg font-semibold">Cash desks overview</h2>
          <Supervisor />
        </div>
      )}
    </div>
  );
}
