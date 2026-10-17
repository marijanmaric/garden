'use client';
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Lock, ShieldCheck, XCircle } from 'lucide-react';
import { moneyAction, useApi } from '@/lib/api';
import { intentKey, settleIntent } from '@/lib/intent';
import { formatCents, parseAmountCents, parseCountCents } from '@/lib/money';
import { useSession } from '@/lib/session';
import { Field, Modal } from './ui';
import { clsx } from './clsx';

/**
 * Step 7e: the one way an operator screen moves money.
 *
 * Every money-moving or destructive action opens a confirmation that names the exact amount and the
 * affected entity, surfaces an approval requirement before anything runs, and executes once with an
 * Idempotency-Key bound to the operator's intent (path + request). The same intent re-submitted after
 * an unclear outcome (network error, closed dialog) reuses its key, so the API replays the stored result
 * instead of booking twice; the key is released only after a success. The result is always shown
 * explicitly: done (or already done), or the API's refusal.
 */

export { intentKey };

export interface ActionRequest {
  title: string;
  /** Business wording of what happens, e.g. "Pay TITO ticket 1234… in CASH". */
  summary: React.ReactNode;
  amountCents?: number | null;
  /** Affected entity lines (player, machine, ticket, handpay, shift ...). */
  details?: Array<[string, React.ReactNode]>;
  /** Shown prominently before the confirmation (e.g. a second person must approve first). */
  warning?: React.ReactNode;
  path: string;
  body: unknown;
  danger?: boolean;
  confirmLabel?: string;
  /** Formats the API response for the success message. */
  describe?: (data: any) => React.ReactNode;
}

type Outcome = { ok: true; data: any; replayed: boolean } | { ok: false; status: number; error: string; data: any };

