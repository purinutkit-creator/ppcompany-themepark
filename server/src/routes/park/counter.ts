import type { FastifyInstance } from 'fastify';
import { one, pool, query, tx } from '../../db/pool';
import { audit } from '../../lib/audit';
import { branchOf, requireAnyStaff, requireDeviceOrStaffPerm, requireManagerApproval, requireStaff } from '../../lib/auth';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { Outbox } from '../../lib/realtime';
import { managerApproval, parse, uuid, z } from '../../lib/validate';
import {
  bindCredentialToTicket, bookingCalendar, cancelBooking, checkInBooking, createBooking, findBookingByScan, getBookingDetail, linkBookingToMember, searchBookings, unbindCredential,
} from '../../services/park/bookings';
import { adjustWallet, bindMember, cashOutWallet, changeCardStatus, findCredential, generateBatch, issueCard, listCards, replaceCard, rotateCode, unbindMember } from '../../services/park/cards';
import { credentialProfile, payloadsFor } from '../../services/park/credentials';
import { getMemberFull, normalizePhone, registerMemberTx } from '../../services/park/members';
import { pointsPost, announcePoints } from '../../services/park/points';
import { printCredential } from '../../services/park/print';
import { idemKey, lang, ymd } from './util';

export default async function parkCounterRoutes(app: FastifyInstance) {
  // ================================================================ bookings
  app.get('/bookings', { preHandler: requireStaff('bookings.view') }, async (req) => {
    const q = parse(z.object({ q: z.string().max(80).optional(), filter: z.string().max(30).optional(), from: ymd.optional(), to: ymd.optional(), limit: z.coerce.number().int().max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }), req.query);
    return searchBookings(branchOf(req), q);
  });
  app.get('/bookings/calendar', { preHandler: requireStaff('bookings.view') }, async (req) => {
    const { month } = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }), req.query);
    return bookingCalendar(branchOf(req), month);
  });
  app.get('/bookings/:id', { preHandler: requireStaff('bookings.view') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const d = await getBookingDetail(id);
    if (d.booking.branch_id !== branchOf(req)) throw forbidden('OTHER_BRANCH');
    return d;
  });
  /** Counter: scan the customer's booking barcode / QR (or type the booking number). */
  app.post('/bookings/scan', { preHandler: requireAnyStaff('bookings.checkin', 'tickets.sell', 'bookings.view') }, async (req) => {
    const b = parse(z.object({ code: z.string().min(3).max(300) }), req.body);
    return findBookingByScan(b.code, branchOf(req));
  });
  /** Counter / phone booking (walk-in groups, school trips…). */
  app.post('/bookings', { preHandler: requireStaff('tickets.sell') }, async (req) => {
    const b = parse(
      z.object({
        visitDate: ymd, memberId: uuid.nullish(), items: z.array(z.object({ packageId: uuid, ticketTypeId: uuid.nullish(), qty: z.number().int().min(1).max(200), guestNames: z.array(z.string().max(80)).optional() })).min(1),
        customer: z.object({ name: z.string().min(1).max(120), phone: z.string().max(30).nullish(), email: z.string().max(160).nullish() }), codes: z.array(z.string().max(40)).default([]),
        payMode: z.enum(['PAY_NOW', 'PAY_AT_PARK']).default('PAY_NOW'), language: lang.default('th'), note: z.string().max(300).nullish(), clientRef: z.string().uuid().nullish(), printerId: uuid.nullish(),
      }),
      req.body,
    );
    const d = await createBooking({ ...b, branchId: branchOf(req), channel: 'COUNTER', staffId: req.staff!.id, clientRef: b.clientRef ?? null, printerId: b.printerId ?? null });
    await audit(req, { action: 'BOOKING_CREATE', entity: 'booking', entityId: d.booking.id, newValue: { bookingNo: d.booking.booking_no, total: d.booking.total } });
    return d;
  });
  app.post('/bookings/:id/checkin', { preHandler: requireStaff('bookings.checkin') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const d = await checkInBooking(id, req.staff!.id);
    await audit(req, { action: 'BOOKING_CHECKIN', entity: 'booking', entityId: id });
    return d;
  });
  app.post('/bookings/:id/cancel', { preHandler: requireStaff('bookings.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ reason: z.string().min(1).max(300), ...managerApproval }), req.body);
    const approver = await requireManagerApproval(req, 'BOOKING_CANCEL', 'bookings.manage', b, { reason: b.reason, entity: 'booking', entityId: id });
    const d = await cancelBooking(id, b.reason, { type: 'STAFF', id: req.staff!.id, name: req.staff!.name });
    await audit(req, { action: 'BOOKING_CANCEL', entity: 'booking', entityId: id, newValue: { reason: b.reason }, approvedBy: approver });
    return d;
  });
  app.post('/bookings/:id/member', { preHandler: requireStaff('bookings.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ memberId: uuid }), req.body);
    await linkBookingToMember(id, b.memberId);
    await audit(req, { action: 'BOOKING_LINK_MEMBER', entity: 'booking', entityId: id, newValue: b });
    return getBookingDetail(id);
  });

  /** Bind a wristband / card to a ticket: Wristband ↔ Ticket ↔ Member. */
  app.post('/tickets/:id/bind', { preHandler: requireStaff('cards.issue') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ code: z.string().max(300).nullish(), generate: z.boolean().default(false), type: z.enum(['TEMP_WRISTBAND', 'PRINTED_WRISTBAND', 'TEMP_CARD']).default('TEMP_WRISTBAND'), heightCm: z.number().int().min(40).max(250).nullish(), print: z.boolean().default(false), printerId: uuid.nullish() }), req.body);
    if (!b.code && !b.generate) throw badRequest('WRISTBAND_REQUIRED');
    const r = await bindCredentialToTicket({ ticketId: id, credentialPayload: b.code ?? null, generate: b.generate, type: b.type, staffId: req.staff!.id, heightCm: b.heightCm ?? null, print: b.print, printerId: b.printerId ?? null });
    await audit(req, { action: 'WRISTBAND_BIND', entity: 'ticket', entityId: id, newValue: r.link });
    return r;
  });
  app.post('/tickets/:id/unbind', { preHandler: requireStaff('cards.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ credentialId: uuid }), req.body);
    const r = await unbindCredential(b.credentialId, id);
    await audit(req, { action: 'WRISTBAND_UNBIND', entity: 'ticket', entityId: id, newValue: b });
    return r;
  });
  app.get('/tickets', { preHandler: requireStaff('tickets.view') }, async (req) => {
    const q = parse(z.object({ q: z.string().max(60).optional(), date: ymd.optional(), status: z.string().max(20).optional(), limit: z.coerce.number().int().max(500).default(100) }), req.query);
    return query(
      `SELECT t.id, t.ticket_no, t.status, t.presence, t.guest_name, t.visit_date::text AS visit_date, t.valid_to::text AS valid_to, t.entry_count, t.price, t.last_entry_at,
              p.name AS package_name, tt.name AS ticket_type_name, bk.booking_no, m.member_no
         FROM tickets t JOIN packages p ON p.id=t.package_id LEFT JOIN ticket_types tt ON tt.id=t.ticket_type_id LEFT JOIN bookings bk ON bk.id=t.booking_id LEFT JOIN members m ON m.id=t.member_id
        WHERE t.branch_id=$1 AND ($2::text IS NULL OR t.ticket_no ILIKE '%'||$2||'%' OR t.guest_name ILIKE '%'||$2||'%' OR bk.booking_no ILIKE '%'||$2||'%' OR m.member_no ILIKE '%'||$2||'%')
          AND ($3::date IS NULL OR t.visit_date=$3) AND ($4::text IS NULL OR t.status=$4) ORDER BY t.created_at DESC LIMIT $5`,
      [branchOf(req), q.q ?? null, q.date ?? null, q.status ?? null, q.limit],
    );
  });

  // ================================================================ cards / wristbands
  /** CARD PROFILE: scan any card / wristband / ticket QR at any counter or POS. */
  app.post('/cards/scan', { preHandler: requireDeviceOrStaffPerm('cards.view', 'pos.sell', 'tickets.sell', 'wallet.view', 'kiosk' as any) }, async (req) => {
    const b = parse(z.object({ code: z.string().min(2).max(300) }), req.body);
    const cred = await findCredential(b.code);
    return credentialProfile(pool, cred.id);
  });
  app.get('/cards/:id', { preHandler: requireStaff('cards.view') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const p = await credentialProfile(pool, id);
    if (!p) throw notFound('Card');
    return p;
  });
  app.get('/cards/:id/history', { preHandler: requireStaff('cards.view') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const c = await one<any>(`SELECT account_id, member_id FROM credentials WHERE id=$1`, [id]);
    if (!c) throw notFound('Card');
    const [ledger, sales, rides, gates, orders, points] = [
      await query(`SELECT * FROM wallet_ledger WHERE account_id=$1 ORDER BY seq DESC LIMIT 200`, [c.account_id]),
      await query(`SELECT s.id, s.sale_no, s.kind, s.channel, s.total, s.status, s.created_at FROM sales s WHERE s.account_id=$1 OR s.credential_id=$2 ORDER BY s.created_at DESC LIMIT 100`, [c.account_id, id]),
      await query(`SELECT l.*, r.name AS ride_name, r.code AS ride_code FROM ride_access_logs l JOIN rides r ON r.id=l.ride_id WHERE l.credential_id=$1 ORDER BY l.created_at DESC LIMIT 100`, [id]),
      await query(`SELECT s.id, s.result, s.reason_code, s.direction, s.created_at, g.code AS gate FROM gate_scans s JOIN gates g ON g.id=s.gate_id WHERE s.credential_id=$1 ORDER BY s.created_at DESC LIMIT 100`, [id]),
      await query(`SELECT id, order_number, status, total, payment_method, created_at FROM orders WHERE account_id=$1 OR credential_id=$2 ORDER BY created_at DESC LIMIT 100`, [c.account_id, id]),
      c.member_id ? await query(`SELECT * FROM points_ledger WHERE member_id=$1 ORDER BY created_at DESC LIMIT 100`, [c.member_id]) : [],
    ];
    return { ledger, sales, rides, gates, orders, points };
  });
  app.get('/cards', { preHandler: requireStaff('cards.view') }, async (req) => {
    const q = parse(z.object({ q: z.string().max(80).optional(), type: z.string().max(30).optional(), status: z.string().max(20).optional(), limit: z.coerce.number().int().max(500).default(100) }), req.query);
    return listCards(branchOf(req), q);
  });
  app.post('/cards', { preHandler: requireStaff('cards.issue') }, async (req) => {
    const b = parse(z.object({ type: z.enum(['MEMBER_CARD', 'TEMP_CARD', 'TEMP_WRISTBAND', 'PRINTED_WRISTBAND', 'RFID']), memberId: uuid.nullish(), label: z.string().max(80).nullish(), activate: z.boolean().default(true), rfidUid: z.string().regex(/^[0-9A-Fa-f]{4,32}$/).nullish(), heightCm: z.number().int().min(40).max(250).nullish(), print: z.boolean().default(false), printerId: uuid.nullish() }), req.body);
    const p = await issueCard({ branchId: branchOf(req), type: b.type, memberId: b.memberId ?? null, label: b.label ?? null, activate: b.activate, staffId: req.staff!.id, rfidUid: b.rfidUid ?? null, heightCm: b.heightCm ?? null });
    if (b.print && p) await printCredential(pool, p.credential.id, { kind: b.type.includes('WRISTBAND') ? 'WRISTBAND' : 'CARD', printerId: b.printerId ?? null, requestedBy: req.staff!.id });
    await audit(req, { action: 'CARD_ISSUE', entity: 'credential', entityId: p?.credential.id, newValue: { type: b.type, code: p?.credential.code, memberId: b.memberId } });
    return p;
  });
  app.post('/cards/batch', { preHandler: requireStaff('cards.issue') }, async (req) => {
    const b = parse(z.object({ type: z.enum(['TEMP_WRISTBAND', 'PRINTED_WRISTBAND', 'TEMP_CARD', 'MEMBER_CARD']), qty: z.number().int().min(1).max(2000), note: z.string().max(200).nullish() }), req.body);
    const r = await generateBatch({ branchId: branchOf(req), type: b.type, qty: b.qty, note: b.note ?? null, staffId: req.staff!.id });
    await audit(req, { action: 'CARD_BATCH', entity: 'wristband_batch', entityId: r.batch.id, newValue: { type: b.type, qty: b.qty } });
    const creds = await query<any>(`SELECT code, token_version FROM credentials WHERE batch_id=$1 ORDER BY code`, [r.batch.id]);
    return { batch: r.batch, codes: creds.map((c) => payloadsFor(c)) };
  });
  app.post('/cards/:id/status', { preHandler: requireStaff('cards.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ action: z.enum(['ACTIVATE', 'SUSPEND', 'UNSUSPEND', 'BLOCK', 'UNBLOCK', 'LOST', 'CLOSE', 'DEACTIVATE']), reason: z.string().max(300).nullish() }), req.body);
    const old = await one<any>(`SELECT status, code FROM credentials WHERE id=$1`, [id]);
    const r = await changeCardStatus(id, b.action, b.reason ?? null);
    await audit(req, { action: `CARD_${b.action}`, entity: 'credential', entityId: id, oldValue: old, newValue: { status: r.status, reason: b.reason } });
    return r;
  });
  /** REPORT LOST → TRANSFER TO NEW CARD (member, wallet, tickets, rights, booking, locker, queue). */
  app.post('/cards/:id/replace', { preHandler: requireStaff('cards.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ newCode: z.string().max(300).nullish(), generate: z.boolean().default(false), reason: z.enum(['LOST', 'DAMAGED', 'STOLEN', 'UPGRADE', 'OTHER']), note: z.string().max(300).nullish(), print: z.boolean().default(false), printerId: uuid.nullish(), ...managerApproval }), req.body);
    const approver = await requireManagerApproval(req, 'CARD_REPLACEMENT', 'cards.manage', b, { reason: b.reason, entity: 'credential', entityId: id });
    const r = await replaceCard({ oldCredentialId: id, newPayload: b.newCode ?? null, generate: b.generate, reason: b.reason, note: b.note ?? null, staffId: req.staff!.id, approvedBy: approver });
    if (b.print) await printCredential(pool, r.newCredentialId, { kind: r.profile?.credential.type.includes('WRISTBAND') ? 'WRISTBAND' : 'CARD', printerId: b.printerId ?? null, requestedBy: req.staff!.id });
    await audit(req, { action: 'CARD_REPLACE', entity: 'credential', entityId: id, newValue: { newCredentialId: r.newCredentialId, transferred: r.transferred, reason: b.reason }, approvedBy: approver });
    return r;
  });
  app.post('/cards/:id/member', { preHandler: requireStaff('cards.issue') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ memberId: uuid }), req.body);
    const r = await bindMember(id, b.memberId, req.staff!.id);
    await audit(req, { action: 'CARD_BIND_MEMBER', entity: 'credential', entityId: id, newValue: b });
    return r;
  });
  app.delete('/cards/:id/member', { preHandler: requireStaff('cards.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const r = await unbindMember(id);
    await audit(req, { action: 'CARD_UNBIND_MEMBER', entity: 'credential', entityId: id });
    return r;
  });
  app.post('/cards/:id/rotate', { preHandler: requireStaff('cards.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const r = await rotateCode(id);
    await audit(req, { action: 'CARD_ROTATE_CODE', entity: 'credential', entityId: id });
    return { ...r, ...payloadsFor(r) };
  });
  app.post('/cards/:id/print', { preHandler: requireAnyStaff('cards.issue', 'cards.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ kind: z.enum(['WRISTBAND', 'CARD']), printerId: uuid.nullish(), language: lang.optional() }), req.body);
    const out = new Outbox();
    const job = await tx((c) => printCredential(c, id, { kind: b.kind, printerId: b.printerId ?? null, language: b.language, requestedBy: req.staff!.id }, out));
    await out.flush();
    await audit(req, { action: 'CARD_PRINT', entity: 'credential', entityId: id, newValue: b });
    return { job };
  });

  // ---------------- wallet operations
  app.post('/wallets/:accountId/adjust', { preHandler: requireStaff('wallet.adjust') }, async (req) => {
    const { accountId } = parse(z.object({ accountId: uuid }), req.params);
    const b = parse(z.object({ amount: z.coerce.number().refine((v) => v !== 0 && Math.abs(v) <= 100000), reason: z.string().min(3).max(300), bonus: z.boolean().default(false), credentialId: uuid.nullish(), ...managerApproval }), req.body);
    const approver = await requireManagerApproval(req, 'WALLET_ADJUSTMENT', 'wallet.adjust', b, { reason: b.reason, entity: 'wallet', entityId: accountId });
    const before = await one<any>(`SELECT balance FROM wallet_accounts WHERE account_id=$1`, [accountId]);
    const e = await adjustWallet({ accountId, amount: b.amount, reason: b.reason, bonus: b.bonus, staffId: req.staff!.id, branchId: branchOf(req), credentialId: b.credentialId ?? null, idempotencyKey: idemKey(req) });
    await audit(req, { action: 'WALLET_ADJUSTMENT', entity: 'wallet', entityId: accountId, oldValue: before, newValue: { amount: b.amount, after: e.balance_after, reason: b.reason, txn: e.txn_no }, approvedBy: approver });
    return e;
  });
  /** Remaining balance at exit: cash out (policy) or transfer to a member wallet. */
  app.post('/wallets/:accountId/cash-out', { preHandler: requireStaff('wallet.refund') }, async (req) => {
    const { accountId } = parse(z.object({ accountId: uuid }), req.params);
    const b = parse(z.object({ mode: z.enum(['CASH', 'TRANSFER_TO_MEMBER']), toMemberId: uuid.nullish(), amount: z.coerce.number().positive().nullish(), credentialId: uuid.nullish(), ...managerApproval }), req.body);
    const approver = await requireManagerApproval(req, 'WALLET_REFUND', 'wallet.refund', b, { entity: 'wallet', entityId: accountId });
    const r = await cashOutWallet({ accountId, mode: b.mode, toMemberId: b.toMemberId ?? null, amount: b.amount ?? null, staffId: req.staff!.id, branchId: branchOf(req), approvedBy: approver, credentialId: b.credentialId ?? null });
    await audit(req, { action: b.mode === 'CASH' ? 'WALLET_CASH_OUT' : 'WALLET_TRANSFER', entity: 'wallet', entityId: accountId, newValue: r, approvedBy: approver });
    return r;
  });
  app.get('/wallets/:accountId/ledger', { preHandler: requireStaff('wallet.view') }, async (req) => {
    const { accountId } = parse(z.object({ accountId: uuid }), req.params);
    return query(
      `SELECT w.*, c.code AS card, u.name AS staff_name FROM wallet_ledger w LEFT JOIN credentials c ON c.id=w.credential_id LEFT JOIN users u ON u.id=w.staff_id
        WHERE w.account_id=$1 ORDER BY w.seq DESC LIMIT 500`,
      [accountId],
    );
  });

  // ================================================================ members (staff side)
  app.get('/members', { preHandler: requireStaff('members.view') }, async (req) => {
    const q = parse(z.object({ q: z.string().max(80).optional(), tier: uuid.optional(), limit: z.coerce.number().int().max(500).default(50) }), req.query);
    const term = q.q?.trim();
    return query(
      `SELECT m.id, m.member_no, m.first_name, m.last_name, m.phone, m.email, m.points, m.status, m.join_date, m.visit_count, m.total_spend, m.birthday::text AS birthday,
              t.code AS tier_code, t.name AS tier_name, t.color AS tier_color, w.balance,
              (SELECT end_date::text FROM memberships ms WHERE ms.member_id=m.id AND ms.status='ACTIVE' ORDER BY end_date DESC NULLS FIRST LIMIT 1) AS membership_end
         FROM members m LEFT JOIN member_tiers t ON t.id=m.tier_id LEFT JOIN wallet_accounts w ON w.account_id=m.account_id
        WHERE ($1::text IS NULL OR m.member_no ILIKE '%'||$1||'%' OR m.phone LIKE '%'||$2||'%' OR m.email ILIKE '%'||$1||'%' OR (m.first_name || ' ' || m.last_name) ILIKE '%'||$1||'%')
          AND ($3::uuid IS NULL OR m.tier_id=$3)
        ORDER BY m.created_at DESC LIMIT $4`,
      [term ?? null, term ? normalizePhone(term) || term : null, q.tier ?? null, q.limit],
    );
  });
  app.get('/members/:id', { preHandler: requireStaff('members.view') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const full = await getMemberFull(pool, id);
    return { ...full, cards: full.cards.map((c: any) => ({ ...c, ...payloadsFor(c) })) };
  });
  /** Register a member at the counter / kiosk (password optional — member can set it online via OTP reset). */
  app.post('/members', { preHandler: requireDeviceOrStaffPerm('members.manage', 'kiosk' as any) }, async (req) => {
    const b = parse(
      z.object({ phone: z.string().min(9).max(20), firstName: z.string().min(1).max(80), lastName: z.string().max(80).default(''), email: z.string().email().max(160).nullish(), password: z.string().min(6).max(200).nullish(),
        birthday: ymd.nullish(), gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED']).nullish(), address: z.string().max(300).nullish(), emergencyContact: z.string().max(160).nullish(), language: lang.default('th'),
        issuePhysicalCard: z.boolean().default(false), cardCode: z.string().max(300).nullish() }),
      req.body,
    );
    const r = await tx((c) => registerMemberTx(c, { ...b, branchId: branchOf(req), createdVia: req.kiosk ? 'KIOSK' : 'COUNTER', staffId: req.staff?.id ?? null }));
    let card: any = null;
    if (req.staff && (b.issuePhysicalCard || b.cardCode)) {
      if (b.cardCode) {
        const cred = await findCredential(b.cardCode);
        card = await bindMember(cred.id, r.member.id, req.staff.id);
      } else card = await issueCard({ branchId: branchOf(req), type: 'MEMBER_CARD', memberId: r.member.id, staffId: req.staff.id, label: `${b.firstName} ${b.lastName}`.trim() });
    }
    if (req.staff) await audit(req, { action: 'MEMBER_CREATE', entity: 'member', entityId: r.member.id, newValue: { memberNo: r.member.member_no, phone: r.member.phone } });
    return { member: { ...r.member, password_hash: undefined }, digitalCard: { ...r.digitalCard }, card };
  });
  app.put('/members/:id', { preHandler: requireStaff('members.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(
      z.object({ firstName: z.string().min(1).max(80), lastName: z.string().max(80).default(''), phone: z.string().min(9).max(20), email: z.string().email().max(160).nullish(), birthday: ymd.nullish(),
        gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED']).nullish(), address: z.string().max(300).nullish(), emergencyContact: z.string().max(160).nullish(), status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']).default('ACTIVE'), tierId: uuid.nullish() }),
      req.body,
    );
    const old = await one<any>(`SELECT * FROM members WHERE id=$1`, [id]);
    if (!old) throw notFound('Member');
    await query(
      `UPDATE members SET first_name=$2, last_name=$3, phone=$4, email=$5, birthday=$6, gender=$7, address=$8, emergency_contact=$9, status=$10, tier_id=COALESCE($11, tier_id),
          token_version = token_version + CASE WHEN $10 <> 'ACTIVE' THEN 1 ELSE 0 END WHERE id=$1`,
      [id, b.firstName, b.lastName, normalizePhone(b.phone), b.email?.toLowerCase() ?? null, b.birthday ?? null, b.gender ?? null, b.address ?? null, b.emergencyContact ?? null, b.status, b.tierId ?? null],
    );
    await audit(req, { action: 'MEMBER_UPDATE', entity: 'member', entityId: id, oldValue: { ...old, password_hash: undefined }, newValue: b });
    return { ok: true };
  });
  app.post('/members/:id/points', { preHandler: requireStaff('members.points') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ points: z.number().int().refine((v) => v !== 0 && Math.abs(v) <= 1_000_000), reason: z.string().min(3).max(300), ...managerApproval }), req.body);
    const approver = await requireManagerApproval(req, 'POINTS_ADJUSTMENT', 'members.points', b, { reason: b.reason, entity: 'member', entityId: id });
    const out = new Outbox();
    const r = await tx(async (c) => {
      const e = await pointsPost(c, { memberId: id, type: 'ADJUST', points: b.points, staffId: req.staff!.id, note: b.reason, reference: 'ADJUSTMENT', idempotencyKey: idemKey(req) });
      await announcePoints(out, c, id);
      return e.entry;
    });
    await out.flush();
    await audit(req, { action: 'POINTS_ADJUSTMENT', entity: 'member', entityId: id, newValue: { points: b.points, reason: b.reason, after: r?.balance_after }, approvedBy: approver });
    return r;
  });
  app.post('/members/:id/logout-all', { preHandler: requireStaff('members.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { logoutAll } = await import('../../services/park/members');
    await logoutAll(id);
    await audit(req, { action: 'MEMBER_LOGOUT_ALL', entity: 'member', entityId: id });
    return { ok: true };
  });
  app.get('/members/:id/history', { preHandler: requireStaff('members.view') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const m = await one<any>(`SELECT account_id FROM members WHERE id=$1`, [id]);
    if (!m) throw notFound('Member');
    return {
      memberships: await query(`SELECT ms.*, mp.name AS product_name, t.name AS tier_name FROM memberships ms JOIN membership_products mp ON mp.id=ms.product_id JOIN member_tiers t ON t.id=ms.tier_id WHERE ms.member_id=$1 ORDER BY ms.created_at DESC`, [id]),
      tickets: await query(`SELECT t.ticket_no, t.status, t.visit_date::text AS visit_date, p.name AS package_name FROM tickets t JOIN packages p ON p.id=t.package_id WHERE t.member_id=$1 OR t.account_id=$2 ORDER BY t.visit_date DESC LIMIT 100`, [id, m.account_id]),
      rides: await query(`SELECT l.created_at, l.result, r.name AS ride_name FROM ride_access_logs l JOIN rides r ON r.id=l.ride_id WHERE l.member_id=$1 ORDER BY l.created_at DESC LIMIT 100`, [id]),
      transactions: await query(`SELECT id, sale_no, kind, total, status, created_at FROM sales WHERE member_id=$1 OR account_id=$2 ORDER BY created_at DESC LIMIT 100`, [id, m.account_id]),
      points: await query(`SELECT * FROM points_ledger WHERE member_id=$1 ORDER BY created_at DESC LIMIT 100`, [id]),
      wallet: await query(`SELECT * FROM wallet_ledger WHERE account_id=$1 ORDER BY seq DESC LIMIT 100`, [m.account_id]),
      sessions: await query(`SELECT id, ip, user_agent, suspicious, created_at, revoked_at FROM member_sessions WHERE member_id=$1 ORDER BY created_at DESC LIMIT 20`, [id]),
    };
  });
  app.post('/blacklist', { preHandler: requireStaff('cards.manage') }, async (req) => {
    const b = parse(z.object({ credentialId: uuid.nullish(), memberId: uuid.nullish(), phone: z.string().max(30).nullish(), reason: z.string().min(3).max(300), until: z.string().max(40).nullish() }), req.body);
    if (!b.credentialId && !b.memberId && !b.phone) throw badRequest('TARGET_REQUIRED');
    const row = await one(`INSERT INTO blacklist_entries (branch_id, credential_id, member_id, phone, reason, until, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [
      branchOf(req), b.credentialId ?? null, b.memberId ?? null, b.phone ? normalizePhone(b.phone) : null, b.reason, b.until ?? null, req.staff!.id,
    ]);
    await audit(req, { action: 'BLACKLIST_ADD', entity: 'blacklist', entityId: (row as any).id, newValue: b });
    return row;
  });
  app.get('/blacklist', { preHandler: requireStaff('cards.view') }, async (req) =>
    query(`SELECT b.*, c.code AS card, m.member_no, u.name AS created_by_name FROM blacklist_entries b LEFT JOIN credentials c ON c.id=b.credential_id LEFT JOIN members m ON m.id=b.member_id LEFT JOIN users u ON u.id=b.created_by WHERE b.branch_id=$1 OR b.branch_id IS NULL ORDER BY b.created_at DESC`, [branchOf(req)]),
  );
  app.delete('/blacklist/:id', { preHandler: requireStaff('cards.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const old = await one(`DELETE FROM blacklist_entries WHERE id=$1 RETURNING *`, [id]);
    await audit(req, { action: 'BLACKLIST_REMOVE', entity: 'blacklist', entityId: id, oldValue: old });
    return { ok: true };
  });
}
