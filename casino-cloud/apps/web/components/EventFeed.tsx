'use client';
import Link from 'next/link';
import { MONEY_EVENTS, formatEuro, formatTime } from '@m1/ui';
import { useLive } from '@/lib/live';
import { clsx } from './clsx';

const TONE: Record<string, string> = {
  JACKPOT: 'text-yellow-600 dark:text-yellow-400',
  MACHINE_OFFLINE: 'text-red-600 dark:text-red-400',
  MACHINE_ERROR: 'text-red-600 dark:text-red-400',
  MACHINE_ONLINE: 'text-emerald-600 dark:text-emerald-400',
  MACHINE_DOOR_OPEN: 'text-amber-600 dark:text-amber-400',
  CASHBOX_OPEN: 'text-amber-600 dark:text-amber-400',
  PRINTER_ERROR: 'text-amber-600 dark:text-amber-400',
};

export function EventFeed({ limit = 30, machineId, className }: { limit?: number; machineId?: string; className?: string }) {
  const { events, connected } = useLive();
  const list = (machineId ? events.filter((e) => e.machineId === machineId) : events).slice(0, limit);
  return (
    <div className={clsx('font-mono text-xs', className)}>
      {!list.length && <div className="py-6 text-center font-sans text-sm text-sub">{connected ? 'Waiting for live events...' : 'Connecting to live stream...'}</div>}
      {list.map((e) => (
        <div key={e.eventId} className="flex items-center gap-3 border-b border-line/50 px-4 py-1.5 last:border-0">
          <span className="shrink-0 text-sub">{formatTime(e.timestamp)}</span>
          <span className="w-10 shrink-0 font-semibold">{e.assetNo}</span>
          <span className={clsx('flex-1 truncate', TONE[e.type])}>
            {e.type}
            {e.errorCode ? ` ${e.errorCode}` : ''}
            {e.playerCardId && (e.type === 'PLAYER_LOGIN' || e.type === 'PLAYER_LOGOUT') ? ` ${e.playerCardId}` : ''}
          </span>
          {MONEY_EVENTS.has(e.type) && <span className="shrink-0 whitespace-nowrap tabular-nums">{formatEuro(e.amount ?? 0)}</span>}
          {e.type === 'GAME_PLAYED' && (e.win ?? 0) > 0 && <span className="shrink-0 whitespace-nowrap tabular-nums text-emerald-600 dark:text-emerald-400">+{formatEuro(e.win)}</span>}
        </div>
      ))}
    </div>
  );
}

export function LiveDot() {
  const { connected } = useLive();
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-sub">
      <span className={clsx('relative flex h-2 w-2')}>
        {connected && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />}
        <span className={clsx('relative inline-flex h-2 w-2 rounded-full', connected ? 'bg-emerald-500' : 'bg-red-500')} />
      </span>
      {connected ? 'LIVE' : 'OFFLINE'}
    </span>
  );
}

export { Link };
