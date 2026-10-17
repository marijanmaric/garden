'use client';
import { useState } from 'react';
import { Building2, Plus } from 'lucide-react';
import { formatDateTime } from '@m1/ui';
import { api, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Card, ErrorNote, Field, Modal, Notice, PageHeader } from '@/components/ui';
import { LicenseBadge, ModuleCard, ReasonDialog, UsageBar, type ModuleCardData, type UsageRow } from '@/components/admin-ui';

interface OrgView {
  organization: { id: string; name: string; slug: string; status: string; created_at: string };
  license: string;
  entitlements: { subscription: null | { status: string; startsAt: string; endsAt: string | null; usable: boolean; plan: { code: string; name: string; version: number } } };
  modules: ModuleCardData[];
  usage: UsageRow[];
  upgrades: Array<{ module: string; name: string; description: string; plans: Array<{ code: string; name: string }> }>;
  upgradeContact: string;
}

function NewCasino({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ code: '', name: '', city: '', country: '' });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="New casino" onClose={onClose}>
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        try { await api('/org/casinos', { method: 'POST', json: { ...f, city: f.city || undefined, country: f.country || undefined } }); onDone(); onClose(); } catch (err) { setError((err as Error).message); }
      }}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code"><input className="input" name="code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="SAL-001" /></Field>
          <Field label="Name"><input className="input" name="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="City"><input className="input" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
          <Field label="Country"><input className="input" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })} /></Field>
        </div>
        <p className="text-xs text-sub">A vault, a cash desk and a floor are created with it. Money rails start in legacy mode until the cutover (Money control).</p>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn-primary">Create casino</button></div>
      </form>
    </Modal>
  );
}

function NewMachine({ casinos, onClose, onDone }: { casinos: Array<{ id: string; name: string; status: string }>; onClose: () => void; onDone: () => void }) {
  const active = casinos.filter((c) => c.status === 'ACTIVE');
  const [f, setF] = useState({ casinoId: active[0]?.id ?? '', machineCode: '', assetNo: '', game: '' });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="New machine" onClose={onClose}>
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        try { await api('/org/machines', { method: 'POST', json: { ...f, game: f.game || undefined } }); onDone(); onClose(); } catch (err) { setError((err as Error).message); }
      }}>
        <Field label="Casino"><select className="input" value={f.casinoId} onChange={(e) => setF({ ...f, casinoId: e.target.value })}>{active.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Machine code"><input className="input" name="machineCode" value={f.machineCode} onChange={(e) => setF({ ...f, machineCode: e.target.value })} /></Field>
          <Field label="Asset no."><input className="input" name="assetNo" value={f.assetNo} onChange={(e) => setF({ ...f, assetNo: e.target.value })} /></Field>
        </div>
        <Field label="Game"><input className="input" value={f.game} onChange={(e) => setF({ ...f, game: e.target.value })} /></Field>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn-primary">Create machine</button></div>
      </form>
    </Modal>
  );
}

/**
 * The customer's administration: plan and license, modules (switch purchased modules on / off with
 * dependency and prerequisite checks), limits with usage, upgrades (contact the administrator) and casinos.
 */
