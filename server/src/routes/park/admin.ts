import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { EVENTS, rooms } from '@kiosk/shared';
import { one, query, tx } from '../../db/pool';
import { audit } from '../../lib/audit';
import { branchOf, requireStaff, requireAnyStaff } from '../../lib/auth';
import { badRequest, notFound } from '../../lib/errors';
import { publish } from '../../lib/realtime';
import { newDeviceToken } from '../../lib/tokens';
import { i18n, parse, uuid, z } from '../../lib/validate';
import { invalidateBranchCache } from '../../services/park/common';
import { deviceAssignment } from '../../services/park/devices';

const ENT = z.enum(['ONE_TIME', 'MULTI_USE', 'UNLIMITED', 'TIME_BASED', 'DATE_BASED']);
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ticketTypeSchema = z.object({
  code: z.string().min(1).max(30).regex(/^[A-Z0-9_]+$/),
  name: i18n,
  description: i18n.default({}),
  min_age: z.number().int().min(0).max(120).nullish(),
  max_age: z.number().int().min(0).max(120).nullish(),
  min_height: z.number().int().min(0).max(300).nullish(),
  max_height: z.number().int().min(0).max(300).nullish(),
  requires_proof: z.boolean().default(false),
  color: z.string().max(20).default('#0ea5e9'),
  sort: z.number().int().default(0),
  is_active: z.boolean().default(true),
});

const packageSchema = z.object({
  code: z.string().min(1).max(40).regex(/^[A-Z0-9_-]+$/),
  kind: z.enum(['ADMISSION', 'ADDON', 'RIDE_PASS', 'FAST_PASS', 'LOCKER', 'FOOD_VOUCHER', 'WALLET_CREDIT', 'EVENT']).default('ADMISSION'),
  name: i18n,
  description: i18n.default({}),
  terms: i18n.default({}),
  image_url: z.string().max(500).nullish(),
  color: z.string().max(20).default('#6366f1'),
  branch_ids: z.array(uuid).default([]),
  channels: z.array(z.enum(['ONLINE', 'COUNTER', 'KIOSK', 'PORTAL'])).default(['ONLINE', 'COUNTER', 'KIOSK']),
  base_price: z.coerce.number().min(0).default(0),
  days: z.number().int().min(1).max(365).default(1),
  usage_mode: z.enum(['FIXED_DATES', 'FLEX_DAYS']).default('FIXED_DATES'),
  flex_window_days: z.number().int().min(1).max(366).default(1),
  entries_per_day: z.number().int().min(1).max(100).nullish(),
  reentry: z.boolean().default(true),
  transferable: z.boolean().default(false),
  sale_from: ymd.nullish(),
  sale_to: ymd.nullish(),
  valid_days: z.array(z.number().int().min(0).max(6)).default([]),
  time_start: hhmm.nullish(),
  time_end: hhmm.nullish(),
  blackout_dates: z.array(ymd).default([]),
  daily_capacity: z.number().int().min(1).nullish(),
  min_qty: z.number().int().min(1).default(1),
  max_qty: z.number().int().min(1).max(500).default(20),
  guests_per_unit: z.number().int().min(1).max(50).default(1),
  bundle: z.record(z.string().regex(/^[A-Z0-9_]+$/), z.number().int().min(1).max(50)).default({}),
  all_rides: z.boolean().default(false),
  all_rides_type: ENT.default('UNLIMITED'),
  all_rides_uses: z.number().int().min(1).nullish(),
  zone_ids: z.array(uuid).default([]),
  refund_policy: z.enum(['NON_REFUNDABLE', 'FULL_BEFORE_VISIT', 'PARTIAL_BEFORE_VISIT', 'ANYTIME']).default('NON_REFUNDABLE'),
  refund_cutoff_hours: z.number().int().min(0).max(720).default(24),
  refund_fee_pct: z.coerce.number().min(0).max(100).default(0),
  member_only: z.boolean().default(false),
  tier_ids: z.array(uuid).default([]),
  points_eligible: z.boolean().default(true),
  requires_visit_date: z.boolean().default(true),
  sort: z.number().int().default(0),
  is_active: z.boolean().default(true),
  prices: z.array(z.object({ ticket_type_id: uuid.nullish(), price: z.coerce.number().min(0), member_price: z.coerce.number().min(0).nullish(), weekend_price: z.coerce.number().min(0).nullish(), tier_prices: z.record(z.string().uuid(), z.coerce.number().min(0)).default({}) })).default([]),
  rides: z.array(z.object({ ride_id: uuid, entitlement_type: ENT.default('UNLIMITED'), uses: z.number().int().min(1).nullish() })).default([]),
  benefits: z.array(z.object({ type: z.enum(['FOOD_VOUCHER', 'LOCKER', 'FAST_PASS', 'WALLET_CREDIT', 'PHOTO', 'COUPON', 'CUSTOM']), value: z.coerce.number().min(0).default(0), qty: z.number().int().min(1).default(1), name: i18n.default({}), config: z.record(z.string(), z.any()).default({}) })).default([]),
});

