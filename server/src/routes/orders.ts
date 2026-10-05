import type { FastifyInstance, FastifyRequest } from 'fastify';
import { EVENTS, rooms } from '@kiosk/shared';
import { one, pool, query } from '../db/pool';
import { audit } from '../lib/audit';
import { branchOf, requireManagerApproval, requireStaff } from '../lib/auth';
import { conflict, forbidden, notFound } from '../lib/errors';
import { idempotent } from '../lib/idempotency';
import { publish } from '../lib/realtime';
import { managerApproval, money, parse, uuid, z } from '../lib/validate';
import { addOrderEvent, cancelOrder, completeOrder, createOrder, getOrderDetail, type Actor } from '../services/orders';
import { confirmCash, manualApprove, refundOrder } from '../services/payments';
import { reprint } from '../services/printing';

const TAB_STATUSES: Record<string, string[]> = {
  WAITING_PAYMENT: ['CREATED', 'WAITING_PAYMENT', 'WAITING_CASH_PAYMENT', 'WAITING_CARD'],
  VERIFICATION: ['WAITING_VERIFICATION'],
  PAID: ['PAID', 'CONFIRMED', 'NEW'],
  PREPARING: ['PREPARING'],
  READY: ['READY'],
  COMPLETED: ['COMPLETED'],
  CANCELLED: ['CANCELLED', 'REFUNDED'],
};

const staffActor = (req: FastifyRequest): Actor => ({ type: 'STAFF', id: req.staff!.id, name: req.staff!.name });

async function orderInBranch(req: FastifyRequest, id: string) {
  const o = await one<any>(`SELECT * FROM orders WHERE id=$1`, [id]);
  if (!o) throw notFound('Order');
  if (req.staff!.branchId && o.branch_id !== req.staff!.branchId) throw forbidden('OTHER_BRANCH');
  return o;
}

