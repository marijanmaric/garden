import type { PlayerCapability } from '../player';
import { ACCOUNT_KINDS, type AccountKind, type AccountRef, accountKey } from './accounts';
import { MoneyError, cents, negate, type Cents } from './cents';

/**
 * Canonical money rails. Gaming (bets, wins, games) is NOT a money rail: gaming only reaches the
 * ledger through GAMING_SETTLEMENT, which compares MACHINE_CREDIT with the reported credit meter.
 */
export const MONEY_RAILS = ['CASH', 'TITO', 'CASHLESS', 'HANDPAY', 'MACHINE_CREDIT', 'VAULT', 'ADMIN'] as const;
export type MoneyRail = (typeof MONEY_RAILS)[number];

/** Canonical money transaction types (see MONEY_TRANSACTIONS for the full matrix). */
export const MONEY_TRANSACTION_TYPES = [
  'CASH_DEPOSIT', 'CASH_WITHDRAWAL',
  'WALLET_TO_MACHINE_RESERVE', 'WALLET_TO_MACHINE_CONFIRM', 'WALLET_TO_MACHINE_RELEASE', 'WALLET_TO_MACHINE_LATE_CONFIRM', 'MACHINE_TO_WALLET',
  'MACHINE_CASH_IN', 'MACHINE_CASH_OUT', 'HOPPER_FILL',
  'TITO_ISSUE_MACHINE', 'TITO_ISSUE_CASHIER', 'TITO_REDEEM_CASHIER', 'TITO_REDEEM_MACHINE', 'TITO_EXCEPTION', 'TITO_EXPIRY', 'TITO_CANCEL',
  'HANDPAY_CREATE_JACKPOT', 'HANDPAY_CREATE_CANCEL_CREDIT', 'HANDPAY_PAY',
  'VAULT_FILL', 'VAULT_DROP', 'DRAWER_SHORT_OVER', 'MACHINE_DROP', 'MACHINE_DROP_DIFFERENCE', 'VAULT_COUNT_DIFFERENCE',
  'PETTY_CASH', 'CASH_ADVANCE', 'BANK_DELIVERY', 'BANK_DEPOSIT',
  'GAMING_SETTLEMENT', 'ADJUSTMENT', 'OPENING_BALANCE', 'REVERSAL',
] as const;
export type MoneyTransactionType = (typeof MONEY_TRANSACTION_TYPES)[number];

/** References a transaction may need. player/wallet/card are context only; a card is never an account. */
export type MoneyRef = 'player' | 'wallet' | 'card' | 'machine' | 'cashierSession' | 'vault' | 'ticket' | 'handpay' | 'transfer';

export type ApprovalRule =
  | { kind: 'NONE' }
  | { kind: 'LIMIT'; setting: string } // supervisor approval above a configurable limit
  | { kind: 'CONFIRMATION' } // receiving person confirms a physical handover
  | { kind: 'FOUR_EYES' }; // always a second, different person

/** Where the idempotency of a transaction comes from. */
export type IdempotencySource =
  | 'CLIENT_KEY' // Idempotency-Key of the operator action
  | 'GATEWAY_EVENT' // machine event id from the gateway
  | 'ENTITY' // state of the domain entity (ticket, handpay, transfer, session, drop)
  | 'SYSTEM'; // background job keyed by entity id

export type ReversalRule =
  | { kind: 'REVERSAL' } // counter-transaction referencing the original
  | { kind: 'VIA'; type: MoneyTransactionType } // undone by another transaction type
  | { kind: 'ADJUSTMENT_ONLY' } // only a 4-eyes adjustment can correct it
  | { kind: 'NONE' };

export interface MoneyTransactionDef {
  rail: MoneyRail;
  label: string;
  requires: MoneyRef[];
  optional?: MoneyRef[];
  /** Amount may be negative (difference / settlement types). */
  signed?: boolean;
  approval: ApprovalRule;
  /** Configurable setting name of the verification (KYC) threshold that applies, if any. */
  verificationThreshold?: string;
  idempotency: IdempotencySource;
  reversal: ReversalRule;
}

const NONE: ApprovalRule = { kind: 'NONE' };

