import crypto from 'node:crypto';
import { buildPromptPayPayload, EVENTS, rooms, type PaymentMethod } from '@kiosk/shared';
import { one, pool, query, tx, type Tx } from '../db/pool';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { Outbox } from '../lib/realtime';
import { getSettings } from '../lib/settings';
import { addOrderEvent, broadcastOrder, getOrderDetail, releaseQueue, type Actor } from './orders';
import { commitStock } from './stock';
import { sendToKitchen } from './kitchen';
import { createOrderPrintJobs } from './printing';
import { getProvider, signWebhook, verifyWebhookSignature } from './providers';
import { config } from '../config';
import { announcePoints, computeEarn, pointsPost } from './park/points';
import { announceWallet, walletPost } from './park/wallet';

const OPEN_PAYMENT = ['PENDING', 'WAITING_VERIFICATION', 'WAITING_CASH', 'WAITING_CARD', 'PROCESSING'];
const PAYABLE_STATUSES = ['CREATED', 'WAITING_PAYMENT', 'WAITING_CASH_PAYMENT', 'WAITING_CARD', 'WAITING_VERIFICATION'];

async function lockOrder(c: Tx, orderId: string) {
  const o = await one<any>(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId], c);
  if (!o) throw notFound('Order');
  return o;
}

export interface ConfirmInput {
  orderId: string;
  paymentId?: string | null;
  method: PaymentMethod;
  provider?: string;
  received?: number | null;
  reference?: string | null;
  providerTxnId?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  approvalCode?: string | null;
  verificationId?: string | null;
  paidAmount?: number | null;
  actor: Actor;
  staffId?: string | null;
}

/**
 * THE critical payment transaction. Must be called inside `tx`. Steps:
 * lock order → bail if already PAID → mark payment PAID → order PAID/CONFIRMED → queue number →
 * commit stock → kitchen tickets → print jobs. Realtime events are queued on `out` and only
 * published after COMMIT. Every write is idempotent, so replays create no duplicates.
 */
