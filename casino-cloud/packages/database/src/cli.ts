import { createPool, migrate, seed } from './index';

const cmd = process.argv[2] ?? 'setup';
const pool = createPool();

try {
  if (cmd === 'reset') {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    console.log('[db] schema dropped');
  }
  if (cmd === 'migrate' || cmd === 'setup' || cmd === 'reset') await migrate(pool);
  if (cmd === 'seed' || cmd === 'setup' || cmd === 'reset') await seed(pool);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
