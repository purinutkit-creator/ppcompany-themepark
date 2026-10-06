import type { FastifyInstance } from 'fastify';
import { one, pool, query } from '../../db/pool';
import { audit } from '../../lib/audit';
import { branchOf, requireAnyStaff, requireKiosk, requireStaff } from '../../lib/auth';
import { forbidden, notFound } from '../../lib/errors';
import { idempotent } from '../../lib/idempotency';
import { parse, uuid, z } from '../../lib/validate';
import { getMenu } from '../../services/menu';
import { createOrder, getOrderDetail } from '../../services/orders';
import { payOrderWithWallet } from '../../services/payments';
import { catalog } from '../../services/park/catalog';
import { credentialProfile } from '../../services/park/credentials';
import { branchToday } from '../../services/park/common';
import { findCredential } from '../../services/park/cards';
import { getSettings } from '../../lib/settings';
import { idemKey, lang, ymd } from './util';

export default async function parkPosRoutes(app: FastifyInstance) {
  app.get('/stores', { preHandler: requireAnyStaff('pos.sell', 'inventory.view', 'dashboard.view') }, async (req) =>
    query(`SELECT s.*, p.name AS printer_name FROM stores s LEFT JOIN printers p ON p.id=s.receipt_printer_id WHERE s.branch_id=$1 AND s.is_active ORDER BY s.code`, [branchOf(req)]),
  );

  /** POS catalogue for a store: retail / service products (with barcode + stock) or the restaurant menu. */
  app.get('/stores/:id/catalog', { preHandler: requireAnyStaff('pos.sell') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const st = await one<any>(`SELECT * FROM stores WHERE id=$1 AND branch_id=$2`, [id, branchOf(req)]);
    if (!st) throw notFound('Store');
    if (st.type === 'RESTAURANT') return { store: st, mode: 'RESTAURANT', menu: await getMenu(st.branch_id) };
    const products = await query(
      `SELECT p.id, p.sku, p.barcode, p.category_id, p.image_url, p.price, p.status, p.track_stock, p.product_type, i.qty AS stock,
              COALESCE((SELECT json_object_agg(lang, name) FROM product_translations WHERE product_id=p.id), '{}') AS name
         FROM products p JOIN categories c ON c.id=p.category_id LEFT JOIN inventory i ON i.product_id=p.id AND i.store_id=$1
        WHERE p.deleted_at IS NULL AND p.status <> 'HIDDEN' AND c.is_active AND (cardinality($2::uuid[])=0 OR p.category_id = ANY($2)) AND c.channel <> 'FOOD'
        ORDER BY c.sort, p.sort`,
      [id, st.category_ids],
    );
    const categories = await query(`SELECT id, name, icon, image_url, sort FROM categories WHERE is_active AND channel <> 'FOOD' AND (cardinality($1::uuid[])=0 OR id = ANY($1)) ORDER BY sort`, [st.category_ids]);
    const lockerRates = st.type === 'LOCKER' ? await query(`SELECT * FROM locker_rates WHERE (branch_id=$1 OR branch_id IS NULL) AND is_active ORDER BY sort`, [st.branch_id]) : [];
    return { store: st, mode: 'RETAIL', products, categories, lockerRates };
  });

  /** Counter catalogue: packages for today (or a date) with prices per ticket type. */
  app.get('/packages', { preHandler: requireAnyStaff('tickets.sell') }, async (req) => {
    const q = parse(z.object({ date: ymd.optional(), memberId: uuid.optional() }), req.query);
    const branchId = branchOf(req);
    const member = q.memberId ? { tierId: (await one<any>(`SELECT tier_id FROM members WHERE id=$1`, [q.memberId]))?.tier_id ?? null } : null;
    const date = q.date ?? (await branchToday(branchId));
    const s = await getSettings();
    return {
      date,
      packages: await catalog(branchId, 'COUNTER', date, member),
      membershipProducts: await query(
        `SELECT mp.id, mp.code, mp.name, mp.price, mp.registration_fee, mp.renewal_price, mp.validity_unit, mp.validity_value, t.name AS tier_name, t.color AS tier_color
           FROM membership_products mp JOIN member_tiers t ON t.id=mp.tier_id WHERE mp.is_active AND 'COUNTER' = ANY(mp.channels) ORDER BY mp.sort`,
      ),
      topupAmounts: s.wallet.quickAmounts,
      lockerRates: await query(`SELECT * FROM locker_rates WHERE (branch_id=$1 OR branch_id IS NULL) AND is_active ORDER BY sort`, [branchId]),
    };
  });

  /** Restaurant POS order (goes to KDS); optional scanned member card for FOOD discount + points. */
  app.post('/orders', { preHandler: requireStaff('pos.sell') }, async (req) => {
    const b = parse(
      z.object({
        clientOrderId: uuid, storeId: uuid.nullish(), orderType: z.enum(['DINE_IN', 'TAKE_AWAY']).default('DINE_IN'), language: lang.default('th'),
        items: z.array(z.object({ productId: uuid, qty: z.number().int().min(1).max(99), modifierIds: z.array(uuid).default([]), specialRequest: z.string().max(200).nullish() })).min(1).max(100),
        promoCode: z.string().max(50).nullish(), note: z.string().max(300).nullish(), memberCode: z.string().max(300).nullish(),
      }),
      req.body,
    );
    let member: { memberId: string | null; accountId: string | null; credentialId: string | null } | null = null;
    if (b.memberCode) {
      const c = await findCredential(b.memberCode);
      member = { memberId: c.member_id, accountId: c.account_id, credentialId: c.id };
    }
    const r = await createOrder({ ...b, member, storeId: b.storeId ?? null } as any, { branchId: branchOf(req), kioskId: null, source: 'POS', actor: { type: 'STAFF', id: req.staff!.id, name: req.staff!.name }, staffId: req.staff!.id });
    return { ...r, ...(await getOrderDetail(r.orderId)) };
  });

  /** Pay a restaurant order with the card wallet (scan wristband / card / app QR). */
  app.post('/orders/:id/wallet', { preHandler: requireStaff('pos.sell') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ code: z.string().min(3).max(300) }), req.body);
    const o = await one<any>(`SELECT branch_id, total FROM orders WHERE id=$1`, [id]);
    if (!o) throw notFound('Order');
    if (o.branch_id !== branchOf(req)) throw forbidden('OTHER_BRANCH');
    const key = idemKey(req) ?? `order:${id}`;
    const r = await idempotent(`order-wallet:${id}`, key, b, () => payOrderWithWallet(id, { credentialPayload: b.code, idempotencyKey: key, staff: req.staff!, actor: { type: 'STAFF', id: req.staff!.id, name: req.staff!.name }, allowStaticDigital: true }));
    if (!r.alreadyPaid) await audit(req, { action: 'PAYMENT_WALLET', entity: 'order', entityId: id, orderId: id, newValue: { total: o.total, balance: r.balance } });
    return r;
  });

  /** Card lookup for POS (name, tier, balance) — same CARD PROFILE as the counter. */
  app.post('/card', { preHandler: requireAnyStaff('pos.sell', 'cards.view') }, async (req) => {
    const b = parse(z.object({ code: z.string().min(2).max(300) }), req.body);
    const c = await findCredential(b.code);
    return credentialProfile(pool, c.id);
  });
}