export async function confirmPaymentTx(c: Tx, p: ConfirmInput, out: Outbox): Promise<{ alreadyPaid: boolean; order: any }> {
  const order = await lockOrder(c, p.orderId);
  if (order.payment_status === 'PAID') return { alreadyPaid: true, order };
  if (['CANCELLED', 'REFUNDED', 'COMPLETED'].includes(order.status)) throw conflict('ORDER_NOT_PAYABLE', `Order is ${order.status}`);

  const total = Number(order.total);
  let payment = p.paymentId
    ? await one<any>(`SELECT * FROM payments WHERE id=$1 AND order_id=$2 FOR UPDATE`, [p.paymentId, order.id], c)
    : null;
  if (p.paymentId && !payment) throw notFound('Payment');
  if (payment && !OPEN_PAYMENT.includes(payment.status) && payment.status !== 'REJECTED' && payment.status !== 'APPROVED') {
    throw conflict('PAYMENT_NOT_OPEN', `Payment is ${payment.status}`);
  }
  if (!payment) {
    payment = await one<any>(
      `INSERT INTO payments (order_id, method, provider, status, amount, created_by) VALUES ($1,$2,$3,'PENDING',$4,$5) RETURNING *`,
      [order.id, p.method, p.provider ?? p.method, total, p.staffId ?? null],
      c,
    );
  }
  const received = p.received ?? null;
  const change = received != null ? Math.round((received - total) * 100) / 100 : null;
  await query(
    `UPDATE payments SET status='PAID', paid_at=now(), received_amount=COALESCE($2, received_amount), change_amount=COALESCE($3, change_amount),
        reference=COALESCE($4, reference), provider_txn_id=COALESCE($5, provider_txn_id), card_brand=COALESCE($6, card_brand),
        card_last4=COALESCE($7, card_last4), approval_code=COALESCE($8, approval_code), confirmed_by=$9 WHERE id=$1`,
    [payment.id, received, change, p.reference ?? null, p.providerTxnId ?? null, p.cardBrand ?? null, p.cardLast4 ?? null, p.approvalCode ?? null, p.staffId ?? null],
    c,
  );
  await query(`UPDATE payments SET status='CANCELLED' WHERE order_id=$1 AND id<>$2 AND status = ANY($3)`, [order.id, payment.id, OPEN_PAYMENT], c);
  if (p.verificationId) {
    await query(
      `UPDATE payment_verifications SET status='APPROVED', decided_by=$2, decided_at=now(), paid_amount=COALESCE($3, paid_amount) WHERE id=$1`,
      [p.verificationId, p.staffId ?? null, p.paidAmount ?? null],
      c,
    );
  }
  await query(`UPDATE payment_verifications SET status='CANCELLED', decided_at=now() WHERE order_id=$1 AND status='WAITING_VERIFICATION'`, [order.id], c);
  await query(
    `UPDATE orders SET payment_status='PAID', payment_method=$2, status='CONFIRMED', paid_at=now(), confirmed_at=now(), version=version+1 WHERE id=$1`,
    [order.id, p.method],
    c,
  );
  await addOrderEvent(c, order.id, 'PAYMENT_APPROVED', { method: p.method, amount: total, paymentId: payment.id, received, change }, p.actor);
  await addOrderEvent(c, order.id, 'PAYMENT_CONFIRMED', { paymentId: payment.id }, { type: 'SYSTEM' });
  await addOrderEvent(c, order.id, 'ORDER_CONFIRMED', {}, { type: 'SYSTEM' });

  // Queue number: reserved at creation; re-allocate only if it was somehow released.
  const q = await one<any>(`SELECT number FROM queue_numbers WHERE order_id=$1 AND active`, [order.id], c);
  if (!q) {
    const clash = await one(`SELECT 1 FROM queue_numbers WHERE branch_id=$1 AND number=$2 AND active`, [order.branch_id, order.order_number], c);
    if (clash) throw conflict('QUEUE_NUMBER_CONFLICT', 'Order number was reused; cancel and re-order');
    await query(
      `INSERT INTO queue_numbers (branch_id, order_id, number) VALUES ($1,$2,$3)
       ON CONFLICT (order_id) DO UPDATE SET active=true, status='RESERVED', released_at=NULL`,
      [order.branch_id, order.id, order.order_number],
      c,
    );
  }
  await commitStock(c, order.branch_id, order.id, out);
  const settings = await getSettings(c);
  await sendToKitchen(c, order, out);
  await createOrderPrintJobs(c, order, out, settings);
  const promos = ((order.applied_promotions as any[]) ?? []).filter((x) => /^[0-9a-f-]{36}$/i.test(String(x.promotionId)));
  if (promos.length) {
    await query(`UPDATE promotions SET usage_count = usage_count + 1 WHERE id = ANY($1)`, [promos.map((x) => x.promotionId)], c);
  }
  // Park members earn FOOD points on restaurant orders (points paid by wallet still earn; refunds reverse).
  const fresh = await one<any>(`SELECT member_id, branch_id, order_number, total FROM orders WHERE id=$1`, [order.id], c);
  if (fresh?.member_id) await earnOrderPoints(c, order.id, fresh, out);

  const kioskRoom = order.kiosk_id ? [rooms.kiosk(order.kiosk_id)] : [];
  out.add([...kioskRoom, rooms.branchCashier(order.branch_id), rooms.branchAdmin(order.branch_id)], EVENTS.PAYMENT_APPROVED, {
    orderId: order.id,
    orderNumber: order.order_number,
    paymentId: payment.id,
    method: p.method,
    amount: total,
    received,
    change,
  });
  await broadcastOrder(out, order.id, c, EVENTS.ORDER_CONFIRMED);
  return { alreadyPaid: false, order };
}

async function earnOrderPoints(c: Tx, orderId: string, o: any, out: Outbox) {
  const pts = await computeEarn(c, o.member_id, { FOOD: Number(o.total) });
  if (pts <= 0) return;
  await pointsPost(c, { memberId: o.member_id, type: 'EARN', points: pts, reference: `ORDER ${o.order_number}`, refType: 'ORDER', refId: orderId, branchId: o.branch_id, idempotencyKey: `earn:order:${orderId}` });
  await query(`UPDATE orders SET points_earned=$2 WHERE id=$1`, [orderId, pts], c);
  await query(`UPDATE members SET total_spend = total_spend + $2 WHERE id=$1`, [o.member_id, o.total], c);
  await announcePoints(out, c, o.member_id);
}

export async function confirmPayment(p: ConfirmInput) {
  const out = new Outbox();
  const r = await tx((c) => confirmPaymentTx(c, p, out));
  await out.flush();
  return r;
}

