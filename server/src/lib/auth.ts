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

declare module 'fastify' {
  interface FastifyRequest {
    staff?: StaffCtx;
    kiosk?: KioskCtx;
    agent?: AgentCtx;
  }
}

export interface JwtPayload {
  sub: string;
  tv: number;
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
  body: { managerCode?: string; managerPin?: string } | undefined,
): Promise<string | null> {
  const staff = req.staff!;
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
  return m.id;
}
