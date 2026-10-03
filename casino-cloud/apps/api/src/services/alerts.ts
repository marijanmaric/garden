import type { PoolClient } from '@m1/database';
import type { BusMessage } from '../bus';

export interface AlertInput {
  orgId: string;
  casinoId: string;
  machineId?: string | null;
  gatewayId?: string | null;
  type: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  message: string;
}

/** Opens an alert unless the same condition is already open for the same machine / gateway. */
export async function openAlert(db: PoolClient, a: AlertInput, out: BusMessage[]): Promise<void> {
  const existing = await db.query(
    `SELECT 1 FROM alerts WHERE org_id = $1 AND type = $2 AND machine_id IS NOT DISTINCT FROM $3
       AND gateway_id IS NOT DISTINCT FROM $4 AND status <> 'RESOLVED' LIMIT 1`,
    [a.orgId, a.type, a.machineId ?? null, a.gatewayId ?? null],
  );
  if (existing.rowCount) return;
  const res = await db.query(
    `INSERT INTO alerts (org_id, casino_id, machine_id, gateway_id, type, severity, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [a.orgId, a.casinoId, a.machineId ?? null, a.gatewayId ?? null, a.type, a.severity, a.message],
  );
  out.push({
    kind: 'alert.created',
    orgId: a.orgId,
    casinoId: a.casinoId,
    alert: { id: res.rows[0].id, type: a.type, severity: a.severity, message: a.message, machineId: a.machineId ?? null },
  });
}

/** Resolves open alerts of a type when the underlying condition clears. */
export async function resolveAlerts(
  db: PoolClient,
  q: { orgId: string; casinoId: string; type: string; machineId?: string | null; gatewayId?: string | null },
  out: BusMessage[],
): Promise<void> {
  const res = await db.query(
    `UPDATE alerts SET status = 'RESOLVED', resolved_at = now()
     WHERE org_id = $1 AND type = $2 AND machine_id IS NOT DISTINCT FROM $3 AND gateway_id IS NOT DISTINCT FROM $4
       AND status <> 'RESOLVED' RETURNING id`,
    [q.orgId, q.type, q.machineId ?? null, q.gatewayId ?? null],
  );
  for (const r of res.rows) out.push({ kind: 'alert.updated', orgId: q.orgId, casinoId: q.casinoId, alertId: r.id, status: 'RESOLVED' });
}
