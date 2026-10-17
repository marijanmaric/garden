'use client';
import { useApi } from '@/lib/api';
import { Card, ErrorNote } from '@/components/ui';
import { AuditList } from '@/components/admin-ui';
import { useOrg } from '@/components/admin-org';

export default function OrgAuditPage() {
  const { id } = useOrg();
  const { data, error } = useApi<{ entries: any[] }>(`/platform/organizations/${id}/audit`, { refreshMs: 15000 });
  return (
    <>
      <ErrorNote error={error} />
      <Card title="Administrative audit (modules, plan, limits, status, users, casinos, machines, logins)" bodyClass="overflow-x-auto">
        {data && <AuditList entries={data.entries} />}
      </Card>
    </>
  );
}
