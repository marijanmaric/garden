'use client';
import { PERMISSIONS, ROLES } from '@m1/shared';
import { timeAgo } from '@m1/ui';
import { useApi } from '@/lib/api';
import { Card, ErrorNote, PageHeader } from '@/components/ui';

export default function EmployeesPage() {
  const { data, error } = useApi<any>('/employees');
  return (
    <div className="space-y-6">
      <PageHeader title="Employees" subtitle="Staff accounts and role based access control (RBAC)." />
      <ErrorNote error={error} />
      <Card bodyClass="overflow-x-auto">
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Casinos</th><th>Last login</th><th>Status</th></tr></thead>
          <tbody>
            {data?.employees.map((e: any) => (
              <tr key={e.id}>
                <td className="font-medium">{e.name}</td>
                <td>{e.email}</td>
                <td className="text-xs font-semibold">{e.role}</td>
                <td className="text-xs">{(e.casinos ?? []).join(', ')}</td>
                <td className="text-xs text-sub">{timeAgo(e.last_login_at)}</td>
                <td className="text-xs">{e.active ? 'active' : 'disabled'}</td>
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
    </div>
  );
}
