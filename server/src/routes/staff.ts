import type { FastifyInstance } from 'fastify';
import { one, query, tx } from '../db/pool';
import { audit } from '../lib/audit';
import { invalidateStaffCache, requireStaff } from '../lib/auth';
import { conflict, forbidden, notFound } from '../lib/errors';
import { hashSecret } from '../lib/tokens';
import { parse, uuid, z } from '../lib/validate';

const userSchema = z.object({
  name: z.string().min(1).max(100),
  nickname: z.string().max(50).nullish(),
  employee_code: z.string().min(1).max(30).regex(/^[A-Za-z0-9_-]+$/),
  username: z.string().min(3).max(60).nullish(),
  password: z.string().min(8).max(200).nullish(),
  pin: z.string().regex(/^\d{4,8}$/).nullish(),
  role_id: uuid,
  branch_id: uuid.nullish(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'LOCKED']).default('ACTIVE'),
});

export default async function staffRoutes(app: FastifyInstance) {
  app.get('/users', { preHandler: requireStaff('staff.manage') }, async (req) =>
    query(
      `SELECT u.id, u.name, u.nickname, u.employee_code, u.username, u.role_id, u.branch_id, u.status, u.last_login_at, u.created_at,
              r.name AS role_name, r.code AS role_code, b.code AS branch_code, (u.pin_hash IS NOT NULL) AS has_pin, (u.password_hash IS NOT NULL) AS has_password
         FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN branches b ON b.id=u.branch_id
        WHERE ($1::uuid IS NULL OR u.branch_id=$1 OR u.branch_id IS NULL) ORDER BY r.level DESC, u.name`,
      [req.staff!.branchId],
    ),
  );

  async function guardRole(staffLevel: number, roleId: string) {
    const r = await one<any>(`SELECT level FROM roles WHERE id=$1`, [roleId]);
    if (!r) throw notFound('Role');
    // Nobody may grant a role above their own level.
    if (r.level > staffLevel) throw forbidden('ROLE_TOO_HIGH', 'Cannot assign a role higher than your own');
  }

  app.post('/users', { preHandler: requireStaff('staff.manage') }, async (req) => {
    const b = parse(userSchema, req.body);
    await guardRole(req.staff!.roleLevel, b.role_id);
    const row = await one<any>(
      `INSERT INTO users (name, nickname, employee_code, username, password_hash, pin_hash, role_id, branch_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [b.name, b.nickname ?? null, b.employee_code.toUpperCase(), b.username ?? null, b.password ? await hashSecret(b.password) : null,
       b.pin ? await hashSecret(b.pin) : null, b.role_id, req.staff!.branchId ?? b.branch_id ?? null, b.status],
    );
    await audit(req, { action: 'STAFF_CREATE', entity: 'user', entityId: row.id, newValue: { ...b, password: undefined, pin: undefined } });
    return row;
  });

  app.put('/users/:id', { preHandler: requireStaff('staff.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(userSchema, req.body);
    const old = await one<any>(`SELECT u.*, r.level FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1`, [id]);
    if (!old) throw notFound('User');
    if (old.level > req.staff!.roleLevel) throw forbidden('ROLE_TOO_HIGH');
    await guardRole(req.staff!.roleLevel, b.role_id);
    await query(
      `UPDATE users SET name=$2, nickname=$3, employee_code=$4, username=$5, role_id=$6, branch_id=$7, status=$8,
         password_hash = COALESCE($9, password_hash), pin_hash = COALESCE($10, pin_hash),
         token_version = token_version + CASE WHEN $8 <> 'ACTIVE' OR $6 <> role_id OR $9 IS NOT NULL THEN 1 ELSE 0 END,
         failed_attempts = CASE WHEN $8='ACTIVE' THEN 0 ELSE failed_attempts END, locked_until = CASE WHEN $8='ACTIVE' THEN NULL ELSE locked_until END
       WHERE id=$1`,
      [id, b.name, b.nickname ?? null, b.employee_code.toUpperCase(), b.username ?? null, b.role_id, req.staff!.branchId ?? b.branch_id ?? null, b.status,
       b.password ? await hashSecret(b.password) : null, b.pin ? await hashSecret(b.pin) : null],
    );
    invalidateStaffCache(id);
    const strip = (o: any) => ({ ...o, password_hash: undefined, pin_hash: undefined, password: undefined, pin: undefined });
    await audit(req, { action: 'STAFF_UPDATE', entity: 'user', entityId: id, oldValue: strip(old), newValue: { ...strip(b), passwordChanged: !!b.password, pinChanged: !!b.pin } });
    return { ok: true };
  });

  app.delete('/users/:id', { preHandler: requireStaff('staff.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    if (id === req.staff!.id) throw conflict('CANNOT_DELETE_SELF');
    // Deactivate rather than delete so history (payments, audit) keeps the reference.
    await query(`UPDATE users SET status='INACTIVE', token_version=token_version+1 WHERE id=$1`, [id]);
    invalidateStaffCache(id);
    await audit(req, { action: 'STAFF_DEACTIVATE', entity: 'user', entityId: id });
    return { ok: true };
  });

  // ---------------- roles & permissions
  app.get('/permissions', { preHandler: requireStaff() }, async () => query(`SELECT * FROM permissions ORDER BY grp, code`));
  app.get('/roles', { preHandler: requireStaff() }, async () =>
    query(
      `SELECT r.*, COALESCE(array_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions,
              (SELECT COUNT(*)::int FROM users u WHERE u.role_id=r.id AND u.status='ACTIVE') AS user_count
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id GROUP BY r.id ORDER BY r.level DESC`,
    ),
  );
  const roleSchema = z.object({ code: z.string().min(2).max(30).regex(/^[A-Z0-9_]+$/), name: z.string().min(1).max(60), level: z.number().int().min(1).max(100), permissions: z.array(z.string().max(60)) });
  async function saveRole(id: string | null, b: z.infer<typeof roleSchema>, staffLevel: number, staffPerms: Set<string>) {
    if (b.level > staffLevel) throw forbidden('ROLE_TOO_HIGH');
    // Cannot grant permissions you do not hold yourself.
    const extra = b.permissions.filter((p) => !staffPerms.has(p));
    if (extra.length) throw forbidden('PERMISSION_ESCALATION', `Cannot grant: ${extra.join(', ')}`);
    return tx(async (c) => {
      const row = id
        ? await one<any>(`UPDATE roles SET code=$2, name=$3, level=$4 WHERE id=$1 RETURNING *`, [id, b.code, b.name, b.level], c)
        : await one<any>(`INSERT INTO roles (code, name, level) VALUES ($1,$2,$3) RETURNING *`, [b.code, b.name, b.level], c);
      if (!row) throw notFound('Role');
      await c.query(`DELETE FROM role_permissions WHERE role_id=$1`, [row.id]);
      if (b.permissions.length) {
        await c.query(`INSERT INTO role_permissions (role_id, permission_code) SELECT $1, code FROM permissions WHERE code = ANY($2)`, [row.id, b.permissions]);
      }
      return row;
    });
  }
  app.post('/roles', { preHandler: requireStaff('roles.manage') }, async (req) => {
    const b = parse(roleSchema, req.body);
    const r = await saveRole(null, b, req.staff!.roleLevel, req.staff!.permissions);
    await audit(req, { action: 'ROLE_CREATE', entity: 'role', entityId: r.id, newValue: b });
    return r;
  });
  app.put('/roles/:id', { preHandler: requireStaff('roles.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(roleSchema, req.body);
    const old = await one<any>(`SELECT r.*, array(SELECT permission_code FROM role_permissions WHERE role_id=r.id) AS permissions FROM roles r WHERE id=$1`, [id]);
    if (!old) throw notFound('Role');
    if (old.code === 'OWNER') throw forbidden('SYSTEM_ROLE', 'Owner role cannot be modified');
    if (old.level > req.staff!.roleLevel) throw forbidden('ROLE_TOO_HIGH');
    const r = await saveRole(id, { ...b, code: old.is_system ? old.code : b.code }, req.staff!.roleLevel, req.staff!.permissions);
    invalidateStaffCache();
    await audit(req, { action: 'ROLE_UPDATE', entity: 'role', entityId: id, oldValue: old, newValue: b });
    return r;
  });
  app.delete('/roles/:id', { preHandler: requireStaff('roles.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const r = await one<any>(`SELECT * FROM roles WHERE id=$1`, [id]);
    if (!r) throw notFound('Role');
    if (r.is_system) throw forbidden('SYSTEM_ROLE', 'Built-in roles cannot be deleted');
    const used = await one(`SELECT 1 FROM users WHERE role_id=$1`, [id]);
    if (used) throw conflict('ROLE_IN_USE', 'Reassign users first');
    await query(`DELETE FROM roles WHERE id=$1`, [id]);
    await audit(req, { action: 'ROLE_DELETE', entity: 'role', entityId: id, oldValue: r });
    return { ok: true };
  });
}
