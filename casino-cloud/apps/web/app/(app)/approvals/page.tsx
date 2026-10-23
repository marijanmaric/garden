'use client';
import { useState } from 'react';
import { ShieldCheck, UserX } from 'lucide-react';
import { formatDateTime, timeAgo } from '@m1/ui';
import { useApi } from '@/lib/api';
import { APPROVAL_LABEL, describeItem, formatCents } from '@/lib/money';
import { useSession } from '@/lib/session';
import { useConfirm } from '@/components/money-ui';
import { Card, Empty, ErrorNote, Field, PageHeader } from '@/components/ui';
import { clsx } from '@/components/clsx';

/**
 * Step 7e, approval inbox (four eyes): every pending request of the casino with reason, amount and the
 * affected player / machine / ticket / handpay, who asked, and who may decide. The requester cannot decide
 * the own request (the API enforces it too); every decision is recorded and stays visible in the history.
 */

type Approval = {
  id: string; action: string; entity_type: string | null; entity_id: string | null; amount_cents: number | null; payload: Record<string, any>; status: string;
  requested_by: string; requested_by_name: string; created_at: string; expires_at: string; decided_by_name: string | null; decided_at: string | null; decision_note: string | null;
  executed_at: string | null; own: boolean; barcode: string | null; asset_no: string | null; player_no: string | null; player_name: string | null; desk_name: string | null; cashier_name: string | null;
};

function entityLines(a: Approval): Array<[string, React.ReactNode]> {
  const out: Array<[string, React.ReactNode]> = [];
  if (a.barcode) out.push(['TITO ticket', <span key="b" className="font-mono">{a.barcode}</span>]);
  if (a.asset_no) out.push(['Machine', a.asset_no]);
  if (a.player_no) out.push(['Player', `${a.player_name?.trim() || ''} (${a.player_no})`]);
  if (a.desk_name) out.push(['Shift', `${a.desk_name} · ${a.cashier_name}`]);
  const p = a.payload ?? {};
  if (a.action === 'DRAWER_SHORT_OVER') {
    out.push(['Counted', formatCents(p.countedCents)], ['Ledger', formatCents(p.ledgerCents)], ['Difference', <b key="d">{formatCents(p.differenceCents)}</b>]);
  }
  if (a.action === 'RECONCILIATION_RESOLUTION') out.push(['Item', describeItem(a.entity_id ?? '')], ['Explanation', p.explanation]);
  if (a.action === 'LATE_EVENT_BOOKING') {
    out.push(['Event', `${p.rail} ${p.kind}`], ['Occurred (economic time)', p.occurredAt ? formatDateTime(p.occurredAt) : '-'], ['Received', p.receivedAt ? formatDateTime(p.receivedAt) : '-'],
      ['Original business date (closed)', p.originalBusinessDate ?? '-'], ['Posting date', "today's open business date, referencing the original"], ['Reason', p.reason]);
  }
  if (a.action === 'MACHINE_EXCEPTION_DISPOSITION') {
    out.push(['Event', `${p.eventType} ${p.code}`], ['Disposition', p.kind === 'CORRECTION' ? 'Correction booking (ADJUSTMENT on approval)' : 'No money moved (nothing booked)'],
      ['Reason', p.reason], ['Evidence', p.evidenceRef]);
  }
  if (a.action === 'HANDPAY_EXCEPTION') out.push(['Resolution', p.resolution], ...(p.jackpotEventId ? [['Linked jackpot event', p.jackpotEventId] as [string, string]] : []));
  if (a.action === 'TITO_CANCEL' || a.action === 'TITO_VOID') out.push(['Reason', p.reason]);
  return out;
}

