'use client';
import { useState } from 'react';
import { CheckCircle2, Clock, ScanLine, ShieldCheck, XCircle } from 'lucide-react';
import { formatDateTime, timeAgo } from '@m1/ui';
import { ApiError, api, useApi } from '@/lib/api';
import { useLiveRefresh } from '@/lib/live';
import { APPROVAL_LABEL, CASH_TX_LABEL_LEDGER, classifyScan, formatCents, parseAmountCents, parseCountCents, requiresApproval } from '@/lib/money';
import { useSession } from '@/lib/session';
import { AmountField, ApprovalHint, FreezeBanner, useConfirm, useOperatorContext } from './money-ui';
import { PlayerWalletCard, walletBlockReason, type PlayerLookup } from './player-wallet';
import { ScanButton } from './cashier';
import { Card, Field, Notice, Stat, TicketBadge } from './ui';
import { clsx } from './clsx';

/**
 * Step 7e: the cage workstation of a casino whose CASH rail is on the ledger. Same screen, same jobs,
 * ledger-backed: the shift opens empty (the float is a vault fill), tickets / wallets are found by one
 * scan, every payment needs a confirmation with the exact amount, approvals are requested and shown
 * before execution, and the shift closes with a blind count. Nothing here computes a balance.
 */

type Ctx = ReturnType<typeof useOperatorContext>['data'];
type Shift = {
  session: null | { id: string; status: 'OPEN' | 'COUNTING'; desk_name: string; opened_at: string; ledger: boolean };
  movements: Array<{ id: string; kind: string; purpose: string; status: string; requested_at: string; expires_at: string; requested_by: string; requested_by_name: string; amount_cents: number | null }>;
  closeApproval: null | { id: string; status: string; created_at: string; decision_note: string | null };
  myApprovals: Array<{ id: string; action: string; entity_type: string; entity_id: string; amount_cents: number | null; status: string; created_at: string; expires_at: string; decided_by_name: string | null; decision_note: string | null; barcode: string | null; asset_no: string | null }>;
};

/** Approved (not yet used, not expired) request of the signed-in cashier for this action / entity (/ amount). */
function approvalFor(shift: Shift | null, action: string, entityId: string, amountCents?: number) {
  const list = (shift?.myApprovals ?? []).filter((a) => a.action === action && a.entity_id === entityId && (amountCents === undefined || Number(a.amount_cents) === amountCents));
  return list[0] ?? null;
}

function ApprovalState({ ap, onRequest, label }: { ap: Shift['myApprovals'][number] | null; onRequest: () => void; label: string }) {
  if (ap?.status === 'APPROVED' && new Date(ap.expires_at) > new Date())
    return <Notice tone="good"><ShieldCheck className="mr-1 inline h-4 w-4" />Approved by {ap.decided_by_name}. You can execute it now (valid until {new Date(ap.expires_at).toLocaleTimeString('de-AT')}).</Notice>;
  if (ap?.status === 'PENDING')
    return <Notice><Clock className="mr-1 inline h-4 w-4" />Waiting for a supervisor to approve (requested {timeAgo(ap.created_at)}).</Notice>;
  return (
    <div className="space-y-2">
      {ap?.status === 'REJECTED' && <Notice tone="bad">Rejected by {ap.decided_by_name}{ap.decision_note ? `: ${ap.decision_note}` : ''}.</Notice>}
      {ap?.status === 'EXPIRED' && <Notice tone="bad">The approval expired. Request a new one.</Notice>}
      <button className="btn w-full" onClick={onRequest} data-testid="request-approval"><ShieldCheck className="h-4 w-4" /> {label}</button>
    </div>
  );
}

// ---- shift ---------------------------------------------------------------------------------------

