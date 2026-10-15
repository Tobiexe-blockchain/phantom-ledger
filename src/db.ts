import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

export function createPool(connectionString: string, max = 20): Pool {
  return new pg.Pool({ connectionString, max });
}

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
