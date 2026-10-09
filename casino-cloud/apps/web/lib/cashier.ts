'use client';
import { useCallback } from 'react';
import { api, useApi } from './api';
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
    open: (cashDeskId: string, openingBalance: number) => run(() => api('/cashier/session/open', { method: 'POST', json: { cashDeskId, openingBalance } })),
    close: (countedBalance: number, note?: string) => run(() => api('/cashier/session/close', { method: 'POST', json: { countedBalance, note } })),
    redeem: (barcode: string) => run(() => api('/tickets/redeem', { method: 'POST', json: { barcode } })),
    issue: (amount: number) => run(() => api('/tickets/issue', { method: 'POST', json: { amount } })),
    tx: (type: string, amount: number, reference?: string, playerCard?: string) =>
      run(() => api('/cashier/transactions', { method: 'POST', json: { type, amount, reference: reference || undefined, playerCard: playerCard || undefined } })),
    handpay: (machineId: string) => run(() => api(`/cashier/handpays/${machineId}`, { method: 'POST', json: {} })),
  };
}

export type Cashier = ReturnType<typeof useCashier>;

export const CASH_TX_LABEL: Record<string, string> = {
  CASH_IN: 'Cash in', CASH_OUT: 'Cash out', TICKET_PAYOUT: 'Ticket payout', TICKET_ISSUE: 'Ticket sold',
  HANDPAY: 'Handpay', FILL: 'Fill', DROP: 'Drop', ADJUSTMENT: 'Adjustment',
};
