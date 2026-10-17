'use client';
import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { formatDateTime } from '@m1/ui';
import { api, useApi } from '@/lib/api';
import { Card, ErrorNote, Field, Modal } from '@/components/ui';
import { LicenseBadge } from '@/components/admin-ui';
import { useOrg } from '@/components/admin-org';

export default function OrgUsersPage() {
  const { id, reload } = useOrg();
  const { data, error, reload: again } = useApi<{ users: Array<{ id: string; email: string; name: string; role: string; active: boolean; is_platform_admin: boolean; last_login_at: string | null; casinos: string[] }> }>(`/platform/organizations/${id}/users`);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', email: '', password: '', reason: '' });
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <ErrorNote error={error} />
      <Card title="Users" actions={<button className="btn-primary text-xs" onClick={() => setOpen(true)}><UserPlus className="h-3.5 w-3.5" /> Add customer admin</button>} bodyClass="overflow-x-auto">
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Casinos</th><th>Last login</th></tr></thead>
          <tbody>
            {data?.users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}{u.is_platform_admin && <span className="ml-1 text-xs text-brand">platform admin</span>}</td>
                <td className="text-sm">{u.email}</td>
                <td className="text-xs">{u.role.replace(/_/g, ' ')}</td>
                <td><LicenseBadge status={u.active ? 'ACTIVE' : 'INACTIVE'} /></td>
                <td className="text-xs">{u.casinos.join(', ') || '-'}</td>
                <td className="text-xs">{u.last_login_at ? formatDateTime(u.last_login_at) : 'never'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="px-4 py-3 text-xs text-sub">All other users are managed by the customer administrator (role rules apply: nobody assigns a role above their own).</div>
      </Card>
      {open && (
        <Modal title="Add customer admin" onClose={() => setOpen(false)}>
          <form className="space-y-3" onSubmit={async (e) => {
            e.preventDefault();
            try { await api(`/platform/organizations/${id}/users`, { method: 'POST', json: f }); setOpen(false); await Promise.all([again(), reload()]); } catch (x) { setErr((x as Error).message); }
          }}>
            <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Email"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Initial password" hint="At least 12 characters"><input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
            <Field label="Reason (audited)"><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
            <ErrorNote error={err} />
            <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button><button className="btn-primary">Create</button></div>
          </form>
        </Modal>
      )}
    </>
  );
}