export const MONEY_TRANSACTIONS: Record<MoneyTransactionType, MoneyTransactionDef> = {
  // ---- CASHLESS / WALLET ----
  CASH_DEPOSIT: { rail: 'CASHLESS', label: 'Cash deposit to wallet', requires: ['player', 'wallet', 'cashierSession'], optional: ['card'], approval: { kind: 'LIMIT', setting: 'deposit_approval_cents' }, verificationThreshold: 'verification_threshold_cents', idempotency: 'CLIENT_KEY', reversal: { kind: 'REVERSAL' } },
  CASH_WITHDRAWAL: { rail: 'CASHLESS', label: 'Cash withdrawal from wallet', requires: ['player', 'wallet', 'cashierSession'], optional: ['card'], approval: { kind: 'LIMIT', setting: 'withdrawal_approval_cents' }, verificationThreshold: 'verification_threshold_cents', idempotency: 'CLIENT_KEY', reversal: { kind: 'REVERSAL' } },
  WALLET_TO_MACHINE_RESERVE: { rail: 'CASHLESS', label: 'Wallet to machine (reserve)', requires: ['player', 'wallet', 'machine', 'transfer'], optional: ['card'], approval: NONE, idempotency: 'ENTITY', reversal: { kind: 'VIA', type: 'WALLET_TO_MACHINE_RELEASE' } },
  WALLET_TO_MACHINE_CONFIRM: { rail: 'CASHLESS', label: 'Wallet to machine (confirmed)', requires: ['player', 'wallet', 'machine', 'transfer'], optional: ['card'], approval: NONE, idempotency: 'GATEWAY_EVENT', reversal: { kind: 'VIA', type: 'MACHINE_TO_WALLET' } },
  WALLET_TO_MACHINE_RELEASE: { rail: 'CASHLESS', label: 'Wallet to machine (released)', requires: ['player', 'wallet', 'machine', 'transfer'], optional: ['card'], approval: NONE, idempotency: 'ENTITY', reversal: { kind: 'NONE' } },
  WALLET_TO_MACHINE_LATE_CONFIRM: { rail: 'CASHLESS', label: 'Wallet to machine confirmed after expiry', requires: ['player', 'wallet', 'machine', 'transfer'], optional: ['card'], approval: NONE, idempotency: 'GATEWAY_EVENT', reversal: { kind: 'ADJUSTMENT_ONLY' } },
  MACHINE_TO_WALLET: { rail: 'CASHLESS', label: 'Machine to wallet', requires: ['player', 'wallet', 'machine'], optional: ['card', 'transfer'], approval: NONE, idempotency: 'GATEWAY_EVENT', reversal: { kind: 'ADJUSTMENT_ONLY' } },
  // ---- CASH at the machine ----
  MACHINE_CASH_IN: { rail: 'CASH', label: 'Cash in at machine', requires: ['machine'], optional: ['player', 'card'], approval: NONE, idempotency: 'GATEWAY_EVENT', reversal: { kind: 'ADJUSTMENT_ONLY' } },
  MACHINE_CASH_OUT: { rail: 'CASH', label: 'Cash out at machine (hopper)', requires: ['machine'], optional: ['player', 'card'], approval: NONE, idempotency: 'GATEWAY_EVENT', reversal: { kind: 'ADJUSTMENT_ONLY' } },
  HOPPER_FILL: { rail: 'VAULT', label: 'Hopper fill from vault', requires: ['machine', 'vault'], approval: { kind: 'CONFIRMATION' }, idempotency: 'CLIENT_KEY', reversal: { kind: 'ADJUSTMENT_ONLY' } },
  // ---- TITO ----
  TITO_ISSUE_MACHINE: { rail: 'TITO', label: 'Ticket printed by machine', requires: ['machine', 'ticket'], optional: ['player', 'card'], approval: NONE, idempotency: 'GATEWAY_EVENT', reversal: { kind: 'VIA', type: 'TITO_CANCEL' } },
  TITO_ISSUE_CASHIER: { rail: 'TITO', label: 'Ticket sold at cashier', requires: ['cashierSession', 'ticket'], optional: ['player', 'wallet', 'card'], approval: NONE, idempotency: 'CLIENT_KEY', reversal: { kind: 'REVERSAL' } },
  TITO_REDEEM_CASHIER: { rail: 'TITO', label: 'Ticket paid at cashier', requires: ['cashierSession', 'ticket'], optional: ['player', 'wallet', 'card'], approval: { kind: 'LIMIT', setting: 'ticket_payout_approval_cents' }, idempotency: 'ENTITY', reversal: { kind: 'REVERSAL' } },
  TITO_REDEEM_MACHINE: { rail: 'TITO', label: 'Ticket accepted by machine', requires: ['machine', 'ticket'], optional: ['player', 'card'], approval: NONE, idempotency: 'ENTITY', reversal: { kind: 'NONE' } },
  TITO_EXCEPTION: { rail: 'TITO', label: 'Ticket accepted without valid commit', requires: ['machine'], optional: ['ticket'], approval: NONE, idempotency: 'GATEWAY_EVENT', reversal: { kind: 'ADJUSTMENT_ONLY' } },
  TITO_EXPIRY: { rail: 'TITO', label: 'Ticket expired', requires: ['ticket'], approval: NONE, idempotency: 'SYSTEM', reversal: { kind: 'REVERSAL' } },
  TITO_CANCEL: { rail: 'TITO', label: 'Ticket cancelled by supervisor', requires: ['ticket'], optional: ['machine'], approval: { kind: 'FOUR_EYES' }, idempotency: 'CLIENT_KEY', reversal: { kind: 'REVERSAL' } },
  // ---- HANDPAY ----
  HANDPAY_CREATE_JACKPOT: { rail: 'HANDPAY', label: 'Jackpot handpay created', requires: ['machine', 'handpay'], optional: ['player', 'card'], approval: NONE, idempotency: 'GATEWAY_EVENT', reversal: { kind: 'REVERSAL' } },
  HANDPAY_CREATE_CANCEL_CREDIT: { rail: 'HANDPAY', label: 'Cancel-credit handpay created', requires: ['machine', 'handpay'], optional: ['player', 'card'], approval: NONE, idempotency: 'GATEWAY_EVENT', reversal: { kind: 'REVERSAL' } },
  HANDPAY_PAY: { rail: 'HANDPAY', label: 'Handpay paid', requires: ['machine', 'handpay'], optional: ['player', 'wallet', 'card', 'cashierSession'], approval: { kind: 'LIMIT', setting: 'handpay_approval_cents' }, verificationThreshold: 'verification_threshold_cents', idempotency: 'ENTITY', reversal: { kind: 'ADJUSTMENT_ONLY' } },
  // ---- CASHIER / VAULT ----
  VAULT_FILL: { rail: 'VAULT', label: 'Fill from vault to drawer', requires: ['cashierSession', 'vault'], approval: { kind: 'CONFIRMATION' }, idempotency: 'CLIENT_KEY', reversal: { kind: 'VIA', type: 'VAULT_DROP' } },
  VAULT_DROP: { rail: 'VAULT', label: 'Drop from drawer to vault', requires: ['cashierSession', 'vault'], approval: { kind: 'CONFIRMATION' }, idempotency: 'CLIENT_KEY', reversal: { kind: 'VIA', type: 'VAULT_FILL' } },
  DRAWER_SHORT_OVER: { rail: 'CASH', label: 'Drawer count difference', requires: ['cashierSession'], signed: true, approval: { kind: 'LIMIT', setting: 'short_over_approval_cents' }, idempotency: 'ENTITY', reversal: { kind: 'ADJUSTMENT_ONLY' } },
  MACHINE_DROP: { rail: 'VAULT', label: 'Machine drop counted into vault', requires: ['machine', 'vault'], approval: NONE, idempotency: 'ENTITY', reversal: { kind: 'ADJUSTMENT_ONLY' } },
  MACHINE_DROP_DIFFERENCE: { rail: 'VAULT', label: 'Machine drop count difference', requires: ['machine', 'vault'], signed: true, approval: { kind: 'LIMIT', setting: 'short_over_approval_cents' }, idempotency: 'ENTITY', reversal: { kind: 'ADJUSTMENT_ONLY' } },
  VAULT_COUNT_DIFFERENCE: { rail: 'VAULT', label: 'Vault count difference', requires: ['vault'], signed: true, approval: { kind: 'FOUR_EYES' }, idempotency: 'ENTITY', reversal: { kind: 'ADJUSTMENT_ONLY' } },
  PETTY_CASH: { rail: 'CASH', label: 'Petty cash expense', requires: [], optional: ['vault', 'cashierSession'], approval: { kind: 'LIMIT', setting: 'petty_cash_approval_cents' }, idempotency: 'CLIENT_KEY', reversal: { kind: 'REVERSAL' } },
  CASH_ADVANCE: { rail: 'CASH', label: 'Cash advance (card payment)', requires: ['player'], optional: ['wallet', 'card', 'cashierSession'], approval: { kind: 'LIMIT', setting: 'cash_advance_approval_cents' }, verificationThreshold: 'verification_threshold_cents', idempotency: 'CLIENT_KEY', reversal: { kind: 'REVERSAL' } },
  BANK_DELIVERY: { rail: 'VAULT', label: 'Cash delivered from bank', requires: ['vault'], approval: { kind: 'FOUR_EYES' }, idempotency: 'CLIENT_KEY', reversal: { kind: 'REVERSAL' } },
  BANK_DEPOSIT: { rail: 'VAULT', label: 'Cash deposited to bank', requires: ['vault'], approval: { kind: 'FOUR_EYES' }, idempotency: 'CLIENT_KEY', reversal: { kind: 'REVERSAL' } },
  // ---- bridge / admin ----
  GAMING_SETTLEMENT: { rail: 'MACHINE_CREDIT', label: 'Gaming settlement (credit meter vs. money in/out)', requires: ['machine'], signed: true, approval: NONE, idempotency: 'SYSTEM', reversal: { kind: 'NONE' } },
  ADJUSTMENT: { rail: 'ADMIN', label: 'Adjustment', requires: [], optional: ['player', 'wallet', 'card', 'machine', 'cashierSession', 'vault', 'ticket', 'handpay'], approval: { kind: 'FOUR_EYES' }, idempotency: 'CLIENT_KEY', reversal: { kind: 'VIA', type: 'ADJUSTMENT' } },
  OPENING_BALANCE: { rail: 'ADMIN', label: 'Opening balance (rail cutover)', requires: [], optional: ['machine', 'cashierSession', 'vault', 'wallet', 'ticket', 'handpay'], approval: NONE, idempotency: 'SYSTEM', reversal: { kind: 'NONE' } },
  REVERSAL: { rail: 'ADMIN', label: 'Reversal', requires: [], approval: { kind: 'LIMIT', setting: 'reversal_approval_cents' }, idempotency: 'CLIENT_KEY', reversal: { kind: 'NONE' } },
};

