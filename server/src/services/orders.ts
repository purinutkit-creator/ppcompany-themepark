import crypto from 'node:crypto';
import {
  EVENTS,
  isScheduleOpen,
  localNow,
  priceCart,
  rooms,
  validateModifierSelection,
  type CartLineInput,
  type I18nText,
  type Lang,
  type MenuSchedule,
  type OrderType,
  type PrintOrder,
} from '@kiosk/shared';
import { one, pool, query, tx, type Db, type Tx } from '../db/pool';
import { badRequest, conflict, notFound } from '../lib/errors';
import { Outbox } from '../lib/realtime';
import { getSettings } from '../lib/settings';
import { loadModifierGroups, loadPromotions } from './menu';
import { releaseStock, reserveStock, returnStock } from './stock';

export type ActorType = 'KIOSK' | 'STAFF' | 'SYSTEM' | 'PROVIDER' | 'CUSTOMER';
export interface Actor {
  type: ActorType;
  id?: string | null;
  name?: string | null;
}

export async function addOrderEvent(db: Db, orderId: string, type: string, data: Record<string, unknown>, actor: Actor) {
  await query(
    `INSERT INTO order_events (order_id, type, data, actor_type, actor_id, actor_name) VALUES ($1,$2,$3,$4,$5,$6)`,
    [orderId, type, JSON.stringify(data ?? {}), actor.type, actor.id ?? null, actor.name ?? null],
    db,
  );
}

/** Lightweight order shape broadcast to cashier / admin / kiosk screens. */
export async function orderSummary(orderId: string, db?: Db) {
  return one<any>(
    `SELECT o.id, o.order_number, o.status, o.payment_status, o.payment_method, o.order_type, o.total, o.subtotal, o.discount,
            o.created_at, o.paid_at, o.branch_id, o.kiosk_id, k.code AS kiosk_code, o.offline_ref, o.source,
            (SELECT COALESCE(SUM(qty),0)::int FROM order_items WHERE order_id=o.id) AS item_count
       FROM orders o LEFT JOIN kiosks k ON k.id=o.kiosk_id WHERE o.id=$1`,
    [orderId],
    db,
  );
}

export async function broadcastOrder(out: Outbox, orderId: string, db: Db, event: string = EVENTS.ORDER_UPDATED, extra: Record<string, unknown> = {}) {
  const s = await orderSummary(orderId, db);
  if (!s) return;
  const acc = await one<any>(`SELECT account_id FROM orders WHERE id=$1`, [orderId], db);
  if (acc?.account_id) out.add(rooms.account(acc.account_id), event, { ...s, ...extra });
  const targets = [rooms.branchCashier(s.branch_id), rooms.branchAdmin(s.branch_id)];
  if (s.kiosk_id) targets.push(rooms.kiosk(s.kiosk_id));
  out.add(targets, event, { ...s, ...extra });
}

export interface CreateOrderItemInput {
  productId: string;
  qty: number;
  modifierIds: string[];
  specialRequest?: string | null;
  upsellSourceProductId?: string | null;
}
export interface CreateOrderInput {
  clientOrderId: string;
  orderType: OrderType;
  language: Lang;
  items: CreateOrderItemInput[];
  promoCode?: string | null;
  note?: string | null;
  offlineRef?: string | null;
  /** Park member (scanned card / logged-in app user): tier FOOD discount + points + wallet. */
  member?: { memberId: string | null; accountId: string | null; credentialId: string | null } | null;
  storeId?: string | null;
}

interface BuiltLine {
  product: any;
  input: CreateOrderItemInput;
  basePrice: number;
  mods: any[];
  modTotal: number;
  stationId: string;
  printerId: string | null;
}

