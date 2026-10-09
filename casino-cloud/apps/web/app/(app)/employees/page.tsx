'use client';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS, ROLES } from '@m1/shared';
import { formatDateTime, formatEuro, timeAgo } from '@m1/ui';
import { api, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Card, ErrorNote, Field, Modal, Notice, PageHeader } from '@/components/ui';
import { clsx } from '@/components/clsx';

function EmployeeForm({ employee, onClose, onSaved }: { employee: any | null; onClose: () => void; onSaved: () => void }) {
  const { me } = useSession();
  const [form, setForm] = useState({
    name: employee?.name ?? '', email: employee?.email ?? '', phone: employee?.phone ?? '', role: employee?.role ?? 'CASHIER',
    active: employee?.active ?? true, password: '', casinoIds: (employee?.casinos ?? []).map((c: any) => c.id) as string[],
  });
  const [error, setError] = useState<string | null>(null);
  const roles = me.user.role === 'SUPER_ADMIN' ? ROLES : ROLES.filter((r) => r !== 'SUPER_ADMIN');
  const save = async () => {
    setError(null);
    try {
      const body: any = { name: form.name, role: form.role, casinoIds: form.casinoIds, phone: form.phone || undefined };
      if (employee) await api(`/employees/${employee.id}`, { method: 'PUT', json: { ...body, active: form.active, password: form.password || undefined } });
      else await api('/employees', { method: 'POST', json: { ...body, email: form.email, password: form.password } });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={employee ? `Edit ${employee.name}` : 'New employee'} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Email"><input className="input" type="email" disabled={!!employee} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Phone"><input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        <Field label="Role">
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {roles.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
          </select>
        </Field>
        <Field label="Casino access">
          <div className="space-y-1">
            {me.casinos.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-violet-600" checked={form.casinoIds.includes(c.id)}
                  onChange={(e) => setForm({ ...form, casinoIds: e.target.checked ? [...form.casinoIds, c.id] : form.casinoIds.filter((x) => x !== c.id) })} />
                {c.name}
              </label>
            ))}
          </div>
        </Field>
        <Field label={employee ? 'New password (optional)' : 'Initial password'} hint="At least 8 characters">
          <input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
        </Field>
        {employee && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-violet-600" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Account active
          </label>
        )}
        {error && <Notice tone="bad">{error}</Notice>}
        <button className="btn-primary w-full" onClick={save}>Save</button>
      </div>
    </Modal>
  );
}

function Activity({ employee, onClose }: { employee: any; onClose: () => void }) {
  const { data } = useApi<any>(`/employees/${employee.id}/activity`);
  return (
    <Modal title={`Activity · ${employee.name}`} onClose={onClose} wide>
      {!data ? <div className="text-sub">Loading...</div> : (
        <div className="space-y-5">
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-sub">Cashier shifts</div>
            {!data.sessions.length && <div className="text-sm text-sub">No shifts.</div>}
            {data.sessions.map((s: any) => (
              <div key={s.id} className="flex justify-between border-b border-line/60 py-1.5 text-sm">
                <span>{s.desk} · {formatDateTime(s.opened_at)} {s.closed_at ? `to ${formatDateTime(s.closed_at)}` : '(open)'}</span>
                <span className={clsx('tabular-nums', s.difference ? 'font-semibold text-red-600' : 'text-sub')}>{s.difference != null ? `diff ${formatEuro(s.difference)}` : ''}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-sub">Audit trail</div>
            {data.audit.map((a: any) => (
              <div key={a.id} className="flex justify-between gap-3 border-b border-line/60 py-1.5 text-sm">
                <span className="font-medium">{a.action}</span>
                <span className="truncate text-xs text-sub">{formatDateTime(a.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function EmployeesPage() {
  const { can } = useSession();
  const { data, error, reload } = useApi<any>('/employees');
  const [edit, setEdit] = useState<any | null | undefined>(undefined);
  const [activity, setActivity] = useState<any | null>(null);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Employees"
        subtitle="Staff accounts, roles and casino access (RBAC). Every change is audited."
        actions={can('user.manage') && <button className="btn-primary" onClick={() => setEdit(null)}><Plus className="h-4 w-4" /> New employee</button>}
      />
      <ErrorNote error={error} />
      <Card bodyClass="overflow-x-auto">
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Casinos</th><th>Shift</th><th>Last login</th><th>Status</th><th /></tr></thead>
          <tbody>
            {data?.employees.map((e: any) => (
              <tr key={e.id} className={e.active ? '' : 'opacity-50'}>
                <td className="font-medium">{e.name}</td>
                <td>{e.email}</td>
                <td className="text-xs font-semibold">{e.role.replace(/_/g, ' ')}</td>
                <td className="text-xs">{e.casinos.map((c: any) => c.name).join(', ')}</td>
                <td className="text-xs">{e.open_desk ? <span className="badge bg-emerald-500/15 text-emerald-600 ring-emerald-500/30">{e.open_desk}</span> : ''}</td>
                <td className="text-xs text-sub">{timeAgo(e.last_login_at)}</td>
                <td className="text-xs">{e.active ? 'active' : 'disabled'}</td>
                <td className="text-right">
                  <button className="btn py-1 text-xs" onClick={() => setActivity(e)}>Activity</button>
                  {can('user.manage') && <button className="btn ml-2 py-1 text-xs" onClick={() => setEdit(e)}>Edit</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {data && (
        <Card title="Permission matrix" bodyClass="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Permission</th>{ROLES.map((r) => <th key={r} className="text-center">{r.replace(/_/g, ' ')}</th>)}</tr></thead>
            <tbody>
              {PERMISSIONS.map((p) => (
                <tr key={p}>
                  <td className="font-mono text-xs">{p}</td>
                  {ROLES.map((r) => <td key={r} className="text-center">{data.rolePermissions[r].includes(p) ? <span className="text-emerald-600">✓</span> : <span className="text-sub/50">·</span>}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {edit !== undefined && <EmployeeForm employee={edit} onClose={() => setEdit(undefined)} onSaved={reload} />}
      {activity && <Activity employee={activity} onClose={() => setActivity(null)} />}
    </div>
  );
}
