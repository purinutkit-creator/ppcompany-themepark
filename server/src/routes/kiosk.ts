import type { FastifyInstance, FastifyRequest } from 'fastify';
import { EVENTS, rooms } from '@kiosk/shared';
import { one, pool, query } from '../db/pool';
import { requireKiosk } from '../lib/auth';
import { forbidden, notFound } from '../lib/errors';
import { publish } from '../lib/realtime';
import { getSettings } from '../lib/settings';
import { saveUpload } from '../lib/uploads';
import { parse, z, uuid } from '../lib/validate';
import { getMenu } from '../services/menu';
import { buildCart, cancelOrder, createOrder, getOrderDetail, addOrderEvent, type Actor } from '../services/orders';
import { cancelPaymentAttempt, requestVerification, startPayment } from '../services/payments';

const itemSchema = z.object({
  productId: uuid,
  qty: z.number().int().min(1).max(99),
  modifierIds: z.array(uuid).max(50).default([]),
  specialRequest: z.string().max(200).nullish(),
  upsellSourceProductId: uuid.nullish(),
});
const cartSchema = z.object({
  orderType: z.enum(['DINE_IN', 'TAKE_AWAY']),
  items: z.array(itemSchema).min(1).max(100),
  promoCode: z.string().max(50).nullish(),
});

const kioskActor = (req: FastifyRequest): Actor => ({ type: 'KIOSK', id: req.kiosk!.id, name: req.kiosk!.code });

/** Public subset of settings safe to expose to customer devices (no secrets). */
export async function publicSettings() {
  const s = await getSettings();
  return {
    store: s.store,
    tax: s.tax,
    order: { orderTypes: s.order.orderTypes, expiryMinutes: s.order.expiryMinutes },
    kiosk: s.kiosk,
    payment: {
      methods: s.payment.methods,
      qr: { mode: s.payment.qr.mode, accountName: s.payment.qr.accountName, bankName: s.payment.qr.bankName, countdownSec: s.payment.qr.countdownSec },
      cash: s.payment.cash,
      card: { timeoutSec: s.payment.card.timeoutSec, provider: s.payment.card.provider },
      other: s.payment.other,
    },
    receipt: { showQr: s.receipt.showQr },
    theme: s.theme,
    fonts: s.fonts,
    queue: s.queue,
  };
}

async function ownOrder(req: FastifyRequest, id: string) {
  const o = await one<any>(`SELECT id, kiosk_id, branch_id FROM orders WHERE id=$1`, [id]);
  if (!o) throw notFound('Order');
  if (o.kiosk_id !== req.kiosk!.id) throw forbidden('NOT_YOUR_ORDER');
  return o;
}

