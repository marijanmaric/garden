'use client';
import { useState } from 'react';
import { formatDateTime } from '@m1/ui';
import { useApi } from '@/lib/api';
import { MACHINE_MONEY_LABEL, formatCents } from '@/lib/money';
import { useSession } from '@/lib/session';
import { useConfirm } from './money-ui';
import { Empty } from './ui';

/** Step 7e: shared supervisor views (Money control and Reconciliation): deferred events, event exceptions, explanations. */

export function DeferredEvents() {
  const { casino, can } = useSession();
  const list = useApi<any[]>(`/money/deferred?casinoId=${casino.id}`, { refreshMs: 8000 });
  const [reason, setReason] = useState<Record<string, string>>({});
  const confirm = useConfirm(() => void list.reload());
  if (!list.data?.length) return <Empty>No pending deferred money events.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead><tr><th>Machine</th><th>Event</th><th className="text-right">Amount</th><th>Reason</th><th>Occurred / received</th><th>Business date</th><th>State</th></tr></thead>
        <tbody>
          {list.data.map((d) => (
            <tr key={d.event_id} data-testid="deferred-row">
              <td className="font-semibold">{d.asset_no}</td>
              <td>{d.rail} · {MACHINE_MONEY_LABEL[d.kind] ?? d.kind}</td>
              <td className="text-right tabular-nums">{formatCents(Number(d.amount_cents))}</td>
              <td className="text-xs">{d.reason}{d.last_error ? <div className="text-red-600">{d.last_error}</div> : null}</td>
              <td className="text-xs">{formatDateTime(d.occurred_at)}<div className="text-sub">{formatDateTime(d.received_at)}</div></td>
              <td className="text-xs">{String(d.business_date).slice(0, 10)}{d.date_closed && <span className="ml-1 badge bg-red-500/15 text-red-600 ring-red-500/30">CLOSED</span>}</td>
              <td className="text-xs">
                {d.explained ? 'explained' : d.late_request_status ? `late booking ${d.late_request_status}` : d.date_closed && can('cashier.supervise') ? (
                  <div className="flex gap-1">
                    <input className="input py-1 text-xs" placeholder="Reason (10+ chars)" value={reason[d.event_id] ?? ''} onChange={(e) => setReason({ ...reason, [d.event_id]: e.target.value })} />
                    <button className="btn py-1 text-xs" disabled={(reason[d.event_id] ?? '').trim().length < 10} onClick={() => confirm.ask({
                      title: 'Request late booking', summary: 'The original business date is closed. A second person must approve; the event is then booked on today\'s open date with a reference to the original date and event.',
                      amountCents: Number(d.amount_cents), details: [['Machine', d.asset_no], ['Event', `${d.rail} ${d.kind}`], ['Original business date', String(d.business_date).slice(0, 10)], ['Reason', reason[d.event_id]]],
                      path: `/money/deferred/${d.event_id}/late-booking`, body: { reason: reason[d.event_id] }, describe: () => 'Late booking requested: waiting for the second person (Approvals).',
                    })}>Request</button>
                  </div>
                ) : 'waits for replay'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {confirm.dialog}
    </div>
  );
}

export function ExplainButton({ itemKey, label, onDone }: { itemKey: string; label?: string; onDone?: () => void }) {
  const { casino } = useSession();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const confirm = useConfirm(() => { setOpen(false); onDone?.(); });
  if (!open) return <button className="btn py-1 text-xs" onClick={() => setOpen(true)} data-testid="explain">{label ?? 'Explain'}</button>;
  return (
    <div className="flex gap-1">
      <input className="input py-1 text-xs" placeholder="Explanation (10+ chars)" value={text} onChange={(e) => setText(e.target.value)} data-testid="explain-text" />
      <button className="btn py-1 text-xs" disabled={text.trim().length < 10} data-testid="explain-submit" onClick={() => confirm.ask({
        title: 'Explain reconciliation item', summary: 'A different person must approve this explanation (Approvals). Nothing is booked; the item then counts as explained.',
        details: [['Item', itemKey], ['Explanation', text]], path: '/money/resolutions', body: { casinoId: casino.id, itemKey, explanation: text }, describe: () => 'Explanation requested.',
      })}>Send</button>
      {confirm.dialog}
    </div>
  );
}

export function EventExceptions({ limit }: { limit?: number }) {
  const { casino } = useSession();
  const list = useApi<any[]>(`/machines/event-exceptions?casinoId=${casino.id}`, { refreshMs: 10000 });
  const rows = (list.data ?? []).slice(0, limit ?? 200);
  if (!rows.length) return <Empty>No machine event exceptions.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead><tr><th>Time</th><th>Machine</th><th>Event</th><th>Code</th><th className="text-right">Amount</th><th>State</th></tr></thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.event_id} data-testid="exception-row">
              <td className="text-xs">{formatDateTime(x.created_at)}</td>
              <td className="font-semibold">{x.asset_no}</td>
              <td>{x.rail} · {MACHINE_MONEY_LABEL[x.event_type] ?? x.event_type}<div className="max-w-xs truncate text-xs text-sub" title={x.message}>{x.message}</div></td>
              <td className="text-xs font-mono">{x.code}</td>
              <td className="text-right tabular-nums">{x.amount !== null ? formatCents(Math.round(Number(x.amount) * 100)) : '-'}</td>
              <td className="text-xs">{x.explained ? 'explained' : x.explanation_status === 'PENDING' ? 'explanation pending' : <ExplainButton itemKey={`machine_event:${x.event_id}`} onDone={() => void list.reload()} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

