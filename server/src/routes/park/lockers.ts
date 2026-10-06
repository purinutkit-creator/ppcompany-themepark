import type { FastifyInstance } from 'fastify';
import { one, pool, query, tx } from '../../db/pool';
import { audit } from '../../lib/audit';
import { branchOf, requireDeviceOrStaffPerm, requireManagerApproval, requireStaff } from '../../lib/auth';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { i18n, managerApproval, parse, uuid, z } from '../../lib/validate';
import { Outbox } from '../../lib/realtime';
import { endLockerSessionTx, forceOpenLocker, openLockerByScan } from '../../services/park/lockers';
import { addPayment, cancelSale, createSale, getSaleDetail } from '../../services/park/sales';
import { anyActor, deviceIdOf, idemKey, lang } from './util';

const lockerSchema = z.object({
  code: z.string().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/),
  bank: z.string().min(1).max(20).default('A'),
  size: z.enum(['S', 'M', 'L', 'XL']).default('M'),
  zone_id: uuid.nullish(),
  status: z.enum(['AVAILABLE', 'OCCUPIED', 'OUT_OF_SERVICE']).default('AVAILABLE'),
  driver: z.enum(['SIMULATOR', 'HTTP', 'EDGE_AGENT']).default('SIMULATOR'),
  controller_config: z.record(z.string(), z.any()).default({}),
  device_id: uuid.nullish(),
  is_active: z.boolean().default(true),
});
const rateSchema = z.object({ label: i18n, size: z.enum(['S', 'M', 'L', 'XL']).nullish(), minutes: z.number().int().min(1).max(10080).nullish(), price: z.coerce.number().min(0), member_price: z.coerce.number().min(0).nullish(), sort: z.number().int().default(0), is_active: z.boolean().default(true) });

