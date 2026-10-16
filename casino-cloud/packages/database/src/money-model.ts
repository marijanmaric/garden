import type pg from 'pg';
import { ACCOUNT_KINDS, ACCOUNT_KIND_KEYS, ACCOUNT_KIND_RAIL, MONEY_TRANSACTIONS, MONEY_TRANSACTION_TYPES } from '@m1/shared';

/**
 * Mirrors the shared money model (account kinds, transaction types) into the reference tables
 * of migration 004. The shared model is the single source; the database only enforces it.
 * Existing rows must match exactly: changing the meaning of a kind or type that may already be
 * in use is refused instead of being applied silently.
 */
export async function syncMoneyModel(pool: pg.Pool): Promise<void> {
  const exists = await pool.query(`SELECT to_regclass('ledger_account_kinds') IS NOT NULL AS ok`);
  if (!exists.rows[0].ok) return; // before migration 004
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const code of ACCOUNT_KIND_KEYS) {
      const k = ACCOUNT_KINDS[code];
      const sign = k.class === 'ASSET' || k.class === 'EXPENSE' ? 1 : -1;
      await client.query(
        `INSERT INTO ledger_account_kinds (code, class, scope, owner, allow_negative, normal_sign, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (code) DO NOTHING`,
        [code, k.class, k.scope, k.owner, k.allowNegative, sign, k.description],
      );
      const row = (await client.query('SELECT class, scope, owner, allow_negative, normal_sign FROM ledger_account_kinds WHERE code = $1', [code])).rows[0];
      if (row.class !== k.class || row.scope !== k.scope || row.owner !== k.owner || row.allow_negative !== k.allowNegative || row.normal_sign !== sign)
        throw new Error(`Ledger account kind ${code} differs between database and shared model`);
      // Rail of the kind (migration 007): filled once, never changed afterwards.
      const hasRail = (await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'ledger_account_kinds' AND column_name = 'cutover_rail'`)).rowCount;
      if (hasRail) {
        const rail = ACCOUNT_KIND_RAIL[code] ?? null;
        await client.query('UPDATE ledger_account_kinds SET cutover_rail = $2 WHERE code = $1 AND cutover_rail IS NULL AND $2::text IS NOT NULL', [code, rail]);
        const r = (await client.query('SELECT cutover_rail FROM ledger_account_kinds WHERE code = $1', [code])).rows[0];
        if (r.cutover_rail !== rail) throw new Error(`Ledger account kind ${code}: rail differs between database and shared model`);
      }
    }
    for (const code of MONEY_TRANSACTION_TYPES) {
      const t = MONEY_TRANSACTIONS[code];
      await client.query(
        `INSERT INTO money_transaction_types (code, rail, label, signed) VALUES ($1,$2,$3,$4)
         ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label`,
        [code, t.rail, t.label, !!t.signed],
      );
      const row = (await client.query('SELECT rail, signed FROM money_transaction_types WHERE code = $1', [code])).rows[0];
      if (row.rail !== t.rail || row.signed !== !!t.signed) throw new Error(`Money transaction type ${code} differs between database and shared model`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
