import { EVENTS, rooms, type Lang } from '@kiosk/shared';
import { one, query, tx, type Db, type Tx } from '../../db/pool';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { Outbox } from '../../lib/realtime';
import { branchToday, createAccount, genBookingNo, parkSettings, randomToken } from './common';
import { credentialProfile, effectiveStatus, issueCredential, payloadsFor, resolveScan } from './credentials';
import { dayBounds } from './entitlements';
import { normalizeEmail, normalizePhone } from './members';
import { createSaleTx, getSaleDetail, syncBookingPayment, type SaleCreateInput } from './sales';
import { printCredential } from './print';

export interface BookingInput {
  branchId: string;
  channel: 'ONLINE' | 'PORTAL' | 'COUNTER' | 'KIOSK';
  memberId?: string | null;
  customer: { name: string; phone?: string | null; email?: string | null };
  visitDate: string;
  items: { packageId: string; ticketTypeId?: string | null; qty: number; guestNames?: string[] }[];
  codes?: string[];
  payMode: 'PAY_NOW' | 'PAY_AT_PARK';
  language?: Lang;
  note?: string | null;
  staffId?: string | null;
  deviceId?: string | null;
  clientRef?: string | null;
  printerId?: string | null;
}

/**
 * Create a booking (guest or member). Tickets are created UNPAID right away so they hold capacity;
 * PAY_NOW holds expire after `booking.holdMinutes`, PAY_AT_PARK reservations stay until the visit date.
 * A BOOKING credential (barcode / QR = booking number + signature) is issued for counter check-in.
 */
