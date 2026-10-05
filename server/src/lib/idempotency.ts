import crypto from 'node:crypto';
import { one, query } from '../db/pool';
import { AppError, conflict } from './errors';

/**
 * Idempotent execution keyed by (scope, key). The first request runs `fn` and stores its result;
 * replays with the same key return the stored response. A different payload with the same key is
 * rejected, and concurrent duplicates get 409 while the first is still running.
 */
export async function idempotent<T>(scope: string, key: string | undefined, body: unknown, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  if (key.length > 200) throw conflict('IDEMPOTENCY_KEY_INVALID');
  const hash = crypto.createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
  const inserted = await one(
    `INSERT INTO idempotency_keys (scope, key, request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key`,
    [scope, key, hash],
  );
  if (!inserted) {
    const row = await one<any>(`SELECT * FROM idempotency_keys WHERE scope=$1 AND key=$2`, [scope, key]);
    if (row.request_hash !== hash) throw conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key reused with different payload');
    if (row.status_code == null) throw conflict('REQUEST_IN_PROGRESS', 'Duplicate request is still being processed');
    if (row.status_code >= 400) throw new AppError(row.status_code, row.response?.code ?? 'ERROR', row.response?.message);
    return row.response as T;
  }
  try {
    const result = await fn();
    await query(`UPDATE idempotency_keys SET status_code=200, response=$3 WHERE scope=$1 AND key=$2`, [scope, key, JSON.stringify(result ?? null)]);
    return result;
  } catch (e) {
    // Business errors are deterministic: remember them. Unexpected errors free the key for retry.
    if (e instanceof AppError && e.status < 500) {
      await query(`UPDATE idempotency_keys SET status_code=$3, response=$4 WHERE scope=$1 AND key=$2`, [
        scope, key, e.status, JSON.stringify({ code: e.code, message: e.message }),
      ]);
    } else await query(`DELETE FROM idempotency_keys WHERE scope=$1 AND key=$2`, [scope, key]);
    throw e;
  }
}