export function ConfirmAction({ req, onClose, onDone }: { req: ActionRequest; onClose: () => void; onDone?: (data: any) => void }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    const r = await moneyAction(req.path, req.body, intentKey(req.path, req.body));
    if (r.ok) settleIntent(req.path, req.body);
    setOutcome(r);
    setBusy(false);
  };
  // The screen refreshes when the operator closes the result, so the result stays visible until then.
  const close = () => {
    if (busy) return;
    onClose();
    if (outcome?.ok) onDone?.(outcome.data);
  };
  return (
    <Modal title={req.title} onClose={close}>
      <div className="space-y-3" data-testid="confirm-action">
        <div className="text-sm">{req.summary}</div>
        {req.amountCents !== undefined && req.amountCents !== null && (
          <div className="rounded-lg bg-muted px-3 py-2 text-center">
            <div className="text-xs uppercase tracking-wide text-sub">Amount</div>
            <div className="text-3xl font-bold tabular-nums" data-testid="confirm-amount">{formatCents(req.amountCents)}</div>
          </div>
        )}
        {req.details && req.details.length > 0 && (
          <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
            {req.details.map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-sub">{k}</dt><dd className="font-medium">{v}</dd></div>
            ))}
          </dl>
        )}
        {req.warning && !outcome && (
          <div className="flex gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"><AlertTriangle className="h-4 w-4 shrink-0" />{req.warning}</div>
        )}
        {outcome?.ok && (
          <div className="flex gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400" data-testid="action-success">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <div>
              <div className="font-semibold">{outcome.replayed ? 'Already done: this exact request was executed before (nothing booked twice).' : 'Done.'}</div>
              {req.describe?.(outcome.data)}
            </div>
          </div>
        )}
        {outcome && !outcome.ok && (
          <div className="flex gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400" data-testid="action-error">
            <XCircle className="h-4 w-4 shrink-0" />
            <div><div className="font-semibold">Not executed{outcome.status ? ` (${outcome.status})` : ''}</div>{outcome.error}</div>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          {outcome?.ok ? (
            <button className="btn-primary" onClick={close}>Close</button>
          ) : (
            <>
              <button className="btn" disabled={busy} onClick={close}>Cancel</button>
              <button className={clsx(req.danger ? 'btn-danger' : 'btn-primary')} disabled={busy} onClick={run} data-testid="confirm-button">
                {busy ? 'Working…' : outcome ? 'Try again (same request)' : req.confirmLabel ?? 'Confirm'}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Holds the action being confirmed; render <Action.Dialog/> once per screen. */
export function useConfirm(onDone?: (data: any) => void) {
  const [req, setReq] = useState<ActionRequest | null>(null);
  return {
    ask: setReq,
    dialog: req ? <ConfirmAction req={req} onClose={() => setReq(null)} onDone={onDone} /> : null,
  };
}

/** Amount input in euros; shows the parsed exact amount so the operator sees what will be sent. */
export function AmountField({ label, value, onChange, allowZero, hint, testId }: { label: string; value: string; onChange: (v: string) => void; allowZero?: boolean; hint?: string; testId?: string }) {
  const cents = allowZero ? parseCountCents(value) : parseAmountCents(value);
  return (
    <Field label={label} hint={hint}>
      <input className="input tabular-nums" inputMode="decimal" placeholder="0,00" value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} />
      {value.trim() !== '' && (
        <span className={clsx('mt-1 block text-xs', cents === null ? 'text-red-600' : 'text-sub')}>{cents === null ? 'Not a valid amount' : `= ${formatCents(cents)}`}</span>
      )}
    </Field>
  );
}

/** Rail modes, freezes and approval limits of the current casino (from the API). */
export function useOperatorContext() {
  const { casino } = useSession();
  return useApi<{
    casinoId: string; today: string;
    rails: Record<'VAULT' | 'CASH' | 'HANDPAY' | 'TITO' | 'CASHLESS', 'LEDGER' | 'LEGACY'>;
    ledgerMachines: string[];
    freezes: Array<{ id: string; rail: string; machine_id: string | null; asset_no: string | null; reason: string; frozen_at: string }>;
    limits: { handpay: number | null; deposit: number | null; withdrawal: number | null; ticketPayout: number | null; shortOver: number | null };
  }>(`/operator/context?casinoId=${casino.id}`, { refreshMs: 15000 });
}

export function RailBadge({ mode }: { mode: 'LEDGER' | 'LEGACY' | string }) {
  return (
    <span className={clsx('badge', mode === 'LEDGER' ? 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 dark:text-emerald-400' : 'bg-slate-500/15 text-slate-600 ring-slate-500/30 dark:text-slate-400')}>
      {mode === 'LEDGER' ? <ShieldCheck className="mr-1 h-3 w-3" /> : null}{mode}
    </span>
  );
}

/** Freezes affecting a screen: shown before any action so an operator never runs into a hidden guard. */
export function FreezeBanner({ freezes, rails }: { freezes: Array<{ rail: string; asset_no: string | null; reason: string }> | undefined; rails?: string[] }) {
  const list = (freezes ?? []).filter((f) => !rails || rails.includes(f.rail) || f.rail === 'GLOBAL');
  if (!list.length) return null;
  return (
    <div className="mb-4 space-y-1 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400" data-testid="freeze-banner">
      {list.map((f, i) => (
        <div key={i} className="flex gap-2"><Lock className="mt-0.5 h-4 w-4 shrink-0" /><span><b>{f.rail === 'GLOBAL' ? 'ALL MONEY' : f.rail}{f.asset_no ? ` · machine ${f.asset_no}` : ''} frozen</b> by reconciliation. Only corrections are possible until a supervisor lifts it. <span className="opacity-75">({f.reason})</span></span></div>
      ))}
    </div>
  );
}

export function ApprovalHint({ amountCents, limitCents }: { amountCents: number | null; limitCents: number | null | undefined }) {
  if (amountCents === null || limitCents === null || limitCents === undefined || amountCents < limitCents) return null;
  return (
    <div className="flex gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400" data-testid="approval-hint">
      <ShieldCheck className="h-4 w-4 shrink-0" />
      <span>Four eyes: from {formatCents(limitCents)} a second person must approve before this can be executed.</span>
    </div>
  );
}
