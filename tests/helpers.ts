import type { Pool } from 'pg';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/phantom_ledger';

export async function setupDb(): Promise<Pool> {
  const pool = createPool(DATABASE_URL, 30);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(DATABASE_URL);
  return pool;
}

export async function resetDb(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE ledger_lines, journal_entries, withdrawals, accounts RESTART IDENTITY CASCADE');
}
