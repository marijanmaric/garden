import { withTransaction } from '@m1/database';
import { pool } from '../db';
import { expireStaleTransfers } from './cashless';
import { retryFailedHandpayResets } from './handpays';
import { releaseExpiredHolds } from './ticket-holds';

/**
 * Periodic housekeeping: expires TITO tickets, releases timed-out ticket holds, expires stale wallet
 * transfers (releasing reservations) and retries failed handpay machine resets.
 */
export function startMaintenance() {
  const tick = async () => {
    await pool.query(
      `WITH expired AS (
         UPDATE tickets SET status = 'EXPIRED', status_reason = 'Expiry date reached'
         WHERE status = 'VALID' AND expires_at <= now() RETURNING id, org_id
       )
       INSERT INTO ticket_events (org_id, ticket_id, action) SELECT org_id, id, 'EXPIRED' FROM expired`,
    );
    await withTransaction(pool, (db) => releaseExpiredHolds(db));
    await withTransaction(pool, (db) => expireStaleTransfers(db));
    await withTransaction(pool, (db) => retryFailedHandpayResets(db));
  };
  void tick().catch((err) => console.error('[maintenance]', err));
  const timer = setInterval(() => tick().catch((err) => console.error('[maintenance]', err)), 15_000);
  return () => clearInterval(timer);
}
