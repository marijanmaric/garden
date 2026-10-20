import { createPool, migrate, seed, syncMoneyModel, syncRbac, withTransaction, writeAudit } from './index';
import { hashGatewayKey } from './seed';

const cmd = process.argv[2] ?? 'setup';
const pool = createPool();

try {
  if (cmd === 'reset') {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    console.log('[db] schema dropped');
  }
  if (cmd === 'migrate' || cmd === 'setup' || cmd === 'reset') {
    await migrate(pool);
    await syncRbac(pool);
    await syncMoneyModel(pool);
  }
  if (cmd === 'seed' || cmd === 'setup' || cmd === 'reset') await seed(pool);
  // Production bootstrap (no demo seed): the platform organisation if needed and its administrator.
  //   npm run platform-admin -w @m1/database -- <email> <password (12+)> [name]
  if (cmd === 'platform-admin') {
    const [email, password, name] = process.argv.slice(3);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !password || password.length < 12)
      throw new Error('usage: platform-admin <email> <password (12+ characters)> [name]');
    await migrate(pool);
    await syncRbac(pool);
    await syncMoneyModel(pool);
    const { default: bcrypt } = await import('bcryptjs');
    await withTransaction(pool, async (db) => {
      let org = (await db.query('SELECT id FROM organizations WHERE is_platform ORDER BY created_at LIMIT 1')).rows[0]?.id;
      if (!org) {
        org = (await db.query(`INSERT INTO organizations (name, slug, is_platform) VALUES ('Platform', 'platform', true) RETURNING id`)).rows[0].id;
        await db.query(`INSERT INTO subscriptions (org_id, plan_id, status, note) SELECT $1, id, 'ACTIVE', 'platform operator' FROM plans WHERE code = 'CUSTOM' ORDER BY version DESC LIMIT 1`, [org]);
        await writeAudit(db, { orgId: org, actorType: 'SYSTEM', actorName: 'cli', action: 'organization.created', entityType: 'organization', entityId: org, details: { new: { name: 'Platform', isPlatform: true }, reason: 'platform bootstrap (CLI)' } });
      }
      // only ever a platform administrator of the platform organisation (database guard as well), never a casino operator
      const id = (await db.query(
        `INSERT INTO employees (org_id, email, name, password_hash, role, is_platform_admin) VALUES ($1, lower($2), $3, $4, 'SUPER_ADMIN', true) RETURNING id`,
        [org, email, name ?? email, await bcrypt.hash(password, 10)])).rows[0].id;
      await writeAudit(db, { orgId: org, actorType: 'SYSTEM', actorName: 'cli', action: 'employee.created', entityType: 'employee', entityId: id,
        details: { new: { email: email.toLowerCase(), role: 'SUPER_ADMIN', platformAdmin: true }, reason: 'platform administrator bootstrap (CLI)' } });
    });
    console.log(`[db] platform administrator ${email.toLowerCase()} created`);
  }
  // Edge gateway of a customer casino: registers the device, prints its key ONCE (only the hash is stored) and
  // assigns the casino's machines that have no gateway yet.
  //   npm run gateway -w @m1/database -- <org-slug> <casino-code> <device-id> [name]
  if (cmd === 'gateway') {
    const [slug, casinoCode, deviceId, name] = process.argv.slice(3);
    if (!slug || !casinoCode || !deviceId || !/^[A-Za-z0-9_-]{3,64}$/.test(deviceId)) throw new Error('usage: gateway <org-slug> <casino-code> <device-id> [name]');
    const { randomBytes } = await import('node:crypto');
    const key = randomBytes(32).toString('base64url');
    const out = await withTransaction(pool, async (db) => {
      const c = (await db.query(
        `SELECT c.id, c.org_id FROM casinos c JOIN organizations o ON o.id = c.org_id WHERE o.slug = $1 AND c.code = $2 AND NOT o.is_platform`, [slug, casinoCode])).rows[0];
      if (!c) throw new Error(`casino ${casinoCode} of organisation ${slug} not found`);
      const g = (await db.query(`INSERT INTO gateways (org_id, casino_id, device_id, name, api_key_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [c.org_id, c.id, deviceId, name ?? deviceId, hashGatewayKey(key)])).rows[0].id;
      const bound = (await db.query('UPDATE machines SET gateway_id = $1 WHERE casino_id = $2 AND org_id = $3 AND gateway_id IS NULL', [g, c.id, c.org_id])).rowCount;
      await writeAudit(db, { orgId: c.org_id, casinoId: c.id, actorType: 'SYSTEM', actorName: 'cli', action: 'gateway.registered', entityType: 'gateway', entityId: g,
        details: { new: { deviceId, name: name ?? deviceId, machinesAssigned: bound }, reason: 'gateway registration (CLI)' } });
      return { bound };
    });
    console.log(`[db] gateway ${deviceId} registered, ${out.bound} machine(s) assigned.\n[db] GATEWAY_ID=${deviceId}\n[db] GATEWAY_KEY=${key}\n[db] Store the key on the gateway now: it is not stored and cannot be shown again.`);
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
