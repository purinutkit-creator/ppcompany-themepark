import type { FastifyInstance } from 'fastify';
import { one, pool, query } from '../../db/pool';
import { audit } from '../../lib/audit';
import { branchOf, deviceFromToken, requireDeviceOrStaffPerm, requireManagerApproval, requireStaff } from '../../lib/auth';
import { forbidden, notFound, unauthorized } from '../../lib/errors';
import { managerApproval, parse, uuid, z } from '../../lib/validate';
import { getSettings } from '../../lib/settings';
import {
  assertGateConfig, closeGate, gateApprove, gateDeny, gateOverride, gateScan, gateSummary, handleGateEvent, listGates, manualOpen, occupancy, openGate, resetGate, setEmergency,
} from '../../services/park/gates';
import { markDeviceSeen } from '../../services/park/devices';
import { scanBody, staffActor } from './util';

const gateSchema = z.object({
  code: z.string().min(1).max(30).regex(/^[A-Za-z0-9_-]+$/),
  number: z.number().int().min(1).max(999),
  name: z.object({ th: z.string().max(80).optional(), en: z.string().max(80).optional(), zh: z.string().max(80).optional() }).default({}),
  direction: z.enum(['ENTRY', 'EXIT', 'BOTH']).default('ENTRY'),
  zone_id: uuid.nullish(),
  mode: z.enum(['AUTO', 'MANUAL']).default('AUTO'),
  controller_kind: z.enum(['TURNSTILE', 'FLAP_BARRIER', 'SWING_GATE', 'RELAY', 'GPIO', 'NETWORK']).default('TURNSTILE'),
  driver: z.enum(['SIMULATOR', 'HTTP', 'RELAY_HTTP', 'EDGE_AGENT']).default('SIMULATOR'),
  controller_config: z.record(z.string(), z.any()).default({}),
  open_seconds: z.number().int().min(1).max(120).default(6),
  operator_id: uuid.nullish(),
  is_active: z.boolean().default(true),
  devices: z.array(z.object({ deviceId: uuid, role: z.enum(['SCANNER', 'DISPLAY', 'CONTROLLER']) })).default([]),
});

async function gateInBranch(req: any, id: string) {
  const g = await one<any>(`SELECT * FROM gates WHERE id=$1`, [id]);
  if (!g) throw notFound('Gate');
  if (g.branch_id !== branchOf(req)) throw forbidden('OTHER_BRANCH');
  if (req.device) {
    const bound = await one(`SELECT 1 FROM gate_devices WHERE gate_id=$1 AND device_id=$2`, [id, req.device.id]);
    if (!bound) throw forbidden('DEVICE_NOT_ASSIGNED', 'This device is not assigned to the gate');
  }
  return g;
}