/** Resolve products/modifiers, validate availability, schedules & modifier rules, and price the cart. */
export async function buildCart(db: Db, branchId: string, input: Pick<CreateOrderInput, 'items' | 'orderType' | 'promoCode' | 'member'>) {
  if (!input.items.length) throw badRequest('EMPTY_CART', 'Cart is empty');
  const settings = await getSettings();
  const ids = [...new Set(input.items.map((i) => i.productId))];
  const products = await query<any>(
    `SELECT p.*, c.station_id AS cat_station_id, c.printer_id AS cat_printer_id, c.schedule_id AS cat_schedule_id, c.is_active AS cat_active,
            COALESCE(json_object_agg(t.lang, t.name) FILTER (WHERE t.lang IS NOT NULL), '{}') AS names,
            s.current - s.reserved AS available
       FROM products p JOIN categories c ON c.id = p.category_id
       LEFT JOIN product_translations t ON t.product_id = p.id
       LEFT JOIN stocks s ON s.product_id = p.id AND s.branch_id = $2
      WHERE p.id = ANY($1) AND p.deleted_at IS NULL
      GROUP BY p.id, c.id, s.current, s.reserved`,
    [ids, branchId],
    db,
  );
  const byId = new Map(products.map((p) => [p.id, p]));
  const branch = await one<any>(`SELECT timezone FROM branches WHERE id=$1`, [branchId], db);
  if (!branch) throw notFound('Branch');
  const schedules = await query<MenuSchedule>(
    `SELECT id, name, to_char(start_time,'HH24:MI') AS start_time, to_char(end_time,'HH24:MI') AS end_time, days, is_active FROM menu_schedules`,
    [],
    db,
  );
  const schedMap = new Map(schedules.map((s) => [s.id, s]));
  const now = localNow(new Date(), branch.timezone);
  const groups = await loadModifierGroups(ids, db);
  const defStation = await one<any>(`SELECT id FROM kitchen_stations WHERE branch_id=$1 AND is_default`, [branchId], db);
  const anyStation = defStation ?? (await one<any>(`SELECT id FROM kitchen_stations WHERE branch_id=$1 ORDER BY sort LIMIT 1`, [branchId], db));
  if (!anyStation) throw conflict('NO_KITCHEN_STATION', 'No kitchen station configured for this branch');
  const recs = await query<any>(`SELECT * FROM product_recommendations WHERE recommended_product_id = ANY($1)`, [ids], db);

  const lines: BuiltLine[] = [];
  for (const it of input.items) {
    const p = byId.get(it.productId);
    if (!p || !p.cat_active) throw conflict('PRODUCT_UNAVAILABLE', 'Product is not available', { productId: it.productId });
    if (p.status !== 'AVAILABLE') throw conflict(p.status === 'SOLD_OUT' ? 'OUT_OF_STOCK' : 'PRODUCT_UNAVAILABLE', 'Product is not available', { productId: p.id });
    if (!isScheduleOpen(schedMap.get(p.schedule_id), now) || !isScheduleOpen(schedMap.get(p.cat_schedule_id), now)) {
      throw conflict('PRODUCT_NOT_IN_SCHEDULE', 'Product is not sold at this time', { productId: p.id });
    }
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > 99) throw badRequest('INVALID_QTY');
    const g = groups.get(p.id) ?? [];
    const errs = validateModifierSelection(g, it.modifierIds);
    if (errs.length) throw badRequest('MODIFIER_INVALID', 'Invalid modifier selection', { productId: p.id, errors: errs });
    const mods = g.flatMap((grp) => grp.modifiers.filter((m) => it.modifierIds.includes(m.id)).map((m) => ({ ...m, group: grp })));
    let basePrice = Number(p.price);
    if (it.upsellSourceProductId && input.items.some((x) => x.productId === it.upsellSourceProductId)) {
      const rec = recs.find((r) => r.product_id === it.upsellSourceProductId && r.recommended_product_id === p.id);
      if (rec?.special_price != null) basePrice = Number(rec.special_price);
    }
    lines.push({
      product: p,
      input: it,
      basePrice,
      mods,
      modTotal: mods.reduce((s, m) => s + Number(m.price_delta), 0),
      stationId: p.station_id ?? p.cat_station_id ?? anyStation.id,
      printerId: p.printer_id ?? p.cat_printer_id ?? null,
    });
  }
  // Aggregate stock check for tracked products (reservation re-checks with row locks).
  const need = new Map<string, number>();
  for (const l of lines) need.set(l.product.id, (need.get(l.product.id) ?? 0) + l.input.qty);
  for (const [pid, q] of need) {
    const p = byId.get(pid);
    if (p.track_stock && (p.available ?? 0) < q) throw conflict('OUT_OF_STOCK', 'Product is sold out', { productId: pid, available: p.available ?? 0 });
  }

  const cartLines: CartLineInput[] = lines.map((l, i) => ({
    key: String(i),
    productId: l.product.id,
    categoryId: l.product.category_id,
    qty: l.input.qty,
    basePrice: l.basePrice,
    modifierTotal: l.modTotal,
    vatRate: l.product.vat_rate == null ? null : Number(l.product.vat_rate),
  }));
  const promotions = await loadPromotions(db);
  if (input.member?.memberId) {
    // Member tier FOOD discount as a synthetic order-level promotion (priority / stacking from settings).
    const b = await one<any>(
      `SELECT MAX(b.value) AS pct, (SELECT name FROM member_tiers t JOIN members m ON m.tier_id=t.id WHERE m.id=$1) AS tier_name
         FROM memberships ms JOIN membership_benefits b ON b.product_id=ms.product_id WHERE ms.member_id=$1 AND ms.status='ACTIVE' AND b.type='FOOD_DISCOUNT'`,
      [input.member.memberId],
      db,
    );
    if (b?.pct > 0) {
      const tn = b.tier_name ?? {};
      promotions.push({
        id: 'member:FOOD', code: null, name: { th: `ส่วนลดสมาชิก ${tn.th ?? ''}`.trim(), en: `${tn.en ?? ''} member discount`.trim(), zh: `${tn.zh ?? ''}会员折扣` },
        description: {}, badge: {}, type: 'PERCENT', value_type: 'PERCENT', value: Number(b.pct), buy_qty: null, get_qty: null, combo_price: null, min_order: null,
        max_discount: null, scope: 'ORDER', product_ids: [], category_ids: [], branch_ids: [], start_date: null, end_date: null, start_time: null, end_time: null,
        days: [], usage_limit: null, usage_count: 0, requires_code: false, priority: settings.member.discountPriority, is_active: true,
      } as any);
    }
  }
  const pricing = priceCart(cartLines, {
    promotions,
    tax: settings.tax as any,
    orderType: input.orderType,
    promoCode: input.promoCode,
    branchId,
    timeZone: branch.timezone,
  });
  return { lines, pricing, settings, timezone: branch.timezone };
}