const tierSchema = z.object({ code: z.string().min(1).max(30).regex(/^[A-Z0-9_]+$/), name: i18n, rank: z.number().int().min(0).max(1000).default(0), color: z.string().max(20).default('#64748b'), is_default: z.boolean().default(false), is_active: z.boolean().default(true) });

const BENEFIT = z.enum(['TICKET_DISCOUNT', 'FOOD_DISCOUNT', 'RETAIL_DISCOUNT', 'LOCKER_DISCOUNT', 'RIDE_DISCOUNT', 'FREE_RIDE', 'FREE_LOCKER', 'BIRTHDAY_REWARD', 'PRIORITY_QUEUE', 'FAST_PASS', 'FREE_ADMISSION', 'GUEST_DISCOUNT', 'POINT_MULTIPLIER', 'PARKING', 'SPECIAL_EVENT', 'LOUNGE', 'CUSTOM']);
const membershipProductSchema = z.object({
  code: z.string().min(1).max(40).regex(/^[A-Z0-9_-]+$/),
  tier_id: uuid,
  name: i18n,
  description: i18n.default({}),
  image_url: z.string().max(500).nullish(),
  card_design: z.object({ background: z.string().max(200).optional(), foreground: z.string().max(20).optional(), imageUrl: z.string().max(500).optional() }).passthrough().default({}),
  registration_fee: z.coerce.number().min(0).default(0),
  price: z.coerce.number().min(0),
  validity_unit: z.enum(['DAY', 'MONTH', 'YEAR', 'LIFETIME']).default('YEAR'),
  validity_value: z.number().int().min(1).max(100).default(1),
  renewal_price: z.coerce.number().min(0).nullish(),
  early_renewal_days: z.number().int().min(0).max(365).default(30),
  early_renewal_discount_pct: z.coerce.number().min(0).max(100).default(0),
  grace_days: z.number().int().min(0).max(365).default(0),
  upgrade_mode: z.enum(['FULL', 'DIFFERENCE', 'PRORATED']).default('DIFFERENCE'),
  upgrade_price: z.coerce.number().min(0).nullish(),
  point_multiplier: z.coerce.number().min(0).max(100).default(1),
  visit_limit: z.number().int().min(1).nullish(),
  channels: z.array(z.enum(['ONLINE', 'COUNTER', 'KIOSK'])).default(['ONLINE', 'COUNTER', 'KIOSK']),
  sort: z.number().int().default(0),
  is_active: z.boolean().default(true),
  benefits: z.array(z.object({ type: BENEFIT, value: z.coerce.number().default(0), name: i18n.default({}), config: z.record(z.string(), z.any()).default({}) })).default([]),
});

