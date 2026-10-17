'use client';
import { useState } from 'react';
import { Lock } from 'lucide-react';
import { formatDateTime, timeAgo } from '@m1/ui';
import { api, useApi } from '@/lib/api';
import { formatCents, parseCountCents } from '@/lib/money';
import { useSession } from '@/lib/session';
import { AmountField, RailBadge, useConfirm, useOperatorContext } from '@/components/money-ui';
import { DeferredEvents, EventExceptions } from '@/components/money-admin';
import { CountReview } from '@/components/count-review';
import { Card, Empty, ErrorNote, Field, Notice, PageHeader } from '@/components/ui';
import { clsx } from '@/components/clsx';

/**
 * Step 7e, money control (admin, one screen): rail state LEGACY / LEDGER, verified cutover counts, dry
 * run and cutover, active freezes (lift after a clean run), deferred money events (late booking of a
 * closed date by four eyes), machine event exceptions and legacy handpay exceptions. Every action goes
 * to the existing guarded API; this screen only shows state and asks for confirmations.
 */

const RAILS = ['VAULT', 'CASH', 'HANDPAY', 'TITO', 'CASHLESS', 'MACHINE'] as const;

function DryRun({ machines }: { machines: any[] }) {
  const [rail, setRail] = useState<(typeof RAILS)[number]>('VAULT');
  const [machineId, setMachineId] = useState('');
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm((d) => setReport(d));
  const target = { rail, machineId: rail === 'MACHINE' ? machineId : undefined };
  const run = async () => {
    setError(null); setReport(null);
    try { setReport(await api('/money/cutover/dry-run', { method: 'POST', json: target })); } catch (e) { setError((e as Error).message); }
  };
  const failed = (report?.checks ?? []).filter((c: any) => !c.ok);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Rail">
          <select className="input" value={rail} onChange={(e) => { setRail(e.target.value as any); setReport(null); }} data-testid="cutover-rail">
            {RAILS.map((r) => <option key={r}>{r}</option>)}
          </select>
        </Field>
        {rail === 'MACHINE' && (
          <Field label="Machine">
            <select className="input" value={machineId} onChange={(e) => { setMachineId(e.target.value); setReport(null); }} data-testid="cutover-machine">
              <option value="">Select...</option>
              {machines.map((m) => <option key={m.id} value={m.id}>{m.asset_no}</option>)}
            </select>
          </Field>
        )}
      </div>
      <div className="flex gap-2">
        <button className="btn flex-1" disabled={rail === 'MACHINE' && !machineId} onClick={run} data-testid="dry-run">Dry run (no changes)</button>
        <button className="btn-danger flex-1" disabled={!report?.ok || !report?.dryRun} data-testid="cutover-execute" onClick={() => confirm.ask({
          title: `Cut ${rail} over to the ledger`, summary: 'The dry run was clean. The cutover books the verified openings and switches the rail to the ledger. It cannot be undone.',
          details: [['Rail', rail], ...(rail === 'MACHINE' ? [['Machine', machines.find((m) => m.id === machineId)?.asset_no] as [string, string]] : []),
            ...(report?.openings ?? []).map((o: any) => [`Opening ${o.accountKind ?? o.kind ?? ''}`, formatCents(o.amountCents)] as [string, string])],
          path: '/money/cutover', body: target, danger: true, confirmLabel: 'Execute cutover', describe: (d) => (d.ok ? `${rail} is on the ledger now.` : 'Cutover aborted: see the checks.'),
        })}>Execute cutover</button>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {report && (
        <div className={clsx('rounded-lg p-3 text-sm', report.ok ? 'bg-emerald-500/10' : 'bg-red-500/10')} data-testid="dry-run-report">
          <div className="font-semibold">{report.dryRun ? 'Dry run' : 'Cutover'} {report.ok ? 'clean' : `blocked (${failed.length} check(s))`}</div>
          {failed.map((c: any) => <div key={c.name} className="mt-1 text-xs"><b>{c.name}</b>{c.detail ? `: ${JSON.stringify(c.detail)}` : ''}</div>)}
          {report.ok && (report.openings ?? []).map((o: any, i: number) => <div key={i} className="mt-1 text-xs">Opening {o.accountKind ?? ''}: {formatCents(o.amountCents)}</div>)}
        </div>
      )}
      {confirm.dialog}
    </div>
  );
}