/** Random 5-digit number 00000–99999 that is not used by any active order of the branch. */
export function randomOrderNumber(): string {
  return String(crypto.randomInt(0, 100000)).padStart(5, '0');
}

async function insertOrderWithNumber(c: Tx, branchId: string, build: (num: string) => Promise<string>): Promise<{ id: string; number: string }> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const num = randomOrderNumber();
    // Pre-check against active numbers; the partial unique index is the final race-safe guard.
    const taken = await one(`SELECT 1 FROM queue_numbers WHERE branch_id=$1 AND number=$2 AND active`, [branchId, num], c);
    if (taken) continue;
    await c.query('SAVEPOINT order_number');
    try {
      const id = await build(num);
      await c.query(`INSERT INTO queue_numbers (branch_id, order_id, number) VALUES ($1,$2,$3)`, [branchId, id, num]);
      await c.query('RELEASE SAVEPOINT order_number');
      return { id, number: num };
    } catch (e: any) {
      await c.query('ROLLBACK TO SAVEPOINT order_number');
      if (e?.code !== '23505' || e?.constraint !== 'queue_numbers_active_unique') throw e;
    }
  }
  throw conflict('ORDER_NUMBER_EXHAUSTED', 'Could not allocate an order number');
}

export async function createOrder(
  input: CreateOrderInput,
  ctx: { branchId: string; kioskId: string | null; source: 'KIOSK' | 'CASHIER' | 'MOBILE' | 'POS'; actor: Actor; staffId?: string | null },
) {
  // Idempotency: kiosks generate clientOrderId once per checkout (also used by offline sync).
  const existing = await one<any>(`SELECT id FROM orders WHERE client_order_id=$1`, [input.clientOrderId]);
  if (existing) return { orderId: existing.id, duplicate: true };

  const out = new Outbox();
  try {
    const res = await tx(async (c) => {
      const { lines, pricing, settings } = await buildCart(c, ctx.branchId, input);
      if (pricing.invalidCode) throw badRequest('INVALID_PROMO_CODE', 'Promo code is invalid or expired');
      const orderTypes = settings.order.orderTypes as Record<string, boolean>;
      if (!orderTypes[input.orderType]) throw badRequest('ORDER_TYPE_DISABLED');
      const expires = new Date(Date.now() + settings.order.expiryMinutes * 60_000);
      const { id, number } = await insertOrderWithNumber(c, ctx.branchId, async (num) => {
        const o = await one<any>(
          `INSERT INTO orders (branch_id, kiosk_id, client_order_id, order_number, order_type, language, subtotal, discount,
              service_charge, vat, total, vat_mode, vat_rate, service_charge_rate, promo_code, applied_promotions, note, source,
              offline_ref, created_by, expires_at, member_id, account_id, credential_id, store_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING id`,
          [
            ctx.branchId, ctx.kioskId, input.clientOrderId, num, input.orderType, input.language, pricing.subtotal, pricing.discount,
            pricing.serviceCharge, pricing.vat, pricing.total, settings.tax.vatMode, settings.tax.vatRate,
            settings.tax.serviceChargeOrderTypes.includes(input.orderType) ? settings.tax.serviceChargeRate : 0,
            input.promoCode?.toUpperCase() || null, JSON.stringify(pricing.appliedPromotions), input.note ?? null, ctx.source,
            input.offlineRef ?? null, ctx.staffId ?? null, expires, input.member?.memberId ?? null, input.member?.accountId ?? null,
            input.member?.credentialId ?? null, input.storeId ?? null,
          ],
          c,
        );
        return o.id as string;
      });
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const pl = pricing.lines[i];
        const item = await one<any>(
          `INSERT INTO order_items (order_id, product_id, category_id, sku, name, base_price, unit_price, qty, line_total, discount, cost,
              station_id, printer_id, special_request, sort)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
          [
            id, l.product.id, l.product.category_id, l.product.sku, JSON.stringify(l.product.names), l.basePrice, pl.unitPrice, l.input.qty,
            pl.lineTotal, pl.discount, l.product.cost, l.stationId, l.printerId, l.input.specialRequest?.slice(0, 200) || null, i,
          ],
          c,
        );
        for (const m of l.mods) {
          await query(
            `INSERT INTO order_item_modifiers (order_item_id, modifier_id, group_id, name, group_name, kind, price_delta) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [item.id, m.id, m.group.id, JSON.stringify(m.name), JSON.stringify(m.group.name), m.group.kind, m.price_delta],
            c,
          );
        }
      }
      if (settings.order.reserveStockOnCreate) {
        await reserveStock(c, ctx.branchId, id, lines.map((l) => ({ productId: l.product.id, qty: l.input.qty })), out);
      }
      await addOrderEvent(c, id, 'ORDER_CREATED', { total: pricing.total, items: lines.length, offlineRef: input.offlineRef ?? undefined }, ctx.actor);
      await broadcastOrder(out, id, c, EVENTS.ORDER_CREATED);
      return { orderId: id, orderNumber: number, duplicate: false };
    });
    await out.flush();
    return res;
  } catch (e: any) {
    // Concurrent duplicate submit of the same clientOrderId: return the winner.
    if (e?.code === '23505' && String(e?.constraint).includes('client_order_id')) {
      const row = await one<any>(`SELECT id FROM orders WHERE client_order_id=$1`, [input.clientOrderId]);
      if (row) return { orderId: row.id, duplicate: true };
    }
    throw e;
  }
}

