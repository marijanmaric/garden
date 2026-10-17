'use client';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PRODUCT_MODULES, PRODUCT_MODULE_DEFS, LIMIT_DEFS, LIMIT_KEYS, type ProductModule } from '@m1/shared';
import { formatEuro } from '@m1/ui';
import { api, useApi } from '@/lib/api';
import { Card, ErrorNote, Field, Modal, PageHeader } from '@/components/ui';
import { ReasonDialog } from '@/components/admin-ui';

type Plan = { id: string; code: string; version: number; name: string; description: string | null; active: boolean; modules: string[]; limits: Record<string, number>; price_cents: number | null; currency: string; billing_interval: string; subscriptions: number };

function PlanEditor({ base, onClose, onDone }: { base: Plan | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    code: base?.code ?? '', name: base?.name ?? '', description: base?.description ?? '',
    modules: new Set<string>(base?.modules ?? ['CORE']), limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, base?.limits[k] !== undefined ? String(base.limits[k]) : ''])),
    price: base?.price_cents != null ? String(base.price_cents / 100) : '', interval: base?.billing_interval ?? 'MONTH', reason: '',
  });
  const [err, setErr] = useState<string | null>(null);
  const toggle = (m: ProductModule) => { const s = new Set(f.modules); s.has(m) ? s.delete(m) : s.add(m); setF({ ...f, modules: s }); };
  return (
    <Modal title={base ? `New version of ${base.code}` : 'New plan'} onClose={onClose} wide>
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api('/platform/plans', { method: 'POST', json: {
            code: f.code, name: f.name, description: f.description || undefined, modules: [...f.modules],
            limits: Object.fromEntries(Object.entries(f.limits).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)])),
            priceCents: f.price ? Math.round(Number(f.price) * 100) : null, billingInterval: f.interval, reason: f.reason,
          } });
          onDone(); onClose();
        } catch (x) { setErr((x as Error).message); }
      }}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code"><input className="input" value={f.code} disabled={!!base} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        </div>
        <Field label="Description"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-sub">Modules</div>
          <div className="grid gap-2 sm:grid-cols-3">
            {PRODUCT_MODULES.map((m) => (
              <label key={m} className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 accent-violet-600" checked={f.modules.has(m)} disabled={m === 'CORE'} onChange={() => toggle(m)} />
                <span>{PRODUCT_MODULE_DEFS[m].name}{PRODUCT_MODULE_DEFS[m].requires.filter((r) => r !== 'CORE').length > 0 && <span className="block text-[11px] text-sub">requires {PRODUCT_MODULE_DEFS[m].requires.filter((r) => r !== 'CORE').map((r) => PRODUCT_MODULE_DEFS[r].name).join(', ')}</span>}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-sub">Limits (empty = unlimited)</div>
          <div className="grid gap-2 sm:grid-cols-4">
            {LIMIT_KEYS.map((k) => <Field key={k} label={`${LIMIT_DEFS[k].label} (${LIMIT_DEFS[k].kind})`}><input className="input" inputMode="numeric" value={f.limits[k]} onChange={(e) => setF({ ...f, limits: { ...f.limits, [k]: e.target.value } })} /></Field>)}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Price (metadata only)"><input className="input" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
          <Field label="Billing interval"><select className="input" value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}><option>MONTH</option><option>YEAR</option><option>NONE</option></select></Field>
          <Field label="Reason (audited)"><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        </div>
        <ErrorNote error={err} />
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn-primary">{base ? 'Create version' : 'Create plan'}</button></div>
      </form>
    </Modal>
  );
}

/** Plans are versioned: modules and limits of a version never change; existing subscriptions keep their version. */
export default function PlansPage() {
  const { data, error, reload } = useApi<{ plans: Plan[] }>('/platform/plans');
  const [edit, setEdit] = useState<{ base: Plan | null } | null>(null);
  const [toggle, setToggle] = useState<Plan | null>(null);
  return (
    <div className="space-y-6">
      <PageHeader title="Plans" subtitle="Versioned plans: modules, limits and price metadata. No payment processing." actions={<button className="btn-primary" onClick={() => setEdit({ base: null })}><Plus className="h-4 w-4" /> New plan</button>} />
      <ErrorNote error={error} />
      <Card bodyClass="overflow-x-auto">
        <table className="table">
          <thead><tr><th>Plan</th><th>Version</th><th>Modules</th><th>Limits</th><th>Price</th><th className="text-right">Subscriptions</th><th>Offered</th><th /></tr></thead>
          <tbody>
            {data?.plans.map((p) => (
              <tr key={p.id}>
                <td><div className="font-medium">{p.name}</div><div className="font-mono text-xs text-sub">{p.code}</div></td>
                <td>v{p.version}</td>
                <td className="max-w-xs text-xs">{p.modules.join(', ')}</td>
                <td className="text-xs">{Object.entries(p.limits).map(([k, v]) => `${k.replace('MAX_', '').toLowerCase()} ${v}`).join(' · ') || 'none'}</td>
                <td className="whitespace-nowrap text-xs">{p.price_cents != null ? `${formatEuro(p.price_cents / 100)} / ${p.billing_interval.toLowerCase()}` : '-'}</td>
                <td className="text-right tabular-nums">{p.subscriptions}</td>
                <td>{p.active ? 'yes' : 'no'}</td>
                <td className="whitespace-nowrap text-right">
                  <button className="btn px-2 py-1 text-xs" onClick={() => setEdit({ base: p })}>New version</button>{' '}
                  <button className="btn px-2 py-1 text-xs" onClick={() => setToggle(p)}>{p.active ? 'Retire' : 'Offer'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {edit && <PlanEditor base={edit.base} onClose={() => setEdit(null)} onDone={() => void reload()} />}
      {toggle && (
        <ReasonDialog title={`${toggle.active ? 'Retire' : 'Offer'} ${toggle.name} v${toggle.version}`} confirm={toggle.active ? 'Retire' : 'Offer'} onClose={() => setToggle(null)}
          description={toggle.active ? 'A retired plan is no longer offered for new subscriptions; existing subscriptions keep it.' : undefined}
          onConfirm={async (reason) => { await api(`/platform/plans/${toggle.id}`, { method: 'PUT', json: { name: toggle.name, description: toggle.description, active: !toggle.active, priceCents: toggle.price_cents, billingInterval: toggle.billing_interval, reason } }); await reload(); }} />
      )}
    </div>
  );
}
