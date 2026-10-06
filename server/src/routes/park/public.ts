import type { FastifyInstance } from 'fastify';
import { one, query } from '../../db/pool';
import { optionalMember } from '../../lib/auth';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { getSettings } from '../../lib/settings';
import { saveUpload } from '../../lib/uploads';
import { parse, uuid, z } from '../../lib/validate';
import { bookingCalendar, bookingForCustomer, cancelBooking, createBooking, getBookingDetail } from '../../services/park/bookings';
import { catalog } from '../../services/park/catalog';
import { branchToday, parkSettings } from '../../services/park/common';
import { occupancy } from '../../services/park/gates';
import { listRewards } from '../../services/park/rewards';
import { rideBoard } from '../../services/park/rides';
import { addPayment, cancelPaymentAttempt, requestSaleVerification } from '../../services/park/sales';
import { saleReceiptData } from '../../services/park/print';
import { simulateSaleProviderResult } from '../../services/park/providers';
import { anyActor, customerMethod, idemKey, lang, ymd } from './util';

/** Settings safe for the public website / member portal (no secrets). */
export async function publicParkSettings() {
  const s = await getSettings();
  return {
    park: { name: s.park.name, tagline: s.park.tagline, logoUrl: s.park.logoUrl || s.theme.logoUrl, openTime: s.park.openTime, closeTime: s.park.closeTime },
    store: { currency: s.store.currency, currencySymbol: s.store.currencySymbol, phone: s.store.phone, address: s.store.address },
    theme: s.theme,
    fonts: s.fonts,
    booking: { payAtParkEnabled: s.booking.payAtParkEnabled, guestCheckout: s.booking.guestCheckout, maxGuests: s.booking.maxGuests, advanceDays: s.booking.advanceDays },
    payment: { online: s.parkPayment.online, allowSlipUpload: s.parkPayment.allowSlipUpload, qrCountdownSec: s.parkPayment.qrCountdownSec, qr: { accountName: s.payment.qr.accountName, bankName: s.payment.qr.bankName } },
    member: { allowDigitalCard: s.member.allowDigitalCard, otp: { enabled: s.member.otp.enabled, requireOnRegister: s.member.otp.requireOnRegister }, passwordMinLength: s.member.passwordMinLength, digitalQrTtlSec: s.member.digitalQrTtlSec },
    wallet: { quickAmounts: s.wallet.quickAmounts, minTopup: s.wallet.minTopup, maxTopup: s.wallet.maxTopup, enabled: s.wallet.enabled },
    points: { enabled: s.points.enabled, redeemValue: s.points.redeemValue },
    ui: s.ui,
    parkReceipt: { ticketTerms: s.parkReceipt.ticketTerms },
  };
}

async function branchByCode(code: string) {
  const b = await one<any>(`SELECT id, code, name, address, phone, timezone, logo_url FROM branches WHERE code=$1 AND is_active`, [code.toUpperCase()]);
  if (!b) throw notFound('Branch');
  return b;
}

