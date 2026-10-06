import crypto from 'node:crypto';
import { EVENTS, rooms } from '@kiosk/shared';
import { config } from '../../config';
import { one, query, tx } from '../../db/pool';
import { badRequest, conflict } from '../../lib/errors';
import { Outbox } from '../../lib/realtime';
import { signWebhook } from '../providers';
import { confirmSalePayment, syncBookingPayment } from './sales';

/**
 * Gateway / card-terminal events for PARK sale payments (same signed webhook endpoint as the restaurant
 * module: /api/payments/webhook/:provider). Card data never reaches us — only masked info + approval code.
 */
export async function handleSaleWebhookEvent(provider: string, body: any) {
  const d = body.data ?? {};
  const pay = await one<any>(`SELECT * FROM sale_payments WHERE provider=$1 AND provider_txn_id=$2`, [provider, d.provider_txn_id]);
  if (!pay) return null;
  if (body.type === 'payment.succeeded') {
    if (d.amount != null && Math.abs(Number(d.amount) - Number(pay.amount)) > 0.005) throw conflict('AMOUNT_MISMATCH');
    return confirmSalePayment(pay.id, {
      providerTxnId: d.provider_txn_id, cardBrand: d.card_brand ?? null, cardLast4: d.card_last4 ?? null, approvalCode: d.approval_code ?? null, reference: d.reference ?? null,
    }, { type: 'PROVIDER', name: provider });
  }
  if (['payment.processing', 'payment.failed', 'payment.cancelled'].includes(body.type)) {
    const status = body.type === 'payment.processing' ? 'PROCESSING' : body.type === 'payment.failed' ? 'DECLINED' : 'CANCELLED';
    const out = new Outbox();
    await tx(async (c) => {
      const cur = await one<any>(`SELECT * FROM sale_payments WHERE id=$1 FOR UPDATE`, [pay.id], c);
      if (!['PENDING', 'WAITING_CARD', 'PROCESSING'].includes(cur.status)) return;
      await query(`UPDATE sale_payments SET status=$2 WHERE id=$1`, [pay.id, status], c);
      await syncBookingPayment(c, pay.sale_id, out);
      out.add([rooms.sale(pay.sale_id)], EVENTS.SALE_UPDATED, { saleId: pay.sale_id, paymentId: pay.id, paymentStatus: status, reason: d.reason ?? null });
    });
    await out.flush();
    return { status };
  }
  return { ignored: true };
}

/** Sandbox gateway: produces a properly signed webhook for a park payment and processes it. */
export async function simulateSaleProviderResult(paymentId: string, outcome: 'succeeded' | 'failed' | 'processing' | 'cancelled') {
  const p = await one<any>(`SELECT * FROM sale_payments WHERE id=$1`, [paymentId]);
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
  const { handleProviderWebhook } = await import('../payments');
  return handleProviderWebhook('sandbox', body, signWebhook(secret, body));
}
