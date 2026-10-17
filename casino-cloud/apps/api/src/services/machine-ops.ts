import { writeAudit, type PoolClient } from '@m1/database';
import { cents } from '@m1/shared';
import { expectedCollection } from './collections';
import { HttpError } from '../auth';
import type { CashActor } from './cash-ops';
import { mainVaultOf, readyVaultSession } from './cash-ops';
import { entityDedupeKey, executeMoneyTransaction, type MoneyActor } from './ledger';
import { railOnLedger } from './rails';
import { countTotal, recordCashCount, type CountInput } from './vault';

/**
 * Step 7d: physical machine money on the ledger.
 *
 *   Hopper fill        vault -> hopper (HOPPER_FILL). Requested by the vault, confirmed at the machine by a
 *                      different employee with the counted amount; a mismatch rejects, nothing moves.
 *   Machine collection blind count of the cashbox, blind second count by a different employee. A match settles:
 *                      the difference to the ledger cashbox is MACHINE_DROP_DIFFERENCE (counter = actor, verifier
 *                      = approver), the counted cash goes cashbox -> vault (MACHINE_DROP); the legacy collection
 *                      row is the projection. The machine must not have taken cash after the count.
 */

type Db = Pick<PoolClient, 'query'>;

const one = async <T = Record<string, any>>(db: Db, sql: string, params: unknown[]): Promise<T> => (await db.query(sql, params)).rows[0];
const employee = (id: string): MoneyActor => ({ type: 'EMPLOYEE', employeeId: id });

function audit(db: Db, a: CashActor, casinoId: string, action: string, entityType: string, entityId: string, details: Record<string, unknown>) {
  return writeAudit(db as PoolClient, { orgId: a.orgId, casinoId, actorType: 'EMPLOYEE', actorId: a.employeeId, actorName: a.employeeEmail ?? null, ip: a.ip ?? null, action, entityType, entityId, details });
}

async function ledgerMachine(db: Db, a: CashActor, machineId: string) {
  const m = await one<{ id: string; casino_id: string; asset_no: string }>(db, 'SELECT id, casino_id, asset_no FROM machines WHERE id = $1 AND org_id = $2 FOR NO KEY UPDATE', [machineId, a.orgId]);
  if (!m || !a.casinoIds.includes(m.casino_id)) throw new HttpError(404, 'Machine not found');
  if (!(await railOnLedger(db, a.orgId, 'MACHINE', m.casino_id, m.id))) throw new HttpError(409, 'MACHINE money is not on the ledger for this machine (cutover pending)');
  return m;
}

// ---- hopper fill -----------------------------------------------------------------------------

export async function requestHopperFill(db: Db, a: CashActor, input: { machineId: string; amountCents: number; requestKey: string; note?: string }) {
  if (!input.requestKey || input.requestKey.length > 200) throw new HttpError(400, 'requestKey required');
  const amount = cents(input.amountCents);
  if (amount <= 0) throw new HttpError(400, 'Amount must be positive');
  const prev = await one(db, 'SELECT * FROM cash_movements WHERE org_id = $1 AND request_key = $2', [a.orgId, input.requestKey]);
  if (prev) {
    if (prev.kind === 'HOPPER_FILL' && prev.machine_id === input.machineId && Number(prev.amount_cents) === amount) return { movement: prev, replayed: true };
    throw new HttpError(409, 'This request key was already used for a different movement');
  }
  const m = await ledgerMachine(db, a, input.machineId);
  const vaultId = await mainVaultOf(db, m.casino_id);
  const vs = await readyVaultSession(db, vaultId);
  const mv = (await db.query(
    `INSERT INTO cash_movements (org_id, casino_id, kind, vault_id, vault_session_id, machine_id, amount_cents, purpose, request_key, requested_by, note, expires_at)
     SELECT $1,$2,'HOPPER_FILL',$3,$4,$5,$6,'SHIFT',$7,$8,$9, now() + make_interval(secs => COALESCE((SELECT cash_movement_timeout_seconds FROM casino_money_settings WHERE casino_id = $2), 900))
     RETURNING *`,
    [a.orgId, m.casino_id, vaultId, vs.id, m.id, amount, input.requestKey, a.employeeId, input.note ?? null],
  )).rows[0];
  await audit(db, a, m.casino_id, 'machine.hopper_fill_requested', 'cash_movement', mv.id, { machineId: m.id, amountCents: amount });
  return { movement: mv, replayed: false };
}