/** Customer picks a payment method on the kiosk. Any previous open payment is cancelled. */
export async function startPayment(orderId: string, method: PaymentMethod, actor: Actor, allowedMethods?: string[]) {
  const settings = await getSettings();
  const methods = settings.payment.methods as Record<string, boolean>;
  if (!methods[method] || (allowedMethods && !allowedMethods.includes(method))) throw badRequest('PAYMENT_METHOD_DISABLED');
  const out = new Outbox();
  const r = await tx(async (c) => {
    const o = await lockOrder(c, orderId);
    if (o.payment_status === 'PAID') throw conflict('ALREADY_PAID', 'Order already paid');
    if (!PAYABLE_STATUSES.includes(o.status)) throw conflict('ORDER_NOT_PAYABLE', `Order is ${o.status}`);
    const open = await query<any>(`SELECT * FROM payments WHERE order_id=$1 AND status = ANY($2)`, [orderId, OPEN_PAYMENT], c);
    for (const op of open) {
      if (op.provider_txn_id && op.method !== 'CASH') await getProvider(op.provider).cancel?.(op.provider_txn_id).catch(() => {});
    }
    await query(`UPDATE payments SET status='CANCELLED' WHERE order_id=$1 AND status = ANY($2)`, [orderId, OPEN_PAYMENT], c);
    await query(`UPDATE payment_verifications SET status='CANCELLED', decided_at=now() WHERE order_id=$1 AND status='WAITING_VERIFICATION'`, [orderId], c);

    const total = Number(o.total);
    const paymentId = crypto.randomUUID();
    let status = 'PENDING';
    let provider: string = method;
    let qrPayload: string | null = null;
    let providerTxnId: string | null = null;
    let expiresAt: Date | null = null;
    let orderStatus = 'WAITING_PAYMENT';

    if (method === 'QR') {
      const qr = settings.payment.qr;
      expiresAt = new Date(Date.now() + qr.countdownSec * 1000);
      provider = qr.mode;
      if (qr.mode === 'PROMPTPAY_STATIC') qrPayload = buildPromptPayPayload(qr.promptpayId);
      else if (qr.mode === 'PROMPTPAY_DYNAMIC') qrPayload = buildPromptPayPayload(qr.promptpayId, total);
      else {
        const prov = getProvider(qr.gatewayProvider);
        provider = prov.name;
        const res = await prov.createQr!({ paymentId, amount: total, orderNumber: o.order_number });
        qrPayload = res.qrPayload;
        providerTxnId = res.providerTxnId;
      }
    } else if (method === 'CASH') {
      status = 'WAITING_CASH';
      orderStatus = 'WAITING_CASH_PAYMENT';
    } else if (method === 'CARD') {
      const prov = getProvider(settings.payment.card.provider);
      provider = prov.name;
      status = 'WAITING_CARD';
      orderStatus = 'WAITING_CARD';
      expiresAt = new Date(Date.now() + settings.payment.card.timeoutSec * 1000);
      const res = await prov.startCardCharge!({ paymentId, amount: total, orderNumber: o.order_number });
      providerTxnId = res.providerTxnId;
    }
    const payment = await one<any>(
      `INSERT INTO payments (id, order_id, method, provider, status, amount, qr_payload, provider_txn_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, method, provider, status, amount, qr_payload, expires_at, provider_txn_id`,
      [paymentId, orderId, method, provider, status, total, qrPayload, providerTxnId, expiresAt],
      c,
    );
    await query(`UPDATE orders SET status=$2, payment_status='PENDING', payment_method=$3, version=version+1 WHERE id=$1`, [orderId, orderStatus, method], c);
    await addOrderEvent(c, orderId, 'PAYMENT_SELECTED', { method, provider, amount: total }, actor);
    await broadcastOrder(out, orderId, c);
    if (method === 'CASH' || method === 'OTHER') {
      out.add([rooms.branchCashier(o.branch_id)], EVENTS.PAYMENT_WAITING, {
        kind: method, orderId, orderNumber: o.order_number, amount: total, kioskId: o.kiosk_id, createdAt: o.created_at,
      });
    }
    return { payment, order: { id: o.id, order_number: o.order_number, total } };
  });
  await out.flush();
  return r;
}