/** Kinds that an ADJUSTMENT may touch. Income from gaming and opening equity are never adjusted directly. */
export const ADJUSTABLE_KINDS: AccountKind[] = [
  'DRAWER', 'VAULT', 'CASHBOX', 'HOPPER', 'WALLET_AVAILABLE', 'TICKET_LIABILITY', 'HANDPAY_PAYABLE', 'MACHINE_CREDIT',
  'CASH_SHORT_OVER', 'DROP_SHORT_OVER', 'VAULT_SHORT_OVER', 'TITO_ADJUSTMENT', 'TITO_EXCEPTION', 'CASHLESS_EXCEPTION', 'LEGACY_FLOOR_CLEARING',
  'CARD_SETTLEMENT_RECEIVABLE', 'BANK_CLEARING',
];

/**
 * Context of a money transaction. playerId, walletId and cardId are references only:
 * the ledger never needs player profile data, and a card is never an account.
 */
export interface MoneyContext {
  casinoId: string;
  amountCents: Cents;
  playerId?: string;
  walletId?: string;
  cardId?: string;
  machineId?: string;
  cashierSessionId?: string;
  vaultId?: string;
  ticketId?: string;
  handpayId?: string;
  transferId?: string;
  /** HANDPAY_PAY, TITO_REDEEM_CASHIER, CASH_ADVANCE: pay out in cash (default) or into the wallet. */
  payTo?: 'CASH' | 'WALLET';
  /** TITO_ISSUE_CASHIER: paid with cash (default) or from the wallet. */
  payFrom?: 'CASH' | 'WALLET';
  /**
   * TITO_ISSUE_MACHINE / TITO_REDEEM_MACHINE / TITO_EXCEPTION on a machine whose MACHINE rail is still
   * LEGACY: the machine side is the machine's LEGACY_FLOOR_CLEARING account instead of MACHINE_CREDIT (D1).
   */
  floorClearing?: boolean;
  /** PETTY_CASH: taken from the vault (default) or a drawer. */
  source?: 'VAULT' | 'DRAWER';
  /** CASH_ADVANCE: fee charged on top of the amount handed out. */
  feeCents?: Cents;
  /** OPENING_BALANCE: the legacy record the opening is derived from (migration 006 cutover). */
  backfillSource?: BackfillSource;
  /** ADJUSTMENT / OPENING_BALANCE: explicit accounts. */
  debit?: AccountRef;
  credit?: AccountRef;
  /** REVERSAL: postings of the original transaction. */
  original?: Posting[];
}

