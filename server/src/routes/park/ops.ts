import type { FastifyInstance } from 'fastify';
import { one, pool, query } from '../../db/pool';
import { audit } from '../../lib/audit';
import { branchOf, deviceFromToken, requireAnyStaff, requireManagerApproval, requireStaff } from '../../lib/auth';
import { badRequest, forbidden, notFound, unauthorized } from '../../lib/errors';
import { managerApproval, parse, uuid, z } from '../../lib/validate';
import { consolidatedDashboard, liveMap, parkDashboard } from '../../services/park/dashboard';
import { occupancy } from '../../services/park/gates';
import { listStaffNotifications } from '../../services/park/notifications';
import { PARK_REPORTS } from '../../services/park/reports';
import { cashMovement, closeShift, currentShift, listShifts, openShift, shiftSummary } from '../../services/park/shifts';
import { searchTransactions } from '../../services/park/transactions';
import { stockOperation, transferStock } from '../../services/park/inventory';
import { deviceAssignment, markDeviceSeen } from '../../services/park/devices';
import { sendReport } from '../reports';
import { lang, ymd } from './util';

export default async function parkOpsRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- dashboards
  app.get('/dashboard', { preHandler: requireStaff('dashboard.view') }, async (req) => {
    const q = parse(z.object({ date: ymd.optional() }), req.query);
    return parkDashboard(pool, branchOf(req), q.date ?? null);
  });
  app.get('/dashboard/consolidated', { preHandler: requireStaff('dashboard.view') }, async (req) => {
    if (req.staff!.branchId) throw forbidden('ALL_BRANCHES_ONLY', 'Consolidated view is for owners / HQ staff');
    return consolidatedDashboard(pool);
  });
  app.get('/map', { preHandler: requireAnyStaff('dashboard.view', 'gates.view', 'rides.view') }, async (req) => liveMap(pool, branchOf(req)));
  app.get('/occupancy', { preHandler: requireAnyStaff('dashboard.view', 'gates.view') }, async (req) => occupancy(pool, branchOf(req)));

  // ---------------------------------------------------------------- transaction center
  app.get('/transactions', { preHandler: requireStaff('transactions.view') }, async (req) => {
    const q = parse(
      z.object({ q: z.string().max(80).optional(), type: z.string().max(30).optional(), method: z.string().max(30).optional(), staffId: uuid.optional(), storeId: uuid.optional(), from: ymd.optional(), to: ymd.optional(), limit: z.coerce.number().int().max(1000).default(200), offset: z.coerce.number().int().min(0).default(0) }),
      req.query,
    );
    return searchTransactions({ branchId: branchOf(req), ...q });
  });

  // ---------------------------------------------------------------- reports (+ CSV / XLSX export; PDF is rendered client-side)
  app.get('/reports', { preHandler: requireStaff('reports.view') }, async () => Object.keys(PARK_REPORTS));
  app.get('/reports/:type', { preHandler: requireStaff('reports.view') }, async (req, reply) => {
    const { type } = parse(z.object({ type: z.string().max(40) }), req.params);
    const gen = PARK_REPORTS[type];
    if (!gen) throw badRequest('UNKNOWN_REPORT', `Available: ${Object.keys(PARK_REPORTS).join(', ')}`);
    const f = parse(z.object({ from: ymd.optional(), to: ymd.optional(), storeId: uuid.optional(), rideId: uuid.optional(), format: z.enum(['json', 'csv', 'xlsx']).default('json') }), req.query);
    if (f.format !== 'json' && !req.staff!.permissions.has('reports.export')) throw forbidden('PERMISSION_DENIED', 'Missing permission: reports.export');
    const branchId = branchOf(req);
    const b = await one<any>(`SELECT timezone FROM branches WHERE id=$1`, [branchId]);
    const report = await gen({ ...f, branchId, tz: b?.timezone ?? 'Asia/Bangkok' });
    if (f.format !== 'json') await audit(req, { action: 'REPORT_EXPORT', entity: 'report', entityId: type, newValue: f });
    return sendReport(reply, report, f.format, type);
  });

  // ---------------------------------------------------------------- notifications
  app.get('/notifications', { preHandler: requireAnyStaff() }, async (req) => {
    const q = parse(z.object({ unread: z.coerce.boolean().optional(), limit: z.coerce.number().int().max(500).default(100) }), req.query);
    return listStaffNotifications(branchOf(req), q);
  });
  app.post('/notifications/:id/read', { preHandler: requireAnyStaff() }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await query(`UPDATE notifications SET read_at=now(), read_by=$2 WHERE id=$1 AND read_at IS NULL`, [id, req.staff!.id]);
    return { ok: true };
  });
  app.post('/notifications/read-all', { preHandler: requireAnyStaff() }, async (req) => {
    await query(`UPDATE notifications SET read_at=now(), read_by=$2 WHERE audience='STAFF' AND (branch_id=$1 OR branch_id IS NULL) AND read_at IS NULL`, [branchOf(req), req.staff!.id]);
    return { ok: true };
  });

  // ---------------------------------------------------------------- shifts
  app.get('/shifts/current', { preHandler: requireStaff('shifts.open') }, async (req) => currentShift(req.staff!.id));
  app.post('/shifts/open', { preHandler: requireStaff('shifts.open') }, async (req) => {
    const b = parse(z.object({ openingCash: z.coerce.number().min(0).max(1_000_000), terminal: z.enum(['COUNTER', 'POS', 'KIOSK', 'RIDE', 'LOCKER']).default('COUNTER'), storeId: uuid.nullish() }), req.body);
    const s = await openShift({ branchId: branchOf(req), userId: req.staff!.id, terminal: b.terminal, storeId: b.storeId ?? null, deviceId: (req.headers['x-device-id'] as string) || null, openingCash: b.openingCash });
    await audit(req, { action: 'SHIFT_OPEN', entity: 'shift', entityId: s.id, newValue: b });
    return s;
  });
  app.post('/shifts/:id/cash', { preHandler: requireStaff('shifts.open') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ type: z.enum(['CASH_IN', 'CASH_OUT']), amount: z.coerce.number().positive().max(1_000_000), note: z.string().min(2).max(200), ...managerApproval }), req.body);
    const s = await one<any>(`SELECT user_id FROM shifts WHERE id=$1`, [id]);
    if (!s) throw notFound('Shift');
    if (s.user_id !== req.staff!.id && !req.staff!.permissions.has('shifts.manage')) throw forbidden('NOT_YOUR_SHIFT');
    const approver = b.type === 'CASH_OUT' ? await requireManagerApproval(req, 'SHIFT_CASH_OUT', 'shifts.open', b, { reason: b.note, entity: 'shift', entityId: id }) : null;
    const r = await cashMovement({ shiftId: id, userId: req.staff!.id, type: b.type, amount: b.amount, note: b.note });
    await audit(req, { action: `SHIFT_${b.type}`, entity: 'shift', entityId: id, newValue: { amount: b.amount, note: b.note }, approvedBy: approver });
    return r;
  });
  app.post('/shifts/:id/close', { preHandler: requireStaff('shifts.open') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ actualCash: z.coerce.number().min(0).max(10_000_000), note: z.string().max(300).nullish(), printerId: uuid.nullish(), language: lang.default('th') }), req.body);
    const r = await closeShift({ shiftId: id, userId: req.staff!.id, actualCash: b.actualCash, note: b.note ?? null, canManageOthers: req.staff!.permissions.has('shifts.manage'), printerId: b.printerId ?? null, language: b.language });
    await audit(req, { action: 'SHIFT_CLOSE', entity: 'shift', entityId: id, newValue: { actualCash: b.actualCash, expected: r.report.expected, overShort: r.report.overShort } });
    return r;
  });
  app.get('/shifts', { preHandler: requireStaff('shifts.manage') }, async (req) => {
    const q = parse(z.object({ from: z.string().optional(), to: z.string().optional(), userId: uuid.optional(), status: z.enum(['OPEN', 'CLOSED']).optional() }), req.query);
    return listShifts(branchOf(req), q);
  });
  app.get('/shifts/:id', { preHandler: requireStaff('shifts.open') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const s = await shiftSummary(pool, id);
    if (s.shift.user_id !== req.staff!.id && !req.staff!.permissions.has('shifts.manage')) throw forbidden('NOT_YOUR_SHIFT');
    return { ...s, movements: await query(`SELECT m.*, u.name AS user_name FROM cash_movements m LEFT JOIN users u ON u.id=m.user_id WHERE m.shift_id=$1 ORDER BY m.created_at`, [id]) };
  });

  // ---------------------------------------------------------------- inventory
  app.get('/inventory', { preHandler: requireStaff('inventory.view') }, async (req) => {
    const q = parse(z.object({ storeId: uuid.optional(), low: z.coerce.boolean().optional() }), req.query);
    return query(
      `SELECT i.*, s.code AS store_code, s.name AS store_name, p.sku, p.barcode, p.price, p.cost, p.product_type,
              COALESCE((SELECT json_object_agg(lang, name) FROM product_translations WHERE product_id=p.id), '{}') AS name
         FROM inventory i JOIN stores s ON s.id=i.store_id JOIN products p ON p.id=i.product_id
        WHERE s.branch_id=$1 AND ($2::uuid IS NULL OR i.store_id=$2) AND ($3::boolean IS NOT TRUE OR (i.min_qty > 0 AND i.qty <= i.min_qty)) ORDER BY s.code, p.sku`,
      [branchOf(req), q.storeId ?? null, q.low ?? null],
    );
  });
  app.post('/inventory/operation', { preHandler: requireStaff('inventory.manage') }, async (req) => {
    const b = parse(z.object({ storeId: uuid, productId: uuid, type: z.enum(['IN', 'OUT', 'ADJUST', 'WASTE']), qty: z.coerce.number().min(0).max(1_000_000), note: z.string().max(200).nullish(), minQty: z.coerce.number().min(0).nullish() }), req.body);
    const store = await one<any>(`SELECT branch_id FROM stores WHERE id=$1`, [b.storeId]);
    if (!store || store.branch_id !== branchOf(req)) throw notFound('Store');
    const r = await stockOperation({ ...b, userId: req.staff!.id });
    await audit(req, { action: `STOCK_${b.type}`, entity: 'inventory', entityId: `${b.storeId}:${b.productId}`, newValue: { ...b, after: (r as any).qty } });
    return r;
  });
  app.post('/inventory/transfer', { preHandler: requireStaff('inventory.manage') }, async (req) => {
    const b = parse(z.object({ fromStoreId: uuid, toStoreId: uuid, items: z.array(z.object({ productId: uuid, qty: z.coerce.number().positive() })).min(1).max(200), note: z.string().max(200).nullish() }), req.body);
    const r = await transferStock({ ...b, userId: req.staff!.id });
    await audit(req, { action: 'STOCK_TRANSFER', entity: 'inventory_transfer', entityId: r.id, newValue: b });
    return r;
  });
  app.get('/inventory/movements', { preHandler: requireStaff('inventory.view') }, async (req) => {
    const q = parse(z.object({ storeId: uuid.optional(), productId: uuid.optional(), limit: z.coerce.number().int().max(1000).default(200) }), req.query);
    return query(
      `SELECT m.*, s.code AS store_code, p.sku, u.name AS user_name FROM inventory_movements m JOIN stores s ON s.id=m.store_id JOIN products p ON p.id=m.product_id LEFT JOIN users u ON u.id=m.user_id
        WHERE s.branch_id=$1 AND ($2::uuid IS NULL OR m.store_id=$2) AND ($3::uuid IS NULL OR m.product_id=$3) ORDER BY m.created_at DESC LIMIT $4`,
      [branchOf(req), q.storeId ?? null, q.productId ?? null, q.limit],
    );
  });

  app.get('/approvals', { preHandler: requireStaff('audit.view') }, async (req) =>
    query(`SELECT a.*, s.name AS staff_name, m.name AS manager_name FROM manager_approvals a LEFT JOIN users s ON s.id=a.staff_id LEFT JOIN users m ON m.id=a.manager_id WHERE a.branch_id=$1 OR a.branch_id IS NULL ORDER BY a.created_at DESC LIMIT 300`, [branchOf(req)]),
  );
}

/** Paired park devices: who am I / what am I attached to. */
export async function parkDeviceRoutes(app: FastifyInstance) {
  app.get('/me', async (req) => {
    const dev = await deviceFromToken(req.headers['x-device-token'] as string);
    if (!dev) throw unauthorized('Device not paired or token invalid');
    await markDeviceSeen(dev.id, req.ip);
    const { publicParkSettings } = await import('./public');
    return { ...(await deviceAssignment(dev.id)), settings: await publicParkSettings(), languages: await query(`SELECT code, name, native_name, flag, enabled, is_default, sort, overrides FROM languages WHERE enabled ORDER BY sort`), fonts: await query(`SELECT id, family, source, file_url, format, weights FROM fonts ORDER BY family`) };
  });
}
