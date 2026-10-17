'use client';
import { useState } from 'react';
import { Building2, Plus } from 'lucide-react';
import { formatDateTime } from '@m1/ui';
import { api, useApi } from '@/lib/api';
import { Card, ErrorNote, Field, Modal } from '@/components/ui';
import { LicenseBadge, ReasonDialog } from '@/components/admin-ui';
import { useOrg } from '@/components/admin-org';

type Casino = { id: string; code: string; name: string; city: string | null; country: string | null; status: string; status_reason: string | null; machines: number; rails_on_ledger: number; created_at: string };

export default function OrgCasinosPage() {
  const { id, reload } = useOrg();
  const { data, error, reload: again } = useApi<{ casinos: Casino[] }>(`/platform/organizations/${id}/casinos`);
  const [dlg, setDlg] = useState<null | 'casino' | 'machine' | { c: Casino }>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const refresh = async () => { await Promise.all([again(), reload()]); };
  const submit = async (path: string, json: unknown) => {
    try { await api(path, { method: 'POST', json }); setDlg(null); setF({}); setErr(null); await refresh(); } catch (x) { setErr((x as Error).message); }
  };
  const active = data?.casinos.filter((c) => c.status === 'ACTIVE') ?? [];
  return (
    <>
      <ErrorNote error={error} />
      <Card title="Casinos" actions={<div className="flex gap-2">
        <button className="btn text-xs" disabled={!active.length} onClick={() => { setF({ casinoId: active[0]?.id }); setDlg('machine'); }}><Plus className="h-3.5 w-3.5" /> Machine</button>
        <button className="btn-primary text-xs" onClick={() => setDlg('casino')}><Building2 className="h-3.5 w-3.5" /> New casino</button>
      </div>} bodyClass="overflow-x-auto">
        <table className="table">
          <thead><tr><th>Code</th><th>Name</th><th>Status</th><th className="text-right">Machines</th><th className="text-right">Rails on ledger</th><th>Created</th><th /></tr></thead>
          <tbody>
            {data?.casinos.map((c) => (
              <tr key={c.id}>
                <td className="font-mono text-xs">{c.code}</td>
                <td>{c.name}<div className="text-xs text-sub">{[c.city, c.country].filter(Boolean).join(', ')}</div></td>
                <td><LicenseBadge status={c.status} />{c.status_reason && <div className="text-xs text-sub">{c.status_reason}</div>}</td>
                <td className="text-right tabular-nums">{c.machines}</td>
                <td className="text-right tabular-nums">{c.rails_on_ledger}</td>
                <td className="text-xs">{formatDateTime(c.created_at)}</td>
                <td className="text-right"><button className="btn px-2 py-1 text-xs" onClick={() => setDlg({ c })}>{c.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {dlg === 'casino' && (
        <Modal title="New casino" onClose={() => setDlg(null)}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(`/platform/organizations/${id}/casinos`, { code: f.code, name: f.name, city: f.city || undefined, country: f.country || undefined }); }}>
            <div className="grid grid-cols-2 gap-3">
              {(['code', 'name', 'city', 'country'] as const).map((k) => <Field key={k} label={k}><input className="input" name={k} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}
            </div>
            <ErrorNote error={err} />
            <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={() => setDlg(null)}>Cancel</button><button className="btn-primary">Create</button></div>
          </form>
        </Modal>
      )}
      {dlg === 'machine' && (
        <Modal title="New machine" onClose={() => setDlg(null)}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(`/platform/organizations/${id}/machines`, { casinoId: f.casinoId, machineCode: f.machineCode, assetNo: f.assetNo, game: f.game || undefined }); }}>
            <Field label="Casino"><select className="input" value={f.casinoId} onChange={(e) => setF({ ...f, casinoId: e.target.value })}>{active.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <div className="grid grid-cols-2 gap-3">
              {(['machineCode', 'assetNo', 'game'] as const).map((k) => <Field key={k} label={k}><input className="input" name={k} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}
            </div>
            <ErrorNote error={err} />
            <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={() => setDlg(null)}>Cancel</button><button className="btn-primary">Create</button></div>
          </form>
        </Modal>
      )}
      {dlg && typeof dlg === 'object' && (
        <ReasonDialog title={`${dlg.c.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} ${dlg.c.name}`} confirm={dlg.c.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} onClose={() => setDlg(null)}
          onConfirm={async (reason) => { await api(`/platform/organizations/${id}/casinos/${dlg.c.id}/status`, { method: 'PUT', json: { status: dlg.c.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE', reason } }); await refresh(); }} />
      )}
    </>
  );
}