export default async function parkGateRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- read
  app.get('/', { preHandler: requireDeviceOrStaffPerm('gates.view') }, async (req) => ({ gates: await listGates(pool, branchOf(req)), occupancy: await occupancy(pool, branchOf(req)), settings: (await getSettings()).gate }));
  app.get('/:id', { preHandler: requireDeviceOrStaffPerm('gates.view') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await gateInBranch(req, id);
    return gateSummary(pool, id);
  });
  app.get('/:id/status', { preHandler: requireDeviceOrStaffPerm('gates.view') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const g = await gateInBranch(req, id);
    return { id: g.id, code: g.code, state: g.state, stateSince: g.state_since, mode: g.mode, direction: g.direction, currentScanId: g.current_scan_id, lastError: g.last_error };
  });
  app.get('/:id/scans', { preHandler: requireStaff('gates.view') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await gateInBranch(req, id);
    return query(`SELECT s.*, u.name AS decided_by_name FROM gate_scans s LEFT JOIN users u ON u.id=s.decided_by WHERE s.gate_id=$1 ORDER BY s.created_at DESC LIMIT 200`, [id]);
  });
  /** Entry log: every scan (incl. denied) across gates, filterable. */
  app.get('/log/scans', { preHandler: requireStaff('gates.view') }, async (req) => {
    const q = parse(z.object({ result: z.string().max(40).optional(), q: z.string().max(60).optional(), gateId: uuid.optional(), from: z.string().optional(), to: z.string().optional(), limit: z.coerce.number().int().max(1000).default(200) }), req.query);
    return query(
      `SELECT s.*, g.code AS gate_code, t.ticket_no, m.member_no, u.name AS decided_by_name, e.passed_at, e.status AS entry_status
         FROM gate_scans s JOIN gates g ON g.id=s.gate_id LEFT JOIN tickets t ON t.id=s.ticket_id LEFT JOIN members m ON m.id=s.member_id
         LEFT JOIN users u ON u.id=s.decided_by LEFT JOIN entry_logs e ON e.scan_id=s.id
        WHERE s.branch_id=$1 AND ($2::text IS NULL OR s.result = ANY(string_to_array($2, ','))) AND ($3::uuid IS NULL OR s.gate_id=$3)
          AND ($4::text IS NULL OR s.code ILIKE '%'||$4||'%' OR t.ticket_no ILIKE '%'||$4||'%' OR m.member_no ILIKE '%'||$4||'%')
          AND ($5::timestamptz IS NULL OR s.created_at >= $5) AND ($6::timestamptz IS NULL OR s.created_at < $6)
        ORDER BY s.created_at DESC LIMIT $7`,
      [branchOf(req), q.result ?? null, q.gateId ?? null, q.q ?? null, q.from ?? null, q.to ?? null, q.limit],
    );
  });
  app.get('/log/entries', { preHandler: requireStaff('gates.view') }, async (req) => {
    const q = parse(z.object({ date: z.string().optional(), limit: z.coerce.number().int().max(1000).default(200) }), req.query);
    return query(
      `SELECT e.*, g.code AS gate_code, t.ticket_no, m.member_no, c.code AS credential_code, u.name AS operator_name FROM entry_logs e LEFT JOIN gates g ON g.id=e.gate_id
         LEFT JOIN tickets t ON t.id=e.ticket_id LEFT JOIN members m ON m.id=e.member_id LEFT JOIN credentials c ON c.id=e.credential_id LEFT JOIN users u ON u.id=e.operator_id
        WHERE e.branch_id=$1 AND ($2::date IS NULL OR e.visit_date=$2) ORDER BY e.created_at DESC LIMIT $3`,
      [branchOf(req), q.date ?? null, q.limit],
    );
  });
  app.get('/log/security', { preHandler: requireStaff('security.view') }, async (req) =>
    query(
      `SELECT s.*, g.code AS gate_code, t.ticket_no, c.code AS credential_code, u.name AS acknowledged_by_name FROM security_events s LEFT JOIN gates g ON g.id=s.gate_id
         LEFT JOIN tickets t ON t.id=s.ticket_id LEFT JOIN credentials c ON c.id=s.credential_id LEFT JOIN users u ON u.id=s.acknowledged_by
        WHERE s.branch_id=$1 ORDER BY s.created_at DESC LIMIT 300`,
      [branchOf(req)],
    ),
  );
  app.post('/log/security/:id/ack', { preHandler: requireStaff('security.view') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await query(`UPDATE security_events SET acknowledged_by=$2, acknowledged_at=now() WHERE id=$1 AND acknowledged_at IS NULL`, [id, req.staff!.id]);
    return { ok: true };
  });

  // ---------------------------------------------------------------- hardware API (scanner device or staff console)
  /** POST /api/park/gates/:id/scan — the ONLY way a ticket can open a gate. */
  app.post('/:id/scan', { preHandler: requireDeviceOrStaffPerm('gates.operate'), config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(scanBody.extend({ direction: z.enum(['ENTRY', 'EXIT']).nullish() }), req.body);
    await gateInBranch(req, id);
    return gateScan(id, b.code, { source: b.source, deviceId: req.device?.id ?? null, staffId: req.staff?.id ?? null, direction: b.direction ?? null });
  });
  app.post('/:id/approve', { preHandler: requireStaff('gates.operate') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ scanId: uuid }), req.body);
    await gateInBranch(req, id);
    const r = await gateApprove(id, b.scanId, req.staff!);
    await audit(req, { action: 'GATE_APPROVE', entity: 'gate', entityId: id, newValue: { scanId: b.scanId } });
    return r;
  });
  app.post('/:id/deny', { preHandler: requireStaff('gates.operate') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ scanId: uuid, reason: z.string().max(200).nullish() }), req.body);
    await gateInBranch(req, id);
    const r = await gateDeny(id, b.scanId, req.staff!, b.reason ?? null);
    await audit(req, { action: 'GATE_DENY', entity: 'gate', entityId: id, newValue: b });
    return r;
  });
  /** Supervisor override of a denied scan (ticket override). */
  app.post('/:id/override', { preHandler: requireStaff('gates.override') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ scanId: uuid, reason: z.string().min(3).max(200), ...managerApproval }), req.body);
    await gateInBranch(req, id);
    const approver = await requireManagerApproval(req, 'TICKET_OVERRIDE', 'tickets.override', b, { reason: b.reason, entity: 'gate_scan', entityId: b.scanId });
    const r = await gateOverride(id, b.scanId, req.staff!, approver, b.reason);
    await audit(req, { action: 'GATE_OVERRIDE', entity: 'gate', entityId: id, newValue: { scanId: b.scanId, reason: b.reason }, approvedBy: approver });
    return r;
  });
  /** Manual gate open without a ticket. */
  app.post('/:id/open', { preHandler: requireStaff('gates.open') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ reason: z.string().min(3).max(200), ...managerApproval }), req.body);
    await gateInBranch(req, id);
    const approver = await requireManagerApproval(req, 'MANUAL_GATE_OPEN', 'gates.open', b, { reason: b.reason, entity: 'gate', entityId: id });
    const r = await manualOpen(id, req.staff!, approver, b.reason);
    await audit(req, { action: 'GATE_MANUAL_OPEN', entity: 'gate', entityId: id, newValue: { reason: b.reason }, approvedBy: approver });
    return r;
  });
  app.post('/:id/close', { preHandler: requireStaff('gates.operate') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await gateInBranch(req, id);
    const r = await closeGate(id);
    await audit(req, { action: 'GATE_CLOSE', entity: 'gate', entityId: id });
    return r;
  });
  /** Re-send OPEN for an APPROVED gate (never while already OPEN). */
  app.post('/:id/resend-open', { preHandler: requireStaff('gates.operate') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await gateInBranch(req, id);
    return openGate(id, staffActor(req));
  });
  app.post('/:id/reset', { preHandler: requireStaff('gates.operate') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await gateInBranch(req, id);
    await resetGate(id);
    await audit(req, { action: 'GATE_RESET', entity: 'gate', entityId: id });
    return gateSummary(pool, id);
  });
  app.post('/emergency', { preHandler: requireStaff('gates.emergency') }, async (req) => {
    const b = parse(z.object({ on: z.boolean(), gateId: uuid.nullish() }), req.body);
    const r = await setEmergency(branchOf(req), b.gateId ?? null, b.on, staffActor(req));
    await audit(req, { action: b.on ? 'GATE_EMERGENCY_ON' : 'GATE_EMERGENCY_OFF', entity: 'gate', entityId: b.gateId ?? 'ALL', newValue: r });
    return r;
  });
  app.post('/:id/mode', { preHandler: requireStaff('gates.operate') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ mode: z.enum(['AUTO', 'MANUAL']) }), req.body);
    const g = await gateInBranch(req, id);
    await query(`UPDATE gates SET mode=$2 WHERE id=$1`, [id, b.mode]);
    await audit(req, { action: 'GATE_MODE', entity: 'gate', entityId: id, oldValue: { mode: g.mode }, newValue: b });
    const { publish } = await import('../../lib/realtime');
    const { EVENTS, rooms } = await import('@kiosk/shared');
    await publish([rooms.gate(id), rooms.branchGates(g.branch_id)], EVENTS.GATE_STATE, { gateId: id, code: g.code, state: g.state, mode: b.mode });
    return { ok: true };
  });
  app.post('/:id/operator', { preHandler: requireStaff('gates.operate') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ operatorId: uuid.nullish() }), req.body);
    await gateInBranch(req, id);
    await query(`UPDATE gates SET operator_id=$2 WHERE id=$1`, [id, b.operatorId === undefined ? req.staff!.id : b.operatorId]);
    return { ok: true };
  });

  // ---------------------------------------------------------------- configuration
  app.post('/', { preHandler: requireStaff('gates.manage') }, async (req) => {
    const b = parse(gateSchema, req.body);
    assertGateConfig(b.driver, b.controller_config);
    const row = await one<any>(
      `INSERT INTO gates (branch_id, code, number, name, direction, zone_id, mode, controller_kind, driver, controller_config, open_seconds, operator_id, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [branchOf(req), b.code.toUpperCase(), b.number, b.name, b.direction, b.zone_id ?? null, b.mode, b.controller_kind, b.driver, b.controller_config, b.open_seconds, b.operator_id ?? null, b.is_active],
    );
    for (const d of b.devices) await query(`INSERT INTO gate_devices (gate_id, device_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [row.id, d.deviceId, d.role]);
    await audit(req, { action: 'GATE_CREATE', entity: 'gate', entityId: row.id, newValue: b });
    return row;
  });
  app.put('/:id', { preHandler: requireStaff('gates.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(gateSchema, req.body);
    const old = await gateInBranch(req, id);
    assertGateConfig(b.driver, b.controller_config);
    await query(
      `UPDATE gates SET code=$2, number=$3, name=$4, direction=$5, zone_id=$6, mode=$7, controller_kind=$8, driver=$9, controller_config=$10, open_seconds=$11, operator_id=$12, is_active=$13 WHERE id=$1`,
      [id, b.code.toUpperCase(), b.number, b.name, b.direction, b.zone_id ?? null, b.mode, b.controller_kind, b.driver, b.controller_config, b.open_seconds, b.operator_id ?? null, b.is_active],
    );
    await query(`DELETE FROM gate_devices WHERE gate_id=$1`, [id]);
    for (const d of b.devices) await query(`INSERT INTO gate_devices (gate_id, device_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, d.deviceId, d.role]);
    await audit(req, { action: 'GATE_UPDATE', entity: 'gate', entityId: id, oldValue: { ...old, controller_config: { ...old.controller_config, secret: undefined } }, newValue: { ...b, controller_config: { ...b.controller_config, secret: b.controller_config.secret ? '***' : undefined } } });
    return { ok: true };
  });
  app.delete('/:id', { preHandler: requireStaff('gates.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await gateInBranch(req, id);
    await query(`UPDATE gates SET is_active=false WHERE id=$1`, [id]);
    await audit(req, { action: 'GATE_DISABLE', entity: 'gate', entityId: id });
    return { ok: true };
  });
}

/**
 * Hardware callbacks: gate controllers / edge agents report sensor events (passage, closed, obstruction,
 * emergency, fire alarm). Authenticated with the controller's device token.
 */
export async function parkHardwareRoutes(app: FastifyInstance) {
  app.post('/gates/:id/events', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const dev = await deviceFromToken(req.headers['x-device-token'] as string);
    if (!dev) throw unauthorized('Device token required');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ event: z.enum(['OPENED', 'PASSAGE', 'CLOSED', 'OBSTRUCTION', 'EMERGENCY_ON', 'EMERGENCY_OFF', 'FIRE_ALARM', 'FAULT', 'ONLINE', 'OFFLINE']), data: z.record(z.string(), z.any()).default({}) }), req.body);
    const bound = await one(`SELECT 1 FROM gate_devices WHERE gate_id=$1 AND device_id=$2`, [id, dev.id]);
    const cfg = await one<any>(`SELECT controller_config FROM gates WHERE id=$1`, [id]);
    if (!bound && cfg?.controller_config?.deviceId !== dev.id) throw forbidden('DEVICE_NOT_ASSIGNED');
    await markDeviceSeen(dev.id, req.ip);
    await handleGateEvent(id, b.event, b.data);
    return { ok: true };
  });
  app.post('/heartbeat', async (req) => {
    const dev = await deviceFromToken(req.headers['x-device-token'] as string);
    if (!dev) throw unauthorized('Device token required');
    const b = parse(z.object({ version: z.string().max(40).optional() }), req.body ?? {});
    await markDeviceSeen(dev.id, req.ip, b.version ?? null);
    return { ok: true, serverTime: new Date().toISOString() };
  });
}
