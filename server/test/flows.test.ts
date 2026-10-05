import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import './setup';
import { bootstrap, createOrder, defaults, kiosk, staff, uuid, type Ctx } from './helpers';

let ctx: Ctx;
let q: (sql: string, p?: unknown[]) => Promise<any[]>;

beforeAll(async () => {
  ctx = await bootstrap();
  q = (await import('../src/db/pool')).query;
});
afterAll(async () => {
  await ctx.app.close();
  await (await import('../src/db/pool')).pool.end();
});

async function qrOrderAwaitingVerification(items: { sku: string; qty?: number }[] = [{ sku: 'CHEESE-BURGER' }, { sku: 'COLA' }]) {
  const o = (await createOrder(ctx, items)).json();
  const pay = (await kiosk(ctx, 'POST', `/orders/${o.orderId}/payments`, { method: 'QR' })).json();
  const v = (await kiosk(ctx, 'POST', `/orders/${o.orderId}/payments/${pay.payment.id}/verify`, { customerReference: 'ref' })).json();
  return { o, pay, v };
}

describe('auth & permissions', () => {
  it('logs in with password and PIN', () => {
    expect(ctx.tokens.admin).toBeTruthy();
    expect(ctx.tokens.cashier).toBeTruthy();
  });
  it('rejects wrong PIN and blocks cashier from settings', async () => {
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { employeeCode: 'KIT001', pin: '9999' } });
    expect(bad.statusCode).toBe(401);
    const r = await staff(ctx, 'cashier', 'PUT', '/api/settings/tax', { vatRate: 10 });
    expect(r.statusCode).toBe(403);
  });
  it('rejects invalid kiosk token', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/kiosk/menu', headers: { 'x-kiosk-token': `${ctx.kioskId}.wrong` } });
    expect(r.statusCode).toBe(401);
  });
});