export default async function kioskRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireKiosk);

  app.post('/pair', async (req) => {
    await query(`UPDATE kiosks SET status='ONLINE', last_seen_at=now(), ip=$2 WHERE id=$1`, [req.kiosk!.id, req.ip]);
    return { kiosk: { id: req.kiosk!.id, code: req.kiosk!.code, name: req.kiosk!.name, branchId: req.kiosk!.branch_id } };
  });

  app.get('/bootstrap', async (req) => {
    const k = req.kiosk!;
    const [branch, languages, fonts, settings] = await Promise.all([
      one<any>(`SELECT id, code, name, address, phone, timezone FROM branches WHERE id=$1`, [k.branch_id]),
      query(`SELECT code, name, native_name, flag, enabled, is_default, sort, overrides FROM languages WHERE enabled ORDER BY sort`),
      query(`SELECT id, family, source, file_url, format, weights FROM fonts`),
      publicSettings(),
    ]);
    return {
      kiosk: {
        id: k.id, code: k.code, name: k.name, branchId: k.branch_id, defaultLanguage: k.default_language, idleTimeout: k.idle_timeout,
        paymentMethods: k.payment_methods, orderTypes: k.order_types, theme: k.theme, receiptPrinterId: k.receipt_printer_id,
      },
      branch,
      languages,
      fonts,
      settings,
      serverTime: new Date().toISOString(),
    };
  });

  app.get('/menu', async (req) => getMenu(req.kiosk!.branch_id));

  app.post('/quote', async (req) => {
    const b = parse(cartSchema, req.body);
    const { pricing } = await buildCart(pool, req.kiosk!.branch_id, { ...b, items: b.items.map((i) => ({ ...i, modifierIds: i.modifierIds ?? [] })) });
    return pricing;
  });

  app.post('/orders', async (req) => {
    const b = parse(
      cartSchema.extend({
        clientOrderId: uuid,
        language: z.enum(['th', 'en', 'zh']),
        note: z.string().max(300).nullish(),
        offlineRef: z.string().max(40).nullish(),
      }),
      req.body,
    );
    const r = await createOrder(b as any, { branchId: req.kiosk!.branch_id, kioskId: req.kiosk!.id, source: 'KIOSK', actor: kioskActor(req) });
    const d = await getOrderDetail(r.orderId);
    return { ...r, order: d.order, items: d.items };
  });

  app.get('/orders/:id', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await ownOrder(req, id);
    const d = await getOrderDetail(id);
    return {
      order: d.order,
      items: d.items,
      payments: d.payments.map((p: any) => ({ ...p, provider_txn_id: undefined })),
      verifications: d.verifications.map((v: any) => ({ id: v.id, status: v.status, reason: v.reason, requested_at: v.requested_at })),
      prints: d.prints,
    };
  });

  app.post('/orders/:id/payments', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ method: z.enum(['QR', 'CASH', 'CARD', 'OTHER']) }), req.body);
    await ownOrder(req, id);
    return startPayment(id, b.method, kioskActor(req), req.kiosk!.payment_methods);
  });

  app.post('/orders/:id/payments/:paymentId/verify', async (req) => {
    const p = parse(z.object({ id: uuid, paymentId: uuid }), req.params);
    const b = parse(z.object({ customerReference: z.string().max(100).nullish(), slipUrl: z.string().max(300).regex(/^\/uploads\/image\//).nullish() }), req.body ?? {});
    await ownOrder(req, p.id);
    return requestVerification(p.id, p.paymentId, { slipUrl: b.slipUrl, customerReference: b.customerReference, kioskId: req.kiosk!.id }, kioskActor(req));
  });

  app.post('/orders/:id/slip', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await ownOrder(req, id);
    const file = await req.file();
    if (!file) throw notFound('File');
    const saved = await saveUpload(file, ['image']);
    await query(`UPDATE payment_verifications SET slip_url=$2 WHERE order_id=$1 AND status='WAITING_VERIFICATION'`, [id, saved.url]);
    await addOrderEvent(pool, id, 'SLIP_UPLOADED', { url: saved.url }, kioskActor(req));
    return { url: saved.url };
  });

  app.post('/orders/:id/payments/:paymentId/cancel', async (req) => {
    const p = parse(z.object({ id: uuid, paymentId: uuid }), req.params);
    await ownOrder(req, p.id);
    return cancelPaymentAttempt(p.id, p.paymentId, kioskActor(req));
  });

  app.post('/orders/:id/cancel', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await ownOrder(req, id);
    await cancelOrder(id, 'CUSTOMER_CANCELLED', kioskActor(req), { allowPaid: false });
    return { ok: true };
  });

  app.post('/orders/:id/call-staff', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const o = await ownOrder(req, id);
    const d = await one<any>(`SELECT order_number, total FROM orders WHERE id=$1`, [id]);
    await addOrderEvent(pool, id, 'STAFF_CALLED', {}, kioskActor(req));
    await publish([rooms.branchCashier(o.branch_id), rooms.branchAdmin(o.branch_id)], EVENTS.STAFF_CALL, {
      orderId: id, orderNumber: d.order_number, kioskCode: req.kiosk!.code, reason: 'CUSTOMER_REQUEST', amount: d.total,
    });
    return { ok: true };
  });

  /** Call staff without an order (e.g. help on the menu screen). */
  app.post('/call-staff', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    await publish([rooms.branchCashier(req.kiosk!.branch_id)], EVENTS.STAFF_CALL, { kioskCode: req.kiosk!.code, reason: 'CUSTOMER_REQUEST' });
    return { ok: true };
  });

  app.post('/heartbeat', async (req) => {
    const b = parse(z.object({ version: z.string().max(40).optional(), pendingSync: z.number().int().min(0).optional() }), req.body ?? {});
    await query(`UPDATE kiosks SET status='ONLINE', last_seen_at=now(), app_version=COALESCE($2, app_version), ip=$3 WHERE id=$1`, [req.kiosk!.id, b.version ?? null, req.ip]);
    return { ok: true, serverTime: new Date().toISOString() };
  });
}
