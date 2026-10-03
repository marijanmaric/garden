/** Ledger entry types. The ledger (gaming_transactions) is append-only. */
export const LEDGER_TYPES = [
  'WAGER', // credits bet (feeds Coin In)
  'WIN', // credits won (feeds Coin Out)
  'JACKPOT',
  'TICKET_IN',
  'TICKET_OUT',
  'CASH_IN',
  'CASH_OUT',
  'ADJUSTMENT',
  'MANUAL',
] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

export interface FinancialSummary {
  coinIn: number;
  coinOut: number;
  jackpots: number;
  /** GGR = Coin In - Coin Out - Jackpots */
  ggr: number;
  /** NGR = GGR - promotional credits (none yet in the MVP) */
  ngr: number;
  ticketsIn: number;
  ticketsOut: number;
  cashIn: number;
  cashOut: number;
  gamesPlayed: number;
}

export function computeGgr(coinIn: number, coinOut: number, jackpots: number): number {
  return round2(coinIn - coinOut - jackpots);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
