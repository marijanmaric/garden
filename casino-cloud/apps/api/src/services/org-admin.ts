import type { PoolClient } from '@m1/database';
import { writeAudit } from '@m1/database';
import {
  PRODUCT_MODULE_DEFS, dependentsOf,
  type LimitKey, type ProductModule,
} from '@m1/shared';
import { HttpError } from '../auth';
import { EntitlementError, invalidateEntitlements, loadEntitlements, requireLimit, usageReport, type OrgEntitlements } from './entitlements';

/**
 * Organisation administration shared by the platform portal and the customer admin: module switches with
 * dependency and prerequisite checks, the organisation overview, module cards (commercial state next to the
 * operational rail state), casino and machine creation under HARD limits, and the change audit (old value,
 * new value, reason) written into the customer's audit chain and, for platform actions, the platform chain.
 */
type Db = Pick<PoolClient, 'query'>;

export interface AdminActor {
  orgId: string; // the actor's own organisation
  employeeId: string;
  email: string;
  ip?: string;
  platform: boolean;
}

const names = (ms: readonly ProductModule[]) => ms.map((m) => PRODUCT_MODULE_DEFS[m].name).join(', ');

/** One change, audited with old and new value and the reason, in the target org (and the platform chain). */
export async function auditChange(
  db: PoolClient, a: AdminActor, targetOrgId: string,
  c: { action: string; entityType: string; entityId?: string | null; casinoId?: string | null; old: unknown; new: unknown; reason?: string | null; extra?: Record<string, unknown> },
) {
  const details = { old: c.old ?? null, new: c.new ?? null, reason: c.reason ?? null, ...(c.extra ?? {}), ...(a.platform ? { platformActor: a.email } : {}) };
  const base = { actorType: 'EMPLOYEE' as const, actorId: a.employeeId, actorName: a.email, ip: a.ip, action: c.action, entityType: c.entityType, entityId: c.entityId ?? null };
  await writeAudit(db, { ...base, orgId: targetOrgId, casinoId: c.casinoId ?? null, details });
  if (a.platform && targetOrgId !== a.orgId) await writeAudit(db, { ...base, orgId: a.orgId, details: { ...details, targetOrgId } });
}

// ---- prerequisite and dependency checks -------------------------------------------------------

async function n(db: Db, sql: string, p: unknown[]): Promise<number> {
  return (await db.query(sql, p)).rows[0].n;
}

/**
 * Why a module cannot be switched on (empty = it can). Dependencies must be effective and the organisation
 * must have the operational basis the module works on.
 */
export async function enableBlockers(db: Db, e: OrgEntitlements, m: ProductModule, opts: { ignorePurchase?: boolean } = {}): Promise<string[]> {
  const out: string[] = [];
  const st = e.modules.find((x) => x.module === m)!;
  if (!opts.ignorePurchase && !st.purchased) out.push(`${PRODUCT_MODULE_DEFS[m].name} is not included in the plan.`);
  const deps = PRODUCT_MODULE_DEFS[m].requires.filter((d) => d !== 'CORE' && !e.inUse.has(d));
  if (deps.length) out.push(`${PRODUCT_MODULE_DEFS[m].name} requires ${names(deps)}${PRODUCT_MODULE_DEFS[m].requiresWhy ? `: ${PRODUCT_MODULE_DEFS[m].requiresWhy}` : '.'}`);
  const casinos = await n(db, `SELECT count(*)::int n FROM casinos WHERE org_id = $1 AND status = 'ACTIVE'`, [e.orgId]);
  if (m !== 'CORE' && m !== 'REPORTING' && m !== 'ADVANCED_RECONCILIATION' && !casinos) out.push('The organisation has no active casino yet.');
  if (m === 'VAULT' || m === 'CASH' || m === 'MACHINE') {
    const noVault = await n(db, `SELECT count(*)::int n FROM casinos c WHERE c.org_id = $1 AND c.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM vaults v WHERE v.casino_id = c.id AND v.active)`, [e.orgId]);
    if (noVault) out.push(`${noVault} active casino(s) have no active vault.`);
  }
  if (m === 'CASH') {
    const noDesk = await n(db, `SELECT count(*)::int n FROM casinos c WHERE c.org_id = $1 AND c.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM cash_desks d WHERE d.casino_id = c.id AND d.active)`, [e.orgId]);
    if (noDesk) out.push(`${noDesk} active casino(s) have no active cash desk.`);
  }
  if (m === 'MACHINE' || m === 'CASHLESS' || m === 'TITO' || m === 'HANDPAY') {
    const machines = await n(db, `SELECT count(*)::int n FROM machines m JOIN casinos c ON c.id = m.casino_id WHERE m.org_id = $1 AND c.status = 'ACTIVE'`, [e.orgId]);
    if (!machines) out.push('The organisation has no machine yet.');
  }
  return out;
}

