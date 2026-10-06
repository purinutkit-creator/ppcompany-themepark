import type { FastifyInstance } from 'fastify';
import { one, pool, query, tx } from '../../db/pool';
import { audit } from '../../lib/audit';
import { branchOf, requireDeviceOrStaffPerm, requireStaff } from '../../lib/auth';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { i18n, parse, uuid, z } from '../../lib/validate';
import { buyRideAtScanner, loadScanPoint, redeemSaleAtScanner, rideBoard, rideScan, setRideStatus } from '../../services/park/rides';
import { callNext, joinQueue, leaveQueue, rideQueueList } from '../../services/park/queues';
import { printQueueSlip } from '../../services/park/print';
import { Outbox } from '../../lib/realtime';
import { anyActor, idemKey, lang, scanBody, staffActor } from './util';

const ENT = z.enum(['ONE_TIME', 'MULTI_USE', 'UNLIMITED', 'TIME_BASED', 'DATE_BASED']);
const rideSchema = z.object({
  code: z.string().min(1).max(30).regex(/^[A-Za-z0-9_-]+$/),
  name: i18n,
  description: i18n.default({}),
  image_url: z.string().max(500).nullish(),
  zone_id: uuid.nullish(),
  min_height: z.number().int().min(0).max(300).nullish(),
  max_height: z.number().int().min(0).max(300).nullish(),
  min_age: z.number().int().min(0).max(120).nullish(),
  max_age: z.number().int().min(0).max(120).nullish(),
  capacity: z.number().int().min(1).max(10000).default(10),
  duration_minutes: z.coerce.number().min(0.1).max(600).default(5),
  status: z.enum(['OPEN', 'CLOSED', 'MAINTENANCE', 'TEMPORARILY_CLOSED']).default('OPEN'),
  ticket_required: z.boolean().default(true),
  addon_enabled: z.boolean().default(true),
  addon_price: z.coerce.number().min(0).nullish(),
  member_price: z.coerce.number().min(0).nullish(),
  peak_price: z.coerce.number().min(0).nullish(),
  tier_prices: z.record(z.string().uuid(), z.coerce.number().min(0)).default({}),
  addon_type: ENT.default('ONE_TIME'),
  addon_uses: z.number().int().min(1).max(1000).default(1),
  addon_valid_minutes: z.number().int().min(1).max(1440).nullish(),
  point_cost: z.number().int().min(1).nullish(),
  queue_enabled: z.boolean().default(false),
  queue_prefix: z.string().min(1).max(3).regex(/^[A-Z]+$/).default('A'),
  operator_id: uuid.nullish(),
  map: z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) }).default({ x: 50, y: 50 }),
  sort: z.number().int().default(0),
  is_active: z.boolean().default(true),
  /** NEW RIDE SETUP: packages that include this ride (no code change needed). */
  package_ids: z.array(z.object({ packageId: uuid, entitlement_type: ENT.default('UNLIMITED'), uses: z.number().int().min(1).nullish() })).optional(),
  /** Create a scan point together with the ride. */
  scan_point: z.object({ code: z.string().min(3).max(40), name: z.string().min(1).max(80), device_id: uuid.nullish(), payment_enabled: z.boolean().default(true) }).nullish(),
});

