'use client';
import { useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, Delete, XCircle } from 'lucide-react';
import { formatDateTime, formatEuro, timeAgo } from '@m1/ui';
import { api, useApi } from '@/lib/api';
import { CASH_TX_LABEL, type Cashier } from '@/lib/cashier';
import { useSession } from '@/lib/session';
import { Field, Modal, Notice, Stat, TicketBadge } from './ui';
import { clsx } from './clsx';

type Msg = { tone: 'good' | 'bad'; text: string } | null;

/** Big-button numeric keypad for touch screens. Value is a decimal string. */
export function Keypad({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const press = (k: string) => {
    if (k === 'del') return onChange(value.slice(0, -1));
    if (k === '.' && value.includes('.')) return;
    if (value.includes('.') && value.split('.')[1].length >= 2) return;
    onChange((value === '0' && k !== '.' ? '' : value) + k);
  };
  return (
    <div className="grid grid-cols-3 gap-2">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'].map((k) => (
        <button key={k} type="button" onClick={() => press(k)} className="rounded-xl bg-muted py-4 text-2xl font-semibold active:scale-95 active:bg-line">
          {k === 'del' ? <Delete className="mx-auto h-6 w-6" /> : k}
        </button>
      ))}
    </div>
  );
}

/** Camera barcode scanning via the browser's BarcodeDetector (Chrome / Android). Hidden where unsupported. */
export function ScanButton({ onScan, large }: { onScan: (code: string) => void; large?: boolean }) {
  const [open, setOpen] = useState(false);
  const [supported, setSupported] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const cb = useRef(onScan);
  cb.current = onScan;
  useEffect(() => setSupported(typeof window !== 'undefined' && 'BarcodeDetector' in window), []);
  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const detector = new (window as any).BarcodeDetector({ formats: ['itf', 'code_128', 'code_39', 'ean_13', 'qr_code'] });
        while (!stop) {
          const codes = await detector.detect(video.current);
          if (codes[0]?.rawValue) {
            cb.current(codes[0].rawValue);
            setOpen(false);
            break;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        setOpen(false);
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [open]);
  if (!supported) return null;
  return (
    <>
      <button type="button" className={large ? 'btn py-4 text-base' : 'btn'} onClick={() => setOpen(true)}>
        <Camera className="h-5 w-5" /> Camera
      </button>
      {open && (
        <Modal title="Scan barcode" onClose={() => setOpen(false)}>
          <video ref={video} className="w-full rounded-lg bg-black" muted playsInline />
        </Modal>
      )}
    </>
  );
}

/** Open / close a shift. */
export function ShiftPanel({ cashier, big }: { cashier: Cashier; big?: boolean }) {
  const { casino } = useSession();
  const desks = useApi<any[]>(`/cashier/desks?casinoId=${casino.id}`);
  const [desk, setDesk] = useState('');
  const [opening, setOpening] = useState('2000');
  const [closing, setClosing] = useState(false);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const s = cashier.session;

  if (!s) {
    const free = (desks.data ?? []).filter((d) => !d.session_id);
    return (
      <div className="space-y-3">
        <Notice>No open shift. Choose a desk and count the opening float.</Notice>
        <Field label="Cash desk">
          <select className={clsx('input', big && 'py-3 text-base')} value={desk} onChange={(e) => setDesk(e.target.value)}>
            <option value="">Select desk...</option>
            {free.map((d) => <option key={d.id} value={d.id}>{d.name} {d.kind === 'MOBILE' ? '(mobile)' : ''}</option>)}
          </select>
        </Field>
        <Field label="Opening balance (EUR)"><input className={clsx('input', big && 'py-3 text-base')} inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} /></Field>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <button className={clsx('btn-primary w-full', big && 'py-4 text-lg')} disabled={!desk}
          onClick={async () => { try { await cashier.open(desk, Number(opening) || 0); setMsg(null); void desks.reload(); } catch (e) { setMsg({ tone: 'bad', text: (e as Error).message }); } }}>
          Open shift
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Stat label="Desk" value={s.desk_name} />
      <Stat label="Opened" value={timeAgo(s.opened_at)} hint={formatDateTime(s.opened_at)} />
      <Stat label="Opening balance" value={formatEuro(s.opening_balance)} />
      {Object.entries(s.byType as Record<string, { total: number; count: number }>).map(([k, v]) => (
        <Stat key={k} label={`${CASH_TX_LABEL[k] ?? k} (${v.count})`} value={formatEuro(v.total)} tone={v.total < 0 ? 'bad' : 'good'} />
      ))}
      <div className="mt-2 flex items-baseline justify-between border-t border-line pt-3">
        <span className="text-sm font-semibold">Expected balance</span>
        <span className="text-2xl font-bold tabular-nums">{formatEuro(s.expected)}</span>
      </div>
      <button className={clsx('btn mt-3 w-full', big && 'py-4 text-base')} onClick={() => { setCounted(String(s.expected)); setClosing(true); }}>Close shift</button>
      {closing && (
        <Modal title="Close shift" onClose={() => setClosing(false)}>
          <div className="space-y-3">
            <Notice>Count the drawer. Expected: <b>{formatEuro(s.expected)}</b></Notice>
            <Field label="Counted balance (EUR)"><input className="input py-3 text-lg" inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus /></Field>
            {counted !== '' && Number(counted) !== s.expected && (
              <Notice tone="bad">Difference: {formatEuro(Number(counted) - s.expected)}. An alert will be raised.</Notice>
            )}
            <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
            <button className="btn-primary w-full py-3" onClick={async () => {
              try { await cashier.close(Number(counted), note); setClosing(false); void desks.reload(); } catch (e) { setMsg({ tone: 'bad', text: (e as Error).message }); }
            }}>Confirm and close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Validate a ticket barcode and pay it out. */
export function TicketPayout({ cashier, big }: { cashier: Cashier; big?: boolean }) {
  const [barcode, setBarcode] = useState('');
  const [ticket, setTicket] = useState<any>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  const lookup = async (code = barcode) => {
    setMsg(null);
    setTicket(null);
    if (!code.trim()) return;
    try {
      setTicket(await api(`/tickets/lookup/${encodeURIComponent(code.trim())}`));
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  };
  const pay = async () => {
    setBusy(true);
    try {
      const r = await cashier.redeem(ticket.barcode);
      setMsg({ tone: 'good', text: `Paid ${formatEuro(r.ticket.amount)} for ticket ${r.ticket.barcode}` });
      setTicket(null);
      setBarcode('');
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <form onSubmit={(e) => { e.preventDefault(); void lookup(); }} className="flex gap-2">
        <input className={clsx('input font-mono', big && 'py-4 text-lg')} inputMode="numeric" placeholder="Scan or type ticket barcode" value={barcode} onChange={(e) => setBarcode(e.target.value)} autoFocus={!big} />
        <button className={clsx('btn-primary', big && 'px-6 text-base')}>Check</button>
        <ScanButton large={big} onScan={(c) => { setBarcode(c); void lookup(c); }} />
      </form>
      {ticket && (
        <div className={clsx('rounded-xl border p-4', ticket.payable ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-red-500/40 bg-red-500/5')}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {ticket.payable ? <CheckCircle2 className="h-6 w-6 text-emerald-500" /> : <XCircle className="h-6 w-6 text-red-500" />}
              <span className="font-mono text-sm">{ticket.barcode}</span>
            </div>
            <TicketBadge status={ticket.status} />
          </div>
          <div className={clsx('mt-2 font-bold tabular-nums', big ? 'text-5xl' : 'text-3xl')}>{formatEuro(ticket.amount)}</div>
          <div className="mt-1 text-xs text-sub">Issued {formatDateTime(ticket.issued_at)} by {ticket.issued_machine ?? ticket.issued_employee} · expires {formatDateTime(ticket.expires_at)}</div>
          {ticket.reason && <div className="mt-2 font-semibold text-red-600">{ticket.reason}</div>}
          {ticket.payable && (
            <button className={clsx('btn-primary mt-4 w-full', big ? 'py-5 text-xl' : 'py-3')} disabled={busy || !cashier.session} onClick={pay}>
              {cashier.session ? `PAY ${formatEuro(ticket.amount)}` : 'Open a shift to pay'}
            </button>
          )}
        </div>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}

/** Amount entry + action buttons (sell ticket, cash in/out, vault). */
export function CashActions({ cashier, big }: { cashier: Cashier; big?: boolean }) {
  const { can } = useSession();
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const value = Number(amount);
  const go = async (label: string, fn: () => Promise<any>) => {
    try {
      const r = await fn();
      setMsg({ tone: 'good', text: r?.barcode ? `Ticket ${r.barcode} printed for ${formatEuro(r.amount)}` : `${label} ${formatEuro(value)} booked` });
      setAmount('');
      setRef('');
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  };
  const disabled = !cashier.session || !(value > 0);
  const btn = clsx(big ? 'py-4 text-base' : '');
  return (
    <div className="space-y-3">
      <div className={clsx('rounded-xl bg-muted px-4 py-3 text-right font-bold tabular-nums', big ? 'text-4xl' : 'text-2xl')}>{formatEuro(value || 0)}</div>
      {big ? <Keypad value={amount} onChange={setAmount} /> : <input className="input" inputMode="decimal" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} />}
      <input className="input" placeholder="Reference / player card (optional)" value={ref} onChange={(e) => setRef(e.target.value)} />
      <div className="grid grid-cols-2 gap-2">
        <button className={clsx('btn-primary', btn)} disabled={disabled} onClick={() => go('Ticket', () => cashier.issue(value))}>Sell ticket</button>
        <button className={clsx('btn', btn)} disabled={disabled} onClick={() => go('Cash in', () => cashier.tx('CASH_IN', value, ref))}>Cash in</button>
        <button className={clsx('btn', btn)} disabled={disabled} onClick={() => go('Cash out', () => cashier.tx('CASH_OUT', value, ref))}>Cash out</button>
        {can('cash.manage') && (
          <>
            <button className={clsx('btn', btn)} disabled={disabled} onClick={() => go('Fill', () => cashier.tx('FILL', value, ref || 'Vault fill'))}>Fill from vault</button>
            <button className={clsx('btn', btn)} disabled={disabled} onClick={() => go('Drop', () => cashier.tx('DROP', value, ref || 'Vault drop'))}>Drop to vault</button>
          </>
        )}
      </div>
      {!cashier.session && <div className="text-xs text-sub">Open a shift to book transactions.</div>}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}

/** Pending jackpot handpays on the floor. */
export function Handpays({ cashier, big }: { cashier: Cashier; big?: boolean }) {
  const { casino } = useSession();
  const list = useApi<any[]>(`/cashier/handpays?casinoId=${casino.id}`, { refreshMs: 4000 });
  const [msg, setMsg] = useState<Msg>(null);
  if (!list.data?.length) return <div className="py-6 text-center text-sm text-sub">No pending handpays.</div>;
  return (
    <div className="space-y-2">
      {list.data.map((h) => (
        <div key={h.id} className="flex items-center gap-3 rounded-xl border border-yellow-500/40 bg-yellow-500/5 p-3">
          <div className="flex-1">
            <div className="font-bold">{h.asset_no} <span className="text-xs font-normal text-sub">{h.manufacturer} · {h.floor} {h.position_label}</span></div>
            <div className={clsx('font-bold tabular-nums text-yellow-600 dark:text-yellow-400', big ? 'text-3xl' : 'text-xl')}>{formatEuro(h.amount)}</div>
            <div className="text-xs text-sub">hit {timeAgo(h.hit_at)}</div>
          </div>
          <button className={clsx('btn-primary', big && 'px-6 py-4 text-lg')} disabled={!cashier.session}
            onClick={async () => { try { const r = await cashier.handpay(h.id); setMsg({ tone: 'good', text: `Handpay ${formatEuro(r.amount)} on ${r.assetNo} paid, machine reset requested.` }); void list.reload(); } catch (e) { setMsg({ tone: 'bad', text: (e as Error).message }); } }}>
            PAY
          </button>
        </div>
      ))}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}

export function TransactionList({ items }: { items: any[] }) {
  if (!items.length) return <div className="py-6 text-center text-sm text-sub">No transactions in this shift yet.</div>;
  return (
    <div>
      {items.map((t) => (
        <div key={t.id} className="flex items-center gap-2 border-b border-line/60 py-2 text-sm last:border-0">
          <span className="w-24 shrink-0 text-xs text-sub">{new Date(t.created_at).toLocaleTimeString('de-AT')}</span>
          <span className="flex-1 truncate">{CASH_TX_LABEL[t.type] ?? t.type}<span className="ml-1 text-xs text-sub">{t.barcode ?? t.asset_no ?? t.reference ?? ''}</span></span>
          <span className={clsx('shrink-0 font-semibold tabular-nums', t.amount < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>{formatEuro(t.amount)}</span>
        </div>
      ))}
    </div>
  );
}