/** Legacy source of an opening balance: one row of a legacy table, used at most once. */
export interface BackfillSource {
  table: 'cash_counts' | 'tickets' | 'handpays';
  id: string;
}

export interface Posting {
  account: AccountRef;
  /** Debit positive, credit negative. */
  amountCents: Cents;
}

const REF_FIELD: Record<MoneyRef, keyof MoneyContext> = {
  player: 'playerId', wallet: 'walletId', card: 'cardId', machine: 'machineId', cashierSession: 'cashierSessionId',
  vault: 'vaultId', ticket: 'ticketId', handpay: 'handpayId', transfer: 'transferId',
};

/**
 * Builds the balanced postings for a transaction. Pure function: no database, no side effects.
 * Throws MoneyError on missing references, invalid amounts or unbalanced results.
 */
export function postings(type: MoneyTransactionType, ctx: MoneyContext): Posting[] {
  const def = MONEY_TRANSACTIONS[type];
  if (!ctx.casinoId) throw new MoneyError(`${type}: casinoId required`);
  for (const ref of def.requires) if (!ctx[REF_FIELD[ref]]) throw new MoneyError(`${type}: ${ref} required`);
  const amount = cents(ctx.amountCents);
  if (def.signed ? amount === 0 : amount <= 0) throw new MoneyError(`${type}: amount must be ${def.signed ? 'non-zero' : 'positive'}`);

  const c = ctx.casinoId;
  const drawer = (): AccountRef => need({ kind: 'DRAWER', casinoId: c, cashierSessionId: ctx.cashierSessionId }, 'cashierSession');
  const vault = (): AccountRef => need({ kind: 'VAULT', casinoId: c, vaultId: ctx.vaultId }, 'vault');
  const wallet = (kind: 'WALLET_AVAILABLE' | 'WALLET_RESERVED' = 'WALLET_AVAILABLE'): AccountRef => need({ kind, walletId: ctx.walletId }, 'wallet');
  const machine = (kind: 'MACHINE_CREDIT' | 'CASHBOX' | 'HOPPER' | 'LEGACY_FLOOR_CLEARING'): AccountRef => need({ kind, casinoId: c, machineId: ctx.machineId }, 'machine');
  /** The machine side of a ticket: MACHINE_CREDIT, or the D1 clearing account of a LEGACY machine. */
  const ticketMachine = (): AccountRef => machine(ctx.floorClearing ? 'LEGACY_FLOOR_CLEARING' : 'MACHINE_CREDIT');
  const casino = (kind: AccountKind): AccountRef => ({ kind, casinoId: c });
  const cashOrWallet = (choice: 'CASH' | 'WALLET' | undefined) => (choice === 'WALLET' ? wallet() : drawer());

  function need(ref: AccountRef, what: MoneyRef): AccountRef {
    const field = REF_FIELD[what];
    if (!ctx[field]) throw new MoneyError(`${type}: ${what} required`);
    return ref;
  }

  /** One debit and one credit of the same amount. */
  const move = (debit: AccountRef, credit: AccountRef, value: Cents = amount): Posting[] => [
    { account: debit, amountCents: value },
    { account: credit, amountCents: negate(value) },
  ];
  /** Signed difference: positive amount debits `whenPositiveDebit`, negative swaps the sides. */
  const signedMove = (whenPositiveDebit: AccountRef, whenPositiveCredit: AccountRef): Posting[] =>
    amount > 0 ? move(whenPositiveDebit, whenPositiveCredit) : move(whenPositiveCredit, whenPositiveDebit, negate(amount));

  let result: Posting[];
  switch (type) {
    case 'CASH_DEPOSIT': result = move(drawer(), wallet()); break;
    case 'CASH_WITHDRAWAL': result = move(wallet(), drawer()); break;
    case 'WALLET_TO_MACHINE_RESERVE': result = move(wallet('WALLET_AVAILABLE'), wallet('WALLET_RESERVED')); break;
    case 'WALLET_TO_MACHINE_CONFIRM': result = move(wallet('WALLET_RESERVED'), machine('MACHINE_CREDIT')); break;
    case 'WALLET_TO_MACHINE_RELEASE': result = move(wallet('WALLET_RESERVED'), wallet('WALLET_AVAILABLE')); break;
    case 'WALLET_TO_MACHINE_LATE_CONFIRM': result = move({ kind: 'CASHLESS_EXCEPTION' }, machine('MACHINE_CREDIT')); break;
    case 'MACHINE_TO_WALLET': result = move(machine('MACHINE_CREDIT'), wallet()); break;
    case 'MACHINE_CASH_IN': result = move(machine('CASHBOX'), machine('MACHINE_CREDIT')); break;
    case 'MACHINE_CASH_OUT': result = move(machine('MACHINE_CREDIT'), machine('HOPPER')); break;
    case 'HOPPER_FILL': result = move(machine('HOPPER'), vault()); break;
    case 'TITO_ISSUE_MACHINE': result = move(ticketMachine(), casino('TICKET_LIABILITY')); break;
    case 'TITO_ISSUE_CASHIER': result = move(cashOrWallet(ctx.payFrom), casino('TICKET_LIABILITY')); break;
    case 'TITO_REDEEM_CASHIER': result = move(casino('TICKET_LIABILITY'), cashOrWallet(ctx.payTo)); break;
    case 'TITO_REDEEM_MACHINE': result = move(casino('TICKET_LIABILITY'), ticketMachine()); break;
    case 'TITO_EXCEPTION': result = move(casino('TITO_EXCEPTION'), ticketMachine()); break;
    case 'TITO_EXPIRY': result = move(casino('TICKET_LIABILITY'), casino('EXPIRED_TICKET_INCOME')); break;
    case 'TITO_CANCEL': result = move(casino('TICKET_LIABILITY'), casino('TITO_ADJUSTMENT')); break;
    case 'HANDPAY_CREATE_JACKPOT': result = move(casino('GAMING_JACKPOT_EXPENSE'), casino('HANDPAY_PAYABLE')); break;
    case 'HANDPAY_CREATE_CANCEL_CREDIT': result = move(machine('MACHINE_CREDIT'), casino('HANDPAY_PAYABLE')); break;
    case 'HANDPAY_PAY': result = move(casino('HANDPAY_PAYABLE'), cashOrWallet(ctx.payTo)); break;
    case 'VAULT_FILL': result = move(drawer(), vault()); break;
    case 'VAULT_DROP': result = move(vault(), drawer()); break;
    // positive = over (more cash than expected), negative = short
    case 'DRAWER_SHORT_OVER': result = signedMove(drawer(), casino('CASH_SHORT_OVER')); break;
    case 'MACHINE_DROP': result = move(vault(), machine('CASHBOX')); break;
    // positive = counted more than the cashbox balance
    case 'MACHINE_DROP_DIFFERENCE': result = signedMove(machine('CASHBOX'), casino('DROP_SHORT_OVER')); break;
    case 'VAULT_COUNT_DIFFERENCE': result = signedMove(vault(), casino('VAULT_SHORT_OVER')); break;
    case 'PETTY_CASH': result = move(casino('PETTY_CASH_EXPENSE'), ctx.source === 'DRAWER' ? drawer() : vault()); break;
    case 'CASH_ADVANCE': {
      const fee = cents(ctx.feeCents ?? 0);
      if (fee < 0) throw new MoneyError('CASH_ADVANCE: fee must not be negative');
      const gross = cents(amount + fee);
      result = [
        { account: casino('CARD_SETTLEMENT_RECEIVABLE'), amountCents: gross },
        { account: cashOrWallet(ctx.payTo), amountCents: negate(amount) },
        ...(fee > 0 ? [{ account: casino('ADVANCE_FEE_INCOME'), amountCents: negate(fee) }] : []),
      ];
      break;
    }
    case 'BANK_DELIVERY': result = move(vault(), casino('BANK_CLEARING')); break;
    case 'BANK_DEPOSIT': result = move(casino('BANK_CLEARING'), vault()); break;
    // positive = MACHINE_CREDIT balance above the reported credit meter, i.e. players lost that amount
    case 'GAMING_SETTLEMENT': result = signedMove(machine('MACHINE_CREDIT'), casino('GAMING_RESULT')); break;
    case 'ADJUSTMENT': {
      const { debit, credit } = ctx;
      if (!debit || !credit) throw new MoneyError('ADJUSTMENT: debit and credit accounts required');
      for (const a of [debit, credit]) if (!ADJUSTABLE_KINDS.includes(a.kind)) throw new MoneyError(`ADJUSTMENT: ${a.kind} cannot be adjusted`);
      result = move(scoped(debit), scoped(credit));
      break;
    }
    case 'OPENING_BALANCE': {
      const { debit, credit } = ctx;
      if (!debit || !credit) throw new MoneyError('OPENING_BALANCE: debit and credit accounts required');
      if (debit.kind !== 'OPENING_EQUITY' && credit.kind !== 'OPENING_EQUITY') throw new MoneyError('OPENING_BALANCE: one side must be OPENING_EQUITY');
      if (!ctx.backfillSource?.table || !ctx.backfillSource.id) throw new MoneyError('OPENING_BALANCE: legacy source required');
      result = move(scoped(debit), scoped(credit));
      break;
    }
    case 'REVERSAL': {
      if (!ctx.original?.length) throw new MoneyError('REVERSAL: original postings required');
      result = ctx.original.map((p) => ({ account: p.account, amountCents: negate(p.amountCents) }));
      break;
    }
    default: {
      const never: never = type;
      throw new MoneyError(`Unknown transaction type ${never}`);
    }
  }

  assertBalanced(type, result);
  return result;

  /** Applies the scope rule to explicitly given accounts: casino id only on casino-scoped kinds. */
  function scoped(ref: AccountRef): AccountRef {
    return ACCOUNT_KINDS[ref.kind].scope === 'CASINO' ? { ...ref, casinoId: ref.casinoId ?? c } : { ...ref, casinoId: undefined };
  }
}