function LedgerShift({ shift, reload }: { shift: Shift | null; reload: () => void }) {
  const { casino } = useSession();
  const desks = useApi<any[]>(`/cashier/desks?casinoId=${casino.id}`);
  const [desk, setDesk] = useState('');
  const [count, setCount] = useState<Record<string, string>>({});
  const [drop, setDrop] = useState('');
  const [closeCount, setCloseCount] = useState('');
  const confirm = useConfirm(() => { reload(); void desks.reload(); });
  const s = shift?.session;

  if (!s) {
    const free = (desks.data ?? []).filter((d) => !d.session_id);
    return (
      <div className="space-y-3">
        <Notice>No open shift. The drawer starts empty: the float comes from the vault as a fill that you count and confirm.</Notice>
        <Field label="Cash desk">
          <select className="input" value={desk} onChange={(e) => setDesk(e.target.value)} data-testid="desk-select">
            <option value="">Select desk...</option>
            {free.map((d) => <option key={d.id} value={d.id}>{d.name} {d.kind === 'MOBILE' ? '(mobile)' : ''}</option>)}
          </select>
        </Field>
        <button className="btn-primary w-full" disabled={!desk} data-testid="open-shift" onClick={() => confirm.ask({
          title: 'Open shift', summary: 'Open a shift with an empty drawer. Ask the vault for your float (fill).', amountCents: 0,
          details: [['Desk', (desks.data ?? []).find((d) => d.id === desk)?.name]], path: '/cashier/session/open', body: { cashDeskId: desk, openingBalance: 0 },
        })}>Open shift</button>
        {confirm.dialog}
      </div>
    );
  }

  const fills = shift!.movements.filter((m) => m.kind === 'FILL');
  const drops = shift!.movements.filter((m) => m.kind === 'DROP');
  return (
    <div className="space-y-3">
      <Stat label="Desk" value={s.desk_name} />
      <Stat label="Opened" value={timeAgo(s.opened_at)} hint={formatDateTime(s.opened_at)} />
      <Stat label="Shift state" value={s.status === 'OPEN' ? 'Open' : 'Closing (counted)'} />
      <div className="text-xs text-sub">Blind drawer: the expected balance is shown to supervisors only.</div>

      {fills.map((m) => {
        const cents = parseCountCents(count[m.id] ?? '');
        return (
          <div key={m.id} className="space-y-2 rounded-xl border border-sky-500/40 bg-sky-500/5 p-3" data-testid="pending-fill">
            <div className="text-sm font-semibold">Fill from the vault waiting for you</div>
            <div className="text-xs text-sub">Issued by {m.requested_by_name} {timeAgo(m.requested_at)}. Count the cash and enter your total (blind).</div>
            <AmountField label="Your count" value={count[m.id] ?? ''} onChange={(v) => setCount({ ...count, [m.id]: v })} testId="fill-count" />
            <button className="btn-primary w-full" disabled={!cents} data-testid="confirm-fill" onClick={() => confirm.ask({
              title: 'Confirm fill from vault', summary: 'You confirm that you received this amount from the vault. A different count rejects the fill and nothing moves.',
              amountCents: cents!, details: [['From', `Vault (${m.requested_by_name})`], ['To', `Drawer ${s.desk_name}`]],
              path: `/cash/movements/${m.id}/confirm`, body: { totalCents: cents },
              describe: (d) => d?.movement?.status === 'REJECTED' ? 'Count did not match: fill REJECTED, nothing booked. Ask the vault to issue it again.' : d?.movement?.status === 'EXPIRED' ? 'The fill expired, nothing booked.' : 'Fill booked into your drawer.',
            })}>Confirm received</button>
          </div>
        );
      })}

      {drops.map((m) => (
        <div key={m.id} className="flex items-center justify-between gap-2 rounded-xl border border-line p-3 text-sm" data-testid="pending-drop">
          <span><Clock className="mr-1 inline h-4 w-4" />{m.purpose === 'CLOSE' ? 'Final drop' : 'Drop'} {m.amount_cents !== null ? formatCents(m.amount_cents) : ''} waiting for the vault to confirm</span>
          {m.purpose !== 'CLOSE' && (
            <button className="btn text-xs" onClick={() => confirm.ask({ title: 'Cancel drop', summary: 'Cancel your drop request. No money has moved yet.', amountCents: m.amount_cents, path: `/cash/movements/${m.id}/cancel`, body: {}, danger: true })}>Cancel</button>
          )}
        </div>
      ))}

      {s.status === 'OPEN' && (
        <div className="space-y-2 border-t border-line pt-3">
          <AmountField label="Drop to vault" value={drop} onChange={setDrop} testId="drop-amount" />
          <button className="btn w-full" disabled={!parseAmountCents(drop)} onClick={() => confirm.ask({
            title: 'Drop to vault', summary: 'Hand cash from your drawer to the vault. It moves when the vault confirms its own count.',
            amountCents: parseAmountCents(drop)!, details: [['From', `Drawer ${s.desk_name}`], ['To', 'Vault']],
            path: '/cash/movements', body: { kind: 'DROP', amountCents: parseAmountCents(drop) }, describe: () => 'Drop requested; waiting for the vault.',
          })}>Request drop</button>
        </div>
      )}

      {shift!.closeApproval?.status === 'PENDING' ? (
        <Notice><Clock className="mr-1 inline h-4 w-4" />Your close count has a short / over above the limit: waiting for a supervisor.</Notice>
      ) : drops.some((m) => m.purpose === 'CLOSE') ? null : (
        <div className="space-y-2 border-t border-line pt-3">
          {shift!.closeApproval?.status === 'REJECTED' && <Notice tone="bad">The supervisor rejected your count{shift!.closeApproval.decision_note ? `: ${shift!.closeApproval.decision_note}` : ''}. Count again.</Notice>}
          <AmountField label="Close shift: blind count of the drawer" value={closeCount} onChange={setCloseCount} allowZero testId="close-count" />
          <button className="btn w-full" disabled={parseCountCents(closeCount) === null || !!fills.length || drops.length > 0} data-testid="close-shift" onClick={() => confirm.ask({
            title: 'Close shift (blind count)', summary: 'Submit your count of the drawer. Any short / over is booked (with supervisor approval above the limit); the rest goes to the vault as the final drop.',
            amountCents: parseCountCents(closeCount)!, details: [['Desk', s.desk_name]], path: '/cashier/session/close', body: { countedBalance: parseCountCents(closeCount)! / 100 },
            describe: (d) => d.status === 'PENDING_APPROVAL' ? 'Short / over above the limit: waiting for supervisor approval.' : d.status === 'PENDING_DROP' ? 'Counted. The final drop is waiting for the vault to confirm.' : 'Shift closed.',
          })}>Submit close count</button>
          {(fills.length > 0 || drops.length > 0) && <div className="text-xs text-sub">Confirm or cancel pending fills / drops before the close count.</div>}
        </div>
      )}
      {confirm.dialog}
    </div>
  );
}

