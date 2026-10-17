'use client';
import Link from 'next/link';
import { useSession } from '@/lib/session';
import { Card, PageHeader } from '@/components/ui';
import { clsx } from '@/components/clsx';

const STATE_TONE: Record<string, string> = {
  ENABLED: 'bg-emerald-500/15 text-emerald-600 ring-emerald-500/30',
  DISABLED: 'bg-slate-500/15 text-slate-500 ring-slate-500/30',
  NOT_PURCHASED: 'bg-slate-500/10 text-sub ring-slate-500/20',
  DEPENDENCY_MISSING: 'bg-amber-500/15 text-amber-600 ring-amber-500/30',
  SUBSCRIPTION_INACTIVE: 'bg-red-500/15 text-red-600 ring-red-500/30',
};

/** Account and the organisation's modules (read-only here; the organisation admin manages them). */
export default function SettingsPage() {
  const { me, can, casino } = useSession();
  const ent = me.entitlements;
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" subtitle={`${me.organization.name} · ${casino.name}`} />
      <Card title="Your enabled modules" actions={can('org.manage') && <Link href="/organization" className="text-xs font-medium text-brand">Manage modules →</Link>} bodyClass="divide-y divide-line">
        {ent.modules.map((m) => (
          <div key={m.module} className="flex items-center gap-4 px-4 py-2.5 text-sm">
            <span className="flex-1 font-medium">{m.name}</span>
            <span className={clsx('badge', STATE_TONE[m.state])}>{m.state.replace(/_/g, ' ')}</span>
          </div>
        ))}
        {ent.modules.some((m) => !m.purchased) && (
          <div className="px-4 py-3 text-xs text-sub">Available upgrades are shown as NOT PURCHASED. {can('org.manage') ? 'Contact your platform administrator to upgrade.' : 'Contact your administrator to upgrade.'}</div>
        )}
      </Card>
      <Card title="Account">
        <div className="text-sm">Signed in as <b>{me.user.email}</b> ({me.user.role.replace(/_/g, ' ')}) in <b>{me.organization.name}</b>{ent.subscription && <> · plan <b>{ent.subscription.plan.name}</b></>}.</div>
        <div className="mt-2 flex flex-wrap gap-1">
          {me.permissions.map((p) => <span key={p} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{p}</span>)}
        </div>
      </Card>
    </div>
  );
}
