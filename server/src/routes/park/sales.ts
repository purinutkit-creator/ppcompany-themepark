import type { FastifyInstance } from 'fastify';
import { one, pool, query } from '../../db/pool';
import { audit } from '../../lib/audit';
import { branchOf, requireAnyStaff, requireDeviceOrStaffPerm, requireManagerApproval, requireStaff } from '../../lib/auth';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { idempotent } from '../../lib/idempotency';
import { Outbox } from '../../lib/realtime';
import { managerApproval, parse, uuid, z } from '../../lib/validate';
import { tx } from '../../db/pool';
import {
  addPayment, approveSaleVerification, cancelPaymentAttempt, cancelSale, confirmSalePayment, createSale, getSaleDetail, quoteSale, refundSale,
  rejectSaleVerification, type SaleCreateInput,
} from '../../services/park/sales';
import { printSaleDocuments, saleReceiptData } from '../../services/park/print';
import { simulateSaleProviderResult } from '../../services/park/providers';
import { parkSettings } from '../../services/park/common';
import { anyActor, deviceIdOf, idemKey, lang, saleLine, staffActor, staffMethod } from './util';

const saleSchema = z.object({
  channel: z.enum(['COUNTER', 'POS', 'KIOSK', 'RIDE', 'LOCKER']).default('COUNTER'),
  storeId: uuid.nullish(),
  credentialId: uuid.nullish(),
  credentialCode: z.string().max(300).nullish(),
  memberId: uuid.nullish(),
  customer: z.object({ name: z.string().max(120).nullish(), phone: z.string().max(30).nullish(), email: z.string().max(160).nullish() }).default({}),
  lines: z.array(saleLine).min(1).max(100),
  codes: z.array(z.string().max(40)).max(5).default([]),
  visitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  clientRef: z.string().max(80).nullish(),
  language: lang.default('th'),
  printerId: uuid.nullish(),
  note: z.string().max(300).nullish(),
  manualDiscount: z.object({ amount: z.coerce.number().positive().max(1_000_000), reason: z.string().min(1).max(200) }).nullish(),
  /** Offline-queued sale synced later (only allowed for actions permitted offline). */
  offline: z.object({ createdAt: z.string().max(40), action: z.string().max(40) }).nullish(),
  ...managerApproval,
});

