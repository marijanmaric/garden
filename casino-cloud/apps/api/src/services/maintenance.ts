import { withTransaction } from '@m1/database';
import { pool } from '../db';
import { expireStaleTransfers } from './cashless';
import { replayDeferredHandpays, retryFailedHandpayResets } from './handpays';
import { releaseExpiredHolds } from './ticket-holds';
import { expireMovements } from './cash-ops';
import { reconcileLedgerCasinos } from './reconciliation';
import { bus } from '../bus';

/** Continuous reconciliation of ledger casinos (CASH / VAULT / global invariants), default every 15 minutes. */
const RECONCILE_EVERY_MS = Number(process.env.RECONCILE_INTERVAL_MS ?? 15 * 60_000);

/**
 * Periodic housekeeping: expires TITO tickets, releases timed-out ticket holds, expires stale wallet
 * transfers (releasing reservations), expires unconfirmed vault fills / drops (no money moved),
 * retries failed handpay machine resets and runs the scheduled reconciliation.
 */
export function startMaintenance() {
  const tick = async () => {
    await pool.query(
      `WITH expired AS (
         UPDATE tickets SET status = 'EXPIRED', status_reason = 'Expiry date reached'
         WHERE status = 'VALID' AND expires_at <= now()
           -- On a TITO rail that is on the ledger, expiry is a ledger transaction (TITO_EXPIRY), not this legacy update.
           AND NOT money_rail_ledger(org_id, casino_id, 'TITO', NULL)
         RETURNING id, org_id
       )
       INSERT INTO ticket_events (org_id, ticket_id, action) SELECT org_id, id, 'EXPIRED' FROM expired`,
    );
    await withTransaction(pool, (db) => releaseExpiredHolds(db));
    await withTransaction(pool, (db) => expireStaleTransfers(db));
    await withTransaction(pool, (db) => retryFailedHandpayResets(db));
    await withTransaction(pool, (db) => replayDeferredHandpays(db)); // safety net; the freeze lift replays first
    await withTransaction(pool, (db) => expireMovements(db));
    if (Date.now() - lastReconcile >= RECONCILE_EVERY_MS) {
      lastReconcile = Date.now();
      await reconcileLedgerCasinos(pool, (m) => bus.publish(m));
    }
  };
  let lastReconcile = 0;
  void tick().catch((err) => console.error('[maintenance]', err));
  const timer = setInterval(() => tick().catch((err) => console.error('[maintenance]', err)), 15_000);
  return () => clearInterval(timer);
}
