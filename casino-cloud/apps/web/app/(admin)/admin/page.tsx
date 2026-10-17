'use client';
import Link from 'next/link';
import { Building2, Monitor, PauseCircle, Rocket, Users } from 'lucide-react';
import { useApi } from '@/lib/api';
import { Card, ErrorNote, Kpi, PageHeader } from '@/components/ui';
import { OrgTable, type OrgSummary } from '@/components/admin-org';

export default function AdminOverviewPage() {
  const { data, error } = useApi<{ organizations: OrgSummary[] }>('/platform/organizations');
  const customers = data?.organizations.filter((o) => !o.is_platform) ?? [];
  const attention = customers.filter((o) => o.license !== 'VALID');
  return (
    <div className="space-y-6">
      <PageHeader title="Platform overview" subtitle="Customer organisations, plans and licenses" actions={<Link href="/admin/onboarding" className="btn-primary"><Rocket className="h-4 w-4" /> Onboard customer</Link>} />
      <ErrorNote error={error} />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Kpi label="Customers" icon={Building2} value={customers.length} sub={`${customers.filter((o) => o.status === 'ACTIVE').length} active`} />
        <Kpi label="Casinos" icon={Building2} value={customers.reduce((s, o) => s + o.active_casinos, 0)} />
        <Kpi label="Machines" icon={Monitor} value={customers.reduce((s, o) => s + o.machines, 0)} />
        <Kpi label="Users" icon={Users} value={customers.reduce((s, o) => s + o.users, 0)} />
      </div>
      {attention.length > 0 && (
        <Card title={<span className="flex items-center gap-2"><PauseCircle className="h-4 w-4 text-amber-600" />Needs attention</span>} bodyClass="overflow-x-auto">
          <OrgTable orgs={attention} />
        </Card>
      )}
      <Card title="All organizations" bodyClass="overflow-x-auto">{data && <OrgTable orgs={data.organizations} />}</Card>
    </div>
  );
}
