import { randomInt } from 'node:crypto';
import type { PoolClient } from '@m1/database';
import { signedCashAmount, type CashTxType } from '@m1/shared';
import { HttpError } from '../auth';

export interface SessionRow {
  id: string;
  org_id: string;
  casino_id: string;
  cash_desk_id: string;
  employee_id: string;
  opening_balance: number;
  opened_at: string;
}

/** The employee's open cashier session, locked for the rest of the transaction. */
export async function requireOpenSession(db: PoolClient, orgId: string, employeeId: string): Promise<SessionRow> {
  const r = await db.query(
    `SELECT * FROM cashier_sessions WHERE org_id = $1 AND employee_id = $2 AND status = 'OPEN' FOR NO KEY UPDATE`,
    [orgId, employeeId],
  );
  if (!r.rowCount) throw new HttpError(409, 'Open a cashier session (shift) first');
  return r.rows[0];
}

export async function addCashTx(
  db: PoolClient,
  s: SessionRow,
  type: CashTxType,
  amount: number,
  extra: { ticketId?: string; machineId?: string; playerId?: string; reference?: string } = {},
) {
  const signed = signedCashAmount(type, amount);
  const r = await db.query(
    `INSERT INTO cash_transactions (org_id, casino_id, session_id, employee_id, type, amount, ticket_id, machine_id, player_id, reference)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, type, amount, created_at`,
    [s.org_id, s.casino_id, s.id, s.employee_id, type, signed, extra.ticketId ?? null, extra.machineId ?? null, extra.playerId ?? null, extra.reference ?? null],
  );
  return r.rows[0];
}

/** Totals per movement type and the expected drawer balance. */
export async function sessionTotals(db: { query: PoolClient['query'] }, sessionId: string, openingBalance: number) {
  const r = await db.query(
    `SELECT type, sum(amount) total, count(*) n FROM cash_transactions WHERE session_id = $1 GROUP BY type`,
    [sessionId],
  );
  const byType: Record<string, { total: number; count: number }> = {};
  let movement = 0;
  for (const row of r.rows) {
    byType[row.type] = { total: row.total, count: row.n };
    movement += row.total;
  }
  return { byType, expected: Math.round((openingBalance + movement) * 100) / 100 };
}

/** 18 digit TITO style barcode. Uniqueness is enforced by the database. */
export function newBarcode(): string {
  let s = String(randomInt(1, 10));
  while (s.length < 18) s += String(randomInt(0, 10));
  return s;
}
