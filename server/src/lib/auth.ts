import type { FastifyReply, FastifyRequest } from 'fastify';
import { one, query } from '../db/pool';
import { forbidden, unauthorized, badRequest } from './errors';
import { parseDeviceToken, safeEqual, sha256, verifySecret } from './tokens';
import { MANAGER_LEVEL, type ManagerPinAction, type Permission } from './permissions';
import { getSetting } from './settings';

export interface StaffCtx {
  id: string;
  name: string;
  employeeCode: string;
  role: string;
  roleId: string;
  roleLevel: number;
  branchId: string | null;
  permissions: Set<string>;
}
export interface KioskCtx {
  id: string;
  code: string;
  branch_id: string;
  default_language: string;
  receipt_printer_id: string | null;
  payment_methods: string[];
  order_types: string[];
  idle_timeout: number;
  theme: Record<string, unknown>;
  name: string;
}
export interface AgentCtx {
  id: string;
  branch_id: string;
  name: string;
}
export interface MemberCtx {
  id: string;
  accountId: string;
  memberNo: string;
  name: string;
  sessionId: string | null;
  language: string;
}
export interface DeviceCtx {
  id: string;
  branch_id: string;
  code: string;
  name: string;
  type: string;
  config: Record<string, any>;
}

declare module 'fastify' {
  interface FastifyRequest {
    staff?: StaffCtx;
    kiosk?: KioskCtx;
    agent?: AgentCtx;
    member?: MemberCtx;
    device?: DeviceCtx;
  }
}

export interface JwtPayload {
  sub: string;
  tv: number;
  typ?: 'member';
  sid?: string;
}

const staffCache = new Map<string, { at: number; v: StaffCtx | null; tv: number }>();
export const invalidateStaffCache = (id?: string) => (id ? staffCache.delete(id) : staffCache.clear());

