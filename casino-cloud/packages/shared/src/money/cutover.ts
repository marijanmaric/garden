import type { AccountKind } from './accounts';

/**
 * Rail cutover (migration 006): a rail moves from LEGACY money (legacy tables are the truth) to
 * LEDGER money (the ledger service is the only money writer; legacy tables are projections).
 * Forward-only. Opening balances are created by the cutover itself, from verified legacy sources.
 */
export const CUTOVER_RAILS = ['VAULT', 'CASH', 'HANDPAY', 'TITO', 'CASHLESS', 'MACHINE'] as const;
export type CutoverRail = (typeof CUTOVER_RAILS)[number];

/** What one cutover covers: a casino, the organisation (wallets are org-level) or one machine. */
export const CUTOVER_SCOPE: Record<CutoverRail, 'CASINO' | 'ORG' | 'MACHINE'> = {
  VAULT: 'CASINO',
  CASH: 'CASINO',
  HANDPAY: 'CASINO',
  TITO: 'CASINO',
  CASHLESS: 'ORG',
  MACHINE: 'MACHINE',
};

/** Rails that must already be on the ledger (cutover order). */
export const CUTOVER_PREREQUISITES: Record<CutoverRail, readonly CutoverRail[]> = {
  VAULT: [],
  CASH: ['VAULT'], // desk cash goes into the vault, drawers are filled from it
  HANDPAY: ['CASH'], // paid from a drawer
  TITO: ['CASH'], // sold / paid at a drawer
  CASHLESS: [],
  MACHINE: ['VAULT', 'TITO', 'HANDPAY', 'CASHLESS'], // drops, tickets, jackpots and transfers touch the machine
};

/** Balance-sheet account kinds and the rail that owns them. Income/expense/equity/suspense belong to none. */
export const ACCOUNT_KIND_RAIL: Partial<Record<AccountKind, CutoverRail>> = {
  VAULT: 'VAULT',
  DRAWER: 'CASH',
  HANDPAY_PAYABLE: 'HANDPAY',
  TICKET_LIABILITY: 'TITO',
  WALLET_AVAILABLE: 'CASHLESS',
  WALLET_RESERVED: 'CASHLESS',
  CASHBOX: 'MACHINE',
  HOPPER: 'MACHINE',
  MACHINE_CREDIT: 'MACHINE',
};

/** Legacy cash_transactions types and the rails they move money on (both sides). */
export const LEGACY_CASH_TX_RAILS: Record<string, readonly CutoverRail[]> = {
  CASH_IN: ['CASH'],
  CASH_OUT: ['CASH'],
  ADJUSTMENT: ['CASH'],
  FILL: ['CASH', 'VAULT'],
  DROP: ['CASH', 'VAULT'],
  TICKET_ISSUE: ['CASH', 'TITO'],
  TICKET_PAYOUT: ['CASH', 'TITO'],
  HANDPAY: ['CASH', 'HANDPAY'],
};

/** Machine event types that move money on a machine (canonical and legacy wire names). */
export const MACHINE_MONEY_EVENT_TYPES = ['CASH_IN', 'CASH_OUT', 'TITO_IN', 'TITO_OUT', 'CASHLESS_IN', 'CASHLESS_OUT', 'JACKPOT', 'COIN_IN', 'COIN_OUT', 'TICKET_IN', 'TICKET_OUT'] as const;
/** Machine event types that put cash into the cashbox (legacy COIN_IN = canonical CASH_IN). */
export const CASHBOX_IN_EVENT_TYPES = ['CASH_IN', 'COIN_IN'] as const;

/**
 * Rails whose complete ledger-backed operations exist, so a production cutover is allowed.
 * VAULT and CASH are implemented in Step 7a, but ticket payouts and handpays (cash drawer +
 * TITO / HANDPAY) follow in 7b / 7c: until then a production cutover of them is refused.
 * Dry runs are always allowed; tests use the cutover service directly.
 */
export const RAIL_PRODUCTION_READY: readonly CutoverRail[] = ['CASHLESS'];

/** Freeze scopes: one rail (of a casino / machine / the org for CASHLESS) or everything (GLOBAL). */
export type FreezeRail = CutoverRail | 'GLOBAL';

/** The only bookings allowed on a frozen rail: corrections (both four-eyes / reversal rules apply). */
export const CORRECTION_TYPES = ['ADJUSTMENT', 'REVERSAL'] as const;