export default async function orderRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requireStaff('orders.view') }, async (req) => {
    const q = parse(
      z.object({
        tab: z.string().optional(),
        status: z.string().optional(),
        q: z.string().max(40).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        kioskId: uuid.optional(),
        method: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );
    const branchId = branchOf(req);
    const where: string[] = ['o.branch_id = $1'];
    const params: unknown[] = [branchId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.tab && TAB_STATUSES[q.tab]) add('o.status = ANY(?)', TAB_STATUSES[q.tab]);
    if (q.status) add('o.status = ANY(?)', q.status.split(','));
    if (q.q) {
      params.push(`%${q.q.replace(/[%_\\]/g, '')}%`);
      where.push(`(o.order_number LIKE $${params.length} OR o.offline_ref ILIKE $${params.length})`);
    }
    if (q.from) add('o.created_at >= ?::timestamptz', q.from);
    if (q.to) add('o.created_at < ?::timestamptz', q.to);
    if (q.kioskId) add('o.kiosk_id = ?', q.kioskId);
    if (q.method) add('o.payment_method = ?', q.method);
    // Today's orders only for live tabs unless explicitly filtered by date.
    if (q.tab && ['COMPLETED', 'CANCELLED'].includes(q.tab) && !q.from) where.push(`o.created_at > now() - interval '24 hours'`);
    params.push(q.limit, q.offset);
    const rows = await query<any>(
      `SELECT o.id, o.order_number, o.status, o.payment_status, o.payment_method, o.order_type, o.total, o.created_at, o.paid_at,
              o.offline_ref, o.source, k.code AS kiosk_code,
              (SELECT COALESCE(SUM(qty),0)::int FROM order_items WHERE order_id=o.id) AS item_count,
              (SELECT id FROM payment_verifications v WHERE v.order_id=o.id AND v.status='WAITING_VERIFICATION' LIMIT 1) AS open_verification_id
         FROM orders o LEFT JOIN kiosks k ON k.id=o.kiosk_id
        WHERE ${where.join(' AND ')}
        ORDER BY o.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const counts = await query<any>(
      `SELECT status, COUNT(*)::int AS n FROM orders WHERE branch_id=$1 AND created_at > now() - interval '24 hours' GROUP BY status`,
      [branchId],
    );
    const tabCounts = Object.fromEntries(
      Object.entries(TAB_STATUSES).map(([tab, sts]) => [tab, counts.filter((c) => sts.includes(c.status)).reduce((s, c) => s + c.n, 0)]),
    );
    return { orders: rows, tabCounts };
  });

  app.get('/:id', { preHandler: requireStaff('orders.view') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await orderInBranch(req, id);
    return getOrderDetail(id);
  });

  /** Counter order created by cashier (POS). */
  app.post('/', { preHandler: requireStaff('orders.manage') }, async (req) => {
    const b = parse(
      z.object({
        clientOrderId: uuid,
        orderType: z.enum(['DINE_IN', 'TAKE_AWAY']),
        language: z.enum(['th', 'en', 'zh']).default('th'),
        items: z.array(z.object({ productId: uuid, qty: z.number().int().min(1).max(99), modifierIds: z.array(uuid).default([]), specialRequest: z.string().max(200).nullish() })).min(1),
        promoCode: z.string().max(50).nullish(),
        note: z.string().max(300).nullish(),
      }),
      req.body,
    );
    const r = await createOrder(b as any, { branchId: branchOf(req), kioskId: null, source: 'CASHIER', actor: staffActor(req), staffId: req.staff!.id });
    return { ...r, ...(await getOrderDetail(r.orderId)) };
  });

  app.post('/:id/cash', { preHandler: requireStaff('payments.cash') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ received: money }), req.body);
    const o = await orderInBranch(req, id);
    const key = req.headers['idempotency-key'] as string | undefined;
    const r = await idempotent(`cash:${id}`, key, b, () => confirmCash(id, b.received, req.staff!));
    if (!r.alreadyPaid) {
      await audit(req, { action: 'PAYMENT_CASH', entity: 'order', entityId: id, orderId: id, newValue: { total: o.total, received: b.received, change: r.change } });
    }
    return r;
  });

  app.post('/:id/manual-payment', { preHandler: requireStaff('payments.view') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ method: z.enum(['QR', 'CASH', 'CARD', 'OTHER']), reference: z.string().max(100).nullish(), ...managerApproval }), req.body);
    const o = await orderInBranch(req, id);
    const approver = await requireManagerApproval(req, 'MANUAL_PAYMENT_APPROVAL', 'payments.manual_approve', b);
    const key = req.headers['idempotency-key'] as string | undefined;
    const r = await idempotent(`manual:${id}`, key, { method: b.method, reference: b.reference }, () => manualApprove(id, b.method, b.reference ?? null, req.staff!));
    if (!r.alreadyPaid) {
      await audit(req, { action: 'PAYMENT_MANUAL_APPROVE', entity: 'order', entityId: id, orderId: id, newValue: { method: b.method, reference: b.reference, amount: o.total }, approvedBy: approver });
    }
    return { alreadyPaid: r.alreadyPaid, orderId: id };
  });

  app.post('/:id/cancel', { preHandler: requireStaff('orders.cancel') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ reason: z.string().min(1).max(300), ...managerApproval }), req.body);
    const o = await orderInBranch(req, id);
    let approver: string | null = null;
    if (o.payment_status === 'PAID') approver = await requireManagerApproval(req, 'CANCEL_PAID_ORDER', 'orders.cancel_paid', b);
    await cancelOrder(id, b.reason, staffActor(req), { allowPaid: o.payment_status === 'PAID' });
    await audit(req, { action: o.payment_status === 'PAID' ? 'CANCEL_PAID_ORDER' : 'CANCEL_ORDER', entity: 'order', entityId: id, orderId: id, oldValue: { status: o.status, total: o.total }, newValue: { reason: b.reason }, approvedBy: approver });
    return { ok: true };
  });

  app.post('/:id/void', { preHandler: requireStaff() }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ reason: z.string().min(1).max(300), ...managerApproval }), req.body);
    const o = await orderInBranch(req, id);
    const approver = await requireManagerApproval(req, 'VOID', 'orders.void', b);
    await cancelOrder(id, `VOID: ${b.reason}`, staffActor(req), { allowPaid: true });
    await audit(req, { action: 'VOID', entity: 'order', entityId: id, orderId: id, oldValue: { status: o.status, total: o.total, payment: o.payment_status }, newValue: { reason: b.reason }, approvedBy: approver });
    return { ok: true };
  });

  app.post('/:id/refund', { preHandler: requireStaff() }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ amount: money, reason: z.string().min(1).max(300), ...managerApproval }), req.body);
    const o = await orderInBranch(req, id);
    const approver = await requireManagerApproval(req, 'REFUND', 'payments.refund', b);
    const key = req.headers['idempotency-key'] as string | undefined;
    const r = await idempotent(`refund:${id}`, key, { amount: b.amount, reason: b.reason }, () => refundOrder(id, b.amount, b.reason, req.staff!, approver));
    await audit(req, { action: 'REFUND', entity: 'order', entityId: id, orderId: id, oldValue: { total: o.total, refunded: o.refunded_amount }, newValue: { amount: b.amount, reason: b.reason }, approvedBy: approver });
    return { ok: true, full: r.full };
  });

  app.post('/:id/complete', { preHandler: requireStaff('orders.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await orderInBranch(req, id);
    await completeOrder(id, staffActor(req));
    return { ok: true };
  });

  app.post('/:id/reprint', { preHandler: requireStaff() }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ kind: z.enum(['RECEIPT', 'KITCHEN_TICKET']), printerId: uuid.nullish(), ...managerApproval }), req.body);
    await orderInBranch(req, id);
    const approver = await requireManagerApproval(req, 'REPRINT', 'orders.reprint', b);
    const jobs = await reprint(id, b.kind, req.staff!.id, b.printerId ?? null);
    await audit(req, { action: 'REPRINT', entity: 'order', entityId: id, orderId: id, newValue: { kind: b.kind, jobs: jobs.length }, approvedBy: approver });
    return { jobs };
  });

  /** Call (or re-call) a READY number on the queue display. */
  app.post('/:id/call', { preHandler: requireStaff('queue.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const o = await orderInBranch(req, id);
    const q = await one<any>(
      `UPDATE queue_numbers SET call_count = call_count + 1, last_called_at = now() WHERE order_id=$1 AND active RETURNING number, call_count`,
      [id],
    );
    if (!q) throw conflict('NOT_IN_QUEUE', 'Order is not in the active queue');
    await addOrderEvent(pool, id, 'QUEUE_CALLED', { count: q.call_count }, staffActor(req));
    await publish(rooms.branchQueue(o.branch_id), EVENTS.QUEUE_CALL, { orderId: id, orderNumber: q.number, language: o.language });
    return { ok: true, callCount: q.call_count };
  });
}