describe('order creation', () => {
  it('creates an order with a random 5-digit number and is idempotent on clientOrderId', async () => {
    const clientOrderId = uuid();
    const body = { clientOrderId, orderType: 'TAKE_AWAY', language: 'en', items: [{ productId: ctx.products['CHEESE-BURGER'].id, qty: 2, modifierIds: [] }] };
    const a = await kiosk(ctx, 'POST', '/orders', body);
    expect(a.statusCode).toBe(200);
    const ja = a.json();
    expect(ja.order.order_number).toMatch(/^\d{5}$/);
    expect(Number(ja.order.total)).toBe(258);
    const b = (await kiosk(ctx, 'POST', '/orders', body)).json();
    expect(b.orderId).toBe(ja.orderId);
    expect(b.duplicate).toBe(true);
  });

  it('validates required modifiers', async () => {
    const r = await kiosk(ctx, 'POST', '/orders', {
      clientOrderId: uuid(),
      orderType: 'DINE_IN',
      language: 'th',
      items: [{ productId: ctx.products['THAI-TEA'].id, qty: 1, modifierIds: [] }],
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('MODIFIER_INVALID');
  });

  it('applies combo promotion and promo code', async () => {
    const r = (await createOrder(ctx, [{ sku: 'CHEESE-BURGER' }, { sku: 'FRIES' }, { sku: 'COLA' }], { promoCode: 'welcome10' })).json();
    // 129 + 49 + (35 + 10 medium) = 223; combo base 213 -> 189 (-24) = 199; 10% code = 19.90
    expect(Number(r.order.discount)).toBeCloseTo(24 + 19.9, 2);
    const bad = await createOrder(ctx, [{ sku: 'COLA' }], { promoCode: 'NOPE' });
    expect(bad.json().error.code).toBe('INVALID_PROMO_CODE');
  });

  it('keeps active order numbers unique across many orders', async () => {
    const nums: string[] = [];
    for (let i = 0; i < 60; i++) nums.push((await createOrder(ctx, [{ sku: 'WATER' }])).json().order.order_number);
    const dupes = await q(`SELECT number FROM queue_numbers WHERE active GROUP BY branch_id, number HAVING COUNT(*) > 1`);
    expect(dupes.length).toBe(0);
    expect(new Set(nums).size).toBe(nums.length);
  });
});

describe('QR payment + slip verification', () => {
  it('notifies cashier, survives concurrent approvals and creates everything exactly once', async () => {
    const { o, pay, v } = await qrOrderAwaitingVerification();
    const amount = Number(o.order.total).toFixed(2);
    expect(pay.payment.qr_payload).toContain('A000000677010111');
    expect(pay.payment.qr_payload).toContain(`54${String(amount.length).padStart(2, '0')}${amount}`);
    expect(v.verification.status).toBe('WAITING_VERIFICATION');
    const waiting = ctx.events.find((e) => e.event === 'PAYMENT_WAITING' && e.data.orderId === o.orderId);
    expect(waiting?.rooms[0]).toContain(':cashier');

    // Six approvals at the same time (two share an idempotency key).
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        staff(ctx, 'cashier', 'POST', `/api/payments/verifications/${v.verification.id}/approve`, {}, i < 2 ? { 'idempotency-key': 'same-key' } : {}),
      ),
    );
    expect(results.filter((r) => r.statusCode === 200).length).toBeGreaterThanOrEqual(5);
    const paid = await q(`SELECT * FROM payments WHERE order_id=$1 AND status='PAID'`, [o.orderId]);
    expect(paid.length).toBe(1);
    const jobs = await q(`SELECT document_type, COUNT(*)::int AS n FROM print_jobs WHERE order_id=$1 GROUP BY 1`, [o.orderId]);
    expect(jobs.find((j) => j.document_type === 'RECEIPT')?.n).toBe(1);
    // Burger -> Hot kitchen printer, Cola -> Beverage printer: two tickets with the same order number.
    expect(jobs.find((j) => j.document_type === 'KITCHEN_TICKET')?.n).toBe(2);
    const numbers = await q(`SELECT DISTINCT order_number FROM print_jobs WHERE order_id=$1`, [o.orderId]);
    expect(numbers.length).toBe(1);
    expect((await q(`SELECT * FROM kitchen_orders WHERE order_id=$1`, [o.orderId])).length).toBe(2);
    const order = (await q(`SELECT * FROM orders WHERE id=$1`, [o.orderId]))[0];
    expect(order.status).toBe('NEW');
    expect(order.payment_status).toBe('PAID');
    const approved = ctx.events.filter((e) => e.event === 'PAYMENT_APPROVED' && e.data.orderId === o.orderId);
    expect(approved.length).toBe(1);
    expect(approved[0].rooms).toContain(`kiosk:${ctx.kioskId}`);
    const auditRows = await q(`SELECT * FROM audit_logs WHERE action='PAYMENT_APPROVE' AND order_id=$1`, [o.orderId]);
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].user_name).toBe('Somchai Cashier');
  });

  it('rejects, notifies kiosk, then allows re-verification', async () => {
    const { o, pay, v } = await qrOrderAwaitingVerification([{ sku: 'WATER' }]);
    const r = await staff(ctx, 'cashier', 'POST', `/api/payments/verifications/${v.verification.id}/reject`, { reason: 'Amount mismatch' });
    expect(r.statusCode).toBe(200);
    const ev = ctx.events.find((e) => e.event === 'PAYMENT_REJECTED' && e.data.orderId === o.orderId);
    expect(ev?.rooms).toContain(`kiosk:${ctx.kioskId}`);
    const again = (await kiosk(ctx, 'POST', `/orders/${o.orderId}/payments/${pay.payment.id}/verify`, {})).json();
    expect(again.verification.status).toBe('WAITING_VERIFICATION');
    expect(again.verification.id).not.toBe(v.verification.id);
  });
});