export default async function parkPublicRoutes(app: FastifyInstance) {
  app.get('/bootstrap', async () => ({
    settings: await publicParkSettings(),
    branches: await query(`SELECT id, code, name, address, phone, timezone, logo_url FROM branches WHERE is_active ORDER BY code`),
    languages: await query(`SELECT code, name, native_name, flag, enabled, is_default, sort, overrides FROM languages WHERE enabled ORDER BY sort`),
    fonts: await query(`SELECT id, family, source, file_url, format, weights FROM fonts ORDER BY family`),
    ticketTypes: await query(`SELECT id, code, name, description, min_age, max_age, min_height, max_height, color, sort FROM ticket_types WHERE is_active ORDER BY sort`),
  }));

  /** Packages for a branch / date with prices per ticket type and remaining capacity. Members see member prices. */
  app.get('/branches/:code/catalog', { preHandler: optionalMember }, async (req) => {
    const { code } = parse(z.object({ code: z.string().max(40) }), req.params);
    const q = parse(z.object({ date: ymd.optional(), channel: z.enum(['ONLINE', 'KIOSK']).default('ONLINE') }), req.query);
    const b = await branchByCode(code);
    const date = q.date ?? (await branchToday(b.id));
    let member: { tierId: string | null } | null = null;
    if (req.member) member = { tierId: (await one<any>(`SELECT tier_id FROM members WHERE id=$1`, [req.member.id]))?.tier_id ?? null };
    return { branch: b, date, packages: await catalog(b.id, req.member ? 'PORTAL' : q.channel, date, member) };
  });

  app.get('/branches/:code/calendar', async (req) => {
    const { code } = parse(z.object({ code: z.string().max(40) }), req.params);
    const { month } = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }), req.query);
    const b = await branchByCode(code);
    const cal = await bookingCalendar(b.id, month);
    // Public view: only availability, no booking counts.
    return { capacity: cal.capacity, days: cal.days.map((d) => ({ date: d.date, pct: d.pct, soldOut: d.guests >= cal.capacity })) };
  });

  /** Live status for the website / public screens: rides, wait times, park occupancy %. */
  app.get('/branches/:code/live', async (req) => {
    const { code } = parse(z.object({ code: z.string().max(40) }), req.params);
    const b = await branchByCode(code);
    const occ = await occupancy((await import('../../db/pool')).pool, b.id);
    const rides = await rideBoard((await import('../../db/pool')).pool, b.id);
    return {
      branch: b,
      occupancy: { pct: occ.pct, level: occ.pct >= 90 ? 'CROWDED' : occ.pct >= 70 ? 'BUSY' : 'NORMAL' },
      rides: rides.map((r) => ({ id: r.id, code: r.code, name: r.name, image_url: r.image_url, status: r.status, entry_paused: r.entry_paused, wait_minutes: r.wait_minutes, queue_enabled: r.queue_enabled, min_height: r.min_height, min_age: r.min_age, addon_price: r.addon_price, zone_name: r.zone_name, map: r.map })),
    };
  });

  app.get('/membership-products', async () =>
    query(
      `SELECT mp.id, mp.code, mp.name, mp.description, mp.image_url, mp.card_design, mp.price, mp.registration_fee, mp.validity_unit, mp.validity_value,
              mp.renewal_price, mp.point_multiplier, t.code AS tier_code, t.name AS tier_name, t.color AS tier_color, t.rank AS tier_rank,
              COALESCE((SELECT json_agg(json_build_object('type', b.type, 'value', b.value, 'name', b.name) ORDER BY b.sort) FROM membership_benefits b WHERE b.product_id=mp.id), '[]') AS benefits
         FROM membership_products mp JOIN member_tiers t ON t.id=mp.tier_id WHERE mp.is_active AND 'ONLINE' = ANY(mp.channels) ORDER BY mp.sort, t.rank`,
    ),
  );

  app.get('/rewards', async () => listRewards(null));

  // ---------------------------------------------------------------- bookings (guest or member)
  const bookingSchema = z.object({
    branchCode: z.string().max(40),
    visitDate: ymd,
    items: z.array(z.object({ packageId: uuid, ticketTypeId: uuid.nullish(), qty: z.number().int().min(1).max(50), guestNames: z.array(z.string().max(80)).max(50).optional() })).min(1).max(20),
    customer: z.object({ name: z.string().min(1).max(120), phone: z.string().max(30).nullish(), email: z.string().email().max(160).nullish() }),
    codes: z.array(z.string().max(40)).max(5).default([]),
    payMode: z.enum(['PAY_NOW', 'PAY_AT_PARK']).default('PAY_NOW'),
    language: lang.default('th'),
    note: z.string().max(300).nullish(),
    clientRef: z.string().uuid().nullish(),
  });

  app.post('/bookings', { preHandler: optionalMember, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(bookingSchema, req.body);
    const branch = await branchByCode(b.branchCode);
    const s = await parkSettings(branch.id);
    const guests = b.items.reduce((n, i) => n + i.qty, 0);
    if (guests > s.booking.maxGuests) throw badRequest('TOO_MANY_GUESTS', `Maximum ${s.booking.maxGuests} guests per booking`);
    const d = await createBooking({
      branchId: branch.id, channel: req.member ? 'PORTAL' : 'ONLINE', memberId: req.member?.id ?? null, customer: b.customer, visitDate: b.visitDate,
      items: b.items, codes: b.codes, payMode: b.payMode, language: b.language, note: b.note, clientRef: b.clientRef ?? null,
    });
    return { ...d, accessToken: d.booking.access_token };
  });

  /** Quote without creating anything (cart total, promotions). */
  app.post('/quote', { preHandler: optionalMember }, async (req) => {
    const b = parse(bookingSchema.omit({ customer: true, payMode: true, note: true, clientRef: true }).extend({ customer: z.any().optional() }), req.body);
    const branch = await branchByCode(b.branchCode);
    const { quoteSale } = await import('../../services/park/sales');
    return quoteSale({
      branchId: branch.id, channel: req.member ? 'PORTAL' : 'ONLINE', memberId: req.member?.id ?? null, visitDate: b.visitDate, codes: b.codes,
      lines: b.items.map((i) => ({ type: 'PACKAGE', refId: i.packageId, ticketTypeId: i.ticketTypeId ?? null, qty: i.qty, meta: { visitDate: b.visitDate } })),
    });
  });

  const tokenOf = (req: any) => String(req.headers['x-booking-token'] ?? (req.query as any)?.token ?? '');
  async function guard(req: any, bookingNo: string) {
    const bk = await one<any>(`SELECT id, access_token, member_id, sale_id, branch_id FROM bookings WHERE booking_no=$1`, [bookingNo.toUpperCase()]);
    if (!bk) throw notFound('Booking');
    if (bk.access_token !== tokenOf(req)) throw notFound('Booking');
    return bk;
  }

  app.get('/bookings/:no', async (req) => {
    const { no } = parse(z.object({ no: z.string().max(40) }), req.params);
    return bookingForCustomer(no, tokenOf(req));
  });

  /** Start / switch payment for a booking (PromptPay QR, card gateway, mobile banking, bank transfer). */
  app.post('/bookings/:no/payments', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { no } = parse(z.object({ no: z.string().max(40) }), req.params);
    const b = parse(z.object({ method: customerMethod.exclude(['WALLET', 'POINTS']) }), req.body);
    const bk = await guard(req, no);
    const s = await parkSettings(bk.branch_id);
    if (!s.parkPayment.online[b.method]) throw badRequest('PAYMENT_METHOD_DISABLED');
    // One open attempt at a time: cancel previous pending ones.
    const open = await query<any>(`SELECT id FROM sale_payments WHERE sale_id=$1 AND status IN ('PENDING','WAITING_CARD','PROCESSING')`, [bk.sale_id]);
    for (const p of open) await cancelPaymentAttempt(bk.sale_id, p.id);
    const r = await addPayment(bk.sale_id, { method: b.method, idempotencyKey: idemKey(req) }, { actor: anyActor(req), channel: 'ONLINE' });
    return { payment: { ...r.payment, provider_txn_id: undefined }, sale: { id: r.sale.id, status: r.sale.status, total: r.sale.total, paid_amount: r.sale.paid_amount } };
  });

  app.post('/bookings/:no/payments/:paymentId/verify', async (req) => {
    const p = parse(z.object({ no: z.string().max(40), paymentId: uuid }), req.params);
    const b = parse(z.object({ reference: z.string().max(100).nullish(), slipUrl: z.string().max(300).regex(/^\/uploads\/image\//).nullish(), paymentTime: z.string().max(40).nullish() }), req.body ?? {});
    const bk = await guard(req, p.no);
    return requestSaleVerification(bk.sale_id, p.paymentId, b, anyActor(req));
  });

  app.post('/bookings/:no/slip', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { no } = parse(z.object({ no: z.string().max(40) }), req.params);
    const bk = await guard(req, no);
    const s = await parkSettings(bk.branch_id);
    if (!s.parkPayment.allowSlipUpload) throw forbidden('SLIP_UPLOAD_DISABLED');
    const file = await req.file();
    if (!file) throw badRequest('FILE_REQUIRED');
    const saved = await saveUpload(file, ['image']);
    await query(`UPDATE payment_verification_requests SET slip_url=$2 WHERE sale_id=$1 AND status='WAITING_VERIFICATION'`, [bk.sale_id, saved.url]);
    return { url: saved.url };
  });

  app.post('/bookings/:no/payments/:paymentId/cancel', async (req) => {
    const p = parse(z.object({ no: z.string().max(40), paymentId: uuid }), req.params);
    const bk = await guard(req, p.no);
    return cancelPaymentAttempt(bk.sale_id, p.paymentId);
  });

  app.post('/bookings/:no/cancel', async (req) => {
    const { no } = parse(z.object({ no: z.string().max(40) }), req.params);
    const bk = await guard(req, no);
    return cancelBooking(bk.id, 'CUSTOMER_CANCELLED', { type: 'GUEST' });
  });

  /** Sandbox gateway "hosted payment page" result (only for the sandbox provider; real gateways call the webhook). */
  app.post('/bookings/:no/payments/:paymentId/sandbox', async (req) => {
    const p = parse(z.object({ no: z.string().max(40), paymentId: uuid }), req.params);
    const b = parse(z.object({ outcome: z.enum(['succeeded', 'failed', 'cancelled']) }), req.body);
    const bk = await guard(req, p.no);
    const pay = await one<any>(`SELECT sale_id FROM sale_payments WHERE id=$1`, [p.paymentId]);
    if (!pay || pay.sale_id !== bk.sale_id) throw notFound('Payment');
    return simulateSaleProviderResult(p.paymentId, b.outcome);
  });

  /** Receipt page (QR on printed receipts): unguessable sale id. */
  app.get('/receipts/:saleId', async (req) => {
    const { saleId } = parse(z.object({ saleId: uuid }), req.params);
    const s = await one<any>(`SELECT status FROM sales WHERE id=$1`, [saleId]);
    if (!s) throw notFound('Receipt');
    if (!['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(s.status)) throw conflict('NOT_PAID');
    const d = await saleReceiptData((await import('../../db/pool')).pool, saleId);
    return { ...d, customer: d.customer ? d.customer.replace(/(?<=.).(?=.)/g, '•') : null };
  });

  app.get('/bookings/:no/detail-for-member', async () => {
    throw notFound('Use /api/park/member/bookings');
  });

  app.get('/booking-by-id/:id', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const token = tokenOf(req);
    const bk = await one<any>(`SELECT access_token FROM bookings WHERE id=$1`, [id]);
    if (!bk || bk.access_token !== token) throw notFound('Booking');
    return getBookingDetail(id);
  });
}
