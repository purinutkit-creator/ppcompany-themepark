import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import './setup';
import { bootstrap, device, publicReq, sleep, staff, uuid, waitFor, type Ctx } from './helpers';

let ctx: Ctx;
let q: (sql: string, p?: unknown[]) => Promise<any[]>;
let pkgs: Record<string, any> = {};
let tts: Record<string, string> = {};
const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10); // Asia/Bangkok
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const gateId = (n: number) => ctx.park.parkIds.gates[`GATE-${String(n).padStart(2, '0')}`];
const spId = (ride: string) => ctx.park.parkIds.scanPoints[`sp:${ride}`];
const priceOf = (pkg: any, tt: string) => pkg.prices.find((p: any) => p.ticket_type_code === tt);

beforeAll(async () => {
  ctx = await bootstrap();
  q = (await import('../src/db/pool')).query;
  const cat = (await publicReq(ctx, 'GET', `/api/park/public/branches/BKK01/catalog?date=${plusDays(today(), 1)}`)).json();
  pkgs = Object.fromEntries(cat.packages.map((p: any) => [p.code, p]));
  tts = Object.fromEntries((await q(`SELECT id, code FROM ticket_types`)).map((r: any) => [r.code, r.id]));
});
afterAll(async () => {
  await ctx.app.close();
  await (await import('../src/db/pool')).pool.end();
});

/** Walk-in counter sale paid in cash by the ticket cashier (opens a shift first). */
async function counterTickets(lines: { code: string; tt?: string; qty?: number }[], extra: Record<string, unknown> = {}) {
  const sale = (await staff(ctx, 'ticket', 'POST', '/api/park/sales', {
    channel: 'COUNTER', visitDate: today(),
    lines: lines.map((l) => ({ type: 'PACKAGE', refId: pkgs[l.code].id, ticketTypeId: l.tt ? tts[l.tt] : null, qty: l.qty ?? 1 })),
    ...extra,
  })).json();
  expect(sale.sale?.id, JSON.stringify(sale)).toBeTruthy();
  const pay = await staff(ctx, 'ticket', 'POST', `/api/park/sales/${sale.sale.id}/payments`, { method: 'CASH', received: Number(sale.sale.total) + 100 });
  expect(pay.statusCode, pay.body).toBe(200);
  const d = (await staff(ctx, 'ticket', 'GET', `/api/park/sales/${sale.sale.id}`)).json();
  return d;
}
const scan = (gate: number, code: string, direction?: 'ENTRY' | 'EXIT') =>
  device(ctx, `GATE-${String(gate).padStart(2, '0')}-DISPLAY`, 'POST', `/api/park/gates/${gateId(gate)}/scan`, { code, source: 'CAMERA', direction });
const gateState = async (n: number) => (await q(`SELECT state FROM gates WHERE id=$1`, [gateId(n)]))[0].state;
const waitIdle = (n: number) => waitFor(async () => ['IDLE', 'DENIED'].includes(await gateState(n)), 5000);

describe('shift & counter sale', () => {
  it('requires an open shift for cash, then sells tickets with cash and prints customer + staff receipts', async () => {
    const s = (await staff(ctx, 'ticket', 'POST', '/api/park/sales', { channel: 'COUNTER', visitDate: today(), lines: [{ type: 'PACKAGE', refId: pkgs['DAY-BASIC'].id, ticketTypeId: tts.ADULT, qty: 1 }] })).json();
    const noShift = await staff(ctx, 'ticket', 'POST', `/api/park/sales/${s.sale.id}/payments`, { method: 'CASH', received: 1000 });
    expect(noShift.json().error.code).toBe('SHIFT_REQUIRED');
    const open = await staff(ctx, 'ticket', 'POST', '/api/park/shifts/open', { openingCash: 2000, terminal: 'COUNTER' });
    expect(open.statusCode).toBe(200);
    const pay = (await staff(ctx, 'ticket', 'POST', `/api/park/sales/${s.sale.id}/payments`, { method: 'CASH', received: 1000 })).json();
    expect(pay.completed).toBe(true);
    expect(Number(pay.payment.change_amount)).toBe(1000 - Number(s.sale.total));
    const d = (await staff(ctx, 'ticket', 'GET', `/api/park/sales/${s.sale.id}`)).json();
    expect(d.sale.status).toBe('PAID');
    expect(d.tickets).toHaveLength(1);
    expect(d.tickets[0].status).toBe('ACTIVE');
    const titles = d.prints.map((p: any) => p.title).join('|');
    expect(titles).toContain('customer copy');
    expect(titles).toContain('staff copy');
    expect(titles).toContain('Ticket TK-');
    const ents = await q(`SELECT * FROM ride_entitlements WHERE ticket_id=$1`, [d.tickets[0].id]);
    expect(ents.length).toBe(4); // basic pass: 4 rides
  });

  it('supports split payment (cash + EDC card) and bundles (family = 4 tickets)', async () => {
    const s = (await staff(ctx, 'ticket', 'POST', '/api/park/sales', { channel: 'COUNTER', visitDate: today(), lines: [{ type: 'PACKAGE', refId: pkgs.FAMILY.id, qty: 1 }] })).json();
    const total = Number(s.sale.total);
    const p1 = (await staff(ctx, 'ticket', 'POST', `/api/park/sales/${s.sale.id}/payments`, { method: 'CASH', amount: 1000, received: 1000 })).json();
    expect(p1.completed).toBe(false);
    expect(p1.sale.status).toBe('PENDING_PAYMENT');
    const p2 = (await staff(ctx, 'ticket', 'POST', `/api/park/sales/${s.sale.id}/payments`, { method: 'CARD', confirmNow: true, approvalCode: '123456', cardLast4: '4242' })).json();
    expect(p2.completed).toBe(true);
    expect(Number(p2.payment.amount)).toBe(total - 1000);
    const tickets = await q(`SELECT tt.code FROM tickets t JOIN ticket_types tt ON tt.id=t.ticket_type_id WHERE t.sale_id=$1 ORDER BY tt.code`, [s.sale.id]);
    expect(tickets.map((t) => t.code)).toEqual(['ADULT', 'ADULT', 'CHILD', 'CHILD']);
  });
});

