'use client';
import { useState } from 'react';
import { useApi } from '@/lib/api';
import { formatCents, parseCountCents } from '@/lib/money';
import { AmountField, useConfirm } from './money-ui';
import { Notice } from './ui';
import { clsx } from './clsx';

/**
 * Step 7e, second person of a blind count: the API discloses the submitted count, the authoritative expected
 * amount and the difference only to a different employee (GET /counts/:id/review, 403 for the counter).
 * Approve = verification with the submitted total (the approved settlement runs: difference booked with the
 * reviewer as approver); reject = the reviewer's own different count (mismatch: nothing booked, recount).
 */
export function CountReview({ countId, verifyPath, onDone, label }: { countId: string; verifyPath: string; onDone: () => void; label?: string }) {
  const r = useApi<any>(`/counts/${countId}/review`);
  const [own, setOwn] = useState('');
  const confirm = useConfirm(onDone);
  if (r.error) return <Notice tone="bad">{r.error}</Notice>;
  const d = r.data;
  if (!d) return null;
  const ownCents = parseCountCents(own);
  return (
    <div className="space-y-2" data-testid="count-review">
      <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-sub">Counted by {d.countedByName}</dt><dd className="font-semibold tabular-nums" data-testid="review-counted">{formatCents(d.countedCents)}</dd>
        <dt className="text-sub">Expected ({d.basis === 'LEDGER_CASHBOX' ? 'CASHBOX ledger' : d.basis === 'LEDGER_VAULT' ? 'vault ledger' : d.basis === 'MACHINE_EVENTS' ? 'machine-reported cash' : d.basis === 'LEGACY_DRAWER' ? 'legacy drawer' : 'opening count'})</dt>
        <dd className="font-semibold tabular-nums" data-testid="review-expected">{d.expectedCents === null ? 'none (opening)' : formatCents(d.expectedCents)}</dd>
        <dt className="text-sub">Difference</dt>
        <dd className={clsx('font-semibold tabular-nums', d.differenceCents ? 'text-red-600' : 'text-emerald-600')} data-testid="review-difference">{d.differenceCents === null ? '-' : formatCents(d.differenceCents)}</dd>
      </dl>
      {d.mismatches > 0 && <div className="text-xs text-amber-700">{d.mismatches} rejected verification(s) before.</div>}
      <button className="btn-primary w-full" data-testid="review-approve" onClick={() => confirm.ask({
        title: `Approve count${label ? `: ${label}` : ''}`,
        summary: d.differenceCents ? 'You confirm this count as the second person. The difference to the expected amount is booked with you as approver.' : 'You confirm this count as the second person.',
        amountCents: d.countedCents, details: [['Counted by', d.countedByName], ['Expected', d.expectedCents === null ? 'none' : formatCents(d.expectedCents)], ['Difference', d.differenceCents === null ? '-' : formatCents(d.differenceCents)]],
        path: verifyPath, body: { totalCents: d.countedCents }, confirmLabel: 'Approve',
        describe: (x) => (x?.matches === false ? 'NOT verified.' : 'Count verified.'),
      })}>Approve count</button>
      <AmountField label="Reject: your own count" value={own} onChange={setOwn} allowZero testId="review-own" />
      <button className="btn w-full" data-testid="review-reject" disabled={ownCents === null || ownCents === d.countedCents} onClick={() => confirm.ask({
        title: 'Reject count', summary: 'Your own count differs: the count is not verified, nothing is booked, and it must be counted again.', amountCents: ownCents!,
        details: [['Submitted count', formatCents(d.countedCents)]], path: verifyPath, body: { totalCents: ownCents }, danger: true, confirmLabel: 'Reject',
        describe: () => 'Rejected: nothing booked, count again.',
      })}>Reject with my count</button>
      {confirm.dialog}
    </div>
  );
}
