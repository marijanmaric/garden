import { migrate, seed, syncMoneyModel, syncRbac } from '@m1/database';
import { buildApp } from './app';
import { checkProductionSecrets, config } from './config';
import { pool } from './db';
import { startGatewayWatchdog } from './services/gateway';
import { startMaintenance } from './services/maintenance';
import { cutoverFreshRails } from './services/cutover';

async function waitForDatabase(retries = 30) {
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i >= retries) throw err;
      console.log(`[api] waiting for database (${i}/${retries})...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

checkProductionSecrets();
await waitForDatabase();
await migrate(pool);
await syncRbac(pool);
await syncMoneyModel(pool);
// Fresh demo database only: rails without legacy money start on the ledger, through the regular cutover.
if (config.autoSeed && (await seed(pool))) await cutoverFreshRails(pool);

const app = await buildApp();
const stopWatchdog = startGatewayWatchdog();
const stopMaintenance = startMaintenance();
await app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    stopWatchdog();
    stopMaintenance();
    await app.close();
    await pool.end();
    process.exit(0);
  });
