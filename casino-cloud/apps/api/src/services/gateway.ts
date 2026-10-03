import { createHash } from 'node:crypto';
import { withTransaction, writeAudit } from '@m1/database';
import { deriveMachineStatus, type GatewayRemoteConfig, type MachineStatus } from '@m1/shared';
import { bus, type BusMessage } from '../bus';
import { config } from '../config';
import { pool } from '../db';
import { HttpError } from '../auth';
import { openAlert, resolveAlerts } from './alerts';
import type { GatewayIdentity } from './ingest';

export async function authenticateGateway(deviceId?: string, key?: string): Promise<GatewayIdentity> {
  if (!deviceId || !key) throw new HttpError(401, 'Missing gateway credentials');
  const res = await pool.query('SELECT id, org_id, casino_id, device_id, api_key_hash FROM gateways WHERE device_id = $1', [deviceId]);
  const gw = res.rows[0];
  const hash = createHash('sha256').update(key).digest('hex');
  if (!gw || gw.api_key_hash !== hash) throw new HttpError(401, 'Invalid gateway credentials');
  return { id: gw.id, orgId: gw.org_id, casinoId: gw.casino_id, deviceId: gw.device_id };
}

export interface HeartbeatInput {
  version?: string;
  stats?: Record<string, unknown>;
  machines?: Array<{ machineId: string; status: MachineStatus }>;
}

/** Records a heartbeat, reconciles machine connectivity and returns the remote configuration. */
export async function heartbeat(gw: GatewayIdentity, input: HeartbeatInput, ip: string): Promise<GatewayRemoteConfig> {
  const out: BusMessage[] = [];
  const wasOffline = await withTransaction(pool, async (db) => {
    const prev = await db.query('SELECT status FROM gateways WHERE id = $1 FOR NO KEY UPDATE', [gw.id]);
    await db.query(
      `UPDATE gateways SET status = 'ONLINE', last_heartbeat_at = now(), last_ip = $2, version = $3, stats = $4 WHERE id = $1`,
      [gw.id, ip, input.version ?? null, input.stats ?? {}],
    );
    const offline = prev.rows[0].status !== 'ONLINE';
    if (offline) {
      await resolveAlerts(db, { orgId: gw.orgId, casinoId: gw.casinoId, type: 'GATEWAY_OFFLINE', gatewayId: gw.id }, out);
      out.push({ kind: 'gateway.status', orgId: gw.orgId, casinoId: gw.casinoId, gatewayId: gw.id, status: 'ONLINE' });
    }

    // Connectivity snapshot from the gateway is the source of truth for "online".
    for (const snap of input.machines ?? []) {
      const r = await db.query('SELECT * FROM machines WHERE org_id = $1 AND gateway_id = $2 AND machine_code = $3 FOR NO KEY UPDATE', [gw.orgId, gw.id, snap.machineId]);
      const m = r.rows[0];
      if (!m) continue;
      const online = snap.status !== 'OFFLINE';
      if (m.online === online) continue;
      const status = deriveMachineStatus({
        online, disabled: m.disabled, maintenance: m.maintenance, errorCode: m.error_code, doorOpen: m.door_open,
        cashboxOpen: m.cashbox_open, printerError: m.printer_error, jackpotPending: m.jackpot_pending,
      });
      await db.query('UPDATE machines SET online = $2, status = $3, status_changed_at = now(), last_communication_at = CASE WHEN $2 THEN now() ELSE last_communication_at END WHERE id = $1', [m.id, online, status]);
      const ctx = { orgId: gw.orgId, casinoId: gw.casinoId, machineId: m.id };
      if (online) await resolveAlerts(db, { ...ctx, type: 'MACHINE_OFFLINE' }, out);
      else await openAlert(db, { ...ctx, type: 'MACHINE_OFFLINE', severity: 'CRITICAL', message: `Machine ${m.asset_no} offline` }, out);
      out.push({ kind: 'machine.status', orgId: gw.orgId, casinoId: gw.casinoId, machineId: m.id, assetNo: m.asset_no, status });
    }
    return offline;
  });
  out.forEach((m) => bus.publish(m));
  if (wasOffline)
    await writeAudit(pool, { orgId: gw.orgId, casinoId: gw.casinoId, actorType: 'GATEWAY', actorName: gw.deviceId, action: 'gateway.online', entityType: 'gateway', entityId: gw.id, ip });
  return remoteConfig(gw);
}

