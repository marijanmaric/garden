'use client';
import { Fragment, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Lock, PauseCircle, Snowflake } from 'lucide-react';
import { formatDateTime } from '@m1/ui';
import { Field, Modal } from './ui';
import { clsx } from './clsx';

/** A module card as GET /org and GET /platform/organizations/:id return it. */
export interface ModuleCardData {
  module: string; name: string; description: string; capabilities: string[];
  requires: string[]; requiresWhy: string | null; dependents: string[];
  purchased: boolean; source: string; enabled: boolean; missing: string[]; effective: boolean;
  state: 'ENABLED' | 'DISABLED' | 'NOT_PURCHASED' | 'DEPENDENCY_MISSING' | 'SUBSCRIPTION_INACTIVE' | 'TEMPORARILY_FROZEN';
  operational: 'OPERATIONAL' | 'LEGACY' | 'FROZEN' | 'NOT_AVAILABLE';
  rails: Array<{ rail: string; onLedger: number; of: number; mode: string; frozen: number }>;
  reason: string;
  canEnable: boolean; enableBlockers: string[]; canDisable: boolean; disableBlockers: string[];
  limits: UsageRow[];
}

export interface UsageRow { key: string; label: string; kind: 'HARD' | 'SOFT'; value: number | null; source: string; used: number; available: number | null; exceeded: boolean }

const STATE: Record<ModuleCardData['state'], { label: string; tone: string; icon: React.ComponentType<{ className?: string }> }> = {
  ENABLED: { label: 'Enabled', tone: 'bg-emerald-500/15 text-emerald-600 ring-emerald-500/30 dark:text-emerald-400', icon: CheckCircle2 },
  DISABLED: { label: 'Disabled', tone: 'bg-slate-500/15 text-slate-600 ring-slate-500/30 dark:text-slate-300', icon: CircleSlash },
  NOT_PURCHASED: { label: 'Not purchased', tone: 'bg-slate-500/10 text-sub ring-slate-500/20', icon: Lock },
  DEPENDENCY_MISSING: { label: 'Dependency missing', tone: 'bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-400', icon: AlertTriangle },
  SUBSCRIPTION_INACTIVE: { label: 'Subscription inactive', tone: 'bg-red-500/15 text-red-600 ring-red-500/30', icon: PauseCircle },
  TEMPORARILY_FROZEN: { label: 'Temporarily frozen', tone: 'bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300', icon: Snowflake },
};

export function ModuleStateBadge({ state }: { state: ModuleCardData['state'] }) {
  const s = STATE[state];
  return <span className={clsx('badge', s.tone)} data-testid={`state-${state}`}><s.icon className="h-3 w-3" />{s.label}</span>;
}

const LICENSE_TONE: Record<string, string> = {
  VALID: 'bg-emerald-500/15 text-emerald-600 ring-emerald-500/30', TRIAL: 'bg-sky-500/15 text-sky-600 ring-sky-500/30',
  EXPIRED: 'bg-red-500/15 text-red-600 ring-red-500/30', SUSPENDED: 'bg-amber-500/15 text-amber-700 ring-amber-500/30',
  CANCELLED: 'bg-slate-500/15 text-slate-600 ring-slate-500/30', ORG_DISABLED: 'bg-red-500/15 text-red-600 ring-red-500/30',
  NO_SUBSCRIPTION: 'bg-slate-500/15 text-slate-600 ring-slate-500/30', ACTIVE: 'bg-emerald-500/15 text-emerald-600 ring-emerald-500/30',
  DISABLED: 'bg-red-500/15 text-red-600 ring-red-500/30', INACTIVE: 'bg-slate-500/15 text-slate-600 ring-slate-500/30',
};
export function LicenseBadge({ status }: { status: string }) {
  return <span className={clsx('badge', LICENSE_TONE[status] ?? LICENSE_TONE.NO_SUBSCRIPTION)}>{status.replace(/_/g, ' ')}</span>;
}

