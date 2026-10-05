import type { FastifyInstance } from 'fastify';
import { EVENTS, rooms } from '@kiosk/shared';
import { one, query } from '../db/pool';
import { audit } from '../lib/audit';
import { branchOf, requireStaff } from '../lib/auth';
import { notFound } from '../lib/errors';
import { publish } from '../lib/realtime';
import { newDeviceToken } from '../lib/tokens';
import { i18n, parse, uuid, z } from '../lib/validate';

const kioskSchema = z.object({
  code: z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(80),
  default_language: z.enum(['th', 'en', 'zh']).default('th'),
  receipt_printer_id: uuid.nullish(),
  theme: z.record(z.string(), z.any()).default({}),
  idle_timeout: z.coerce.number().int().min(10).max(3600).default(60),
  payment_methods: z.array(z.enum(['QR', 'CASH', 'CARD', 'OTHER'])).default(['QR', 'CASH', 'CARD']),
  order_types: z.array(z.enum(['DINE_IN', 'TAKE_AWAY'])).min(1).default(['DINE_IN', 'TAKE_AWAY']),
  is_active: z.boolean().default(true),
});

const branchSchema = z.object({
  code: z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
  name: i18n,
  address: z.string().max(300).nullish(),
  phone: z.string().max(40).nullish(),
  tax_id: z.string().max(40).nullish(),
  timezone: z.string().max(60).default('Asia/Bangkok'),
  is_active: z.boolean().default(true),
});

export default async function deviceRoutes(app: FastifyInstance) {
  // ---------------- kiosks
  app.get('/kiosks', { preHandler: requireStaff() }, async (req) =>
    query(
      `SELECT k.id, k.branch_id, k.code, k.name, k.default_language, k.receipt_printer_id, k.theme, k.idle_timeout, k.payment_methods, k.order_types,
              k.is_active, k.app_version, k.ip, k.last_seen_at, k.created_at, (k.token_hash IS NOT NULL) AS paired,
              CASE WHEN k.last_seen_at > now() - interval '90 seconds' THEN 'ONLINE' ELSE 'OFFLINE' END AS status,
              p.name AS receipt_printer_name,
              (SELECT COUNT(*)::int FROM orders o WHERE o.kiosk_id=k.id AND o.created_at > date_trunc('day', now())) AS orders_today
         FROM kiosks k LEFT JOIN printers p ON p.id=k.receipt_printer_id WHERE k.branch_id=$1 ORDER BY k.code`,
      [branchOf(req)],
    ),
  );
  app.post('/kiosks', { preHandler: requireStaff('kiosks.manage') }, async (req) => {
    const b = parse(kioskSchema, req.body);
    const id = crypto.randomUUID();
    const t = newDeviceToken(id);
    await query(
      `INSERT INTO kiosks (id, branch_id, code, name, token_hash, default_language, receipt_printer_id, theme, idle_timeout, payment_methods, order_types, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, branchOf(req), b.code.toUpperCase(), b.name, t.hash, b.default_language, b.receipt_printer_id ?? null, b.theme, b.idle_timeout, b.payment_methods, b.order_types, b.is_active],
    );
    await audit(req, { action: 'KIOSK_CREATE', entity: 'kiosk', entityId: id, newValue: b });
    return { id, token: t.token };
  });
  app.put('/kiosks/:id', { preHandler: requireStaff('kiosks.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(kioskSchema, req.body);
    const old = await one<any>(`SELECT * FROM kiosks WHERE id=$1`, [id]);
    if (!old) throw notFound('Kiosk');
    await query(
      `UPDATE kiosks SET code=$2, name=$3, default_language=$4, receipt_printer_id=$5, theme=$6, idle_timeout=$7, payment_methods=$8, order_types=$9, is_active=$10 WHERE id=$1`,
      [id, b.code.toUpperCase(), b.name, b.default_language, b.receipt_printer_id ?? null, b.theme, b.idle_timeout, b.payment_methods, b.order_types, b.is_active],
    );
    await audit(req, { action: 'KIOSK_UPDATE', entity: 'kiosk', entityId: id, oldValue: { ...old, token_hash: undefined }, newValue: b });
    await publish(rooms.kiosk(id), EVENTS.SETTINGS_UPDATED, { scope: 'kiosk' });
    return { ok: true };
  });
  /** Issue a new pairing token (old token stops working immediately). */
  app.post('/kiosks/:id/token', { preHandler: requireStaff('kiosks.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const t = newDeviceToken(id);
    const r = await one(`UPDATE kiosks SET token_hash=$2 WHERE id=$1 RETURNING id`, [id, t.hash]);
    if (!r) throw notFound('Kiosk');
    await audit(req, { action: 'KIOSK_TOKEN_ROTATE', entity: 'kiosk', entityId: id });
    return { id, token: t.token };
  });
  /** Remote reload of a kiosk (e.g. after an update). */
  app.post('/kiosks/:id/reload', { preHandler: requireStaff('kiosks.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await publish(rooms.kiosk(id), EVENTS.SETTINGS_UPDATED, { scope: 'kiosk', reload: true });
    await audit(req, { action: 'KIOSK_RELOAD', entity: 'kiosk', entityId: id });
    return { ok: true };
  });
  app.delete('/kiosks/:id', { preHandler: requireStaff('kiosks.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const old = await one(`DELETE FROM kiosks WHERE id=$1 RETURNING id, code, name`, [id]);
    await audit(req, { action: 'KIOSK_DELETE', entity: 'kiosk', entityId: id, oldValue: old });
    return { ok: true };
  });

  // ---------------- branches
  app.get('/branches', { preHandler: requireStaff() }, async (req) =>
    req.staff!.branchId
      ? query(`SELECT * FROM branches WHERE id=$1`, [req.staff!.branchId])
      : query(`SELECT * FROM branches ORDER BY code`),
  );
  app.post('/branches', { preHandler: requireStaff('branches.manage') }, async (req) => {
    const b = parse(branchSchema, req.body);
    const row = await one<any>(
      `INSERT INTO branches (code, name, address, phone, tax_id, timezone, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.code.toUpperCase(), b.name, b.address ?? null, b.phone ?? null, b.tax_id ?? null, b.timezone, b.is_active],
    );
    // Every branch needs a default kitchen station for routing.
    await query(`INSERT INTO kitchen_stations (branch_id, code, name, is_default) VALUES ($1,'MAIN',$2,true)`, [row.id, { th: 'ครัวหลัก', en: 'Main Kitchen', zh: '主厨房' }]);
    await query(`INSERT INTO stocks (product_id, branch_id) SELECT id, $1 FROM products WHERE track_stock ON CONFLICT DO NOTHING`, [row.id]);
    await audit(req, { action: 'BRANCH_CREATE', entity: 'branch', entityId: row.id, newValue: row });
    return row;
  });
  app.put('/branches/:id', { preHandler: requireStaff('branches.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(branchSchema, req.body);
    const old = await one(`SELECT * FROM branches WHERE id=$1`, [id]);
    if (!old) throw notFound('Branch');
    const row = await one(
      `UPDATE branches SET code=$2, name=$3, address=$4, phone=$5, tax_id=$6, timezone=$7, is_active=$8 WHERE id=$1 RETURNING *`,
      [id, b.code.toUpperCase(), b.name, b.address ?? null, b.phone ?? null, b.tax_id ?? null, b.timezone, b.is_active],
    );
    await audit(req, { action: 'BRANCH_UPDATE', entity: 'branch', entityId: id, oldValue: old, newValue: row });
    return row;
  });
}
