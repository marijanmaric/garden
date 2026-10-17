'use client';
import { useState } from 'react';
import { api, useApi } from '@/lib/api';
import { Card, ErrorNote, Field, Notice } from '@/components/ui';
import { ReasonDialog, UsageBar } from '@/components/admin-ui';
import { useOrg } from '@/components/admin-org';

const STATUSES = ['TRIAL', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'CANCELLED'];
const toInput = (d: string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '');

export default function OrgSettingsPage() {
  const { id, d, reload } = useOrg();
  const plans = useApi<{ plans: Array<{ id: string; code: string; name: string; version: number; active: boolean; modules: string[] }> }>('/platform/plans');
  const [sub, setSub] = useState<{ planId: string; status: string; endsAt: string } | null>(null);
  const [limit, setLimit] = useState<{ key: string; label: string; value: string } | null>(null);
  const [dlg, setDlg] = useState<null | 'sub' | 'status' | 'limit'>(null);
  const [note, setNote] = useState<string | null>(null);
  if (!d) return <div className="text-sub">Loading...</div>;
  const s = sub ?? { planId: d.subscription?.plan_id ?? '', status: d.subscription?.status ?? 'ACTIVE', endsAt: toInput(d.subscription?.ends_at) };
  const plan = plans.data?.plans.find((p) => p.id === s.planId);
  const o = d.organization;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Subscription">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setDlg('sub'); }}>
          <Field label="Plan">
            <select className="input" name="plan" value={s.planId} onChange={(e) => setSub({ ...s, planId: e.target.value })}>
              {plans.data?.plans.filter((p) => p.active || p.id === d.subscription?.plan_id).map((p) => <option key={p.id} value={p.id}>{p.name} v{p.version} ({p.code})</option>)}
            </select>
          </Field>
          {plan && <div className="text-xs text-sub">Modules: {plan.modules.join(', ')}</div>}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Status"><select className="input" name="status" value={s.status} onChange={(e) => setSub({ ...s, status: e.target.value })}>{STATUSES.map((x) => <option key={x}>{x}</option>)}</select></Field>
            <Field label="Ends (empty = open-ended)"><input className="input" type="date" value={s.endsAt} onChange={(e) => setSub({ ...s, endsAt: e.target.value })} /></Field>
          </div>
          <Notice>SUSPENDED, EXPIRED and CANCELLED make the organisation read-only: data stays, new actions are refused. Nothing is deleted. No payment is processed here.</Notice>
          <div className="flex justify-end"><button className="btn-primary">Save subscription</button></div>
        </form>
      </Card>
      <Card title="Organization status">
        <div className="text-sm">Current status: <b>{o.status}</b>{o.status_reason && <span className="text-sub"> · {o.status_reason}</span>}</div>
        <p className="mt-2 text-xs text-sub">A disabled organisation cannot log in and every request of its users is refused (403 ORGANIZATION_DISABLED). Data is kept.</p>
        {!o.is_platform && <div className="mt-3"><button className={o.status === 'ACTIVE' ? 'btn' : 'btn-primary'} onClick={() => setDlg('status')}>{o.status === 'ACTIVE' ? 'Disable organisation' : 'Enable organisation'}</button></div>}
      </Card>
      <Card title="Limits" className="lg:col-span-2" bodyClass="divide-y divide-line">
        {d.usage.map((u) => {
          const ov = d.limitOverrides.find((x) => x.limit_key === u.key);
          return (
            <div key={u.key} className="flex flex-wrap items-center gap-4 px-4 py-2">
              <div className="min-w-[16rem] flex-1"><UsageBar row={u} /></div>
              <span className="text-xs text-sub">{u.source === 'OVERRIDE' ? `override (${ov?.reason})` : u.source === 'PLAN' ? 'from plan' : 'no limit'}</span>
              <button className="btn px-2 py-1 text-xs" onClick={() => { setLimit({ key: u.key, label: u.label, value: u.value === null ? '' : String(u.value) }); setDlg('limit'); }}>Change</button>
            </div>
          );
        })}
        {note && <div className="px-4 py-2"><Notice tone="bad">{note}</Notice></div>}
      </Card>
      <ErrorNote error={plans.error} />
      {dlg === 'sub' && (
        <ReasonDialog title="Change subscription" confirm="Save" onClose={() => setDlg(null)}
          description={<>Plan <b>{plan?.name} v{plan?.version}</b>, status <b>{s.status}</b>{s.endsAt ? <>, until <b>{s.endsAt}</b></> : ''}. Modules the new plan removes are refused while open money items exist.</>}
          onConfirm={async (reason) => { await api(`/platform/organizations/${id}/subscription`, { method: 'PUT', json: { planId: s.planId, status: s.status, endsAt: s.endsAt ? new Date(`${s.endsAt}T23:59:59Z`).toISOString() : null, reason } }); setSub(null); await reload(); }} />
      )}
      {dlg === 'status' && (
        <ReasonDialog title={o.status === 'ACTIVE' ? 'Disable organisation' : 'Enable organisation'} confirm={o.status === 'ACTIVE' ? 'Disable' : 'Enable'} onClose={() => setDlg(null)}
          onConfirm={async (reason) => { await api(`/platform/organizations/${id}/status`, { method: 'PUT', json: { status: o.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE', reason } }); await reload(); }} />
      )}
      {dlg === 'limit' && limit && (
        <ReasonDialog title={`Limit: ${limit.label}`} confirm="Save" onClose={() => setDlg(null)}
          description={<Field label="Value (empty = unlimited, 'plan' = back to the plan)"><input className="input" name="limit" value={limit.value} onChange={(e) => setLimit({ ...limit, value: e.target.value })} /></Field>}
          onConfirm={async (reason) => {
            const v = limit.value.trim().toLowerCase();
            const r = await api<{ warning: string | null }>(`/platform/organizations/${id}/limits/${limit.key}`, { method: 'PUT', json: { value: v === '' ? null : v === 'plan' ? 'PLAN' : Number(v), reason } });
            setNote(r.warning);
            await reload();
          }} />
      )}
    </div>
  );
}
