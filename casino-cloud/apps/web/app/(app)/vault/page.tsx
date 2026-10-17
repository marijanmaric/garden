'use client';
import { useState } from 'react';
import { Clock } from 'lucide-react';
import { formatDateTime, timeAgo } from '@m1/ui';
import { useApi } from '@/lib/api';
import { formatCents, parseAmountCents, parseCountCents } from '@/lib/money';
import { useSession } from '@/lib/session';
import { AmountField, FreezeBanner, RailBadge, useConfirm, useOperatorContext } from '@/components/money-ui';
import { Card, Empty, ErrorNote, Field, Kpi, Notice, PageHeader } from '@/components/ui';

/**
 * Step 7e, vault / cash control (one screen): vault session with blind counts verified by a second
 * person, fills to cashier shifts and drops from them (confirmed by the receiving side with its own
 * count), hopper fills and machine collections. Every count is blind: amounts the counter must count
 * are never shown before the count.
 */

type Status = {
  vault: { id: string; name: string } | null;
  rails: Record<string, string>;
  ledgerMachines: string[];
  session: null | { id: string; status: 'OPEN' | 'COUNTING'; business_date: string; opened_at: string; opened_by_name: string; verified: boolean };
  pendingCounts: Array<{ id: string; context: string; counted_by: string; counted_by_name: string; created_at: string; mismatches: number }>;
  balanceCents: number | null;
  movements: Array<{ id: string; kind: string; purpose: string; status: string; amount_cents: number; requested_at: string; expires_at: string; requested_by: string; requested_by_name: string; desk_name: string | null; cashier_name: string | null; asset_no: string | null }>;
  shifts: Array<{ id: string; status: string; opened_at: string; desk_name: string; employee: string; employee_id: string }>;
  collectionCounts: Array<{ id: string; machine_id: string; asset_no: string; counted_by: string; counted_by_name: string; created_at: string; mismatches: number }>;
};

function CountBox({ label, button, onSubmit, testId }: { label: string; button: string; onSubmit: (cents: number) => void; testId?: string }) {
  const [v, setV] = useState('');
  const cents = parseCountCents(v);
  return (
    <div className="space-y-2">
      <AmountField label={label} value={v} onChange={setV} allowZero testId={testId} />
      <button className="btn-primary w-full" disabled={cents === null} onClick={() => { onSubmit(cents!); setV(''); }} data-testid={testId ? `${testId}-submit` : undefined}>{button}</button>
    </div>
  );
}

