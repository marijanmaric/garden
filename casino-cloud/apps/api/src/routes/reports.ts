import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@m1/database';
import { hasPermission } from '@m1/shared';
import { HttpError, actor, guard, scopeCasino } from '../auth';
import { pool } from '../db';
import { toCsv, toPdf, toXlsx } from '../services/export';
import { REPORTS, runReport } from '../services/reports';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function reportRoutes(app: FastifyInstance) {
  app.get('/api/v1/reports', { preHandler: guard('report.view') }, async () =>
    REPORTS.map(({ key, title, description, group, filters, columns }) => ({ key, title, description, group, filters, columns })),
  );

  /** Filter options: floors, manufacturers, machines and employees of the casino. */
  app.get('/api/v1/reports/options', { preHandler: guard('report.view') }, async (req) => {
    const casinoId = scopeCasino(req, z.object({ casinoId: z.string().uuid().optional() }).parse(req.query).casinoId);
    const [floors, manufacturers, machines, employees] = await Promise.all([
      pool.query('SELECT id, name FROM floors WHERE org_id = $1 AND casino_id = $2 ORDER BY sort_order', [req.auth.orgId, casinoId]),
      pool.query('SELECT DISTINCT mm.manufacturer FROM machines m JOIN machine_models mm ON mm.id = m.model_id WHERE m.org_id = $1 AND m.casino_id = $2 ORDER BY 1', [req.auth.orgId, casinoId]),
      pool.query('SELECT id, asset_no FROM machines WHERE org_id = $1 AND casino_id = $2 ORDER BY asset_no', [req.auth.orgId, casinoId]),
      pool.query('SELECT id, name FROM employees WHERE org_id = $1 ORDER BY name', [req.auth.orgId]),
    ]);
    return { floors: floors.rows, manufacturers: manufacturers.rows.map((r) => r.manufacturer), machines: machines.rows, employees: employees.rows };
  });

  app.get('/api/v1/reports/:key', { preHandler: guard('report.view') }, async (req, reply) => {
    const { key } = z.object({ key: z.string() }).parse(req.params);
    const def = REPORTS.find((r) => r.key === key);
    if (!def) throw new HttpError(404, 'Unknown report');
    const qs = z.object({
      casinoId: z.string().uuid().optional(), from: day, to: day, format: z.enum(['json', 'csv', 'xlsx', 'pdf']).default('json'),
      floorId: z.string().uuid().optional(), manufacturer: z.string().max(80).optional(), machineId: z.string().uuid().optional(), employeeId: z.string().uuid().optional(),
    }).parse(req.query);
    if (qs.from > qs.to) throw new HttpError(400, '"from" must not be after "to"');
    if (qs.format !== 'json' && !hasPermission(req.auth.role, 'report.export')) throw new HttpError(403, 'Missing permission report.export');
    const casinoId = scopeCasino(req, qs.casinoId);
    const c = (await pool.query('SELECT name, timezone FROM casinos WHERE id = $1', [casinoId])).rows[0];
    const result = await runReport(def, req.auth.orgId, casinoId, c.timezone, qs);
    if (qs.format === 'json') return { key: def.key, title: def.title, columns: def.columns, ...result };

    const subtitle = `${c.name} · ${qs.from} to ${qs.to} (${c.timezone}) · ${result.rows.length} rows${result.truncated ? ' (truncated)' : ''} · by ${req.auth.email}`;
    const input = { title: def.title, subtitle, columns: def.columns, rows: result.rows, totals: result.totals, timezone: c.timezone };
    const filename = `${def.key}_${qs.from}_${qs.to}.${qs.format}`;
    await writeAudit(pool, { ...actor(req), casinoId, action: 'report.exported', entityType: 'report', entityId: def.key, details: { format: qs.format, from: qs.from, to: qs.to, rows: result.rows.length } });
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    if (qs.format === 'csv') return reply.type('text/csv; charset=utf-8').send(toCsv(input));
    if (qs.format === 'xlsx') return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(await toXlsx(input));
    return reply.type('application/pdf').send(await toPdf(input));
  });
}
