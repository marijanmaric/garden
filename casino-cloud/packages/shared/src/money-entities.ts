/**
 * Money domain entities: states and allowed transitions. Business rules, not legal assumptions:
 * one central definition, enforced by the API services and mirrored by database triggers.
 */
import type { TicketStatus } from './cash';
import { playerCan, type PlayerCapability, type PlayerStatus } from './player';

function transitions<S extends string>(map: Record<S, readonly S[]>) {
  return { map, can: (from: S, to: S) => map[from]?.includes(to) ?? false };
}

// ---- Wallet ---------------------------------------------------------------------------------
export const WALLET_STATUSES = ['ACTIVE', 'BLOCKED', 'CLOSED'] as const;
export type WalletStatus = (typeof WALLET_STATUSES)[number];
export const WALLET_TRANSITIONS = transitions<WalletStatus>({ ACTIVE: ['BLOCKED', 'CLOSED'], BLOCKED: ['ACTIVE', 'CLOSED'], CLOSED: [] });

/** Wallet operations. The effective rule is: player capability AND wallet state allow it. */
export const WALLET_OPERATIONS = ['DEPOSIT', 'WITHDRAW', 'TO_MACHINE', 'FROM_MACHINE'] as const;
export type WalletOperation = (typeof WALLET_OPERATIONS)[number];

/**
 * ACTIVE   everything.
 * BLOCKED  only machine -> wallet, so credits on a machine are never stranded.
 * CLOSED   nothing (closing requires zero balances and no open transfers/sessions).
 */
export const WALLET_STATUS_OPERATIONS: Record<WalletStatus, readonly WalletOperation[]> = {
  ACTIVE: WALLET_OPERATIONS,
  BLOCKED: ['FROM_MACHINE'],
  CLOSED: [],
};

const OPERATION_CAPABILITY: Record<WalletOperation, PlayerCapability> = {
  DEPOSIT: 'WALLET_DEPOSIT',
  WITHDRAW: 'WALLET_WITHDRAW',
  TO_MACHINE: 'CASHLESS_TO_MACHINE',
  FROM_MACHINE: 'CASHLESS_FROM_MACHINE',
};

/** null if allowed, otherwise the reason. */
export function walletOperationBlocked(op: WalletOperation, player: PlayerStatus, wallet: WalletStatus): string | null {
  if (!WALLET_STATUS_OPERATIONS[wallet].includes(op)) return `Wallet status ${wallet} does not allow ${op}`;
  if (!playerCan(player, OPERATION_CAPABILITY[op])) return `Player status ${player} does not allow ${OPERATION_CAPABILITY[op]}`;
  return null;
}

// ---- Cashless session -------------------------------------------------------------------------
export const CASHLESS_SESSION_STATUSES = ['OPEN', 'CLOSED'] as const;
export type CashlessSessionStatus = (typeof CASHLESS_SESSION_STATUSES)[number];

// ---- Wallet transfer -------------------------------------------------------------------------
export const TRANSFER_DIRECTIONS = ['TO_MACHINE', 'FROM_MACHINE'] as const;
export type TransferDirection = (typeof TRANSFER_DIRECTIONS)[number];
export const TRANSFER_STATUSES = ['REQUESTED', 'SENT', 'CONFIRMED', 'FAILED', 'EXPIRED', 'LATE_CONFIRMED'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];
/**
 * REQUESTED is never a completed money movement: only CONFIRMED moves money to/from the machine.
 * LATE_CONFIRMED (Step 7d): the machine confirmed after the transfer had failed / expired (reservation
 * already released): booked as an exception, never silently as a normal transfer.
 */
export const TRANSFER_TRANSITIONS = transitions<TransferStatus>({
  REQUESTED: ['SENT', 'FAILED', 'EXPIRED'],
  SENT: ['CONFIRMED', 'FAILED', 'EXPIRED'],
  CONFIRMED: [],
  FAILED: ['LATE_CONFIRMED'],
  EXPIRED: ['LATE_CONFIRMED'],
  LATE_CONFIRMED: [],
});
export const ACTIVE_TRANSFER_STATUSES: readonly TransferStatus[] = ['REQUESTED', 'SENT'];

// ---- Handpay ---------------------------------------------------------------------------------
export const HANDPAY_KINDS = ['JACKPOT', 'CANCEL_CREDIT'] as const;
export type HandpayKind = (typeof HANDPAY_KINDS)[number];
export const HANDPAY_STATUSES = ['PENDING', 'APPROVED', 'PAID', 'MACHINE_RESET', 'VOIDED'] as const;
export type HandpayStatus = (typeof HANDPAY_STATUSES)[number];
/** Payment (PAID) never waits for the machine; MACHINE_RESET follows when the reset is confirmed. */
export const HANDPAY_TRANSITIONS = transitions<HandpayStatus>({
  PENDING: ['APPROVED', 'VOIDED'],
  APPROVED: ['PAID', 'VOIDED'],
  PAID: ['MACHINE_RESET'],
  MACHINE_RESET: [],
  VOIDED: [],
});
export const UNPAID_HANDPAY_STATUSES: readonly HandpayStatus[] = ['PENDING', 'APPROVED'];

// ---- TITO tickets (Step 7c) ----------------------------------------------------------------------
/**
 * VALID <-> HELD moves no money (a hold is a reservation for one machine or cashier, released on
 * reject / timeout). REDEEMED, EXPIRED, CANCELLED and VOID are final. HELD tickets never expire.
 */
export const TICKET_TRANSITIONS = transitions<TicketStatus>({
  VALID: ['HELD', 'REDEEMED', 'EXPIRED', 'CANCELLED', 'VOID'],
  HELD: ['VALID', 'REDEEMED'],
  REDEEMED: [],
  EXPIRED: [],
  CANCELLED: [],
  VOID: [],
});

// ---- Vault / cash counts / approvals ----------------------------------------------------------
export const VAULT_SESSION_STATUSES = ['OPEN', 'COUNTING', 'CLOSED'] as const;
export type VaultSessionStatus = (typeof VAULT_SESSION_STATUSES)[number];
export const VAULT_SESSION_TRANSITIONS = transitions<VaultSessionStatus>({ OPEN: ['COUNTING'], COUNTING: ['OPEN', 'CLOSED'], CLOSED: [] });

export const CASH_COUNT_CONTEXTS = ['VAULT_OPEN', 'VAULT_CLOSE', 'DRAWER_CLOSE', 'MACHINE_DROP', 'VAULT_CUTOVER', 'DRAWER_CUTOVER'] as const;
export type CashCountContext = (typeof CASH_COUNT_CONTEXTS)[number];

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const APPROVAL_TRANSITIONS = transitions<ApprovalStatus>({
  PENDING: ['APPROVED', 'REJECTED', 'EXPIRED'],
  APPROVED: ['EXECUTED', 'EXPIRED'],
  REJECTED: [],
  EXPIRED: [],
  EXECUTED: [],
});

/** Denominations as { "<value in cents>": count }. Returns the total in cents. */
export function denominationTotal(denominations: Record<string, number>): number {
  let total = 0;
  for (const [value, count] of Object.entries(denominations)) {
    const v = Number(value);
    if (!Number.isSafeInteger(v) || v <= 0 || !Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid denomination ${value}: ${count}`);
    total += v * count;
  }
  if (!Number.isSafeInteger(total)) throw new Error('Count total out of range');
  return total;
}