export default async function parkLockerRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requireDeviceOrStaffPerm('lockers.operate', 'lockers.manage', 'kiosk' as any) }, async (req) => ({
    lockers: await query(
      `SELECT l.*, s.id AS session_id, s.expire_at, s.start_at, s.open_count, c.code AS credential_code, m.member_no, m.first_name
         FROM lockers l LEFT JOIN locker_sessions s ON s.locker_id=l.id AND s.status='ACTIVE' LEFT JOIN credentials c ON c.id=s.credential_id LEFT JOIN members m ON m.id=s.member_id
        WHERE l.branch_id=$1 AND l.is_active ORDER BY l.bank, l.code`,
      [branchOf(req)],
    ),
    rates: await query(`SELECT * FROM locker_rates WHERE (branch_id=$1 OR branch_id IS NULL) AND is_active ORDER BY sort, minutes NULLS LAST`, [branchOf(req)]),
  }));

  /** Rent a locker: scan wristband → choose locker / duration → pay with wallet (or cash at staff station). */
  app.post('/rent', { preHandler: requireDeviceOrStaffPerm('lockers.operate', 'kiosk' as any) }, async (req) => {
    const b = parse(z.object({ code: z.string().max(300), rateId: uuid, lockerId: uuid.nullish(), method: z.enum(['WALLET', 'CASH', 'PROMPTPAY', 'CARD']).default('WALLET'), received: z.coerce.number().min(0).nullish(), language: lang.default('th') }), req.body);
    if (b.method === 'CASH' && !req.staff) throw forbidden('STAFF_ONLY', 'Cash is taken by staff');
    const key = idemKey(req);
    if (!key) throw badRequest('IDEMPOTENCY_KEY_REQUIRED');
    const { sale } = await createSale({
      branchId: branchOf(req), channel: 'LOCKER', credentialPayload: b.code, lines: [{ type: 'LOCKER', refId: b.rateId, qty: 1, meta: { lockerId: b.lockerId ?? undefined } }],
      clientRef: `locker:${key}`, staffId: req.staff?.id ?? null, deviceId: deviceIdOf(req), language: b.language,
    });
    let r: Awaited<ReturnType<typeof addPayment>> | null = null;
    if (sale.status !== 'PAID') {
      try {
        r = await addPayment(sale.id, { method: b.method, credentialPayload: b.method === 'WALLET' ? b.code : null, received: b.received ?? null, idempotencyKey: `lockerpay:${key}` }, { actor: anyActor(req), staffId: req.staff?.id ?? null, deviceId: deviceIdOf(req), channel: 'LOCKER' });
      } catch (e) {
        // Payment refused (e.g. insufficient balance): release the hold immediately.
        if (b.method === 'WALLET' || b.method === 'CASH') await cancelSale(sale.id, 'PAYMENT_FAILED', anyActor(req)).catch(() => {});
        throw e;
      }
    }
    const d = await getSaleDetail(pool, sale.id);
    const session = await one<any>(`SELECT s.*, l.code AS locker_code, l.bank FROM locker_sessions s JOIN lockers l ON l.id=s.locker_id WHERE s.sale_id=$1`, [sale.id]);
    return { sale: d.sale, payment: r?.payment ? { ...r.payment, provider_txn_id: undefined } : null, session };
  });

  /** Open by scanning the same wristband (locker controller / kiosk at the locker bank). */
  app.post('/open', { preHandler: requireDeviceOrStaffPerm('lockers.operate', 'kiosk' as any) }, async (req) => {
    const b = parse(z.object({ code: z.string().max(300), release: z.boolean().default(false) }), req.body);
    return openLockerByScan(branchOf(req), b.code, { deviceId: deviceIdOf(req), release: b.release });
  });
  app.post('/:id/force-open', { preHandler: requireStaff('lockers.force_open') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ release: z.boolean().default(false), reason: z.string().min(3).max(200), ...managerApproval }), req.body);
    const approver = await requireManagerApproval(req, 'LOCKER_FORCE_OPEN', 'lockers.force_open', b, { reason: b.reason, entity: 'locker', entityId: id });
    const r = await forceOpenLocker(id, req.staff!.id, b.release);
    await audit(req, { action: 'LOCKER_FORCE_OPEN', entity: 'locker', entityId: id, newValue: { release: b.release, reason: b.reason }, approvedBy: approver });
    return r;
  });
  app.post('/sessions/:id/end', { preHandler: requireStaff('lockers.operate') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const out = new Outbox();
    const r = await tx((c) => endLockerSessionTx(c, id, 'ENDED', out));
    await out.flush();
    if (!r) throw notFound('Active session');
    await audit(req, { action: 'LOCKER_RELEASE', entity: 'locker_session', entityId: id });
    return r;
  });
  app.get('/:id/log', { preHandler: requireStaff('lockers.operate') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return query(`SELECT a.*, c.code AS credential_code, u.name AS staff_name FROM locker_access_logs a LEFT JOIN credentials c ON c.id=a.credential_id LEFT JOIN users u ON u.id=a.staff_id WHERE a.locker_id=$1 ORDER BY a.created_at DESC LIMIT 100`, [id]);
  });

  // ---------------- configuration
  app.post('/', { preHandler: requireStaff('lockers.manage') }, async (req) => {
    const b = parse(lockerSchema, req.body);
    const row = await one<any>(
      `INSERT INTO lockers (branch_id, code, bank, size, zone_id, status, driver, controller_config, device_id, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [branchOf(req), b.code.toUpperCase(), b.bank, b.size, b.zone_id ?? null, b.status, b.driver, b.controller_config, b.device_id ?? null, b.is_active],
    );
    await audit(req, { action: 'LOCKER_CREATE', entity: 'locker', entityId: row.id, newValue: b });
    return row;
  });
  app.post('/bulk', { preHandler: requireStaff('lockers.manage') }, async (req) => {
    const b = parse(z.object({ bank: z.string().min(1).max(20), prefix: z.string().min(1).max(5).default('L'), from: z.number().int().min(1).max(9999), to: z.number().int().min(1).max(9999), size: z.enum(['S', 'M', 'L', 'XL']).default('M'), zone_id: uuid.nullish() }), req.body);
    if (b.to < b.from || b.to - b.from > 500) throw badRequest('INVALID_RANGE');
    let n = 0;
    for (let i = b.from; i <= b.to; i++) {
      const r = await one(`INSERT INTO lockers (branch_id, code, bank, size, zone_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`, [branchOf(req), `${b.prefix}-${i}`, b.bank, b.size, b.zone_id ?? null]);
      if (r) n++;
    }
    await audit(req, { action: 'LOCKER_BULK_CREATE', entity: 'locker', newValue: { ...b, created: n } });
    return { created: n };
  });
  app.put('/:id', { preHandler: requireStaff('lockers.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(lockerSchema, req.body);
    const old = await one<any>(`SELECT * FROM lockers WHERE id=$1 AND branch_id=$2`, [id, branchOf(req)]);
    if (!old) throw notFound('Locker');
    await query(`UPDATE lockers SET code=$2, bank=$3, size=$4, zone_id=$5, status=$6, driver=$7, controller_config=$8, device_id=$9, is_active=$10 WHERE id=$1`, [
      id, b.code.toUpperCase(), b.bank, b.size, b.zone_id ?? null, b.status, b.driver, b.controller_config, b.device_id ?? null, b.is_active,
    ]);
    await audit(req, { action: 'LOCKER_UPDATE', entity: 'locker', entityId: id, oldValue: old, newValue: b });
    return { ok: true };
  });
  app.post('/rates', { preHandler: requireStaff('lockers.manage') }, async (req) => {
    const b = parse(rateSchema, req.body);
    const row = await one(`INSERT INTO locker_rates (branch_id, size, label, minutes, price, member_price, sort, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [
      branchOf(req), b.size ?? null, b.label, b.minutes ?? null, b.price, b.member_price ?? null, b.sort, b.is_active,
    ]);
    await audit(req, { action: 'LOCKER_RATE_CREATE', entity: 'locker_rate', newValue: b });
    return row;
  });
  app.put('/rates/:id', { preHandler: requireStaff('lockers.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(rateSchema, req.body);
    await query(`UPDATE locker_rates SET size=$2, label=$3, minutes=$4, price=$5, member_price=$6, sort=$7, is_active=$8 WHERE id=$1`, [id, b.size ?? null, b.label, b.minutes ?? null, b.price, b.member_price ?? null, b.sort, b.is_active]);
    await audit(req, { action: 'LOCKER_RATE_UPDATE', entity: 'locker_rate', entityId: id, newValue: b });
    return { ok: true };
  });
}
