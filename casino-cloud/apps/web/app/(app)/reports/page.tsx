'use client';
import { useMemo, useState } from 'react';
import { Download, FileSpreadsheet, FileText, Play } from 'lucide-react';
import { formatDateTime, formatEuro, formatNumber } from '@m1/ui';
import { api, download, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Card, ErrorNote, Field, PageHeader } from '@/components/ui';
import { clsx } from '@/components/clsx';

const iso = (d: Date) => d.toISOString().slice(0, 10);

function cell(type: string, v: any) {
  if (v === null || v === undefined || v === '') return '';
  switch (type) {
    case 'money': return formatEuro(v);
    case 'number': return formatNumber(v);
    case 'percent': return `${(Number(v) * 100).toFixed(2)} %`;
    case 'datetime': return formatDateTime(v);
    default: return String(v);
  }
}

export default function ReportsPage() {
  const { casino, can } = useSession();
  const defs = useApi<any[]>('/reports');
  const opts = useApi<any>(`/reports/options?casinoId=${casino.id}`);
  const [key, setKey] = useState('daily-gaming');
  const [from, setFrom] = useState(iso(new Date(Date.now() - 6 * 86400000)));
  const [to, setTo] = useState(iso(new Date()));
  const [f, setF] = useState({ floorId: '', manufacturer: '', machineId: '', employeeId: '' });
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const def = defs.data?.find((d) => d.key === key);

  const query = useMemo(() => {
    const p = new URLSearchParams({ casinoId: casino.id, from, to });
    if (def?.filters.includes('machine')) {
      if (f.floorId) p.set('floorId', f.floorId);
      if (f.manufacturer) p.set('manufacturer', f.manufacturer);
      if (f.machineId) p.set('machineId', f.machineId);
    }
    if (def?.filters.includes('employee') && f.employeeId) p.set('employeeId', f.employeeId);
    return p.toString();
  }, [casino.id, from, to, f, def]);

  const run = async () => {
    setBusy('run');
    setError(null);
    try { setResult(await api(`/reports/${key}?${query}`)); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const exp = async (format: string) => {
    setBusy(format);
    setError(null);
    try { await download(`/reports/${key}?${query}&format=${format}`, `${key}.${format}`); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const groups = [...new Set((defs.data ?? []).map((d) => d.group))];

  return (
    <div className="space-y-6">
      <PageHeader title="Reports" subtitle="Run reports for any period and export them as CSV, Excel or PDF. Exports are recorded in the audit log." />
      <div className="grid gap-6 xl:grid-cols-4">
        <Card title="Report" bodyClass="p-2">
          {groups.map((g) => (
            <div key={g} className="mb-2">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-sub">{g}</div>
              {defs.data?.filter((d) => d.group === g).map((d) => (
                <button key={d.key} onClick={() => { setKey(d.key); setResult(null); }}
                  className={clsx('block w-full rounded-lg px-2.5 py-2 text-left text-sm', key === d.key ? 'bg-brand/10 font-semibold text-brand' : 'hover:bg-muted')}>
                  {d.title}
                </button>
              ))}
            </div>
          ))}
        </Card>
        <div className="space-y-6 xl:col-span-3">
          <Card title={def?.title ?? 'Report'}>
            <p className="mb-4 text-sm text-sub">{def?.description}</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="From"><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
              <Field label="To"><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
              {def?.filters.includes('machine') && (
                <>
                  <Field label="Floor">
                    <select className="input" value={f.floorId} onChange={(e) => setF({ ...f, floorId: e.target.value })}>
                      <option value="">All floors</option>
                      {opts.data?.floors.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Manufacturer">
                    <select className="input" value={f.manufacturer} onChange={(e) => setF({ ...f, manufacturer: e.target.value })}>
                      <option value="">All manufacturers</option>
                      {opts.data?.manufacturers.map((x: string) => <option key={x}>{x}</option>)}
                    </select>
                  </Field>
                  <Field label="Machine">
                    <select className="input" value={f.machineId} onChange={(e) => setF({ ...f, machineId: e.target.value })}>
                      <option value="">All machines</option>
                      {opts.data?.machines.map((x: any) => <option key={x.id} value={x.id}>{x.asset_no}</option>)}
                    </select>
                  </Field>
                </>
              )}
              {def?.filters.includes('employee') && (
                <Field label="Employee">
                  <select className="input" value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}>
                    <option value="">All employees</option>
                    {opts.data?.employees.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                </Field>
              )}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="btn-primary" onClick={run} disabled={!!busy}><Play className="h-4 w-4" /> {busy === 'run' ? 'Running...' : 'Run report'}</button>
              {can('report.export') && (
                <>
                  <button className="btn" onClick={() => exp('csv')} disabled={!!busy}><Download className="h-4 w-4" /> CSV</button>
                  <button className="btn" onClick={() => exp('xlsx')} disabled={!!busy}><FileSpreadsheet className="h-4 w-4" /> Excel</button>
                  <button className="btn" onClick={() => exp('pdf')} disabled={!!busy}><FileText className="h-4 w-4" /> PDF</button>
                </>
              )}
            </div>
          </Card>
          <ErrorNote error={error} />
          {result && (
            <Card title={`${result.title} · ${result.rows.length} rows${result.truncated ? ' (truncated)' : ''}`} bodyClass="max-h-[600px] overflow-auto">
              <table className="table">
                <thead className="sticky top-0 bg-panel">
                  <tr>{result.columns.map((c: any) => <th key={c.key} className={['money', 'number', 'percent'].includes(c.type) ? 'text-right' : ''}>{c.label}</th>)}</tr>
                </thead>
                <tbody>
                  {result.rows.map((r: any, i: number) => (
                    <tr key={i}>
                      {result.columns.map((c: any) => (
                        <td key={c.key} className={clsx(['money', 'number', 'percent'].includes(c.type) && 'text-right tabular-nums', c.type === 'text' && 'max-w-xs truncate')}>{cell(c.type, r[c.key])}</td>
                      ))}
                    </tr>
                  ))}
                  {Object.keys(result.totals).length > 0 && (
                    <tr className="font-semibold">
                      {result.columns.map((c: any, i: number) => (
                        <td key={c.key} className={clsx(['money', 'number', 'percent'].includes(c.type) && 'text-right tabular-nums')}>{i === 0 ? 'Total' : c.key in result.totals ? cell(c.type, result.totals[c.key]) : ''}</td>
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