describe('online booking → payment verification → gate', () => {
  let booking: any;
  it('guest books online with PromptPay and the counter approves the slip (realtime to the booking page)', async () => {
    const r = await publicReq(ctx, 'POST', '/api/park/public/bookings', {
      branchCode: 'BKK01', visitDate: today(), payMode: 'PAY_NOW', language: 'en',
      items: [{ packageId: pkgs['DAY-UNLIMITED'].id, ticketTypeId: tts.ADULT, qty: 1 }],
      customer: { name: 'Somsri Guest', phone: '0899999999', email: 'somsri@example.com' },
    });
    expect(r.statusCode, r.body).toBe(200);
    booking = r.json();
    expect(booking.booking.booking_no).toMatch(/^BK-\d{6}-\d{5}$/);
    expect(booking.booking.status).toBe('PENDING_PAYMENT');
    expect(booking.tickets[0].status).toBe('UNPAID');
    const hdr = { 'x-booking-token': booking.accessToken };
    const pay = (await publicReq(ctx, 'POST', `/api/park/public/bookings/${booking.booking.booking_no}/payments`, { method: 'PROMPTPAY' }, hdr)).json();
    expect(pay.payment.qr_payload).toMatch(/^000201/);
    // Scanning the unpaid ticket at a gate is refused.
    const early = (await scan(1, booking.tickets[0].qr)).json();
    expect(early.result).toBe('DENIED');
    expect(early.reasonCode).toBe('NOT_PAID');
    await waitIdle(1);
    const v = (await publicReq(ctx, 'POST', `/api/park/public/bookings/${booking.booking.booking_no}/payments/${pay.payment.id}/verify`, { reference: 'SLIP123' }, hdr)).json();
    expect(v.verification.status).toBe('WAITING_VERIFICATION');
    expect(ctx.events.some((e) => e.event === 'PARK_PAYMENT_WAITING' && e.data.verificationId === v.verification.id)).toBe(true);
    const list = (await staff(ctx, 'cashier', 'GET', '/api/park/sales/verifications/list')).json();
    expect(list.some((x: any) => x.id === v.verification.id)).toBe(true);
    const before = ctx.events.length;
    const ok = await staff(ctx, 'cashier', 'POST', `/api/park/sales/verifications/${v.verification.id}/approve`);
    expect(ok.statusCode, ok.body).toBe(200);
    const evs = ctx.events.slice(before);
    expect(evs.some((e) => e.event === 'BOOKING_UPDATED' && e.data.status === 'CONFIRMED')).toBe(true);
    expect(evs.some((e) => e.event === 'SALE_PAID' && e.rooms.some((r) => r.startsWith('sale:')))).toBe(true);
    const d = (await publicReq(ctx, 'GET', `/api/park/public/bookings/${booking.booking.booking_no}`, undefined, hdr)).json();
    expect(d.booking.status).toBe('CONFIRMED');
    expect(d.tickets[0].status).toBe('ACTIVE');
    // Double approval is harmless.
    const again = await staff(ctx, 'cashier', 'POST', `/api/park/sales/verifications/${v.verification.id}/approve`);
    expect(again.json().alreadyPaid).toBe(true);
    booking = d;
  });

  it('AUTO gate grants, opens, confirms passage and updates occupancy', async () => {
    const before = (await staff(ctx, 'admin', 'GET', '/api/park/occupancy')).json().inside;
    const r = (await scan(1, booking.tickets[0].qr)).json();
    expect(r.result).toBe('GRANTED');
    expect(r.checks.filter((c: any) => !c.ok)).toEqual([]);
    for (const k of ['TICKET_FOUND', 'PAYMENT', 'VISIT_DATE', 'ACTIVE', 'BRANCH', 'NOT_INSIDE', 'NOT_USED']) expect(r.checks.some((c: any) => c.key === k && c.ok)).toBe(true);
    await waitFor(async () => (await q(`SELECT presence FROM tickets WHERE ticket_no=$1`, [booking.tickets[0].ticket_no]))[0].presence === 'INSIDE');
    await waitIdle(1);
    const after = (await staff(ctx, 'admin', 'GET', '/api/park/occupancy')).json();
    expect(after.inside).toBe(before + 1);
    const log = await q(`SELECT * FROM entry_logs WHERE ticket_id=(SELECT id FROM tickets WHERE ticket_no=$1)`, [booking.tickets[0].ticket_no]);
    expect(log[0].status).toBe('CONFIRMED');
    expect(ctx.events.some((e) => e.event === 'OCCUPANCY_UPDATED')).toBe(true);
    const bk = await q(`SELECT status FROM bookings WHERE booking_no=$1`, [booking.booking.booking_no]);
    expect(bk[0].status).toBe('CHECKED_IN');
  });

  it('same QR at another gate → ACCESS DENIED + DUPLICATE ENTRY ATTEMPT (anti-passback) with first entry info', async () => {
    const r = (await scan(6, booking.tickets[0].qr)).json();
    expect(r.result).toBe('DENIED');
    expect(r.reasonCode).toBe('ALREADY_INSIDE');
    expect(r.duplicate.firstGate).toBe('GATE-01');
    const sec = await q(`SELECT * FROM security_events WHERE type='DUPLICATE_ENTRY' ORDER BY created_at DESC LIMIT 1`);
    expect(sec[0].data.firstGate).toBe('GATE-01');
    expect(ctx.events.some((e) => e.event === 'SECURITY_ALERT' && e.data.type === 'DUPLICATE_ENTRY')).toBe(true);
    expect(await gateState(6)).toBe('DENIED');
    // Every scan is logged — denied ones too.
    const scans = await q(`SELECT result FROM gate_scans WHERE gate_id=$1 ORDER BY created_at DESC LIMIT 1`, [gateId(6)]);
    expect(scans[0].result).toBe('DENIED');
  });

  it('exit gate releases presence (re-entry allowed by the package)', async () => {
    await waitIdle(10);
    const r = (await scan(10, booking.tickets[0].qr)).json();
    expect(r.result).toBe('GRANTED');
    await waitFor(async () => (await q(`SELECT presence FROM tickets WHERE ticket_no=$1`, [booking.tickets[0].ticket_no]))[0].presence === 'OUTSIDE');
    await waitIdle(10);
    await waitIdle(2);
    const back = (await scan(2, booking.tickets[0].qr)).json();
    expect(back.result).toBe('GRANTED');
    await waitIdle(2);
  });
});

