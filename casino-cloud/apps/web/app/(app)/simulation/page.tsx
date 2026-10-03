'use client';
import { useEffect, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { api, useApi } from '@/lib/api';
import { useLive, useLiveRefresh } from '@/lib/live';
import { useSession } from '@/lib/session';
import { Card, ErrorNote, Kpi, PageHeader } from '@/components/ui';
import { EventFeed } from '@/components/EventFeed';

export default function SimulationPage() {
  const { casino, can } = useSession();
  const { events } = useLive();
  const { data, error, reload } = useApi<any>(`/simulation?casinoId=${casino.id}`);
  const [eps, setEps] = useState(2);
  const [busy, setBusy] = useState(false);
  const [rate, setRate] = useState(0);
  useEffect(() => { if (data) setEps(data.eventsPerSecond); }, [data]);
  useLiveRefresh(() => void reload(), 500, ['simulation.updated']);
  useEffect(() => {
    const t = setInterval(() => setRate(events.filter((e) => Date.now() - e.receivedAt < 10000).length / 10), 1000);
    return () => clearInterval(t);
  }, [events]);

  const update = async (running: boolean) => {
    setBusy(true);
    try {
      await api('/simulation', { method: 'PUT', json: { casinoId: casino.id, running, eventsPerSecond: eps } });
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Simulation Controller" subtitle="Drives the SimulatorAdapter on the edge gateway through its remote configuration." />
      <ErrorNote error={error} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Controller">
          {data && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <span className="text-sm text-sub">Status</span>
                <span className={`badge ${data.running ? 'bg-emerald-500/15 text-emerald-600 ring-emerald-500/30' : 'bg-slate-500/15 text-slate-500 ring-slate-500/30'}`}>{data.running ? 'RUNNING' : 'STOPPED'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-sub">Machines</span>
                <span className="font-semibold">{data.machines}</span>
              </div>
              <div>
                <div className="mb-2 flex justify-between text-sm"><span className="text-sub">Event frequency</span><span className="font-semibold">{eps} events/sec</span></div>
                <input type="range" min={1} max={5} step={1} value={eps} onChange={(e) => setEps(Number(e.target.value))} className="w-full accent-violet-600" disabled={!can('simulation.control')} />
              </div>
              {can('simulation.control') ? (
                <div className="grid grid-cols-2 gap-2">
                  <button className="btn-primary py-3" disabled={busy} onClick={() => update(true)}><Play className="h-4 w-4" /> {data.running ? 'APPLY' : 'START'}</button>
                  <button className="btn-danger py-3" disabled={busy || !data.running} onClick={() => update(false)}><Square className="h-4 w-4" /> STOP</button>
                </div>
              ) : (
                <div className="text-xs text-sub">Your role cannot control the simulation.</div>
              )}
              <p className="text-xs text-sub">Changes reach the gateway within ~2 seconds (next heartbeat) and are recorded in the audit log.</p>
            </div>
          )}
        </Card>
        <div className="grid gap-4 sm:grid-cols-2 lg:col-span-2">
          <Kpi label="Observed rate" value={`${rate.toFixed(1)} ev/s`} sub="last 10 seconds, incl. status events" />
          <Kpi label="Events this session" value={events.length >= 150 ? '150+' : events.length} sub="since this page opened" />
          <Card title="How it works" className="sm:col-span-2">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-sub">
              <li>The gateway runs one adapter per machine (here: SimulatorAdapter).</li>
              <li>Adapters translate native events into the internal event model.</li>
              <li>Events go into the gateway&apos;s durable offline queue, then to the cloud API.</li>
              <li>The API ingests idempotently, updates meters, ledger, alerts and streams them here.</li>
            </ol>
          </Card>
        </div>
      </div>
      <Card title="Live Events" bodyClass="max-h-[480px] overflow-y-auto"><EventFeed limit={150} /></Card>
    </div>
  );
}
