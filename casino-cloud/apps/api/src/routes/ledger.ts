import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard, scopeCasino } from '../auth';
import { pool } from '../db';
import { checkLedgerInvariants } from '../services/ledger';
import { countsTargets } from '../services/blind-count';

/** Read-only ledger endpoints. Money is written only through the ledger service. */
export async function ledgerRoutes(app: FastifyInstance) {
  app.get('/api/v1/ledger/health', { preHandler: guard('accounting.view') }, async (req) => checkLedgerInvariants(pool, req.auth.orgId));

  /** Balances of the casino's accounts plus the organisation-level (wallet) accounts. */
  app.get('/api/v1/ledger/accounts', { preHandler: guard('accounting.view') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    const r = await pool.query(
      `SELECT a.id, a.kind, k.class, k.scope, a.casino_id, a.machine_id, a.wallet_id, a.cashier_session_id, a.vault_id,
         CASE WHEN $3::boolean AND a.kind IN ('VAULT', 'CASHBOX', 'DRAWER') THEN NULL ELSE b.balance_cents * b.normal_sign END AS balance_cents,
         ($3::boolean AND a.kind IN ('VAULT', 'CASHBOX', 'DRAWER')) AS blind, b.version, b.updated_at
       FROM ledger_accounts a JOIN ledger_account_kinds k ON k.code = a.kind JOIN ledger_balances b ON b.account_id = a.id
       WHERE a.org_id = $1 AND (a.casino_id = $2 OR a.casino_id IS NULL) ORDER BY k.scope, a.kind, a.id`,
      // Blind count: balances of count targets (vault, machine cashbox, drawer) are withheld from roles that count them.
      [req.auth.orgId, casinoId, countsTargets(req.auth.role)],
    );
    return r.rows;
  });
}