export default async function parkSalesRoutes(app: FastifyInstance) {
  const toInput = (req: any, b: z.infer<typeof saleSchema>): SaleCreateInput => ({
    branchId: branchOf(req), channel: req.kiosk ? 'KIOSK' : b.channel, storeId: b.storeId ?? null, credentialId: b.credentialId ?? null, credentialPayload: b.credentialCode ?? null,
    memberId: b.memberId ?? null, customer: b.customer, lines: b.lines as any, codes: b.codes, visitDate: b.visitDate ?? null, clientRef: b.clientRef ?? null,
    language: b.language, staffId: req.staff?.id ?? null, deviceId: deviceIdOf(req), printerId: b.printerId ?? req.kiosk?.receipt_printer_id ?? (req.device?.config?.printerId as string | undefined) ?? null, note: b.note ?? null,
    manualDiscount: b.manualDiscount ?? null, expiresMinutes: req.staff ? 60 : null,
  });

  app.post('/quote', { preHandler: requireDeviceOrStaffPerm('tickets.sell', 'pos.sell', 'wallet.topup', 'lockers.operate', 'rides.operate', 'kiosk' as any) }, async (req) => {
    const b = parse(saleSchema, req.body);
    return quoteSale(toInput(req, b));
  });

  /** Create a sale at a counter / POS / kiosk / ride / locker station. */
  app.post('/', { preHandler: requireDeviceOrStaffPerm('tickets.sell', 'pos.sell', 'wallet.topup', 'lockers.operate', 'rides.operate', 'kiosk' as any) }, async (req) => {
    const b = parse(saleSchema, req.body);
    if (b.manualDiscount) {
      if (!req.staff) throw forbidden('STAFF_ONLY');
      await requireManagerApproval(req, 'DISCOUNT', 'pos.discount', b, { reason: b.manualDiscount.reason, entity: 'sale' });
    }
    if (b.offline) {
      const s = await parkSettings(branchOf(req));
      if (!s.offline.allow[b.offline.action]) throw forbidden('OFFLINE_NOT_ALLOWED', `${b.offline.action} is not allowed offline`);
    }
    if (b.lines.some((l) => l.type === 'TOPUP') && req.staff && !req.staff.permissions.has('wallet.topup')) throw forbidden('PERMISSION_DENIED', 'Missing permission: wallet.topup');
    const r = await createSale(toInput(req, b));
    if (!r.duplicate && req.staff) await audit(req, { action: 'SALE_CREATE', entity: 'sale', entityId: r.sale.id, newValue: { saleNo: r.sale.sale_no, total: r.sale.total, lines: b.lines.length, offline: b.offline ?? undefined } });
    return getSaleDetail(pool, r.sale.id);
  });

  app.get('/', { preHandler: requireStaff('transactions.view') }, async (req) => {
    const q = parse(z.object({ q: z.string().max(60).optional(), status: z.string().max(40).optional(), from: z.string().optional(), to: z.string().optional(), limit: z.coerce.number().int().max(500).default(100) }), req.query);
    return query(
      `SELECT s.id, s.sale_no, s.channel, s.kind, s.status, s.total, s.paid_amount, s.refunded_amount, s.customer_name, s.created_at, s.paid_at, s.fulfil_status,
              m.member_no, u.name AS created_by_name, st.name AS store_name, bk.booking_no
         FROM sales s LEFT JOIN members m ON m.id=s.member_id LEFT JOIN users u ON u.id=s.created_by LEFT JOIN stores st ON st.id=s.store_id LEFT JOIN bookings bk ON bk.sale_id=s.id
        WHERE s.branch_id=$1 AND ($2::text IS NULL OR s.sale_no ILIKE '%'||$2||'%' OR s.customer_name ILIKE '%'||$2||'%' OR m.member_no ILIKE '%'||$2||'%' OR bk.booking_no ILIKE '%'||$2||'%')
          AND ($3::text IS NULL OR s.status = ANY(string_to_array($3, ','))) AND ($4::timestamptz IS NULL OR s.created_at >= $4) AND ($5::timestamptz IS NULL OR s.created_at < $5)
        ORDER BY s.created_at DESC LIMIT $6`,
      [branchOf(req), q.q ?? null, q.status ?? null, q.from ?? null, q.to ?? null, q.limit],
    );
  });

  app.get('/:id', { preHandler: requireDeviceOrStaffPerm('transactions.view', 'tickets.sell', 'pos.sell', 'rides.operate', 'lockers.operate', 'kiosk' as any) }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const d = await getSaleDetail(pool, id);
    if (d.sale.branch_id !== branchOf(req)) throw forbidden('OTHER_BRANCH');
    return { ...d, payments: d.payments.map((p: any) => (req.staff ? p : { ...p, provider_txn_id: undefined })) };
  });

  /** Add a payment (split payments: call repeatedly until fully paid). */
  app.post('/:id/payments', { preHandler: requireDeviceOrStaffPerm('tickets.sell', 'pos.sell', 'wallet.topup', 'lockers.operate', 'rides.operate', 'kiosk' as any) }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(
      z.object({
        method: staffMethod, amount: z.coerce.number().positive().nullish(), received: z.coerce.number().min(0).nullish(), credentialCode: z.string().max(300).nullish(),
        credentialId: uuid.nullish(), reference: z.string().max(100).nullish(), cardBrand: z.string().max(20).nullish(), cardLast4: z.string().regex(/^\d{4}$/).nullish(),
        approvalCode: z.string().max(30).nullish(), confirmNow: z.boolean().default(false),
      }),
      req.body,
    );
    if (!req.staff && ['CASH', 'COMP', 'VOUCHER'].includes(b.method) && b.confirmNow) throw forbidden('STAFF_ONLY');
    if (b.method === 'COMP' && !req.staff?.permissions.has('pos.discount')) throw forbidden('PERMISSION_DENIED', 'Missing permission: pos.discount');
    const sale = await one<any>(`SELECT branch_id FROM sales WHERE id=$1`, [id]);
    if (!sale) throw notFound('Sale');
    if (sale.branch_id !== branchOf(req)) throw forbidden('OTHER_BRANCH');
    const r = await addPayment(
      id,
      { method: b.method, amount: b.amount ?? null, received: b.received ?? null, credentialPayload: b.credentialCode ?? null, credentialId: b.credentialId ?? null, reference: b.reference ?? null,
        cardBrand: b.cardBrand ?? null, cardLast4: b.cardLast4 ?? null, approvalCode: b.approvalCode ?? null, confirmNow: b.confirmNow, idempotencyKey: idemKey(req) },
      { actor: anyActor(req), staffId: req.staff?.id ?? null, deviceId: deviceIdOf(req) },
    );
    if (req.staff && !r.replay && r.payment.status === 'PAID') await audit(req, { action: `PARK_PAYMENT_${b.method}`, entity: 'sale', entityId: id, newValue: { amount: r.payment.amount, received: b.received, paymentNo: r.payment.payment_no } });
    return { ...r, payment: req.staff ? r.payment : { ...r.payment, provider_txn_id: undefined } };
  });

  /** Staff confirms a cash payment requested from a kiosk / ride scanner (WAITING_CASH). */
  app.post('/:id/payments/:paymentId/confirm-cash', { preHandler: requireStaff('payments.cash') }, async (req) => {
    const p = parse(z.object({ id: uuid, paymentId: uuid }), req.params);
    const b = parse(z.object({ received: z.coerce.number().min(0) }), req.body);
    const key = idemKey(req);
    const r = await idempotent(`park-cash:${p.paymentId}`, key ?? undefined, b, () => confirmSalePayment(p.paymentId, { received: b.received, staffId: req.staff!.id }, staffActor(req)));
    await audit(req, { action: 'PARK_CASH_CONFIRM', entity: 'sale', entityId: p.id, newValue: { paymentId: p.paymentId, received: b.received } });
    return r;
  });

  /** Counter EDC / external terminal approved — staff records the approval (manual confirmation, audited). */
  app.post('/:id/payments/:paymentId/confirm', { preHandler: requireStaff('payments.verify') }, async (req) => {
    const p = parse(z.object({ id: uuid, paymentId: uuid }), req.params);
    const b = parse(z.object({ reference: z.string().max(100).nullish(), approvalCode: z.string().max(30).nullish(), cardLast4: z.string().regex(/^\d{4}$/).nullish(), ...managerApproval }), req.body ?? {});
    const approver = await requireManagerApproval(req, 'MANUAL_PAYMENT_APPROVAL', 'payments.manual_approve', b, { entity: 'sale', entityId: p.id });
    const r = await confirmSalePayment(p.paymentId, { reference: b.reference ?? null, approvalCode: b.approvalCode ?? null, cardLast4: b.cardLast4 ?? null, staffId: req.staff!.id }, staffActor(req));
    await audit(req, { action: 'PARK_PAYMENT_MANUAL_CONFIRM', entity: 'sale', entityId: p.id, newValue: { paymentId: p.paymentId, ...b, managerPin: undefined }, approvedBy: approver });
    return r;
  });

  app.post('/:id/payments/:paymentId/cancel', { preHandler: requireDeviceOrStaffPerm('tickets.sell', 'pos.sell', 'rides.operate', 'lockers.operate', 'wallet.topup', 'kiosk' as any) }, async (req) => {
    const p = parse(z.object({ id: uuid, paymentId: uuid }), req.params);
    return cancelPaymentAttempt(p.id, p.paymentId);
  });

  /** Sandbox terminal simulator (counter / kiosk card payment testing without real hardware). */
  app.post('/:id/payments/:paymentId/sandbox', { preHandler: requireDeviceOrStaffPerm('tickets.sell', 'pos.sell', 'rides.operate', 'kiosk' as any) }, async (req) => {
    const p = parse(z.object({ id: uuid, paymentId: uuid }), req.params);
    const b = parse(z.object({ outcome: z.enum(['succeeded', 'failed', 'cancelled', 'processing']) }), req.body);
    return simulateSaleProviderResult(p.paymentId, b.outcome);
  });

  app.post('/:id/cancel', { preHandler: requireDeviceOrStaffPerm('tickets.sell', 'pos.sell', 'rides.operate', 'lockers.operate', 'wallet.topup', 'kiosk' as any) }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ reason: z.string().min(1).max(200).default('CANCELLED') }), req.body ?? {});
    const r = await cancelSale(id, b.reason, anyActor(req));
    if (req.staff) await audit(req, { action: 'SALE_CANCEL', entity: 'sale', entityId: id, newValue: b });
    return r;
  });

  /** Refund / void (full or partial, by items or amount). Permission + manager PIN per settings. */
  app.post('/:id/refund', { preHandler: requireStaff() }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(
      z.object({
        amount: z.coerce.number().positive().nullish(), items: z.array(z.object({ saleItemId: uuid, qty: z.number().int().min(1) })).max(100).optional(),
        reason: z.string().min(1).max(300), refundMethod: z.enum(['ORIGINAL', 'CASH', 'WALLET']).nullish(), override: z.boolean().default(false), void: z.boolean().default(false), ...managerApproval,
      }),
      req.body,
    );
    const sale = await one<any>(`SELECT * FROM sales WHERE id=$1`, [id]);
    if (!sale) throw notFound('Sale');
    if (sale.branch_id !== branchOf(req)) throw forbidden('OTHER_BRANCH');
    const approver = b.void
      ? await requireManagerApproval(req, 'VOID', 'sales.void', b, { reason: b.reason, reference: sale.sale_no, entity: 'sale', entityId: id })
      : await requireManagerApproval(req, 'REFUND', 'payments.refund', b, { reason: b.reason, reference: sale.sale_no, entity: 'sale', entityId: id });
    if (b.override && !req.staff!.permissions.has('tickets.override')) throw forbidden('PERMISSION_DENIED', 'Missing permission: tickets.override');
    const key = idemKey(req);
    const r = await idempotent(`park-refund:${id}`, key ?? undefined, { ...b, managerPin: undefined }, () =>
      refundSale(id, { amount: b.amount ?? null, items: b.items, reason: b.void ? `VOID: ${b.reason}` : b.reason, refundMethod: b.refundMethod ?? null, override: b.override }, req.staff!, approver),
    );
    await audit(req, { action: b.void ? 'SALE_VOID' : 'SALE_REFUND', entity: 'sale', entityId: id, oldValue: { total: sale.total, refunded: sale.refunded_amount }, newValue: { amount: r.amount, items: b.items, reason: b.reason, override: b.override }, approvedBy: approver });
    return r;
  });

  app.post('/:id/reprint', { preHandler: requireAnyStaff('tickets.sell', 'pos.sell', 'transactions.view') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ only: z.enum(['RECEIPT', 'TICKETS']).nullish(), printerId: uuid.nullish(), ...managerApproval }), req.body ?? {});
    const approver = await requireManagerApproval(req, 'REPRINT', 'orders.reprint', b, { entity: 'sale', entityId: id });
    const out = new Outbox();
    const jobs = await tx(async (c) => {
      const sale = await one<any>(`SELECT * FROM sales WHERE id=$1`, [id], c);
      if (!sale) throw notFound('Sale');
      if (!['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(sale.status)) throw badRequest('SALE_NOT_PAID');
      return printSaleDocuments(c, { ...sale, printer_id: b.printerId ?? sale.printer_id }, out, { reprint: true, requestedBy: req.staff!.id, only: b.only ?? undefined });
    });
    await out.flush();
    await audit(req, { action: 'SALE_REPRINT', entity: 'sale', entityId: id, newValue: { jobs: jobs.length, only: b.only }, approvedBy: approver });
    return { jobs };
  });

  /** Receipt data for browser / A4 / customer-display rendering. */
  app.get('/:id/receipt', { preHandler: requireDeviceOrStaffPerm('transactions.view', 'tickets.sell', 'pos.sell', 'kiosk' as any) }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return saleReceiptData(pool, id);
  });

  // ---------------------------------------------------------------- payment verification center (park)
  app.get('/verifications/list', { preHandler: requireStaff('payments.verify') }, async (req) => {
    const q = parse(z.object({ status: z.string().default('WAITING_VERIFICATION') }), req.query);
    return query(
      `SELECT v.*, s.sale_no, s.kind, s.channel, s.total, s.customer_name AS sale_customer, s.phone, s.email, bk.booking_no, bk.visit_date::text AS visit_date, bk.guests,
              p.payment_no, p.qr_payload IS NOT NULL AS had_qr, u.name AS decided_by_name
         FROM payment_verification_requests v JOIN sales s ON s.id=v.sale_id JOIN sale_payments p ON p.id=v.sale_payment_id
         LEFT JOIN bookings bk ON bk.id=v.booking_id LEFT JOIN users u ON u.id=v.decided_by
        WHERE v.branch_id=$1 AND v.status = ANY(string_to_array($2, ',')) AND (v.status='WAITING_VERIFICATION' OR v.decided_at > now() - interval '24 hours')
        ORDER BY CASE WHEN v.status='WAITING_VERIFICATION' THEN 0 ELSE 1 END, v.requested_at`,
      [branchOf(req), q.status],
    );
  });
  app.post('/verifications/:vid/approve', { preHandler: requireStaff('payments.verify') }, async (req) => {
    const { vid } = parse(z.object({ vid: uuid }), req.params);
    const r = await approveSaleVerification(vid, req.staff!);
    await audit(req, { action: 'PARK_PAYMENT_APPROVE', entity: 'payment_verification', entityId: vid, newValue: r });
    return r;
  });
  app.post('/verifications/:vid/reject', { preHandler: requireStaff('payments.verify') }, async (req) => {
    const { vid } = parse(z.object({ vid: uuid }), req.params);
    const b = parse(z.object({ reason: z.string().min(1).max(300), requestNewSlip: z.boolean().default(false) }), req.body);
    const r = await rejectSaleVerification(vid, req.staff!, b.reason, b.requestNewSlip);
    await audit(req, { action: b.requestNewSlip ? 'PARK_PAYMENT_NEW_SLIP' : 'PARK_PAYMENT_REJECT', entity: 'payment_verification', entityId: vid, newValue: b });
    return r;
  });
}
