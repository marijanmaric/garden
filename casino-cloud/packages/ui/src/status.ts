import type { MachineStatus } from '@m1/shared';

/** Single source for status colours across dashboard, floor map and lists. */
export const STATUS_COLORS: Record<MachineStatus, { hex: string; badge: string; label: string }> = {
  ONLINE: { hex: '#10b981', badge: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-emerald-500/30', label: 'Online' },
  OFFLINE: { hex: '#ef4444', badge: 'bg-red-500/15 text-red-600 dark:text-red-400 ring-red-500/30', label: 'Offline' },
  WARNING: { hex: '#f59e0b', badge: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-amber-500/30', label: 'Warning' },
  ERROR: { hex: '#dc2626', badge: 'bg-rose-600/15 text-rose-600 dark:text-rose-400 ring-rose-600/30', label: 'Error' },
  MAINTENANCE: { hex: '#6366f1', badge: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 ring-indigo-500/30', label: 'Maintenance' },
  DISABLED: { hex: '#64748b', badge: 'bg-slate-500/15 text-slate-600 dark:text-slate-400 ring-slate-500/30', label: 'Disabled' },
  JACKPOT: { hex: '#eab308', badge: 'bg-yellow-400/20 text-yellow-700 dark:text-yellow-300 ring-yellow-500/40', label: 'Jackpot' },
};

export function statusColor(status: string) {
  return STATUS_COLORS[status as MachineStatus] ?? STATUS_COLORS.OFFLINE;
}

export const SEVERITY_BADGE: Record<string, string> = {
  CRITICAL: 'bg-red-500/15 text-red-600 dark:text-red-400 ring-red-500/30',
  WARNING: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-amber-500/30',
  INFO: 'bg-sky-500/15 text-sky-600 dark:text-sky-400 ring-sky-500/30',
};

/** Event types shown with a monetary amount in live feeds. */
export const MONEY_EVENTS = new Set(['GAME_PLAYED', 'COIN_IN', 'COIN_OUT', 'TICKET_IN', 'TICKET_OUT', 'JACKPOT']);
