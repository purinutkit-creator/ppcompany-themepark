import type { FastifyInstance, FastifyRequest } from 'fastify';
import { EVENTS, rooms } from '@kiosk/shared';
import { one, query, tx } from '../db/pool';
import { audit } from '../lib/audit';
import { requireStaff } from '../lib/auth';
import { conflict, notFound } from '../lib/errors';
import { publish } from '../lib/realtime';
import { hhmm, i18n, money, parse, uuid, z } from '../lib/validate';
import { loadPromotions } from '../services/menu';

/** Tell every kiosk to refresh its cached menu. */
async function menuChanged() {
  const branches = await query<{ id: string }>(`SELECT id FROM branches`);
  await publish([...branches.map((b) => rooms.branchKiosks(b.id)), ...branches.map((b) => rooms.branchAdmin(b.id))], EVENTS.MENU_UPDATED, { at: Date.now() });
}

const nullableUuid = uuid.nullish().transform((v) => v || null);

const categorySchema = z.object({
  kind: z.enum(['STANDARD', 'RECOMMENDED', 'PROMOTION']).default('STANDARD'),
  name: i18n,
  image_url: z.string().max(500).nullish(),
  icon: z.string().max(40).nullish(),
  sort: z.number().int().default(0),
  station_id: nullableUuid,
  printer_id: nullableUuid,
  schedule_id: nullableUuid,
  is_active: z.boolean().default(true),
  channel: z.enum(['FOOD', 'RETAIL', 'SERVICE']).default('FOOD'),
});

const translation = z.object({ name: z.string().max(200).default(''), short_description: z.string().max(300).nullish(), description: z.string().max(2000).nullish() });
const productSchema = z.object({
  sku: z.string().min(1).max(60),
  barcode: z.string().max(60).nullish(),
  category_id: uuid,
  image_url: z.string().max(500).nullish(),
  price: money,
  cost: money.default(0),
  vat_rate: z.coerce.number().min(0).max(100).nullish(),
  station_id: nullableUuid,
  printer_id: nullableUuid,
  schedule_id: nullableUuid,
  status: z.enum(['AVAILABLE', 'SOLD_OUT', 'UNAVAILABLE', 'HIDDEN']).default('AVAILABLE'),
  is_recommended: z.boolean().default(false),
  track_stock: z.boolean().default(false),
  sort: z.number().int().default(0),
  product_type: z.enum(['FOOD', 'DRINK', 'SOUVENIR', 'MERCHANDISE', 'PHOTO', 'LOCKER', 'SERVICE', 'OTHER']).default('FOOD'),
  translations: z.object({ th: translation, en: translation, zh: translation }).partial(),
  modifier_group_ids: z.array(uuid).default([]),
  recommendations: z.array(z.object({ recommended_product_id: uuid, message: i18n.default({}), special_price: money.nullish() })).default([]),
});

const groupSchema = z.object({
  name: i18n,
  selection: z.enum(['SINGLE', 'MULTIPLE']),
  kind: z.enum(['OPTION', 'ADD', 'REMOVE', 'EXTRA']).default('OPTION'),
  required: z.boolean().default(false),
  min_select: z.number().int().min(0).default(0),
  max_select: z.number().int().min(0).default(1),
  sort: z.number().int().default(0),
  modifiers: z
    .array(z.object({ id: uuid.optional(), name: i18n, price_delta: z.coerce.number().min(-100000).max(100000).default(0), is_default: z.boolean().default(false), is_active: z.boolean().default(true), sort: z.number().int().default(0) }))
    .default([]),
});