export default function OrganizationPage() {
  const { can, refresh } = useSession();
  const org = useApi<OrgView>(can('org.manage') ? '/org' : null);
  const casinos = useApi<{ casinos: Array<{ id: string; code: string; name: string; city: string | null; status: string; status_reason: string | null; machines: number; users: number; created_at: string }> }>(can('org.manage') ? '/org/casinos' : null);
  const [dialog, setDialog] = useState<null | { kind: 'module'; m: ModuleCardData } | { kind: 'casino' } | { kind: 'machine' } | { kind: 'casinoStatus'; id: string; name: string; to: 'ACTIVE' | 'INACTIVE' }>(null);
  if (!can('org.manage')) return <Notice tone="bad">Only the organisation administrator manages the organisation.</Notice>;
  const d = org.data;
  const reload = async () => { await Promise.all([org.reload(), casinos.reload(), refresh()]); };
  const sub = d?.entitlements.subscription;

  return (
    <div className="space-y-6">
      <PageHeader title="Organization" subtitle={d ? `${d.organization.name} · plan, modules, limits and casinos` : 'Loading...'} />
      <ErrorNote error={org.error} />
      {d && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card title="Plan">
              <div className="text-xl font-semibold" data-testid="org-plan">{sub?.plan.name ?? 'No plan'}</div>
              <div className="mt-1 text-xs text-sub">{sub ? `${sub.plan.code} v${sub.plan.version} · since ${formatDateTime(sub.startsAt)}${sub.endsAt ? ` · until ${formatDateTime(sub.endsAt)}` : ''}` : ''}</div>
              <div className="mt-2"><LicenseBadge status={d.license} /></div>
            </Card>
            <Card title="Limits" className="md:col-span-2" bodyClass="grid gap-x-6 px-4 py-2 md:grid-cols-2">
              {d.usage.map((u) => <UsageBar key={u.key} row={u} />)}
            </Card>
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-sub">Your enabled modules</h2>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {d.modules.filter((m) => m.purchased).map((m) => (
                <ModuleCard key={m.module} m={m} actions={m.module !== 'CORE' && (
                  m.enabled
                    ? <button className="btn" disabled={!m.canDisable} onClick={() => setDialog({ kind: 'module', m })}>Switch off</button>
                    : <button className="btn-primary" disabled={!m.canEnable} onClick={() => setDialog({ kind: 'module', m })}>Switch on</button>
                )} />
              ))}
            </div>
          </div>

          {d.upgrades.length > 0 && (
            <Card title="Available upgrades" bodyClass="divide-y divide-line">
              {d.upgrades.map((u) => (
                <div key={u.module} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm" data-testid={`upgrade-${u.module}`}>
                  <div className="flex-1">
                    <div className="font-medium">{u.name}</div>
                    <div className="text-xs text-sub">{u.description}{u.plans.length ? ` · included in ${u.plans.map((p) => p.name).join(', ')}` : ''}</div>
                  </div>
                  <span className="badge bg-slate-500/10 text-sub ring-slate-500/20">Not purchased</span>
                </div>
              ))}
              <div className="px-4 py-3 text-sm text-sub">{d.upgradeContact}</div>
            </Card>
          )}

          <Card title="Casinos" actions={
            <div className="flex gap-2">
              <button className="btn text-xs" onClick={() => setDialog({ kind: 'machine' })}><Plus className="h-3.5 w-3.5" /> Machine</button>
              <button className="btn-primary text-xs" onClick={() => setDialog({ kind: 'casino' })}><Building2 className="h-3.5 w-3.5" /> New casino</button>
            </div>
          } bodyClass="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Code</th><th>Name</th><th>Status</th><th className="text-right">Machines</th><th className="text-right">Users</th><th>Created</th><th /></tr></thead>
              <tbody>
                {casinos.data?.casinos.map((c) => (
                  <tr key={c.id}>
                    <td className="font-mono text-xs">{c.code}</td>
                    <td>{c.name}{c.city && <span className="text-xs text-sub"> · {c.city}</span>}</td>
                    <td><LicenseBadge status={c.status} />{c.status_reason && <div className="text-xs text-sub">{c.status_reason}</div>}</td>
                    <td className="text-right tabular-nums">{c.machines}</td>
                    <td className="text-right tabular-nums">{c.users}</td>
                    <td className="text-xs">{formatDateTime(c.created_at)}</td>
                    <td className="text-right">
                      <button className="btn px-2 py-1 text-xs" onClick={() => setDialog({ kind: 'casinoStatus', id: c.id, name: c.name, to: c.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })}>
                        {c.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {dialog?.kind === 'module' && (
        <ReasonDialog
          title={`${dialog.m.enabled ? 'Switch off' : 'Switch on'} ${dialog.m.name}`}
          description={dialog.m.enabled ? 'Pages and API of this module are refused while it is off. Existing data is kept.' : dialog.m.description}
          confirm={dialog.m.enabled ? 'Switch off' : 'Switch on'}
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => { await api(`/org/modules/${dialog.m.module}`, { method: 'PUT', json: { enabled: !dialog.m.enabled, reason } }); await reload(); }}
        />
      )}
      {dialog?.kind === 'casinoStatus' && (
        <ReasonDialog
          title={`${dialog.to === 'ACTIVE' ? 'Activate' : 'Deactivate'} ${dialog.name}`}
          description={dialog.to === 'INACTIVE' ? 'An inactive casino cannot be operated; its data is kept.' : undefined}
          confirm={dialog.to === 'ACTIVE' ? 'Activate' : 'Deactivate'}
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => { await api(`/org/casinos/${dialog.id}/status`, { method: 'PUT', json: { status: dialog.to, reason } }); await reload(); }}
        />
      )}
      {dialog?.kind === 'casino' && <NewCasino onClose={() => setDialog(null)} onDone={() => void reload()} />}
      {dialog?.kind === 'machine' && casinos.data && <NewMachine casinos={casinos.data.casinos} onClose={() => setDialog(null)} onDone={() => void reload()} />}
    </div>
  );
}
