import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard, scopeCasino } from '../auth';
import { pool } from '../db';
import { checkLedgerInvariants } from '../services/ledger';

/** Read-only ledger endpoints. Money is written only through the ledger service. */
export async function ledgerRoutes(app: FastifyInstance) {
  app.get('/api/v1/ledger/health', { preHandler: guard('accounting.view') }, async (req) => checkLedgerInvariants(pool, req.auth.orgId));

  /** Balances of the casino's accounts plus the organisation-level (wallet) accounts. */
  app.get('/api/v1/ledger/accounts', { preHandler: guard('accounting.view') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    const r = await pool.query(
      `SELECT a.id, a.kind, k.class, k.scope, a.casino_id, a.machine_id, a.wallet_id, a.cashier_session_id, a.vault_id,
         b.balance_cents * b.normal_sign AS balance_cents, b.version, b.updated_at
       FROM ledger_accounts a JOIN ledger_account_kinds k ON k.code = a.kind JOIN ledger_balances b ON b.account_id = a.id
       WHERE a.org_id = $1 AND (a.casino_id = $2 OR a.casino_id IS NULL) ORDER BY k.scope, a.kind, a.id`,
      [req.auth.orgId, casinoId],
    );
    return r.rows;
  });
}