/**
 * Why a module cannot be switched off (empty = it can): enabled modules depending on it, and open money items
 * that would be stranded (an open shift could no longer be closed, a pending transfer no longer confirmed).
 */
export async function disableBlockers(db: Db, e: OrgEntitlements, m: ProductModule): Promise<string[]> {
  const out: string[] = [];
  if (m === 'CORE') return ['Core is always included.'];
  const deps = dependentsOf(m).filter((d) => e.inUse.has(d));
  if (deps.length) out.push(`${names(deps)} depend${deps.length === 1 ? 's' : ''} on ${PRODUCT_MODULE_DEFS[m].name}; switch ${deps.length === 1 ? 'it' : 'them'} off first.`);
  const open: Array<[ProductModule, string, string]> = [
    ['CASH', `SELECT count(*)::int n FROM cashier_sessions WHERE org_id = $1 AND status = 'OPEN'`, 'open cashier shift(s)'],
    ['HANDPAY', `SELECT count(*)::int n FROM handpays WHERE org_id = $1 AND status IN ('PENDING', 'APPROVED')`, 'unpaid handpay(s)'],
    ['CASHLESS', `SELECT count(*)::int n FROM wallet_transfers WHERE org_id = $1 AND status IN ('REQUESTED', 'SENT')`, 'pending wallet transfer(s)'],
    ['CASHLESS', `SELECT count(*)::int n FROM wallet_balances WHERE org_id = $1 AND (available_cents <> 0 OR reserved_cents <> 0)`, 'wallet(s) holding player money'],
    ['TITO', `SELECT count(*)::int n FROM tickets WHERE org_id = $1 AND status = 'VALID' AND expires_at > now()`, 'valid ticket(s) outstanding (player money)'],
    ['VAULT', `SELECT count(*)::int n FROM cash_movements WHERE org_id = $1 AND status = 'REQUESTED'`, 'open vault movement(s)'],
  ];
  for (const [mod, sql, label] of open) {
    if (mod !== m) continue;
    const c = await n(db, sql, [e.orgId]);
    if (c) out.push(`${c} ${label}.`);
  }
  return out;
}

