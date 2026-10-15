import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './db.js';

const dir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'migrations');

export async function migrate(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl, 1);
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/phantom_ledger').catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