describe('gate security', () => {
  it('rejects forged / unknown codes and never opens', async () => {
    const forged = (await scan(5, 'TP:TK-20261006-000001.AAAAAAAA')).json();
    expect(forged.result).toBe('DENIED');
    expect(['NO_TICKET', 'FORGED_CODE']).toContain(forged.reasonCode);
    await waitIdle(5);
    const junk = (await scan(5, 'hello world')).json();
    expect(junk.reasonCode).toBe('INVALID_CODE');
    await waitIdle(5);
    const d = await counterTickets([{ code: 'DAY-BASIC', tt: 'ADULT' }]);
    const tampered = d.tickets[0].credential_code + '.ABCDEFGH';
    const r = (await scan(5, tampered)).json();
    expect(r.reasonCode).toBe('FORGED_CODE');
    expect((await q(`SELECT 1 FROM security_events WHERE type='FORGED_TOKEN'`)).length).toBeGreaterThan(0);
    await waitIdle(5);
  });

  it('two gates scanning the same ticket at the same time → exactly one grant', async () => {
    const d = await counterTickets([{ code: 'DAY-BASIC', tt: 'ADULT' }]);
    const { payloadsFor } = await import('../src/services/park/credentials');
    const qr = payloadsFor({ code: d.tickets[0].credential_code, token_version: 1 }).qr;
    await Promise.all([waitIdle(7), waitIdle(8)]);
    const [a, b] = await Promise.all([scan(7, qr), scan(8, qr)]);
    const results = [a.json().result, b.json().result].sort();
    expect(results).toEqual(['DENIED', 'GRANTED']);
    await Promise.all([waitIdle(7), waitIdle(8)]);
  });

  it('MANUAL gate: request goes to the operator; DENY keeps it closed, APPROVE opens', async () => {
    const d = await counterTickets([{ code: 'DAY-BASIC', tt: 'CHILD' }]);
    const { payloadsFor } = await import('../src/services/park/credentials');
    const qr = payloadsFor({ code: d.tickets[0].credential_code, token_version: 1 }).qr;
    const r = (await scan(3, qr)).json();
    expect(r.result).toBe('PENDING');
    expect(await gateState(3)).toBe('WAITING_APPROVAL');
    expect(ctx.events.some((e) => e.event === 'GATE_SCAN' && e.data.scanId === r.scanId && e.rooms.some((x) => x.endsWith(':gates')))).toBe(true);
    const deny = await staff(ctx, 'gate', 'POST', `/api/park/gates/${gateId(3)}/deny`, { scanId: r.scanId });
    expect(deny.statusCode).toBe(200);
    expect(await gateState(3)).toBe('DENIED');
    expect((await q(`SELECT presence FROM tickets WHERE id=$1`, [d.tickets[0].id]))[0].presence).toBe('OUTSIDE');
    await sleep(3100); // duplicate-ignore window
    const r2 = (await scan(3, qr)).json();
    expect(r2.result).toBe('PENDING');
    const ok = await staff(ctx, 'gate', 'POST', `/api/park/gates/${gateId(3)}/approve`, { scanId: r2.scanId });
    expect(ok.statusCode, ok.body).toBe(200);
    await waitFor(async () => (await q(`SELECT presence FROM tickets WHERE id=$1`, [d.tickets[0].id]))[0].presence === 'INSIDE');
    const scanRow = (await q(`SELECT result, decided_by FROM gate_scans WHERE id=$1`, [r2.scanId]))[0];
    expect(scanRow.result).toBe('APPROVED');
    expect(scanRow.decided_by).toBeTruthy();
    await waitIdle(3);
  });

  it('manual gate open needs gates.open + manager PIN; OPEN is never sent twice', async () => {
    const no = await staff(ctx, 'gate', 'POST', `/api/park/gates/${gateId(4)}/open`, { reason: 'wheelchair' });
    expect(no.statusCode).toBe(403);
    const needPin = await staff(ctx, 'supervisor', 'POST', `/api/park/gates/${gateId(4)}/open`, { reason: 'wheelchair' });
    expect(needPin.json().error.code).toBe('MANAGER_PIN_REQUIRED');
    const ok = await staff(ctx, 'supervisor', 'POST', `/api/park/gates/${gateId(4)}/open`, { reason: 'wheelchair', managerCode: 'MGR001', managerPin: '2222' });
    expect(ok.statusCode, ok.body).toBe(200);
    const again = await staff(ctx, 'supervisor', 'POST', `/api/park/gates/${gateId(4)}/open`, { reason: 'again', managerCode: 'MGR001', managerPin: '2222' });
    expect([409, 200]).toContain(again.statusCode);
    if (again.statusCode === 409) expect(['GATE_ALREADY_OPEN', 'GATE_BUSY']).toContain(again.json().error.code);
    expect((await q(`SELECT 1 FROM manager_approvals WHERE action='MANUAL_GATE_OPEN'`)).length).toBeGreaterThan(0);
    await waitIdle(4);
  });

  it('emergency mode overrides the ticket system and is logged', async () => {
    const on = await staff(ctx, 'supervisor', 'POST', '/api/park/gates/emergency', { on: true, gateId: gateId(5) });
    expect(on.statusCode).toBe(200);
    expect(await gateState(5)).toBe('EMERGENCY');
    const d = await counterTickets([{ code: 'DAY-BASIC', tt: 'ADULT' }]);
    const { payloadsFor } = await import('../src/services/park/credentials');
    const r = (await scan(5, payloadsFor({ code: d.tickets[0].credential_code, token_version: 1 }).qr)).json();
    expect(r.reasonCode).toBe('EMERGENCY');
    await staff(ctx, 'supervisor', 'POST', '/api/park/gates/emergency', { on: false, gateId: gateId(5) });
    expect(await gateState(5)).toBe('IDLE');
  });
});

