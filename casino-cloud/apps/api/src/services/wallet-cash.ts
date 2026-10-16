import { writeAudit, type PoolClient } from '@m1/database';
import { cents } from '@m1/shared';
import { HttpError } from '../auth';
import { consumeApproval, requestApproval } from './approvals';
import { addCashTx, requireOpenSession } from './cashier';
import { entityDedupeKey, executeMoneyTransaction, type MoneyActor } from './ledger';
import type { Actor } from './players';
import { railOnLedger } from './rails';
import { assertWalletOperation, walletOfPlayer } from './wallets';

/**
 * Step 7d: cashier <-> wallet, one immediate ledger transaction each (no state machine):
 *   deposit     CASH_DEPOSIT     drawer -> wallet available
 *   withdrawal  CASH_WITHDRAWAL  wallet available -> drawer (only the available balance; reserved money stays)
 * Player capability + wallet state, KYC above the organisation's verification threshold, a four-eyes
 * approval above deposit_approval_cents / withdrawal_approval_cents (approver != cashier, used once,
 * bound to wallet and amount). Exactly once per HTTP Idempotency-Key (dedupe key); the drawer row is a
 * LegacyProjection (CASH_IN / CASH_OUT referencing the ledger transaction).
 */

type Db = Pick<PoolClient, 'query'>;
export type WalletCashKind = 'CASH_DEPOSIT' | 'CASH_WITHDRAWAL';

const LIMIT = { CASH_DEPOSIT: 'deposit_approval_cents', CASH_WITHDRAWAL: 'withdrawal_approval_cents' } as const;

async function approvalLimit(db: Db, casinoId: string, kind: WalletCashKind): Promise<number | null> {
  const v = (await db.query(`SELECT ${LIMIT[kind]} AS v FROM casino_money_settings WHERE casino_id = $1`, [casinoId])).rows[0]?.v;
  return v === null || v === undefined ? null : Number(v);
}

async function assertVerified(db: Db, orgId: string, playerId: string, amountCents: number) {
  const t = (await db.query('SELECT verification_threshold_cents FROM organizations WHERE id = $1', [orgId])).rows[0]?.verification_threshold_cents;
  if (t === null || t === undefined || amountCents < Number(t)) return;
  const p = (await db.query('SELECT verification_status FROM players WHERE id = $1', [playerId])).rows[0];
  if (p?.verification_status !== 'VERIFIED') throw new HttpError(409, 'The player is not verified (verification threshold)');
}

/** Four-eyes approval request for a deposit / withdrawal above the limit (bound to wallet and amount). */
export async function requestWalletCashApproval(db: Db, a: Actor, input: { kind: WalletCashKind; playerId: string; amountCents: number }) {
  if (!a.employeeId) throw new HttpError(400, 'An employee must request');
  const session = await requireOpenSession(db as PoolClient, a.orgId, a.employeeId);
  const w = await walletOfPlayer(db, a.orgId, input.playerId);
  const limit = await approvalLimit(db, session.casino_id, input.kind);
  if (limit === null || input.amountCents < limit) throw new HttpError(409, 'This amount is below the approval limit');
  return requestApproval(db, a, { casinoId: session.casino_id, action: input.kind, entityType: 'wallet', entityId: w.id, amountCents: input.amountCents, payload: { playerId: input.playerId } });
}

export async function walletCash(db: PoolClient, a: Actor, input: { kind: WalletCashKind; playerId: string; cardId?: string | null; amountCents: number; requestKey: string }) {
  if (!a.employeeId) throw new HttpError(400, 'An employee must book');
  if (!input.requestKey) throw new HttpError(400, 'requestKey required');
  const amount = cents(input.amountCents);
  if (amount <= 0) throw new HttpError(400, 'Amount must be positive');
  const session = await requireOpenSession(db, a.orgId, a.employeeId);
  if (!(await railOnLedger(db, a.orgId, 'CASH', session.casino_id))) throw new HttpError(409, 'CASH is not on the ledger for this casino');
  const w = await walletOfPlayer(db, a.orgId, input.playerId);
  assertWalletOperation(w, input.kind === 'CASH_DEPOSIT' ? 'DEPOSIT' : 'WITHDRAW');
  await assertVerified(db, a.orgId, input.playerId, amount);
  let approval: { id: string; decided_by: string } | null = null;
  const limit = await approvalLimit(db, session.casino_id, input.kind);
  if (limit !== null && amount >= limit) {
    approval = (await db.query(
      `SELECT id, decided_by FROM approvals WHERE action = $1 AND entity_id = $2 AND amount_cents = $3 AND status = 'APPROVED' AND expires_at > now() ORDER BY decided_at DESC LIMIT 1 FOR UPDATE`,
      [input.kind, w.id, amount])).rows[0] ?? null;
    if (!approval) throw new HttpError(409, 'Supervisor approval required for this amount');
    if (approval.decided_by === a.employeeId) throw new HttpError(409, 'The approver cannot book the same amount');
  }
  const actor: MoneyActor = { type: 'EMPLOYEE', employeeId: a.employeeId, name: a.employeeEmail ?? null, ip: a.ip ?? null };
  const r = await executeMoneyTransaction(db, {
    orgId: a.orgId, type: input.kind, dedupeKey: entityDedupeKey('wallet', w.id, input.kind.toLowerCase(), input.requestKey), actor, approvedBy: approval?.decided_by ?? null,
    ctx: { casinoId: session.casino_id, amountCents: amount, playerId: input.playerId, walletId: w.id, cardId: input.cardId ?? undefined, cashierSessionId: session.id },
  });
  if (r.replayed) return { moneyTransaction: r.transaction, transaction: null, replayed: true };
  const cashTx = await addCashTx(db, session, input.kind === 'CASH_DEPOSIT' ? 'CASH_IN' : 'CASH_OUT', amount / 100, {
    moneyTransactionId: r.transaction.id, playerId: input.playerId, reference: input.kind === 'CASH_DEPOSIT' ? 'Wallet deposit' : 'Wallet withdrawal',
  });
  if (approval) await consumeApproval(db, a, approval.id, { action: input.kind, entityId: w.id, moneyTransactionId: r.transaction.id });
  await writeAudit(db, {
    orgId: a.orgId, casinoId: session.casino_id, actorType: 'EMPLOYEE', actorId: a.employeeId, actorName: a.employeeEmail ?? null, ip: a.ip ?? null,
    action: input.kind === 'CASH_DEPOSIT' ? 'wallet.cash_deposit' : 'wallet.cash_withdrawal', entityType: 'wallet', entityId: w.id,
    details: { amountCents: amount, transactionId: r.transaction.id, approvalId: approval?.id ?? null },
  });
  return { moneyTransaction: r.transaction, transaction: cashTx, replayed: false };
}
