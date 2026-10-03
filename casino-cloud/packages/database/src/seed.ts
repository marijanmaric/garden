import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type pg from 'pg';
import { MODULES, PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '@m1/shared';
import { writeAudit } from './audit';

export const DEMO_PASSWORD = 'demo';
export const DEMO_GATEWAY_ID = 'GW-VIE-001';

export function hashGatewayKey(key: string) {
  return createHash('sha256').update(key).digest('hex');
}

type Fixture = { id: string; label: string; kind: string; x: number; y: number; w: number; h: number };

interface FloorSeed {
  name: string;
  fixtures: Fixture[];
  slots: Array<[number, number, string]>; // x, y, position label
}

const FLOORS: FloorSeed[] = [
  {
    name: 'Main Floor',
    fixtures: [
      { id: 'bar', label: 'BAR', kind: 'bar', x: 640, y: 250, w: 420, h: 110 },
      { id: 'cashier', label: 'CASHIER', kind: 'cashier', x: 60, y: 530, w: 260, h: 100 },
      { id: 'entrance', label: 'ENTRANCE', kind: 'entrance', x: 520, y: 620, w: 180, h: 60 },
    ],
    slots: [
      [140, 110, 'A-01'], [240, 110, 'A-02'], [340, 110, 'A-03'], [440, 110, 'A-04'],
      [700, 110, 'B-01'], [800, 110, 'B-02'], [900, 110, 'B-03'], [1000, 110, 'B-04'],
      [140, 340, 'C-01'], [240, 340, 'C-02'], [340, 340, 'C-03'], [440, 340, 'C-04'],
    ],
  },
  {
    name: 'Floor 2',
    fixtures: [
      { id: 'lounge', label: 'LOUNGE', kind: 'bar', x: 760, y: 420, w: 340, h: 140 },
      { id: 'stairs', label: 'STAIRS', kind: 'entrance', x: 60, y: 560, w: 160, h: 90 },
    ],
    slots: [[200, 200, 'D-01'], [320, 200, 'D-02'], [440, 200, 'D-03'], [560, 200, 'D-04'], [680, 200, 'D-05']],
  },
  {
    name: 'VIP Area',
    fixtures: [
      { id: 'vipbar', label: 'VIP BAR', kind: 'bar', x: 420, y: 470, w: 360, h: 110 },
    ],
    slots: [[380, 240, 'V-01'], [600, 240, 'V-02'], [820, 240, 'V-03']],
  },
];

const MACHINE_TYPES = [
  { manufacturer: 'Novomatic', model: 'NV Panorama 43', games: ['Golden Pharaoh', 'Lucky Clover', 'Hot Sevens', 'Ocean Pearl'] },
  { manufacturer: 'IGT', model: 'IGT CrystalDual 27', games: ['Diamond Frenzy', 'Wild Buffalo', 'Liberty Bells', 'Cash Wheel'] },
  { manufacturer: 'EGT', model: 'EGT P-Line Curved', games: ['Burning Fruits', 'Shining Crown Classic', 'Royal Dice', 'Fire Joker'] },
  { manufacturer: 'SYNOT', model: 'SYNOT Evolution', games: ['Mystic Forest', 'Book of Gold', 'Lucky Tiger', 'Super Bar'] },
  { manufacturer: 'Zitro', model: 'Zitro Illusion 2', games: ['Link King', 'Dragon Riches', 'Bingo Royale', 'Mega Fortune Bingo'] },
];

const FIRST = ['Anna', 'Lukas', 'Sophie', 'David', 'Laura', 'Maximilian', 'Julia', 'Felix', 'Lena', 'Paul', 'Marie', 'Jonas', 'Elena', 'Tobias', 'Sarah'];
const LAST = ['Gruber', 'Huber', 'Wagner', 'Müller', 'Pichler', 'Steiner', 'Moser', 'Mayer', 'Hofer', 'Leitner', 'Berger', 'Fuchs'];
const TIERS = ['BRONZE', 'BRONZE', 'BRONZE', 'SILVER', 'SILVER', 'GOLD', 'GOLD', 'PLATINUM', 'VIP'];

/** Creates the demo tenant data. Does nothing if data already exists. */
export async function seed(pool: pg.Pool, log = console.log): Promise<boolean> {
  const existing = await pool.query('SELECT 1 FROM organizations LIMIT 1');
  if (existing.rowCount) {
    log('[db] seed skipped: data already present');
    return false;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pwHash = await bcrypt.hash(DEMO_PASSWORD, 10);

    // --- RBAC reference tables
    for (const r of ROLES) await client.query('INSERT INTO roles (key, name) VALUES ($1,$2)', [r, r.replace(/_/g, ' ')]);
    for (const p of PERMISSIONS) await client.query('INSERT INTO permissions (key) VALUES ($1)', [p]);
    for (const r of ROLES)
      for (const p of ROLE_PERMISSIONS[r])
        await client.query('INSERT INTO role_permissions (role_key, permission_key) VALUES ($1,$2)', [r, p]);

    // --- Tenant A: M1 Gaming Group
    const org = (await client.query(`INSERT INTO organizations (name, slug) VALUES ('M1 Gaming Group','m1') RETURNING id`)).rows[0].id;
    const casino = (
      await client.query(
        `INSERT INTO casinos (org_id, code, name, city, country) VALUES ($1,'VIE-001','M1 Demo Casino','Vienna','AT') RETURNING id`,
        [org],
      )
    ).rows[0].id;
    const enabledByDefault = new Set(['machines', 'floor', 'accounting', 'tickets', 'cash', 'cashier', 'reporting', 'loyalty', 'jackpots']);
    for (const m of MODULES)
      await client.query('INSERT INTO casino_modules (org_id, casino_id, module_key, enabled) VALUES ($1,$2,$3,$4)', [
        org, casino, m.key, enabledByDefault.has(m.key),
      ]);

    const gateway = (
      await client.query(
        `INSERT INTO gateways (org_id, casino_id, device_id, name, hardware, api_key_hash, config)
         VALUES ($1,$2,$3,'Vienna Floor Gateway','Raspberry Pi 5 / Docker',$4,$5) RETURNING id`,
        [org, casino, DEMO_GATEWAY_ID, hashGatewayKey(process.env.GATEWAY_KEY ?? 'demo-gateway-key'),
          { simulation: { running: true, eventsPerSecond: 2 } }],
      )
    ).rows[0].id;

    const modelIds: Record<string, string> = {};
    for (const t of MACHINE_TYPES) {
      modelIds[t.manufacturer] = (
        await client.query('INSERT INTO machine_models (org_id, manufacturer, name, cabinet) VALUES ($1,$2,$3,$4) RETURNING id', [
          org, t.manufacturer, t.model, 'Upright',
        ])
      ).rows[0].id;
    }

    // 20 machines, 4 per manufacturer, spread over the 3 floors.
    let n = 0;
    for (const [fi, f] of FLOORS.entries()) {
      const floorId = (
        await client.query('INSERT INTO floors (org_id, casino_id, name, sort_order, layout) VALUES ($1,$2,$3,$4,$5) RETURNING id', [
          org, casino, f.name, fi, JSON.stringify(f.fixtures),
        ])
      ).rows[0].id;
      const zoneId = (
        await client.query('INSERT INTO zones (org_id, floor_id, name) VALUES ($1,$2,$3) RETURNING id', [org, floorId, `${f.name} Zone A`])
      ).rows[0].id;
      for (const [x, y, label] of f.slots) {
        const type = MACHINE_TYPES[Math.floor(n / 4)];
        n++;
        const code = `VIE-001-${String(n).padStart(6, '0')}`;
        const asset = `M${String(n).padStart(3, '0')}`;
        const maintenance = asset === 'M012';
        const m = await client.query(
          `INSERT INTO machines (org_id, casino_id, floor_id, zone_id, model_id, gateway_id, machine_code, asset_no, serial_number,
             game, denomination, position_label, pos_x, pos_y, adapter_key, status, online, maintenance, last_communication_at, status_changed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'simulator',$15,true,$16,now(),now()) RETURNING id`,
          [org, casino, floorId, zoneId, modelIds[type.manufacturer], gateway, code, asset,
            `SN${(100000 + n * 7919).toString()}`, type.games[(n - 1) % 4], [0.01, 0.02, 0.05, 0.1][n % 4], label, x, y,
            maintenance ? 'MAINTENANCE' : 'ONLINE', maintenance],
        );
        await client.query('INSERT INTO machine_meters (machine_id, org_id) VALUES ($1,$2)', [m.rows[0].id, org]);
      }
    }

    // Players
    for (let i = 1; i <= 60; i++) {
      const tier = TIERS[(i * 7) % TIERS.length];
      await client.query(
        `INSERT INTO players (org_id, card_number, first_name, last_name, tier, points, total_coin_in, visits, last_visit_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() - ($9 || ' hours')::interval)`,
        [org, `PC-${String(i).padStart(5, '0')}`, FIRST[i % FIRST.length], LAST[(i * 5) % LAST.length], tier,
          5000 + ((i * 7331) % 60000), 2000 + ((i * 3797) % 40000), 3 + (i % 40), i * 3],
      );
    }

    // Jackpots (configuration only in Phase 1; the engine follows in Phase 4)
    const jackpots: Array<[string, string, number, number, number | null, number]> = [
      ['Main Floor Linked', 'LINKED', 1000, 2350.4, 10000, 0.01],
      ['VIP Mega Link', 'LINKED', 5000, 8120.75, 50000, 0.015],
      ['Friday Mystery', 'MYSTERY', 500, 1730.2, 5000, 0.008],
      ['Happy Hour', 'TIME', 250, 412.5, 1000, 0.005],
      ['Austria Wide Area', 'WIDE_AREA', 10000, 14205.0, null, 0.002],
      ['M001 Local Bonus', 'LOCAL', 100, 188.3, 500, 0.01],
      ['Floor 2 Linked', 'LINKED', 750, 913.1, 7500, 0.01],
    ];
    for (const [name, type, base, current, max, rate] of jackpots)
      await client.query(
        'INSERT INTO jackpots (org_id, casino_id, name, type, base_value, current_value, max_value, contribution_rate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [org, casino, name, type, base, current, max, rate],
      );

    // Employees
    const staff: Array<[string, string, string]> = [
      ['admin@example.com', 'Demo Admin', 'SUPER_ADMIN'],
      ['manager@example.com', 'Maria Manager', 'MANAGER'],
      ['floor@example.com', 'Florian Floor', 'FLOOR_SUPERVISOR'],
      ['cashier@example.com', 'Clara Cashier', 'CASHIER'],
      ['tech@example.com', 'Tom Technician', 'TECHNICIAN'],
      ['accounting@example.com', 'Alex Accounting', 'ACCOUNTING'],
    ];
    for (const [email, name, role] of staff) {
      const e = await client.query('INSERT INTO employees (org_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id', [
        org, email, name, pwHash, role,
      ]);
      await client.query('INSERT INTO employee_casinos (employee_id, casino_id, org_id) VALUES ($1,$2,$3)', [e.rows[0].id, casino, org]);
    }

    // 7 days of hourly history so charts and KPIs are populated from the first second.
    await client.query(
      `INSERT INTO gaming_transactions (org_id, casino_id, machine_id, type, amount, occurred_at, reference)
       SELECT m.org_id, m.casino_id, m.id, t.type, t.amount, h.ts + (random() * interval '59 minutes'), 'seed-history'
       FROM machines m
       CROSS JOIN generate_series(date_trunc('hour', now()) - interval '7 days', date_trunc('hour', now()) - interval '1 hour', interval '1 hour') h(ts)
       CROSS JOIN LATERAL (
         SELECT (30 + random() * 120)
                * CASE WHEN extract(hour FROM h.ts AT TIME ZONE 'Europe/Vienna') BETWEEN 18 AND 23 THEN 2.2
                       WHEN extract(hour FROM h.ts AT TIME ZONE 'Europe/Vienna') BETWEEN 0 AND 3 THEN 1.4
                       WHEN extract(hour FROM h.ts AT TIME ZONE 'Europe/Vienna') BETWEEN 4 AND 10 THEN 0.35
                       ELSE 1 END AS wager,
                0.86 + random() * 0.07 AS rtp
       ) w
       CROSS JOIN LATERAL (VALUES
         ('WAGER', round(w.wager::numeric, 2)),
         ('WIN', round((w.wager * w.rtp)::numeric, 2)),
         ('CASH_IN', round((w.wager * 0.35)::numeric / 5) * 5),
         ('TICKET_OUT', round((w.wager * 0.22)::numeric, 2))
       ) t(type, amount)
       WHERE m.org_id = $1 AND NOT m.maintenance`,
      [org],
    );
    await client.query(
      `UPDATE machine_meters mm SET
         coin_in = s.coin_in, coin_out = s.coin_out, cash_in = s.cash_in, tickets_out = s.tickets_out,
         games_played = round(s.coin_in / 1.9), games_won = round(s.coin_in / 1.9 * 0.28)
       FROM (
         SELECT machine_id,
           sum(amount) FILTER (WHERE type='WAGER') coin_in, sum(amount) FILTER (WHERE type='WIN') coin_out,
           sum(amount) FILTER (WHERE type='CASH_IN') cash_in, sum(amount) FILTER (WHERE type='TICKET_OUT') tickets_out
         FROM gaming_transactions WHERE org_id = $1 GROUP BY machine_id
       ) s WHERE s.machine_id = mm.machine_id`,
      [org],
    );

    // --- Tenant B: proves isolation (its users never see tenant A data)
    const orgB = (await client.query(`INSERT INTO organizations (name, slug) VALUES ('Riverside Gaming Ltd','riverside') RETURNING id`)).rows[0].id;
    const casinoB = (
      await client.query(`INSERT INTO casinos (org_id, code, name, city, country, timezone) VALUES ($1,'LON-001','Riverside Casino','London','GB','Europe/London') RETURNING id`, [orgB])
    ).rows[0].id;
    for (const m of MODULES)
      await client.query('INSERT INTO casino_modules (org_id, casino_id, module_key, enabled) VALUES ($1,$2,$3,$4)', [orgB, casinoB, m.key, !!m.core || m.key === 'floor']);
    await client.query('INSERT INTO floors (org_id, casino_id, name) VALUES ($1,$2,$3)', [orgB, casinoB, 'Ground Floor']);
    const eB = await client.query(`INSERT INTO employees (org_id, email, name, password_hash, role) VALUES ($1,'admin@riverside.example','Riverside Admin',$2,'SUPER_ADMIN') RETURNING id`, [orgB, pwHash]);
    await client.query('INSERT INTO employee_casinos (employee_id, casino_id, org_id) VALUES ($1,$2,$3)', [eB.rows[0].id, casinoB, orgB]);

    await writeAudit(client, { orgId: org, casinoId: casino, actorType: 'SYSTEM', actorName: 'seed', action: 'tenant.created', entityType: 'organization', entityId: org, details: { casinos: 1, machines: n } });
    await writeAudit(client, { orgId: orgB, casinoId: casinoB, actorType: 'SYSTEM', actorName: 'seed', action: 'tenant.created', entityType: 'organization', entityId: orgB });

    await client.query('COMMIT');
    log(`[db] seeded demo data: 2 tenants, ${n} machines, 60 players, 7 jackpots`);
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
