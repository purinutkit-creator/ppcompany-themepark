import crypto from 'node:crypto';
import { config } from '../config';
import { safeEqual } from '../lib/tokens';

/**
 * Payment provider adapter. Real gateways / card terminals (e.g. a bank's EDC SDK, Omise, 2C2P,
 * GB Prime Pay, Adyen terminal API) implement this interface. Card data never touches our server:
 * the terminal / gateway handles PAN + CVV and only returns masked info and a transaction id.
 */
export interface PaymentProvider {
  name: string;
  createQr?(p: { paymentId: string; amount: number; orderNumber: string }): Promise<{ qrPayload: string; providerTxnId: string }>;
  startCardCharge?(p: { paymentId: string; amount: number; orderNumber: string; terminalId?: string | null }): Promise<{ providerTxnId: string }>;
  cancel?(providerTxnId: string): Promise<void>;
}

/** Sandbox provider: results are delivered through the same signed-webhook path as a real gateway. */
export const sandboxProvider: PaymentProvider = {
  name: 'sandbox',
  async createQr({ paymentId, amount }) {
    const providerTxnId = `sbxqr_${crypto.randomBytes(8).toString('hex')}`;
    return { qrPayload: `SANDBOX-QR|${providerTxnId}|${amount.toFixed(2)}|${paymentId}`, providerTxnId };
  },
  async startCardCharge() {
    return { providerTxnId: `sbxcard_${crypto.randomBytes(8).toString('hex')}` };
  },
  async cancel() {},
};

const providers: Record<string, PaymentProvider> = { sandbox: sandboxProvider };
export function registerProvider(p: PaymentProvider) {
  providers[p.name] = p;
}
export function getProvider(name: string): PaymentProvider {
  const p = providers[name];
  if (!p) throw new Error(`Unknown payment provider: ${name}`);
  return p;
}

/** Signature header format: `t=<unix seconds>,v1=<hex hmac_sha256(secret, t + "." + rawBody)>` */
export function signWebhook(secret: string, rawBody: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

export function verifyWebhookSignature(provider: string, rawBody: string, header: string | undefined): { ok: boolean; reason?: string } {
  const secret = config.webhookSecret(provider);
  if (!secret) return { ok: false, reason: 'NO_SECRET_CONFIGURED' };
  if (!header) return { ok: false, reason: 'MISSING_SIGNATURE' };
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1) return { ok: false, reason: 'MALFORMED_SIGNATURE' };
  // Replay protection: reject stale timestamps (event ids are additionally de-duplicated in DB).
  if (Math.abs(Date.now() / 1000 - t) > config.webhookToleranceSec) return { ok: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' };
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return safeEqual(expected, parts.v1) ? { ok: true } : { ok: false, reason: 'BAD_SIGNATURE' };
}
