'use client';
import { useCallback, useState } from 'react';
import { api, newIdempotencyKey, useApi } from './api';
import { useLiveRefresh } from './live';

/** Current cashier shift plus all drawer actions. Shared by the cage workstation and the mobile cashier. */
export function useCashier() {
  const s = useApi<any>('/cashier/session');
  useLiveRefresh(() => void s.reload(), 1500, ['alert.created', 'alert.updated']);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      const r = await fn();
      await s.reload();
      return r;
    },
    [s],
  );
  return {
    session: s.data?.session ?? null,
    transactions: (s.data?.transactions ?? []) as any[],
    loading: s.loading && !s.data,
    reload: s.reload,
    open: (cashDeskId: string, openingBalance: number, key?: string) =>
      run(() => api('/cashier/session/open', { method: 'POST', json: { cashDeskId, openingBalance }, idempotencyKey: key })),
    close: (countedBalance: number, note?: string, key?: string) =>
      run(() => api('/cashier/session/close', { method: 'POST', json: { countedBalance, note }, idempotencyKey: key })),
    redeem: (barcode: string, key?: string) => run(() => api('/tickets/redeem', { method: 'POST', json: { barcode }, idempotencyKey: key })),
    issue: (amount: number, key?: string) => run(() => api('/tickets/issue', { method: 'POST', json: { amount }, idempotencyKey: key })),
    tx: (type: string, amount: number, reference?: string, playerCard?: string, key?: string) =>
      run(() => api('/cashier/transactions', { method: 'POST', json: { type, amount, reference: reference || undefined, playerCard: playerCard || undefined }, idempotencyKey: key })),
    handpay: (machineId: string, jackpotEventId: string, key?: string) =>
      run(() => api(`/cashier/handpays/${machineId}`, { method: 'POST', json: { jackpotEventId }, idempotencyKey: key })),
  };
}

export type Cashier = ReturnType<typeof useCashier>;

export const CASH_TX_LABEL: Record<string, string> = {
  CASH_IN: 'Cash in', CASH_OUT: 'Cash out', TICKET_PAYOUT: 'Ticket payout', TICKET_ISSUE: 'Ticket sold',
  HANDPAY: 'Handpay', FILL: 'Fill', DROP: 'Drop', ADJUSTMENT: 'Adjustment',
};

/**
 * One idempotency key per operator intent: it stays the same across double taps and network
 * retries of the same action, and is renewed only after the action finished.
 */
export function useActionKey(prefix: string) {
  const [key, setKey] = useState(() => newIdempotencyKey(prefix));
  return { key, renew: useCallback(() => setKey(newIdempotencyKey(prefix)), [prefix]) };
}
