'use client';
import { formatDateTime, timeAgo } from '@m1/ui';
import { Card, Stat } from '@/components/ui';
import { ModuleStateBadge, UsageBar } from '@/components/admin-ui';
import { useOrg } from '@/components/admin-org';

export default function OrgOverviewPage() {
  const { d } = useOrg();
  if (!d) return <div className="text-sub">Loading...</div>;
  const o = d.organization;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="Organization">
        <Stat label="Status" value={o.status} tone={o.status === 'ACTIVE' ? 'good' : 'bad'} />
        {o.status_reason && <div className="text-xs text-sub">{o.status_reason}</div>}
        <Stat label="Casinos (active / all)" value={`${o.active_casinos} / ${o.casinos}`} />
        <Stat label="Machines" value={o.machines} />
        <Stat label="Users (active)" value={o.users} />
        <Stat label="Created" value={formatDateTime(o.created_at)} />
        <Stat label="Last activity" value={o.last_activity ? timeAgo(o.last_activity) : '-'} />
      </Card>
      <Card title="Subscription">
        <Stat label="Plan" value={d.subscription ? `${d.subscription.plan_name} v${d.subscription.version}` : '-'} />
        <Stat label="Status" value={d.subscription?.status ?? '-'} />
        <Stat label="Starts" value={d.subscription ? formatDateTime(d.subscription.starts_at) : '-'} />
        <Stat label="Ends" value={d.subscription?.ends_at ? formatDateTime(d.subscription.ends_at) : 'open-ended'} />
        <Stat label="License" value={o.license} tone={o.license === 'VALID' || o.license === 'TRIAL' ? 'good' : 'bad'} />
        <div className="mt-2 text-xs text-sub">No billing in this system: price fields of plans are metadata only.</div>
      </Card>
      <Card title="Modules" bodyClass="divide-y divide-line">
        {d.modules.map((m) => (
          <div key={m.module} className="flex items-center justify-between px-4 py-2 text-sm"><span>{m.name}</span><ModuleStateBadge state={m.state} /></div>
        ))}
      </Card>
      <Card title="Limits and usage" className="lg:col-span-3" bodyClass="grid gap-x-6 px-4 py-2 md:grid-cols-2 xl:grid-cols-4">
        {d.usage.map((u) => <UsageBar key={u.key} row={u} />)}
      </Card>
    </div>
  );
}