/** Kiosk "ตรวจสอบการชำระเงิน": create a WAITING_VERIFICATION request for cashiers. Idempotent. */
export async function requestVerification(
  orderId: string,
  paymentId: string,
  info: { slipUrl?: string | null; customerReference?: string | null; kioskId?: string | null },
  actor: Actor,
) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const o = await lockOrder(c, orderId);
    if (o.payment_status === 'PAID') return { alreadyPaid: true, verification: null };
    if (!PAYABLE_STATUSES.includes(o.status)) throw conflict('ORDER_NOT_PAYABLE', `Order is ${o.status}`);
    const pay = await one<any>(`SELECT * FROM payments WHERE id=$1 AND order_id=$2 FOR UPDATE`, [paymentId, orderId], c);
    if (!pay || pay.method !== 'QR') throw badRequest('INVALID_PAYMENT');
    if (!['PENDING', 'WAITING_VERIFICATION', 'REJECTED'].includes(pay.status)) throw conflict('PAYMENT_NOT_OPEN', `Payment is ${pay.status}`);
    const existing = await one<any>(`SELECT * FROM payment_verifications WHERE order_id=$1 AND status='WAITING_VERIFICATION'`, [orderId], c);
    if (existing) {
      if (info.slipUrl && !existing.slip_url) await query(`UPDATE payment_verifications SET slip_url=$2 WHERE id=$1`, [existing.id, info.slipUrl], c);
      return { alreadyPaid: false, verification: existing };
    }
    const v = await one<any>(
      `INSERT INTO payment_verifications (payment_id, order_id, kiosk_id, expected_amount, slip_url, customer_reference)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [paymentId, orderId, info.kioskId ?? o.kiosk_id, o.total, info.slipUrl ?? null, info.customerReference?.slice(0, 100) ?? null],
      c,
    );
    await query(`UPDATE payments SET status='WAITING_VERIFICATION' WHERE id=$1`, [paymentId], c);
    await query(`UPDATE orders SET status='WAITING_VERIFICATION', version=version+1 WHERE id=$1`, [orderId], c);
    await addOrderEvent(c, orderId, 'VERIFICATION_REQUESTED', { verificationId: v.id, slip: !!info.slipUrl }, actor);
    const k = o.kiosk_id ? await one<any>(`SELECT code FROM kiosks WHERE id=$1`, [o.kiosk_id], c) : null;
    out.add([rooms.branchCashier(o.branch_id), rooms.branchAdmin(o.branch_id)], EVENTS.PAYMENT_WAITING, {
      kind: 'VERIFICATION',
      verificationId: v.id,
      orderId,
      orderNumber: o.order_number,
      amount: Number(o.total),
      kioskCode: k?.code ?? null,
      createdAt: o.created_at,
      slipUrl: v.slip_url,
    });
    await broadcastOrder(out, orderId, c);
    return { alreadyPaid: false, verification: v };
  });
  await out.flush();
  return r;
}

export async function approveVerification(verificationId: string, staff: { id: string; name: string }, paidAmount?: number | null) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const v = await one<any>(`SELECT * FROM payment_verifications WHERE id=$1 FOR UPDATE`, [verificationId], c);
    if (!v) throw notFound('Verification');
    if (v.status === 'APPROVED') return { alreadyPaid: true, orderId: v.order_id, verification: v };
    if (v.status !== 'WAITING_VERIFICATION') throw conflict('VERIFICATION_CLOSED', `Verification is ${v.status}`);
    const res = await confirmPaymentTx(
      c,
      { orderId: v.order_id, paymentId: v.payment_id, method: 'QR', verificationId, paidAmount: paidAmount ?? Number(v.expected_amount), actor: { type: 'STAFF', id: staff.id, name: staff.name }, staffId: staff.id },
      out,
    );
    return { alreadyPaid: res.alreadyPaid, orderId: v.order_id, verification: v };
  });
  await out.flush();
  return r;
}

export async function rejectVerification(verificationId: string, staff: { id: string; name: string }, reason: string) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const v = await one<any>(`SELECT * FROM payment_verifications WHERE id=$1 FOR UPDATE`, [verificationId], c);
    if (!v) throw notFound('Verification');
    if (v.status === 'REJECTED') return v;
    if (v.status !== 'WAITING_VERIFICATION') throw conflict('VERIFICATION_CLOSED', `Verification is ${v.status}`);
    const o = await lockOrder(c, v.order_id);
    await query(`UPDATE payment_verifications SET status='REJECTED', decided_by=$2, decided_at=now(), reason=$3 WHERE id=$1`, [verificationId, staff.id, reason], c);
    await query(`UPDATE payments SET status='REJECTED' WHERE id=$1 AND status='WAITING_VERIFICATION'`, [v.payment_id], c);
    await query(`UPDATE orders SET status='WAITING_PAYMENT', version=version+1 WHERE id=$1 AND status='WAITING_VERIFICATION'`, [v.order_id], c);
    await addOrderEvent(c, v.order_id, 'PAYMENT_REJECTED', { verificationId, reason }, { type: 'STAFF', id: staff.id, name: staff.name });
    const targets = [rooms.branchCashier(o.branch_id), rooms.branchAdmin(o.branch_id)];
    if (o.kiosk_id) targets.push(rooms.kiosk(o.kiosk_id));
    out.add(targets, EVENTS.PAYMENT_REJECTED, { orderId: v.order_id, orderNumber: o.order_number, verificationId, paymentId: v.payment_id, reason });
    await broadcastOrder(out, v.order_id, c);
    return { ...v, status: 'REJECTED', order: o };
  });
  await out.flush();
  return r;
}

export async function confirmCash(orderId: string, received: number, staff: { id: string; name: string }) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const o = await lockOrder(c, orderId);
    if (o.payment_status === 'PAID') return { alreadyPaid: true, order: o, change: null };
    if (received + 1e-9 < Number(o.total)) throw badRequest('INSUFFICIENT_CASH', 'Received amount is less than total');
    const pay = await one<any>(`SELECT id FROM payments WHERE order_id=$1 AND method='CASH' AND status='WAITING_CASH' ORDER BY created_at DESC LIMIT 1`, [orderId], c);
    const res = await confirmPaymentTx(
      c,
      { orderId, paymentId: pay?.id ?? null, method: 'CASH', provider: 'CASH', received, actor: { type: 'STAFF', id: staff.id, name: staff.name }, staffId: staff.id },
      out,
    );
    // Cash drawer accounting: attach to the cashier's open shift (if any).
    const shift = await one<any>(`SELECT id FROM shifts WHERE user_id=$1 AND status='OPEN'`, [staff.id], c);
    if (shift && !res.alreadyPaid) {
      await query(`UPDATE orders SET shift_id=$2 WHERE id=$1`, [orderId, shift.id], c);
      await query(`INSERT INTO cash_movements (shift_id, type, amount, ref_type, ref_id, user_id) VALUES ($1,'CASH_ORDER',$2,'ORDER',$3,$4) ON CONFLICT DO NOTHING`, [shift.id, o.total, orderId, staff.id], c);
    }
    return { ...res, change: Math.round((received - Number(o.total)) * 100) / 100 };
  });
  await out.flush();
  return r;
}

/** Manual approval (e.g. OTHER method, offline EDC terminal). Permission + manager PIN checked by caller. */
export async function manualApprove(orderId: string, method: PaymentMethod, reference: string | null, staff: { id: string; name: string }) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const pay = await one<any>(
      `SELECT id FROM payments WHERE order_id=$1 AND method=$2 AND status = ANY($3) ORDER BY created_at DESC LIMIT 1`,
      [orderId, method, [...OPEN_PAYMENT, 'REJECTED']],
      c,
    );
    return confirmPaymentTx(
      c,
      { orderId, paymentId: pay?.id ?? null, method, provider: `MANUAL_${method}`, reference, actor: { type: 'STAFF', id: staff.id, name: staff.name }, staffId: staff.id },
      out,
    );
  });
  await out.flush();
  return r;
}

/** Customer cancels a card / QR attempt on the kiosk (order stays open for another method). */
export async function cancelPaymentAttempt(orderId: string, paymentId: string, actor: Actor) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const o = await lockOrder(c, orderId);
    const p = await one<any>(`SELECT * FROM payments WHERE id=$1 AND order_id=$2 FOR UPDATE`, [paymentId, orderId], c);
    if (!p) throw notFound('Payment');
    if (p.status === 'PAID') throw conflict('ALREADY_PAID');
    if (!OPEN_PAYMENT.includes(p.status) && p.status !== 'REJECTED') return p;
    if (p.provider_txn_id) await getProvider(p.provider).cancel?.(p.provider_txn_id).catch(() => {});
    await query(`UPDATE payments SET status='CANCELLED' WHERE id=$1`, [paymentId], c);
    await query(`UPDATE payment_verifications SET status='CANCELLED', decided_at=now() WHERE payment_id=$1 AND status='WAITING_VERIFICATION'`, [paymentId], c);
    if (o.payment_status !== 'PAID') await query(`UPDATE orders SET status='WAITING_PAYMENT', payment_status='UNPAID' WHERE id=$1`, [orderId], c);
    await addOrderEvent(c, orderId, 'PAYMENT_CANCELLED', { paymentId, method: p.method }, actor);
    await broadcastOrder(out, orderId, c);
    return { ...p, status: 'CANCELLED' };
  });
  await out.flush();
  return r;
}

export async function refundOrder(orderId: string, amount: number, reason: string, staff: { id: string; name: string }, approvedBy: string | null) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const o = await lockOrder(c, orderId);
    if (!['PAID', 'PARTIALLY_REFUNDED'].includes(o.payment_status)) throw conflict('ORDER_NOT_PAID', 'Only paid orders can be refunded');
    const remaining = Math.round((Number(o.total) - Number(o.refunded_amount)) * 100) / 100;
    if (amount <= 0 || amount > remaining + 1e-9) throw badRequest('INVALID_REFUND_AMOUNT', `Refundable amount is ${remaining}`);
    const pay = await one<any>(`SELECT id, method, wallet_ledger_id FROM payments WHERE order_id=$1 AND status='PAID'`, [orderId], c);
    let ledgerId: string | null = null;
    if (pay?.method === 'WALLET' && pay.wallet_ledger_id) {
      // Wallet payments are refunded back to the same wallet (ledger REFUND).
      const led0 = await one<any>(`SELECT account_id FROM wallet_ledger WHERE id=$1`, [pay.wallet_ledger_id], c);
      const led = await walletPost(c, { accountId: led0.account_id, type: 'REFUND', amount, branchId: o.branch_id, reference: `ORDER ${o.order_number}`, refType: 'ORDER', refId: orderId, staffId: staff.id, note: reason, idempotencyKey: `order-refund:${orderId}:${o.refunded_amount}:${amount}` });
      ledgerId = led.entry.id;
      await announceWallet(out, c, led0.account_id, o.branch_id, { reason: 'REFUND' });
    }
    await query(
      `INSERT INTO refunds (order_id, payment_id, amount, reason, method, created_by, approved_by, branch_id, refund_method, wallet_ledger_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [orderId, pay?.id ?? null, amount, reason, pay?.method ?? null, staff.id, approvedBy, o.branch_id, pay?.method === 'WALLET' ? 'WALLET' : pay?.method ?? null, ledgerId],
      c,
    );
    if (o.member_id && Number(o.points_earned) > 0) {
      const back = Math.floor((Number(o.points_earned) * amount) / Math.max(0.01, Number(o.total)));
      if (back > 0) await pointsPost(c, { memberId: o.member_id, type: 'REVERSE', points: -back, reference: `ORDER ${o.order_number}`, refType: 'ORDER', refId: orderId, clamp: true, idempotencyKey: `unearn:order:${orderId}:${o.refunded_amount}:${amount}` });
    }
    const full = Math.abs(amount - remaining) < 0.005;
    await query(
      `UPDATE orders SET refunded_amount = refunded_amount + $2, payment_status = $3, status = CASE WHEN $3='REFUNDED' THEN 'REFUNDED' ELSE status END,
         version=version+1 WHERE id=$1`,
      [orderId, amount, full ? 'REFUNDED' : 'PARTIALLY_REFUNDED'],
      c,
    );
    if (full) {
      // Keep the PAID payment row (uniqueness guard) but record the refund on it via reference.
      await query(`UPDATE kitchen_orders SET status='CANCELLED' WHERE order_id=$1 AND status IN ('NEW','PREPARING')`, [orderId], c);
      await releaseQueue(c, orderId, 'CANCELLED');
    }
    await addOrderEvent(c, orderId, full ? 'REFUNDED' : 'PARTIALLY_REFUNDED', { amount, reason, approvedBy }, { type: 'STAFF', id: staff.id, name: staff.name });
    await broadcastOrder(out, orderId, c);
    if (full) out.add([rooms.branchQueue(o.branch_id), rooms.branchKitchen(o.branch_id)], EVENTS.QUEUE_UPDATED, { branchId: o.branch_id });
    return { order: o, amount, full };
  });
  await out.flush();
  return r;
}

