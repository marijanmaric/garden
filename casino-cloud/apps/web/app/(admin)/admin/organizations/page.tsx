'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Rocket } from 'lucide-react';
import { useApi } from '@/lib/api';
import { Card, ErrorNote, PageHeader } from '@/components/ui';
import { OrgTable, type OrgSummary } from '@/components/admin-org';

export default function OrganizationsPage() {
  const { data, error } = useApi<{ organizations: OrgSummary[] }>('/platform/organizations');
  const [q, setQ] = useState('');
  const list = (data?.organizations ?? []).filter((o) => !q || `${o.name} ${o.slug} ${o.plan_name}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-6">
      <PageHeader title="Organizations" subtitle={`${data?.organizations.length ?? 0} organisations`} actions={<>
        <input className="input w-56" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <Link href="/admin/onboarding" className="btn-primary"><Rocket className="h-4 w-4" /> Onboard</Link>
      </>} />
      <ErrorNote error={error} />
      <Card bodyClass="overflow-x-auto">{data && <OrgTable orgs={list} />}</Card>
    </div>
  );
}
