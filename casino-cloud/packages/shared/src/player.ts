/**
 * Player identity domain. Separate from money, gaming and loyalty: other domains reference
 * players only by player_id (and card_id for the card that was presented).
 */

export const PLAYER_STATUSES = ['ACTIVE', 'SUSPENDED', 'EXCLUDED', 'CLOSED'] as const;
export type PlayerStatus = (typeof PLAYER_STATUSES)[number];

export const CARD_STATUSES = ['ACTIVE', 'BLOCKED', 'LOST', 'REPLACED', 'EXPIRED'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const CARD_TYPES = ['MAGSTRIPE', 'RFID', 'QR', 'VIRTUAL'] as const;
export type CardType = (typeof CARD_TYPES)[number];

/** Cached on the player; the full history is in player_verifications. */
export const VERIFICATION_STATUSES = ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Decisions recorded in player_verifications (UNVERIFIED is only the initial state). */
export const VERIFICATION_DECISIONS = ['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED'] as const;
export type VerificationDecision = (typeof VERIFICATION_DECISIONS)[number];

export const PLAYER_CAPABILITIES = [
  'CARD_LOGIN', // carded play at a machine (player tracking session)
  'CARD_ISSUE', // issue or replace a card
  'WALLET_DEPOSIT', // money into the wallet
  'WALLET_WITHDRAW', // money out of the wallet
  'CASHLESS_TO_MACHINE', // wallet -> machine
  'CASHLESS_FROM_MACHINE', // machine -> wallet
  'HANDPAY_TO_WALLET', // handpay paid into the wallet instead of cash
  'CASH_ADVANCE', // cash advance in the player's name
  'PROFILE_UPDATE', // staff edits the player's profile
] as const;
export type PlayerCapability = (typeof PLAYER_CAPABILITIES)[number];

/**
 * Status restrictions. This table is the single definition used by the backend.
 *
 * ACTIVE     everything allowed.
 * SUSPENDED  temporary hold pending review: account frozen. No card login, no money in or out
 *            of the wallet, no new cards. Only machine -> wallet stays possible so credits are
 *            never stranded on a machine. Profile can be maintained.
 * EXCLUDED   (self or operator exclusion): no card login, no money into the wallet, no transfers
 *            to machines, no handpay to wallet, no cash advance, no new cards. The player can still
 *            withdraw the existing wallet balance and machine -> wallet stays possible.
 * CLOSED     terminal. No financial activity of any kind and no changes.
 */
export const STATUS_CAPABILITIES: Record<PlayerStatus, readonly PlayerCapability[]> = {
  ACTIVE: PLAYER_CAPABILITIES,
  SUSPENDED: ['CASHLESS_FROM_MACHINE', 'PROFILE_UPDATE'],
  EXCLUDED: ['WALLET_WITHDRAW', 'CASHLESS_FROM_MACHINE', 'PROFILE_UPDATE'],
  CLOSED: [],
};

export function playerCan(status: PlayerStatus, capability: PlayerCapability): boolean {
  return STATUS_CAPABILITIES[status]?.includes(capability) ?? false;
}

/** Allowed player status changes. CLOSED is terminal. */
export const PLAYER_STATUS_TRANSITIONS: Record<PlayerStatus, readonly PlayerStatus[]> = {
  ACTIVE: ['SUSPENDED', 'EXCLUDED', 'CLOSED'],
  SUSPENDED: ['ACTIVE', 'EXCLUDED', 'CLOSED'],
  EXCLUDED: ['ACTIVE', 'CLOSED'],
  CLOSED: [],
};

/**
 * Allowed card status changes. Only ACTIVE cards can be used. LOST, REPLACED and EXPIRED are
 * terminal (a lost card can still get a replacement link). Card status never touches money.
 */
export const CARD_STATUS_TRANSITIONS: Record<CardStatus, readonly CardStatus[]> = {
  ACTIVE: ['BLOCKED', 'LOST', 'REPLACED', 'EXPIRED'],
  BLOCKED: ['ACTIVE', 'LOST', 'REPLACED', 'EXPIRED'],
  LOST: [],
  REPLACED: [],
  EXPIRED: [],
};

export function canTransitionPlayer(from: PlayerStatus, to: PlayerStatus): boolean {
  return PLAYER_STATUS_TRANSITIONS[from].includes(to);
}

export function canTransitionCard(from: CardStatus, to: CardStatus): boolean {
  return CARD_STATUS_TRANSITIONS[from].includes(to);
}

export type CardRejection = 'UNKNOWN_CARD' | 'CARD_BLOCKED' | 'CARD_LOST' | 'CARD_REPLACED' | 'CARD_EXPIRED';

/** Whether a card can be used right now. Only ACTIVE, non-expired cards are usable. */
export function cardUsability(card: { status: CardStatus; expires_at?: string | Date | null }, now = new Date()): CardRejection | null {
  if (card.status !== 'ACTIVE') return `CARD_${card.status}` as CardRejection;
  if (card.expires_at && new Date(card.expires_at) <= now) return 'CARD_EXPIRED';
  return null;
}

/**
 * Masks a document number for display/storage: keeps the last 4 characters.
 * The full number is never stored; a keyed hash is stored for matching (see API identity service).
 */
export function maskDocumentNumber(value: string): string {
  const v = value.replace(/\s+/g, '');
  if (v.length <= 4) return '*'.repeat(v.length);
  return `${'*'.repeat(v.length - 4)}${v.slice(-4)}`;
}

/**
 * Verification (KYC) threshold concept. The threshold is a configurable setting per organisation;
 * no amount is built in. null = no threshold configured, so no verification is required by it.
 * Whether a threshold is legally required, and at which amount, is decided per jurisdiction.
 */
export function verificationRequired(amountCents: number, thresholdCents: number | null | undefined): boolean {
  return thresholdCents !== null && thresholdCents !== undefined && amountCents >= thresholdCents;
}