function CutoverCounts({ machines, vaults, desks }: { machines: any[]; vaults: Array<{ id: string; name: string }>; desks: any[] }) {
  const { casino, me } = useSession();
  const counts = useApi<any[]>(`/money/counts?casinoId=${casino.id}`, { refreshMs: 8000 });
  const [context, setContext] = useState<'VAULT_CUTOVER' | 'DRAWER_CUTOVER' | 'MACHINE_DROP'>('VAULT_CUTOVER');
  const [ref, setRef] = useState('');
  const [amount, setAmount] = useState('');
  const confirm = useConfirm(() => void counts.reload());
  const options = context === 'VAULT_CUTOVER' ? vaults.map((v) => [v.id, v.name]) : context === 'DRAWER_CUTOVER' ? desks.map((d) => [d.id, d.name]) : machines.map((m) => [m.id, m.asset_no]);
  const refKey = context === 'VAULT_CUTOVER' ? 'vaultId' : context === 'DRAWER_CUTOVER' ? 'cashDeskId' : 'machineId';
  const cents = parseCountCents(amount);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Count for">
          <select className="input" value={context} onChange={(e) => { setContext(e.target.value as any); setRef(''); }} data-testid="count-context">
            <option value="VAULT_CUTOVER">Vault (VAULT cutover)</option>
            <option value="DRAWER_CUTOVER">Cash desk (CASH cutover)</option>
            <option value="MACHINE_DROP">Machine cashbox (MACHINE cutover)</option>
          </select>
        </Field>
        <Field label="Object">
          <select className="input" value={ref} onChange={(e) => setRef(e.target.value)} data-testid="count-ref">
            <option value="">Select...</option>
            {options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </Field>
      </div>
      <AmountField label="Physical count (blind)" value={amount} onChange={setAmount} allowZero testId="count-amount" />
      <button className="btn w-full" disabled={!ref || cents === null} data-testid="count-record" onClick={() => { confirm.ask({
        title: 'Record cutover count', summary: 'Your blind physical count. A different employee must count blind to verify it.', amountCents: cents!,
        details: [['Object', options.find(([id]) => id === ref)?.[1]]], path: '/money/counts', body: { context, [refKey]: ref, totalCents: cents },
      }); setAmount(''); }}>Record count</button>
      {!counts.data?.length && <Empty>No cutover counts yet.</Empty>}
      {counts.data?.map((c) => {
        return (
          <div key={c.id} className="rounded-lg border border-line p-2 text-sm" data-testid="cutover-count">
            <div className="flex items-center justify-between">
              <span>{c.vault_name ?? c.desk_name ?? c.asset_no} · {c.context.replace('_', ' ')} · by {c.counted_by_name} {timeAgo(c.created_at)}</span>
              <span className={clsx('badge', c.used ? 'bg-slate-500/15 text-slate-600 ring-slate-500/30' : c.verified ? 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/30' : 'bg-amber-500/15 text-amber-700 ring-amber-500/30')}>{c.used ? 'USED' : c.verified ? 'VERIFIED' : c.mismatches ? `MISMATCH ×${c.mismatches}` : 'UNVERIFIED'}</span>
            </div>
            {!c.verified && !c.used && (c.counted_by === me.user.id ? <div className="mt-1 text-xs text-sub">A different employee must verify this count.</div> : (
              <div className="mt-2"><CountReview countId={c.id} verifyPath={`/money/counts/${c.id}/verify`} onDone={() => void counts.reload()} label={c.vault_name ?? c.desk_name ?? c.asset_no} /></div>
            ))}
          </div>
        );
      })}
      {confirm.dialog}
    </div>
  );
}

function Freezes() {
  const ctx = useOperatorContext();
  const { can } = useSession();
  const [reason, setReason] = useState('');
  const confirm = useConfirm(() => void ctx.reload());
  const list = ctx.data?.freezes ?? [];
  if (!list.length) return <Empty>No active freeze.</Empty>;
  return (
    <div className="space-y-2">
      <Field label="Reason for lifting"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What was fixed / explained" data-testid="lift-reason" /></Field>
      {list.map((f) => (
        <div key={f.id} className="flex items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-2 text-sm" data-testid="freeze-row">
          <span><Lock className="mr-1 inline h-4 w-4" /><b>{f.rail}{f.asset_no ? ` · ${f.asset_no}` : ''}</b> since {formatDateTime(f.frozen_at)}<div className="text-xs text-sub">{f.reason}</div></span>
          {can('money.cutover') && <button className="btn text-xs" disabled={reason.trim().length < 5} onClick={() => confirm.ask({
            title: `Lift freeze: ${f.rail}${f.asset_no ? ` (${f.asset_no})` : ''}`, summary: 'Runs a reconciliation now. The freeze is lifted only if the run of this rail is clean; deferred events are then replayed exactly once.',
            details: [['Reason', reason]], path: `/money/freezes/${f.id}/lift`, body: { reason }, confirmLabel: 'Lift freeze',
            describe: (d) => (d.lifted ? `Lifted. Replayed: ${(d.replayed?.length ?? 0) + (d.replayedTickets?.length ?? 0) + (d.replayedMachine?.length ?? 0)} deferred event(s).` : 'Not lifted.'),
          })}>Lift</button>}
        </div>
      ))}
      {confirm.dialog}
    </div>
  );
}

function LegacyHandpayExceptions() {
  const { casino } = useSession();
  const list = useApi<any[]>(`/handpays/legacy-exceptions?casinoId=${casino.id}`, { refreshMs: 15000 });
  const [form, setForm] = useState<Record<string, any>>({});
  const confirm = useConfirm(() => void list.reload());
  const detect = useConfirm(() => void list.reload());
  const open = (list.data ?? []).filter((x) => x.status !== 'APPROVED');
  return (
    <div className="space-y-2">
      <button className="btn" onClick={() => detect.ask({ title: 'Detect legacy handpay exceptions', summary: 'Finds legacy handpay payments without a jackpot event (they block the HANDPAY cutover). Nothing is booked.', path: '/handpays/legacy-exceptions/detect', body: { casinoId: casino.id } })}>Detect</button>
      {!open.length && <Empty>No open legacy handpay exception.</Empty>}
      {open.map((x) => {
        const f = form[x.id] ?? { resolution: 'HISTORICAL', evidenceReference: '', justification: '' };
        const set = (k: string, v: string) => setForm({ ...form, [x.id]: { ...f, [k]: v } });
        return (
          <div key={x.id} className="space-y-2 rounded-lg border border-line p-2 text-sm">
            <div className="flex justify-between"><span>Legacy payment {formatCents(Number(x.amount_cents))} (cash row {x.cash_transaction_id})</span><span className="badge bg-amber-500/15 text-amber-700 ring-amber-500/30">{x.status}</span></div>
            {(x.status === 'OPEN' || x.status === 'REJECTED') && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <select className="input" value={f.resolution} onChange={(e) => set('resolution', e.target.value)}>
                    <option value="HISTORICAL">HISTORICAL (settled, no liability)</option>
                    <option value="DISPUTED">DISPUTED (investigation)</option>
                    <option value="LINK">LINK to jackpot event</option>
                  </select>
                  <input className="input" placeholder="Evidence reference" value={f.evidenceReference} onChange={(e) => set('evidenceReference', e.target.value)} />
                </div>
                {f.resolution === 'LINK' && <input className="input" placeholder="Jackpot event id" value={f.jackpotEventId ?? ''} onChange={(e) => set('jackpotEventId', e.target.value)} />}
                <input className="input" placeholder="Justification (20+ chars)" value={f.justification} onChange={(e) => set('justification', e.target.value)} />
                <button className="btn w-full" disabled={f.evidenceReference.trim().length < 3 || f.justification.trim().length < 20} onClick={() => confirm.ask({
                  title: 'Propose classification', summary: 'A second person must approve (Approvals). No money and no cash movement is created for history.', amountCents: Number(x.amount_cents),
                  details: [['Resolution', f.resolution], ['Evidence', f.evidenceReference]], path: `/handpays/legacy-exceptions/${x.id}/propose`,
                  body: { resolution: f.resolution, evidenceReference: f.evidenceReference, justification: f.justification, jackpotEventId: f.resolution === 'LINK' ? f.jackpotEventId : undefined },
                })}>Propose</button>
              </>
            )}
          </div>
        );
      })}
      {confirm.dialog}{detect.dialog}
    </div>
  );
}

export default function MoneyControlPage() {
  const { casino, can } = useSession();
  const ctx = useOperatorContext();
  const rails = useApi<any>(can('money.cutover') ? `/money/rails?casinoId=${casino.id}` : null, { refreshMs: 10000 });
  const machines = useApi<any[]>(`/machines?casinoId=${casino.id}`);
  const desks = useApi<any[]>(`/cashier/desks?casinoId=${casino.id}`);
  const vault = useApi<any>(can('cash.manage') ? `/vault/status?casinoId=${casino.id}` : null);
  const ledgerMachines = new Set(ctx.data?.ledgerMachines ?? []);
  return (
    <div className="space-y-6">
      <PageHeader title="Money control" subtitle="Rail state (LEGACY / LEDGER), cutover, freezes, deferred events and exceptions. Simple for the operator, guarded underneath." />
      <ErrorNote error={ctx.error} />
      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        {ctx.data && (['VAULT', 'CASH', 'HANDPAY', 'TITO', 'CASHLESS'] as const).map((r) => {
          const frozen = ctx.data!.freezes.some((f) => f.rail === r || f.rail === 'GLOBAL');
          return (
            <div key={r} className="card p-4" data-testid={`rail-${r}`}>
              <div className="text-xs font-semibold uppercase tracking-wide text-sub">{r}</div>
              <div className="mt-2 flex items-center gap-2"><RailBadge mode={ctx.data!.rails[r]} />{frozen && <span className="badge bg-red-500/15 text-red-600 ring-red-500/30"><Lock className="h-3 w-3" />FROZEN</span>}</div>
              <div className="mt-1 text-xs text-sub">{rails.data?.cutovers?.find((c: any) => c.rail === r) ? `since ${formatDateTime(rails.data.cutovers.find((c: any) => c.rail === r).as_of)}` : 'not cut over'}</div>
            </div>
          );
        })}
        {ctx.data && (
          <div className="card p-4" data-testid="rail-MACHINE">
            <div className="text-xs font-semibold uppercase tracking-wide text-sub">MACHINE</div>
            <div className="mt-2 text-lg font-semibold">{ledgerMachines.size} / {machines.data?.length ?? '-'}</div>
            <div className="mt-1 text-xs text-sub">machines on the ledger · {ctx.data.freezes.filter((f) => f.rail === 'MACHINE').length} frozen</div>
          </div>
        )}
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Active freezes"><Freezes /></Card>
        {can('money.cutover') ? <Card title="Cutover: dry run and execute"><DryRun machines={(machines.data ?? []).filter((m) => !ledgerMachines.has(m.id))} /></Card> : <Card title="Cutover"><Notice>Needs permission money.cutover.</Notice></Card>}
        {can('cash.manage') && <Card title="Cutover counts (four eyes, blind)"><CutoverCounts machines={(machines.data ?? []).filter((m) => !ledgerMachines.has(m.id))} vaults={vault.data?.vault ? [vault.data.vault] : []} desks={desks.data ?? []} /></Card>}
        {can('cashier.supervise') && <Card title="Legacy handpay exceptions (HANDPAY cutover blockers)"><LegacyHandpayExceptions /></Card>}
      </div>
      {can('cashier.supervise') && <Card title="Deferred money events (pending)" bodyClass="p-0"><DeferredEvents /></Card>}
      {can('cashier.supervise') && <Card title="Machine event exceptions" bodyClass="p-0"><EventExceptions /></Card>}
      <div className="text-xs text-sub">Machines on the ledger: {(machines.data ?? []).filter((m) => ledgerMachines.has(m.id)).map((m) => m.asset_no).join(', ') || 'none'}. Business date today: {ctx.data?.today}.</div>
    </div>
  );
}
