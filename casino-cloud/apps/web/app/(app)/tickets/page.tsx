'use client';
import { useState } from 'react';
import { ScanLine } from 'lucide-react';
import { TICKET_STATUSES } from '@m1/shared';
import { formatDateTime, formatEuro, timeAgo } from '@m1/ui';
import { api, useApi } from '@/lib/api';
import { useLiveRefresh } from '@/lib/live';
import { useSession } from '@/lib/session';
import { Card, ErrorNote, Field, Kpi, Modal, Notice, PageHeader, TicketBadge } from '@/components/ui';

function TicketDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can } = useSession();
  const { data: t, reload } = useApi<any>(`/tickets/${id}`);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const act = async (action: string) => {
    const body: Record<string, unknown> = {};
    if (action === 'adjust') {
      const amount = Number(prompt('New amount (EUR)', String(t.amount)));
      if (!amount) return;
      body.amount = amount;
    }
    if (action !== 'reprint') {
      const reason = prompt('Reason (mandatory, stored in the audit log)');
      if (!reason) return;
      body.reason = reason;
    }
    try {
      const r = await api(`/tickets/${id}/${action}`, { method: 'POST', json: body });
      setMsg({ tone: 'good', text: action === 'adjust' ? `Replaced by new ticket ${r.barcode} (${formatEuro(r.amount)})` : `Ticket ${action} done` });
      await reload();
      onChanged();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  };

  return (
    <Modal title="Ticket" onClose={onClose}>
      {!t ? (
        <div className="text-sub">Loading...</div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="font-mono text-lg tracking-wider">{t.barcode}</div>
              <div className="text-3xl font-bold">{formatEuro(t.amount)}</div>
            </div>
            <TicketBadge status={t.status} />
          </div>
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><div className="text-xs text-sub">Issued</div>{formatDateTime(t.issued_at)}<div className="text-xs text-sub">{t.issued_machine ?? t.issued_employee}</div></div>
            <div><div className="text-xs text-sub">Expires</div>{formatDateTime(t.expires_at)}</div>
            <div><div className="text-xs text-sub">Redeemed</div>{t.redeemed_at ? formatDateTime(t.redeemed_at) : '-'}<div className="text-xs text-sub">{t.redeemed_machine ?? t.redeemed_employee ?? ''}</div></div>
            <div><div className="text-xs text-sub">Reprints</div>{t.reprint_count}</div>
            {t.status_reason && <div className="col-span-2"><div className="text-xs text-sub">Reason</div>{t.status_reason}</div>}
          </div>
          {can('ticket.manage') && t.status === 'VALID' && (
            <div className="flex flex-wrap gap-2">
              <button className="btn" onClick={() => act('reprint')}>Reprint</button>
              <button className="btn" onClick={() => act('adjust')}>Adjust amount</button>
              <button className="btn" onClick={() => act('cancel')}>Cancel</button>
              <button className="btn-danger" onClick={() => act('void')}>Void</button>
            </div>
          )}
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-sub">History</div>
            {t.events.map((e: any, i: number) => (
              <div key={i} className="flex justify-between border-b border-line/60 py-1.5 text-sm last:border-0">
                <span className="font-medium">{e.action}</span>
                <span className="text-xs text-sub">{e.asset_no ?? e.employee ?? ''} · {formatDateTime(e.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function TicketsPage() {
  const { casino } = useSession();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [scan, setScan] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const qs = new URLSearchParams({ casinoId: casino.id, ...(status && { status }), ...(search && { search }) });
  const list = useApi<any[]>(`/tickets?${qs}`);
  const sum = useApi<any>(`/tickets/summary?casinoId=${casino.id}`);
  useLiveRefresh(() => { void list.reload(); void sum.reload(); }, 3000, ['machine.event']);

  const validate = async (e: React.FormEvent) => {
    e.preventDefault();
    setScanErr(null);
    try {
      const t = await api(`/tickets/lookup/${encodeURIComponent(scan.trim())}`);
      setSelected(t.id);
    } catch (err) {
      setScanErr((err as Error).message);
    }
  };

  const s = sum.data;
  return (
    <div className="space-y-6">
      <PageHeader title="Tickets (TITO)" subtitle="Tickets printed by machines or sold at the cage. Every change is kept in the ticket history." />
      {s && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Kpi label="Outstanding liability" value={formatEuro(s.liability)} sub={`${s.valid_count} valid tickets`} />
          <Kpi label="Issued today" value={formatEuro(s.issued_today_amount)} sub={`${s.issued_today} tickets`} />
          <Kpi label="Redeemed today" value={formatEuro(s.redeemed_today_amount)} sub={`${s.redeemed_today} tickets`} />
          <Kpi label="Expired" value={s.expired_count} sub={`${s.expiring_soon} expiring within 3 days`} />
        </div>
      )}
      <Card title="Validate ticket">
        <form onSubmit={validate} className="flex flex-wrap items-end gap-2">
          <div className="min-w-[240px] flex-1">
            <Field label="Barcode"><input className="input font-mono" inputMode="numeric" value={scan} onChange={(e) => setScan(e.target.value)} placeholder="Scan or type barcode" /></Field>
          </div>
          <button className="btn-primary"><ScanLine className="h-4 w-4" /> Validate</button>
        </form>
        {scanErr && <div className="mt-3"><Notice tone="bad">{scanErr}</Notice></div>}
      </Card>
      <ErrorNote error={list.error} />
      <div className="flex flex-wrap gap-2">
        <input className="input max-w-xs" placeholder="Search barcode..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {TICKET_STATUSES.map((x) => <option key={x}>{x}</option>)}
        </select>
      </div>
      <Card bodyClass="overflow-x-auto">
        <table className="table">
          <thead><tr><th>Barcode</th><th className="text-right">Amount</th><th>Status</th><th>Issued</th><th>Issued by</th><th>Redeemed</th><th>Expires</th></tr></thead>
          <tbody>
            {list.data?.map((t) => (
              <tr key={t.id} className="cursor-pointer" onClick={() => setSelected(t.id)}>
                <td className="font-mono text-xs">{t.barcode}</td>
                <td className="text-right tabular-nums">{formatEuro(t.amount)}</td>
                <td><TicketBadge status={t.status} /></td>
                <td className="text-xs">{formatDateTime(t.issued_at)}</td>
                <td>{t.issued_machine ?? t.issued_employee}</td>
                <td className="text-xs">{t.redeemed_at ? `${timeAgo(t.redeemed_at)} · ${t.redeemed_machine ?? t.redeemed_employee}` : '-'}</td>
                <td className="text-xs text-sub">{formatDateTime(t.expires_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {selected && <TicketDetail id={selected} onClose={() => setSelected(null)} onChanged={() => { void list.reload(); void sum.reload(); }} />}
    </div>
  );
}
