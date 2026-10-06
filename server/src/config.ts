import 'dotenv/config';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Missing environment variable ${k}`);
  return v;
};

export const config = {
  env: env('NODE_ENV', 'development'),
  port: Number(env('PORT', '4000')),
  host: env('HOST', '0.0.0.0'),
  databaseUrl: env('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/kiosk'),
  // On Render, RENDER_EXTERNAL_URL is provided automatically (used for receipt QR lookup links).
  publicUrl: env('PUBLIC_URL', process.env.RENDER_EXTERNAL_URL || 'http://localhost:4000').replace(/\/$/, ''),
  corsOrigins: env('CORS_ORIGINS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  jwtSecret: env('JWT_SECRET', 'dev-only-secret-change-me-dev-only-secret-change-me'),
  jwtTtl: env('JWT_TTL', '12h'),
  memberJwtTtl: env('MEMBER_JWT_TTL', '30d'),
  // HMAC key for credential QR / barcode signatures (rotate = every printed code becomes invalid).
  credentialSecret: env('CREDENTIAL_SECRET', `${process.env.JWT_SECRET || 'dev-only-secret-change-me-dev-only-secret-change-me'}:credentials`),
  webhookToleranceSec: Number(env('WEBHOOK_TOLERANCE_SEC', '300')),
  uploadDir: env('UPLOAD_DIR', './uploads'),
  webDist: env('WEB_DIST', '../web/dist'),
  logLevel: env('LOG_LEVEL', 'info'),
  maxUploadMb: Number(env('MAX_UPLOAD_MB', '20')),
  webhookSecret(provider: string): string | undefined {
    return process.env[`PAYMENT_WEBHOOK_SECRET_${provider.toUpperCase()}`];
  },
};

if (config.env === 'production' && config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}
