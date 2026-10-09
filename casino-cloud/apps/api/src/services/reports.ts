import { pool } from '../db';

export type ColumnType = 'text' | 'money' | 'number' | 'percent' | 'datetime' | 'date';

export interface Column {
  key: string;
  label: string;
  type: ColumnType;
  /** Include in the totals row (default: true for money/number). */
  total?: boolean;
}

export interface ReportFilters {
  from: string; // YYYY-MM-DD, business day in the casino's timezone
  to: string;
  floorId?: string;
  manufacturer?: string;
  machineId?: string;
  employeeId?: string;
}

export interface ReportDef {
  key: string;
  title: string;
  description: string;
  group: 'Gaming' | 'Tickets & Cash' | 'Operations';
  filters: Array<'machine' | 'employee'>;
  columns: Column[];
  sql: string;
}

/**
 * Every report query starts from this parameter CTE so all parameters are typed even when unused.
 * The period is [from 00:00, to+1 00:00) in the casino's local time.
 */
const P = `WITH p AS (
  SELECT $1::uuid AS org, $2::uuid AS casino,
    ($3::date)::timestamp AT TIME ZONE $5::text AS t_from,
    ($4::date + 1)::timestamp AT TIME ZONE $5::text AS t_to,
    $5::text AS tz, $6::uuid AS floor, $7::text AS manu, $8::uuid AS machine, $9::uuid AS emp
)`;
const MACHINE_FILTER = `(p.floor IS NULL OR m.floor_id = p.floor) AND (p.manu IS NULL OR mm.manufacturer = p.manu) AND (p.machine IS NULL OR m.id = p.machine)`;
const GAMING_AGG = `
  COALESCE(sum(t.amount) FILTER (WHERE t.type = 'WAGER'), 0) AS coin_in,
  COALESCE(sum(t.amount) FILTER (WHERE t.type = 'WIN'), 0) AS coin_out,
  COALESCE(sum(t.amount) FILTER (WHERE t.type = 'JACKPOT'), 0) AS jackpots,
  COALESCE(sum(t.amount) FILTER (WHERE t.type = 'WAGER'), 0) - COALESCE(sum(t.amount) FILTER (WHERE t.type IN ('WIN','JACKPOT')), 0) AS ggr`;
const HOLD = `CASE WHEN sum(t.amount) FILTER (WHERE t.type = 'WAGER') > 0 THEN
  (sum(t.amount) FILTER (WHERE t.type = 'WAGER') - COALESCE(sum(t.amount) FILTER (WHERE t.type IN ('WIN','JACKPOT')), 0)) / sum(t.amount) FILTER (WHERE t.type = 'WAGER') END AS hold`;

const money = (key: string, label: string): Column => ({ key, label, type: 'money' });