/** Customer switch (org admin) or platform switch: on/off with checks, audited, cache invalidated. */
export async function setModuleEnabled(db: PoolClient, a: AdminActor, orgId: string, m: ProductModule, enabled: boolean, reason?: string) {
  if (m === 'CORE') throw new EntitlementError('MODULE_DISABLE_BLOCKED', 'Core is always included.', 409);
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`entitlements:${orgId}`]);
  const e = await loadEntitlements(orgId, db, true);
  const st = e.modules.find((x) => x.module === m)!;
  if (st.enabled === enabled) return { module: m, enabled, changed: false };
  if (enabled) {
    if (!st.purchased) throw new EntitlementError('MODULE_NOT_ENTITLED');
    const b = await enableBlockers(db, e, m);
    if (b.length) throw blocked('MODULE_ENABLE_BLOCKED', b);
  } else {
    const b = await disableBlockers(db, e, m);
    if (b.length) throw blocked('MODULE_DISABLE_BLOCKED', b);
  }
  await db.query(
    `INSERT INTO org_module_settings (org_id, module_key, enabled, updated_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (org_id, module_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, m, enabled, a.employeeId],
  );
  await auditChange(db, a, orgId, { action: enabled ? 'module.enabled' : 'module.disabled', entityType: 'module', entityId: null, old: { module: m, enabled: !enabled }, new: { module: m, enabled }, reason, extra: { module: m } });
  invalidateEntitlements(orgId);
  return { module: m, enabled, changed: true };
}

export function blocked(code: 'MODULE_ENABLE_BLOCKED' | 'MODULE_DISABLE_BLOCKED', reasons: string[]) {
  const err = new EntitlementError(code, reasons.join(' '), 409);
  err.body = { code, reasons };
  return err;
}

// ---- views ---------------------------------------------------------------------------------------

/** Operational rail state per module: casinos on the ledger / legacy, active freezes. */
async function railState(db: Db, orgId: string) {
  const [cut, frz, casinos, machines] = await Promise.all([
    db.query(`SELECT rail, count(DISTINCT coalesce(machine_id, casino_id))::int n FROM money_rail_cutovers WHERE org_id = $1 GROUP BY rail`, [orgId]),
    db.query(`SELECT rail, count(*)::int n FROM money_rail_freezes WHERE org_id = $1 AND lifted_at IS NULL GROUP BY rail`, [orgId]),
    n(db, `SELECT count(*)::int n FROM casinos WHERE org_id = $1 AND status = 'ACTIVE'`, [orgId]),
    n(db, `SELECT count(*)::int n FROM machines m JOIN casinos c ON c.id = m.casino_id WHERE m.org_id = $1 AND c.status = 'ACTIVE'`, [orgId]),
  ]);
  const cutovers = Object.fromEntries(cut.rows.map((r) => [r.rail, r.n]));
  const freezes = Object.fromEntries(frz.rows.map((r) => [r.rail, r.n]));
  return { cutovers, freezes, casinos, machines, globalFreezes: freezes.GLOBAL ?? 0 };
}

const MODULE_LIMITS: Partial<Record<ProductModule, LimitKey[]>> = {
  CORE: ['MAX_CASINOS', 'MAX_MACHINES', 'MAX_USERS', 'MAX_PLAYERS'],
  TITO: ['MAX_MONTHLY_TITO_VOLUME'],
  HANDPAY: ['MAX_MONTHLY_HANDPAYS'],
  CASHLESS: ['MAX_WALLETS', 'MAX_CASHLESS_PLAYERS'],
};

/** Module cards: purchased / enabled / dependency / operational state, limits with usage, the reason in words. */
export async function moduleCards(db: Db, e: OrgEntitlements) {
  const [rs, usage] = await Promise.all([railState(db, e.orgId), usageReport(db, e)]);
  return Promise.all(e.modules.map(async (m) => {
    const def = PRODUCT_MODULE_DEFS[m.module];
    const rails = def.rails.map((r) => {
      const scope = r === 'CASHLESS' ? 1 : r === 'MACHINE' ? rs.machines : rs.casinos;
      const onLedger = rs.cutovers[r] ?? 0;
      return { rail: r, onLedger, of: scope, mode: onLedger === 0 ? 'LEGACY' : onLedger >= scope ? 'LEDGER' : 'PARTIAL', frozen: rs.freezes[r] ?? 0 };
    });
    const frozen = rails.some((r) => r.frozen > 0) || (def.rails.length > 0 && rs.globalFreezes > 0);
    const operational = !m.effective ? 'NOT_AVAILABLE' : frozen ? 'FROZEN' : rails.length && rails.every((r) => r.mode === 'LEGACY') ? 'LEGACY' : 'OPERATIONAL';
    const state = m.effective && frozen ? 'TEMPORARILY_FROZEN' : m.state;
    let reason: string;
    if (m.module === 'CORE') reason = 'Always included.';
    else if (!m.purchased) reason = 'Not included in the current plan. Contact your administrator to upgrade.';
    else if (!m.enabled) reason = 'Purchased, switched off by your administrator.';
    else if (m.missing.length) reason = `Requires ${names(m.missing)}${def.requiresWhy ? `: ${def.requiresWhy}` : '.'}`;
    else if (!m.effective) reason = 'The subscription is not active: existing data stays readable.';
    else if (frozen) reason = 'Temporarily frozen by reconciliation until the difference is explained.';
    else if (operational === 'LEGACY') reason = 'Enabled; the money rail still runs in legacy mode until the cutover.';
    else reason = 'Enabled and operational.';
    const disableBlock = m.enabled && m.purchased && m.module !== 'CORE' ? await disableBlockers(db, e, m.module) : [];
    const enableBlock = !m.enabled && m.purchased ? await enableBlockers(db, e, m.module) : [];
    return {
      module: m.module, name: def.name, description: def.description, capabilities: def.capabilities,
      requires: def.requires.filter((d) => d !== 'CORE'), requiresWhy: def.requiresWhy ?? null, dependents: dependentsOf(m.module),
      purchased: m.purchased, source: m.source, enabled: m.enabled, missing: m.missing, effective: m.effective, state, operational, rails, reason,
      canEnable: !m.enabled && m.purchased && enableBlock.length === 0, enableBlockers: enableBlock,
      canDisable: m.enabled && m.purchased && m.module !== 'CORE' && disableBlock.length === 0, disableBlockers: disableBlock,
      limits: (MODULE_LIMITS[m.module] ?? []).map((k) => usage.find((u) => u.key === k)!),
    };
  }));
}

/** Organisation summary: counts, last activity, license status (used by the platform list and detail). */
export async function orgSummaries(db: Db, orgIds?: string[]) {
  const r = await db.query(
    `SELECT o.id, o.name, o.slug, o.status, o.status_reason, o.is_platform, o.created_at,
       s.status AS subscription_status, s.starts_at, s.ends_at, p.code AS plan_code, p.name AS plan_name, p.version AS plan_version,
       (SELECT count(*)::int FROM casinos c WHERE c.org_id = o.id) AS casinos,
       (SELECT count(*)::int FROM casinos c WHERE c.org_id = o.id AND c.status = 'ACTIVE') AS active_casinos,
       (SELECT count(*)::int FROM machines m WHERE m.org_id = o.id) AS machines,
       (SELECT count(*)::int FROM employees e WHERE e.org_id = o.id AND e.active) AS users,
       (SELECT max(created_at) FROM audit_logs a WHERE a.org_id = o.id) AS last_activity
     FROM organizations o LEFT JOIN subscriptions s ON s.org_id = o.id LEFT JOIN plans p ON p.id = s.plan_id
     WHERE ($1::uuid[] IS NULL OR o.id = ANY($1)) ORDER BY o.is_platform DESC, o.name`,
    [orgIds ?? null],
  );
  return Promise.all(r.rows.map(async (o) => {
    const e = await loadEntitlements(o.id, db);
    return { ...o, license: licenseStatus(e), modules: [...e.effective], inUse: [...e.inUse] };
  }));
}

export function licenseStatus(e: OrgEntitlements) {
  if (e.orgStatus !== 'ACTIVE') return 'ORG_DISABLED';
  if (!e.subscription) return 'NO_SUBSCRIPTION';
  if (!e.subscription.usable) return e.subscription.endsAt && new Date(e.subscription.endsAt) <= new Date() && ['ACTIVE', 'TRIAL'].includes(e.subscription.status) ? 'EXPIRED' : e.subscription.status;
  return e.subscription.status === 'TRIAL' ? 'TRIAL' : 'VALID';
}

// ---- casinos and machines --------------------------------------------------------------------

export async function createCasino(
  db: PoolClient, a: AdminActor, orgId: string,
  input: { code: string; name: string; city?: string; country?: string; timezone?: string; currency?: string },
) {
  await requireLimit(db, orgId, 'MAX_CASINOS');
  let id: string;
  try {
    id = (await db.query(
      `INSERT INTO casinos (org_id, code, name, city, country, timezone, currency) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [orgId, input.code, input.name, input.city ?? null, input.country ?? null, input.timezone ?? 'Europe/Vienna', input.currency ?? 'EUR'],
    )).rows[0].id;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'A casino with this code already exists');
    throw err;
  }
  // operational basis: money settings, vault, a cash desk and a floor; every rail starts LEGACY (cutover later)
  await db.query('INSERT INTO casino_money_settings (casino_id, org_id) VALUES ($1,$2)', [id, orgId]);
  await db.query(`INSERT INTO vaults (org_id, casino_id, name) VALUES ($1,$2,'Main Vault')`, [orgId, id]);
  await db.query(`INSERT INTO cash_desks (org_id, casino_id, name) VALUES ($1,$2,'Main Cage')`, [orgId, id]);
  await db.query(`INSERT INTO floors (org_id, casino_id, name) VALUES ($1,$2,'Main Floor')`, [orgId, id]);
  // the organisation's super admins see every casino; the creating customer admin gets access too
  await db.query(
    `INSERT INTO employee_casinos (employee_id, casino_id, org_id)
     SELECT e.id, $2, $1 FROM employees e WHERE e.org_id = $1 AND (e.role = 'SUPER_ADMIN' OR e.id = $3) ON CONFLICT DO NOTHING`,
    [orgId, id, a.employeeId],
  );
  await auditChange(db, a, orgId, { action: 'casino.created', entityType: 'casino', entityId: id, casinoId: id, old: null, new: input });
  invalidateEntitlements(orgId);
  return { id };
}

