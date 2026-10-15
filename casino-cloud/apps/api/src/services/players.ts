import { createHmac } from 'node:crypto';
import { writeAudit, type PoolClient } from '@m1/database';
import {
  canTransitionCard, canTransitionPlayer, cardUsability, maskDocumentNumber, playerCan,
  type CardRejection, type CardStatus, type CardType, type PlayerCapability, type PlayerStatus, type VerificationDecision,
} from '@m1/shared';
import { HttpError } from '../auth';
import { config } from '../config';

/**
 * Player identity service. player_cards is the only card lookup source; legacy
 * players.card_number is never read for lookups and never written.
 */

type Db = Pick<PoolClient, 'query'>;

export interface Actor {
  orgId: string;
  employeeId?: string | null;
  employeeEmail?: string | null;
  ip?: string | null;
}

export interface PlayerRow {
  id: string;
  org_id: string;
  player_no: string;
  status: PlayerStatus;
  verification_status: string;
}

export interface CardRow {
  id: string;
  org_id: string;
  player_id: string;
  card_number: string;
  card_type: CardType;
  status: CardStatus;
  expires_at: string | null;
  replaced_by_card_id: string | null;
}

export type CardResolution =
  | { ok: true; card: CardRow; player: PlayerRow }
  | { ok: false; reason: CardRejection; card?: CardRow; player?: PlayerRow };

const MESSAGES: Record<CardRejection, string> = {
  UNKNOWN_CARD: 'Unknown player card',
  CARD_BLOCKED: 'Player card is blocked',
  CARD_LOST: 'Player card was reported lost',
  CARD_REPLACED: 'Player card was replaced by a new card',
  CARD_EXPIRED: 'Player card has expired',
};

/** Resolves a card number to exactly one card and its player (unique per organisation). */
export async function resolveCard(db: Db, orgId: string, cardNumber: string): Promise<CardResolution> {
  const r = await db.query(
    `SELECT c.id, c.org_id, c.player_id, c.card_number, c.card_type, c.status, c.expires_at, c.replaced_by_card_id,
            p.player_no, p.status AS player_status, p.verification_status
     FROM player_cards c JOIN players p ON p.id = c.player_id
     WHERE c.org_id = $1 AND c.card_number = $2`,
    [orgId, cardNumber.trim()],
  );
  const row = r.rows[0];
  if (!row) return { ok: false, reason: 'UNKNOWN_CARD' };
  const card: CardRow = {
    id: row.id, org_id: row.org_id, player_id: row.player_id, card_number: row.card_number, card_type: row.card_type,
    status: row.status, expires_at: row.expires_at, replaced_by_card_id: row.replaced_by_card_id,
  };
  const player: PlayerRow = { id: row.player_id, org_id: row.org_id, player_no: row.player_no, status: row.player_status, verification_status: row.verification_status };
  const rejection = cardUsability(card);
  return rejection ? { ok: false, reason: rejection, card, player } : { ok: true, card, player };
}

/** Resolves a card that must be usable; throws 404/409 otherwise. Optionally checks a player capability. */
export async function requireUsableCard(db: Db, orgId: string, cardNumber: string, capability?: PlayerCapability) {
  const res = await resolveCard(db, orgId, cardNumber);
  if (!res.ok) throw new HttpError(res.reason === 'UNKNOWN_CARD' ? 404 : 409, MESSAGES[res.reason]);
  if (capability) assertCapability(res.player, capability);
  return res;
}

export function cardRejectionMessage(reason: CardRejection) {
  return MESSAGES[reason];
}

export function assertCapability(player: Pick<PlayerRow, 'status'>, capability: PlayerCapability) {
  if (!playerCan(player.status, capability)) throw new HttpError(409, `Player status ${player.status} does not allow ${capability}`);
}

async function lockPlayer(db: Db, orgId: string, playerId: string): Promise<PlayerRow> {
  const r = await db.query('SELECT id, org_id, player_no, status, verification_status FROM players WHERE id = $1 AND org_id = $2 FOR NO KEY UPDATE', [playerId, orgId]);
  if (!r.rowCount) throw new HttpError(404, 'Player not found');
  return r.rows[0];
}

async function lockCard(db: Db, orgId: string, cardId: string): Promise<CardRow> {
  const r = await db.query('SELECT * FROM player_cards WHERE id = $1 AND org_id = $2 FOR NO KEY UPDATE', [cardId, orgId]);
  if (!r.rowCount) throw new HttpError(404, 'Card not found');
  return r.rows[0];
}

function audit(db: Db, a: Actor, action: string, entityType: string, entityId: string, details: Record<string, unknown>) {
  // Only ids and statuses: no personal data in the audit trail.
  return writeAudit(db as PoolClient, {
    orgId: a.orgId, actorType: a.employeeId ? 'EMPLOYEE' : 'SYSTEM', actorId: a.employeeId ?? null, actorName: a.employeeEmail ?? 'system',
    action, entityType, entityId, details, ip: a.ip ?? null,
  });
}