export async function loadStaff(userId: string, tokenVersion: number): Promise<StaffCtx | null> {
  const c = staffCache.get(userId);
  if (c && Date.now() - c.at < 10_000 && c.tv === tokenVersion) return c.v;
  const u = await one<any>(
    `SELECT u.id, u.name, u.employee_code, u.branch_id, u.status, u.token_version, r.id AS role_id, r.code AS role, r.level
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
    [userId],
  );
  let v: StaffCtx | null = null;
  if (u && u.status === 'ACTIVE' && u.token_version === tokenVersion) {
    const perms = await query<{ permission_code: string }>(`SELECT permission_code FROM role_permissions WHERE role_id=$1`, [u.role_id]);
    v = {
      id: u.id,
      name: u.name,
      employeeCode: u.employee_code,
      role: u.role,
      roleId: u.role_id,
      roleLevel: u.level,
      branchId: u.branch_id,
      permissions: new Set(perms.map((p) => p.permission_code)),
    };
  }
  staffCache.set(userId, { at: Date.now(), v, tv: tokenVersion });
  return v;
}

export async function staffFromToken(req: FastifyRequest, token?: string): Promise<StaffCtx | null> {
  try {
    const payload = token ? req.server.jwt.verify<JwtPayload>(token) : await req.jwtVerify<JwtPayload>();
    if (payload.typ === 'member') return null;
    return await loadStaff(payload.sub, payload.tv ?? 0);
  } catch {
    return null;
  }
}

export async function kioskFromToken(token: string | undefined | null): Promise<KioskCtx | null> {
  const t = parseDeviceToken(token);
  if (!t) return null;
  const k = await one<any>(`SELECT * FROM kiosks WHERE id=$1 AND is_active`, [t.id]);
  if (!k?.token_hash || !safeEqual(k.token_hash, sha256(t.secret))) return null;
  return k as KioskCtx;
}

export async function agentFromToken(token: string | undefined | null): Promise<AgentCtx | null> {
  const t = parseDeviceToken(token);
  if (!t) return null;
  const a = await one<any>(`SELECT id, branch_id, name, token_hash FROM print_agents WHERE id=$1`, [t.id]);
  if (!a || !safeEqual(a.token_hash, sha256(t.secret))) return null;
  return { id: a.id, branch_id: a.branch_id, name: a.name };
}

/** Member (customer portal) JWT: { sub: memberId, tv: token_version, typ: 'member', sid: session }. */
export async function memberFromJwt(payload: JwtPayload | null): Promise<MemberCtx | null> {
  if (!payload || payload.typ !== 'member') return null;
  const m = await one<any>(
    `SELECT m.id, m.account_id, m.member_no, m.first_name, m.last_name, m.status, m.token_version, m.language,
            (SELECT revoked_at FROM member_sessions s WHERE s.id = $2::uuid) AS revoked_at
       FROM members m WHERE m.id=$1`,
    [payload.sub, payload.sid ?? null],
  );
  if (!m || m.status !== 'ACTIVE' || m.token_version !== (payload.tv ?? 0) || m.revoked_at) return null;
  if (payload.sid) query(`UPDATE member_sessions SET last_seen_at=now() WHERE id=$1 AND last_seen_at < now() - interval '5 minutes'`, [payload.sid]).catch(() => {});
  return { id: m.id, accountId: m.account_id, memberNo: m.member_no, name: `${m.first_name} ${m.last_name}`.trim(), sessionId: payload.sid ?? null, language: m.language };
}

export async function memberFromToken(req: FastifyRequest, token?: string): Promise<MemberCtx | null> {
  try {
    const payload = token ? req.server.jwt.verify<JwtPayload>(token) : await req.jwtVerify<JwtPayload>();
    return await memberFromJwt(payload);
  } catch {
    return null;
  }
}

export async function requireMember(req: FastifyRequest) {
  const m = await memberFromToken(req);
  if (!m) throw unauthorized('Member login required');
  req.member = m;
}

/** Attach the member if a valid member token is present (guest checkout otherwise). */
export async function optionalMember(req: FastifyRequest) {
  if (!req.headers.authorization) return;
  const m = await memberFromToken(req);
  if (m) req.member = m;
}

/** Paired park device (gate scanner / display, ride scanner, locker controller, POS terminal…). */
export async function deviceFromToken(token: string | undefined | null): Promise<DeviceCtx | null> {
  const t = parseDeviceToken(token);
  if (!t) return null;
  const d = await one<any>(`SELECT id, branch_id, code, name, type, config, token_hash FROM devices WHERE id=$1 AND is_active`, [t.id]);
  if (!d?.token_hash || !safeEqual(d.token_hash, sha256(t.secret))) return null;
  return { id: d.id, branch_id: d.branch_id, code: d.code, name: d.name, type: d.type, config: d.config ?? {} };
}

/** Device token OR staff (with any of the permissions) — gate / ride / locker endpoints used by both. */
export function requireDeviceOrStaffPerm(...perms: Permission[]) {
  return async (req: FastifyRequest) => {
    const dev = await deviceFromToken(req.headers['x-device-token'] as string);
    if (dev) {
      req.device = dev;
      query(`UPDATE devices SET last_seen_at=now(), status='ONLINE', ip=$2 WHERE id=$1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '20 seconds' OR status <> 'ONLINE')`, [dev.id, req.ip]).catch(() => {});
      return;
    }
    const kiosk = await kioskFromToken(req.headers['x-kiosk-token'] as string);
    if (kiosk && perms.includes('kiosk' as Permission)) return void (req.kiosk = kiosk);
    const staff = await staffFromToken(req);
    if (!staff) throw unauthorized();
    if (perms.length && !perms.some((p) => staff.permissions.has(p))) throw forbidden('PERMISSION_DENIED');
    req.staff = staff;
  };
}

/** preHandler: require an authenticated staff member, optionally with all given permissions. */
export function requireStaff(...perms: Permission[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const staff = await staffFromToken(req);
    if (!staff) throw unauthorized();
    for (const p of perms) if (!staff.permissions.has(p)) throw forbidden('PERMISSION_DENIED', `Missing permission: ${p}`);
    req.staff = staff;
  };
}

/** preHandler: staff with ANY of the permissions. */
export function requireAnyStaff(...perms: Permission[]) {
  return async (req: FastifyRequest) => {
    const staff = await staffFromToken(req);
    if (!staff) throw unauthorized();
    if (perms.length && !perms.some((p) => staff.permissions.has(p))) throw forbidden('PERMISSION_DENIED');
    req.staff = staff;
  };
}

export async function requireKiosk(req: FastifyRequest) {
  const kiosk = await kioskFromToken(req.headers['x-kiosk-token'] as string);
  if (!kiosk) throw unauthorized('Kiosk not paired or token invalid');
  req.kiosk = kiosk;
}

export async function requireAgent(req: FastifyRequest) {
  const agent = await agentFromToken(req.headers['x-agent-token'] as string);
  if (!agent) throw unauthorized('Print agent token invalid');
  req.agent = agent;
}

/** Device (kiosk / agent) or staff — used by print executors running in either. */
export async function requireDeviceOrStaff(req: FastifyRequest) {
  const kiosk = await kioskFromToken(req.headers['x-kiosk-token'] as string);
  if (kiosk) return void (req.kiosk = kiosk);
  const agent = await agentFromToken(req.headers['x-agent-token'] as string);
  if (agent) return void (req.agent = agent);
  const staff = await staffFromToken(req);
  if (staff) return void (req.staff = staff);
  throw unauthorized();
}

/** Resolve which branch a staff request operates on. Branch-bound staff are pinned to their branch. */
export function branchOf(req: FastifyRequest): string {
  if (req.device) return req.device.branch_id;
  if (req.kiosk) return req.kiosk.branch_id;
  if (req.agent) return req.agent.branch_id;
  const s = req.staff;
  if (!s) throw unauthorized();
  if (s.branchId) return s.branchId;
  const b = (req.headers['x-branch-id'] as string) || ((req.query as any)?.branchId as string);
  if (!b || !/^[0-9a-f-]{36}$/i.test(b)) throw badRequest('BRANCH_REQUIRED', 'Select a branch (X-Branch-Id header)');
  return b;
}

/**
 * Enforce manager-PIN approval for sensitive actions when configured. Returns the approver id.
 * The approver must hold `perm`, be manager level or above, and enter their employee code + PIN.
 */
export async function requireManagerApproval(
  req: FastifyRequest,
  action: ManagerPinAction,
  perm: Permission,
  body: { managerCode?: string; managerPin?: string; reason?: string | null } | undefined,
  ctx: { reference?: string | null; entity?: string; entityId?: string | null; reason?: string | null } = {},
): Promise<string | null> {
  const staff = req.staff;
  if (!staff) throw unauthorized();
  const sec = await getSetting('security');
  const required = (sec.managerPinActions as string[]).includes(action);
  if (!required) {
    if (!staff.permissions.has(perm)) throw forbidden('PERMISSION_DENIED', `Missing permission: ${perm}`);
    return null;
  }
  if (!body?.managerCode || !body?.managerPin) throw forbidden('MANAGER_PIN_REQUIRED', 'Manager PIN approval required');
  const m = await one<any>(
    `SELECT u.id, u.pin_hash, r.level, r.id AS role_id FROM users u JOIN roles r ON r.id=u.role_id
      WHERE u.employee_code=$1 AND u.status='ACTIVE'`,
    [body.managerCode],
  );
  if (!m || m.level < MANAGER_LEVEL || !(await verifySecret(body.managerPin, m.pin_hash))) {
    throw forbidden('MANAGER_PIN_INVALID', 'Invalid manager code or PIN');
  }
  const has = await one(`SELECT 1 FROM role_permissions WHERE role_id=$1 AND permission_code=$2`, [m.role_id, perm]);
  if (!has) throw forbidden('MANAGER_PIN_INVALID', 'Approver lacks permission');
  await query(
    `INSERT INTO manager_approvals (branch_id, action, staff_id, manager_id, reason, reference, entity, entity_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [staff.branchId ?? ((req.headers['x-branch-id'] as string) || null), action, staff.id, m.id, ctx.reason ?? body?.reason ?? null, ctx.reference ?? null, ctx.entity ?? null, ctx.entityId ?? null],
  ).catch(() => {});
  return m.id;
}
