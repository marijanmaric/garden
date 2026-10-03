'use client';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Card, ErrorNote, PageHeader, Stat } from '@/components/ui';

export default function CasinosPage() {
  const { me, setCasinoId, casino } = useSession();
  const { data, error } = useApi<any[]>('/casinos');
  return (
    <div>
      <PageHeader title="Casinos" subtitle={`${me.organization.name} · properties you have access to`} />
      <ErrorNote error={error} />
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {data?.map((c) => (
          <Card key={c.id} title={<span>{c.name} <span className="ml-1 font-mono text-xs text-sub">{c.code}</span></span>}
            actions={c.id === casino.id ? <span className="text-xs text-brand">selected</span> : <button className="btn py-1 text-xs" onClick={() => setCasinoId(c.id)}>Select</button>}>
            <Stat label="Location" value={`${c.city}, ${c.country}`} />
            <Stat label="Timezone / Currency" value={`${c.timezone} · ${c.currency}`} />
            <Stat label="Machines online" value={`${c.online} / ${c.machines}`} />
            <Stat label="Open alerts" value={c.open_alerts} tone={c.open_alerts ? 'warn' : undefined} />
            <div className="mt-3 border-t border-line pt-3">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-sub">Floors</div>
              {(c.floor_list ?? []).map((f: any) => <Stat key={f.id} label={f.name} value={`${f.machines} machines`} />)}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