export interface NewPlayer {
  homeCasinoId?: string | null;
  profile?: { firstName?: string; lastName?: string; birthDate?: string; email?: string; phone?: string; nationality?: string };
  card?: { cardNumber: string; cardType?: CardType; expiresAt?: string | null };
}

/** Registers a player: identity row, profile (personal data) and optionally a first card. */
export async function createPlayer(db: Db, a: Actor, input: NewPlayer) {
  const p = await db.query(
    `INSERT INTO players (org_id, home_casino_id) VALUES ($1,$2) RETURNING id, org_id, player_no, status, verification_status`,
    [a.orgId, input.homeCasinoId ?? null],
  );
  const player: PlayerRow = p.rows[0];
  const pr = input.profile ?? {};
  await db.query(
    `INSERT INTO player_profiles (player_id, org_id, first_name, last_name, birth_date, email, phone, nationality) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [player.id, a.orgId, pr.firstName ?? null, pr.lastName ?? null, pr.birthDate ?? null, pr.email ?? null, pr.phone ?? null, pr.nationality ?? null],
  );
  await db.query(`INSERT INTO player_status_history (org_id, player_id, from_status, to_status, reason, changed_by) VALUES ($1,$2,NULL,'ACTIVE','registered',$3)`, [
    a.orgId, player.id, a.employeeId ?? null,
  ]);
  await audit(db, a, 'player.registered', 'player', player.id, { playerNo: player.player_no });
  const card = input.card ? await issueCard(db, a, player.id, input.card) : null;
  return { player, card };
}

/** Issues a card. A player can hold at most one ACTIVE card; use replaceCard to swap cards. */
export async function issueCard(db: Db, a: Actor, playerId: string, input: { cardNumber: string; cardType?: CardType; expiresAt?: string | null }) {
  const player = await lockPlayer(db, a.orgId, playerId);
  assertCapability(player, 'CARD_ISSUE');
  const card = await insertCard(db, a, playerId, input);
  await db.query(`INSERT INTO player_card_events (org_id, card_id, player_id, action, employee_id) VALUES ($1,$2,$3,'ISSUED',$4)`, [a.orgId, card.id, playerId, a.employeeId ?? null]);
  await audit(db, a, 'player.card_issued', 'player_card', card.id, { playerId });
  return card;
}

async function insertCard(db: Db, a: Actor, playerId: string, input: { cardNumber: string; cardType?: CardType; expiresAt?: string | null }): Promise<CardRow> {
  const number = input.cardNumber.trim();
  if (!/^[A-Za-z0-9-]{4,40}$/.test(number)) throw new HttpError(400, 'Invalid card number');
  try {
    const r = await db.query(
      `INSERT INTO player_cards (org_id, player_id, card_number, card_type, expires_at, issued_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [a.orgId, playerId, number, input.cardType ?? 'MAGSTRIPE', input.expiresAt ?? null, a.employeeId ?? null],
    );
    return r.rows[0];
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505' && e.constraint === 'player_cards_org_card_number_key') throw new HttpError(409, 'Card number already in use');
    if (e.code === '23505' && e.constraint === 'player_cards_one_active_per_player') throw new HttpError(409, 'Player already has an active card');
    throw err;
  }
}

/** Changes a card's status (block, unblock, lost, expired). Never touches money. */
export async function setCardStatus(db: Db, a: Actor, cardId: string, to: Exclude<CardStatus, 'REPLACED'>, reason?: string) {
  const card = await lockCard(db, a.orgId, cardId);
  if (!canTransitionCard(card.status, to)) throw new HttpError(409, `Card cannot change from ${card.status} to ${to}`);
  if (to === 'ACTIVE') assertCapability(await lockPlayer(db, a.orgId, card.player_id), 'CARD_ISSUE');
  try {
    await db.query('UPDATE player_cards SET status = $2, status_reason = $3, status_changed_at = now() WHERE id = $1', [cardId, to, reason ?? null]);
  } catch (err) {
    if ((err as { constraint?: string }).constraint === 'player_cards_one_active_per_player') throw new HttpError(409, 'Player already has an active card');
    throw err;
  }
  const action = to === 'ACTIVE' ? 'UNBLOCKED' : to;
  await db.query(`INSERT INTO player_card_events (org_id, card_id, player_id, action, reason, employee_id) VALUES ($1,$2,$3,$4,$5,$6)`, [
    a.orgId, cardId, card.player_id, action, reason ?? null, a.employeeId ?? null,
  ]);
  await audit(db, a, `player.card_${action.toLowerCase()}`, 'player_card', cardId, { playerId: card.player_id, from: card.status, to });
  return { ...card, status: to };
}