const rewardSchema = z.object({
  code: z.string().min(1).max(40).regex(/^[A-Z0-9_-]+$/),
  name: i18n,
  description: i18n.default({}),
  image_url: z.string().max(500).nullish(),
  reward_type: z.enum(['COUPON', 'TICKET', 'RIDE', 'FOOD', 'DRINK', 'SOUVENIR', 'LOCKER', 'UPGRADE', 'WALLET_CREDIT']),
  points_required: z.number().int().min(1),
  stock: z.number().int().min(0).nullish(),
  start_at: z.string().max(40).nullish(),
  end_at: z.string().max(40).nullish(),
  tier_ids: z.array(uuid).default([]),
  ref_id: uuid.nullish(),
  value: z.coerce.number().min(0).default(0),
  valid_days: z.number().int().min(1).max(3650).default(30),
  per_member_limit: z.number().int().min(1).nullish(),
  sort: z.number().int().default(0),
  is_active: z.boolean().default(true),
});

const zoneSchema = z.object({ code: z.string().min(1).max(30).regex(/^[A-Z0-9_-]+$/), name: i18n, color: z.string().max(20).default('#22c55e'), capacity: z.number().int().min(0).default(0), map: z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100), w: z.number().min(1).max(100), h: z.number().min(1).max(100) }), sort: z.number().int().default(0), is_active: z.boolean().default(true) });
const storeSchema = z.object({ code: z.string().min(1).max(30).regex(/^[A-Z0-9_-]+$/), name: i18n, type: z.enum(['RESTAURANT', 'RETAIL', 'LOCKER', 'SERVICE', 'TICKETING', 'WAREHOUSE']), zone_id: uuid.nullish(), receipt_printer_id: uuid.nullish(), category_ids: z.array(uuid).default([]), is_active: z.boolean().default(true) });
const deviceSchema = z.object({
  code: z.string().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(80),
  type: z.enum(['GATE_SCANNER', 'GATE_CONTROLLER', 'GATE_DISPLAY', 'POS', 'COUNTER', 'KIOSK', 'RIDE_SCANNER', 'KITCHEN_DISPLAY', 'QUEUE_DISPLAY', 'LOCKER_CONTROLLER', 'EDGE_AGENT', 'OTHER']),
  location: z.string().max(120).nullish(),
  zone_id: uuid.nullish(),
  config: z.record(z.string(), z.any()).default({}),
  is_active: z.boolean().default(true),
});

/** Generic CRUD helper: columns are validated by zod, values parameterised. */
function crud(app: FastifyInstance, o: { path: string; table: string; perm: any; schema: z.ZodTypeAny; cols: string[]; branchScoped?: boolean; audit: string; after?: (id: string, b: any, c: any) => Promise<void>; orderBy?: string; list?: string }) {
  app.get(o.path, { preHandler: requireAnyStaff() }, async (req) =>
    query(o.list ?? `SELECT * FROM ${o.table} ${o.branchScoped ? 'WHERE branch_id=$1' : ''} ORDER BY ${o.orderBy ?? 'sort, created_at'}`, o.branchScoped || o.list?.includes('$1') ? [branchOf(req)] : []),
  );
  app.post(o.path, { preHandler: requireStaff(o.perm) }, async (req) => {
    const b = parse(o.schema, req.body) as Record<string, any>;
    const vals = o.cols.map((c) => normalize(b[c]));
    const row = await tx(async (c) => {
      const r = await one<any>(
        `INSERT INTO ${o.table} (${o.branchScoped ? 'branch_id, ' : ''}${o.cols.join(', ')}) VALUES (${o.branchScoped ? '$1, ' : ''}${o.cols.map((_, i) => `$${i + (o.branchScoped ? 2 : 1)}`).join(', ')}) RETURNING *`,
        o.branchScoped ? [branchOf(req), ...vals] : vals,
        c,
      );
      if (o.after) await o.after(r.id, b, c);
      return r;
    });
    await audit(req, { action: `${o.audit}_CREATE`, entity: o.table, entityId: row.id, newValue: b });
    return row;
  });
  app.put(`${o.path}/:id`, { preHandler: requireStaff(o.perm) }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(o.schema, req.body) as Record<string, any>;
    const old = await one(`SELECT * FROM ${o.table} WHERE id=$1`, [id]);
    if (!old) throw notFound(o.table);
    await tx(async (c) => {
      await c.query(`UPDATE ${o.table} SET ${o.cols.map((col, i) => `${col}=$${i + 2}`).join(', ')} WHERE id=$1`, [id, ...o.cols.map((col) => normalize(b[col]))]);
      if (o.after) await o.after(id, b, c);
    });
    await audit(req, { action: `${o.audit}_UPDATE`, entity: o.table, entityId: id, oldValue: old, newValue: b });
    return { ok: true };
  });
  app.delete(`${o.path}/:id`, { preHandler: requireStaff(o.perm) }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const old = await one(`SELECT * FROM ${o.table} WHERE id=$1`, [id]);
    if (!old) throw notFound(o.table);
    // Soft delete when the table has is_active (history keeps references).
    if ('is_active' in (old as any)) await query(`UPDATE ${o.table} SET is_active=false WHERE id=$1`, [id]);
    else await query(`DELETE FROM ${o.table} WHERE id=$1`, [id]);
    await audit(req, { action: `${o.audit}_DELETE`, entity: o.table, entityId: id, oldValue: old });
    return { ok: true };
  });
}
const normalize = (v: unknown) => (v === undefined ? null : v && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v);

