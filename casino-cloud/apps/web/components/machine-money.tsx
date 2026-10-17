'use client';
import { useState } from 'react';
import { Lock } from 'lucide-react';
import { formatDateTime, timeAgo } from '@m1/ui';
import { useApi } from '@/lib/api';
import { MACHINE_MONEY_LABEL, formatCents, parseCountCents } from '@/lib/money';
import { useSession } from '@/lib/session';
import { AmountField, RailBadge, useConfirm } from './money-ui';
import { Card, Stat } from './ui';

/**
 * Step 7e, machine operations: the machine's money rail, freezes (per machine; CASHLESS / global ones
 * are shown too), MACHINE CREDIT meter state, pending / deferred events, exceptions, open handpays,
 * hopper fills to confirm at the machine (blind count) and the collection state.
 */
export function MachineMoney({ machineId }: { machineId: string }) {
  const { can, me } = useSession();
  const m = useApi<any>(`/machines/${machineId}/money`, { refreshMs: 5000 });
  const [count, setCount] = useState<Record<string, string>>({});
  const confirm = useConfirm(() => void m.reload());
  const d = m.data;
  if (!d) return null;
  const pendingFills = d.hopperFills.filter((h: any) => h.status === 'REQUESTED');
  return (
    <Card title={<span className="flex items-center gap-2">Money <RailBadge mode={d.rail} /></span>} className="xl:col-span-2">
      <div className="grid gap-6 md:grid-cols-2" data-testid="machine-money">
        <div>
          {d.freezes.map((f: any) => (
            <div key={f.id} className="mb-2 flex gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400" data-testid="machine-freeze">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" /><span><b>{f.rail === 'MACHINE' ? 'This machine' : f.rail} frozen</b> since {formatDateTime(f.frozen_at)}: money events are deferred (not lost) until a supervisor lifts it. <span className="opacity-75">{f.reason}</span></span>
            </div>
          ))}
          <Stat label="MACHINE rail" value={d.rail} hint={d.ledgerSince ? `since ${formatDateTime(d.ledgerSince)}` : undefined} />
          <Stat label="MACHINE CREDIT meter" value={d.creditMeterReliable ? 'reliable (settled at each report)' : 'settled at verified zero credit only'} />
          <Stat label="Last credit meter" value={d.lastCreditMeter ? (d.lastCreditMeter.credit_cents !== null ? formatCents(Number(d.lastCreditMeter.credit_cents)) : 'reported') : '-'} hint={d.lastCreditMeter ? timeAgo(d.lastCreditMeter.occurred_at) : undefined} />
          <Stat label="Pending / deferred money events" value={d.deferred.length} tone={d.deferred.length ? 'warn' : undefined} />
          <Stat label="Open handpays" value={d.handpays.filter((h: any) => h.status !== 'PAID').length} />
          <Stat label="Last collection count" value={d.collectionCounts[0] ? (d.collectionCounts[0].settled ? 'settled' : 'waiting for 2nd count') : '-'} hint={d.collectionCounts[0] ? timeAgo(d.collectionCounts[0].created_at) : undefined} />
          {d.deferred.map((x: any) => (
            <div key={x.event_id} className="text-xs text-sub" data-testid="machine-deferred">{MACHINE_MONEY_LABEL[x.kind] ?? x.kind} {formatCents(Number(x.amount_cents))} · {x.reason} · business date {String(x.business_date).slice(0, 10)}{x.last_error ? ` · ${x.last_error}` : ''}</div>
          ))}
        </div>
        <div className="space-y-3">
          {pendingFills.map((h: any) => {
            const cents = parseCountCents(count[h.id] ?? '');
            const own = h.requested_by === me.user.id;
            return (
              <div key={h.id} className="space-y-2 rounded-xl border border-sky-500/40 bg-sky-500/5 p-3" data-testid="hopper-confirm-box">
                <div className="text-sm font-semibold">Hopper fill waiting for confirmation at this machine</div>
                <div className="text-xs text-sub">Requested {timeAgo(h.requested_at)} · expires {new Date(h.expires_at).toLocaleTimeString('de-AT')}. Count the cash you put into the hopper (blind).</div>
                {own ? <div className="text-xs text-amber-700">You requested it: a different employee must confirm at the machine.</div> : can('cash.transact') ? (
                  <>
                    <AmountField label="Your count" value={count[h.id] ?? ''} onChange={(v) => setCount({ ...count, [h.id]: v })} testId="hopper-count" />
                    <button className="btn-primary w-full" disabled={!cents} data-testid="hopper-confirm" onClick={() => confirm.ask({
                      title: 'Confirm hopper fill', summary: 'You confirm that you put this amount into the hopper. A different count rejects it and nothing moves.', amountCents: cents!,
                      details: [['Machine', d.assetNo], ['From', 'Vault']], path: `/machines/hopper-fills/${h.id}/confirm`, body: { totalCents: cents },
                      describe: (r) => r?.movement?.status === 'REJECTED' ? 'Count did not match: hopper fill REJECTED, nothing booked.' : r?.movement?.status === 'EXPIRED' ? 'Hopper fill expired, nothing booked.' : 'Hopper fill booked.',
                    })}>Confirm at machine</button>
                  </>
                ) : <div className="text-xs text-sub">Needs permission cash.transact.</div>}
              </div>
            );
          })}
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-sub">Money exceptions</div>
            {!d.exceptions.length && <div className="text-sm text-sub">None.</div>}
            {d.exceptions.map((x: any) => (
              <div key={x.event_id} className="border-b border-line/60 py-1 text-xs last:border-0" data-testid="machine-exception">
                <span className="font-mono">{x.code}</span> · {MACHINE_MONEY_LABEL[x.event_type] ?? x.event_type} · {timeAgo(x.created_at)} {x.explained ? '· explained' : ''}
                <div className="text-sub">{x.message}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {confirm.dialog}
    </Card>
  );
}