describe('wristband, wallet and POS', () => {
  let wristband: string;
  let accountId: string;
  it('binds a pre-printed wristband to a ticket (Wristband ↔ Ticket ↔ account) and tops up with cash', async () => {
    const d = await counterTickets([{ code: 'DAY-BASIC', tt: 'ADULT' }]);
    const stock = await q(`SELECT code, token_version FROM credentials WHERE type='PRINTED_WRISTBAND' AND status='NEW' ORDER BY code LIMIT 1`);
    const { payloadsFor } = await import('../src/services/park/credentials');
    wristband = payloadsFor(stock[0]).barcode;
    const b = await staff(ctx, 'ticket', 'POST', `/api/park/tickets/${d.tickets[0].id}/bind`, { code: wristband });
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json().link.wristband).toBe(stock[0].code);
    expect(b.json().link.ticket).toBe(d.tickets[0].ticket_no);
    accountId = b.json().profile.credential.account_id;
    const top = (await staff(ctx, 'ticket', 'POST', '/api/park/sales', { channel: 'COUNTER', credentialCode: wristband, lines: [{ type: 'TOPUP', amount: 500, qty: 1 }] })).json();
    expect(top.sale?.id, JSON.stringify(top)).toBeTruthy();
    const paid = (await staff(ctx, 'ticket', 'POST', `/api/park/sales/${top.sale.id}/payments`, { method: 'CASH', received: 500 })).json();
    expect(paid.completed).toBe(true);
    const w = await q(`SELECT balance FROM wallet_accounts WHERE account_id=$1`, [accountId]);
    expect(Number(w[0].balance)).toBe(500);
    const led = await q(`SELECT * FROM wallet_ledger WHERE account_id=$1`, [accountId]);
    expect(led).toHaveLength(1);
    expect(Number(led[0].balance_before)).toBe(0);
    expect(Number(led[0].balance_after)).toBe(500);
    expect(ctx.events.some((e) => e.event === 'WALLET_UPDATED' && e.data.accountId === accountId && e.data.balance === 500)).toBe(true);
    // The wristband also opens the gate (bound ticket).
    await waitIdle(1);
    const g = (await scan(1, wristband)).json();
    expect(g.result).toBe('GRANTED');
    await waitIdle(1);
  });

  it('POS retail purchase with the wallet: double tap charges once; insufficient balance refused', async () => {
    const store = (await staff(ctx, 'pos', 'GET', '/api/park/pos/stores')).json().find((s: any) => s.code === 'SOUVENIR');
    const cat = (await staff(ctx, 'pos', 'GET', `/api/park/pos/stores/${store.id}/catalog`)).json();
    const keychain = cat.products.find((p: any) => p.sku === 'KEYCHAIN');
    await staff(ctx, 'pos', 'POST', '/api/park/shifts/open', { openingCash: 1000, terminal: 'POS', storeId: store.id });
    const s = (await staff(ctx, 'pos', 'POST', '/api/park/sales', { channel: 'POS', storeId: store.id, lines: [{ type: 'PRODUCT', refId: keychain.id, qty: 1 }] })).json();
    const key = uuid();
    const [a, b] = await Promise.all([
      staff(ctx, 'pos', 'POST', `/api/park/sales/${s.sale.id}/payments`, { method: 'WALLET', credentialCode: wristband }, { 'idempotency-key': key }),
      staff(ctx, 'pos', 'POST', `/api/park/sales/${s.sale.id}/payments`, { method: 'WALLET', credentialCode: wristband }, { 'idempotency-key': key }),
    ]);
    expect(a.statusCode, a.body).toBe(200);
    expect(b.statusCode, b.body).toBe(200);
    const debits = await q(`SELECT * FROM wallet_ledger WHERE account_id=$1 AND type='PAYMENT'`, [accountId]);
    expect(debits).toHaveLength(1);
    const w = await q(`SELECT balance FROM wallet_accounts WHERE account_id=$1`, [accountId]);
    expect(Number(w[0].balance)).toBe(500 - Number(s.sale.total));
    const inv = await q(`SELECT qty FROM inventory WHERE product_id=$1 AND store_id=$2`, [keychain.id, store.id]);
    expect(Number(inv[0].qty)).toBe(99);
    const big = (await staff(ctx, 'pos', 'POST', '/api/park/sales', { channel: 'POS', storeId: store.id, lines: [{ type: 'PRODUCT', refId: cat.products.find((p: any) => p.sku === 'TSHIRT').id, qty: 2 }] })).json();
    const fail = await staff(ctx, 'pos', 'POST', `/api/park/sales/${big.sale.id}/payments`, { method: 'WALLET', credentialCode: wristband });
    expect(fail.json().error.code).toBe('INSUFFICIENT_BALANCE');
    expect(Number((await q(`SELECT balance FROM wallet_accounts WHERE account_id=$1`, [accountId]))[0].balance)).toBe(500 - Number(s.sale.total));
  });

  it('restaurant order paid with the wallet goes to the kitchen; balance syncs', async () => {
    const before = Number((await q(`SELECT balance FROM wallet_accounts WHERE account_id=$1`, [accountId]))[0].balance);
    const o = (await staff(ctx, 'pos', 'POST', '/api/park/pos/orders', { clientOrderId: uuid(), orderType: 'TAKE_AWAY', items: [{ productId: ctx.products['WATER'].id, qty: 2, modifierIds: [] }] })).json();
    const pay = await staff(ctx, 'pos', 'POST', `/api/park/pos/orders/${o.orderId}/wallet`, { code: wristband });
    expect(pay.statusCode, pay.body).toBe(200);
    expect(pay.json().balance).toBe(before - 30);
    const k = await q(`SELECT * FROM kitchen_orders WHERE order_id=$1`, [o.orderId]);
    expect(k.length).toBeGreaterThan(0);
    const ord = await q(`SELECT payment_method, payment_status FROM orders WHERE id=$1`, [o.orderId]);
    expect(ord[0]).toMatchObject({ payment_method: 'WALLET', payment_status: 'PAID' });
  });
});