const spSchema = z.object({
  code: z.string().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(80),
  ride_id: uuid,
  zone_id: uuid.nullish(),
  device_id: uuid.nullish(),
  location: z.string().max(120).nullish(),
  mode: z.enum(['ENTRY', 'QUEUE', 'BOTH']).default('ENTRY'),
  payment_enabled: z.boolean().default(true),
  payment_methods: z.array(z.enum(['WALLET', 'PROMPTPAY', 'CARD', 'CASH'])).default(['WALLET', 'PROMPTPAY', 'CARD', 'CASH']),
  operator_id: uuid.nullish(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

async function rideInBranch(req: any, id: string) {
  const r = await one<any>(`SELECT * FROM rides WHERE id=$1`, [id]);
  if (!r) throw notFound('Ride');
  if (r.branch_id !== branchOf(req)) throw forbidden('OTHER_BRANCH');
  return r;
}
async function spInBranch(req: any, id: string) {
  const sp = await loadScanPoint(pool, id);
  if (sp.branch_id !== branchOf(req)) throw forbidden('OTHER_BRANCH');
  if (sp.status !== 'ACTIVE') throw badRequest('SCAN_POINT_INACTIVE');
  if (req.device && sp.device_id && sp.device_id !== req.device.id) throw forbidden('DEVICE_NOT_ASSIGNED');
  return sp;
}

export default async function parkRideRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requireDeviceOrStaffPerm('rides.view', 'kiosk' as any) }, async (req) => rideBoard(pool, branchOf(req)));
  app.get('/admin', { preHandler: requireStaff('rides.manage') }, async (req) =>
    query(
      `SELECT r.*, COALESCE((SELECT json_agg(json_build_object('packageId', pr.package_id, 'entitlement_type', pr.entitlement_type, 'uses', pr.uses)) FROM package_rides pr WHERE pr.ride_id=r.id), '[]') AS package_ids,
              (SELECT json_agg(sp ORDER BY sp.code) FROM ride_scan_points sp WHERE sp.ride_id=r.id) AS scan_points
         FROM rides r WHERE r.branch_id=$1 ORDER BY r.sort, r.code`,
      [branchOf(req)],
    ),
  );
  app.get('/:id', { preHandler: requireDeviceOrStaffPerm('rides.view') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const r = await rideInBranch(req, id);
    const scanPoints = await query(`SELECT * FROM ride_scan_points WHERE ride_id=$1 ORDER BY code`, [id]);
    const recent = await query(
      `SELECT l.*, c.code AS credential_code FROM ride_access_logs l LEFT JOIN credentials c ON c.id=l.credential_id WHERE l.ride_id=$1 ORDER BY l.created_at DESC LIMIT 30`,
      [id],
    );
    const pendingCash = await query(
      `SELECT p.id AS payment_id, p.amount, p.created_at, s.id AS sale_id, s.sale_no, c.code AS credential_code FROM sale_payments p JOIN sales s ON s.id=p.sale_id
         JOIN sale_items si ON si.sale_id=s.id AND si.item_type='RIDE_ADDON' AND si.ref_id=$1 LEFT JOIN credentials c ON c.id=s.credential_id
        WHERE p.status='WAITING_CASH' ORDER BY p.created_at`,
      [id],
    );
    const board = (await rideBoard(pool, r.branch_id)).find((x) => x.id === id);
    return { ride: { ...r, ...board }, scanPoints, recent, pendingCash, queue: r.queue_enabled ? await rideQueueList(pool, id) : [] };
  });

  // ---------------------------------------------------------------- operator
  app.post('/:id/status', { preHandler: requireStaff('rides.operate') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ status: z.enum(['OPEN', 'CLOSED', 'MAINTENANCE', 'TEMPORARILY_CLOSED']).optional(), paused: z.boolean().optional(), reason: z.string().max(200).nullish() }), req.body);
    const old = await rideInBranch(req, id);
    const r = await setRideStatus(id, b, staffActor(req));
    await audit(req, { action: 'RIDE_STATUS', entity: 'ride', entityId: id, oldValue: { status: old.status, paused: old.entry_paused }, newValue: b });
    return r;
  });
  /** Operator manual approve (e.g. visual height check, comp ride) / manual deny. */
  app.post('/:id/manual', { preHandler: requireStaff('rides.operate') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ decision: z.enum(['APPROVE', 'DENY']), code: z.string().max(300).nullish(), credentialId: uuid.nullish(), reason: z.string().min(2).max(200) }), req.body);
    const ride = await rideInBranch(req, id);
    let credId = b.credentialId ?? null;
    if (!credId && b.code) {
      const { findCredential } = await import('../../services/park/cards');
      credId = (await findCredential(b.code)).id;
    }
    const row = await one<any>(
      `INSERT INTO ride_access_logs (branch_id, ride_id, credential_id, member_id, result, reason_code, checks, operator_id, manual)
       VALUES ($1,$2,$3,(SELECT member_id FROM credentials WHERE id=$3),$4,$5,$6,$7,true) RETURNING *`,
      [ride.branch_id, id, credId, b.decision === 'APPROVE' ? 'GRANTED' : 'DENIED', b.decision === 'APPROVE' ? 'MANUAL_APPROVE' : 'OPERATOR_DENIED', JSON.stringify([{ key: 'MANUAL', ok: b.decision === 'APPROVE', detail: b.reason }]), req.staff!.id],
    );
    const { publish } = await import('../../lib/realtime');
    const { EVENTS, rooms } = await import('@kiosk/shared');
    await publish([rooms.ride(id), rooms.branchRides(ride.branch_id)], EVENTS.RIDE_SCAN, { logId: row.id, rideId: id, result: row.result, reasonCode: row.reason_code, manual: true, at: row.created_at, by: req.staff!.name });
    await audit(req, { action: b.decision === 'APPROVE' ? 'RIDE_MANUAL_APPROVE' : 'RIDE_MANUAL_DENY', entity: 'ride', entityId: id, newValue: { credentialId: credId, reason: b.reason } });
    return row;
  });

  // ---------------------------------------------------------------- scan points (device or staff)
  app.get('/scan-points/:id', { preHandler: requireDeviceOrStaffPerm('rides.view', 'rides.operate') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const sp = await spInBranch(req, id);
    const ride = await one<any>(`SELECT id, code, name, image_url, status, entry_paused, addon_enabled, addon_price, member_price, queue_enabled, min_height, min_age, capacity, duration_minutes FROM rides WHERE id=$1`, [sp.ride_id]);
    return { scanPoint: sp, ride };
  });
  app.post('/scan-points/:id/scan', { preHandler: requireDeviceOrStaffPerm('rides.operate'), config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(scanBody, req.body);
    await spInBranch(req, id);
    return rideScan(id, b.code, { deviceId: req.device?.id ?? null, staffId: req.staff?.id ?? null });
  });
  /** BUY RIDE AT SCANNER (wallet = instant, others = pending sale). */
  app.post('/scan-points/:id/buy', { preHandler: requireDeviceOrStaffPerm('rides.operate') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ code: z.string().max(300).nullish(), credentialId: uuid.nullish(), method: z.enum(['WALLET', 'PROMPTPAY', 'CARD', 'CASH']), language: lang.default('th') }), req.body);
    await spInBranch(req, id);
    const key = idemKey(req);
    if (!key) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    return buyRideAtScanner(id, { raw: b.code ?? null, credentialId: b.credentialId ?? null, method: b.method, idempotencyKey: key, deviceId: req.device?.id ?? null, staffId: req.staff?.id ?? null, language: b.language });
  });
  app.post('/scan-points/:id/redeem', { preHandler: requireDeviceOrStaffPerm('rides.operate') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ saleId: uuid }), req.body);
    await spInBranch(req, id);
    return redeemSaleAtScanner(id, b.saleId, { deviceId: req.device?.id ?? null, staffId: req.staff?.id ?? null });
  });
  app.post('/scan-points/:id/queue', { preHandler: requireDeviceOrStaffPerm('rides.operate', 'queue.rides') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ code: z.string().max(300), partySize: z.number().int().min(1).max(20).default(1), print: z.boolean().default(false), language: lang.default('th') }), req.body);
    const sp = await spInBranch(req, id);
    const q = await joinQueue(sp.ride_id, { raw: b.code, partySize: b.partySize });
    if (b.print) {
      const out = new Outbox();
      await tx((c) => printQueueSlip(c, { rideName: q.ride.name, queueNo: q.queueNo, ahead: q.ahead, waitMinutes: q.waitMinutes }, sp.branch_id, null, b.language, out));
      await out.flush();
    }
    return q;
  });

  // ---------------------------------------------------------------- virtual queue (operator)
  app.get('/:id/queue', { preHandler: requireDeviceOrStaffPerm('rides.view', 'queue.rides') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await rideInBranch(req, id);
    return rideQueueList(pool, id);
  });
  app.post('/:id/queue/call', { preHandler: requireStaff('queue.rides') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ count: z.number().int().min(1).max(100).nullish() }), req.body ?? {});
    await rideInBranch(req, id);
    const called = await callNext(id, b.count ?? null);
    await audit(req, { action: 'QUEUE_CALL', entity: 'ride', entityId: id, newValue: { called: called.map((c) => c.queue_no) } });
    return called;
  });
  app.post('/queue/:entryId/cancel', { preHandler: requireStaff('queue.rides') }, async (req) => {
    const { entryId } = parse(z.object({ entryId: uuid }), req.params);
    return leaveQueue(entryId, null);
  });
  app.post('/:id/queue/join', { preHandler: requireDeviceOrStaffPerm('queue.rides', 'kiosk' as any) }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ code: z.string().max(300), partySize: z.number().int().min(1).max(20).default(1) }), req.body);
    await rideInBranch(req, id);
    return joinQueue(id, { raw: b.code, partySize: b.partySize });
  });

  // ---------------------------------------------------------------- configuration
  async function saveRide(req: any, id: string | null, b: z.infer<typeof rideSchema>) {
    return tx(async (c) => {
      const params = [b.code.toUpperCase(), b.name, b.description, b.image_url ?? null, b.zone_id ?? null, b.min_height ?? null, b.max_height ?? null, b.min_age ?? null, b.max_age ?? null, b.capacity,
        b.duration_minutes, b.status, b.ticket_required, b.addon_enabled, b.addon_price ?? null, b.member_price ?? null, b.peak_price ?? null, b.tier_prices, b.addon_type, b.addon_uses,
        b.addon_valid_minutes ?? null, b.point_cost ?? null, b.queue_enabled, b.queue_prefix, b.operator_id ?? null, b.map, b.sort, b.is_active];
      const cols = 'code, name, description, image_url, zone_id, min_height, max_height, min_age, max_age, capacity, duration_minutes, status, ticket_required, addon_enabled, addon_price, member_price, peak_price, tier_prices, addon_type, addon_uses, addon_valid_minutes, point_cost, queue_enabled, queue_prefix, operator_id, map, sort, is_active';
      const row = id
        ? await one<any>(`UPDATE rides SET ${cols.split(', ').map((col, i) => `${col}=$${i + 2}`).join(', ')} WHERE id=$1 RETURNING *`, [id, ...params], c)
        : await one<any>(`INSERT INTO rides (branch_id, ${cols}) VALUES ($1, ${params.map((_, i) => `$${i + 2}`).join(',')}) RETURNING *`, [branchOf(req), ...params], c);
      if (b.package_ids) {
        await c.query(`DELETE FROM package_rides WHERE ride_id=$1`, [row.id]);
        for (const p of b.package_ids) await c.query(`INSERT INTO package_rides (package_id, ride_id, entitlement_type, uses) VALUES ($1,$2,$3,$4)`, [p.packageId, row.id, p.entitlement_type, p.uses ?? null]);
      }
      if (b.scan_point) {
        await c.query(`INSERT INTO ride_scan_points (branch_id, code, name, ride_id, zone_id, device_id, payment_enabled) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (code) DO NOTHING`, [
          row.branch_id, b.scan_point.code.toUpperCase(), b.scan_point.name, row.id, row.zone_id, b.scan_point.device_id ?? null, b.scan_point.payment_enabled,
        ]);
      }
      return row;
    });
  }
  app.post('/', { preHandler: requireStaff('rides.manage') }, async (req) => {
    const b = parse(rideSchema, req.body);
    const row = await saveRide(req, null, b);
    await audit(req, { action: 'RIDE_CREATE', entity: 'ride', entityId: row.id, newValue: b });
    return row;
  });
  app.put('/:id', { preHandler: requireStaff('rides.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(rideSchema, req.body);
    const old = await rideInBranch(req, id);
    const row = await saveRide(req, id, b);
    await audit(req, { action: 'RIDE_UPDATE', entity: 'ride', entityId: id, oldValue: old, newValue: b });
    const { publish } = await import('../../lib/realtime');
    const { EVENTS, rooms } = await import('@kiosk/shared');
    await publish([rooms.ride(id), rooms.branchRides(old.branch_id), rooms.branchPublic(old.branch_id)], EVENTS.RIDE_UPDATED, { rideId: id, status: row.status });
    return row;
  });
  app.delete('/:id', { preHandler: requireStaff('rides.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await rideInBranch(req, id);
    await query(`UPDATE rides SET is_active=false WHERE id=$1`, [id]);
    await audit(req, { action: 'RIDE_DISABLE', entity: 'ride', entityId: id });
    return { ok: true };
  });
  app.get('/scan-points/list/all', { preHandler: requireStaff('rides.view') }, async (req) =>
    query(`SELECT sp.*, r.code AS ride_code, r.name AS ride_name, d.code AS device_code, d.status AS device_status FROM ride_scan_points sp JOIN rides r ON r.id=sp.ride_id LEFT JOIN devices d ON d.id=sp.device_id WHERE sp.branch_id=$1 ORDER BY sp.code`, [branchOf(req)]),
  );
  app.post('/scan-points', { preHandler: requireStaff('rides.manage') }, async (req) => {
    const b = parse(spSchema, req.body);
    await rideInBranch(req, b.ride_id);
    const row = await one<any>(
      `INSERT INTO ride_scan_points (branch_id, code, name, ride_id, zone_id, device_id, location, mode, payment_enabled, payment_methods, operator_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [branchOf(req), b.code.toUpperCase(), b.name, b.ride_id, b.zone_id ?? null, b.device_id ?? null, b.location ?? null, b.mode, b.payment_enabled, b.payment_methods, b.operator_id ?? null, b.status],
    );
    await audit(req, { action: 'SCAN_POINT_CREATE', entity: 'scan_point', entityId: row.id, newValue: b });
    return row;
  });
  app.put('/scan-points/:id', { preHandler: requireStaff('rides.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(spSchema, req.body);
    const old = await one<any>(`SELECT * FROM ride_scan_points WHERE id=$1 AND branch_id=$2`, [id, branchOf(req)]);
    if (!old) throw notFound('Scan point');
    await query(
      `UPDATE ride_scan_points SET code=$2, name=$3, ride_id=$4, zone_id=$5, device_id=$6, location=$7, mode=$8, payment_enabled=$9, payment_methods=$10, operator_id=$11, status=$12 WHERE id=$1`,
      [id, b.code.toUpperCase(), b.name, b.ride_id, b.zone_id ?? null, b.device_id ?? null, b.location ?? null, b.mode, b.payment_enabled, b.payment_methods, b.operator_id ?? null, b.status],
    );
    await audit(req, { action: 'SCAN_POINT_UPDATE', entity: 'scan_point', entityId: id, oldValue: old, newValue: b });
    return { ok: true };
  });
  app.delete('/scan-points/:id', { preHandler: requireStaff('rides.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await query(`UPDATE ride_scan_points SET status='INACTIVE' WHERE id=$1 AND branch_id=$2`, [id, branchOf(req)]);
    await audit(req, { action: 'SCAN_POINT_DISABLE', entity: 'scan_point', entityId: id });
    return { ok: true };
  });
  app.get('/log/access', { preHandler: requireStaff('rides.view') }, async (req) => {
    const q = parse(z.object({ rideId: uuid.optional(), q: z.string().max(60).optional(), limit: z.coerce.number().int().max(1000).default(200) }), req.query);
    return query(
      `SELECT l.*, r.code AS ride_code, r.name AS ride_name, c.code AS credential_code, m.member_no, u.name AS operator_name FROM ride_access_logs l JOIN rides r ON r.id=l.ride_id
         LEFT JOIN credentials c ON c.id=l.credential_id LEFT JOIN members m ON m.id=l.member_id LEFT JOIN users u ON u.id=l.operator_id
        WHERE l.branch_id=$1 AND ($2::uuid IS NULL OR l.ride_id=$2) AND ($3::text IS NULL OR c.code ILIKE '%'||$3||'%' OR m.member_no ILIKE '%'||$3||'%')
        ORDER BY l.created_at DESC LIMIT $4`,
      [branchOf(req), q.rideId ?? null, q.q ?? null, q.limit],
    );
  });
  void anyActor;
}