export async function getOrderDetail(orderId: string, db?: Db) {
  const order = await one<any>(
    `SELECT o.*, k.code AS kiosk_code, k.name AS kiosk_name, b.name AS branch_name, b.code AS branch_code, b.timezone AS branch_timezone,
            q.status AS queue_status, q.call_count, u.name AS created_by_name
       FROM orders o JOIN branches b ON b.id=o.branch_id LEFT JOIN kiosks k ON k.id=o.kiosk_id
       LEFT JOIN queue_numbers q ON q.order_id=o.id LEFT JOIN users u ON u.id=o.created_by
      WHERE o.id=$1`,
    [orderId],
    db,
  );
  if (!order) throw notFound('Order');
  // Sequential when running on a transaction client (a pg client cannot run queries in parallel).
  const all = async <T>(ps: (() => Promise<T>)[]) => {
    if (db && db !== pool) {
      const out: T[] = [];
      for (const p of ps) out.push(await p());
      return out;
    }
    return Promise.all(ps.map((p) => p()));
  };
  const [items, payments, verifications, events, kitchen, prints, refunds] = await all<any[]>([
    () => query<any>(
      `SELECT oi.*, p.image_url, ks.name AS station_name,
              COALESCE((SELECT json_agg(json_build_object('id', m.id, 'modifier_id', m.modifier_id, 'name', m.name, 'group_name', m.group_name,
                 'kind', m.kind, 'price_delta', m.price_delta)) FROM order_item_modifiers m WHERE m.order_item_id = oi.id), '[]') AS modifiers
         FROM order_items oi JOIN products p ON p.id = oi.product_id LEFT JOIN kitchen_stations ks ON ks.id = oi.station_id
        WHERE oi.order_id=$1 ORDER BY oi.sort`,
      [orderId],
      db,
    ),
    () => query<any>(
      `SELECT p.id, p.method, p.provider, p.status, p.amount, p.received_amount, p.change_amount, p.reference, p.provider_txn_id,
              p.card_brand, p.card_last4, p.approval_code, p.paid_at, p.created_at, p.expires_at, u.name AS confirmed_by_name
         FROM payments p LEFT JOIN users u ON u.id=p.confirmed_by WHERE p.order_id=$1 ORDER BY p.created_at`,
      [orderId],
      db,
    ),
    () => query<any>(
      `SELECT v.*, u.name AS decided_by_name FROM payment_verifications v LEFT JOIN users u ON u.id=v.decided_by
        WHERE v.order_id=$1 ORDER BY v.requested_at`,
      [orderId],
      db,
    ),
    () => query<any>(`SELECT * FROM order_events WHERE order_id=$1 ORDER BY id`, [orderId], db),
    () => query<any>(
      `SELECT ko.*, ks.name AS station_name, ks.code AS station_code FROM kitchen_orders ko JOIN kitchen_stations ks ON ks.id=ko.station_id WHERE ko.order_id=$1`,
      [orderId],
      db,
    ),
    () => query<any>(
      `SELECT j.id, j.document_type, j.status, j.attempts, j.last_error, j.copy_no, j.is_reprint, j.created_at, j.printed_at, pr.name AS printer_name
         FROM print_jobs j LEFT JOIN printers pr ON pr.id=j.printer_id WHERE j.order_id=$1 ORDER BY j.created_at`,
      [orderId],
      db,
    ),
    () => query<any>(`SELECT r.*, u.name AS created_by_name FROM refunds r LEFT JOIN users u ON u.id=r.created_by WHERE r.order_id=$1 ORDER BY r.created_at`, [orderId], db),
  ]);
  return { order, items, payments, verifications, events, kitchen, prints, refunds };
}

