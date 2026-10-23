/**
 * Step 7e: presentation helpers for the operator screens. Pure functions only: nothing here decides an
 * amount, a balance or a booking. Amounts typed by the operator are parsed to integer cents as text
 * (no floating point), balances are always the ones the API returns from the ledger.
 */

/** Parses an operator amount ("50", "12,5", "1.234,56", "12.50") to integer cents; null if not a valid positive amount. */
export function parseAmountCents(input: string): number | null {
  const s = input.trim().replace(/\s/g, '').replace(/€/g, '');
  if (!s) return null;
  let intPart: string;
  let frac = '';
  // The last ',' or '.' followed by 1-2 digits is the decimal separator; other separators group thousands.
  const m = /^(.*?)[.,](\d{1,2})$/.exec(s);
  if (m) {
    intPart = m[1];
    frac = m[2];
  } else intPart = s;
  if (!/^\d{1,3}([.,]?\d{3})*$|^\d+$/.test(intPart)) return null;
  const digits = intPart.replace(/[.,]/g, '');
  if (!/^\d+$/.test(digits) || digits.length > 11) return null;
  const cents = Number(digits) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** Like parseAmountCents but also accepts 0 (blind counts can be zero). */
export function parseCountCents(input: string): number | null {
  const s = input.trim();
  if (/^0+([.,]0{1,2})?$/.test(s)) return 0;
  return parseAmountCents(s);
}

/** Euro display of integer cents, e.g. 123456 -> "1.234,56 €" (de-DE, matching the rest of the UI). */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '-';
  const v = Number(cents);
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  const euros = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${euros},${String(abs % 100).padStart(2, '0')} €`;
}

/** Whether a configured limit requires a second person for this amount (same rule as the API: amount >= limit). */
export function requiresApproval(amountCents: number, limitCents: number | null | undefined): boolean {
  return limitCents !== null && limitCents !== undefined && amountCents >= limitCents;
}

export type ScanKind = 'TICKET' | 'CARD' | 'UNKNOWN';

/** "Scan anything": TITO barcodes are numeric (6-30 digits, as the API accepts); other card-like input is a player card. */
export function classifyScan(input: string): ScanKind {
  const s = input.trim();
  if (/^\d{6,30}$/.test(s)) return 'TICKET';
  if (/^[A-Za-z0-9-]{3,40}$/.test(s)) return 'CARD';
  return 'UNKNOWN';
}

/** Operator wording for approval actions (business terms only). */
export const APPROVAL_LABEL: Record<string, string> = {
  HANDPAY_PAY: 'Handpay payment',
  HANDPAY_EXCEPTION: 'Handpay legacy exception',
  TITO_REDEEM_CASHIER: 'TITO ticket payout',
  TITO_CANCEL: 'TITO ticket cancellation',
  TITO_VOID: 'TITO ticket void',
  CASH_DEPOSIT: 'CASHLESS wallet deposit',
  CASH_WITHDRAWAL: 'CASHLESS wallet withdrawal',
  DRAWER_SHORT_OVER: 'Drawer short / over',
  RECONCILIATION_RESOLUTION: 'Reconciliation explanation',
  MACHINE_EXCEPTION_DISPOSITION: 'Machine exception disposition',
  LATE_EVENT_BOOKING: 'Late event booking',
};

/** Operator wording for ledger transaction types (wallet history, machine history). */
export const MONEY_TX_LABEL: Record<string, string> = {
  CASH_DEPOSIT: 'Cash deposit',
  CASH_WITHDRAWAL: 'Cash withdrawal',
  WALLET_TO_MACHINE_RESERVE: 'To machine (reserved)',
  WALLET_TO_MACHINE_CONFIRM: 'To machine',
  WALLET_TO_MACHINE_RELEASE: 'To machine (released)',
  WALLET_TO_MACHINE_LATE_CONFIRM: 'To machine (late confirmation)',
  MACHINE_TO_WALLET: 'From machine',
  TITO_REDEEM_CASHIER: 'TITO ticket paid',
  TITO_ISSUE_CASHIER: 'TITO ticket sold',
  HANDPAY_PAY: 'Handpay paid',
  ADJUSTMENT: 'Adjustment',
  REVERSAL: 'Reversal',
};

/** Machine money event types in business terms. */
export const MACHINE_MONEY_LABEL: Record<string, string> = {
  CASH_IN: 'CASH in',
  CASH_OUT: 'CASH out (hopper)',
  TITO_IN: 'TITO in',
  TITO_OUT: 'TITO out',
  CASHLESS_IN: 'CASHLESS in',
  CASHLESS_OUT: 'CASHLESS out',
  JACKPOT: 'HANDPAY (jackpot)',
  CREDIT_METER: 'MACHINE CREDIT meter',
};

/** Human text for a reconciliation item key (`machine_event:<id>`, `ticket:<id>`, `meters:<machine>:<type>` ...). */
export function describeItem(key: string, assetOf: (machineId: string) => string | undefined = () => undefined): string {
  const [kind, id, extra] = key.split(':');
  const short = (v: string) => (v && v.length > 12 ? `${v.slice(0, 8)}…` : v);
  switch (kind) {
    case 'machine_event': return `Machine event ${short(id)}`;
    case 'ticket_event': return `TITO event ${short(id)}`;
    case 'deferred_event': return `Deferred event ${short(id)}`;
    case 'meters': return `Meters ≠ ledger: ${assetOf(id) ?? short(id)} ${MACHINE_MONEY_LABEL[extra] ?? extra}`;
    case 'floor_clearing': return `Floor clearing ${assetOf(id) ?? short(id)}`;
    case 'ticket': return `TITO ticket ${short(id)}`;
    case 'handpay': return `Handpay ${short(id)}`;
    case 'wallet': return `CASHLESS wallet ${short(id)}`;
    case 'transfer': return `CASHLESS transfer ${short(id)}`;
    case 'collection': return `Machine collection ${short(id)}`;
    case 'jackpot_event': return `Jackpot event ${short(id)}`;
    case 'cash_tx': return `Drawer row ${short(id)}`;
    case 'money_tx': return `Ledger transaction ${short(id)}`;
    case 'movement': return `Vault movement ${short(id)}`;
    case 'count': return `Count ${short(id)}`;
    case 'session': return `Cashier shift ${short(id)}`;
    case 'ledger': return 'Ledger invariants';
    default: return key;
  }
}

/** Drawer rows (legacy projection of the ledger) in business terms. */
export const CASH_TX_LABEL_LEDGER: Record<string, string> = {
  CASH_IN: 'CASH in', CASH_OUT: 'CASH out', TICKET_PAYOUT: 'TITO paid', TICKET_ISSUE: 'TITO sold',
  HANDPAY: 'HANDPAY paid', FILL: 'Fill from vault', DROP: 'Drop to vault', ADJUSTMENT: 'Short / over',
};

/** Machine event types for operator screens; legacy protocol names never reach the operator. */
export const MACHINE_EVENT_LABEL: Record<string, string> = {
  ...MACHINE_MONEY_LABEL,
  COIN_IN: 'CASH in', COIN_OUT: 'CASH out (hopper)', TICKET_IN: 'TITO in', TICKET_OUT: 'TITO out', BILL_IN: 'CASH in',
  GAME_PLAYED: 'Game played', JACKPOT_RESET: 'HANDPAY reset',
};
export const eventLabel = (type: string) => MACHINE_EVENT_LABEL[type] ?? type.replace(/_/g, ' ').replace(/\bCOIN\b/g, 'CASH');
