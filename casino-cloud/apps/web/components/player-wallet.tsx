'use client';
import { formatDateTime, timeAgo } from '@m1/ui';
import { Ban, CreditCard, Wallet } from 'lucide-react';
import { MONEY_TX_LABEL, formatCents } from '@/lib/money';
import { Stat } from './ui';
import { clsx } from './clsx';

/** Response of GET /players/lookup/:card (balances are the ledger's, never computed here). */
export interface PlayerLookup {
  card: { id: string; number: string; type: string; status: string; expiresAt: string | null };
  usable: boolean;
  rejection: string | null;
  player: { id: string; player_no: string; status: string; verification_status: string; tier: string; first_name: string | null; last_name: string | null; current_machine: string | null };
  wallet: null | {
    id: string; status: string; statusReason: string | null;
    availableCents: number; reservedCents: number; pendingInCents: number;
    cashlessSession: { id: string; opened_at: string; asset_no: string } | null;
    activeTransfers: Array<{ id: string; direction: string; status: string; amount_cents: number; requested_at: string; asset_no: string }>;
    history: Array<{ id: string; type: string; amount_cents: number; business_date: string; created_at: string; asset_no: string | null; barcode: string | null; available_delta_cents: number | null; reserved_delta_cents: number | null }>;
  };
}

/** Why a CASHLESS operation is not possible for this player (shown before any action). */
export function walletBlockReason(p: PlayerLookup): string | null {
  if (!p.usable) return p.rejection ?? 'Card not usable';
  if (p.player.status !== 'ACTIVE') return `Player is ${p.player.status}`;
  if (!p.wallet) return 'Player has no CASHLESS wallet';
  if (p.wallet.status !== 'ACTIVE') return `CASHLESS wallet is ${p.wallet.status}${p.wallet.statusReason ? ` (${p.wallet.statusReason})` : ''}`;
  return null;
}

export function PlayerWalletCard({ p, compact }: { p: PlayerLookup; compact?: boolean }) {
  const blocked = walletBlockReason(p);
  const w = p.wallet;
  return (
    <div className="space-y-3" data-testid="player-wallet">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-lg font-semibold">{[p.player.first_name, p.player.last_name].filter(Boolean).join(' ') || p.player.player_no}</div>
          <div className="text-xs text-sub">
            <CreditCard className="mr-1 inline h-3 w-3" />{p.card.number} · {p.player.player_no} · {p.player.tier} · {p.player.verification_status}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={clsx('badge', p.card.status === 'ACTIVE' ? 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/30' : 'bg-red-500/15 text-red-600 ring-red-500/30')}>CARD {p.card.status}</span>
          <span className={clsx('badge', p.player.status === 'ACTIVE' ? 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/30' : 'bg-red-500/15 text-red-600 ring-red-500/30')}>PLAYER {p.player.status}</span>
        </div>
      </div>
      {blocked && <div className="flex gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400" data-testid="wallet-blocked"><Ban className="h-4 w-4 shrink-0" />{blocked}</div>}
      {w && (
        <div className="rounded-xl border border-line p-3">
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-sub"><Wallet className="h-3.5 w-3.5" /> CASHLESS wallet · {w.status}</div>
          <div className="text-3xl font-bold tabular-nums" data-testid="wallet-available">{formatCents(w.availableCents)}</div>
          <div className="text-xs text-sub">available (from the ledger)</div>
          <div className="mt-2">
            <Stat label="Reserved for a machine transfer" value={formatCents(w.reservedCents)} />
            <Stat label="Coming back from a machine" value={formatCents(w.pendingInCents)} />
            <Stat label="CASHLESS session" value={w.cashlessSession ? `playing on ${w.cashlessSession.asset_no}` : 'none'} hint={w.cashlessSession ? timeAgo(w.cashlessSession.opened_at) : undefined} />
          </div>
          {w.activeTransfers.length > 0 && (
            <div className="mt-2 text-xs text-sub">
              {w.activeTransfers.map((t) => <div key={t.id}>{t.direction === 'TO_MACHINE' ? 'To' : 'From'} {t.asset_no}: {formatCents(t.amount_cents)} ({t.status})</div>)}
            </div>
          )}
        </div>
      )}
      {w && !compact && (
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-sub">Wallet history</div>
          {!w.history.length && <div className="text-sm text-sub">No wallet movements yet.</div>}
          {w.history.map((h) => {
            const delta = h.available_delta_cents ?? 0;
            return (
              <div key={h.id} className="flex items-center gap-2 border-b border-line/60 py-1.5 text-sm last:border-0">
                <span className="w-32 shrink-0 text-xs text-sub">{formatDateTime(h.created_at)}</span>
                <span className="flex-1 truncate">{MONEY_TX_LABEL[h.type] ?? h.type}<span className="ml-1 text-xs text-sub">{h.asset_no ?? h.barcode ?? ''}</span></span>
                <span className={clsx('shrink-0 font-semibold tabular-nums', delta < 0 ? 'text-red-600 dark:text-red-400' : delta > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-sub')}>
                  {delta === 0 ? formatCents(h.amount_cents) : `${delta > 0 ? '+' : ''}${formatCents(delta)}`}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