function Decide({ a, onDone }: { a: Approval; onDone: () => void }) {
  const { can } = useSession();
  const [note, setNote] = useState('');
  const confirm = useConfirm(onDone);
  if (a.own) return <div className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400" data-testid="own-request"><UserX className="h-4 w-4" />Your own request: a different person must decide.</div>;
  if (!can('cashier.supervise')) return <div className="text-xs text-sub">Needs permission cashier.supervise.</div>;
  const ask = (decision: 'APPROVED' | 'REJECTED') => confirm.ask({
    title: `${decision === 'APPROVED' ? 'Approve' : 'Reject'}: ${APPROVAL_LABEL[a.action] ?? a.action}`,
    summary: decision === 'APPROVED'
      ? 'You approve as the second person. Depending on the request, it is executed now (cancellation, void, explanation, late booking, short / over) or can be executed once by the requester (payouts, deposits, withdrawals).'
      : 'You reject the request. Nothing is executed.',
    amountCents: a.amount_cents !== null ? Number(a.amount_cents) : undefined,
    details: [['Requested by', a.requested_by_name], ...entityLines(a), ...(note ? [['Your note', note] as [string, string]] : [])],
    path: `/approvals/${a.id}/decide`, body: { decision, note: note || undefined }, danger: decision === 'REJECTED',
    confirmLabel: decision === 'APPROVED' ? 'Approve' : 'Reject',
    describe: () => (decision === 'APPROVED' ? 'Approved.' : 'Rejected.'),
  });
  return (
    <div className="space-y-2">
      <Field label="Note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="flex gap-2">
        <button className="btn-primary flex-1" onClick={() => ask('APPROVED')} data-testid="approve">Approve</button>
        <button className="btn flex-1" onClick={() => ask('REJECTED')} data-testid="reject">Reject</button>
      </div>
      {confirm.dialog}
    </div>
  );
}

export default function ApprovalsPage() {
  const { casino } = useSession();
  const [tab, setTab] = useState<'PENDING' | 'ALL'>('PENDING');
  const list = useApi<Approval[]>(`/approvals?casinoId=${casino.id}&status=${tab}`, { refreshMs: 4000 });
  const pending = (list.data ?? []).filter((a) => tab === 'ALL' || new Date(a.expires_at) > new Date());
  return (
    <div className="space-y-6">
      <PageHeader title="Approvals" subtitle="Four eyes: HANDPAY, TITO payouts / cancellations / voids, CASHLESS deposits / withdrawals, short / over, reconciliation explanations, late events and handpay exceptions."
        actions={<div className="flex gap-1">{(['PENDING', 'ALL'] as const).map((t) => <button key={t} className={clsx('btn', tab === t && 'ring-2 ring-brand')} onClick={() => setTab(t)}>{t === 'PENDING' ? 'Pending' : 'History'}</button>)}</div>} />
      <ErrorNote error={list.error} />
      {!pending.length && <Card><Empty>{tab === 'PENDING' ? 'No pending approvals.' : 'No approvals yet.'}</Empty></Card>}
      <div className="grid gap-4 lg:grid-cols-2">
        {pending.map((a) => (
          <Card key={a.id} title={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" />{APPROVAL_LABEL[a.action] ?? a.action}</span>}
            actions={<span className={clsx('badge', a.status === 'PENDING' ? 'bg-amber-500/15 text-amber-700 ring-amber-500/30' : a.status === 'REJECTED' || a.status === 'EXPIRED' ? 'bg-red-500/15 text-red-600 ring-red-500/30' : 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/30')}>{a.status}</span>}>
            <div className="space-y-3" data-testid="approval-card">
              {a.amount_cents !== null && <div className="text-2xl font-bold tabular-nums">{formatCents(Number(a.amount_cents))}</div>}
              <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-sub">Requested by</dt><dd>{a.requested_by_name} · {timeAgo(a.created_at)}</dd>
                <dt className="text-sub">Decided by</dt><dd>{a.decided_by_name ? `${a.decided_by_name} · ${formatDateTime(a.decided_at!)}` : 'a second person with cashier.supervise (not the requester)'}</dd>
                {entityLines(a).map(([k, v]) => <div key={k} className="contents"><dt className="text-sub">{k}</dt><dd>{v}</dd></div>)}
                {a.decision_note && <><dt className="text-sub">Note</dt><dd>{a.decision_note}</dd></>}
                {a.executed_at && <><dt className="text-sub">Executed</dt><dd>{formatDateTime(a.executed_at)}</dd></>}
                {a.status === 'PENDING' && <><dt className="text-sub">Expires</dt><dd>{new Date(a.expires_at).toLocaleTimeString('de-AT')}</dd></>}
              </dl>
              {a.status === 'PENDING' && <Decide a={a} onDone={() => void list.reload()} />}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