export async function confirmHopperFill(db: Db, a: CashActor, movementId: string, count: CountInput) {
  const mv = await one(db, `SELECT * FROM cash_movements WHERE id = $1 AND org_id = $2 AND kind = 'HOPPER_FILL' FOR UPDATE`, [movementId, a.orgId]);
  if (!mv || !a.casinoIds.includes(mv.casino_id)) throw new HttpError(404, 'Hopper fill not found');
  if (mv.status === 'CONFIRMED' && mv.decided_by === a.employeeId) return { movement: mv, replayed: true };
  if (mv.status !== 'REQUESTED') throw new HttpError(409, `Hopper fill is ${mv.status}`);
  if (mv.requested_by === a.employeeId) throw new HttpError(409, 'The requester cannot confirm the own hopper fill');
  if (new Date(mv.expires_at) <= new Date()) return { movement: (await db.query(`UPDATE cash_movements SET status = 'EXPIRED' WHERE id = $1 RETURNING *`, [mv.id])).rows[0], replayed: false };
  await ledgerMachine(db, a, mv.machine_id);
  const counted = countTotal(count);
  if (counted !== Number(mv.amount_cents)) {
    const rejected = (await db.query(
      `UPDATE cash_movements SET status = 'REJECTED', decided_by = $2, decided_at = now(), confirmed_count_cents = $3, note = COALESCE(note || ' / ', '') || 'count mismatch' WHERE id = $1 RETURNING *`,
      [mv.id, a.employeeId, counted])).rows[0];
    await audit(db, a, mv.casino_id, 'machine.hopper_fill_mismatch', 'cash_movement', mv.id, { amountCents: Number(mv.amount_cents), countedCents: counted });
    return { movement: rejected, replayed: false };
  }
  const vs = await one(db, 'SELECT status FROM vault_sessions WHERE id = $1', [mv.vault_session_id]);
  if (vs.status !== 'OPEN') throw new HttpError(409, 'The vault session is not open');
  const r = await executeMoneyTransaction(db, {
    orgId: a.orgId, type: 'HOPPER_FILL', dedupeKey: entityDedupeKey('cash_movement', mv.id), actor: employee(mv.requested_by), approvedBy: a.employeeId,
    ctx: { casinoId: mv.casino_id, amountCents: cents(Number(mv.amount_cents)), machineId: mv.machine_id, vaultId: mv.vault_id },
  });
  const confirmed = (await db.query(
    `UPDATE cash_movements SET status = 'CONFIRMED', decided_by = $2, decided_at = now(), confirmed_count_cents = $3, money_transaction_id = $4 WHERE id = $1 RETURNING *`,
    [mv.id, a.employeeId, counted, r.transaction.id])).rows[0];
  await audit(db, a, mv.casino_id, 'machine.hopper_filled', 'cash_movement', mv.id, { machineId: mv.machine_id, amountCents: Number(mv.amount_cents), transactionId: r.transaction.id });
  return { movement: confirmed, replayed: false };
}

// ---- machine collection ----------------------------------------------------------------------

/** First, blind count of a machine's cashbox at its collection. */
export async function recordCollectionCount(db: Db, a: CashActor, machineId: string, count: CountInput) {
  const m = await ledgerMachine(db, a, machineId);
  const c = await recordCashCount(db, a, { ...count, blind: true, casinoId: m.casino_id, context: 'MACHINE_DROP', machineId: m.id });
  await audit(db, a, m.casino_id, 'machine.collection_counted', 'cash_count', c.id, { machineId: m.id, totalCents: c.total_cents });
  return c;
}

/**
 * Second, blind count by a different employee. A match settles the collection against the ledger;
 * a mismatch books nothing (recount).
 */
