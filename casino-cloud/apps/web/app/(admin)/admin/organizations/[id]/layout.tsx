'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { use } from 'react';
import { useApi } from '@/lib/api';
import { ErrorNote, PageHeader } from '@/components/ui';
import { LicenseBadge } from '@/components/admin-ui';
import { OrgCtx, type OrgDetail } from '@/components/admin-org';
import { clsx } from '@/components/clsx';

const TABS = [['', 'Overview'], ['/modules', 'Modules'], ['/users', 'Users'], ['/casinos', 'Casinos'], ['/settings', 'Settings'], ['/audit', 'Audit']] as const;

export default function OrgLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const pathname = usePathname();
  const { data, error, reload } = useApi<OrgDetail>(`/platform/organizations/${id}`);
  const o = data?.organization;
  return (
    <OrgCtx.Provider value={{ id, d: data, reload }}>
      <PageHeader
        title={o?.name ?? 'Organization'}
        subtitle={o && <span className="flex flex-wrap items-center gap-2">{o.slug} · {o.plan_name ?? 'no plan'}{o.plan_version ? ` v${o.plan_version}` : ''} <LicenseBadge status={o.license} /></span>}
        actions={<Link href="/admin/organizations" className="btn">All organizations</Link>}
      />
      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map(([path, label]) => {
          const href = `/admin/organizations/${id}${path}`;
          const active = path ? pathname.startsWith(href) : pathname === href;
          return <Link key={path} href={href} className={clsx('whitespace-nowrap border-b-2 px-3 py-2 text-sm', active ? 'border-brand font-semibold text-brand' : 'border-transparent text-sub hover:text-fg')}>{label}</Link>;
        })}
      </nav>
      <ErrorNote error={error} />
      {children}
    </OrgCtx.Provider>
  );
}
