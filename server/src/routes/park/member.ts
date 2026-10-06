import type { FastifyInstance } from 'fastify';
import { one, query } from '../../db/pool';
import { requireMember } from '../../lib/auth';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { getSettings } from '../../lib/settings';
import { hashSecret, verifySecret } from '../../lib/tokens';
import { parse, uuid, z } from '../../lib/validate';
import { tx } from '../../db/pool';
import { getBookingDetail } from '../../services/park/bookings';
import { dynamicFor, payloadsFor } from '../../services/park/credentials';
import {
  getMemberFull, logoutAll, memberLogin, memberToken, normalizeEmail, normalizePhone, registerMemberTx, requestOtp, resetPassword, verifyOtp,
} from '../../services/park/members';
import { accountQueues, joinQueue, leaveQueue } from '../../services/park/queues';
import { listRewards, memberRedemptions, redeemReward } from '../../services/park/rewards';
import { addPayment, cancelPaymentAttempt, createSale, getSaleDetail, quoteSale, requestSaleVerification } from '../../services/park/sales';
import { simulateSaleProviderResult } from '../../services/park/providers';
import { cancelOrder, createOrder, getOrderDetail } from '../../services/orders';
import { payOrderWithWallet } from '../../services/payments';
import { idemKey, lang } from './util';

const registerSchema = z.object({
  phone: z.string().min(9).max(20),
  firstName: z.string().min(1).max(80),
  lastName: z.string().max(80).default(''),
  email: z.string().email().max(160).nullish(),
  password: z.string().min(6).max(200),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED']).nullish(),
  address: z.string().max(300).nullish(),
  emergencyContact: z.string().max(160).nullish(),
  language: lang.default('th'),
  otp: z.string().max(10).nullish(),
  branchCode: z.string().max(40).nullish(),
});

