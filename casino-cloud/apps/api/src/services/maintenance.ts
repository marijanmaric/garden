import { pool } from '../db';

/** Periodic housekeeping: expires TITO tickets past their expiry date (with history entry). */
export function startMaintenance() {
  const tick = async () => {
    await pool.query(
      `WITH expired AS (
         UPDATE tickets SET status = 'EXPIRED', status_reason = 'Expiry date reached'
         WHERE status = 'VALID' AND expires_at <= now() RETURNING id, org_id
       )
       INSERT INTO ticket_events (org_id, ticket_id, action) SELECT org_id, id, 'EXPIRED' FROM expired`,
    );
  };
  void tick().catch((err) => console.error('[maintenance]', err));
  const timer = setInterval(() => tick().catch((err) => console.error('[maintenance]', err)), 60_000);
  return () => clearInterval(timer);
}
