'use client';
import { api, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Card, ErrorNote, PageHeader } from '@/components/ui';

export default function SettingsPage() {
  const { casino, can, refresh, me } = useSession();
  const { data, error, reload } = useApi<any[]>(`/casinos/${casino.id}/modules`);
  const toggle = async (key: string, enabled: boolean) => {
    try {
      await api(`/casinos/${casino.id}/modules/${key}`, { method: 'PUT', json: { enabled } });
      await Promise.all([reload(), refresh()]);
    } catch (e) {
      alert((e as Error).message);
    }
  };
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" subtitle={`${casino.name} · Configure instead of code: enable only the modules this casino needs.`} />
      <ErrorNote error={error} />
      <Card title="Modules" bodyClass="divide-y divide-line">
        {data?.map((m) => (
          <label key={m.key} className="flex cursor-pointer items-center gap-4 px-4 py-3">
            <input type="checkbox" className="h-5 w-5 accent-violet-600" checked={m.enabled} disabled={m.core || !can('settings.manage')} onChange={(e) => toggle(m.key, e.target.checked)} />
            <div className="flex-1">
              <div className="font-medium">{m.name} {m.core && <span className="ml-1 text-xs text-sub">(core)</span>}</div>
              <div className="text-xs text-sub">{m.description}</div>
            </div>
            <span className="rounded bg-muted px-2 py-0.5 text-xs text-sub">Phase {m.phase}</span>
          </label>
        ))}
      </Card>
      <Card title="Account">
        <div className="text-sm">Signed in as <b>{me.user.email}</b> ({me.user.role}) in <b>{me.organization.name}</b>.</div>
        <div className="mt-2 flex flex-wrap gap-1">
          {me.permissions.map((p) => <span key={p} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{p}</span>)}
        </div>
      </Card>
    </div>
  );
}