export default async function parkMemberRoutes(app: FastifyInstance) {
  const meta = (req: any) => ({ ip: req.ip as string, ua: String(req.headers['user-agent'] ?? '') });

  app.post('/register', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(registerSchema, req.body);
    const s = await getSettings();
    if (!s.member.enabled) throw forbidden('MEMBERSHIP_DISABLED');
    if (s.member.otp.enabled && s.member.otp.requireOnRegister) {
      if (!b.otp || !(await verifyOtp(normalizePhone(b.phone), 'REGISTER', b.otp))) throw badRequest('OTP_INVALID', 'Verify your phone number first');
    }
    const branch = b.branchCode ? await one<any>(`SELECT id FROM branches WHERE code=$1`, [b.branchCode.toUpperCase()]) : null;
    const r = await tx((c) => registerMemberTx(c, { ...b, branchId: branch?.id ?? null, createdVia: 'ONLINE' }));
    if (s.member.otp.requireOnRegister) await query(`UPDATE members SET phone_verified=true WHERE id=$1`, [r.member.id]);
    const login = await memberLogin(app, normalizePhone(b.phone), b.password, meta(req));
    return { token: login.token, memberId: r.member.id, memberNo: r.member.member_no };
  });

  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(z.object({ login: z.string().min(3).max(160), password: z.string().min(1).max(200) }), req.body);
    return memberLogin(app, b.login, b.password, meta(req));
  });

  app.post('/otp', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(z.object({ target: z.string().min(3).max(160), purpose: z.enum(['REGISTER', 'LOGIN', 'RESET_PASSWORD', 'VERIFY']) }), req.body);
    const target = b.target.includes('@') ? normalizeEmail(b.target)! : normalizePhone(b.target);
    if (b.purpose === 'RESET_PASSWORD' || b.purpose === 'LOGIN') {
      const exists = await one(b.target.includes('@') ? `SELECT 1 FROM members WHERE lower(email)=$1` : `SELECT 1 FROM members WHERE phone=$1`, [target]);
      // Do not reveal whether an account exists.
      if (!exists) return { sent: true };
    }
    return requestOtp(target, b.purpose);
  });

  /** OTP login (passwordless) when enabled. */
  app.post('/login/otp', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(z.object({ login: z.string().min(3).max(160), code: z.string().min(4).max(10) }), req.body);
    const isEmail = b.login.includes('@');
    const target = isEmail ? normalizeEmail(b.login)! : normalizePhone(b.login);
    if (!(await verifyOtp(target, 'LOGIN', b.code))) throw badRequest('OTP_INVALID', 'Invalid or expired code');
    const m = await one<any>(isEmail ? `SELECT * FROM members WHERE lower(email)=$1` : `SELECT * FROM members WHERE phone=$1`, [target]);
    if (!m || m.status !== 'ACTIVE') throw notFound('Member');
    const sess = await one<any>(`INSERT INTO member_sessions (member_id, ip, user_agent) VALUES ($1,$2,$3) RETURNING id`, [m.id, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300)]);
    await query(`UPDATE members SET last_login_at=now(), ${isEmail ? 'email_verified' : 'phone_verified'}=true WHERE id=$1`, [m.id]);
    return { token: memberToken(app, m, sess.id), memberId: m.id };
  });

  app.post('/password/reset', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(z.object({ login: z.string().min(3).max(160), code: z.string().min(4).max(10), newPassword: z.string().min(6).max(200) }), req.body);
    return resetPassword(b.login, b.code, b.newPassword);
  });

  // ------------------------------------------------------------ authenticated
  app.register(async (auth) => {
    auth.addHook('preHandler', requireMember);

    auth.get('/me', async (req) => {
      const full = await getMemberFull((await import('../../db/pool')).pool, req.member!.id);
      return { ...full, cards: full.cards.map((c: any) => ({ ...c, ...(c.type === 'DIGITAL_CARD' ? {} : payloadsFor(c)) })) };
    });

    auth.put('/me', async (req) => {
      const b = parse(
        z.object({ firstName: z.string().min(1).max(80), lastName: z.string().max(80).default(''), email: z.string().email().max(160).nullish(), birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
          gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED']).nullish(), address: z.string().max(300).nullish(), emergencyContact: z.string().max(160).nullish(), language: lang.optional() }),
        req.body,
      );
      const email = normalizeEmail(b.email);
      if (email && (await one(`SELECT 1 FROM members WHERE lower(email)=$1 AND id<>$2`, [email, req.member!.id]))) throw conflict('EMAIL_TAKEN');
      // Birthday can only be set once by the member (birthday promotions).
      await query(
        `UPDATE members SET first_name=$2, last_name=$3, email=$4, birthday=COALESCE(birthday, $5), gender=$6, address=$7, emergency_contact=$8, language=COALESCE($9, language),
            email_verified = CASE WHEN lower(COALESCE(email,'')) <> lower(COALESCE($4,'')) THEN false ELSE email_verified END WHERE id=$1`,
        [req.member!.id, b.firstName, b.lastName, email, b.birthday ?? null, b.gender ?? null, b.address ?? null, b.emergencyContact ?? null, b.language ?? null],
      );
      return { ok: true };
    });

    auth.post('/password', async (req) => {
      const b = parse(z.object({ current: z.string().max(200), next: z.string().min(6).max(200) }), req.body);
      const m = await one<any>(`SELECT password_hash FROM members WHERE id=$1`, [req.member!.id]);
      if (!(await verifySecret(b.current, m.password_hash))) throw forbidden('WRONG_PASSWORD', 'Current password is incorrect');
      const s = await getSettings();
      if (b.next.length < s.member.passwordMinLength) throw badRequest('WEAK_PASSWORD');
      await query(`UPDATE members SET password_hash=$2 WHERE id=$1`, [req.member!.id, await hashSecret(b.next)]);
      await logoutAll(req.member!.id);
      return { ok: true, reLogin: true };
    });

    auth.post('/logout', async (req) => {
      if (req.member!.sessionId) await query(`UPDATE member_sessions SET revoked_at=now() WHERE id=$1`, [req.member!.sessionId]);
      return { ok: true };
    });
    auth.post('/logout-all', async (req) => {
      await logoutAll(req.member!.id);
      return { ok: true };
    });
    auth.get('/sessions', async (req) =>
      query(`SELECT id, ip, user_agent, suspicious, created_at, last_seen_at, revoked_at, (id = $2::uuid) AS current FROM member_sessions WHERE member_id=$1 ORDER BY created_at DESC LIMIT 30`, [req.member!.id, req.member!.sessionId]),
    );

    /** Digital member card QR / barcode: short-lived (rotates) so screenshots cannot be shared. */
    auth.get('/qr', async (req) => {
      const s = await getSettings();
      const c = await one<any>(`SELECT * FROM credentials WHERE member_id=$1 AND type='DIGITAL_CARD' AND status='ACTIVE' ORDER BY created_at DESC LIMIT 1`, [req.member!.id]);
      if (!c) throw notFound('Digital card');
      return { code: c.code, ...dynamicFor(c, s.member.digitalQrTtlSec), ttlSec: s.member.digitalQrTtlSec };
    });

    auth.get('/tickets', async (req) =>
      query(
        `SELECT t.id, t.ticket_no, t.status, t.presence, t.guest_name, t.visit_date::text AS visit_date, t.valid_to::text AS valid_to, t.entry_count, p.name AS package_name, p.color,
                tt.name AS ticket_type_name, bk.booking_no, c.code AS credential_code, c.token_version
           FROM tickets t JOIN packages p ON p.id=t.package_id LEFT JOIN ticket_types tt ON tt.id=t.ticket_type_id LEFT JOIN bookings bk ON bk.id=t.booking_id
           LEFT JOIN credentials c ON c.id=t.credential_id
          WHERE (t.member_id=$1 OR t.account_id=$2) AND t.status IN ('UNPAID','PAID','ACTIVE','USED','EXPIRED') ORDER BY t.visit_date DESC, t.ticket_no LIMIT 200`,
        [req.member!.id, req.member!.accountId],
      ).then((rows) => rows.map((t) => ({ ...t, ...(t.status === 'ACTIVE' ? payloadsFor({ code: t.credential_code ?? t.ticket_no, token_version: t.token_version ?? 1 }) : {}) }))),
    );

    auth.get('/bookings', async (req) =>
      query(
        `SELECT bk.id, bk.booking_no, bk.visit_date::text AS visit_date, bk.guests, bk.status, bk.payment_status, bk.total, bk.pay_mode, bk.access_token, bk.created_at, b.code AS branch_code, b.name AS branch_name
           FROM bookings bk JOIN branches b ON b.id=bk.branch_id WHERE bk.member_id=$1 OR bk.account_id=$2 ORDER BY bk.visit_date DESC LIMIT 100`,
        [req.member!.id, req.member!.accountId],
      ),
    );
    auth.get('/bookings/:id', async (req) => {
      const { id } = parse(z.object({ id: uuid }), req.params);
      const bk = await one<any>(`SELECT member_id, account_id FROM bookings WHERE id=$1`, [id]);
      if (!bk || (bk.member_id !== req.member!.id && bk.account_id !== req.member!.accountId)) throw notFound('Booking');
      return getBookingDetail(id);
    });

    auth.get('/wallet', async (req) => {
      const w = await one<any>(`SELECT balance, bonus_balance, status, updated_at FROM wallet_accounts WHERE account_id=$1`, [req.member!.accountId]);
      const ledger = await query(
        `SELECT w.txn_no, w.type, w.debit, w.credit, w.balance_after, w.reference, w.created_at, c.code AS card FROM wallet_ledger w LEFT JOIN credentials c ON c.id=w.credential_id
          WHERE w.account_id=$1 ORDER BY w.seq DESC LIMIT 100`,
        [req.member!.accountId],
      );
      return { wallet: w, ledger };
    });

    auth.get('/points', async (req) =>
      query(`SELECT type, points, balance_after, reference, created_at FROM points_ledger WHERE member_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.member!.id]),
    );

    auth.get('/transactions', async (req) =>
      query(
        `SELECT s.id, s.sale_no, s.kind, s.channel, s.total, s.status, s.created_at, s.paid_at, s.points_earned, st.name AS store_name,
                (SELECT json_agg(json_build_object('name', name, 'qty', qty, 'total', line_total) ORDER BY sort) FROM sale_items WHERE sale_id=s.id) AS items
           FROM sales s LEFT JOIN stores st ON st.id=s.store_id WHERE (s.member_id=$1 OR s.account_id=$2) AND s.status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED','PENDING_PAYMENT')
          ORDER BY s.created_at DESC LIMIT 100`,
        [req.member!.id, req.member!.accountId],
      ),
    );

    auth.get('/rides', async (req) =>
      query(
        `SELECT l.id, l.result, l.reason_code, l.created_at, r.name AS ride_name, r.code AS ride_code, r.image_url FROM ride_access_logs l JOIN rides r ON r.id=l.ride_id
          WHERE (l.member_id=$1 OR l.credential_id IN (SELECT id FROM credentials WHERE account_id=$2)) AND l.result='GRANTED' ORDER BY l.created_at DESC LIMIT 100`,
        [req.member!.id, req.member!.accountId],
      ),
    );

    auth.get('/entitlements', async (req) =>
      query(
        `SELECT e.*, r.name AS ride_name, r.code AS ride_code FROM ride_entitlements e LEFT JOIN rides r ON r.id=e.ride_id
          WHERE e.status='ACTIVE' AND (e.account_id=$1 OR e.member_id=$2) AND (e.valid_until IS NULL OR e.valid_until > now()) ORDER BY e.valid_until NULLS LAST`,
        [req.member!.accountId, req.member!.id],
      ),
    );

    auth.get('/queues', async (req) => accountQueues((await import('../../db/pool')).pool, req.member!.accountId));
    auth.post('/queues', async (req) => {
      const b = parse(z.object({ rideId: uuid, credentialId: uuid.optional(), partySize: z.number().int().min(1).max(20).default(1) }), req.body);
      const cred = b.credentialId
        ? await one<any>(`SELECT id FROM credentials WHERE id=$1 AND account_id=$2`, [b.credentialId, req.member!.accountId])
        : await one<any>(
            `SELECT c.id FROM credentials c WHERE c.account_id=$1 AND c.status='ACTIVE' AND c.type IN ('DIGITAL_CARD','MEMBER_CARD','TEMP_WRISTBAND','PRINTED_WRISTBAND') ORDER BY (c.type='DIGITAL_CARD') DESC LIMIT 1`,
            [req.member!.accountId],
          );
      if (!cred) throw notFound('Card');
      return joinQueue(b.rideId, { credentialId: cred.id, partySize: b.partySize });
    });
    auth.delete('/queues/:id', async (req) => {
      const { id } = parse(z.object({ id: uuid }), req.params);
      return leaveQueue(id, req.member!.accountId);
    });

    auth.get('/lockers', async (req) =>
      query(
        `SELECT s.*, l.code AS locker_code, l.bank, l.size FROM locker_sessions s JOIN lockers l ON l.id=s.locker_id WHERE s.account_id=$1 ORDER BY s.start_at DESC LIMIT 30`,
        [req.member!.accountId],
      ),
    );

    auth.get('/coupons', async (req) =>
      query(
        `SELECT c.id, c.code, c.status, c.valid_from::text, c.valid_to::text, c.used_count, c.max_uses, c.source, p.name, p.description, p.type, p.value, p.value_type
           FROM coupons c JOIN promotions p ON p.id=c.promotion_id WHERE c.member_id=$1 ORDER BY c.created_at DESC LIMIT 100`,
        [req.member!.id],
      ),
    );

    auth.get('/notifications', async (req) =>
      query(`SELECT * FROM notifications WHERE audience='ACCOUNT' AND account_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.member!.accountId]),
    );
    auth.post('/notifications/read', async (req) => {
      await query(`UPDATE notifications SET read_at=now() WHERE audience='ACCOUNT' AND account_id=$1 AND read_at IS NULL`, [req.member!.accountId]);
      return { ok: true };
    });

    auth.get('/food-orders', async (req) =>
      query(
        `SELECT o.id, o.order_number, o.status, o.payment_status, o.total, o.created_at, o.ready_at,
                (SELECT json_agg(json_build_object('name', name, 'qty', qty) ORDER BY sort) FROM order_items WHERE order_id=o.id) AS items
           FROM orders o WHERE o.account_id=$1 ORDER BY o.created_at DESC LIMIT 50`,
        [req.member!.accountId],
      ),
    );

    // ---------------- rewards
    auth.get('/rewards', async (req) => ({ rewards: await listRewards(req.member!.id), redemptions: await memberRedemptions(req.member!.id) }));
    auth.post('/rewards/:id/redeem', async (req) => {
      const { id } = parse(z.object({ id: uuid }), req.params);
      const key = idemKey(req);
      if (!key) throw badRequest('IDEMPOTENCY_KEY_REQUIRED');
      return redeemReward(req.member!.id, id, key, null);
    });

    // ---------------- purchases from the portal (membership / renewal / upgrade / top-up / ride add-on)
    const portalSale = z.object({
      branchCode: z.string().max(40),
      lines: z.array(z.object({ type: z.enum(['MEMBERSHIP', 'MEMBERSHIP_RENEWAL', 'MEMBERSHIP_UPGRADE', 'TOPUP', 'PACKAGE']), refId: uuid.nullish(), ticketTypeId: uuid.nullish(), qty: z.number().int().min(1).max(20).default(1), amount: z.coerce.number().min(0).max(1_000_000).nullish(), meta: z.record(z.string(), z.any()).default({}) })).min(1).max(10),
      codes: z.array(z.string().max(40)).max(5).default([]),
      clientRef: z.string().uuid().nullish(),
      language: lang.default('th'),
    });
    auth.post('/sales/quote', async (req) => {
      const b = parse(portalSale, req.body);
      const branch = await one<any>(`SELECT id FROM branches WHERE code=$1`, [b.branchCode.toUpperCase()]);
      if (!branch) throw notFound('Branch');
      return quoteSale({ branchId: branch.id, channel: 'PORTAL', memberId: req.member!.id, lines: b.lines, codes: b.codes });
    });
    auth.post('/sales', async (req) => {
      const b = parse(portalSale, req.body);
      const branch = await one<any>(`SELECT id FROM branches WHERE code=$1`, [b.branchCode.toUpperCase()]);
      if (!branch) throw notFound('Branch');
      const r = await createSale({ branchId: branch.id, channel: 'PORTAL', memberId: req.member!.id, lines: b.lines, codes: b.codes, clientRef: b.clientRef ?? null, language: b.language });
      return getSaleDetail((await import('../../db/pool')).pool, r.sale.id);
    });
    async function ownSale(req: any, id: string) {
      const s = await one<any>(`SELECT * FROM sales WHERE id=$1`, [id]);
      if (!s || (s.member_id !== req.member!.id && s.account_id !== req.member!.accountId)) throw notFound('Sale');
      return s;
    }
    auth.get('/sales/:id', async (req) => {
      const { id } = parse(z.object({ id: uuid }), req.params);
      await ownSale(req, id);
      const d = await getSaleDetail((await import('../../db/pool')).pool, id);
      return { ...d, payments: d.payments.map((p: any) => ({ ...p, provider_txn_id: undefined })) };
    });
    auth.post('/sales/:id/payments', async (req) => {
      const { id } = parse(z.object({ id: uuid }), req.params);
      const b = parse(z.object({ method: z.enum(['PROMPTPAY', 'CARD', 'MOBILE_BANKING', 'BANK_TRANSFER', 'EWALLET', 'WALLET', 'POINTS']), amount: z.coerce.number().positive().nullish() }), req.body);
      const s = await ownSale(req, id);
      const settings = await getSettings();
      if (!['WALLET', 'POINTS'].includes(b.method) && !settings.parkPayment.online[b.method]) throw badRequest('PAYMENT_METHOD_DISABLED');
      const open = await query<any>(`SELECT id FROM sale_payments WHERE sale_id=$1 AND status IN ('PENDING','WAITING_CARD','PROCESSING')`, [s.id]);
      for (const p of open) await cancelPaymentAttempt(s.id, p.id);
      const r = await addPayment(s.id, { method: b.method, amount: b.amount ?? null, ownAccountId: b.method === 'WALLET' ? req.member!.accountId : null, idempotencyKey: idemKey(req) }, { actor: { type: 'MEMBER', id: req.member!.id, name: req.member!.name }, channel: 'PORTAL' });
      return { payment: { ...r.payment, provider_txn_id: undefined }, sale: r.sale, completed: r.completed };
    });
    auth.post('/sales/:id/payments/:paymentId/verify', async (req) => {
      const p = parse(z.object({ id: uuid, paymentId: uuid }), req.params);
      const b = parse(z.object({ reference: z.string().max(100).nullish(), slipUrl: z.string().max(300).regex(/^\/uploads\/image\//).nullish() }), req.body ?? {});
      await ownSale(req, p.id);
      return requestSaleVerification(p.id, p.paymentId, b, { type: 'MEMBER', id: req.member!.id });
    });
    auth.post('/sales/:id/payments/:paymentId/sandbox', async (req) => {
      const p = parse(z.object({ id: uuid, paymentId: uuid }), req.params);
      const b = parse(z.object({ outcome: z.enum(['succeeded', 'failed', 'cancelled']) }), req.body);
      await ownSale(req, p.id);
      return simulateSaleProviderResult(p.paymentId, b.outcome);
    });

    // ---------------- mobile food ordering (paid from the member wallet)
    auth.post('/food-orders', async (req) => {
      const b = parse(
        z.object({
          branchCode: z.string().max(40), clientOrderId: uuid, orderType: z.enum(['DINE_IN', 'TAKE_AWAY']).default('TAKE_AWAY'), language: lang.default('th'),
          items: z.array(z.object({ productId: uuid, qty: z.number().int().min(1).max(20), modifierIds: z.array(uuid).max(30).default([]), specialRequest: z.string().max(200).nullish() })).min(1).max(30),
          note: z.string().max(300).nullish(),
        }),
        req.body,
      );
      const branch = await one<any>(`SELECT id FROM branches WHERE code=$1`, [b.branchCode.toUpperCase()]);
      if (!branch) throw notFound('Branch');
      const r = await createOrder(
        { clientOrderId: b.clientOrderId, orderType: b.orderType, language: b.language, items: b.items, note: b.note, member: { memberId: req.member!.id, accountId: req.member!.accountId, credentialId: null } },
        { branchId: branch.id, kioskId: null, source: 'MOBILE', actor: { type: 'CUSTOMER', id: req.member!.id, name: req.member!.name } },
      );
      const actor = { type: 'CUSTOMER' as const, id: req.member!.id, name: req.member!.name };
      let paid: Awaited<ReturnType<typeof payOrderWithWallet>>;
      try {
        paid = await payOrderWithWallet(r.orderId, { accountId: req.member!.accountId, idempotencyKey: `mobile:${b.clientOrderId}`, actor });
      } catch (e) {
        // Wallet refused (e.g. insufficient balance): the unpaid order must not reach the kitchen.
        if (!r.duplicate) await cancelOrder(r.orderId, 'WALLET_PAYMENT_FAILED', actor, { allowPaid: false }).catch(() => {});
        throw e;
      }
      return { orderId: r.orderId, orderNumber: (await getOrderDetail(r.orderId)).order.order_number, balance: paid.balance };
    });
  });
}