export async function verifyCollectionCount(db: Db, a: CashActor, countId: string, input: CountInput) {
  const c = await one(db, `SELECT * FROM cash_counts WHERE id = $1 AND org_id = $2 AND context = 'MACHINE_DROP' FOR UPDATE`, [countId, a.orgId]);
  if (!c || !a.casinoIds.includes(c.casino_id)) throw new HttpError(404, 'Count not found');
  const m = await ledgerMachine(db, a, c.machine_id);
  if (await one(db, 'SELECT 1 FROM count_settlements WHERE count_id = $1', [countId])) throw new HttpError(409, 'Count already settled');
  const latest = await one(db, `SELECT id FROM cash_counts WHERE machine_id = $1 AND context = 'MACHINE_DROP' ORDER BY created_at DESC, id DESC LIMIT 1`, [m.id]);
  if (latest.id !== countId) throw new HttpError(409, 'A newer count exists for this machine');
  const total = countTotal(input);
  let v;
  try {
    v = (await db.query('INSERT INTO cash_count_verifications (org_id, count_id, total_cents, matches, verified_by, note) VALUES ($1,$2,$3,false,$4,$5) RETURNING *',
      [a.orgId, countId, total, a.employeeId, input.note ?? null])).rows[0];
  } catch (err) {
    if (/different employee/.test((err as Error).message)) throw new HttpError(409, 'The second count must be done by a different employee');
    throw err;
  }
  if (!v.matches) {
    await audit(db, a, c.casino_id, 'machine.collection_count_mismatch', 'cash_count', countId, { counted: c.total_cents, verified: total });
    return { matches: false as const, settlement: null, collection: null };
  }
  const later = await one<{ n: number }>(db, `SELECT count(*)::int n FROM machine_events WHERE machine_id = $1 AND type = 'CASH_IN' AND received_at > $2`, [m.id, c.created_at]);
  if (later.n) throw new HttpError(409, 'The machine accepted cash after the count: count again');

  // the one expected-collection definition (services/collections.ts): the machine's CASHBOX ledger balance
  const ledgerCents = (await expectedCollection(db, a.orgId, m.id)).cashCents;
  const counted = Number(c.total_cents);
  const difference = counted - ledgerCents;
  const vaultId = await mainVaultOf(db, m.casino_id);
  let diffTx: string | null = null;
  let dropTx: string | null = null;
  if (difference !== 0) {
    diffTx = (await executeMoneyTransaction(db, {
      orgId: a.orgId, type: 'MACHINE_DROP_DIFFERENCE', dedupeKey: entityDedupeKey('count', countId, 'difference'), actor: employee(c.counted_by), approvedBy: a.employeeId,
      reason: `Machine ${m.asset_no} collection count difference`, ctx: { casinoId: m.casino_id, amountCents: cents(difference), machineId: m.id, vaultId },
    })).transaction.id;
  }
  if (counted > 0) {
    await readyVaultSession(db, vaultId);
    dropTx = (await executeMoneyTransaction(db, {
      orgId: a.orgId, type: 'MACHINE_DROP', dedupeKey: entityDedupeKey('count', countId, 'drop'), actor: employee(c.counted_by), approvedBy: a.employeeId,
      ctx: { casinoId: m.casino_id, amountCents: cents(counted), machineId: m.id, vaultId },
    })).transaction.id;
  }
  const settlement = (await db.query(
    `INSERT INTO count_settlements (count_id, org_id, casino_id, ledger_cents, counted_cents, difference_cents, money_transaction_id, settled_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [countId, a.orgId, m.casino_id, ledgerCents, counted, difference, diffTx, a.employeeId])).rows[0];
  let collection = null;
  if (dropTx || diffTx)
    collection = (await db.query(
      `INSERT INTO cash_collections (org_id, casino_id, machine_id, period_start, period_end, expected_cash, expected_tickets, counted_cash, counted_tickets, difference, note, collected_by, count_id, money_transaction_id)
       SELECT $1, $2, $3, COALESCE((SELECT max(period_end) FROM cash_collections WHERE machine_id = $3), (SELECT as_of FROM money_rail_cutovers WHERE rail = 'MACHINE' AND machine_id = $3)),
         now(), $4::bigint / 100.0, 0, $5::bigint / 100.0, 0, $6::bigint / 100.0, 'ledger collection', $7, $8, $9 RETURNING *`,
      [a.orgId, m.casino_id, m.id, ledgerCents, counted, difference, c.counted_by, countId, dropTx ?? diffTx])).rows[0];
  await audit(db, a, m.casino_id, 'machine.collection_settled', 'cash_count', countId, { machineId: m.id, ledgerCents, countedCents: counted, differenceCents: difference, dropTx, diffTx });
  return { matches: true as const, settlement, collection };
}