describe('cash payment', () => {
  it('requires enough cash, computes change and is idempotent', async () => {
    const o = (await createOrder(ctx, [{ sku: 'PAD-THAI' }])).json();
    await kiosk(ctx, 'POST', `/orders/${o.orderId}/payments`, { method: 'CASH' });
    expect((await q(`SELECT status FROM orders WHERE id=$1`, [o.orderId]))[0].status).toBe('WAITING_CASH_PAYMENT');
    const low = await staff(ctx, 'cashier', 'POST', `/api/orders/${o.orderId}/cash`, { received: 10 });
    expect(low.json().error.code).toBe('INSUFFICIENT_CASH');
    const okr = await staff(ctx, 'cashier', 'POST', `/api/orders/${o.orderId}/cash`, { received: 100 }, { 'idempotency-key': 'cash-1' });
    expect(okr.json().change).toBe(15);
    const replay = await staff(ctx, 'cashier', 'POST', `/api/orders/${o.orderId}/cash`, { received: 100 }, { 'idempotency-key': 'cash-1' });
    expect(replay.json().change).toBe(15);
    const second = await staff(ctx, 'cashier', 'POST', `/api/orders/${o.orderId}/cash`, { received: 500 });
    expect(second.json().alreadyPaid).toBe(true);
    expect((await q(`SELECT COUNT(*)::int AS n FROM payments WHERE order_id=$1 AND status='PAID'`, [o.orderId]))[0].n).toBe(1);
  });
});

describe('card payment via signed provider webhook', () => {
  it('approves through sandbox, dedupes replays and rejects bad signatures', async () => {
    const { signWebhook } = await import('../src/services/providers');
    const o = (await createOrder(ctx, [{ sku: 'NUGGETS' }])).json();
    const p = (await kiosk(ctx, 'POST', `/orders/${o.orderId}/payments`, { method: 'CARD' })).json();
    expect(p.payment.status).toBe('WAITING_CARD');
    const txn = (await q(`SELECT provider_txn_id FROM payments WHERE id=$1`, [p.payment.id]))[0].provider_txn_id;
    const body = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded', data: { provider_txn_id: txn, amount: Number(o.order.total), card_brand: 'VISA', card_last4: '4242' } });
    const post = (sig: string) =>
      ctx.app.inject({ method: 'POST', url: '/api/payments/webhook/sandbox', headers: { 'content-type': 'application/json', 'x-signature': sig }, payload: body });
    expect((await post(signWebhook('wrong', body))).statusCode).toBe(401);
    expect((await post(signWebhook('test-webhook-secret', body, Math.floor(Date.now() / 1000) - 3600))).statusCode).toBe(401);
    const sig = signWebhook('test-webhook-secret', body);
    expect((await post(sig)).statusCode).toBe(200);
    expect((await post(sig)).json().result.duplicate).toBe(true);
    const pay = (await q(`SELECT * FROM payments WHERE id=$1`, [p.payment.id]))[0];
    expect(pay.status).toBe('PAID');
    expect(pay.card_last4).toBe('4242');
  });

  it('handles declined cards', async () => {
    const o = (await createOrder(ctx, [{ sku: 'NUGGETS' }])).json();
    const p = (await kiosk(ctx, 'POST', `/orders/${o.orderId}/payments`, { method: 'CARD' })).json();
    const r = await staff(ctx, 'cashier', 'POST', '/api/payments/sandbox/simulate', { paymentId: p.payment.id, outcome: 'failed' });
    expect(r.statusCode).toBe(200);
    const ev = ctx.events.find((e) => e.event === 'PAYMENT_STATUS' && e.data.orderId === o.orderId);
    expect(ev?.data.status).toBe('DECLINED');
  });
});