/** Signed provider callback (card terminal / gateway QR). De-duplicated by provider event id. */
export async function handleProviderWebhook(provider: string, rawBody: string, signature: string | undefined) {
  const sig = verifyWebhookSignature(provider, rawBody, signature);
  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw badRequest('INVALID_JSON');
  }
  // Invalid signatures are rejected before touching the event table (so forged ids cannot block real events).
  if (!sig.ok) throw new AppError(401, 'INVALID_SIGNATURE', sig.reason);
  const eventId = String(body.id ?? '');
  if (!eventId) throw badRequest('MISSING_EVENT_ID');
  const ins = await one(
    `INSERT INTO payment_webhook_events (provider, event_id, signature_valid, payload) VALUES ($1,$2,true,$3) ON CONFLICT DO NOTHING RETURNING id`,
    [provider, eventId, JSON.stringify(body)],
  );
  if (!ins) return { duplicate: true };
  const d = body.data ?? {};
  const payment = await one<any>(`SELECT * FROM payments WHERE provider=$1 AND provider_txn_id=$2`, [provider, d.provider_txn_id]);
  if (!payment) {
    // Park sale payment (tickets, top-up, membership, ride add-on…)?
    const { handleSaleWebhookEvent } = await import('./park/providers');
    let parkResult: unknown;
    try {
      parkResult = await handleSaleWebhookEvent(provider, body);
    } catch (e) {
      // Unexpected failure: forget the event so the provider's retry is processed (business errors stay recorded).
      if (!(e instanceof AppError)) await query(`DELETE FROM payment_webhook_events WHERE provider=$1 AND event_id=$2`, [provider, eventId]);
      throw e;
    }
    if (!parkResult) throw notFound('Payment');
    await query(`UPDATE payment_webhook_events SET processed_at=now() WHERE provider=$1 AND event_id=$2`, [provider, eventId]);
    return parkResult;
  }
  const actor: Actor = { type: 'PROVIDER', name: provider };
  let result: unknown = { ok: true };
  if (body.type === 'payment.succeeded') {
    if (d.amount != null && Math.abs(Number(d.amount) - Number(payment.amount)) > 0.005) {
      await addOrderEvent(pool, payment.order_id, 'PAYMENT_AMOUNT_MISMATCH', { expected: payment.amount, got: d.amount }, actor);
      throw conflict('AMOUNT_MISMATCH');
    }
    const last4 = d.card_last4 && /^[0-9]{4}$/.test(String(d.card_last4)) ? String(d.card_last4) : null;
    try {
      result = await confirmPayment({
        orderId: payment.order_id, paymentId: payment.id, method: payment.method, provider, providerTxnId: d.provider_txn_id,
        cardBrand: d.card_brand ?? null, cardLast4: last4, approvalCode: d.approval_code ?? null, reference: d.reference ?? null, actor,
      });
    } catch (e: any) {
      if (e?.code === 'ORDER_NOT_PAYABLE') {
        // Money captured for an order that was cancelled/expired: flag for refund, never silently drop.
        const o = await one<any>(`SELECT branch_id, order_number FROM orders WHERE id=$1`, [payment.order_id]);
        await query(`UPDATE payments SET status='APPROVED', provider_txn_id=$2 WHERE id=$1`, [payment.id, d.provider_txn_id]);
        await addOrderEvent(pool, payment.order_id, 'LATE_PAYMENT_NEEDS_REFUND', { amount: d.amount }, actor);
        const out = new Outbox();
        out.add([rooms.branchCashier(o.branch_id), rooms.branchAdmin(o.branch_id)], EVENTS.STAFF_CALL, { orderId: payment.order_id, orderNumber: o.order_number, reason: 'LATE_PAYMENT_NEEDS_REFUND' });
        await out.flush();
        result = { lateRefundNeeded: true };
      } else throw e;
    }
  } else if (['payment.processing', 'payment.failed', 'payment.cancelled'].includes(body.type)) {
    const status = body.type === 'payment.processing' ? 'PROCESSING' : body.type === 'payment.failed' ? 'DECLINED' : 'CANCELLED';
    const out = new Outbox();
    await tx(async (c) => {
      const o = await lockOrder(c, payment.order_id);
      const cur = await one<any>(`SELECT status FROM payments WHERE id=$1 FOR UPDATE`, [payment.id], c);
      if (!OPEN_PAYMENT.includes(cur.status)) return;
      await query(`UPDATE payments SET status=$2 WHERE id=$1`, [payment.id, status], c);
      if (status !== 'PROCESSING' && o.payment_status !== 'PAID') await query(`UPDATE orders SET status='WAITING_PAYMENT', payment_status='UNPAID' WHERE id=$1`, [o.id], c);
      await addOrderEvent(c, o.id, `CARD_${status}`, { reason: d.reason ?? null }, actor);
      const targets = [rooms.branchCashier(o.branch_id)];
      if (o.kiosk_id) targets.push(rooms.kiosk(o.kiosk_id));
      out.add(targets, EVENTS.PAYMENT_STATUS, { orderId: o.id, paymentId: payment.id, method: payment.method, status, reason: d.reason ?? null });
    });
    await out.flush();
  }
  await query(`UPDATE payment_webhook_events SET processed_at=now() WHERE provider=$1 AND event_id=$2`, [provider, eventId]);
  return result;
}

