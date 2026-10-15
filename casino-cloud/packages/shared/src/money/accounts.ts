/**
 * Ledger account model (double entry). Signed amounts: debit = positive, credit = negative.
 *
 * Scope rule: wallets belong to the ORGANISATION, so wallet accounts are organisation-level and
 * usable from every casino of the organisation. Physical money (drawers, vaults, machine cashboxes)
 * and casino liabilities (tickets, handpays, machine credits) are CASINO-level.
 *
 * Player cards are identifiers only: there is no card account kind, and there never will be.
 */
export const ACCOUNT_CLASSES = ['ASSET', 'LIABILITY', 'INCOME', 'EXPENSE', 'EQUITY'] as const;
export type AccountClass = (typeof ACCOUNT_CLASSES)[number];

export type AccountScope = 'ORG' | 'CASINO';
/** Which entity a per-entity account belongs to. */
export type AccountOwner = 'NONE' | 'MACHINE' | 'WALLET' | 'CASHIER_SESSION' | 'VAULT';

export interface AccountKindDef {
  class: AccountClass;
  scope: AccountScope;
  owner: AccountOwner;
  /** Whether the displayed balance may go below zero (enforced by the ledger in migration 004). */
  allowNegative: boolean;
  description: string;
}

export const ACCOUNT_KINDS = {
  // Physical money, per casino
  DRAWER: { class: 'ASSET', scope: 'CASINO', owner: 'CASHIER_SESSION', allowNegative: false, description: 'Cash in a cashier drawer (one per shift), 0 after close' },
  VAULT: { class: 'ASSET', scope: 'CASINO', owner: 'VAULT', allowNegative: false, description: 'Cash in a vault' },
  CASHBOX: { class: 'ASSET', scope: 'CASINO', owner: 'MACHINE', allowNegative: false, description: 'Bills in the machine stacker' },
  HOPPER: { class: 'ASSET', scope: 'CASINO', owner: 'MACHINE', allowNegative: false, description: 'Coins/cash in the machine hopper for cash payouts' },
  // External / suspense
  CARD_SETTLEMENT_RECEIVABLE: { class: 'ASSET', scope: 'CASINO', owner: 'NONE', allowNegative: true, description: 'Cash advance amounts due from the card processor' },
  BANK_CLEARING: { class: 'ASSET', scope: 'CASINO', owner: 'NONE', allowNegative: true, description: 'Cash in transit to or from the bank' },
  TITO_EXCEPTION: { class: 'ASSET', scope: 'CASINO', owner: 'NONE', allowNegative: true, description: 'Tickets accepted by a machine without a valid commit (under investigation)' },
  CASHLESS_EXCEPTION: { class: 'ASSET', scope: 'ORG', owner: 'NONE', allowNegative: true, description: 'Wallet transfers confirmed after expiry (under investigation)' },
  // Liabilities
  WALLET_AVAILABLE: { class: 'LIABILITY', scope: 'ORG', owner: 'WALLET', allowNegative: false, description: 'Player wallet, available balance' },
  WALLET_RESERVED: { class: 'LIABILITY', scope: 'ORG', owner: 'WALLET', allowNegative: false, description: 'Player wallet, reserved for transfers in progress' },
  TICKET_LIABILITY: { class: 'LIABILITY', scope: 'CASINO', owner: 'NONE', allowNegative: false, description: 'Outstanding TITO tickets' },
  HANDPAY_PAYABLE: { class: 'LIABILITY', scope: 'CASINO', owner: 'NONE', allowNegative: false, description: 'Handpays created but not yet paid' },
  MACHINE_CREDIT: { class: 'LIABILITY', scope: 'CASINO', owner: 'MACHINE', allowNegative: true, description: 'Credits put on a machine through money rails since the last gaming settlement' },
  // Income / expense / equity
  GAMING_RESULT: { class: 'INCOME', scope: 'CASINO', owner: 'NONE', allowNegative: true, description: 'Net gaming result from machine settlements' },
  EXPIRED_TICKET_INCOME: { class: 'INCOME', scope: 'CASINO', owner: 'NONE', allowNegative: true, description: 'Expired, unredeemed tickets' },
  ADVANCE_FEE_INCOME: { class: 'INCOME', scope: 'CASINO', owner: 'NONE', allowNegative: true, description: 'Cash advance fees' },
  GAMING_JACKPOT_EXPENSE: { class: 'EXPENSE', scope: 'CASINO', owner: 'NONE', allowNegative: true, description: 'Jackpots paid by handpay' },
  PETTY_CASH_EXPENSE: { class: 'EXPENSE', scope: 'CASINO', owner: 'NONE', allowNegative: true, description: 'Petty cash spending' },
  CASH_SHORT_OVER: { class: 'EXPENSE', scope: 'CASINO', owner: 'NONE', allowNegative: true, description: 'Drawer count differences' },
  DROP_SHORT_OVER: { class: 'EXPENSE', scope: 'CASINO', owner: 'NONE', allowNegative: true, description: 'Machine drop count differences' },
  VAULT_SHORT_OVER: { class: 'EXPENSE', scope: 'CASINO', owner: 'NONE', allowNegative: true, description: 'Vault count differences' },
  TITO_ADJUSTMENT: { class: 'EXPENSE', scope: 'CASINO', owner: 'NONE', allowNegative: true, description: 'Supervisor ticket cancellations' },
  OPENING_EQUITY: { class: 'EQUITY', scope: 'CASINO', owner: 'NONE', allowNegative: true, description: 'Starting balances from the migration backfill' },
} as const satisfies Record<string, AccountKindDef>;

export type AccountKind = keyof typeof ACCOUNT_KINDS;
export const ACCOUNT_KIND_KEYS = Object.keys(ACCOUNT_KINDS) as AccountKind[];

/** Identifies one ledger account. Casino id is only set for casino-scoped kinds. */
export interface AccountRef {
  kind: AccountKind;
  casinoId?: string;
  machineId?: string;
  walletId?: string;
  cashierSessionId?: string;
  vaultId?: string;
}

/** Stable key of an account, used for lock ordering and for summing postings per account. */
export function accountKey(ref: AccountRef): string {
  const def = ACCOUNT_KINDS[ref.kind];
  const owner =
    def.owner === 'MACHINE' ? ref.machineId : def.owner === 'WALLET' ? ref.walletId : def.owner === 'CASHIER_SESSION' ? ref.cashierSessionId : def.owner === 'VAULT' ? ref.vaultId : '';
  return [ref.kind, def.scope === 'CASINO' ? ref.casinoId : 'org', owner ?? ''].join(':');
}

/** Balance as shown to people: assets/expenses as summed, liabilities/income/equity sign-flipped. */
export function displayBalance(kind: AccountKind, signedSum: number): number {
  const cls = ACCOUNT_KINDS[kind].class;
  return cls === 'ASSET' || cls === 'EXPENSE' ? signedSum : -signedSum;
}
