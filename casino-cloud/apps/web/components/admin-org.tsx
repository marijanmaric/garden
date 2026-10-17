'use client';
import Link from 'next/link';
import { createContext, useContext } from 'react';
import { formatDateTime, timeAgo } from '@m1/ui';
import { LicenseBadge, type ModuleCardData, type UsageRow } from './admin-ui';

export interface OrgSummary {
  id: string; name: string; slug: string; status: string; status_reason: string | null; is_platform: boolean; created_at: string;
  subscription_status: string | null; starts_at: string | null; ends_at: string | null; plan_code: string | null; plan_name: string | null; plan_version: number | null;
  casinos: number; active_casinos: number; machines: number; users: number; last_activity: string | null; license: string; modules: string[]; inUse: string[];
}

const SHORT: Record<string, string> = { CORE: 'Core', TITO: 'TITO', HANDPAY: 'Handpay', CASH: 'Cash', VAULT: 'Vault', CASHLESS: 'Cashless', MACHINE: 'Machine', REPORTING: 'Reports', ADVANCED_RECONCILIATION: 'Adv. recon' };

export function OrgTable({ orgs }: { orgs: OrgSummary[] }) {
  return (
    <table className="table" data-testid="org-table">
      <thead><tr><th>Organization</th><th>Status</th><th>Plan</th><th>Modules</th><th className="text-right">Casinos</th><th className="text-right">Machines</th><th className="text-right">Users</th><th>Created</th><th>Activity</th><th>License</th></tr></thead>
      <tbody>
        {orgs.map((o) => (
          <tr key={o.id}>
            <td><Link href={`/admin/organizations/${o.id}`} className="font-medium text-brand">{o.name}</Link><div className="text-xs text-sub">{o.slug}{o.is_platform ? ' · platform' : ''}</div></td>
            <td><LicenseBadge status={o.status} /></td>
            <td className="text-sm">{o.plan_name ?? '-'}{o.plan_version && <span className="text-xs text-sub"> v{o.plan_version}</span>}</td>
            <td className="min-w-[15rem] max-w-[20rem]"><div className="flex flex-wrap gap-1">{o.inUse.filter((m) => m !== 'CORE').map((m) => <span key={m} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{SHORT[m] ?? m}</span>)}</div></td>
            <td className="text-right tabular-nums">{o.active_casinos}{o.casinos !== o.active_casinos && <span className="text-xs text-sub">/{o.casinos}</span>}</td>
            <td className="text-right tabular-nums">{o.machines}</td>
            <td className="text-right tabular-nums">{o.users}</td>
            <td className="whitespace-nowrap text-xs">{formatDateTime(o.created_at).split(',')[0]}</td>
            <td className="whitespace-nowrap text-xs">{o.last_activity ? timeAgo(o.last_activity) : '-'}</td>
            <td><LicenseBadge status={o.license} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The organisation detail of the admin portal (loaded once by the detail layout, shared by its tabs). */
export interface OrgDetail {
  organization: OrgSummary;
  modules: ModuleCardData[];
  usage: UsageRow[];
  overrides: Array<{ module_key: string; entitled: boolean; reason: string; created_at: string }>;
  limitOverrides: Array<{ limit_key: string; value: number | null; reason: string; created_at: string }>;
  subscription: null | { plan_id: string; code: string; plan_name: string; version: number; status: string; starts_at: string; ends_at: string | null; note: string | null };
}

export const OrgCtx = createContext<{ id: string; d: OrgDetail | null; reload: () => Promise<void> } | null>(null);
export const useOrg = () => useContext(OrgCtx)!;

