import type { FastifyRequest } from 'fastify';
import { query, type Db } from '../db/pool';

export interface AuditEntry {
  action: string;
  entity?: string;
  entityId?: string | null;
  orderId?: string | null;
  branchId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  approvedBy?: string | null;
}

export function deviceOf(req: FastifyRequest): string {
  const ua = (req.headers['user-agent'] as string) || '';
  const dev = (req.headers['x-device-id'] as string) || '';
  return [dev, ua.slice(0, 160)].filter(Boolean).join(' | ');
}

export async function audit(req: FastifyRequest | null, e: AuditEntry, db?: Db) {
  const s = req?.staff;
  const who = s ? { id: s.id, name: s.name, role: s.role } : req?.kiosk ? { id: null, name: req.kiosk.code, role: 'KIOSK' } : { id: null, name: 'SYSTEM', role: 'SYSTEM' };
  await query(
    `INSERT INTO audit_logs (user_id, user_name, role, action, entity, entity_id, order_id, branch_id, old_value, new_value, ip, device, approved_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      who.id,
      who.name,
      who.role,
      e.action,
      e.entity ?? null,
      e.entityId ?? null,
      e.orderId ?? null,
      e.branchId ?? s?.branchId ?? req?.kiosk?.branch_id ?? null,
      e.oldValue === undefined ? null : JSON.stringify(e.oldValue),
      e.newValue === undefined ? null : JSON.stringify(e.newValue),
      req?.ip ?? null,
      req ? deviceOf(req) : null,
      e.approvedBy ?? null,
    ],
    db,
  );
}