export default function VaultPage() {
  const { casino, me, can } = useSession();
  const ctx = useOperatorContext();
  const st = useApi<Status>(`/vault/status?casinoId=${casino.id}`, { refreshMs: 5000 });
  const machines = useApi<any[]>(`/machines?casinoId=${casino.id}`);
  const confirm = useConfirm(() => { void st.reload(); void ctx.reload(); });
  const [fillShift, setFillShift] = useState('');
  const [fillAmount, setFillAmount] = useState('');
  const [hopperMachine, setHopperMachine] = useState('');
  const [hopperAmount, setHopperAmount] = useState('');
  const [collectMachine, setCollectMachine] = useState('');
  const d = st.data;
  const s = d?.session;
  const ready = s?.status === 'OPEN' && s.verified;
  const ledgerMachines = (machines.data ?? []).filter((m) => d?.ledgerMachines.includes(m.id));
  const meId = me.user.id;
  const verified = (r: any) => (r?.matches === false ? 'Counts differ: NOT verified. Count again (recount) and verify again.' : 'Counts match: verified.');

  return (
    <div className="space-y-6">
      <PageHeader title="Vault" subtitle="Vault session, fills and drops of cashier shifts, hopper fills and machine collections. Every count is blind and verified by a second person."
        actions={d && <span className="text-xs text-sub">VAULT <RailBadge mode={d.rails.VAULT} /> · CASH <RailBadge mode={d.rails.CASH} /></span>} />
      <ErrorNote error={st.error} />
      <FreezeBanner freezes={ctx.data?.freezes} rails={['VAULT', 'CASH', 'MACHINE']} />
      {d && d.rails.VAULT !== 'LEDGER' && <Notice>The VAULT rail of this casino is not on the ledger yet (cutover in Money control). Legacy cash management stays available.</Notice>}

      {d && d.rails.VAULT === 'LEDGER' && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Kpi label="Vault session" value={s ? (s.status === 'OPEN' ? (s.verified ? 'OPEN' : 'OPEN · awaiting 2nd count') : 'COUNTING') : 'CLOSED'} sub={s ? `${s.business_date} · opened by ${s.opened_by_name} ${timeAgo(s.opened_at)}` : 'Open the vault with a blind count'} />
            <Kpi label="Vault balance (ledger)" value={d.balanceCents !== null ? formatCents(d.balanceCents) : 'hidden'} sub={d.balanceCents !== null ? 'Verified open vault' : 'Hidden while counting (blind)'} />
            <Kpi label="Open requests" value={d.movements.length} sub={`${d.shifts.length} cashier shift(s) open`} />
          </div>

          <div className="grid gap-6 xl:grid-cols-3">
            <Card title="Vault session">
              {!s && can('cash.manage') && (
                <CountBox label="Opening count (blind)" button="Open vault" testId="vault-open" onSubmit={(cents) => confirm.ask({
                  title: 'Open vault', summary: 'Your blind opening count. A different employee must count again to verify it before the vault can be used.',
                  amountCents: cents, details: [['Vault', d.vault?.name]], path: '/vault/sessions', body: { count: { totalCents: cents } }, describe: () => 'Vault opened; waiting for the second count.',
                })} />
              )}
              {d.pendingCounts.map((c) => (
                <div key={c.id} className="mb-3 space-y-2 rounded-xl border border-sky-500/40 bg-sky-500/5 p-3" data-testid="vault-pending-count">
                  <div className="text-sm font-semibold">{c.context === 'VAULT_OPEN' ? 'Opening' : 'Closing'} count by {c.counted_by_name} waiting for verification</div>
                  <div className="text-xs text-sub">{formatDateTime(c.created_at)}{c.mismatches ? ` · ${c.mismatches} mismatching verification(s)` : ''}</div>
                  {c.counted_by === meId ? (
                    <>
                      <Notice>A different employee must count blind to verify your count.</Notice>
                      {c.mismatches > 0 && <CountBox label="Recount (blind)" button="Submit recount" onSubmit={(cents) => confirm.ask({
                        title: 'Recount vault', summary: 'Your new blind count replaces the previous one; it must be verified again.', amountCents: cents,
                        path: `/vault/sessions/${s!.id}/recount`, body: { totalCents: cents },
                      })} />}
                    </>
                  ) : (
                    <CountBox label="Your blind count" button="Verify count" testId="vault-verify" onSubmit={(cents) => confirm.ask({
                      title: 'Verify vault count', summary: 'Your independent blind count. Matching counts settle the vault count (a difference to the ledger is booked with you as approver).',
                      amountCents: cents, details: [['First count by', c.counted_by_name]], path: `/vault/counts/${c.id}/verify`, body: { totalCents: cents }, describe: verified,
                    })} />
                  )}
                </div>
              ))}
              {ready && (
                <CountBox label="Close vault: closing count (blind)" button="Count for closing" testId="vault-close" onSubmit={(cents) => confirm.ask({
                  title: 'Close vault', summary: 'Your blind closing count. The vault closes when a second employee verifies it.', amountCents: cents,
                  path: `/vault/sessions/${s!.id}/close`, body: { totalCents: cents }, danger: true,
                })} />
              )}
              {s && !ready && !d.pendingCounts.length && <Empty>Waiting…</Empty>}
            </Card>

            <Card title="Fills and drops">
              {d.movements.filter((m) => m.kind !== 'HOPPER_FILL').map((m) => (
                <div key={m.id} className="mb-3 space-y-2 rounded-xl border border-line p-3 text-sm" data-testid={`vault-movement-${m.kind.toLowerCase()}`}>
                  <div className="font-semibold">{m.kind === 'FILL' ? 'Fill to' : m.purpose === 'CLOSE' ? 'Final drop from' : 'Drop from'} {m.desk_name} ({m.cashier_name})</div>
                  <div className="text-xs text-sub">Requested by {m.requested_by_name} {timeAgo(m.requested_at)} · expires {new Date(m.expires_at).toLocaleTimeString('de-AT')}</div>
                  {m.kind === 'FILL' ? (
                    <div className="flex items-center justify-between">
                      <span><Clock className="mr-1 inline h-4 w-4" />{formatCents(m.amount_cents)} waiting for the cashier to count and confirm</span>
                      {m.requested_by === meId && <button className="btn text-xs" onClick={() => confirm.ask({ title: 'Cancel fill', summary: 'Cancel this fill. No money has moved yet.', amountCents: m.amount_cents, path: `/cash/movements/${m.id}/cancel`, body: {}, danger: true })}>Cancel</button>}
                    </div>
                  ) : (
                    <CountBox label="Your blind count of the drop" button="Confirm drop received" testId="drop-confirm" onSubmit={(cents) => confirm.ask({
                      title: 'Confirm drop into vault', summary: 'You confirm receiving this amount from the cashier. A different count rejects the drop and nothing moves.', amountCents: cents,
                      details: [['From', `${m.desk_name} (${m.cashier_name})`], ['To', d.vault?.name]], path: `/cash/movements/${m.id}/confirm`, body: { totalCents: cents },
                      describe: (r) => r?.movement?.status === 'REJECTED' ? 'Count did not match: drop REJECTED, nothing booked.' : r?.movement?.status === 'EXPIRED' ? 'Drop expired, nothing booked.' : 'Drop booked into the vault.',
                    })} />
                  )}
                </div>
              ))}
              {ready && (
                <div className="space-y-2 border-t border-line pt-3">
                  <Field label="Issue fill to shift">
                    <select className="input" value={fillShift} onChange={(e) => setFillShift(e.target.value)} data-testid="fill-shift">
                      <option value="">Select open shift...</option>
                      {d.shifts.filter((x) => x.status === 'OPEN' && x.employee_id !== meId).map((x) => <option key={x.id} value={x.id}>{x.desk_name} · {x.employee}</option>)}
                    </select>
                  </Field>
                  <AmountField label="Fill amount" value={fillAmount} onChange={setFillAmount} testId="fill-amount" />
                  <button className="btn-primary w-full" disabled={!fillShift || !parseAmountCents(fillAmount)} data-testid="issue-fill" onClick={() => {
                    const x = d.shifts.find((y) => y.id === fillShift)!;
                    confirm.ask({
                      title: 'Issue fill', summary: 'Cash leaves the vault for this drawer when the cashier confirms it with their own count.', amountCents: parseAmountCents(fillAmount)!,
                      details: [['From', d.vault?.name], ['To', `${x.desk_name} (${x.employee})`]], path: '/cash/movements', body: { kind: 'FILL', cashierSessionId: fillShift, amountCents: parseAmountCents(fillAmount) },
                      describe: () => 'Fill issued; waiting for the cashier.',
                    });
                    setFillAmount('');
                  }}>Issue fill</button>
                </div>
              )}
              {!ready && <div className="text-xs text-sub">Fills and drops need an open, verified vault.</div>}
            </Card>

            <Card title="Machines: hopper fill and collection">
              {d.movements.filter((m) => m.kind === 'HOPPER_FILL').map((m) => (
                <div key={m.id} className="mb-2 flex items-center justify-between rounded-xl border border-line p-3 text-sm" data-testid="hopper-pending">
                  <span><Clock className="mr-1 inline h-4 w-4" />Hopper fill {formatCents(m.amount_cents)} for {m.asset_no}: confirm at the machine</span>
                  {m.requested_by === meId && <button className="btn text-xs" onClick={() => confirm.ask({ title: 'Cancel hopper fill', summary: 'Cancel this hopper fill. No money has moved yet.', amountCents: m.amount_cents, path: `/cash/movements/${m.id}/cancel`, body: {}, danger: true })}>Cancel</button>}
                </div>
              ))}
              {d.collectionCounts.map((c) => (
                <div key={c.id} className="mb-3 space-y-2 rounded-xl border border-sky-500/40 bg-sky-500/5 p-3" data-testid="collection-pending">
                  <div className="text-sm font-semibold">Collection {c.asset_no}: count by {c.counted_by_name} waiting for verification</div>
                  {c.counted_by === meId ? <Notice>A different employee must count blind to verify it.</Notice> : (
                    <CountBox label="Your blind count" button="Verify collection" testId="collection-verify" onSubmit={(cents) => confirm.ask({
                      title: 'Verify machine collection', summary: 'Matching counts book the drop into the vault (and a difference to the ledger with you as approver). A mismatch books nothing.',
                      amountCents: cents, details: [['Machine', c.asset_no], ['First count by', c.counted_by_name]], path: `/machines/collections/counts/${c.id}/verify`, body: { totalCents: cents },
                      describe: (r) => r?.matches === false ? 'Counts differ: nothing booked. Count again.' : 'Collection booked into the vault.',
                    })} />
                  )}
                </div>
              ))}
              {ready ? (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Field label="Hopper fill: machine">
                      <select className="input" value={hopperMachine} onChange={(e) => setHopperMachine(e.target.value)} data-testid="hopper-machine">
                        <option value="">Select machine (MACHINE on ledger)...</option>
                        {ledgerMachines.map((m) => <option key={m.id} value={m.id}>{m.asset_no} · {m.manufacturer}</option>)}
                      </select>
                    </Field>
                    <AmountField label="Hopper fill amount" value={hopperAmount} onChange={setHopperAmount} testId="hopper-amount" />
                    <button className="btn w-full" disabled={!hopperMachine || !parseAmountCents(hopperAmount)} data-testid="hopper-request" onClick={() => {
                      confirm.ask({
                        title: 'Hopper fill', summary: 'Cash leaves the vault for the machine hopper when an attendant confirms it at the machine with their own count.', amountCents: parseAmountCents(hopperAmount)!,
                        details: [['Machine', ledgerMachines.find((m) => m.id === hopperMachine)?.asset_no]], path: `/machines/${hopperMachine}/hopper-fills`, body: { amountCents: parseAmountCents(hopperAmount) },
                        describe: () => 'Hopper fill requested; confirm it at the machine.',
                      });
                      setHopperAmount('');
                    }}>Request hopper fill</button>
                  </div>
                  <div className="space-y-2 border-t border-line pt-3">
                    <Field label="Collection: machine">
                      <select className="input" value={collectMachine} onChange={(e) => setCollectMachine(e.target.value)} data-testid="collect-machine">
                        <option value="">Select machine (MACHINE on ledger)...</option>
                        {ledgerMachines.map((m) => <option key={m.id} value={m.id}>{m.asset_no} · {m.manufacturer}</option>)}
                      </select>
                    </Field>
                    {collectMachine && <CountBox label="Cashbox count (blind)" button="Record collection count" testId="collect-count" onSubmit={(cents) => confirm.ask({
                      title: 'Machine collection count', summary: 'Your blind count of the cashbox. A second employee must count blind to verify it; then the drop is booked.', amountCents: cents,
                      details: [['Machine', ledgerMachines.find((m) => m.id === collectMachine)?.asset_no]], path: `/machines/${collectMachine}/collections/count`, body: { totalCents: cents },
                      describe: () => 'Count recorded; waiting for the second count.',
                    })} />}
                  </div>
                </div>
              ) : <div className="text-xs text-sub">Hopper fills and collections need an open, verified vault.</div>}
              {!ledgerMachines.length && <div className="mt-2 text-xs text-sub">No machine of this casino is on the MACHINE ledger yet.</div>}
            </Card>
          </div>
        </>
      )}
      {confirm.dialog}
    </div>
  );
}
