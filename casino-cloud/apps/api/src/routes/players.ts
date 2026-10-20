import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTransaction } from '@m1/database';
import { CARD_TYPES, PLAYER_STATUSES, VERIFICATION_DECISIONS } from '@m1/shared';
import { HttpError, guard } from '../auth';
import { pool } from '../db';
import { changePlayerStatus, createPlayer, issueCard, recordVerification, replaceCard, setCardStatus } from '../services/players';

/**
 * Player onboarding at the cage (permission player.manage): registration, cards, status and the identity
 * verification. Thin routes over the player service of migration 003: every query is bound to the caller's
 * organisation, personal data never reaches the audit trail, a document number is stored masked and hashed only.
 * No route here moves money; the wallet of a new player starts empty on the ledger.
 */
const actor = (req: FastifyRequest) => ({ orgId: req.auth.orgId, employeeId: req.auth.sub, employeeEmail: req.auth.email, ip: req.ip });
const card = z.object({ cardNumber: z.string().trim().min(4).max(40), cardType: z.enum(CARD_TYPES).optional(), expiresAt: z.string().datetime().nullable().optional() });
const id = z.object({ id: z.string().uuid() });
const reason = z.string().trim().min(3).max(500);

export async function playerRoutes(app: FastifyInstance) {
  const P = { config: { feature: 'core' as const }, preHandler: guard('player.manage') };

  app.post('/api/v1/players', P, async (req) => {
    const body = z.object({
      homeCasinoId: z.string().uuid().optional(),
      profile: z.object({
        firstName: z.string().trim().max(80).optional(), lastName: z.string().trim().max(80).optional(),
        birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), email: z.string().trim().email().max(200).optional(),
        phone: z.string().trim().max(40).optional(), nationality: z.string().trim().length(2).optional(),
      }).optional(),
      card: card.optional(),
    }).parse(req.body);
    const homeCasinoId = body.homeCasinoId ?? req.auth.casinoIds[0] ?? null;
    if (homeCasinoId && !req.auth.casinoIds.includes(homeCasinoId)) throw new HttpError(404, 'Casino not found');
    const r = await withTransaction(pool, (db) => createPlayer(db, actor(req), { homeCasinoId, profile: body.profile, card: body.card }));
    return { player: r.player, card: r.card, walletId: r.wallet.id };
  });

  app.post('/api/v1/players/:id/cards', P, async (req) => {
    const { id: playerId } = id.parse(req.params);
    const body = card.parse(req.body);
    return withTransaction(pool, (db) => issueCard(db, actor(req), playerId, body));
  });

  app.post('/api/v1/players/cards/:id/status', P, async (req) => {
    const { id: cardId } = id.parse(req.params);
    const body = z.object({ status: z.enum(['ACTIVE', 'BLOCKED', 'LOST', 'EXPIRED']), reason: reason.optional() }).parse(req.body);
    return withTransaction(pool, (db) => setCardStatus(db, actor(req), cardId, body.status, body.reason));
  });

  app.post('/api/v1/players/cards/:id/replace', P, async (req) => {
    const { id: cardId } = id.parse(req.params);
    const body = card.extend({ reason: reason.optional() }).parse(req.body);
    return withTransaction(pool, (db) => replaceCard(db, actor(req), cardId, body, body.reason));
  });

  app.post('/api/v1/players/:id/status', P, async (req) => {
    const { id: playerId } = id.parse(req.params);
    const body = z.object({ status: z.enum(PLAYER_STATUSES), reason }).parse(req.body);
    return withTransaction(pool, (db) => changePlayerStatus(db, actor(req), playerId, body.status, body.reason));
  });

  app.post('/api/v1/players/:id/verification', P, async (req) => {
    const { id: playerId } = id.parse(req.params);
    const body = z.object({
      status: z.enum(VERIFICATION_DECISIONS), method: z.string().trim().max(40).optional(), documentType: z.string().trim().max(40).optional(),
      documentCountry: z.string().trim().length(2).optional(), documentNumber: z.string().trim().min(4).max(40).optional(),
      validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), note: z.string().trim().max(500).optional(),
    }).parse(req.body);
    return withTransaction(pool, (db) => recordVerification(db, actor(req), playerId, body));
  });
}
