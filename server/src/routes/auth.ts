import type { FastifyInstance } from 'fastify';
import { one, query } from '../db/pool';
import { audit } from '../lib/audit';
import { requireStaff, invalidateStaffCache, loadStaff } from '../lib/auth';
import { unauthorized, forbidden, badRequest } from '../lib/errors';
import { getSetting } from '../lib/settings';
import { verifySecret, hashSecret } from '../lib/tokens';
import { parse, z } from '../lib/validate';

export default async function authRoutes(app: FastifyInstance) {
  app.post(
    '/login',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const b = parse(
        z.object({
          username: z.string().max(100).optional(),
          password: z.string().max(200).optional(),
          employeeCode: z.string().max(50).optional(),
          pin: z.string().max(20).optional(),
        }),
        req.body,
      );
      const byPin = !!(b.employeeCode && b.pin);
      if (!byPin && !(b.username && b.password)) throw badRequest('CREDENTIALS_REQUIRED');
      const u = await one<any>(
        `SELECT u.*, r.code AS role FROM users u JOIN roles r ON r.id=u.role_id WHERE ${byPin ? 'u.employee_code=$1' : 'lower(u.username)=lower($1)'}`,
        [byPin ? b.employeeCode : b.username],
      );
      const sec = await getSetting('security');
      if (!u) throw unauthorized('Invalid credentials');
      if (u.locked_until && new Date(u.locked_until) > new Date()) throw forbidden('ACCOUNT_LOCKED', 'Too many attempts, try again later');
      if (u.status !== 'ACTIVE') throw forbidden('ACCOUNT_DISABLED', 'Account is disabled');
      const ok = await verifySecret(byPin ? b.pin! : b.password!, byPin ? u.pin_hash : u.password_hash);
      if (!ok) {
        const attempts = u.failed_attempts + 1;
        const lock = attempts >= sec.maxLoginAttempts;
        await query(
          `UPDATE users SET failed_attempts=$2, locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END WHERE id=$1`,
          [u.id, lock ? 0 : attempts, lock, String(sec.lockMinutes)],
        );
        await audit(req, { action: 'LOGIN_FAILED', entity: 'user', entityId: u.id, branchId: u.branch_id });
        throw unauthorized('Invalid credentials');
      }
      await query(`UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE id=$1`, [u.id]);
      const token = app.jwt.sign({ sub: u.id, tv: u.token_version });
      const staff = await loadStaff(u.id, u.token_version);
      req.staff = staff!;
      await audit(req, { action: 'LOGIN', entity: 'user', entityId: u.id, newValue: { method: byPin ? 'PIN' : 'PASSWORD' } });
      return { token, user: serializeStaff(staff!) };
    },
  );

  app.get('/me', { preHandler: requireStaff() }, async (req) => {
    const branches = req.staff!.branchId
      ? await query(`SELECT id, code, name, timezone FROM branches WHERE id=$1`, [req.staff!.branchId])
      : await query(`SELECT id, code, name, timezone FROM branches WHERE is_active ORDER BY code`);
    return { user: serializeStaff(req.staff!), branches };
  });

  app.post('/logout', { preHandler: requireStaff() }, async (req) => {
    await audit(req, { action: 'LOGOUT', entity: 'user', entityId: req.staff!.id });
    return { ok: true };
  });

  /** Revoke all sessions of the current user (token version bump). */
  app.post('/logout-all', { preHandler: requireStaff() }, async (req) => {
    await query(`UPDATE users SET token_version = token_version + 1 WHERE id=$1`, [req.staff!.id]);
    invalidateStaffCache(req.staff!.id);
    await audit(req, { action: 'LOGOUT_ALL', entity: 'user', entityId: req.staff!.id });
    return { ok: true };
  });

  app.post('/change-password', { preHandler: requireStaff() }, async (req) => {
    const b = parse(z.object({ currentPassword: z.string().optional(), newPassword: z.string().min(8).max(200).optional(), newPin: z.string().regex(/^\d{4,8}$/).optional(), currentPin: z.string().optional() }), req.body);
    const u = await one<any>(`SELECT * FROM users WHERE id=$1`, [req.staff!.id]);
    if (b.newPassword) {
      if (u.password_hash && !(await verifySecret(b.currentPassword ?? '', u.password_hash))) throw forbidden('INVALID_PASSWORD');
      await query(`UPDATE users SET password_hash=$2 WHERE id=$1`, [u.id, await hashSecret(b.newPassword)]);
    }
    if (b.newPin) {
      if (u.pin_hash && !(await verifySecret(b.currentPin ?? '', u.pin_hash))) throw forbidden('INVALID_PIN');
      await query(`UPDATE users SET pin_hash=$2 WHERE id=$1`, [u.id, await hashSecret(b.newPin)]);
    }
    await audit(req, { action: 'CREDENTIALS_CHANGED', entity: 'user', entityId: u.id });
    return { ok: true };
  });
}

export function serializeStaff(s: NonNullable<Awaited<ReturnType<typeof loadStaff>>>) {
  return { id: s.id, name: s.name, employeeCode: s.employeeCode, role: s.role, roleLevel: s.roleLevel, branchId: s.branchId, permissions: [...s.permissions] };
}