export async function createBooking(input: BookingInput) {
  const s = await parkSettings(input.branchId);
  if (!input.memberId && !s.booking.guestCheckout && ['ONLINE', 'PORTAL'].includes(input.channel)) throw forbidden('LOGIN_REQUIRED', 'Please log in to book');
  if (input.payMode === 'PAY_AT_PARK' && !s.booking.payAtParkEnabled) throw badRequest('PAY_AT_PARK_DISABLED');
  if (!input.items.length) throw badRequest('EMPTY_CART');
  const phone = input.customer.phone ? normalizePhone(input.customer.phone) : null;
  const email = normalizeEmail(input.customer.email);
  if (['ONLINE', 'PORTAL'].includes(input.channel) && !phone && !email) throw badRequest('CONTACT_REQUIRED', 'Phone or email is required');
  if (input.clientRef) {
    const dup = await one<any>(`SELECT b.* FROM bookings b JOIN sales s ON s.id=b.sale_id WHERE s.client_ref=$1`, [input.clientRef]);
    if (dup) return getBookingDetail(dup.id);
  }
  const out = new Outbox();
  const bookingId = await tx(async (c) => {
    let accountId: string | null = null;
    if (input.memberId) accountId = (await one<any>(`SELECT account_id FROM members WHERE id=$1`, [input.memberId], c))?.account_id ?? null;
    if (!accountId) accountId = (await createAccount(c, { branchId: input.branchId, kind: 'GUEST', name: input.customer.name, phone, email })).id;
    const saleInput: SaleCreateInput = {
      branchId: input.branchId,
      channel: input.channel,
      memberId: input.memberId ?? null,
      accountId,
      customer: { name: input.customer.name, phone, email },
      lines: input.items.map((i) => ({ type: 'PACKAGE' as const, refId: i.packageId, ticketTypeId: i.ticketTypeId ?? null, qty: i.qty, meta: { visitDate: input.visitDate, guestNames: i.guestNames } })),
      codes: input.codes,
      visitDate: input.visitDate,
      clientRef: input.clientRef ?? null,
      language: input.language ?? 'th',
      staffId: input.staffId ?? null,
      deviceId: input.deviceId ?? null,
      printerId: input.printerId ?? null,
      note: input.note ?? null,
      forBooking: true,
      // PAY_AT_PARK: no hold expiry (released as NO_SHOW after the visit date).
      expiresMinutes: input.payMode === 'PAY_NOW' ? s.booking.holdMinutes : null,
      autoCompleteZero: false,
    };
    const { sale } = await createSaleTx(c, saleInput, out);
    const today = await branchToday(input.branchId, c);
    const no = await genBookingNo(c, today);
    const tickets = await query<any>(`SELECT id, ticket_type_id, guest_name FROM tickets WHERE sale_id=$1 ORDER BY ticket_no`, [sale.id], c);
    const holdEnd = input.payMode === 'PAY_NOW' ? sale.expires_at : (await dayBounds(c, input.visitDate, input.visitDate, (await one<any>(`SELECT timezone FROM branches WHERE id=$1`, [input.branchId], c)).timezone)).end;
    const bk = await one<any>(
      `INSERT INTO bookings (booking_no, branch_id, sale_id, account_id, member_id, channel, customer_name, phone, email, visit_date, guests, pay_mode, status, total, language, access_token, note, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [no, input.branchId, sale.id, accountId, input.memberId ?? null, input.channel, input.customer.name, phone, email, input.visitDate, Math.max(1, tickets.length),
       input.payMode, input.payMode === 'PAY_NOW' ? 'PENDING_PAYMENT' : 'RESERVED', sale.total, input.language ?? 'th', randomToken(24), input.note ?? null, holdEnd],
      c,
    );
    await query(`UPDATE tickets SET booking_id=$2 WHERE sale_id=$1`, [sale.id, bk.id], c);
    let i = 0;
    for (const t of tickets) await query(`INSERT INTO booking_guests (booking_id, ticket_type_id, name, ticket_id, sort) VALUES ($1,$2,$3,$4,$5)`, [bk.id, t.ticket_type_id, t.guest_name, t.id, i++], c);
    const cred = await issueCredential(c, { type: 'BOOKING', code: no, branchId: input.branchId, accountId, memberId: input.memberId ?? null, bookingId: bk.id, status: 'ACTIVE' });
    await query(`UPDATE bookings SET credential_id=$2 WHERE id=$1`, [bk.id, cred.id], c);
    if (Number(sale.total) === 0) {
      const { completeSaleTx } = await import('./sales');
      await completeSaleTx(c, sale.id, out, { strict: true, actor: { type: 'SYSTEM' } });
    }
    await syncBookingPayment(c, sale.id, out);
    out.add([rooms.branchAdmin(input.branchId), rooms.branchCounter(input.branchId)], EVENTS.BOOKING_UPDATED, { bookingId: bk.id, bookingNo: no, status: bk.status, created: true });
    return bk.id as string;
  });
  await out.flush();
  return getBookingDetail(bookingId);
}

export async function getBookingDetail(bookingId: string, db?: Db) {
  const b = await one<any>(
    `SELECT bk.*, bk.visit_date::text AS visit_date, br.code AS branch_code, br.name AS branch_name, c.code AS credential_code, c.token_version,
            m.member_no, s.sale_no, s.status AS sale_status, s.total AS sale_total, s.paid_amount, s.subtotal, s.discount, s.applied_promotions, s.expires_at AS sale_expires_at
       FROM bookings bk JOIN branches br ON br.id=bk.branch_id JOIN sales s ON s.id=bk.sale_id LEFT JOIN credentials c ON c.id=bk.credential_id LEFT JOIN members m ON m.id=bk.member_id
      WHERE bk.id=$1`,
    [bookingId],
    db,
  );
  if (!b) throw notFound('Booking');
  const sale = await getSaleDetail(db ?? (await import('../../db/pool')).pool, b.sale_id);
  const tickets = await query<any>(
    `SELECT t.id, t.ticket_no, t.status, t.presence, t.guest_name, t.visit_date::text AS visit_date, t.valid_to::text AS valid_to, t.price, t.entry_count,
            p.name AS package_name, p.code AS package_code, tt.name AS ticket_type_name, tt.code AS ticket_type_code, c.code AS credential_code, c.token_version,
            (SELECT json_agg(json_build_object('id', cr.id, 'code', cr.code, 'type', cr.type, 'status', cr.status))
               FROM credential_links l JOIN credentials cr ON cr.id=l.credential_id WHERE l.ticket_id=t.id AND l.unlinked_at IS NULL AND cr.type <> 'QR_TICKET') AS wristbands
       FROM tickets t JOIN packages p ON p.id=t.package_id LEFT JOIN ticket_types tt ON tt.id=t.ticket_type_id LEFT JOIN credentials c ON c.id=t.credential_id
      WHERE t.booking_id=$1 ORDER BY t.ticket_no`,
    [bookingId],
    db,
  );
  const pl = b.credential_code ? payloadsFor({ code: b.credential_code, token_version: b.token_version }) : null;
  return {
    booking: { ...b, qr: pl?.qr ?? null, barcode: pl?.barcode ?? null, outstanding: Math.max(0, Number(b.sale_total) - Number(b.paid_amount)) },
    tickets: tickets.map((t) => ({ ...t, ...payloadsFor({ code: t.credential_code ?? t.ticket_no, token_version: t.token_version ?? 1 }) })),
    sale: sale.sale,
    items: sale.items,
    payments: sale.payments.map((p: any) => ({ ...p, provider_txn_id: undefined })),
    verifications: sale.verifications,
  };
}

/** Public lookup (booking page): booking number + access token from the confirmation link. */
export async function bookingForCustomer(bookingNo: string, token: string) {
  const b = await one<any>(`SELECT id, access_token FROM bookings WHERE booking_no=$1`, [bookingNo.toUpperCase()]);
  if (!b || b.access_token !== token) throw notFound('Booking');
  return getBookingDetail(b.id);
}

/** Counter: scan a booking barcode / ticket QR or type a booking number. */
export async function findBookingByScan(raw: string, branchId: string) {
  const r = await resolveScan(raw, undefined, { allowStaticDigital: true });
  let bookingId: string | null = null;
  if (r.ok) {
    const c = r.credential;
    bookingId = c.booking_id ?? (await one<any>(`SELECT t.booking_id FROM tickets t WHERE t.credential_id=$1 OR t.id IN (SELECT ticket_id FROM credential_links WHERE credential_id=$1 AND unlinked_at IS NULL) LIMIT 1`, [c.id]))?.booking_id ?? null;
  } else {
    const txt = raw.trim().toUpperCase();
    const b = await one<any>(`SELECT id FROM bookings WHERE booking_no=$1`, [txt]);
    bookingId = b?.id ?? null;
    if (!bookingId && r.reason && r.reason !== 'INVALID_CODE' && r.reason !== 'NO_TICKET') throw conflict(r.reason, 'Code not valid');
  }
  if (!bookingId) throw notFound('Booking');
  const d = await getBookingDetail(bookingId);
  if (d.booking.branch_id !== branchId) throw conflict('WRONG_BRANCH', 'Booking belongs to another branch');
  return d;
}

export async function searchBookings(branchId: string, f: { q?: string; filter?: string; from?: string; to?: string; limit?: number; offset?: number }) {
  const today = await branchToday(branchId);
  const where = ['bk.branch_id=$1'];
  const params: unknown[] = [branchId];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  switch (f.filter) {
    case 'TODAY': add('bk.visit_date = ?::date', today); break;
    case 'TOMORROW': add(`bk.visit_date = ?::date + 1`, today); break;
    case 'UPCOMING': add('bk.visit_date >= ?::date', today); where.push(`bk.status NOT IN ('CANCELLED','EXPIRED','REFUNDED')`); break;
    case 'UNPAID': where.push(`bk.payment_status IN ('UNPAID','PENDING') AND bk.status IN ('PENDING_PAYMENT','RESERVED')`); break;
    case 'PAID': where.push(`bk.payment_status='PAID'`); break;
    case 'PENDING_VERIFICATION': where.push(`bk.status='WAITING_VERIFICATION'`); break;
    case 'CANCELLED': where.push(`bk.status IN ('CANCELLED','EXPIRED')`); break;
    case 'REFUNDED': where.push(`(bk.status='REFUNDED' OR bk.payment_status IN ('REFUNDED','PARTIALLY_REFUNDED'))`); break;
    case 'CHECKED_IN': where.push(`bk.status IN ('CHECKED_IN','COMPLETED')`); break;
    case 'NO_SHOW': where.push(`bk.status='NO_SHOW'`); break;
  }
  if (f.from) add('bk.visit_date >= ?::date', f.from);
  if (f.to) add('bk.visit_date <= ?::date', f.to);
  if (f.q) {
    const q = f.q.trim();
    params.push(`%${q.replace(/[%_\\]/g, '')}%`);
    const i = params.length;
    where.push(`(bk.booking_no ILIKE $${i} OR bk.customer_name ILIKE $${i} OR bk.phone ILIKE $${i} OR bk.email ILIKE $${i} OR m.member_no ILIKE $${i}
      OR EXISTS (SELECT 1 FROM tickets t WHERE t.booking_id=bk.id AND t.ticket_no ILIKE $${i}))`);
  }
  params.push(f.limit ?? 100, f.offset ?? 0);
  return query<any>(
    `SELECT bk.id, bk.booking_no, bk.customer_name, bk.phone, bk.email, bk.visit_date::text AS visit_date, bk.guests, bk.pay_mode, bk.status, bk.payment_status,
            bk.total, bk.channel, bk.created_at, bk.checked_in_at, m.member_no, s.sale_no, s.paid_amount
       FROM bookings bk JOIN sales s ON s.id=bk.sale_id LEFT JOIN members m ON m.id=bk.member_id
      WHERE ${where.join(' AND ')} ORDER BY bk.visit_date DESC, bk.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
}

/** Booking calendar: guests per day vs. daily capacity. */
export async function bookingCalendar(branchId: string, month: string) {
  const s = await parkSettings(branchId);
  const rows = await query<any>(
    `SELECT t.visit_date::text AS date, COUNT(*)::int AS guests,
            COUNT(*) FILTER (WHERE t.status IN ('ACTIVE','USED'))::int AS paid,
            COUNT(DISTINCT t.booking_id)::int AS bookings
       FROM tickets t WHERE t.branch_id=$1 AND to_char(t.visit_date,'YYYY-MM')=$2 AND t.status NOT IN ('CANCELLED','REFUNDED','EXPIRED')
      GROUP BY t.visit_date ORDER BY t.visit_date`,
    [branchId, month],
  );
  return { capacity: s.park.dailyTicketCapacity, days: rows.map((r) => ({ ...r, pct: Math.round((r.guests / Math.max(1, s.park.dailyTicketCapacity)) * 100) })) };
}

/** Mark arrival at the counter (paid bookings only). */
export async function checkInBooking(bookingId: string, staffId: string) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const bk = await one<any>(`SELECT * FROM bookings WHERE id=$1 FOR UPDATE`, [bookingId], c);
    if (!bk) throw notFound('Booking');
    if (bk.payment_status !== 'PAID') throw conflict('BOOKING_NOT_PAID', 'Collect the outstanding payment first');
    if (!['CONFIRMED', 'CHECKED_IN'].includes(bk.status)) throw conflict('BOOKING_NOT_CONFIRMED', `Booking is ${bk.status}`);
    const today = await branchToday(bk.branch_id, c);
    const vd = String(bk.visit_date).slice(0, 10);
    const lastValid = await one<any>(`SELECT MAX(valid_to)::text AS d FROM tickets WHERE booking_id=$1`, [bookingId], c);
    if (today < vd || today > (lastValid?.d ?? vd)) throw conflict('WRONG_DATE', `Visit date is ${vd}`);
    await query(`UPDATE bookings SET status='CHECKED_IN', checked_in_at=COALESCE(checked_in_at, now()), checked_in_by=$2 WHERE id=$1`, [bookingId, staffId], c);
    out.add([rooms.booking(bookingId), rooms.branchCounter(bk.branch_id)], EVENTS.BOOKING_UPDATED, { bookingId, bookingNo: bk.booking_no, status: 'CHECKED_IN' });
    return bk;
  });
  await out.flush();
  return getBookingDetail(r.id);
}