async function catalogChanged() {
  const branches = await query<{ id: string }>(`SELECT id FROM branches`);
  await publish([rooms.global, ...branches.map((b) => rooms.branchPublic(b.id)), ...branches.map((b) => rooms.branchCounter(b.id))], EVENTS.MENU_UPDATED, { scope: 'park' });
}

export default async function parkAdminRoutes(app: FastifyInstance) {
  crud(app, { path: '/ticket-types', table: 'ticket_types', perm: 'tickets.manage', schema: ticketTypeSchema, cols: ['code', 'name', 'description', 'min_age', 'max_age', 'min_height', 'max_height', 'requires_proof', 'color', 'sort', 'is_active'], audit: 'TICKET_TYPE', after: async () => void catalogChanged() });

  const PKG_COLS = ['code', 'kind', 'name', 'description', 'terms', 'image_url', 'color', 'branch_ids', 'channels', 'base_price', 'days', 'usage_mode', 'flex_window_days', 'entries_per_day', 'reentry', 'transferable', 'sale_from', 'sale_to', 'valid_days',
    'time_start', 'time_end', 'blackout_dates', 'daily_capacity', 'min_qty', 'max_qty', 'guests_per_unit', 'bundle', 'all_rides', 'all_rides_type', 'all_rides_uses', 'zone_ids', 'refund_policy', 'refund_cutoff_hours', 'refund_fee_pct',
    'member_only', 'tier_ids', 'points_eligible', 'requires_visit_date', 'sort', 'is_active'];
  crud(app, {
    path: '/packages', table: 'packages', perm: 'tickets.manage', schema: packageSchema, cols: PKG_COLS, audit: 'PACKAGE',
    list: `SELECT p.*, p.sale_from::text AS sale_from, p.sale_to::text AS sale_to, to_char(p.time_start,'HH24:MI') AS time_start, to_char(p.time_end,'HH24:MI') AS time_end,
             COALESCE((SELECT json_agg(pp) FROM package_prices pp WHERE pp.package_id=p.id), '[]') AS prices,
             COALESCE((SELECT json_agg(pr) FROM package_rides pr WHERE pr.package_id=p.id), '[]') AS rides,
             COALESCE((SELECT json_agg(b) FROM package_benefits b WHERE b.package_id=p.id), '[]') AS benefits,
             (SELECT COUNT(*)::int FROM tickets t WHERE t.package_id=p.id AND t.status IN ('ACTIVE','USED')) AS sold
        FROM packages p ORDER BY p.sort, p.created_at`,
    after: async (id, b, c) => {
      if (b.bundle && Object.keys(b.bundle).length) {
        for (const code of Object.keys(b.bundle)) if (!(await one(`SELECT 1 FROM ticket_types WHERE code=$1`, [code], c))) throw badRequest('UNKNOWN_TICKET_TYPE', `Bundle ticket type ${code} not found`);
      }
      await c.query(`DELETE FROM package_prices WHERE package_id=$1`, [id]);
      for (const p of b.prices) await c.query(`INSERT INTO package_prices (package_id, ticket_type_id, price, member_price, weekend_price, tier_prices) VALUES ($1,$2,$3,$4,$5,$6)`, [id, p.ticket_type_id ?? null, p.price, p.member_price ?? null, p.weekend_price ?? null, p.tier_prices]);
      await c.query(`DELETE FROM package_rides WHERE package_id=$1`, [id]);
      for (const r of b.rides) await c.query(`INSERT INTO package_rides (package_id, ride_id, entitlement_type, uses) VALUES ($1,$2,$3,$4)`, [id, r.ride_id, r.entitlement_type, r.uses ?? null]);
      await c.query(`DELETE FROM package_benefits WHERE package_id=$1`, [id]);
      for (const bn of b.benefits) await c.query(`INSERT INTO package_benefits (package_id, type, value, qty, name, config) VALUES ($1,$2,$3,$4,$5,$6)`, [id, bn.type, bn.value, bn.qty, bn.name, bn.config]);
      void catalogChanged();
    },
  });

  crud(app, {
    path: '/tiers', table: 'member_tiers', perm: 'membership.manage', schema: tierSchema, cols: ['code', 'name', 'rank', 'color', 'is_default', 'is_active'], audit: 'TIER', orderBy: 'rank',
    after: async (id, b, c) => {
      if (b.is_default) await c.query(`UPDATE member_tiers SET is_default=false WHERE id<>$1`, [id]);
    },
  });
  crud(app, {
    path: '/membership-products', table: 'membership_products', perm: 'membership.manage', schema: membershipProductSchema, audit: 'MEMBERSHIP_PRODUCT',
    cols: ['code', 'tier_id', 'name', 'description', 'image_url', 'card_design', 'registration_fee', 'price', 'validity_unit', 'validity_value', 'renewal_price', 'early_renewal_days', 'early_renewal_discount_pct', 'grace_days', 'upgrade_mode', 'upgrade_price', 'point_multiplier', 'visit_limit', 'channels', 'sort', 'is_active'],
    list: `SELECT mp.*, t.code AS tier_code, t.name AS tier_name, t.color AS tier_color, COALESCE((SELECT json_agg(b ORDER BY b.sort) FROM membership_benefits b WHERE b.product_id=mp.id), '[]') AS benefits,
             (SELECT COUNT(*)::int FROM memberships ms WHERE ms.product_id=mp.id AND ms.status='ACTIVE') AS active_members
        FROM membership_products mp JOIN member_tiers t ON t.id=mp.tier_id ORDER BY mp.sort, t.rank`,
    after: async (id, b, c) => {
      await c.query(`DELETE FROM membership_benefits WHERE product_id=$1`, [id]);
      let i = 0;
      for (const bn of b.benefits) await c.query(`INSERT INTO membership_benefits (product_id, type, value, name, config, sort) VALUES ($1,$2,$3,$4,$5,$6)`, [id, bn.type, bn.value, bn.name, bn.config, i++]);
    },
  });
  crud(app, { path: '/rewards', table: 'rewards', perm: 'rewards.manage', schema: rewardSchema, audit: 'REWARD', cols: ['code', 'name', 'description', 'image_url', 'reward_type', 'points_required', 'stock', 'start_at', 'end_at', 'tier_ids', 'ref_id', 'value', 'valid_days', 'per_member_limit', 'sort', 'is_active'] });
  crud(app, { path: '/zones', table: 'zones', perm: 'zones.manage', schema: zoneSchema, branchScoped: true, audit: 'ZONE', cols: ['code', 'name', 'color', 'capacity', 'map', 'sort', 'is_active'] });
  crud(app, { path: '/stores', table: 'stores', perm: 'inventory.manage', schema: storeSchema, branchScoped: true, audit: 'STORE', orderBy: 'code', cols: ['code', 'name', 'type', 'zone_id', 'receipt_printer_id', 'category_ids', 'is_active'] });

  // ---------------- coupons
  app.get('/coupons', { preHandler: requireStaff('promotions.manage') }, async (req) => {
    const q = parse(z.object({ q: z.string().max(40).optional(), promotionId: uuid.optional() }), req.query);
    return query(
      `SELECT c.*, p.name AS promotion_name, m.member_no FROM coupons c JOIN promotions p ON p.id=c.promotion_id LEFT JOIN members m ON m.id=c.member_id
        WHERE ($1::text IS NULL OR c.code ILIKE '%'||$1||'%') AND ($2::uuid IS NULL OR c.promotion_id=$2) ORDER BY c.created_at DESC LIMIT 500`,
      [q.q ?? null, q.promotionId ?? null],
    );
  });
  app.post('/coupons', { preHandler: requireStaff('promotions.manage') }, async (req) => {
    const b = parse(z.object({ promotionId: uuid, code: z.string().min(3).max(30).regex(/^[A-Za-z0-9_-]+$/).nullish(), qty: z.number().int().min(1).max(5000).default(1), prefix: z.string().max(8).regex(/^[A-Z0-9]*$/).default('CP'), memberId: uuid.nullish(), maxUses: z.number().int().min(1).default(1), validFrom: ymd.nullish(), validTo: ymd.nullish() }), req.body);
    const codes: string[] = [];
    await tx(async (c) => {
      for (let i = 0; i < b.qty; i++) {
        const code = b.qty === 1 && b.code ? b.code.toUpperCase() : `${b.prefix}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        await c.query(`INSERT INTO coupons (code, promotion_id, member_id, max_uses, valid_from, valid_to, source) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [code, b.promotionId, b.memberId ?? null, b.maxUses, b.validFrom ?? null, b.validTo ?? null, b.qty > 1 ? 'BATCH' : 'MANUAL']);
        codes.push(code);
      }
    });
    await audit(req, { action: 'COUPON_CREATE', entity: 'coupon', newValue: { ...b, codes: codes.length } });
    return { codes };
  });
  app.post('/coupons/:id/void', { preHandler: requireStaff('promotions.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await query(`UPDATE coupons SET status='VOID' WHERE id=$1`, [id]);
    await audit(req, { action: 'COUPON_VOID', entity: 'coupon', entityId: id });
    return { ok: true };
  });

  // ---------------- devices
  app.get('/devices', { preHandler: requireAnyStaff('devices.manage', 'gates.view', 'dashboard.view') }, async (req) =>
    query(
      `SELECT d.id, d.branch_id, d.code, d.name, d.type, d.location, d.zone_id, d.ip, d.app_version, d.last_error, d.last_seen_at, d.config, d.is_active, d.created_at,
              CASE WHEN d.last_seen_at > now() - interval '2 minutes' AND d.status <> 'ERROR' THEN 'ONLINE' WHEN d.status='ERROR' THEN 'ERROR' ELSE 'OFFLINE' END AS status,
              (d.token_hash IS NOT NULL) AS paired, z.name AS zone_name,
              (SELECT string_agg(g.code || ':' || gd.role, ', ') FROM gate_devices gd JOIN gates g ON g.id=gd.gate_id WHERE gd.device_id=d.id) AS gates,
              (SELECT string_agg(sp.code, ', ') FROM ride_scan_points sp WHERE sp.device_id=d.id) AS scan_points
         FROM devices d LEFT JOIN zones z ON z.id=d.zone_id WHERE d.branch_id=$1 ORDER BY d.type, d.code`,
      [branchOf(req)],
    ),
  );
  app.post('/devices', { preHandler: requireStaff('devices.manage') }, async (req) => {
    const b = parse(deviceSchema, req.body);
    const id = crypto.randomUUID();
    const t = newDeviceToken(id);
    await query(`INSERT INTO devices (id, branch_id, code, name, type, location, zone_id, config, is_active, token_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
      id, branchOf(req), b.code.toUpperCase(), b.name, b.type, b.location ?? null, b.zone_id ?? null, b.config, b.is_active, t.hash,
    ]);
    await audit(req, { action: 'DEVICE_CREATE', entity: 'device', entityId: id, newValue: b });
    return { id, token: t.token };
  });
  app.put('/devices/:id', { preHandler: requireStaff('devices.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(deviceSchema, req.body);
    const old = await one<any>(`SELECT * FROM devices WHERE id=$1 AND branch_id=$2`, [id, branchOf(req)]);
    if (!old) throw notFound('Device');
    await query(`UPDATE devices SET code=$2, name=$3, type=$4, location=$5, zone_id=$6, config=$7, is_active=$8 WHERE id=$1`, [id, b.code.toUpperCase(), b.name, b.type, b.location ?? null, b.zone_id ?? null, b.config, b.is_active]);
    await audit(req, { action: 'DEVICE_UPDATE', entity: 'device', entityId: id, oldValue: { ...old, token_hash: undefined }, newValue: b });
    await publish(rooms.parkDevice(id), EVENTS.SETTINGS_UPDATED, { scope: 'device' });
    return { ok: true };
  });
  app.post('/devices/:id/token', { preHandler: requireStaff('devices.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const t = newDeviceToken(id);
    const r = await one(`UPDATE devices SET token_hash=$2 WHERE id=$1 AND branch_id=$3 RETURNING id`, [id, t.hash, branchOf(req)]);
    if (!r) throw notFound('Device');
    await audit(req, { action: 'DEVICE_TOKEN_ROTATE', entity: 'device', entityId: id });
    return { id, token: t.token };
  });
  app.post('/devices/:id/reload', { preHandler: requireStaff('devices.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await publish(rooms.parkDevice(id), EVENTS.SETTINGS_UPDATED, { scope: 'device', reload: true });
    await audit(req, { action: 'DEVICE_RELOAD', entity: 'device', entityId: id });
    return { ok: true };
  });
  app.delete('/devices/:id', { preHandler: requireStaff('devices.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await query(`UPDATE devices SET is_active=false, token_hash=NULL WHERE id=$1 AND branch_id=$2`, [id, branchOf(req)]);
    await audit(req, { action: 'DEVICE_DISABLE', entity: 'device', entityId: id });
    return { ok: true };
  });
  app.get('/devices/:id/assignment', { preHandler: requireStaff('devices.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return deviceAssignment(id);
  });

  // ---------------- per-branch park configuration overrides (capacity, gate policy…)
  app.get('/branch-config', { preHandler: requireStaff('settings.manage') }, async (req) => (await one<any>(`SELECT config FROM branches WHERE id=$1`, [branchOf(req)]))?.config ?? {});
  app.put('/branch-config', { preHandler: requireStaff('settings.manage') }, async (req) => {
    const b = parse(z.record(z.enum(['park', 'gate', 'ride', 'rideQueue', 'wallet', 'booking', 'parkPayment', 'shift', 'locker', 'offline']), z.record(z.string(), z.any())), req.body);
    const old = await one<any>(`SELECT config FROM branches WHERE id=$1`, [branchOf(req)]);
    await query(`UPDATE branches SET config=$2 WHERE id=$1`, [branchOf(req), b]);
    invalidateBranchCache();
    await audit(req, { action: 'BRANCH_CONFIG_CHANGE', entity: 'branch', entityId: branchOf(req), oldValue: old?.config, newValue: b });
    return { ok: true };
  });
}
