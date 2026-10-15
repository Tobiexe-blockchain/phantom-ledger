import { createPool } from './db.js';
import { buildApp } from './app.js';
import { migrate } from './migrate.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/phantom_ledger';
const port = Number(process.env.PORT ?? 3000);

await migrate(databaseUrl);
const pool = createPool(databaseUrl);
const app = buildApp(pool);

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port, host: '0.0.0.0' });
console.log(`phantom-ledger listening on :${port}`);