/**
 * Replaces a card with a new one for the SAME player (and therefore the same wallet).
 * The old card becomes REPLACED (a LOST card stays LOST) and links to the new card.
 */
export async function replaceCard(db: Db, a: Actor, oldCardId: string, input: { cardNumber: string; cardType?: CardType; expiresAt?: string | null }, reason?: string) {
  const old = await lockCard(db, a.orgId, oldCardId);
  if (old.replaced_by_card_id) throw new HttpError(409, 'Card was already replaced');
  if (old.status !== 'LOST' && !canTransitionCard(old.status, 'REPLACED')) throw new HttpError(409, `Card in status ${old.status} cannot be replaced`);
  const player = await lockPlayer(db, a.orgId, old.player_id);
  assertCapability(player, 'CARD_ISSUE');
  const nextStatus: CardStatus = old.status === 'LOST' ? 'LOST' : 'REPLACED';
  // Retire the old card first so the "one active card per player" rule holds.
  await db.query('UPDATE player_cards SET status = $2, status_reason = COALESCE($3, status_reason), status_changed_at = now() WHERE id = $1', [oldCardId, nextStatus, reason ?? null]);
  const card = await insertCard(db, a, old.player_id, { cardType: input.cardType ?? old.card_type, ...input });
  await db.query('UPDATE player_cards SET replaced_by_card_id = $2 WHERE id = $1', [oldCardId, card.id]);
  await db.query(`INSERT INTO player_card_events (org_id, card_id, player_id, action, reason, employee_id, details) VALUES ($1,$2,$3,'REPLACED',$4,$5,$6)`, [
    a.orgId, oldCardId, old.player_id, reason ?? null, a.employeeId ?? null, { newCardId: card.id },
  ]);
  await db.query(`INSERT INTO player_card_events (org_id, card_id, player_id, action, employee_id, details) VALUES ($1,$2,$3,'ISSUED',$4,$5)`, [
    a.orgId, card.id, old.player_id, a.employeeId ?? null, { replaces: oldCardId },
  ]);
  await audit(db, a, 'player.card_replaced', 'player_card', oldCardId, { playerId: old.player_id, newCardId: card.id });
  return { oldCardId, card };
}

/** Changes the player status following the documented transition rules. */
export async function changePlayerStatus(db: Db, a: Actor, playerId: string, to: PlayerStatus, reason: string) {
  if (!reason || reason.trim().length < 3) throw new HttpError(400, 'A reason is required');
  const player = await lockPlayer(db, a.orgId, playerId);
  if (!canTransitionPlayer(player.status, to)) throw new HttpError(409, `Player status cannot change from ${player.status} to ${to}`);
  await db.query('UPDATE players SET status = $2, status_changed_at = now(), updated_at = now() WHERE id = $1', [playerId, to]);
  await db.query('INSERT INTO player_status_history (org_id, player_id, from_status, to_status, reason, changed_by) VALUES ($1,$2,$3,$4,$5,$6)', [
    a.orgId, playerId, player.status, to, reason, a.employeeId ?? null,
  ]);
  await audit(db, a, 'player.status_changed', 'player', playerId, { from: player.status, to });
  return { ...player, status: to };
}

/** Keyed hash of a document number: allows matching duplicates without storing the number. */
export function hashDocumentNumber(orgId: string, documentNumber: string): string {
  return createHmac('sha256', config.piiHashSecret).update(`${orgId}:${documentNumber.replace(/\s+/g, '').toUpperCase()}`).digest('hex');
}

/** Records a verification decision. Stores only the masked number and the keyed hash. */
export async function recordVerification(
  db: Db,
  a: Actor,
  playerId: string,
  input: { status: VerificationDecision; method?: string; documentType?: string; documentCountry?: string; documentNumber?: string; validUntil?: string; note?: string },
) {
  await lockPlayer(db, a.orgId, playerId);
  const masked = input.documentNumber ? maskDocumentNumber(input.documentNumber) : null;
  const hash = input.documentNumber ? hashDocumentNumber(a.orgId, input.documentNumber) : null;
  const r = await db.query(
    `INSERT INTO player_verifications (org_id, player_id, status, method, document_type, document_country, document_number_masked, document_number_hash, valid_until, note, decided_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [a.orgId, playerId, input.status, input.method ?? null, input.documentType ?? null, input.documentCountry ?? null, masked, hash, input.validUntil ?? null, input.note ?? null, a.employeeId ?? null],
  );
  await db.query('UPDATE players SET verification_status = $2, updated_at = now() WHERE id = $1', [playerId, input.status]);
  await audit(db, a, 'player.verification_recorded', 'player', playerId, { status: input.status, verificationId: r.rows[0].id });
  return { id: r.rows[0].id, status: input.status, documentNumberMasked: masked };
}