describe('rides: entitlements and buying at the scanner', () => {
  let qr: string;
  it('included ride → granted; not included → offer → buy with wallet → granted; second scan → used up', async () => {
    const d = await counterTickets([{ code: 'DAY-BASIC', tt: 'ADULT' }]);
    const { payloadsFor } = await import('../src/services/park/credentials');
    qr = payloadsFor({ code: d.tickets[0].credential_code, token_version: 1 }).qr;
    // Must enter the park first.
    const notIn = (await device(ctx, 'SCAN-RIDE-001', 'POST', `/api/park/rides/scan-points/${spId('R01')}/scan`, { code: qr })).json();
    expect(notIn.reasonCode).toBe('NOT_ENTERED');
    await waitIdle(2);
    expect((await scan(2, qr)).json().result).toBe('GRANTED');
    await waitFor(async () => (await q(`SELECT presence FROM tickets WHERE id=$1`, [d.tickets[0].id]))[0].presence === 'INSIDE');
    const ok = (await device(ctx, 'SCAN-RIDE-001', 'POST', `/api/park/rides/scan-points/${spId('R01')}/scan`, { code: qr })).json();
    expect(ok.result).toBe('GRANTED');
    expect(ok.entitlement.type).toBe('UNLIMITED');
    const vr = (await device(ctx, 'SCAN-RIDE-004', 'POST', `/api/park/rides/scan-points/${spId('R04')}/scan`, { code: qr })).json();
    expect(vr.result).toBe('NOT_INCLUDED');
    expect(vr.reasonCode).toBe('NOT_INCLUDED');
    expect(vr.offer.price).toBe(120);
    // No wallet money on a paper ticket's guest account → insufficient.
    const poor = await device(ctx, 'SCAN-RIDE-004', 'POST', `/api/park/rides/scan-points/${spId('R04')}/buy`, { code: qr, method: 'WALLET' }, { 'idempotency-key': uuid() });
    expect(poor.json().error.code).toBe('INSUFFICIENT_BALANCE');
    expect((await q(`SELECT 1 FROM ride_entitlements WHERE ticket_id IS NULL AND ride_id=(SELECT ride_id FROM ride_scan_points WHERE id=$1) AND source='ADDON'`, [spId('R04')])).length).toBe(0);
    // Top up the guest account then buy.
    const top = (await staff(ctx, 'ticket', 'POST', '/api/park/sales', { channel: 'COUNTER', credentialCode: qr, lines: [{ type: 'TOPUP', amount: 500, qty: 1 }] })).json();
    await staff(ctx, 'ticket', 'POST', `/api/park/sales/${top.sale.id}/payments`, { method: 'CASH', received: 500 });
    const key = uuid();
    const buy = await device(ctx, 'SCAN-RIDE-004', 'POST', `/api/park/rides/scan-points/${spId('R04')}/buy`, { code: qr, method: 'WALLET' }, { 'idempotency-key': key });
    expect(buy.statusCode, buy.body).toBe(200);
    expect(buy.json().completed).toBe(true);
    expect(buy.json().scan.result).toBe('GRANTED');
    expect(buy.json().scan.entitlement.usesLeft).toBe(0);
    // Retry of the same purchase (network retry) does not charge again.
    const retry = await device(ctx, 'SCAN-RIDE-004', 'POST', `/api/park/rides/scan-points/${spId('R04')}/buy`, { code: qr, method: 'WALLET' }, { 'idempotency-key': key });
    expect(retry.statusCode).toBe(200);
    const acc = (await q(`SELECT account_id FROM tickets WHERE id=$1`, [d.tickets[0].id]))[0].account_id;
    expect(Number((await q(`SELECT balance FROM wallet_accounts WHERE account_id=$1`, [acc]))[0].balance)).toBe(380);
    await sleep(8100);
    const used = (await device(ctx, 'SCAN-RIDE-004', 'POST', `/api/park/rides/scan-points/${spId('R04')}/scan`, { code: qr })).json();
    expect(used.result).toBe('NOT_INCLUDED');
    expect(used.reasonCode).toBe('USES_EXHAUSTED');
  }, 20000);

  it('cash at the ride waits for the operator before granting', async () => {
    const r = await device(ctx, 'SCAN-RIDE-006', 'POST', `/api/park/rides/scan-points/${spId('R06')}/buy`, { code: qr, method: 'CASH' }, { 'idempotency-key': uuid() });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().completed).toBe(false);
    expect(r.json().payment.status).toBe('WAITING_CASH');
    const ride = (await q(`SELECT ride_id FROM ride_scan_points WHERE id=$1`, [spId('R06')]))[0].ride_id;
    const detail = (await staff(ctx, 'ride', 'GET', `/api/park/rides/${ride}`)).json();
    expect(detail.pendingCash.length).toBe(1);
    await staff(ctx, 'ride', 'POST', '/api/park/shifts/open', { openingCash: 0, terminal: 'RIDE' });
    const conf = await staff(ctx, 'ride', 'POST', `/api/park/sales/${r.json().sale.id}/payments/${r.json().payment.id}/confirm-cash`, { received: 100 });
    expect(conf.statusCode, conf.body).toBe(200);
    const redeem = (await device(ctx, 'SCAN-RIDE-006', 'POST', `/api/park/rides/scan-points/${spId('R06')}/redeem`, { saleId: r.json().sale.id })).json();
    expect(redeem.scan.result).toBe('GRANTED');
  });

  it('virtual queue: join → number + wait estimate → call → board on scan', async () => {
    const vr = (await q(`SELECT ride_id FROM ride_scan_points WHERE id=$1`, [spId('R05')]))[0].ride_id;
    const j = await device(ctx, 'SCAN-RIDE-005', 'POST', `/api/park/rides/scan-points/${spId('R05')}/queue`, { code: qr });
    expect(j.statusCode, j.body).toBe(200);
    expect(j.json().queueNo).toMatch(/^G\d+$/);
    expect(j.json().ahead).toBe(0);
    const called = (await staff(ctx, 'ride', 'POST', `/api/park/rides/${vr}/queue/call`, { count: 1 })).json();
    expect(called[0].status).toBe('CALLED');
    const list = (await staff(ctx, 'ride', 'GET', `/api/park/rides/${vr}/queue`)).json();
    expect(list[0].status).toBe('CALLED');
  });
});