export async function buildPrintOrder(orderId: string, db: Db, onlyStationId?: string | null, printerItems?: string[]): Promise<PrintOrder> {
  const d = await getOrderDetail(orderId, db);
  const o = d.order;
  const paid = d.payments.find((p: any) => p.status === 'PAID');
  let items = d.items;
  if (onlyStationId) items = items.filter((i: any) => i.station_id === onlyStationId);
  if (printerItems) items = items.filter((i: any) => printerItems.includes(i.id));
  return {
    orderId: o.id,
    orderNumber: o.order_number,
    orderType: o.order_type,
    createdAt: new Date(o.created_at).toISOString(),
    paidAt: o.paid_at ? new Date(o.paid_at).toISOString() : null,
    kioskCode: o.kiosk_code ?? (o.source === 'CASHIER' ? 'POS' : null),
    branchName: (o.branch_name as I18nText)?.[o.language as Lang] || (o.branch_name as I18nText)?.en || o.branch_code,
    timeZone: o.branch_timezone,
    language: o.language,
    items: items.map((i: any) => ({
      name: i.name,
      qty: i.qty,
      unitPrice: Number(i.unit_price),
      total: Number(i.line_total),
      specialRequest: i.special_request,
      modifiers: i.modifiers.map((m: any) => ({ name: m.name, kind: m.kind, priceDelta: Number(m.price_delta), groupName: m.group_name })),
    })),
    subtotal: Number(o.subtotal),
    discount: Number(o.discount),
    serviceCharge: Number(o.service_charge),
    vat: Number(o.vat),
    total: Number(o.total),
    paymentMethod: o.payment_method,
    paymentStatus: o.payment_status,
    receivedAmount: paid?.received_amount ?? null,
    changeAmount: paid?.change_amount ?? null,
    note: o.note,
  };
}