describe('kitchen → queue workflow', () => {
  it('moves NEW → PREPARING → READY and releases the number on pickup', async () => {
    const { o, v } = await qrOrderAwaitingVerification([{ sku: 'BASIL-PORK-RICE' }]);
    await staff(ctx, 'cashier', 'POST', `/api/payments/verifications/${v.verification.id}/approve`, {});
    const k = (await staff(ctx, 'kitchen', 'GET', '/api/kitchen/orders')).json().orders.find((x: any) => x.order_id === o.orderId);
    expect(k.status).toBe('NEW');
    expect((await staff(ctx, 'kitchen', 'POST', `/api/kitchen/orders/${k.id}/start`)).statusCode).toBe(200);
    let board = (await ctx.app.inject({ method: 'GET', url: '/api/public/queue/BKK01' })).json().board;
    expect(board.preparing.map((x: any) => x.number)).toContain(o.order.order_number);
    await staff(ctx, 'kitchen', 'POST', `/api/kitchen/orders/${k.id}/done`);
    board = (await ctx.app.inject({ method: 'GET', url: '/api/public/queue/BKK01' })).json().board;
    expect(board.ready.map((x: any) => x.number)).toContain(o.order.order_number);
    expect(ctx.events.some((e) => e.event === 'ORDER_READY' && e.data.orderNumber === o.order.order_number && e.rooms.some((r) => r.endsWith(':queue')))).toBe(true);
    await staff(ctx, 'cashier', 'POST', `/api/orders/${o.orderId}/complete`);
    const qn = (await q(`SELECT active, status FROM queue_numbers WHERE order_id=$1`, [o.orderId]))[0];
    expect(qn).toEqual({ active: false, status: 'COMPLETED' });
    const timeline = (await staff(ctx, 'admin', 'GET', `/api/orders/${o.orderId}`)).json().events.map((e: any) => e.type);
    expect(timeline).toEqual(
      expect.arrayContaining(['ORDER_CREATED', 'PAYMENT_SELECTED', 'VERIFICATION_REQUESTED', 'PAYMENT_APPROVED', 'PAYMENT_CONFIRMED', 'KITCHEN_RECEIVED', 'PREPARING', 'READY', 'COMPLETED']),
    );
  });
});

describe('stock', () => {
  it('reserves on create, commits on payment, blocks when sold out, releases on cancel', async () => {
    const pid = ctx.products['CHOCO-PIE'].id;
    const before = (await q(`SELECT current, reserved FROM stocks WHERE product_id=$1`, [pid]))[0];
    const o = (await createOrder(ctx, [{ sku: 'CHOCO-PIE', qty: 3 }])).json();
    const mid = (await q(`SELECT current, reserved FROM stocks WHERE product_id=$1`, [pid]))[0];
    expect(mid.reserved - before.reserved).toBe(3);
    await kiosk(ctx, 'POST', `/orders/${o.orderId}/payments`, { method: 'CASH' });
    await staff(ctx, 'cashier', 'POST', `/api/orders/${o.orderId}/cash`, { received: 200 });
    const after = (await q(`SELECT current, reserved FROM stocks WHERE product_id=$1`, [pid]))[0];
    expect(after.current).toBe(before.current - 3);
    expect(after.reserved).toBe(before.reserved);
    const tooMany = await createOrder(ctx, [{ sku: 'CHOCO-PIE', qty: 99 }]);
    expect(tooMany.json().error.code).toBe('OUT_OF_STOCK');
    const c = (await createOrder(ctx, [{ sku: 'CHOCO-PIE', qty: 2 }])).json();
    await kiosk(ctx, 'POST', `/orders/${c.orderId}/cancel`);
    expect((await q(`SELECT reserved FROM stocks WHERE product_id=$1`, [pid]))[0].reserved).toBe(before.reserved);
  });
});

describe('print queue', () => {
  it('claims once, retries on failure, prints once', async () => {
    const { o, v } = await qrOrderAwaitingVerification([{ sku: 'WATER' }]);
    await staff(ctx, 'cashier', 'POST', `/api/payments/verifications/${v.verification.id}/approve`, {});
    const agent = { 'x-agent-token': ctx.agentToken };
    const jobs = (await ctx.app.inject({ method: 'GET', url: '/api/print/executor/jobs', headers: agent })).json();
    const job = jobs.find((j: any) => j.order_id === o.orderId && j.document_type === 'RECEIPT');
    expect(job).toBeTruthy();
    const claim = async () => (await ctx.app.inject({ method: 'POST', url: `/api/print/executor/jobs/${job.id}/claim`, headers: agent })).json();
    expect((await claim()).claimed).toBe(true);
    expect((await claim()).claimed).toBe(false);
    await ctx.app.inject({ method: 'POST', url: `/api/print/executor/jobs/${job.id}/result`, headers: agent, payload: { ok: false, error: 'ECONNREFUSED' } });
    expect((await q(`SELECT status FROM print_jobs WHERE id=$1`, [job.id]))[0].status).toBe('RETRYING');
    expect(ctx.events.some((e) => e.event === 'PRINTER_ERROR' && e.data.jobId === job.id && e.data.message === 'Receipt Printer Offline')).toBe(true);
    await staff(ctx, 'admin', 'POST', `/api/print/jobs/${job.id}/retry`);
    expect((await claim()).claimed).toBe(true);
    await ctx.app.inject({ method: 'POST', url: `/api/print/executor/jobs/${job.id}/result`, headers: agent, payload: { ok: true } });
    expect((await q(`SELECT status FROM print_jobs WHERE id=$1`, [job.id]))[0].status).toBe('PRINTED');
    expect((await q(`SELECT COUNT(*)::int AS n FROM print_jobs WHERE order_id=$1 AND document_type='RECEIPT'`, [o.orderId]))[0].n).toBe(1);
  });

  it('renders receipts with Thai/Chinese as raster ESC/POS', async () => {
    const { buildDoc, renderEscPos, needsRaster } = await import('@kiosk/shared');
    const job = (await q(`SELECT payload FROM print_jobs WHERE document_type='KITCHEN_TICKET' LIMIT 1`))[0];
    const doc = buildDoc(job.payload);
    expect(needsRaster(doc)).toBe(true);
    const text = await renderEscPos(doc, null, { paperWidth: 80, mode: 'TEXT' });
    expect(text[0]).toBe(0x1b);
  });
});