describe('members, promotions, points, lost card', () => {
  let token: string;
  it('member logs in, sees member price, buys a ticket with wallet and earns points (Gold x1.5)', async () => {
    const login = await publicReq(ctx, 'POST', '/api/park/member/login', { login: '0811111111', password: 'member1234' });
    expect(login.statusCode, login.body).toBe(200);
    token = login.json().token;
    const auth = { authorization: `Bearer ${token}` };
    const qr = (await publicReq(ctx, 'GET', '/api/park/member/qr', undefined, auth)).json();
    expect(qr.qr).toMatch(/^TPD:DC-/);
    const cat = (await publicReq(ctx, 'GET', `/api/park/public/branches/BKK01/catalog?date=${plusDays(today(), 1)}`, undefined, auth)).json();
    const basic = cat.packages.find((p: any) => p.code === 'DAY-BASIC');
    expect(priceOf(basic, 'ADULT').unit_price).toBe(405); // member price
    const before = Number((await q(`SELECT points FROM members WHERE phone='0811111111'`))[0].points);
    const b = (await publicReq(ctx, 'POST', '/api/park/public/bookings', { branchCode: 'BKK01', visitDate: today(), items: [{ packageId: basic.id, ticketTypeId: tts.ADULT, qty: 1 }], customer: { name: 'Somchai Jaidee', phone: '0811111111' } }, auth)).json();
    expect(b.booking.member_id).toBeTruthy();
    const pay = await publicReq(ctx, 'POST', `/api/park/member/sales/${b.sale.id}/payments`, { method: 'WALLET' }, auth);
    expect(pay.statusCode, pay.body).toBe(200);
    expect(pay.json().completed).toBe(true);
    const after = Number((await q(`SELECT points FROM members WHERE phone='0811111111'`))[0].points);
    expect(after - before).toBe(Math.floor(Math.floor(Number(b.sale.total) / 100) * 1.5));
    // Member card (digital QR) opens the gate for the account's ticket.
    await waitIdle(9);
    const g = (await scan(9, qr.qr, 'ENTRY')).json();
    expect(g.result, JSON.stringify(g)).toBe('GRANTED');
    await waitIdle(9);
    // Static digital-card code (screenshot) is refused.
    const { payloadsFor } = await import('../src/services/park/credentials');
    const dc = (await q(`SELECT code, token_version FROM credentials WHERE type='DIGITAL_CARD' AND member_id=(SELECT id FROM members WHERE phone='0811111111')`))[0];
    const st = (await scan(1, payloadsFor(dc).qr)).json();
    expect(st.reasonCode).toBe('QR_EXPIRED');
    await waitIdle(9);
  });

  it('non-stackable "come 4 pay 3" wins over "buy 3 get 10%"; promo code applies; birthday child is free', async () => {
    const quote = (await publicReq(ctx, 'POST', '/api/park/public/quote', { branchCode: 'BKK01', visitDate: plusDays(today(), 1), items: [{ packageId: pkgs['DAY-BASIC'].id, ticketTypeId: tts.ADULT, qty: 4 }] })).json();
    const names = quote.promotions.map((p: any) => p.name.en);
    expect(names).toContain('Come 4, pay 3');
    expect(names).not.toContain('Buy 3 tickets, 10% off');
    const unit = priceOf(pkgs['DAY-BASIC'], 'ADULT').unit_price;
    expect(quote.discount).toBe(unit);
    const code = (await publicReq(ctx, 'POST', '/api/park/public/quote', { branchCode: 'BKK01', visitDate: plusDays(today(), 1), codes: ['park100'], items: [{ packageId: pkgs['DAY-BASIC'].id, ticketTypeId: tts.ADULT, qty: 1 }] })).json();
    expect(code.promotions.some((p: any) => p.code === 'PARK100')).toBe(true);
    const bad = await publicReq(ctx, 'POST', '/api/park/public/bookings', { branchCode: 'BKK01', visitDate: plusDays(today(), 1), codes: ['NOPE'], items: [{ packageId: pkgs['DAY-BASIC'].id, ticketTypeId: tts.ADULT, qty: 1 }], customer: { name: 'x', phone: '0800000000' } });
    expect(bad.json().error.code).toBe('INVALID_PROMO_CODE');
    const login = (await publicReq(ctx, 'POST', '/api/park/member/login', { login: '0822222222', password: 'member1234' })).json();
    const bday = (await publicReq(ctx, 'POST', '/api/park/public/quote', { branchCode: 'BKK01', visitDate: plusDays(today(), 1), items: [{ packageId: pkgs['DAY-BASIC'].id, ticketTypeId: tts.CHILD, qty: 1 }, { packageId: pkgs['DAY-BASIC'].id, ticketTypeId: tts.ADULT, qty: 1 }] }, { authorization: `Bearer ${login.token}` })).json();
    expect(bday.promotions.some((p: any) => p.name.en === 'Birthday child enters free')).toBe(true);
  });

  it('lost card: report lost → old card denied, new card keeps member + wallet + rights', async () => {
    const card = (await q(`SELECT c.*, w.balance FROM credentials c JOIN wallet_accounts w ON w.account_id=c.account_id WHERE c.type='MEMBER_CARD' AND c.label='Somchai Jaidee'`))[0];
    const { payloadsFor } = await import('../src/services/park/credentials');
    const oldCode = payloadsFor(card).barcode;
    const r = await staff(ctx, 'supervisor', 'POST', `/api/park/cards/${card.id}/replace`, { generate: true, reason: 'LOST', managerCode: 'MGR001', managerPin: '2222' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().transferred.member).toBe(true);
    const neu = r.json().profile;
    expect(neu.credential.code).not.toBe(card.code);
    expect(Number(neu.wallet.balance)).toBe(Number(card.balance));
    expect(neu.member.member_no).toBeTruthy();
    await waitIdle(1);
    const g = (await scan(1, oldCode)).json();
    expect(g.reasonCode).toBe('CARD_LOST');
    expect(ctx.events.some((e) => e.event === 'SECURITY_ALERT' && e.data.type === 'REVOKED_CREDENTIAL')).toBe(true);
    await waitIdle(1);
    // The old card cannot pay either.
    const store = (await staff(ctx, 'pos', 'GET', '/api/park/pos/stores')).json().find((s: any) => s.code === 'SOUVENIR');
    const cat = (await staff(ctx, 'pos', 'GET', `/api/park/pos/stores/${store.id}/catalog`)).json();
    const s = (await staff(ctx, 'pos', 'POST', '/api/park/sales', { channel: 'POS', storeId: store.id, lines: [{ type: 'PRODUCT', refId: cat.products.find((p: any) => p.sku === 'BALLOON').id, qty: 1 }] })).json();
    const pay = await staff(ctx, 'pos', 'POST', `/api/park/sales/${s.sale.id}/payments`, { method: 'WALLET', credentialCode: oldCode });
    expect(pay.json().error.code).toBe('CARD_LOST');
    const pay2 = await staff(ctx, 'pos', 'POST', `/api/park/sales/${s.sale.id}/payments`, { method: 'WALLET', credentialCode: neu.credential.barcode });
    expect(pay2.statusCode, pay2.body).toBe(200);
  });

  it('member buys a membership upgrade from the portal and the tier changes', async () => {
    const auth = { authorization: `Bearer ${token}` };
    const plat = (await q(`SELECT id FROM membership_products WHERE code='MS-PLATINUM'`))[0].id;
    const s = await publicReq(ctx, 'POST', '/api/park/member/sales', { branchCode: 'BKK01', lines: [{ type: 'MEMBERSHIP_UPGRADE', refId: plat, qty: 1 }] }, auth);
    expect(s.statusCode, s.body).toBe(200);
    expect(Number(s.json().sale.total)).toBe(1299 - 599);
    const pay = await publicReq(ctx, 'POST', `/api/park/member/sales/${s.json().sale.id}/payments`, { method: 'WALLET' }, auth);
    expect(pay.json().completed).toBe(true);
    const me = (await publicReq(ctx, 'GET', '/api/park/member/me', undefined, auth)).json();
    expect(me.member.tier_code).toBe('PLATINUM');
  });
});

describe('refunds, lockers, shift close, reports', () => {
  it('refunds an unused ticket (manager PIN) and revokes it', async () => {
    const d = (await staff(ctx, 'ticket', 'POST', '/api/park/sales', { channel: 'COUNTER', visitDate: plusDays(today(), 2), lines: [{ type: 'PACKAGE', refId: pkgs['DAY-BASIC'].id, ticketTypeId: tts.ADULT, qty: 1 }] })).json();
    await staff(ctx, 'ticket', 'POST', `/api/park/sales/${d.sale.id}/payments`, { method: 'CASH', received: 1000 });
    const no = await staff(ctx, 'ticket', 'POST', `/api/park/sales/${d.sale.id}/refund`, { reason: 'changed plans' });
    expect(no.statusCode).toBe(403);
    const r = await staff(ctx, 'supervisor', 'POST', `/api/park/sales/${d.sale.id}/refund`, { reason: 'changed plans', managerCode: 'MGR001', managerPin: '2222', refundMethod: 'CASH' }, {});
    if (r.json().error?.code === 'SHIFT_REQUIRED') {
      await staff(ctx, 'supervisor', 'POST', '/api/park/shifts/open', { openingCash: 500 });
      const r2 = await staff(ctx, 'supervisor', 'POST', `/api/park/sales/${d.sale.id}/refund`, { reason: 'changed plans', managerCode: 'MGR001', managerPin: '2222', refundMethod: 'CASH' });
      expect(r2.statusCode, r2.body).toBe(200);
    } else expect(r.statusCode, r.body).toBe(200);
    const t = await q(`SELECT status FROM tickets WHERE sale_id=$1`, [d.sale.id]);
    expect(t[0].status).toBe('REFUNDED');
    const sale = await q(`SELECT status FROM sales WHERE id=$1`, [d.sale.id]);
    expect(sale[0].status).toBe('REFUNDED');
  });

  it('rents a locker with the wallet and opens it with the same wristband', async () => {
    const wb = ctx.park.parkMembers.guestWristband;
    const cred = (await q(`SELECT code, token_version FROM credentials WHERE code=$1`, [wb]))[0];
    const { payloadsFor } = await import('../src/services/park/credentials');
    const code = payloadsFor(cred).barcode;
    const rate = (await q(`SELECT id FROM locker_rates WHERE minutes=60`))[0].id;
    const r = await device(ctx, 'LOCKER-A', 'POST', '/api/park/lockers/rent', { code, rateId: rate, method: 'WALLET' }, { 'idempotency-key': uuid() });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().session.locker_code).toMatch(/^L-/);
    const open = (await device(ctx, 'LOCKER-A', 'POST', '/api/park/lockers/open', { code })).json();
    expect(open.ok).toBe(true);
    expect(open.locker.code).toBe(r.json().session.locker_code);
  });

  it('closes the counter shift with expected cash and over/short', async () => {
    const cur = (await staff(ctx, 'ticket', 'GET', '/api/park/shifts/current')).json();
    expect(cur.summary.cashSales).toBeGreaterThan(0);
    const close = (await staff(ctx, 'ticket', 'POST', `/api/park/shifts/${cur.id}/close`, { actualCash: cur.summary.expected - 20 })).json();
    expect(close.shift.status).toBe('CLOSED');
    expect(Number(close.shift.over_short)).toBe(-20);
  });

  it('dashboard, live map, transaction center and every park report respond', async () => {
    const dash = (await staff(ctx, 'admin', 'GET', '/api/park/dashboard')).json();
    expect(dash.kpis.ticketSales).toBeGreaterThan(0);
    expect(dash.kpis.currentInside).toBeGreaterThan(0);
    expect(dash.charts.gateTraffic).toHaveLength(10);
    const map = (await staff(ctx, 'admin', 'GET', '/api/park/map')).json();
    expect(map.zones.length).toBe(5);
    const tx = (await staff(ctx, 'admin', 'GET', `/api/park/transactions?q=${encodeURIComponent('WT-')}`)).json();
    expect(tx.length).toBeGreaterThan(0);
    const reports = (await staff(ctx, 'admin', 'GET', '/api/park/reports')).json();
    for (const r of reports) {
      const res = await staff(ctx, 'admin', 'GET', `/api/park/reports/${r}?from=${plusDays(today(), -1)}&to=${plusDays(today(), 3)}`);
      expect(res.statusCode, `${r}: ${res.body.slice(0, 300)}`).toBe(200);
    }
    const csv = await staff(ctx, 'admin', 'GET', `/api/park/reports/park-daily-sales?format=csv`);
    expect(csv.headers['content-type']).toContain('text/csv');
    const audit = await q(`SELECT DISTINCT action FROM audit_logs`);
    const actions = audit.map((a) => a.action);
    for (const a of ['GATE_APPROVE', 'GATE_DENY', 'GATE_MANUAL_OPEN', 'CARD_REPLACE', 'SALE_REFUND', 'SHIFT_CLOSE', 'WRISTBAND_BIND']) expect(actions).toContain(a);
  });
});
