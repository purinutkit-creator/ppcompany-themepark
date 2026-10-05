import type { FastifyInstance } from 'fastify';
import { one, query } from '../db/pool';
import { audit } from '../lib/audit';
import { branchOf, requireStaff } from '../lib/auth';
import { forbidden, notFound } from '../lib/errors';
import { idempotent } from '../lib/idempotency';
import { money, parse, uuid, z } from '../lib/validate';
import { getOrderDetail } from '../services/orders';
import { approveVerification, handleProviderWebhook, rejectVerification, simulateProviderResult } from '../services/payments';

export default async function paymentRoutes(app: FastifyInstance) {
  // Provider callbacks need the exact raw body for HMAC verification.
  await app.register(async (hook) => {
    hook.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    hook.post('/webhook/:provider', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req) => {
      const { provider } = parse(z.object({ provider: z.string().regex(/^[a-z0-9_-]{2,30}$/) }), req.params);
      const result = await handleProviderWebhook(provider, String(req.body ?? ''), req.headers['x-signature'] as string | undefined);
      return { received: true, result };
    });
  });

  app.get('/verifications', { preHandler: requireStaff('payments.verify') }, async (req) => {
    const q = parse(z.object({ status: z.string().default('WAITING_VERIFICATION'), limit: z.coerce.number().int().max(200).default(100) }), req.query);
    const branchId = branchOf(req);
    return query<any>(
      `SELECT v.*, o.order_number, o.total, o.order_type, o.created_at AS order_created_at, o.status AS order_status, k.code AS kiosk_code,
              u.name AS decided_by_name, p.method, p.provider,
              (SELECT COALESCE(SUM(qty),0)::int FROM order_items WHERE order_id=o.id) AS item_count
         FROM payment_verifications v JOIN orders o ON o.id=v.order_id JOIN payments p ON p.id=v.payment_id
         LEFT JOIN kiosks k ON k.id=v.kiosk_id LEFT JOIN users u ON u.id=v.decided_by
        WHERE o.branch_id=$1 AND v.status = ANY($2)
          AND (v.status='WAITING_VERIFICATION' OR v.decided_at > now() - interval '24 hours')
        ORDER BY CASE WHEN v.status='WAITING_VERIFICATION' THEN 0 ELSE 1 END, v.requested_at ${q.status === 'WAITING_VERIFICATION' ? 'ASC' : 'DESC'}
        LIMIT $3`,
      [branchId, q.status.split(','), q.limit],
    );
  });

  app.get('/verifications/:id', { preHandler: requireStaff('payments.verify') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const v = await one<any>(`SELECT * FROM payment_verifications WHERE id=$1`, [id]);
    if (!v) throw notFound('Verification');
    const detail = await getOrderDetail(v.order_id);
    if (req.staff!.branchId && detail.order.branch_id !== req.staff!.branchId) throw forbidden('OTHER_BRANCH');
    return { verification: v, ...detail };
  });

  app.post('/verifications/:id/approve', { preHandler: requireStaff('payments.verify') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ paidAmount: money.nullish(), note: z.string().max(300).nullish() }), req.body ?? {});
    const v = await one<any>(`SELECT v.*, o.branch_id, o.total FROM payment_verifications v JOIN orders o ON o.id=v.order_id WHERE v.id=$1`, [id]);
    if (!v) throw notFound('Verification');
    if (req.staff!.branchId && v.branch_id !== req.staff!.branchId) throw forbidden('OTHER_BRANCH');
    const key = (req.headers['idempotency-key'] as string) || undefined;
    const r = await idempotent(`approve:${id}`, key, b, () => approveVerification(id, req.staff!, b.paidAmount ?? null));
    if (!r.alreadyPaid) {
      await audit(req, {
        action: 'PAYMENT_APPROVE', entity: 'payment_verification', entityId: id, orderId: v.order_id, branchId: v.branch_id,
        oldValue: { status: 'WAITING_VERIFICATION' }, newValue: { status: 'APPROVED', amount: v.total, paidAmount: b.paidAmount ?? v.total, note: b.note },
      });
    }
    return { ok: true, alreadyPaid: r.alreadyPaid, orderId: v.order_id };
  });

  app.post('/verifications/:id/reject', { preHandler: requireStaff('payments.verify') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ reason: z.string().min(1).max(300) }), req.body);
    const v = await one<any>(`SELECT v.*, o.branch_id, o.total FROM payment_verifications v JOIN orders o ON o.id=v.order_id WHERE v.id=$1`, [id]);
    if (!v) throw notFound('Verification');
    if (req.staff!.branchId && v.branch_id !== req.staff!.branchId) throw forbidden('OTHER_BRANCH');
    await rejectVerification(id, req.staff!, b.reason);
    await audit(req, {
      action: 'PAYMENT_REJECT', entity: 'payment_verification', entityId: id, orderId: v.order_id, branchId: v.branch_id,
      oldValue: { status: v.status }, newValue: { status: 'REJECTED', amount: v.total, reason: b.reason },
    });
    return { ok: true };
  });

  app.get('/history', { preHandler: requireStaff('payments.view') }, async (req) => {
    const q = parse(
      z.object({ from: z.string().optional(), to: z.string().optional(), method: z.string().optional(), status: z.string().optional(), limit: z.coerce.number().int().max(500).default(200) }),
      req.query,
    );
    const branchId = branchOf(req);
    return query<any>(
      `SELECT p.id, p.order_id, p.method, p.provider, p.status, p.amount, p.received_amount, p.change_amount, p.reference, p.card_brand, p.card_last4,
              p.approval_code, p.paid_at, p.created_at, o.order_number, o.payment_status, u.name AS confirmed_by_name, k.code AS kiosk_code
         FROM payments p JOIN orders o ON o.id=p.order_id LEFT JOIN users u ON u.id=p.confirmed_by LEFT JOIN kiosks k ON k.id=o.kiosk_id
        WHERE o.branch_id=$1 AND ($2::timestamptz IS NULL OR p.created_at >= $2) AND ($3::timestamptz IS NULL OR p.created_at < $3)
          AND ($4::text IS NULL OR p.method=$4) AND ($5::text IS NULL OR p.status=$5)
        ORDER BY p.created_at DESC LIMIT $6`,
      [branchId, q.from ?? null, q.to ?? null, q.method ?? null, q.status ?? null, q.limit],
    );
  });

  /** Card terminal / gateway attempts in progress (shown on the cashier sandbox terminal panel). */
  app.get('/pending-provider', { preHandler: requireStaff('payments.verify') }, async (req) =>
    query<any>(
      `SELECT p.id, p.method, p.provider, p.status, p.amount, p.created_at, o.order_number, k.code AS kiosk_code
         FROM payments p JOIN orders o ON o.id=p.order_id LEFT JOIN kiosks k ON k.id=o.kiosk_id
        WHERE o.branch_id=$1 AND p.provider_txn_id IS NOT NULL AND p.status IN ('PENDING','WAITING_CARD','PROCESSING')
        ORDER BY p.created_at DESC LIMIT 50`,
      [branchOf(req)],
    ),
  );

  /** Sandbox terminal simulator → signed webhook → normal processing path. */
  app.post('/sandbox/simulate', { preHandler: requireStaff('payments.verify') }, async (req) => {
    const b = parse(z.object({ paymentId: uuid, outcome: z.enum(['succeeded', 'failed', 'processing', 'cancelled']) }), req.body);
    const r = await simulateProviderResult(b.paymentId, b.outcome);
    await audit(req, { action: 'SANDBOX_PAYMENT_SIMULATE', entity: 'payment', entityId: b.paymentId, newValue: b });
    return r;
  });
}