/** Sandbox terminal / gateway simulator: produces a properly signed webhook and processes it. */
export async function simulateProviderResult(paymentId: string, outcome: 'succeeded' | 'failed' | 'processing' | 'cancelled') {
  const p = await one<any>(`SELECT * FROM payments WHERE id=$1`, [paymentId]);
  if (!p || p.provider !== 'sandbox' || !p.provider_txn_id) throw badRequest('NOT_SANDBOX_PAYMENT');
  const secret = config.webhookSecret('sandbox');
  if (!secret) throw conflict('NO_SANDBOX_SECRET', 'PAYMENT_WEBHOOK_SECRET_SANDBOX is not configured');
  const body = JSON.stringify({
    id: `evt_${crypto.randomBytes(8).toString('hex')}`,
    type: `payment.${outcome}`,
    data: {
      provider_txn_id: p.provider_txn_id,
      amount: Number(p.amount),
      card_brand: p.method === 'CARD' ? 'VISA' : null,
      card_last4: p.method === 'CARD' ? '4242' : null,
      approval_code: outcome === 'succeeded' ? String(crypto.randomInt(100000, 999999)) : null,
      reason: outcome === 'failed' ? 'DECLINED_BY_ISSUER' : null,
    },
  });
  return handleProviderWebhook('sandbox', body, signWebhook(secret, body));
}

