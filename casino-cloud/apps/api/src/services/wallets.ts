import { writeAudit, type PoolClient } from '@m1/database';
import { WALLET_TRANSITIONS, walletOperationBlocked, type PlayerStatus, type WalletOperation, type WalletStatus } from '@m1/shared';
import { HttpError } from '../auth';
import type { Actor } from './players';

/**
 * Wallet domain. A wallet belongs to the organisation and to exactly one player. It has no balance
 * column: balances come only from the ledger (view wallet_balances).
 */

type Db = Pick<PoolClient, 'query'>;

export interface WalletRow {
  id: string;
  org_id: string;
  player_id: string;
  status: WalletStatus;
  player_status: PlayerStatus;
}

export async function createWallet(db: Db, a: Actor, playerId: string) {
  const p = await db.query('SELECT status FROM players WHERE id = $1 AND org_id = $2 FOR NO KEY UPDATE', [playerId, a.orgId]);
  if (!p.rowCount) throw new HttpError(404, 'Player not found');
  if (p.rows[0].status === 'CLOSED') throw new HttpError(409, 'A closed player cannot get a wallet');
  const r = await db.query(
    'INSERT INTO wallets (org_id, player_id, created_by) VALUES ($1,$2,$3) ON CONFLICT (player_id) DO NOTHING RETURNING id, org_id, player_id, status',
    [a.orgId, playerId, a.employeeId ?? null],
  );
  if (!r.rowCount) throw new HttpError(409, 'Player already has a wallet');
  await db.query(`INSERT INTO wallet_events (org_id, wallet_id, action, employee_id) VALUES ($1,$2,'CREATED',$3)`, [a.orgId, r.rows[0].id, a.employeeId ?? null]);
  await writeAudit(db as PoolClient, { orgId: a.orgId, actorType: a.employeeId ? 'EMPLOYEE' : 'SYSTEM', actorId: a.employeeId ?? null, actorName: a.employeeEmail ?? 'system', action: 'wallet.created', entityType: 'wallet', entityId: r.rows[0].id, details: { playerId } });
  return r.rows[0];
}

/** Locks and returns a wallet with its player's status. */
export async function lockWallet(db: Db, orgId: string, walletId: string): Promise<WalletRow> {
  const r = await db.query(
    `SELECT w.id, w.org_id, w.player_id, w.status, p.status AS player_status
     FROM wallets w JOIN players p ON p.id = w.player_id WHERE w.id = $1 AND w.org_id = $2 FOR NO KEY UPDATE OF w`,
    [walletId, orgId],
  );
  if (!r.rowCount) throw new HttpError(404, 'Wallet not found');
  return r.rows[0];
}

export async function walletOfPlayer(db: Db, orgId: string, playerId: string): Promise<WalletRow> {
  const r = await db.query('SELECT id FROM wallets WHERE player_id = $1 AND org_id = $2', [playerId, orgId]);
  if (!r.rowCount) throw new HttpError(409, 'Player has no wallet');
  return lockWallet(db, orgId, r.rows[0].id);
}

/** Throws 409 unless both the wallet state and the player status allow the operation. */
export function assertWalletOperation(w: Pick<WalletRow, 'status' | 'player_status'>, op: WalletOperation) {
  const reason = walletOperationBlocked(op, w.player_status, w.status);
  if (reason) throw new HttpError(409, reason);
}

/** Wallet balances from the ledger plus transfers in progress. */
export async function walletBalances(db: Db, orgId: string, walletId: string) {
  const r = await db.query(
    `SELECT b.available_cents, b.reserved_cents, b.status,
       COALESCE((SELECT sum(amount_cents) FROM wallet_transfers t WHERE t.wallet_id = b.wallet_id AND t.direction = 'FROM_MACHINE' AND t.status IN ('REQUESTED', 'SENT')), 0)::bigint AS pending_in_cents,
       (SELECT machine_id FROM cashless_sessions s WHERE s.wallet_id = b.wallet_id AND s.status = 'OPEN') AS playing_machine_id
     FROM wallet_balances b WHERE b.wallet_id = $1 AND b.org_id = $2`,
    [walletId, orgId],
  );
  if (!r.rowCount) throw new HttpError(404, 'Wallet not found');
  // The playing balance on a machine is a gaming / machine-credit concept, not a wallet balance.
  return r.rows[0] as { available_cents: number; reserved_cents: number; pending_in_cents: number; status: WalletStatus; playing_machine_id: string | null };
}

export async function setWalletStatus(db: Db, a: Actor, walletId: string, to: WalletStatus, reason: string) {
  if (!reason || reason.trim().length < 3) throw new HttpError(400, 'A reason is required');
  const w = await lockWallet(db, a.orgId, walletId);
  if (!WALLET_TRANSITIONS.can(w.status, to)) throw new HttpError(409, `Wallet status cannot change from ${w.status} to ${to}`);
  if (to === 'CLOSED') {
    const b = await walletBalances(db, a.orgId, walletId);
    if (b.available_cents !== 0 || b.reserved_cents !== 0 || b.pending_in_cents !== 0) throw new HttpError(409, 'Wallet balance must be zero before closing');
    if (b.playing_machine_id) throw new HttpError(409, 'Wallet has an open cashless session');
  }
  await db.query('UPDATE wallets SET status = $2, status_reason = $3, status_changed_at = now() WHERE id = $1', [walletId, to, reason]);
  const action = to === 'ACTIVE' ? 'UNBLOCKED' : to;
  await db.query('INSERT INTO wallet_events (org_id, wallet_id, action, reason, employee_id) VALUES ($1,$2,$3,$4,$5)', [a.orgId, walletId, action, reason, a.employeeId ?? null]);
  await writeAudit(db as PoolClient, { orgId: a.orgId, actorType: a.employeeId ? 'EMPLOYEE' : 'SYSTEM', actorId: a.employeeId ?? null, actorName: a.employeeEmail ?? 'system', action: `wallet.${action.toLowerCase()}`, entityType: 'wallet', entityId: walletId, details: { from: w.status, to } });
  return { ...w, status: to };
}
