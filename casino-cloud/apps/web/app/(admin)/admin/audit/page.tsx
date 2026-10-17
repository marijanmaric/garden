'use client';
import { useApi } from '@/lib/api';
import { Card, ErrorNote, PageHeader } from '@/components/ui';
import { AuditList } from '@/components/admin-ui';

export default function PlatformAuditPage() {
  const { data, error } = useApi<{ entries: any[] }>('/platform/audit', { refreshMs: 15000 });
  return (
    <div className="space-y-6">
      <PageHeader title="Platform audit" subtitle="Every platform action across organisations (old value, new value, reason); also recorded in each customer's own chain." />
      <ErrorNote error={error} />
      <Card bodyClass="overflow-x-auto">{data && <AuditList entries={data.entries} />}</Card>
    </div>
  );
}
