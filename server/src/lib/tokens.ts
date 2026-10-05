import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export const hashSecret = (s: string) => bcrypt.hash(s, 10);
export const verifySecret = (s: string, hash: string | null | undefined) => (hash ? bcrypt.compare(s, hash) : Promise.resolve(false));

/** Device tokens are high-entropy random values, so a fast SHA-256 digest is sufficient. */
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export function newDeviceToken(id: string): { token: string; hash: string } {
  const secret = crypto.randomBytes(24).toString('base64url');
  return { token: `${id}.${secret}`, hash: sha256(secret) };
}
export function parseDeviceToken(token: string | undefined | null): { id: string; secret: string } | null {
  if (!token) return null;
  const i = token.indexOf('.');
  if (i < 1) return null;
  const id = token.slice(0, i);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { id, secret: token.slice(i + 1) };
}
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
