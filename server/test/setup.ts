import pg from 'pg';

/** Point the server at an isolated test database (created on demand). */
const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/kiosk_test';
process.env.DATABASE_URL = base;
process.env.PAYMENT_WEBHOOK_SECRET_SANDBOX = 'test-webhook-secret';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.UPLOAD_DIR = '/tmp/kiosk-test-uploads';
process.env.LOG_LEVEL = 'silent';

export async function ensureDb() {
  const u = new URL(base);
  const dbName = u.pathname.slice(1);
  u.pathname = '/postgres';
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  const exists = await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName]);
  if (!exists.rowCount) await c.query(`CREATE DATABASE "${dbName}"`);
  await c.end();
}
