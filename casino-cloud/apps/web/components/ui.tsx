'use client';
import { statusColor } from '@m1/ui';
import { clsx } from './clsx';

export function StatusBadge({ status }: { status: string }) {
  const c = statusColor(status);
  return (
    <span className={clsx('badge', c.badge)}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.hex }} />
      {status}
    </span>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-sub">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className, bodyClass }: { title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={clsx('card overflow-hidden', className)}>
      {title && (
        <header className="card-h">
          <span>{title}</span>
          {actions}
        </header>
      )}
      <div className={bodyClass ?? 'p-4'}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'good' | 'bad' | 'warn' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="min-w-0 truncate text-sm text-sub" title={label}>{label}</span>
      <span className={clsx('shrink-0 font-semibold tabular-nums', tone === 'good' && 'text-emerald-600 dark:text-emerald-400', tone === 'bad' && 'text-red-600 dark:text-red-400', tone === 'warn' && 'text-amber-600 dark:text-amber-400')}>
        {value}
        {hint && <span className="ml-1 text-xs font-normal text-sub">{hint}</span>}
      </span>
    </div>
  );
}

export function Kpi({ label, value, sub, icon: Icon, accent }: { label: string; value: React.ReactNode; sub?: React.ReactNode; icon?: React.ComponentType<{ className?: string }>; accent?: string }) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-sub">{label}</span>
        {Icon && (
          <span className={clsx('rounded-lg p-1.5', accent ?? 'bg-brand/10 text-brand')}>
            <Icon className="h-4 w-4" />
          </span>
        )}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {sub && <div className="mt-1 text-xs text-sub">{sub}</div>}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-8 text-center text-sm text-sub">{children}</div>;
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</div>;
}

/** Lightweight SVG bar chart (no chart library needed for the MVP). */
export function BarChart({ data, height = 160, color = 'rgb(var(--brand))', format = (n: number) => String(n) }: {
  data: Array<{ label: string; value: number }>;
  height?: number;
  color?: string;
  format?: (n: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  const w = 100 / Math.max(1, data.length);
  return (
    <div>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
        {data.map((d, i) => {
          const h = (Math.abs(d.value) / max) * (height - 4);
          return (
            <rect key={i} x={i * w + w * 0.15} y={height - h} width={w * 0.7} height={h} rx={0.6} fill={d.value < 0 ? '#ef4444' : color} opacity={0.85}>
              <title>{`${d.label}: ${format(d.value)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-sub">
        <span>{data[0]?.label}</span>
        <span>{data[Math.floor(data.length / 2)]?.label}</span>
        <span>{data[data.length - 1]?.label}</span>
      </div>
    </div>
  );
}

const TICKET_BADGE: Record<string, string> = {
  VALID: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-emerald-500/30',
  REDEEMED: 'bg-sky-500/15 text-sky-600 dark:text-sky-400 ring-sky-500/30',
  CANCELLED: 'bg-slate-500/15 text-slate-600 dark:text-slate-400 ring-slate-500/30',
  EXPIRED: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-amber-500/30',
  VOID: 'bg-red-500/15 text-red-600 dark:text-red-400 ring-red-500/30',
};

export function TicketBadge({ status }: { status: string }) {
  return <span className={clsx('badge', TICKET_BADGE[status] ?? TICKET_BADGE.CANCELLED)}>{status}</span>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className={clsx('card max-h-[92vh] w-full overflow-y-auto rounded-b-none sm:rounded-xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')} onClick={(e) => e.stopPropagation()}>
        <div className="card-h sticky top-0 bg-panel">
          <span>{title}</span>
          <button className="btn px-2 py-1 text-xs" onClick={onClose}>Close</button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-sub">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-sub">{hint}</span>}
    </label>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'good' | 'bad'; children: React.ReactNode }) {
  const cls = tone === 'good' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : tone === 'bad' ? 'bg-red-500/10 text-red-600 dark:text-red-400' : 'bg-muted';
  return <div className={clsx('rounded-lg px-3 py-2 text-sm', cls)}>{children}</div>;
}
