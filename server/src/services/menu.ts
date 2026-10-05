import type { MenuCategory, MenuModifierGroup, MenuProduct, MenuSchedule, Promotion } from '@kiosk/shared';
import { query, type Db } from '../db/pool';

export interface MenuData {
  categories: MenuCategory[];
  products: MenuProduct[];
  schedules: MenuSchedule[];
  promotions: Promotion[];
  generatedAt: string;
}

const PROMO_COLS = `id, code, name, description, badge, type, value_type, value, buy_qty, get_qty, combo_price, min_order,
  max_discount, scope, product_ids, category_ids, branch_ids, start_date::text, end_date::text,
  to_char(start_time,'HH24:MI') AS start_time, to_char(end_time,'HH24:MI') AS end_time, days, usage_limit, usage_count,
  requires_code, priority, is_active`;

export async function loadPromotions(db?: Db, onlyActive = true): Promise<Promotion[]> {
  return query<Promotion>(`SELECT ${PROMO_COLS} FROM promotions ${onlyActive ? 'WHERE is_active' : ''} ORDER BY priority DESC, created_at`, [], db);
}

export async function loadModifierGroups(productIds: string[], db?: Db): Promise<Map<string, MenuModifierGroup[]>> {
  const out = new Map<string, MenuModifierGroup[]>();
  if (!productIds.length) return out;
  const rows = await query<any>(
    `SELECT pmg.product_id, pmg.sort AS link_sort, g.*,
            COALESCE(json_agg(json_build_object('id', m.id, 'group_id', m.group_id, 'name', m.name, 'price_delta', m.price_delta,
              'is_default', m.is_default, 'is_active', m.is_active, 'sort', m.sort) ORDER BY m.sort, m.created_at)
              FILTER (WHERE m.id IS NOT NULL), '[]') AS modifiers
       FROM product_modifier_groups pmg
       JOIN modifier_groups g ON g.id = pmg.group_id
       LEFT JOIN modifiers m ON m.group_id = g.id
      WHERE pmg.product_id = ANY($1)
      GROUP BY pmg.product_id, pmg.sort, g.id
      ORDER BY pmg.sort, g.sort`,
    [productIds],
    db,
  );
  for (const r of rows) {
    const list = out.get(r.product_id) ?? [];
    list.push({
      id: r.id,
      name: r.name,
      selection: r.selection,
      required: r.required,
      min_select: r.min_select,
      max_select: r.max_select,
      kind: r.kind,
      sort: r.sort,
      modifiers: r.modifiers.map((m: any) => ({ ...m, price_delta: Number(m.price_delta) })),
    });
    out.set(r.product_id, list);
  }
  return out;
}

export async function getMenu(branchId: string, db?: Db): Promise<MenuData> {
  const [categories, productsRaw, schedules, promotions, recs] = await Promise.all([
    query<MenuCategory>(
      `SELECT id, kind, name, image_url, icon, sort, schedule_id, is_active FROM categories WHERE is_active ORDER BY sort, created_at`,
      [],
      db,
    ),
    query<any>(
      `SELECT p.id, p.sku, p.category_id, p.image_url, p.price, p.status, p.is_recommended, p.schedule_id, p.track_stock,
              p.vat_rate, p.station_id, p.sort,
              CASE WHEN p.track_stock THEN COALESCE(s.current - s.reserved, 0) END AS available_stock,
              COALESCE(json_object_agg(t.lang, json_build_object('name', t.name, 'description', t.description,
                'short_description', t.short_description)) FILTER (WHERE t.lang IS NOT NULL), '{}') AS tr
         FROM products p
         LEFT JOIN stocks s ON s.product_id = p.id AND s.branch_id = $1
         LEFT JOIN product_translations t ON t.product_id = p.id
        WHERE p.deleted_at IS NULL AND p.status <> 'HIDDEN'
        GROUP BY p.id, s.current, s.reserved
        ORDER BY p.sort, p.created_at`,
      [branchId],
      db,
    ),
    query<MenuSchedule>(
      `SELECT id, name, to_char(start_time,'HH24:MI') AS start_time, to_char(end_time,'HH24:MI') AS end_time, days, is_active FROM menu_schedules`,
      [],
      db,
    ),
    loadPromotions(db),
    query<any>(`SELECT product_id, recommended_product_id, message, special_price FROM product_recommendations ORDER BY sort`, [], db),
  ]);
  const groups = await loadModifierGroups(productsRaw.map((p) => p.id), db);
  const products: MenuProduct[] = productsRaw.map((p) => {
    const pick = (k: string) => Object.fromEntries(Object.entries(p.tr).map(([lang, v]: any) => [lang, v[k] ?? ''])) as any;
    return {
      id: p.id,
      sku: p.sku,
      category_id: p.category_id,
      image_url: p.image_url,
      price: Number(p.price),
      status: p.status,
      is_recommended: p.is_recommended,
      schedule_id: p.schedule_id,
      track_stock: p.track_stock,
      available_stock: p.available_stock == null ? null : Number(p.available_stock),
      vat_rate: p.vat_rate == null ? null : Number(p.vat_rate),
      station_id: p.station_id,
      sort: p.sort,
      name: pick('name'),
      description: pick('description'),
      short_description: pick('short_description'),
      modifier_groups: groups.get(p.id) ?? [],
      recommendations: recs
        .filter((r) => r.product_id === p.id)
        .map((r) => ({ product_id: r.recommended_product_id, message: r.message, special_price: r.special_price == null ? null : Number(r.special_price) })),
    };
  });
  return {
    categories,
    products,
    schedules,
    promotions: promotions.filter((p) => !p.branch_ids?.length || p.branch_ids.includes(branchId)),
    generatedAt: new Date().toISOString(),
  };
}