export async function remoteConfig(gw: GatewayIdentity): Promise<GatewayRemoteConfig> {
  const [g, machines, commands] = await Promise.all([
    pool.query('SELECT config FROM gateways WHERE id = $1', [gw.id]),
    pool.query(
      `SELECT m.machine_code, m.asset_no, m.game, m.denomination, m.adapter_key, m.adapter_config, mm.manufacturer, mm.name AS model
       FROM machines m LEFT JOIN machine_models mm ON mm.id = m.model_id
       WHERE m.gateway_id = $1 AND m.org_id = $2 ORDER BY m.asset_no`,
      [gw.id, gw.orgId],
    ),
    pool.query(
      `UPDATE machine_commands c SET status = 'SENT' FROM machines m
       WHERE c.machine_id = m.id AND c.gateway_id = $1 AND c.status = 'PENDING'
       RETURNING c.id, c.type, c.payload, m.machine_code`,
      [gw.id],
    ),
  ]);
  const sim = g.rows[0]?.config?.simulation ?? { running: false, eventsPerSecond: 2 };
  return {
    gatewayId: gw.deviceId,
    casinoId: gw.casinoId,
    heartbeatIntervalSec: 2,
    simulation: { running: !!sim.running, eventsPerSecond: Number(sim.eventsPerSecond ?? 2) },
    machines: machines.rows.map((r) => ({
      machineId: r.machine_code,
      assetNo: r.asset_no,
      manufacturer: r.manufacturer ?? 'Unknown',
      model: r.model ?? 'Unknown',
      game: r.game ?? '',
      denomination: r.denomination,
      adapter: r.adapter_key,
      adapterConfig: r.adapter_config,
    })),
    pendingCommands: commands.rows.map((r) => ({ id: r.id, type: r.type, payload: r.payload, machineId: r.machine_code })),
  };
}

/** Marks gateways without heartbeat as offline. Their machines become OFFLINE until the gateway reports again. */
export function startGatewayWatchdog() {
  const tick = async () => {
    const stale = await pool.query(
      `SELECT id, org_id, casino_id, device_id, name FROM gateways
       WHERE status = 'ONLINE' AND last_heartbeat_at < now() - make_interval(secs => $1)`,
      [config.gatewayTimeoutSec],
    );
    for (const gw of stale.rows) {
      const out: BusMessage[] = [];
      await withTransaction(pool, async (db) => {
        await db.query(`UPDATE gateways SET status = 'OFFLINE' WHERE id = $1`, [gw.id]);
        await openAlert(db, { orgId: gw.org_id, casinoId: gw.casino_id, gatewayId: gw.id, type: 'GATEWAY_OFFLINE', severity: 'CRITICAL', message: `Gateway ${gw.name} (${gw.device_id}) offline` }, out);
        const ms = await db.query(
          `UPDATE machines SET online = false, status = 'OFFLINE', status_changed_at = now()
           WHERE gateway_id = $1 AND online RETURNING id, asset_no`,
          [gw.id],
        );
        for (const m of ms.rows) out.push({ kind: 'machine.status', orgId: gw.org_id, casinoId: gw.casino_id, machineId: m.id, assetNo: m.asset_no, status: 'OFFLINE' });
        out.push({ kind: 'gateway.status', orgId: gw.org_id, casinoId: gw.casino_id, gatewayId: gw.id, status: 'OFFLINE' });
      });
      out.forEach((m) => bus.publish(m));
      await writeAudit(pool, { orgId: gw.org_id, casinoId: gw.casino_id, actorType: 'SYSTEM', actorName: 'watchdog', action: 'gateway.offline', entityType: 'gateway', entityId: gw.id });
    }
  };
  const timer = setInterval(() => tick().catch((err) => console.error('[watchdog]', err)), 5000);
  return () => clearInterval(timer);
}