/**
 * Bind a wristband / card to a ticket (scan a pre-printed wristband, or generate a new one).
 * Wristband ↔ Ticket ↔ Member (or guest account) are linked; the wristband shares the account wallet.
 */
export async function bindCredentialToTicket(a: { ticketId: string; credentialPayload?: string | null; generate?: boolean; type?: 'TEMP_WRISTBAND' | 'PRINTED_WRISTBAND' | 'TEMP_CARD'; staffId: string; heightCm?: number | null; print?: boolean; printerId?: string | null }) {
  const out = new Outbox();
  const res = await tx(async (c) => {
    const t = await one<any>(`SELECT t.*, b.timezone FROM tickets t JOIN branches b ON b.id=t.branch_id WHERE t.id=$1 FOR UPDATE OF t`, [a.ticketId], c);
    if (!t) throw notFound('Ticket');
    if (!['ACTIVE', 'PAID'].includes(t.status)) throw conflict('TICKET_NOT_ACTIVE', `Ticket is ${t.status} — payment required before issuing wristbands`);
    const s = await parkSettings(t.branch_id, c);
    let cred: any;
    if (a.credentialPayload) {
      const r = await resolveScan(a.credentialPayload, c, { allowStaticDigital: true });
      if (!r.ok) throw conflict(r.reason!, 'Wristband / card code not valid');
      cred = await one<any>(`SELECT * FROM credentials WHERE id=$1 FOR UPDATE`, [r.credential.id], c);
      if (['QR_TICKET', 'BOOKING', 'DIGITAL_CARD'].includes(cred.type)) throw badRequest('NOT_A_WRISTBAND', 'Scan a wristband or card');
      const st = await effectiveStatus(c, cred);
      if (st !== 'NEW' && st !== 'ACTIVE') throw conflict(`CARD_${st}`, `Card is ${st}`);
      if (st === 'ACTIVE' && cred.account_id && t.account_id && cred.account_id !== t.account_id && !cred.member_id) {
        const other = await one(`SELECT 1 FROM credential_links l JOIN tickets x ON x.id=l.ticket_id WHERE l.credential_id=$1 AND l.unlinked_at IS NULL AND x.status='ACTIVE'`, [cred.id], c);
        if (other) throw conflict('WRISTBAND_IN_USE', 'This wristband is already bound to another guest');
      }
    } else {
      if (!a.generate) throw badRequest('WRISTBAND_REQUIRED', 'Scan a wristband or choose generate');
      cred = await issueCredential(c, { type: a.type ?? 'TEMP_WRISTBAND', branchId: t.branch_id, status: 'NEW', issuedBy: a.staffId });
    }
    const end = (await dayBounds(c, String(t.valid_to).slice(0, 10), String(t.valid_to).slice(0, 10), t.timezone)).end;
    if (!t.account_id) {
      // Walk-in guests get a guest account on first wristband: one wallet shared by every ticket of the sale.
      const sale = t.sale_id ? await one<any>(`SELECT account_id, customer_name, phone, email FROM sales WHERE id=$1 FOR UPDATE`, [t.sale_id], c) : null;
      let accountId = sale?.account_id ?? null;
      if (!accountId) {
        accountId = (await createAccount(c, { branchId: t.branch_id, kind: 'GUEST', name: sale?.customer_name ?? t.guest_name, phone: sale?.phone, email: sale?.email })).id;
        if (t.sale_id) await query(`UPDATE sales SET account_id=$2 WHERE id=$1`, [t.sale_id, accountId], c);
      }
      await query(`UPDATE tickets SET account_id=$2 WHERE account_id IS NULL AND (id=$1 OR ($3::uuid IS NOT NULL AND sale_id=$3))`, [t.id, accountId, t.sale_id], c);
      await query(`UPDATE credentials SET account_id=$2 WHERE account_id IS NULL AND id IN (SELECT credential_id FROM tickets WHERE sale_id=$3 OR id=$1)`, [t.id, accountId, t.sale_id], c);
      t.account_id = accountId;
    }
    // A member card keeps its own account; wristbands join the ticket's account (shared wallet).
    const keepAccount = cred.type === 'MEMBER_CARD' && cred.account_id;
    await query(
      `UPDATE credentials SET status='ACTIVE', activated_at=COALESCE(activated_at, now()), branch_id=COALESCE(branch_id,$2),
          account_id = CASE WHEN $3 THEN account_id ELSE $4 END, member_id = COALESCE(member_id, $5), booking_id = COALESCE(booking_id, $6),
          expiry_policy = CASE WHEN type IN ('TEMP_WRISTBAND','PRINTED_WRISTBAND','TEMP_CARD') THEN 'PACKAGE_EXPIRY' ELSE expiry_policy END,
          expires_at = CASE WHEN type IN ('TEMP_WRISTBAND','PRINTED_WRISTBAND','TEMP_CARD') THEN $7::timestamptz ELSE expires_at END,
          label = COALESCE(label, $8), height_cm = COALESCE($9, height_cm), issued_by = COALESCE(issued_by, $10), issued_at = COALESCE(issued_at, now())
        WHERE id=$1`,
      [cred.id, t.branch_id, !!keepAccount, t.account_id, t.member_id, t.booking_id, end, t.guest_name, a.heightCm ?? null, a.staffId],
      c,
    );
    await query(`INSERT INTO credential_links (credential_id, ticket_id, created_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [cred.id, t.id, a.staffId], c);
    if (t.status === 'PAID') await query(`UPDATE tickets SET status='ACTIVE', activated_at=now() WHERE id=$1`, [t.id], c);
    if (t.booking_id) await query(`UPDATE bookings SET status='CHECKED_IN', checked_in_at=COALESCE(checked_in_at, now()), checked_in_by=COALESCE(checked_in_by,$2) WHERE id=$1 AND status='CONFIRMED'`, [t.booking_id, a.staffId], c);
    if (s.gate && t.account_id) out.add(rooms.account(t.account_id), EVENTS.CREDENTIAL_UPDATED, { credentialId: cred.id, ticketId: t.id, reason: 'BOUND' });
    out.add([rooms.branchCounter(t.branch_id)], EVENTS.CREDENTIAL_UPDATED, { credentialId: cred.id, ticketId: t.id, reason: 'BOUND' });
    if (a.print) await printCredential(c, cred.id, { kind: 'WRISTBAND', printerId: a.printerId ?? null, requestedBy: a.staffId }, out).catch(() => null);
    const member = t.member_id ? await one<any>(`SELECT member_no FROM members WHERE id=$1`, [t.member_id], c) : null;
    return { credentialId: cred.id, link: { wristband: cred.code, ticket: t.ticket_no, member: member?.member_no ?? null } };
  });
  await out.flush();
  return { ...res, profile: await credentialProfile((await import('../../db/pool')).pool, res.credentialId) };
}

export async function unbindCredential(credentialId: string, ticketId: string) {
  const r = await one<any>(`UPDATE credential_links SET unlinked_at=now() WHERE credential_id=$1 AND ticket_id=$2 AND unlinked_at IS NULL RETURNING id`, [credentialId, ticketId]);
  if (!r) throw notFound('Link');
  return { ok: true };
}

/** Background: PAY_AT_PARK reservations / unpaid holds past the visit date, and paid no-shows. */
export async function bookingMaintenance() {
  const s = await parkSettings(null);
  await query(
    `WITH x AS (
       UPDATE bookings bk SET status='EXPIRED' FROM branches b
        WHERE b.id=bk.branch_id AND bk.status IN ('RESERVED','PENDING_PAYMENT') AND bk.visit_date < (now() AT TIME ZONE b.timezone)::date RETURNING bk.sale_id)
     UPDATE sales SET status='EXPIRED', cancelled_at=now(), cancel_reason='NOT_PAID_BEFORE_VISIT' FROM x WHERE sales.id=x.sale_id AND sales.status IN ('OPEN','PENDING_PAYMENT')`,
  );
  await query(`UPDATE tickets t SET status='CANCELLED', cancelled_at=now() FROM bookings bk WHERE bk.id=t.booking_id AND bk.status='EXPIRED' AND t.status='UNPAID'`);
  if (s.booking.autoNoShow) {
    await query(
      `UPDATE bookings bk SET status='NO_SHOW' FROM branches b
        WHERE b.id=bk.branch_id AND bk.status='CONFIRMED' AND
              (SELECT MAX(valid_to) FROM tickets t WHERE t.booking_id=bk.id) < (now() AT TIME ZONE b.timezone)::date
          AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.booking_id=bk.id AND t.entry_count > 0)`,
    );
  }
  await query(
    `UPDATE bookings bk SET status='COMPLETED' FROM branches b
      WHERE b.id=bk.branch_id AND bk.status='CHECKED_IN' AND (SELECT MAX(valid_to) FROM tickets t WHERE t.booking_id=bk.id) < (now() AT TIME ZONE b.timezone)::date`,
  );
}

export async function cancelBooking(bookingId: string, reason: string, actor: { type: 'STAFF' | 'MEMBER' | 'GUEST'; id?: string | null; name?: string | null }) {
  const bk = await one<any>(`SELECT * FROM bookings WHERE id=$1`, [bookingId]);
  if (!bk) throw notFound('Booking');
  const { cancelSale } = await import('./sales');
  const sale = await one<any>(`SELECT status FROM sales WHERE id=$1`, [bk.sale_id]);
  if (sale.status === 'PAID' || sale.status === 'PARTIALLY_REFUNDED') throw conflict('BOOKING_PAID', 'Paid bookings must be refunded');
  await cancelSale(bk.sale_id, reason, actor as any);
  return getBookingDetail(bookingId);
}

export async function linkBookingToMember(bookingId: string, memberId: string) {
  return tx(async (c: Tx) => {
    const m = await one<any>(`SELECT id, account_id FROM members WHERE id=$1`, [memberId], c);
    if (!m) throw notFound('Member');
    const bk = await one<any>(`SELECT * FROM bookings WHERE id=$1 FOR UPDATE`, [bookingId], c);
    if (!bk) throw notFound('Booking');
    if (bk.member_id && bk.member_id !== memberId) throw conflict('BOOKING_HAS_MEMBER');
    await query(`UPDATE bookings SET member_id=$2 WHERE id=$1`, [bookingId, memberId], c);
    await query(`UPDATE tickets SET member_id=$2 WHERE booking_id=$1`, [bookingId, memberId], c);
    await query(`UPDATE sales SET member_id=$2 WHERE id=$1 AND member_id IS NULL`, [bk.sale_id, memberId], c);
    return { ok: true };
  });
}