// ---- scan desk: TITO ticket or player card ---------------------------------------------------------

function TicketDesk({ ticket, ctx, shift, reload, onDone }: { ticket: any; ctx: Ctx; shift: Shift | null; reload: () => void; onDone: () => void }) {
  const [payTo, setPayTo] = useState<'CASH' | 'WALLET'>('CASH');
  const [card, setCard] = useState('');
  const confirm = useConfirm(() => { reload(); onDone(); });
  const amount = Number(ticket.amount_cents ?? Math.round(Number(ticket.amount) * 100));
  const needs = requiresApproval(amount, ctx?.limits.ticketPayout);
  const ap = approvalFor(shift, 'TITO_REDEEM_CASHIER', ticket.id);
  const approved = ap?.status === 'APPROVED' && new Date(ap.expires_at) > new Date();
  const frozen = ctx?.freezes.some((f) => f.rail === 'TITO' || f.rail === 'GLOBAL');
  return (
    <div className={clsx('space-y-3 rounded-xl border p-4', ticket.payable ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-red-500/40 bg-red-500/5')} data-testid="ticket-desk">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 font-mono text-sm">{ticket.payable ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : <XCircle className="h-5 w-5 text-red-500" />}TITO {ticket.barcode}</span>
        <TicketBadge status={ticket.status} />
      </div>
      <div className="text-4xl font-bold tabular-nums">{formatCents(amount)}</div>
      <div className="text-xs text-sub">Issued {formatDateTime(ticket.issued_at)} by {ticket.issued_machine ?? ticket.issued_employee} · expires {formatDateTime(ticket.expires_at)}</div>
      {ticket.reason && <div className="font-semibold text-red-600">{ticket.reason}</div>}
      {ticket.payable && (
        <>
          <div className="grid grid-cols-2 gap-2">
            {(['CASH', 'WALLET'] as const).map((t) => (
              <button key={t} className={clsx('btn', payTo === t && 'ring-2 ring-brand')} onClick={() => setPayTo(t)}>{t === 'CASH' ? 'Pay in CASH' : 'To CASHLESS wallet'}</button>
            ))}
          </div>
          {payTo === 'WALLET' && <Field label="Player card"><input className="input font-mono" value={card} onChange={(e) => setCard(e.target.value)} placeholder="Scan player card" /></Field>}
          <ApprovalHint amountCents={amount} limitCents={ctx?.limits.ticketPayout} />
          {needs && <ApprovalState ap={ap} label="Request supervisor approval" onRequest={() => confirm.ask({
            title: 'Request approval: TITO payout', summary: 'A supervisor must approve this payout before you can pay it.', amountCents: amount,
            details: [['Ticket', ticket.barcode]], path: `/tickets/${ticket.id}/approval-request`, body: {}, describe: () => 'Approval requested. Wait for the supervisor.',
          })} />}
          <button className="btn-primary w-full py-3 text-lg" data-testid="pay-ticket"
            disabled={!shift?.session || shift.session.status !== 'OPEN' || (needs && !approved) || (payTo === 'WALLET' && !card.trim()) || frozen}
            onClick={() => confirm.ask({
              title: 'Pay TITO ticket', summary: payTo === 'CASH' ? 'Pay this ticket in CASH from your drawer.' : 'Pay this ticket into the player\'s CASHLESS wallet.',
              amountCents: amount, details: [['Ticket', ticket.barcode], ['Pay to', payTo === 'CASH' ? 'CASH (drawer)' : `CASHLESS wallet of card ${card}`], ...(approved ? [['Approved by', ap!.decided_by_name] as [string, string]] : [])],
              path: '/tickets/redeem', body: { barcode: ticket.barcode, payTo, playerCard: payTo === 'WALLET' ? card.trim() : undefined },
              describe: () => `Ticket ${ticket.barcode} paid.`,
            })}>
            {!shift?.session ? 'Open a shift to pay' : frozen ? 'TITO frozen' : `PAY ${formatCents(amount)}`}
          </button>
        </>
      )}
      {confirm.dialog}
    </div>
  );
}

function WalletDesk({ player, ctx, shift, reload, refresh }: { player: PlayerLookup; ctx: Ctx; shift: Shift | null; reload: () => void; refresh: () => void }) {
  const [amount, setAmount] = useState('');
  const confirm = useConfirm(() => { reload(); refresh(); setAmount(''); });
  const cents = parseAmountCents(amount);
  const blocked = walletBlockReason(player);
  const frozen = ctx?.freezes.some((f) => f.rail === 'CASHLESS' || f.rail === 'CASH' || f.rail === 'GLOBAL');
  const canBook = !!shift?.session && shift.session.status === 'OPEN' && !blocked && !frozen && cents !== null;
  const action = (kind: 'CASH_DEPOSIT' | 'CASH_WITHDRAWAL') => {
    const limit = kind === 'CASH_DEPOSIT' ? ctx?.limits.deposit : ctx?.limits.withdrawal;
    const needs = cents !== null && requiresApproval(cents, limit);
    const ap = cents !== null && player.wallet ? approvalFor(shift, kind, player.wallet.id, cents) : null;
    const approved = ap?.status === 'APPROVED' && new Date(ap.expires_at) > new Date();
    const label = kind === 'CASH_DEPOSIT' ? 'Deposit' : 'Withdraw';
    const body = { playerCard: player.card.number, amount: cents! / 100 };
    return { needs, ap, approved, label, run: () => confirm.ask({
      title: kind === 'CASH_DEPOSIT' ? 'CASHLESS deposit' : 'CASHLESS withdrawal',
      summary: kind === 'CASH_DEPOSIT' ? 'Player gives CASH; the amount is credited to the CASHLESS wallet.' : 'CASH from your drawer; the amount is debited from the available wallet balance.',
      amountCents: cents!, details: [['Player', [player.player.first_name, player.player.last_name].filter(Boolean).join(' ') || player.player.player_no], ['Card', player.card.number], ...(approved ? [['Approved by', ap!.decided_by_name] as [string, string]] : [])],
      path: kind === 'CASH_DEPOSIT' ? '/cashier/wallet/deposit' : '/cashier/wallet/withdraw', body, describe: () => `${label} booked.`,
    }), request: () => confirm.ask({
      title: `Request approval: ${label.toLowerCase()}`, summary: 'A supervisor must approve this amount for this wallet before you can book it.', amountCents: cents!,
      details: [['Card', player.card.number]], path: '/cashier/wallet/approval-request', body: { ...body, kind }, describe: () => 'Approval requested. Wait for the supervisor.',
    }) };
  };
  const dep = action('CASH_DEPOSIT');
  const wd = action('CASH_WITHDRAWAL');
  return (
    <div className="space-y-3" data-testid="wallet-desk">
      <PlayerWalletCard p={player} compact />
      <AmountField label="Amount" value={amount} onChange={setAmount} testId="wallet-amount" />
      {cents !== null && (dep.needs || wd.needs) && (
        <div className="space-y-2">
          {dep.needs && <div><div className="text-xs font-semibold text-sub">Deposit</div><ApprovalHint amountCents={cents} limitCents={ctx?.limits.deposit} /><ApprovalState ap={dep.ap} label="Request approval for deposit" onRequest={dep.request} /></div>}
          {wd.needs && <div><div className="text-xs font-semibold text-sub">Withdrawal</div><ApprovalHint amountCents={cents} limitCents={ctx?.limits.withdrawal} /><ApprovalState ap={wd.ap} label="Request approval for withdrawal" onRequest={wd.request} /></div>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button className="btn-primary" disabled={!canBook || (dep.needs && !dep.approved)} onClick={dep.run} data-testid="wallet-deposit">Deposit</button>
        <button className="btn" disabled={!canBook || (wd.needs && !wd.approved)} onClick={wd.run} data-testid="wallet-withdraw">Withdraw</button>
      </div>
      {!shift?.session && <div className="text-xs text-sub">Open a shift to book CASHLESS deposits / withdrawals.</div>}
      {confirm.dialog}
    </div>
  );
}

function ScanDesk({ ctx, shift, reload }: { ctx: Ctx; shift: Shift | null; reload: () => void }) {
  const [code, setCode] = useState('');
  const [ticket, setTicket] = useState<any>(null);
  const [player, setPlayer] = useState<PlayerLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  // refresh = same ticket / card again after an action: keep it on screen while reloading
  const lookup = async (raw = code, refresh = false) => {
    const c = raw.trim();
    setError(null);
    if (!refresh) { setTicket(null); setPlayer(null); }
    if (!c) return;
    const kind = classifyScan(c);
    try {
      if (kind === 'TICKET') { setPlayer(null); setTicket(await api(`/tickets/lookup/${encodeURIComponent(c)}`)); }
      else if (kind === 'CARD') { setTicket(null); setPlayer(await api(`/players/lookup/${encodeURIComponent(c)}`)); }
      else setError('Not a TITO ticket or player card');
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? (kind === 'TICKET' ? 'Unknown TITO ticket' : 'Unknown player card') : (e as Error).message);
    }
  };
  return (
    <div className="space-y-3">
      <form onSubmit={(e) => { e.preventDefault(); void lookup(); }} className="flex gap-2">
        <input className="input font-mono" placeholder="Scan TITO ticket or player card" value={code} onChange={(e) => setCode(e.target.value)} data-testid="scan-input" />
        <button className="btn-primary" data-testid="scan-go"><ScanLine className="h-4 w-4" /> Check</button>
        <ScanButton onScan={(c) => { setCode(c); void lookup(c); }} />
      </form>
      {error && <Notice tone="bad">{error}</Notice>}
      {ticket && <TicketDesk ticket={ticket} ctx={ctx} shift={shift} reload={reload} onDone={() => void lookup(ticket.barcode, true)} />}
      {player && <WalletDesk player={player} ctx={ctx} shift={shift} reload={reload} refresh={() => void lookup(player.card.number, true)} />}
    </div>
  );
}

// ---- handpays, ticket sale, own approvals -------------------------------------------------------------

function LedgerHandpays({ ctx, shift, reload }: { ctx: Ctx; shift: Shift | null; reload: () => void }) {
  const { casino } = useSession();
  const list = useApi<any[]>(`/cashier/handpays?casinoId=${casino.id}`, { refreshMs: 4000 });
  const [card, setCard] = useState<Record<string, string>>({});
  const confirm = useConfirm(() => { reload(); void list.reload(); });
  const frozen = ctx?.freezes.some((f) => f.rail === 'HANDPAY' || f.rail === 'GLOBAL');
  if (!list.data?.length) return <div className="py-6 text-center text-sm text-sub">No pending handpays.</div>;
  return (
    <div className="space-y-2">
      {list.data.map((h) => {
        const amount = Number(h.amount_cents);
        const needs = requiresApproval(amount, ctx?.limits.handpay);
        const ap = approvalFor(shift, 'HANDPAY_PAY', h.handpay_id);
        const approved = h.handpay_status === 'APPROVED' || (ap?.status === 'APPROVED' && new Date(ap.expires_at) > new Date());
        const pay = (payTo: 'CASH' | 'WALLET') => confirm.ask({
          title: 'Pay HANDPAY', summary: payTo === 'CASH' ? 'Pay this jackpot in CASH from your drawer. The machine reset is requested separately.' : 'Pay this jackpot into the player\'s CASHLESS wallet.',
          amountCents: amount, details: [['Machine', `${h.asset_no} (${h.manufacturer ?? ''} ${h.floor ?? ''})`], ['Hit', formatDateTime(h.hit_at)], ['Pay to', payTo === 'CASH' ? 'CASH (drawer)' : `CASHLESS wallet of card ${card[h.handpay_id]}`]],
          path: `/cashier/handpays/${h.id}`, body: { jackpotEventId: h.jackpot_event_id, payTo, playerCard: payTo === 'WALLET' ? card[h.handpay_id]?.trim() : undefined },
          describe: (d) => `HANDPAY ${formatCents(d.amountCents)} on ${d.assetNo} paid (${d.status}).`,
        });
        return (
          <div key={h.handpay_id} className="space-y-2 rounded-xl border border-yellow-500/40 bg-yellow-500/5 p-3" data-testid="handpay">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-bold">{h.asset_no} <span className="text-xs font-normal text-sub">{h.manufacturer} · {h.floor} {h.position_label}</span></div>
                <div className="text-xl font-bold tabular-nums text-yellow-600 dark:text-yellow-400">{formatCents(amount)}</div>
                <div className="text-xs text-sub">hit {timeAgo(h.hit_at)} · {h.handpay_status}</div>
              </div>
            </div>
            {needs && h.handpay_status !== 'APPROVED' && <ApprovalState ap={ap} label="Request supervisor approval" onRequest={() => confirm.ask({
              title: 'Request approval: HANDPAY', summary: 'A supervisor must approve this handpay before it can be paid.', amountCents: amount,
              details: [['Machine', h.asset_no]], path: `/handpays/${h.handpay_id}/approval-request`, body: {}, describe: () => 'Approval requested.',
            })} />}
            <input className="input font-mono text-xs" placeholder="Player card (only for wallet payment)" value={card[h.handpay_id] ?? ''} onChange={(e) => setCard({ ...card, [h.handpay_id]: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <button className="btn-primary" disabled={!shift?.session || shift.session.status !== 'OPEN' || (needs && !approved) || frozen} onClick={() => pay('CASH')} data-testid="pay-handpay">PAY CASH</button>
              <button className="btn" disabled={!shift?.session || shift.session.status !== 'OPEN' || (needs && !approved) || frozen || !card[h.handpay_id]?.trim()} onClick={() => pay('WALLET')}>To wallet</button>
            </div>
          </div>
        );
      })}
      {confirm.dialog}
    </div>
  );
}

function SellTicket({ ctx, shift, reload }: { ctx: Ctx; shift: Shift | null; reload: () => void }) {
  const [amount, setAmount] = useState('');
  const confirm = useConfirm(() => { reload(); setAmount(''); });
  const cents = parseAmountCents(amount);
  const frozen = ctx?.freezes.some((f) => f.rail === 'TITO' || f.rail === 'GLOBAL');
  return (
    <div className="space-y-2">
      <AmountField label="Sell TITO ticket for CASH" value={amount} onChange={setAmount} testId="sell-amount" />
      <button className="btn w-full" disabled={!cents || !shift?.session || shift.session.status !== 'OPEN' || frozen} onClick={() => confirm.ask({
        title: 'Sell TITO ticket', summary: 'The player pays CASH; a TITO ticket is printed.', amountCents: cents!, path: '/tickets/issue', body: { amount: cents! / 100, payFrom: 'CASH' },
        describe: (d) => <>Ticket <span className="font-mono">{d.barcode}</span> printed.</>,
      })} data-testid="sell-ticket">Sell ticket</button>
      {confirm.dialog}
    </div>
  );
}

function MyApprovals({ shift }: { shift: Shift | null }) {
  const list = shift?.myApprovals ?? [];
  if (!list.length) return <div className="py-4 text-center text-sm text-sub">No approval requests in this shift.</div>;
  return (
    <div>
      {list.map((a) => (
        <div key={a.id} className="flex items-center gap-2 border-b border-line/60 py-2 text-sm last:border-0" data-testid="my-approval">
          <span className="flex-1">{APPROVAL_LABEL[a.action] ?? a.action}<span className="ml-1 text-xs text-sub">{a.barcode ?? a.asset_no ?? ''}</span></span>
          <span className="tabular-nums">{a.amount_cents !== null ? formatCents(Number(a.amount_cents)) : ''}</span>
          <span className={clsx('badge', a.status === 'APPROVED' || a.status === 'EXECUTED' ? 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/30' : a.status === 'PENDING' ? 'bg-amber-500/15 text-amber-700 ring-amber-500/30' : 'bg-red-500/15 text-red-600 ring-red-500/30')}>{a.status}</span>
        </div>
      ))}
    </div>
  );
}

function BlindTransactions() {
  const s = useApi<any>('/cashier/session', { refreshMs: 5000 });
  const items: any[] = s.data?.transactions ?? [];
  if (!items.length) return <div className="py-6 text-center text-sm text-sub">No transactions in this shift yet.</div>;
  return (
    <div>
      {items.map((t) => (
        <div key={t.id} className="flex items-center gap-2 border-b border-line/60 py-2 text-sm last:border-0">
          <span className="w-20 shrink-0 text-xs text-sub">{new Date(t.created_at).toLocaleTimeString('de-AT')}</span>
          <span className="flex-1 truncate">{CASH_TX_LABEL_LEDGER[t.type] ?? t.type}<span className="ml-1 text-xs text-sub">{t.barcode ?? t.asset_no ?? t.reference ?? ''}</span></span>
          {t.amount !== undefined && <span className="tabular-nums">{formatCents(Math.round(Number(t.amount) * 100))}</span>}
        </div>
      ))}
    </div>
  );
}

export function LedgerWorkstation() {
  const ctx = useOperatorContext();
  const shift = useApi<Shift>('/cashier/shift', { refreshMs: 5000 });
  useLiveRefresh(() => void shift.reload(), 1500, ['alert.created', 'alert.updated']);
  const reload = () => void shift.reload();
  return (
    <div className="space-y-4">
      <FreezeBanner freezes={ctx.data?.freezes} rails={['CASH', 'TITO', 'HANDPAY', 'CASHLESS']} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6">
          <Card title="My shift"><LedgerShift shift={shift.data} reload={reload} /></Card>
          <Card title="Shift transactions" bodyClass="max-h-96 overflow-y-auto px-4 py-2"><BlindTransactions /></Card>
        </div>
        <div className="space-y-6">
          <Card title="Scan: TITO ticket or player card"><ScanDesk ctx={ctx.data} shift={shift.data} reload={reload} /></Card>
          <Card title="My approval requests"><MyApprovals shift={shift.data} /></Card>
        </div>
        <div className="space-y-6">
          <Card title="HANDPAY (jackpots)"><LedgerHandpays ctx={ctx.data} shift={shift.data} reload={reload} /></Card>
          <Card title="TITO sale"><SellTicket ctx={ctx.data} shift={shift.data} reload={reload} /></Card>
        </div>
      </div>
    </div>
  );
}

/** One part of the ledger workstation, self-contained (mobile cashier tabs on a ledger casino). */
export function LedgerPanel({ part }: { part: 'shift' | 'scan' | 'handpay' | 'sell' }) {
  const ctx = useOperatorContext();
  const shift = useApi<Shift>('/cashier/shift', { refreshMs: 5000 });
  const reload = () => void shift.reload();
  return (
    <div className="space-y-3">
      <FreezeBanner freezes={ctx.data?.freezes} rails={['CASH', 'TITO', 'HANDPAY', 'CASHLESS']} />
      {part === 'shift' && <LedgerShift shift={shift.data} reload={reload} />}
      {part === 'scan' && <ScanDesk ctx={ctx.data} shift={shift.data} reload={reload} />}
      {part === 'handpay' && <LedgerHandpays ctx={ctx.data} shift={shift.data} reload={reload} />}
      {part === 'sell' && (
        <>
          <SellTicket ctx={ctx.data} shift={shift.data} reload={reload} />
          <div className="text-xs text-sub">On the ledger there is no generic cash in / out: use TITO, CASHLESS deposit / withdrawal or the vault.</div>
        </>
      )}
    </div>
  );
}
