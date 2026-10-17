import { createPool, migrate, seed, syncMoneyModel, syncRbac } from './index';

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
  // Upgrade path (no demo seed): creates the platform organisation if needed and its administrator.
  //   npm run db -- platform-admin <email> <password> [name]
  if (cmd === 'platform-admin') {
    const [email, password, name] = process.argv.slice(3);
    if (!email || !password || password.length < 12) throw new Error('usage: platform-admin <email> <password (12+ characters)> [name]');
    const { default: bcrypt } = await import('bcryptjs');
    let org = (await pool.query('SELECT id FROM organizations WHERE is_platform ORDER BY created_at LIMIT 1')).rows[0]?.id;
    if (!org) {
      org = (await pool.query(`INSERT INTO organizations (name, slug, is_platform) VALUES ('Platform', 'platform', true) RETURNING id`)).rows[0].id;
      await pool.query(`INSERT INTO subscriptions (org_id, plan_id, status, note) SELECT $1, id, 'ACTIVE', 'platform operator' FROM plans WHERE code = 'CUSTOM' ORDER BY version DESC LIMIT 1`, [org]);
    }
    await pool.query(
      `INSERT INTO employees (org_id, email, name, password_hash, role, is_platform_admin) VALUES ($1, lower($2), $3, $4, 'SUPER_ADMIN', true)`,
      [org, email, name ?? email, await bcrypt.hash(password, 10)]);
    console.log(`[db] platform administrator ${email} created`);
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