const promotionSchema = z.object({
  code: z.string().max(50).nullish().transform((v) => (v ? v.toUpperCase() : null)),
  name: i18n,
  description: i18n.default({}),
  badge: i18n.default({}),
  type: z.enum(['PERCENT', 'FIXED', 'BUY_X_GET_Y', 'COMBO', 'SET_MENU', 'COUPON', 'PROMO_CODE']),
  value_type: z.enum(['PERCENT', 'FIXED']).default('PERCENT'),
  value: z.coerce.number().min(0).default(0),
  buy_qty: z.coerce.number().int().min(1).nullish(),
  get_qty: z.coerce.number().int().min(1).nullish(),
  combo_price: money.nullish(),
  min_order: money.nullish(),
  max_discount: money.nullish(),
  scope: z.enum(['ORDER', 'PRODUCT', 'CATEGORY']).default('ORDER'),
  product_ids: z.array(uuid).default([]),
  category_ids: z.array(uuid).default([]),
  branch_ids: z.array(uuid).default([]),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  start_time: hhmm.nullish(),
  end_time: hhmm.nullish(),
  days: z.array(z.number().int().min(0).max(6)).default([]),
  usage_limit: z.coerce.number().int().min(1).nullish(),
  requires_code: z.boolean().default(false),
  priority: z.coerce.number().int().default(0),
  is_active: z.boolean().default(true),
  // Park rule engine fields
  applies_to: z.enum(['FOOD', 'PARK', 'ALL']).default('FOOD'),
  channels: z.array(z.enum(['ONLINE', 'PORTAL', 'COUNTER', 'KIOSK', 'POS', 'RIDE', 'LOCKER'])).default([]),
  item_types: z.array(z.enum(['PACKAGE', 'MEMBERSHIP', 'MEMBERSHIP_RENEWAL', 'MEMBERSHIP_UPGRADE', 'TOPUP', 'PRODUCT', 'LOCKER', 'RIDE_ADDON', 'SERVICE'])).default([]),
  package_ids: z.array(uuid).default([]),
  ticket_type_ids: z.array(uuid).default([]),
  tier_ids: z.array(uuid).default([]),
  min_qty: z.coerce.number().int().min(1).nullish(),
  max_units: z.coerce.number().int().min(1).nullish(),
  advance_days: z.coerce.number().int().min(0).max(365).nullish(),
  birthday_only: z.boolean().default(false),
  members_only: z.boolean().default(false),
  stackable: z.boolean().default(true),
  usage_per_member: z.coerce.number().int().min(1).nullish(),
});

const scheduleSchema = z.object({ name: z.string().min(1).max(60), start_time: hhmm, end_time: hhmm, days: z.array(z.number().int().min(0).max(6)).default([0, 1, 2, 3, 4, 5, 6]), is_active: z.boolean().default(true) });

const idParam = (req: FastifyRequest) => parse(z.object({ id: uuid }), req.params).id;