export function assertBalanced(type: string, list: Posting[]): void {
  if (list.length < 2) throw new MoneyError(`${type}: at least two postings required`);
  const sum = list.reduce((s, p) => s + p.amountCents, 0);
  if (sum !== 0) throw new MoneyError(`${type}: postings do not balance (${sum})`);
  for (const p of list) {
    if (p.amountCents === 0) throw new MoneyError(`${type}: zero posting`);
    const def = ACCOUNT_KINDS[p.account.kind];
    if (def.scope === 'ORG' && p.account.casinoId) throw new MoneyError(`${type}: ${p.account.kind} is organisation-level`);
    if (def.scope === 'CASINO' && !p.account.casinoId) throw new MoneyError(`${type}: ${p.account.kind} needs a casino`);
  }
  const keys = new Set(list.map((p) => accountKey(p.account)));
  if (keys.size < 2) throw new MoneyError(`${type}: debit and credit must be different accounts`);
}

/**
 * Player capability needed for a transaction, or null if the transaction does not depend on the
 * player's status (system steps such as confirm/release must always be able to complete).
 */
export function requiredCapability(type: MoneyTransactionType, ctx: Pick<MoneyContext, 'payTo' | 'payFrom'> = {}): PlayerCapability | null {
  switch (type) {
    case 'CASH_DEPOSIT': return 'WALLET_DEPOSIT';
    case 'CASH_WITHDRAWAL': return 'WALLET_WITHDRAW';
    case 'WALLET_TO_MACHINE_RESERVE': return 'CASHLESS_TO_MACHINE';
    case 'MACHINE_TO_WALLET': return 'CASHLESS_FROM_MACHINE';
    case 'HANDPAY_PAY': return ctx.payTo === 'WALLET' ? 'HANDPAY_TO_WALLET' : null;
    case 'TITO_REDEEM_CASHIER': return ctx.payTo === 'WALLET' ? 'WALLET_DEPOSIT' : null;
    case 'TITO_ISSUE_CASHIER': return ctx.payFrom === 'WALLET' ? 'WALLET_WITHDRAW' : null;
    case 'CASH_ADVANCE': return 'CASH_ADVANCE';
    default: return null;
  }
}