/** Self-ordering kiosk (food) paying with the park wallet. */
export async function parkKioskFoodRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireKiosk);
  app.post('/orders/:id/wallet', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ code: z.string().min(3).max(300) }), req.body);
    const o = await one<any>(`SELECT kiosk_id FROM orders WHERE id=$1`, [id]);
    if (!o || o.kiosk_id !== req.kiosk!.id) throw notFound('Order');
    const key = idemKey(req) ?? `kiosk-order:${id}`;
    return idempotent(`order-wallet:${id}`, key, b, () => payOrderWithWallet(id, { credentialPayload: b.code, idempotencyKey: key, actor: { type: 'KIOSK', id: req.kiosk!.id, name: req.kiosk!.code } }));
  });
  /** Park kiosk: catalogue for buying tickets at the kiosk. */
  app.get('/park/catalog', async (req) => {
    const q = parse(z.object({ date: ymd.optional() }), req.query);
    const date = q.date ?? (await branchToday(req.kiosk!.branch_id));
    return { date, packages: await catalog(req.kiosk!.branch_id, 'KIOSK', date, null), branchId: req.kiosk!.branch_id };
  });
  /** Park kiosk: scan a card to see balance / tickets / queues (no personal data beyond first name). */
  app.post('/park/card', async (req) => {
    const b = parse(z.object({ code: z.string().min(2).max(300) }), req.body);
    const { resolveScan } = await import('../../services/park/credentials');
    const r = await resolveScan(b.code, pool);
    if (!r.ok) throw notFound('Card');
    const p = await credentialProfile(pool, r.credential.id);
    return {
      code: p!.credential.code, type: p!.credential.type, status: p!.credential.status, expiresAt: p!.credential.expires_at,
      name: p!.member?.first_name ?? p!.tickets[0]?.guest_name ?? null, tier: p!.member ? { name: p!.member.tier_name, color: p!.member.tier_color } : null,
      balance: p!.wallet ? Number(p!.wallet.balance) : null, points: p!.member?.points ?? null,
      tickets: p!.tickets.map((t: any) => ({ ticketNo: t.ticket_no, status: t.status, package: t.package_name, ticketType: t.ticket_type_name, visitDate: t.visit_date, validTo: t.valid_to, presence: t.presence })),
      rides: p!.entitlements.map((e: any) => ({ ride: e.ride_name, type: e.type, usesLeft: e.uses_left, validUntil: e.valid_until, status: e.status })),
      queues: p!.queues.map((q: any) => ({ queueNo: q.queue_no, ride: q.ride_name, status: q.status })),
      lockers: p!.lockers.map((l: any) => ({ code: l.locker_code, expireAt: l.expire_at })),
    };
  });
}