export async function setCasinoStatus(db: PoolClient, a: AdminActor, orgId: string, casinoId: string, status: 'ACTIVE' | 'INACTIVE', reason: string) {
  const c = (await db.query('SELECT id, status FROM casinos WHERE id = $1 AND org_id = $2 FOR NO KEY UPDATE', [casinoId, orgId])).rows[0];
  if (!c) throw new HttpError(404, 'Casino not found');
  if (c.status === status) return { id: casinoId, status, changed: false };
  if (status === 'ACTIVE') await requireLimit(db, orgId, 'MAX_CASINOS');
  else {
    const open = await n(db, `SELECT count(*)::int n FROM cashier_sessions WHERE casino_id = $1 AND status = 'OPEN'`, [casinoId]);
    if (open) throw new HttpError(409, `The casino has ${open} open cashier shift(s); close them before deactivating.`);
  }
  await db.query('UPDATE casinos SET status = $2, status_reason = $3 WHERE id = $1', [casinoId, status, reason]);
  await auditChange(db, a, orgId, { action: 'casino.status_changed', entityType: 'casino', entityId: casinoId, casinoId, old: { status: c.status }, new: { status }, reason });
  return { id: casinoId, status, changed: true };
}

export async function createMachine(
  db: PoolClient, a: AdminActor, orgId: string,
  input: { casinoId: string; machineCode: string; assetNo: string; serialNumber?: string; game?: string; denomination?: number; floorId?: string | null },
) {
  const c = (await db.query(`SELECT id FROM casinos WHERE id = $1 AND org_id = $2 AND status = 'ACTIVE'`, [input.casinoId, orgId])).rows[0];
  if (!c) throw new HttpError(404, 'Casino not found');
  if (input.floorId && !(await db.query('SELECT 1 FROM floors WHERE id = $1 AND casino_id = $2', [input.floorId, input.casinoId])).rowCount) throw new HttpError(404, 'Floor not found');
  await requireLimit(db, orgId, 'MAX_MACHINES');
  let id: string;
  try {
    id = (await db.query(
      `INSERT INTO machines (org_id, casino_id, floor_id, machine_code, asset_no, serial_number, game, denomination)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [orgId, input.casinoId, input.floorId ?? null, input.machineCode, input.assetNo, input.serialNumber ?? null, input.game ?? null, input.denomination ?? 0.01],
    )).rows[0].id;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'Machine code or asset number already in use');
    throw err;
  }
  await db.query('INSERT INTO machine_meters (machine_id, org_id) VALUES ($1,$2)', [id, orgId]);
  await auditChange(db, a, orgId, { action: 'machine.created', entityType: 'machine', entityId: id, casinoId: input.casinoId, old: null, new: input });
  return { id };
}
