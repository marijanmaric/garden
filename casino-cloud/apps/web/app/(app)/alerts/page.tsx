'use client';
import { useState } from 'react';
import { SEVERITY_BADGE, formatDateTime, timeAgo } from '@m1/ui';
import { api, useApi } from '@/lib/api';
import { useLiveRefresh } from '@/lib/live';
import { useSession } from '@/lib/session';
import { Card, Empty, ErrorNote, PageHeader } from '@/components/ui';
import { clsx } from '@/components/clsx';

const FILTERS = ['ACTIVE', 'OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'ALL'];

export default function AlertsPage() {
  const { casino, can } = useSession();
  const [status, setStatus] = useState('ACTIVE');
  const { data, error, reload } = useApi<any[]>(`/alerts?casinoId=${casino.id}&status=${status}`);
  useLiveRefresh(() => void reload(), 1000, ['alert.created', 'alert.updated']);

  const act = async (id: string, action: 'acknowledge' | 'resolve') => {
    await api(`/alerts/${id}/${action}`, { method: 'POST' }).catch((e) => alert(e.message));
    await reload();
  };

  return (
    <div>
      <PageHeader title="Alerts" subtitle="Raised automatically from machine and gateway events. Conditions that clear resolve their alert." />
      <ErrorNote error={error} />
      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button key={f} className={status === f ? 'btn-primary' : 'btn'} onClick={() => setStatus(f)}>{f}</button>
        ))}
      </div>
      <Card bodyClass="overflow-x-auto">
        {data && !data.length && <Empty>No alerts</Empty>}
        {!!data?.length && (
          <table className="table">
            <thead><tr><th>Severity</th><th>Type</th><th>Message</th><th>Source</th><th>Raised</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td><span className={clsx('badge', SEVERITY_BADGE[a.severity])}>{a.severity}</span></td>
                  <td className="text-xs font-medium">{a.type}</td>
                  <td>{a.message}</td>
                  <td>{a.asset_no ?? a.device_id ?? '-'}</td>
                  <td className="text-xs text-sub" title={formatDateTime(a.created_at)}>{timeAgo(a.created_at)}</td>
                  <td className="text-xs">{a.status}{a.acknowledged_by_email ? ` · ${a.acknowledged_by_email}` : ''}</td>
                  <td className="text-right">
                    {can('alert.manage') && a.status === 'OPEN' && <button className="btn py-1 text-xs" onClick={() => act(a.id, 'acknowledge')}>Acknowledge</button>}
                    {can('alert.manage') && a.status !== 'RESOLVED' && <button className="btn ml-2 py-1 text-xs" onClick={() => act(a.id, 'resolve')}>Resolve</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