export default async function menuRoutes(app: FastifyInstance) {
  // ---------------- categories
  app.get('/categories', { preHandler: requireStaff() }, async () =>
    query(`SELECT c.*, (SELECT COUNT(*)::int FROM products p WHERE p.category_id=c.id AND p.deleted_at IS NULL) AS product_count FROM categories c ORDER BY sort, created_at`),
  );
  app.post('/categories', { preHandler: requireStaff('categories.manage') }, async (req) => {
    const b = parse(categorySchema, req.body);
    const row = await one(
      `INSERT INTO categories (kind, name, image_url, icon, sort, station_id, printer_id, schedule_id, is_active, channel) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [b.kind, b.name, b.image_url ?? null, b.icon ?? null, b.sort, b.station_id, b.printer_id, b.schedule_id, b.is_active, b.channel],
    );
    await audit(req, { action: 'CATEGORY_CREATE', entity: 'category', entityId: (row as any).id, newValue: row });
    await menuChanged();
    return row;
  });
  app.put('/categories/:id', { preHandler: requireStaff('categories.manage') }, async (req) => {
    const id = idParam(req);
    const b = parse(categorySchema, req.body);
    const old = await one(`SELECT * FROM categories WHERE id=$1`, [id]);
    if (!old) throw notFound('Category');
    const row = await one(
      `UPDATE categories SET kind=$2, name=$3, image_url=$4, icon=$5, sort=$6, station_id=$7, printer_id=$8, schedule_id=$9, is_active=$10, channel=$11 WHERE id=$1 RETURNING *`,
      [id, b.kind, b.name, b.image_url ?? null, b.icon ?? null, b.sort, b.station_id, b.printer_id, b.schedule_id, b.is_active, b.channel],
    );
    await audit(req, { action: 'CATEGORY_UPDATE', entity: 'category', entityId: id, oldValue: old, newValue: row });
    await menuChanged();
    return row;
  });
  app.post('/categories/reorder', { preHandler: requireStaff('categories.manage') }, async (req) => {
    const b = parse(z.object({ ids: z.array(uuid).min(1) }), req.body);
    await tx(async (c) => {
      for (let i = 0; i < b.ids.length; i++) await c.query(`UPDATE categories SET sort=$2 WHERE id=$1`, [b.ids[i], i * 10]);
    });
    await audit(req, { action: 'CATEGORY_REORDER', entity: 'category', newValue: b.ids });
    await menuChanged();
    return { ok: true };
  });
  app.delete('/categories/:id', { preHandler: requireStaff('categories.manage') }, async (req) => {
    const id = idParam(req);
    const used = await one(`SELECT 1 FROM products WHERE category_id=$1 AND deleted_at IS NULL`, [id]);
    if (used) throw conflict('CATEGORY_NOT_EMPTY', 'Move or delete the products in this category first');
    // Soft-deleted products keep their FK for historical orders; move them to keep referential integrity.
    const old = await one(`SELECT * FROM categories WHERE id=$1`, [id]);
    const hasHistory = await one(`SELECT 1 FROM products WHERE category_id=$1`, [id]);
    if (hasHistory) await query(`UPDATE categories SET is_active=false WHERE id=$1`, [id]);
    else await query(`DELETE FROM categories WHERE id=$1`, [id]);
    await audit(req, { action: 'CATEGORY_DELETE', entity: 'category', entityId: id, oldValue: old });
    await menuChanged();
    return { ok: true, archived: !!hasHistory };
  });

  // ---------------- products
  app.get('/products', { preHandler: requireStaff() }, async (req) => {
    const q = parse(z.object({ categoryId: uuid.optional(), q: z.string().max(60).optional(), branchId: uuid.optional() }), req.query);
    const rows = await query<any>(
      `SELECT p.*, COALESCE(json_object_agg(t.lang, json_build_object('name', t.name, 'short_description', t.short_description, 'description', t.description))
                FILTER (WHERE t.lang IS NOT NULL), '{}') AS translations,
              (SELECT array_agg(group_id ORDER BY sort) FROM product_modifier_groups WHERE product_id=p.id) AS modifier_group_ids,
              (SELECT COALESCE(json_agg(json_build_object('recommended_product_id', r.recommended_product_id, 'message', r.message, 'special_price', r.special_price) ORDER BY r.sort), '[]')
                 FROM product_recommendations r WHERE r.product_id=p.id) AS recommendations,
              s.current AS stock_current, s.reserved AS stock_reserved
         FROM products p LEFT JOIN product_translations t ON t.product_id=p.id
         LEFT JOIN stocks s ON s.product_id=p.id AND s.branch_id = COALESCE($3::uuid, (SELECT id FROM branches ORDER BY created_at LIMIT 1))
        WHERE p.deleted_at IS NULL AND ($1::uuid IS NULL OR p.category_id=$1)
          AND ($2::text IS NULL OR p.sku ILIKE '%'||$2||'%' OR EXISTS (SELECT 1 FROM product_translations x WHERE x.product_id=p.id AND x.name ILIKE '%'||$2||'%'))
        GROUP BY p.id, s.current, s.reserved ORDER BY p.sort, p.created_at`,
      [q.categoryId ?? null, q.q ?? null, (req.headers['x-branch-id'] as string) || q.branchId || req.staff!.branchId || null],
    );
    return rows.map((r) => ({ ...r, modifier_group_ids: r.modifier_group_ids ?? [] }));
  });

  async function saveProduct(id: string | null, b: z.infer<typeof productSchema>) {
    return tx(async (c) => {
      const params = [b.sku, b.barcode || null, b.category_id, b.image_url ?? null, b.price, b.cost, b.vat_rate ?? null, b.station_id, b.printer_id, b.schedule_id, b.status, b.is_recommended, b.track_stock, b.sort, b.product_type];
      const row = id
        ? await one<any>(
            `UPDATE products SET sku=$2, barcode=$3, category_id=$4, image_url=$5, price=$6, cost=$7, vat_rate=$8, station_id=$9, printer_id=$10, schedule_id=$11,
               status=$12, is_recommended=$13, track_stock=$14, sort=$15, product_type=$16 WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
            [id, ...params],
            c,
          )
        : await one<any>(
            `INSERT INTO products (sku, barcode, category_id, image_url, price, cost, vat_rate, station_id, printer_id, schedule_id, status, is_recommended, track_stock, sort, product_type)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
            params,
            c,
          );
      if (!row) throw notFound('Product');
      for (const [lang, t] of Object.entries(b.translations)) {
        if (!t) continue;
        await c.query(
          `INSERT INTO product_translations (product_id, lang, name, short_description, description) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (product_id, lang) DO UPDATE SET name=EXCLUDED.name, short_description=EXCLUDED.short_description, description=EXCLUDED.description`,
          [row.id, lang, t.name, t.short_description ?? null, t.description ?? null],
        );
      }
      await c.query(`DELETE FROM product_modifier_groups WHERE product_id=$1`, [row.id]);
      for (let i = 0; i < b.modifier_group_ids.length; i++) {
        await c.query(`INSERT INTO product_modifier_groups (product_id, group_id, sort) VALUES ($1,$2,$3)`, [row.id, b.modifier_group_ids[i], i]);
      }
      await c.query(`DELETE FROM product_recommendations WHERE product_id=$1`, [row.id]);
      for (let i = 0; i < b.recommendations.length; i++) {
        const r = b.recommendations[i];
        if (r.recommended_product_id === row.id) continue;
        await c.query(
          `INSERT INTO product_recommendations (product_id, recommended_product_id, message, special_price, sort) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [row.id, r.recommended_product_id, r.message, r.special_price ?? null, i],
        );
      }
      if (b.track_stock) {
        await c.query(`INSERT INTO stocks (product_id, branch_id) SELECT $1, id FROM branches ON CONFLICT DO NOTHING`, [row.id]);
      }
      return row;
    });
  }

  app.post('/products', { preHandler: requireStaff('products.manage') }, async (req) => {
    const b = parse(productSchema, req.body);
    const row = await saveProduct(null, b);
    await audit(req, { action: 'PRODUCT_CREATE', entity: 'product', entityId: row.id, newValue: b });
    await menuChanged();
    return row;
  });
  app.put('/products/:id', { preHandler: requireStaff('products.manage') }, async (req) => {
    const id = idParam(req);
    const b = parse(productSchema, req.body);
    const old = await one<any>(`SELECT * FROM products WHERE id=$1`, [id]);
    if (!old) throw notFound('Product');
    const row = await saveProduct(id, b);
    await audit(req, { action: 'PRODUCT_UPDATE', entity: 'product', entityId: id, oldValue: old, newValue: b });
    if (Number(old.price) !== Number(b.price)) {
      await audit(req, { action: 'PRICE_CHANGE', entity: 'product', entityId: id, oldValue: { price: old.price }, newValue: { price: b.price } });
    }
    await menuChanged();
    return row;
  });
  /** Quick status toggle (Available / Sold out / Unavailable / Hidden). */
  app.patch('/products/:id/status', { preHandler: requireStaff('stock.manage') }, async (req) => {
    const id = idParam(req);
    const b = parse(z.object({ status: z.enum(['AVAILABLE', 'SOLD_OUT', 'UNAVAILABLE', 'HIDDEN']) }), req.body);
    const old = await one<any>(`SELECT status FROM products WHERE id=$1`, [id]);
    if (!old) throw notFound('Product');
    await query(`UPDATE products SET status=$2 WHERE id=$1`, [id, b.status]);
    await audit(req, { action: 'PRODUCT_STATUS', entity: 'product', entityId: id, oldValue: old, newValue: b });
    await menuChanged();
    return { ok: true };
  });
  app.delete('/products/:id', { preHandler: requireStaff('products.manage') }, async (req) => {
    const id = idParam(req);
    const old = await one(`UPDATE products SET deleted_at=now(), status='HIDDEN', sku = sku || '#deleted#' || extract(epoch from now())::bigint WHERE id=$1 AND deleted_at IS NULL RETURNING *`, [id]);
    if (!old) throw notFound('Product');
    await audit(req, { action: 'PRODUCT_DELETE', entity: 'product', entityId: id, oldValue: old });
    await menuChanged();
    return { ok: true };
  });

  // ---------------- modifier groups
  app.get('/modifier-groups', { preHandler: requireStaff() }, async () =>
    query(
      `SELECT g.*, COALESCE((SELECT json_agg(m ORDER BY m.sort, m.created_at) FROM modifiers m WHERE m.group_id=g.id), '[]') AS modifiers,
              (SELECT COUNT(*)::int FROM product_modifier_groups x WHERE x.group_id=g.id) AS product_count
         FROM modifier_groups g ORDER BY g.sort, g.created_at`,
    ),
  );
  async function saveGroup(id: string | null, b: z.infer<typeof groupSchema>) {
    return tx(async (c) => {
      const params = [b.name, b.selection, b.kind, b.required, b.min_select, b.selection === 'SINGLE' ? 1 : b.max_select, b.sort];
      const g = id
        ? await one<any>(`UPDATE modifier_groups SET name=$2, selection=$3, kind=$4, required=$5, min_select=$6, max_select=$7, sort=$8 WHERE id=$1 RETURNING *`, [id, ...params], c)
        : await one<any>(`INSERT INTO modifier_groups (name, selection, kind, required, min_select, max_select, sort) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, params, c);
      if (!g) throw notFound('Modifier group');
      const keep = b.modifiers.filter((m) => m.id).map((m) => m.id);
      // Historical order lines keep a name snapshot; removed modifiers are deleted (FK set null).
      await c.query(`DELETE FROM modifiers WHERE group_id=$1 AND NOT (id = ANY($2::uuid[]))`, [g.id, keep]);
      for (const m of b.modifiers) {
        if (m.id) {
          await c.query(`UPDATE modifiers SET name=$3, price_delta=$4, is_default=$5, is_active=$6, sort=$7 WHERE id=$1 AND group_id=$2`, [m.id, g.id, m.name, m.price_delta, m.is_default, m.is_active, m.sort]);
        } else {
          await c.query(`INSERT INTO modifiers (group_id, name, price_delta, is_default, is_active, sort) VALUES ($1,$2,$3,$4,$5,$6)`, [g.id, m.name, m.price_delta, m.is_default, m.is_active, m.sort]);
        }
      }
      return g;
    });
  }
  app.post('/modifier-groups', { preHandler: requireStaff('modifiers.manage') }, async (req) => {
    const b = parse(groupSchema, req.body);
    const g = await saveGroup(null, b);
    await audit(req, { action: 'MODIFIER_GROUP_CREATE', entity: 'modifier_group', entityId: g.id, newValue: b });
    await menuChanged();
    return g;
  });
  app.put('/modifier-groups/:id', { preHandler: requireStaff('modifiers.manage') }, async (req) => {
    const id = idParam(req);
    const b = parse(groupSchema, req.body);
    const old = await one(`SELECT * FROM modifier_groups WHERE id=$1`, [id]);
    const g = await saveGroup(id, b);
    await audit(req, { action: 'MODIFIER_GROUP_UPDATE', entity: 'modifier_group', entityId: id, oldValue: old, newValue: b });
    await menuChanged();
    return g;
  });
  app.delete('/modifier-groups/:id', { preHandler: requireStaff('modifiers.manage') }, async (req) => {
    const id = idParam(req);
    const old = await one(`DELETE FROM modifier_groups WHERE id=$1 RETURNING *`, [id]);
    await audit(req, { action: 'MODIFIER_GROUP_DELETE', entity: 'modifier_group', entityId: id, oldValue: old });
    await menuChanged();
    return { ok: true };
  });

  // ---------------- schedules
  app.get('/schedules', { preHandler: requireStaff() }, async () =>
    query(`SELECT id, name, to_char(start_time,'HH24:MI') AS start_time, to_char(end_time,'HH24:MI') AS end_time, days, is_active FROM menu_schedules ORDER BY start_time`),
  );
  app.post('/schedules', { preHandler: requireStaff('products.manage') }, async (req) => {
    const b = parse(scheduleSchema, req.body);
    const row = await one(`INSERT INTO menu_schedules (name, start_time, end_time, days, is_active) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [b.name, b.start_time, b.end_time, b.days, b.is_active]);
    await audit(req, { action: 'SCHEDULE_CREATE', entity: 'menu_schedule', entityId: (row as any).id, newValue: b });
    await menuChanged();
    return row;
  });
  app.put('/schedules/:id', { preHandler: requireStaff('products.manage') }, async (req) => {
    const id = idParam(req);
    const b = parse(scheduleSchema, req.body);
    await query(`UPDATE menu_schedules SET name=$2, start_time=$3, end_time=$4, days=$5, is_active=$6 WHERE id=$1`, [id, b.name, b.start_time, b.end_time, b.days, b.is_active]);
    await audit(req, { action: 'SCHEDULE_UPDATE', entity: 'menu_schedule', entityId: id, newValue: b });
    await menuChanged();
    return { ok: true };
  });
  app.delete('/schedules/:id', { preHandler: requireStaff('products.manage') }, async (req) => {
    const id = idParam(req);
    await query(`DELETE FROM menu_schedules WHERE id=$1`, [id]);
    await audit(req, { action: 'SCHEDULE_DELETE', entity: 'menu_schedule', entityId: id });
    await menuChanged();
    return { ok: true };
  });

  // ---------------- promotions
  app.get('/promotions', { preHandler: requireStaff() }, async () => loadPromotions(undefined, false, 'ALL'));
  const promoParams = (b: z.infer<typeof promotionSchema>) => [
    b.code, b.name, b.description, b.badge, b.type, b.value_type, b.value, b.buy_qty ?? null, b.get_qty ?? null, b.combo_price ?? null,
    b.min_order ?? null, b.max_discount ?? null, b.scope, b.product_ids, b.category_ids, b.branch_ids, b.start_date ?? null, b.end_date ?? null,
    b.start_time ?? null, b.end_time ?? null, b.days, b.usage_limit ?? null, b.requires_code || b.type === 'COUPON' || b.type === 'PROMO_CODE', b.priority, b.is_active,
    b.applies_to, b.channels, b.item_types, b.package_ids, b.ticket_type_ids, b.tier_ids, b.min_qty ?? null, b.max_units ?? null, b.advance_days ?? null,
    b.birthday_only, b.members_only, b.stackable, b.usage_per_member ?? null,
  ];
  const PROMO_COLS = 'code, name, description, badge, type, value_type, value, buy_qty, get_qty, combo_price, min_order, max_discount, scope, product_ids, category_ids, branch_ids, start_date, end_date, start_time, end_time, days, usage_limit, requires_code, priority, is_active, applies_to, channels, item_types, package_ids, ticket_type_ids, tier_ids, min_qty, max_units, advance_days, birthday_only, members_only, stackable, usage_per_member';
  app.post('/promotions', { preHandler: requireStaff('promotions.manage') }, async (req) => {
    const b = parse(promotionSchema, req.body);
    const row = await one<any>(`INSERT INTO promotions (${PROMO_COLS}) VALUES (${PROMO_COLS.split(',').map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, promoParams(b));
    await audit(req, { action: 'PROMOTION_CREATE', entity: 'promotion', entityId: row.id, newValue: b });
    await menuChanged();
    return row;
  });
  app.put('/promotions/:id', { preHandler: requireStaff('promotions.manage') }, async (req) => {
    const id = idParam(req);
    const b = parse(promotionSchema, req.body);
    const old = await one(`SELECT * FROM promotions WHERE id=$1`, [id]);
    if (!old) throw notFound('Promotion');
    const sets = PROMO_COLS.split(',').map((c, i) => `${c.trim()}=$${i + 2}`).join(', ');
    await query(`UPDATE promotions SET ${sets} WHERE id=$1`, [id, ...promoParams(b)]);
    await audit(req, { action: 'PROMOTION_UPDATE', entity: 'promotion', entityId: id, oldValue: old, newValue: b });
    await menuChanged();
    return { ok: true };
  });
  app.delete('/promotions/:id', { preHandler: requireStaff('promotions.manage') }, async (req) => {
    const id = idParam(req);
    const old = await one(`DELETE FROM promotions WHERE id=$1 RETURNING *`, [id]);
    await audit(req, { action: 'PROMOTION_DELETE', entity: 'promotion', entityId: id, oldValue: old });
    await menuChanged();
    return { ok: true };
  });
}

export { menuChanged };
