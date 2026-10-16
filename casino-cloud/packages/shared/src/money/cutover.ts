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

/** Rails whose ledger-backed operations are implemented (7a: VAULT, CASH; 7b: HANDPAY; 7c: TITO). */
export const RAIL_IMPLEMENTED: readonly CutoverRail[] = ['VAULT', 'CASH', 'HANDPAY', 'TITO', 'CASHLESS'];

/*
 * Three different kinds of dependency between rails, kept apart on purpose:
 *
 * A. IMPLEMENTATION dependency (technical): the rail's own ledger operations post to accounts of
 *    another rail, so that rail's ledger operations must exist. Derived from the posting matrix:
 *    HANDPAY_CREATE_JACKPOT touches HANDPAY_PAYABLE + expense, HANDPAY_PAY touches HANDPAY_PAYABLE +
 *    DRAWER (CASH) or WALLET_AVAILABLE (CASHLESS, optional payout). HANDPAY never touches TITO.
 *
 * B. CUTOVER dependency (technical, enforced by the cutover service): rails that must already be on
 *    the ledger when the rail is cut over = CUTOVER_PREREQUISITES (HANDPAY needs CASH).
 *
 * C. MAINTENANCE-WINDOW dependency (operational only): rails that must go live in the same window,
 *    because a legacy operation spans them and would stop working if only one side were on the
 *    ledger: legacy fill / drop (CASH + VAULT), legacy cashier ticket payout / sale (CASH + TITO),
 *    legacy handpay payment (CASH + HANDPAY). The window may only be opened when every rail in it is
 *    implemented. This - and nothing else - is why a production HANDPAY cutover waits for TITO.
 */
export const RAIL_IMPLEMENTATION_REQUIRES: Record<CutoverRail, readonly CutoverRail[]> = {
  VAULT: [],
  CASH: ['VAULT'], // fills / drops
  HANDPAY: ['CASH'], // cash payout from a drawer (wallet payout additionally needs CASHLESS, checked per payment)
  TITO: ['CASH'], // cashier sale / payout
  CASHLESS: [],
  MACHINE: ['VAULT', 'TITO', 'HANDPAY', 'CASHLESS'],
};

/** C: rails that go live together (one maintenance window). Rails not listed form a window of their own. */
export const MAINTENANCE_WINDOWS: ReadonlyArray<readonly CutoverRail[]> = [['VAULT', 'CASH', 'HANDPAY', 'TITO']];

export function maintenanceWindowOf(rail: CutoverRail): readonly CutoverRail[] {
  return MAINTENANCE_WINDOWS.find((w) => w.includes(rail)) ?? [rail];
}

export interface RailRelease {
  rail: CutoverRail;
  /** A: missing ledger implementations the rail itself needs (technical). */
  implementationMissing: CutoverRail[];
  /** B: rails that must be on the ledger before this cutover (enforced by the cutover itself). */
  cutoverPrerequisites: readonly CutoverRail[];
  /** C: rails of the same maintenance window whose ledger implementation is still missing (operational). */
  windowMissing: CutoverRail[];
  released: boolean;
}

export function railRelease(rail: CutoverRail): RailRelease {
  const seen = new Set<CutoverRail>();
  const visit = (r: CutoverRail) => {
    if (seen.has(r)) return;
    seen.add(r);
    RAIL_IMPLEMENTATION_REQUIRES[r].forEach(visit);
  };
  visit(rail);
  const implementationMissing = [...seen].filter((r) => !RAIL_IMPLEMENTED.includes(r)).sort();
  const windowMissing = maintenanceWindowOf(rail).filter((r) => !RAIL_IMPLEMENTED.includes(r) && !implementationMissing.includes(r)).sort();
  return { rail, implementationMissing, cutoverPrerequisites: CUTOVER_PREREQUISITES[rail], windowMissing, released: !implementationMissing.length && !windowMissing.length };
}

/** Rails not implemented yet that block a production cutover of `rail` (A + C; empty = released). */
export function railReleaseBlockers(rail: CutoverRail): CutoverRail[] {
  const r = railRelease(rail);
  return [...new Set([...r.implementationMissing, ...r.windowMissing])].sort();
}

/** Rails that may be cut over in production now. Dry runs are always allowed; tests use the service directly. */
export const RAIL_PRODUCTION_READY: readonly CutoverRail[] = CUTOVER_RAILS.filter((r) => railRelease(r).released);

/** Freeze scopes: one rail (of a casino / machine / the org for CASHLESS) or everything (GLOBAL). */
export type FreezeRail = CutoverRail | 'GLOBAL';

/** The only bookings allowed on a frozen rail: corrections (both four-eyes / reversal rules apply). */
export const CORRECTION_TYPES = ['ADJUSTMENT', 'REVERSAL'] as const;