export { getOrderDetail };

/**
 * Pay a restaurant order with the park wallet (wristband / card / app QR). Ledger debit + PAID + kitchen
 * tickets happen in ONE transaction, so a double tap can never charge twice (idempotency key + order lock).
 */
export async function payOrderWithWallet(
  orderId: string,
  a: { credentialPayload?: string | null; accountId?: string | null; idempotencyKey?: string | null; staff?: { id: string; name: string } | null; actor: Actor; allowStaticDigital?: boolean },
) {
  const { resolveScan, effectiveStatus } = await import('./park/credentials');
  const out = new Outbox();
  const r = await tx(async (c) => {
    const o = await lockOrder(c, orderId);
    if (o.payment_status === 'PAID') return { alreadyPaid: true, order: o, balance: null };
    if (!PAYABLE_STATUSES.includes(o.status)) throw conflict('ORDER_NOT_PAYABLE', `Order is ${o.status}`);
    let accountId = a.accountId ?? null;
    let cred: any = null;
    if (!accountId) {
      const res = await resolveScan(a.credentialPayload ?? '', c, { allowStaticDigital: !!a.allowStaticDigital });
      if (!res.ok) throw conflict(res.reason!, 'Card / QR not valid');
      cred = res.credential;
      if ((await effectiveStatus(c, cred)) !== 'ACTIVE') throw conflict(`CARD_${cred.status}`, `Card is ${cred.status}`);
      accountId = cred.account_id;
    }
    if (!accountId) throw conflict('NO_WALLET', 'This card has no wallet');
    const member = await one<any>(`SELECT id FROM members WHERE account_id=$1`, [accountId], c);
    const led = await walletPost(c, {
      accountId, type: 'PAYMENT', amount: -Number(o.total), branchId: o.branch_id, credentialId: cred?.id ?? null, memberId: member?.id ?? null,
      reference: `ORDER ${o.order_number}`, refType: 'ORDER', refId: o.id, storeId: o.store_id, staffId: a.staff?.id ?? null,
      idempotencyKey: a.idempotencyKey ? `order-pay:${a.idempotencyKey}` : `order-pay:${o.id}`,
    });
    await query(`UPDATE orders SET account_id=COALESCE(account_id,$2), member_id=COALESCE(member_id,$3), credential_id=COALESCE(credential_id,$4) WHERE id=$1`, [o.id, accountId, member?.id ?? null, cred?.id ?? null], c);
    await query(`UPDATE payments SET status='CANCELLED' WHERE order_id=$1 AND status = ANY($2)`, [o.id, OPEN_PAYMENT], c);
    const pay = await one<any>(
      `INSERT INTO payments (order_id, method, provider, status, amount, created_by, wallet_ledger_id) VALUES ($1,'WALLET','WALLET','PENDING',$2,$3,$4) RETURNING id`,
      [o.id, o.total, a.staff?.id ?? null, led.entry.id],
      c,
    );
    const res = await confirmPaymentTx(c, { orderId: o.id, paymentId: pay.id, method: 'WALLET' as any, provider: 'WALLET', reference: led.entry.txn_no, actor: a.actor, staffId: a.staff?.id ?? null }, out);
    await announceWallet(out, c, accountId, o.branch_id, { reason: 'PAYMENT', orderNumber: o.order_number });
    const w = await one<any>(`SELECT balance FROM wallet_accounts WHERE account_id=$1`, [accountId], c);
    return { alreadyPaid: res.alreadyPaid, order: res.order, balance: Number(w.balance), ledger: led.entry };
  });
  await out.flush();
  return r;
}