export const REPORTS: ReportDef[] = [
  {
    key: 'daily-gaming', title: 'Daily Gaming Report', group: 'Gaming', filters: ['machine'],
    description: 'Coin In, Coin Out, jackpots, GGR and hold per business day.',
    columns: [
      { key: 'day', label: 'Day', type: 'date' }, money('coin_in', 'Coin In'), money('coin_out', 'Coin Out'), money('jackpots', 'Jackpots'),
      money('ggr', 'GGR'), { key: 'hold', label: 'Hold', type: 'percent' }, { key: 'wagers', label: 'Wagers', type: 'number' },
      money('tickets_in', 'Tickets In'), money('tickets_out', 'Tickets Out'), money('cash_in', 'Cash In'),
    ],
    sql: `${P} SELECT (t.occurred_at AT TIME ZONE p.tz)::date AS day, ${GAMING_AGG}, ${HOLD},
        count(*) FILTER (WHERE t.type = 'WAGER') AS wagers,
        COALESCE(sum(t.amount) FILTER (WHERE t.type = 'TICKET_IN'), 0) AS tickets_in,
        COALESCE(sum(t.amount) FILTER (WHERE t.type = 'TICKET_OUT'), 0) AS tickets_out,
        COALESCE(sum(t.amount) FILTER (WHERE t.type = 'CASH_IN'), 0) AS cash_in
      FROM p, gaming_transactions t JOIN machines m ON m.id = t.machine_id LEFT JOIN machine_models mm ON mm.id = m.model_id
      WHERE t.org_id = p.org AND t.casino_id = p.casino AND t.occurred_at >= p.t_from AND t.occurred_at < p.t_to AND ${MACHINE_FILTER}
      GROUP BY 1 ORDER BY 1`,
  },
  {
    key: 'machine-performance', title: 'Machine Performance', group: 'Gaming', filters: ['machine'],
    description: 'Per machine result for the period, sorted by GGR.',
    columns: [
      { key: 'asset_no', label: 'Asset', type: 'text' }, { key: 'manufacturer', label: 'Manufacturer', type: 'text' },
      { key: 'game', label: 'Game', type: 'text' }, { key: 'floor', label: 'Floor', type: 'text' },
      money('coin_in', 'Coin In'), money('coin_out', 'Coin Out'), money('jackpots', 'Jackpots'), money('ggr', 'GGR'),
      { key: 'hold', label: 'Hold', type: 'percent' }, { key: 'wagers', label: 'Wagers', type: 'number' },
    ],
    sql: `${P} SELECT m.asset_no, mm.manufacturer, m.game, f.name AS floor, ${GAMING_AGG}, ${HOLD},
        count(t.id) FILTER (WHERE t.type = 'WAGER') AS wagers
      FROM p, machines m LEFT JOIN machine_models mm ON mm.id = m.model_id LEFT JOIN floors f ON f.id = m.floor_id
      LEFT JOIN gaming_transactions t ON t.machine_id = m.id AND t.occurred_at >= (SELECT t_from FROM p) AND t.occurred_at < (SELECT t_to FROM p)
      WHERE m.org_id = p.org AND m.casino_id = p.casino AND ${MACHINE_FILTER}
      GROUP BY m.id, mm.manufacturer, f.name ORDER BY ggr DESC`,
  },
  {
    key: 'manufacturer-performance', title: 'Manufacturer Performance', group: 'Gaming', filters: ['machine'],
    description: 'Results grouped by manufacturer, including GGR per machine.',
    columns: [
      { key: 'manufacturer', label: 'Manufacturer', type: 'text' }, { key: 'machines', label: 'Machines', type: 'number' },
      money('coin_in', 'Coin In'), money('coin_out', 'Coin Out'), money('jackpots', 'Jackpots'), money('ggr', 'GGR'),
      { key: 'hold', label: 'Hold', type: 'percent' }, { key: 'ggr_per_machine', label: 'GGR / Machine', type: 'money', total: false },
    ],
    sql: `${P} SELECT COALESCE(mm.manufacturer, 'Unknown') AS manufacturer, count(DISTINCT m.id) AS machines, ${GAMING_AGG}, ${HOLD},
        (COALESCE(sum(t.amount) FILTER (WHERE t.type = 'WAGER'), 0) - COALESCE(sum(t.amount) FILTER (WHERE t.type IN ('WIN','JACKPOT')), 0)) / count(DISTINCT m.id) AS ggr_per_machine
      FROM p, machines m LEFT JOIN machine_models mm ON mm.id = m.model_id
      LEFT JOIN gaming_transactions t ON t.machine_id = m.id AND t.occurred_at >= (SELECT t_from FROM p) AND t.occurred_at < (SELECT t_to FROM p)
      WHERE m.org_id = p.org AND m.casino_id = p.casino AND ${MACHINE_FILTER}
      GROUP BY 1 ORDER BY ggr DESC`,
  },
  {
    key: 'jackpot-wins', title: 'Jackpot Wins', group: 'Gaming', filters: ['machine'],
    description: 'Every jackpot hit in the period.',
    columns: [{ key: 'occurred_at', label: 'Time', type: 'datetime' }, { key: 'asset_no', label: 'Asset', type: 'text' }, { key: 'manufacturer', label: 'Manufacturer', type: 'text' }, { key: 'game', label: 'Game', type: 'text' }, money('amount', 'Amount')],
    sql: `${P} SELECT t.occurred_at, m.asset_no, mm.manufacturer, m.game, t.amount
      FROM p, gaming_transactions t JOIN machines m ON m.id = t.machine_id LEFT JOIN machine_models mm ON mm.id = m.model_id
      WHERE t.org_id = p.org AND t.casino_id = p.casino AND t.type = 'JACKPOT' AND t.occurred_at >= p.t_from AND t.occurred_at < p.t_to AND ${MACHINE_FILTER}
      ORDER BY t.occurred_at DESC`,
  },
  {
    key: 'tickets', title: 'Tickets (TITO)', group: 'Tickets & Cash', filters: ['machine'],
    description: 'Tickets issued in the period with their current status.',
    columns: [
      { key: 'barcode', label: 'Barcode', type: 'text' }, money('amount', 'Amount'), { key: 'status', label: 'Status', type: 'text' },
      { key: 'issued_at', label: 'Issued', type: 'datetime' }, { key: 'issued_by', label: 'Issued by', type: 'text' },
      { key: 'redeemed_at', label: 'Redeemed', type: 'datetime' }, { key: 'redeemed_by', label: 'Redeemed at', type: 'text' },
      { key: 'expires_at', label: 'Expires', type: 'datetime' },
    ],
    sql: `${P} SELECT tk.barcode, tk.amount, tk.status, tk.issued_at, COALESCE(m.asset_no, ei.name) AS issued_by, tk.redeemed_at,
        COALESCE(mr.asset_no, er.name) AS redeemed_by, tk.expires_at
      FROM p, tickets tk LEFT JOIN machines m ON m.id = tk.issued_by_machine_id LEFT JOIN machine_models mm ON mm.id = m.model_id
      LEFT JOIN employees ei ON ei.id = tk.issued_by_employee LEFT JOIN machines mr ON mr.id = tk.redeemed_machine_id LEFT JOIN employees er ON er.id = tk.redeemed_by_employee
      WHERE tk.org_id = p.org AND tk.casino_id = p.casino AND tk.issued_at >= p.t_from AND tk.issued_at < p.t_to
        AND (p.floor IS NULL AND p.manu IS NULL AND p.machine IS NULL OR (m.id IS NOT NULL AND ${MACHINE_FILTER}))
      ORDER BY tk.issued_at DESC`,
  },
  {
    key: 'cashier-sessions', title: 'Cashier Sessions', group: 'Tickets & Cash', filters: ['employee'],
    description: 'Shifts with opening, expected and counted balance and differences.',
    columns: [
      { key: 'opened_at', label: 'Opened', type: 'datetime' }, { key: 'closed_at', label: 'Closed', type: 'datetime' }, { key: 'desk', label: 'Desk', type: 'text' },
      { key: 'employee', label: 'Employee', type: 'text' }, { key: 'status', label: 'Status', type: 'text' }, money('opening_balance', 'Opening'),
      money('expected_balance', 'Expected'), money('counted_balance', 'Counted'), money('difference', 'Difference'),
    ],
    sql: `${P} SELECT s.opened_at, s.closed_at, d.name AS desk, e.name AS employee, s.status, s.opening_balance, s.expected_balance, s.counted_balance, s.difference
      FROM p, cashier_sessions s JOIN cash_desks d ON d.id = s.cash_desk_id JOIN employees e ON e.id = s.employee_id
      WHERE s.org_id = p.org AND s.casino_id = p.casino AND s.opened_at >= p.t_from AND s.opened_at < p.t_to AND (p.emp IS NULL OR s.employee_id = p.emp)
      ORDER BY s.opened_at DESC`,
  },
  {
    key: 'cash-transactions', title: 'Cash Transactions', group: 'Tickets & Cash', filters: ['employee'],
    description: 'Every drawer movement (signed: + into the drawer, - out of it).',
    columns: [
      { key: 'created_at', label: 'Time', type: 'datetime' }, { key: 'desk', label: 'Desk', type: 'text' }, { key: 'employee', label: 'Employee', type: 'text' },
      { key: 'type', label: 'Type', type: 'text' }, money('amount', 'Amount'), { key: 'reference', label: 'Reference', type: 'text' }, { key: 'asset_no', label: 'Machine', type: 'text' },
    ],
    sql: `${P} SELECT ct.created_at, d.name AS desk, e.name AS employee, ct.type, ct.amount, ct.reference, m.asset_no
      FROM p, cash_transactions ct JOIN cashier_sessions s ON s.id = ct.session_id JOIN cash_desks d ON d.id = s.cash_desk_id
      JOIN employees e ON e.id = ct.employee_id LEFT JOIN machines m ON m.id = ct.machine_id
      WHERE ct.org_id = p.org AND ct.casino_id = p.casino AND ct.created_at >= p.t_from AND ct.created_at < p.t_to AND (p.emp IS NULL OR ct.employee_id = p.emp)
      ORDER BY ct.id DESC`,
  },
  {
    key: 'collections', title: 'Drop Collections', group: 'Tickets & Cash', filters: ['machine', 'employee'],
    description: 'Machine cashbox counts against meter values.',
    columns: [
      { key: 'created_at', label: 'Time', type: 'datetime' }, { key: 'asset_no', label: 'Machine', type: 'text' }, money('expected_cash', 'Exp. Cash'),
      money('expected_tickets', 'Exp. Tickets'), money('counted_cash', 'Cnt. Cash'), money('counted_tickets', 'Cnt. Tickets'),
      money('difference', 'Difference'), { key: 'collected_by', label: 'Collected by', type: 'text' },
    ],
    sql: `${P} SELECT cc.created_at, m.asset_no, cc.expected_cash, cc.expected_tickets, cc.counted_cash, cc.counted_tickets, cc.difference, e.name AS collected_by
      FROM p, cash_collections cc JOIN machines m ON m.id = cc.machine_id LEFT JOIN machine_models mm ON mm.id = m.model_id JOIN employees e ON e.id = cc.collected_by
      WHERE cc.org_id = p.org AND cc.casino_id = p.casino AND cc.created_at >= p.t_from AND cc.created_at < p.t_to AND ${MACHINE_FILTER} AND (p.emp IS NULL OR cc.collected_by = p.emp)
      ORDER BY cc.created_at DESC`,
  },
  {
    key: 'alerts', title: 'Alerts', group: 'Operations', filters: ['machine'],
    description: 'All alerts raised in the period and how they were handled.',
    columns: [
      { key: 'created_at', label: 'Raised', type: 'datetime' }, { key: 'severity', label: 'Severity', type: 'text' }, { key: 'type', label: 'Type', type: 'text' },
      { key: 'message', label: 'Message', type: 'text' }, { key: 'status', label: 'Status', type: 'text' }, { key: 'resolved_at', label: 'Resolved', type: 'datetime' },
    ],
    sql: `${P} SELECT a.created_at, a.severity, a.type, a.message, a.status, a.resolved_at
      FROM p, alerts a LEFT JOIN machines m ON m.id = a.machine_id LEFT JOIN machine_models mm ON mm.id = m.model_id
      WHERE a.org_id = p.org AND a.casino_id = p.casino AND a.created_at >= p.t_from AND a.created_at < p.t_to
        AND (p.floor IS NULL AND p.manu IS NULL AND p.machine IS NULL OR (m.id IS NOT NULL AND ${MACHINE_FILTER}))
      ORDER BY a.created_at DESC`,
  },
  {
    key: 'audit', title: 'Audit Trail', group: 'Operations', filters: ['employee'],
    description: 'Security and configuration relevant actions.',
    columns: [
      { key: 'created_at', label: 'Time', type: 'datetime' }, { key: 'actor_name', label: 'Actor', type: 'text' }, { key: 'action', label: 'Action', type: 'text' },
      { key: 'entity', label: 'Entity', type: 'text' }, { key: 'details', label: 'Details', type: 'text' },
    ],
    sql: `${P} SELECT a.created_at, a.actor_name, a.action, concat_ws(' ', a.entity_type, left(a.entity_id, 12)) AS entity, a.details::text AS details
      FROM p, audit_logs a
      WHERE a.org_id = p.org AND (a.casino_id IS NULL OR a.casino_id = p.casino) AND a.created_at >= p.t_from AND a.created_at < p.t_to AND (p.emp IS NULL OR a.actor_id = p.emp)
      ORDER BY a.id DESC`,
  },
];

export const ROW_LIMIT = 20000;

export async function runReport(def: ReportDef, orgId: string, casinoId: string, timezone: string, f: ReportFilters) {
  const r = await pool.query(`${def.sql} LIMIT ${ROW_LIMIT + 1}`, [
    orgId, casinoId, f.from, f.to, timezone, f.floorId ?? null, f.manufacturer ?? null, f.machineId ?? null, f.employeeId ?? null,
  ]);
  const truncated = r.rows.length > ROW_LIMIT;
  const rows = truncated ? r.rows.slice(0, ROW_LIMIT) : r.rows;
  const totals: Record<string, number> = {};
  for (const c of def.columns)
    if ((c.total ?? (c.type === 'money' || c.type === 'number')) && c.type !== 'percent')
      totals[c.key] = Math.round(rows.reduce((s, row) => s + (Number(row[c.key]) || 0), 0) * 100) / 100;
  return { rows, totals, truncated };
}