export function UsageBar({ row }: { row: UsageRow }) {
  const pct = row.value === null ? 0 : row.value === 0 ? 100 : Math.min(100, (row.used / row.value) * 100);
  return (
    <div className="py-1.5" data-testid={`limit-${row.key}`}>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-sub">{row.label} <span className="text-[10px] uppercase">{row.kind}</span></span>
        <span className={clsx('tabular-nums font-medium', row.exceeded && 'text-red-600')}>{row.used} / {row.value ?? 'unlimited'}</span>
      </div>
      {row.value !== null && (
        <div className="mt-1 h-1.5 rounded-full bg-muted">
          <div className={clsx('h-1.5 rounded-full', row.exceeded ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-brand')} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * One module: commercial state (purchased / enabled / dependencies) next to the operational rail state, the
 * reason in words, limits with usage, and the actions the caller may take.
 */
export function ModuleCard({ m, actions }: { m: ModuleCardData; actions?: React.ReactNode }) {
  return (
    <div className="card flex flex-col p-4" data-testid={`module-${m.module}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold">{m.name}</div>
          <div className="text-xs text-sub">{m.description}</div>
        </div>
        <ModuleStateBadge state={m.state} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-sub">Purchased</dt><dd>{m.purchased ? `yes (${m.source.toLowerCase()})` : 'no'}</dd>
        <dt className="text-sub">Enabled</dt><dd>{m.enabled ? 'yes' : 'no'}</dd>
        <dt className="text-sub">Operational</dt><dd>{m.operational.replace(/_/g, ' ').toLowerCase()}</dd>
        {m.requires.length > 0 && (<><dt className="text-sub">Requires</dt><dd>{m.requires.join(', ')}</dd></>)}
        {m.rails.map((r) => (
          <Fragment key={r.rail}><dt className="text-sub">Rail {r.rail}</dt><dd>{r.mode.toLowerCase()} ({r.onLedger}/{r.of}){r.frozen ? `, ${r.frozen} frozen` : ''}</dd></Fragment>
        ))}
      </dl>
      <p className="mt-3 text-sm" data-testid="module-reason">{m.reason}</p>
      {m.requiresWhy && m.state === 'DEPENDENCY_MISSING' && <p className="mt-1 text-xs text-sub">{m.requiresWhy}</p>}
      {m.limits.length > 0 && <div className="mt-2 border-t border-line pt-2">{m.limits.map((l) => <UsageBar key={l.key} row={l} />)}</div>}
      {!m.canDisable && m.disableBlockers.length > 0 && m.enabled && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">Cannot be switched off: {m.disableBlockers.join(' ')}</p>
      )}
      {!m.canEnable && m.enableBlockers.length > 0 && !m.enabled && m.purchased && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">Cannot be switched on yet: {m.enableBlockers.join(' ')}</p>
      )}
      {actions && <div className="mt-auto flex flex-wrap gap-2 pt-3">{actions}</div>}
    </div>
  );
}

/** Confirmation with a mandatory reason (every administrative change is audited with it). */
export function ReasonDialog({ title, description, confirm, onConfirm, onClose, minLength = 3 }: {
  title: string; description?: React.ReactNode; confirm: string; minLength?: number;
  onConfirm: (reason: string) => Promise<void>; onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={title} onClose={onClose}>
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try { await onConfirm(reason.trim()); onClose(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
      }}>
        {description && <div className="text-sm">{description}</div>}
        <Field label="Reason (audited)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus name="reason" /></Field>
        {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600" data-testid="dialog-error">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || reason.trim().length < minLength}>{confirm}</button>
        </div>
      </form>
    </Modal>
  );
}

export function AuditList({ entries }: { entries: Array<{ id: string | number; action: string; actor_name: string | null; details: any; created_at: string; target_org?: string | null }> }) {
  if (!entries.length) return <div className="py-6 text-center text-sm text-sub">No entries.</div>;
  return (
    <table className="table">
      <thead><tr><th>Time</th><th>Action</th><th>By</th><th>Old</th><th>New</th><th>Reason</th></tr></thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id}>
            <td className="whitespace-nowrap text-xs">{formatDateTime(e.created_at)}</td>
            <td className="font-mono text-xs">{e.action}{e.target_org && <div className="font-sans text-sub">{e.target_org}</div>}</td>
            <td className="text-xs">{e.actor_name}</td>
            <td className="max-w-[16rem] truncate font-mono text-[11px]" title={JSON.stringify(e.details?.old)}>{e.details?.old === undefined ? '' : JSON.stringify(e.details.old)}</td>
            <td className="max-w-[16rem] truncate font-mono text-[11px]" title={JSON.stringify(e.details?.new)}>{e.details?.new === undefined ? '' : JSON.stringify(e.details.new)}</td>
            <td className="text-xs">{e.details?.reason ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