describe('manager PIN protected actions', () => {
  it('requires manager approval for refunds and logs the approver', async () => {
    const o = (await createOrder(ctx, [{ sku: 'COLA' }])).json();
    await kiosk(ctx, 'POST', `/orders/${o.orderId}/payments`, { method: 'CASH' });
    await staff(ctx, 'cashier', 'POST', `/api/orders/${o.orderId}/cash`, { received: 100 });
    const denied = await staff(ctx, 'cashier', 'POST', `/api/orders/${o.orderId}/refund`, { amount: 10, reason: 'cold' });
    expect(denied.json().error.code).toBe('MANAGER_PIN_REQUIRED');
    const wrong = await staff(ctx, 'cashier', 'POST', `/api/orders/${o.orderId}/refund`, { amount: 10, reason: 'cold', managerCode: 'MGR001', managerPin: '0000' });
    expect(wrong.json().error.code).toBe('MANAGER_PIN_INVALID');
    const ok = await staff(ctx, 'cashier', 'POST', `/api/orders/${o.orderId}/refund`, { amount: 10, reason: 'cold', managerCode: 'MGR001', managerPin: '2222' });
    expect(ok.statusCode).toBe(200);
    const a = (await q(`SELECT u.employee_code FROM audit_logs a JOIN users u ON u.id=a.approved_by WHERE a.action='REFUND' AND a.order_id=$1`, [o.orderId]))[0];
    expect(a.employee_code).toBe('MGR001');
    expect((await q(`SELECT payment_status FROM orders WHERE id=$1`, [o.orderId]))[0].payment_status).toBe('PARTIALLY_REFUNDED');
  });
});

describe('reports', () => {
  it('produces dashboard, JSON and CSV/XLSX exports for every report', async () => {
    const d = (await staff(ctx, 'admin', 'GET', '/api/reports/dashboard')).json();
    expect(Number(d.summary.orders)).toBeGreaterThan(0);
    const ps = await staff(ctx, 'admin', 'GET', '/api/reports/product-sales');
    expect(ps.json().rows?.length).toBeGreaterThan(0);
    const csv = await staff(ctx, 'admin', 'GET', '/api/reports/daily-sales?format=csv');
    expect(csv.headers['content-type']).toContain('text/csv');
    const xlsx = await staff(ctx, 'admin', 'GET', '/api/reports/kitchen-time?format=xlsx');
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
    for (const t of (await staff(ctx, 'admin', 'GET', '/api/reports')).json()) {
      const res = await staff(ctx, 'admin', 'GET', `/api/reports/${t}`);
      expect(res.statusCode, `${t}: ${res.body}`).toBe(200);
    }
  });
});

describe('helpers', () => {
  it('default selection satisfies required groups', () => {
    expect(defaults(ctx.products['THAI-TEA']).length).toBeGreaterThanOrEqual(2);
  });
});