/** Free the customer number and queue entry once an order is finished. */
export async function releaseQueue(c: Tx, orderId: string, status: 'COMPLETED' | 'CANCELLED') {
  await query(`UPDATE queue_numbers SET active=false, status=$2, released_at=now() WHERE order_id=$1 AND active`, [orderId, status], c);
}

export async function emitQueue(out: Outbox, branchId: string, extra?: { event?: string; data?: unknown }) {
  out.add([rooms.branchQueue(branchId), rooms.branchKitchen(branchId)], EVENTS.QUEUE_UPDATED, { branchId });
  if (extra?.event) out.add([rooms.branchQueue(branchId)], extra.event, extra.data);
}

/** Cancel an order. Unpaid: release stock/number. Paid: requires caller-side permission checks. */
export async function cancelOrder(orderId: string, reason: string, actor: Actor, opts: { allowPaid: boolean }) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const o = await one<any>(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId], c);
    if (!o) throw notFound('Order');
    if (['CANCELLED', 'REFUNDED', 'COMPLETED'].includes(o.status)) throw conflict('ORDER_FINALIZED', `Order is already ${o.status}`);
    const paid = o.payment_status === 'PAID';
    if (paid && !opts.allowPaid) throw conflict('ORDER_PAID', 'Order is paid; use cancel-paid with manager approval');
    await query(
      `UPDATE orders SET status='CANCELLED', cancelled_at=now(), cancel_reason=$2, payment_status = CASE WHEN payment_status='PAID' THEN 'VOID' ELSE payment_status END, version=version+1 WHERE id=$1`,
      [orderId, reason],
      c,
    );
    await query(
      `UPDATE payments SET status='CANCELLED' WHERE order_id=$1 AND status IN ('PENDING','WAITING_VERIFICATION','WAITING_CASH','WAITING_CARD','PROCESSING')`,
      [orderId],
      c,
    );
    await query(`UPDATE payment_verifications SET status='CANCELLED', decided_at=now() WHERE order_id=$1 AND status='WAITING_VERIFICATION'`, [orderId], c);
    const started = await one(`SELECT 1 FROM kitchen_orders WHERE order_id=$1 AND status <> 'NEW'`, [orderId], c);
    await query(`UPDATE kitchen_orders SET status='CANCELLED' WHERE order_id=$1 AND status IN ('NEW','PREPARING','READY')`, [orderId], c);
    await query(`UPDATE print_jobs SET status='CANCELLED' WHERE order_id=$1 AND status IN ('QUEUED','RETRYING')`, [orderId], c);
    if (paid) {
      if (!started) await returnStock(c, o.branch_id, orderId, out);
    } else await releaseStock(c, o.branch_id, orderId, out);
    await releaseQueue(c, orderId, 'CANCELLED');
    await addOrderEvent(c, orderId, 'CANCELLED', { reason, wasPaid: paid }, actor);
    await broadcastOrder(out, orderId, c, EVENTS.ORDER_CANCELLED);
    if (paid) emitQueue(out, o.branch_id);
    out.add(rooms.branchKitchen(o.branch_id), EVENTS.KITCHEN_UPDATED, { orderId });
    return { order: o, wasPaid: paid };
  });
  await out.flush();
  return r;
}

