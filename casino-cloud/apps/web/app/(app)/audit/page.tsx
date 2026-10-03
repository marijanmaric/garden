'use client';
import { useState } from 'react';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { formatDateTime } from '@m1/ui';
import { api, useApi } from '@/lib/api';
import { Card, ErrorNote, PageHeader } from '@/components/ui';

export default function AuditPage() {
  const [action, setAction] = useState('');
  const { data, error, reload } = useApi<any[]>(`/audit?limit=200${action ? `&action=${encodeURIComponent(action)}` : ''}`, { refreshMs: 10000 });
  const [verify, setVerify] = useState<any>(null);

  return (
    <div>
      <PageHeader
        title="Audit Log"
        subtitle="Append-only, hash-chained record of every security and configuration relevant action."
        actions={
          <>
            <input className="input w-48" placeholder="Filter action prefix..." value={action} onChange={(e) => setAction(e.target.value)} />
            <button className="btn" onClick={() => reload()}>Refresh</button>
            <button className="btn-primary" onClick={async () => setVerify(await api('/audit/verify'))}>Verify integrity</button>
          </>
        }
      />
      <ErrorNote error={error} />
      {verify && (
        <div className={`mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${verify.valid ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-red-500/10 text-red-600'}`}>
          {verify.valid ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
          {verify.valid ? `Hash chain intact: ${verify.entries} entries verified.` : `Chain broken at entry #${verify.brokenAt}!`}
        </div>
      )}
      <Card bodyClass="overflow-x-auto">
        <table className="table">
          <thead><tr><th>#</th><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th><th>IP</th><th>Hash</th></tr></thead>
          <tbody>
            {data?.map((a) => (
              <tr key={a.id}>
                <td className="font-mono text-xs text-sub">{a.id}</td>
                <td className="text-xs">{formatDateTime(a.created_at)}</td>
                <td className="text-xs"><span className="text-sub">{a.actor_type}</span> {a.actor_name}</td>
                <td className="font-medium">{a.action}</td>
                <td className="text-xs text-sub">{a.entity_type}{a.entity_id ? ` ${String(a.entity_id).slice(0, 12)}` : ''}</td>
                <td className="max-w-xs truncate font-mono text-[11px] text-sub" title={JSON.stringify(a.details)}>{Object.keys(a.details).length ? JSON.stringify(a.details) : ''}</td>
                <td className="text-xs text-sub">{a.ip ?? ''}</td>
                <td className="font-mono text-[10px] text-sub">{a.hash.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
