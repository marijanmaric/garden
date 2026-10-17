'use client';
import { useState } from 'react';
import { CheckCircle2, Lock, XCircle } from 'lucide-react';
import { formatDateTime, timeAgo } from '@m1/ui';
import { useApi } from '@/lib/api';
import { MACHINE_MONEY_LABEL, describeItem, formatCents } from '@/lib/money';
import { useSession } from '@/lib/session';
import { DeferredEvents, EventExceptions, ExplainButton } from '@/components/money-admin';
import { useConfirm } from '@/components/money-ui';
import { Card, Empty, ErrorNote, Field, Notice, PageHeader } from '@/components/ui';
import { clsx } from '@/components/clsx';

/**
 * Step 7e, reconciliation: the latest run per rail (CASH / VAULT, TITO, HANDPAY, CASHLESS, MACHINE, global
 * invariants) with every open item, ledger <-> meters per machine, unresolved late events and exceptions,
 * and exactly what blocks the business-day close. Runs and closes go through the guarded API.
 */

const RAIL_ORDER = ['CASH', 'VAULT', 'TITO', 'HANDPAY', 'CASHLESS', 'MACHINE', 'GLOBAL'];

function DayClose({ status, reload }: { status: any; reload: () => void }) {
  const { casino, can } = useSession();
  const [date, setDate] = useState('');
  const confirm = useConfirm(reload);
  const run = useConfirm(reload);
  const target = date || status?.openDates?.[status.openDates.length - 1] || '';
  return (
    <div className="space-y-3" data-testid="day-close">
      <div className={clsx('flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold', status?.canClose ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-red-500/10 text-red-600 dark:text-red-400')} data-testid="day-close-state">
        {status?.canClose ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
        {status?.canClose ? 'Nothing blocks the business-day close (a fresh reconciliation runs at close).' : `Business-day close is blocked (${status?.blockers?.length ?? 0})`}
      </div>
      {status?.blockers?.map((b: any, i: number) => <div key={i} className="text-sm" data-testid="day-close-blocker"><span className="font-mono text-xs text-sub">{b.code}</span> {b.message}</div>)}
      <div className="text-xs text-sub">Today: {status?.today} · last closed: {status?.closed?.[0]?.business_date ?? 'none'} · open past dates with money: {status?.openDates?.join(', ') || 'none'}</div>
      <div className="flex flex-wrap gap-2">
        <button className="btn" data-testid="run-reconciliation" onClick={() => run.ask({
          title: 'Run reconciliation now', summary: 'Checks every rail on the ledger. A CRITICAL mismatch raises an alert and freezes the affected rail (per machine for MACHINE).',
          path: '/money/reconciliation', body: { casinoId: casino.id }, describe: (d) => (d.ok ? 'Clean run.' : `Mismatch in ${d.checks.filter((c: any) => !c.ok).length} check(s).`),
        })}>Run reconciliation</button>
        {can('cash.manage') && (
          <>
            <Field label=""><input className="input" type="date" value={target} onChange={(e) => setDate(e.target.value)} data-testid="close-date" /></Field>
            <button className="btn-primary" disabled={!target} data-testid="close-day" onClick={() => confirm.ask({
              title: `Close business day ${target}`, summary: 'Only a past date, nothing frozen, no unprocessed deferred event and a clean reconciliation. Afterwards this date takes no money transaction.',
              details: [['Business date', target]], path: '/money/day-close', body: { casinoId: casino.id, businessDate: target }, danger: true, confirmLabel: 'Close day',
              describe: () => `Business date ${target} closed.`,
            })}>Close business day</button>
          </>
        )}
      </div>
      {confirm.dialog}{run.dialog}
    </div>
  );
}

function Meters() {
  const { casino } = useSession();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = new URLSearchParams({ casinoId: casino.id, ...(from ? { from } : {}), ...(to ? { to } : {}) });
  const m = useApi<any>(`/money/reconciliation/meters?${q}`, { refreshMs: 15000 });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 px-4 pt-4">
        <Field label="From"><input className="input" type="date" value={from || m.data?.from || ''} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input className="input" type="date" value={to || m.data?.to || ''} onChange={(e) => setTo(e.target.value)} /></Field>
        {m.data && <span className={clsx('badge', m.data.ok ? 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/30' : 'bg-red-500/15 text-red-600 ring-red-500/30')} data-testid="meters-state">{m.data.ok ? 'LEDGER = METERS' : 'UNEXPLAINED DIFFERENCE'}</span>}
      </div>
      {!m.data?.machines?.length ? <Empty>No machine on the MACHINE ledger.</Empty> : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Machine</th><th>Money</th><th className="text-right">Meters (machine)</th><th className="text-right">Ledger</th><th className="text-right">Exceptions</th><th className="text-right">Deferred</th><th className="text-right">Unexplained</th></tr></thead>
            <tbody>
              {m.data.machines.flatMap((mc: any) => mc.lines.filter((l: any) => l.meterCents === null || l.meterCents || l.ledgerCents || l.exceptionCents || l.deferredCents).map((l: any, i: number) => (
                <tr key={`${mc.machineId}-${l.type}`} data-testid="meter-row">
                  <td className="font-semibold">{i === 0 ? mc.assetNo : ''}</td>
                  <td>{MACHINE_MONEY_LABEL[l.type] ?? l.type}</td>
                  <td className="text-right tabular-nums">{l.meterCents === null ? 'blind' : formatCents(l.meterCents)}</td>
                  <td className="text-right tabular-nums">{l.ledgerCents === null ? 'blind' : formatCents(l.ledgerCents)}</td>
                  <td className="text-right tabular-nums">{l.exceptionCents === null ? 'blind' : formatCents(l.exceptionCents)}</td>
                  <td className="text-right tabular-nums">{l.deferredCents === null ? 'blind' : formatCents(l.deferredCents)}</td>
                  <td className={clsx('text-right font-semibold tabular-nums', l.unexplainedCents ? 'text-red-600' : 'text-emerald-600')}>{formatCents(l.unexplainedCents)}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function ReconciliationPage() {
  const { casino } = useSession();
  const status = useApi<any>(`/money/day-close/status?casinoId=${casino.id}`, { refreshMs: 8000 });
  const machines = useApi<any[]>(`/machines?casinoId=${casino.id}`);
  const assetOf = (id: string) => machines.data?.find((m) => m.id === id)?.asset_no;
  const run = status.data?.lastRun;
  const checks: any[] = run?.checks ?? [];
  const reload = () => void status.reload();
  return (
    <div className="space-y-6">
      <PageHeader title="Reconciliation" subtitle="Ledger against operational state per rail, ledger against machine meters, open late events and exceptions, and what blocks the business-day close." />
      <ErrorNote error={status.error} />
      {status.data?.freezes?.length > 0 && (
        <Notice tone="bad">{status.data.freezes.map((f: any) => <div key={f.id}><Lock className="mr-1 inline h-4 w-4" />{f.rail}{f.asset_no ? ` · ${f.asset_no}` : ''} frozen: {f.reason}</div>)}</Notice>
      )}
      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Business-day close"><DayClose status={status.data} reload={reload} /></Card>
        <Card title={`Latest run ${run ? `· ${run.trigger} · ${timeAgo(run.created_at)}` : ''}`} className="xl:col-span-2">
          {!run && <Empty>No reconciliation run yet.</Empty>}
          {run && (
            <div className="space-y-3">
              <div className={clsx('text-sm font-semibold', run.ok ? 'text-emerald-600' : 'text-red-600')} data-testid="last-run-state">{run.ok ? 'Clean' : 'Mismatch'} · {formatDateTime(run.created_at)}</div>
              {RAIL_ORDER.filter((r) => checks.some((c) => c.rail === r)).map((rail) => (
                <div key={rail} className="rounded-lg border border-line p-2" data-testid={`recon-rail-${rail}`}>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-sub">{rail === 'GLOBAL' ? 'Ledger invariants' : rail}</div>
                  {checks.filter((c) => c.rail === rail).map((c) => (
                    <div key={c.key} className="py-0.5 text-sm">
                      <span className={clsx('mr-2 inline-block w-4', c.ok ? 'text-emerald-600' : 'text-red-600')}>{c.ok ? '✓' : '✗'}</span>
                      <span className="font-mono text-xs">{c.key}</span>
                      {c.resolved?.length > 0 && <span className="ml-2 text-xs text-sub">{c.resolved.length} explained</span>}
                      {c.items.map((i: string) => (
                        <div key={i} className="ml-6 flex items-center gap-2 text-xs" data-testid="recon-item">
                          <span>{describeItem(i, assetOf)}</span>
                          <ExplainButton itemKey={i} onDone={reload} />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
      <Card title="Ledger ↔ meters per machine" bodyClass="pb-2"><Meters /></Card>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Unresolved late / deferred events" bodyClass="p-0"><DeferredEvents /></Card>
        <Card title="Machine event exceptions" bodyClass="p-0"><EventExceptions limit={50} /></Card>
      </div>
    </div>
  );
}
