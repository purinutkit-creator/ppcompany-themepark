import pg from 'pg';
import { config } from '../config';

// NUMERIC -> number, BIGINT -> number (safe for our ranges), DATE -> string.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: Number(process.env.DB_POOL_MAX || 20) });

export type Db = pg.Pool | pg.PoolClient;
export type Tx = pg.PoolClient;

export async function query<T = any>(text: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  const r = await db.query(text, params as any[]);
  return r.rows as T[];
}

export async function one<T = any>(text: string, params: unknown[] = [], db: Db = pool): Promise<T | null> {
  const r = await db.query(text, params as any[]);
  return (r.rows[0] as T) ?? null;
}

/**
 * Run `fn` inside a transaction. Serialization failures / deadlocks are retried, which keeps the
 * critical payment path correct under concurrent approvals from several cashiers.
 */
export async function tx<T>(fn: (client: Tx) => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      if ((err?.code === '40001' || err?.code === '40P01') && attempt < retries) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