/** Customer picked up the food (or cashier marks served). Frees the queue number. */
export async function completeOrder(orderId: string, actor: Actor) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const o = await one<any>(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId], c);
    if (!o) throw notFound('Order');
    if (o.status === 'COMPLETED') return o;
    if (o.payment_status !== 'PAID' || !['PAID', 'CONFIRMED', 'NEW', 'PREPARING', 'READY'].includes(o.status)) {
      throw conflict('INVALID_STATUS', `Cannot complete order in status ${o.status}`);
    }
    await query(`UPDATE orders SET status='COMPLETED', completed_at=now(), version=version+1 WHERE id=$1`, [orderId], c);
    await query(`UPDATE kitchen_orders SET status='DONE', done_at=now() WHERE order_id=$1 AND status <> 'CANCELLED'`, [orderId], c);
    await releaseQueue(c, orderId, 'COMPLETED');
    await addOrderEvent(c, orderId, 'COMPLETED', {}, actor);
    await broadcastOrder(out, orderId, c, EVENTS.ORDER_COMPLETED);
    emitQueue(out, o.branch_id);
    out.add(rooms.branchKitchen(o.branch_id), EVENTS.KITCHEN_UPDATED, { orderId });
    return o;
  });
  await out.flush();
  return r;
}

/** Background: expire unpaid orders past their deadline (never those awaiting cashier verification). */
export async function expireStaleOrders(): Promise<number> {
  const rows = await query<any>(
    `SELECT id FROM orders WHERE payment_status IN ('UNPAID','PENDING')
       AND status IN ('CREATED','WAITING_PAYMENT','WAITING_CASH_PAYMENT','WAITING_CARD') AND expires_at < now() LIMIT 100`,
  );
  let n = 0;
  for (const r of rows) {
    try {
      await cancelOrder(r.id, 'EXPIRED', { type: 'SYSTEM', name: 'expiry' }, { allowPaid: false });
      n++;
    } catch {
      /* raced with payment: fine */
    }
  }
  return n;
}

/** Background: auto-complete READY orders after configured minutes (keeps queue display clean). */
export async function autoCompleteReady(minutes: number): Promise<number> {
  if (!minutes) return 0;
  const rows = await query<any>(`SELECT id FROM orders WHERE status='READY' AND ready_at < now() - ($1 || ' minutes')::interval LIMIT 100`, [String(minutes)]);
  for (const r of rows) await completeOrder(r.id, { type: 'SYSTEM', name: 'auto-complete' }).catch(() => {});
  return rows.length;
}
