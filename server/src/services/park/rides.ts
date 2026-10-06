import {
  ageOn,
  EVENTS,
  hasExhausted,
  localNow,
  pickEntitlement,
  rooms,
  type CheckResult,
  type CustomerSnapshot,
} from '@kiosk/shared';
import { one, pool, query, tx, type Db, type Tx } from '../../db/pool';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { Outbox } from '../../lib/realtime';
import { branchInfo, parkSettings, type ParkActor } from './common';
import { rideAddonPrice } from './catalog';
import { credentialProfile, credentialStatusReason, effectiveStatus, resolveScan, snapshotFrom, ticketsForCredential, touchCredential } from './credentials';
import { memberPricingCtx } from './members';
import { notify } from './notifications';
import { addPaymentTx, createSaleTx } from './sales';

export interface RideScanResult {
  logId: string | null;
  result: 'GRANTED' | 'DENIED' | 'NOT_INCLUDED' | 'PAYMENT_PENDING' | 'QUEUE_JOINED';
  reasonCode: string | null;
  checks: CheckResult[];
  customer: CustomerSnapshot;
  ride: { id: string; code: string; name: any; status: string };
  entitlement?: { id: string; type: string; usesLeft: number | null; validUntil: string | null; fastPass: boolean } | null;
  offer?: { price: number; memberPriced: boolean; methods: string[]; walletBalance: number | null } | null;
  queue?: any;
  duplicate?: boolean;
}

const STATUS_REASON: Record<string, string> = { CLOSED: 'RIDE_CLOSED', MAINTENANCE: 'RIDE_MAINTENANCE', TEMPORARILY_CLOSED: 'RIDE_TEMP_CLOSED' };

export async function loadScanPoint(db: Db, scanPointId: string) {
  const sp = await one<any>(
    `SELECT sp.*, r.code AS ride_code, r.name AS ride_name, r.status AS ride_status, r.branch_id AS ride_branch_id FROM ride_scan_points sp JOIN rides r ON r.id=sp.ride_id WHERE sp.id=$1`,
    [scanPointId],
    db,
  );
  if (!sp) throw notFound('Scan point');
  return sp;
}

/** Entitlements usable by a credential: its tickets' rights, rights bought on this card, account-level rights. */
async function entitlementsFor(c: Db, cred: any, ticketIds: string[]) {
  return query<any>(
    `SELECT * FROM ride_entitlements
      WHERE status IN ('ACTIVE','EXHAUSTED') AND (credential_id=$1 OR ticket_id = ANY($2) OR (ticket_id IS NULL AND credential_id IS NULL AND account_id=$3))
      FOR UPDATE`,
    [cred.id, ticketIds, cred.account_id],
    c,
  );
}

/**
 * Ride entry scan: credential → ride status → valid ticket today (and park entry) → age / height →
 * entitlement for THIS ride → consume one use atomically. When nothing covers the ride the response
 * carries an add-on offer so the guest can buy access right at the scanner.
 */
export async function rideScanTx(c: Tx, sp: any, raw: string | null, ctx: { deviceId?: string | null; staffId?: string | null; credentialId?: string | null; manual?: boolean }, out: Outbox): Promise<RideScanResult> {
  const ride = await one<any>(`SELECT * FROM rides WHERE id=$1`, [sp.ride_id], c);
  const settings = await parkSettings(ride.branch_id, c);
  const b = await branchInfo(ride.branch_id, c);
  const now = new Date();
  const local = localNow(now, b.timezone);
  const checks: CheckResult[] = [];
  const rideInfo = { id: ride.id, code: ride.code, name: ride.name, status: ride.status };
  let cred: any;
  if (ctx.credentialId) cred = await one<any>(`SELECT * FROM credentials WHERE id=$1`, [ctx.credentialId], c);
  else {
    const res = await resolveScan(raw ?? '', c);
    if (!res.ok) {
      checks.push({ key: 'CODE_VALID', ok: false });
      return log(c, ride, sp, null, null, null, 'DENIED', res.reason ?? 'INVALID_CODE', checks, {}, ctx, out, rideInfo);
    }
    cred = res.credential;
  }
  if (!cred) throw notFound('Credential');
  checks.push({ key: 'CODE_VALID', ok: true });
  const st = await effectiveStatus(c, cred);
  const profile = await credentialProfile(c, cred.id);
  const snap = snapshotFrom(profile);
  const r0 = credentialStatusReason(st);
  if (r0) {
    checks.push({ key: 'CREDENTIAL', ok: false, detail: st });
    return log(c, ride, sp, cred, null, null, 'DENIED', r0, checks, snap, ctx, out, rideInfo);
  }
  checks.push({ key: 'CREDENTIAL', ok: true, detail: cred.code });
  await touchCredential(c, cred.id, ride.zone_id);

  // Accidental double scan within a few seconds: return the previous grant, never consume twice.
  const prev = await one<any>(
    `SELECT * FROM ride_access_logs WHERE ride_id=$1 AND credential_id=$2 AND result='GRANTED' AND created_at > now() - interval '8 seconds' ORDER BY created_at DESC LIMIT 1`,
    [ride.id, cred.id],
    c,
  );
  if (prev) return { logId: prev.id, result: 'GRANTED', reasonCode: null, checks: prev.checks, customer: snap, ride: rideInfo, duplicate: true };

  if (ride.status !== 'OPEN') {
    checks.push({ key: 'RIDE_STATUS', ok: false, detail: ride.status });
    return log(c, ride, sp, cred, null, null, 'DENIED', STATUS_REASON[ride.status] ?? 'RIDE_CLOSED', checks, snap, ctx, out, rideInfo);
  }
  if (ride.entry_paused) {
    checks.push({ key: 'RIDE_STATUS', ok: false, detail: 'PAUSED' });
    return log(c, ride, sp, cred, null, null, 'DENIED', 'RIDE_PAUSED', checks, snap, ctx, out, rideInfo);
  }
  checks.push({ key: 'RIDE_STATUS', ok: true });

  const tickets = (await ticketsForCredential(c, cred, { includeAccount: true })).filter(
    (t) => t.branch_id === ride.branch_id && t.status === 'ACTIVE' && String(t.valid_from).slice(0, 10) <= local.date && String(t.valid_to).slice(0, 10) >= local.date,
  );
  const ticket = tickets.find((t) => t.presence === 'INSIDE') ?? tickets[0] ?? null;
  if (ride.ticket_required) {
    if (!ticket) {
      checks.push({ key: 'TICKET_FOUND', ok: false });
      return log(c, ride, sp, cred, null, null, 'DENIED', 'NO_VALID_TICKET', checks, snap, ctx, out, rideInfo);
    }
    checks.push({ key: 'TICKET_FOUND', ok: true, detail: ticket.ticket_no });
    if (settings.ride.requireParkEntry && !tickets.some((t) => t.presence === 'INSIDE')) {
      checks.push({ key: 'PARK_ENTRY', ok: false });
      return log(c, ride, sp, cred, ticket, null, 'DENIED', 'NOT_ENTERED', checks, snapshotFrom(profile, ticket), ctx, out, rideInfo);
    }
    if (ticket.time_start && ticket.time_end) {
      const s = String(ticket.time_start).slice(0, 5);
      const e = String(ticket.time_end).slice(0, 5);
      if (!(local.time >= s && local.time < e)) {
        checks.push({ key: 'TIME_WINDOW', ok: false, detail: `${s}–${e}` });
        return log(c, ride, sp, cred, ticket, null, 'DENIED', 'OUTSIDE_TIME', checks, snapshotFrom(profile, ticket), ctx, out, rideInfo);
      }
    }
  }
  const tsnap = snapshotFrom(profile, ticket);
  // Age: member birthday if known, else the ticket type's age band.
  const age = ageOn(profile?.member?.birthday ? String(profile.member.birthday).slice(0, 10) : null, local.date);
  const minAge = age ?? ticket?.tt_max_age ?? null;
  const maxAge = age ?? ticket?.tt_min_age ?? null;
  if (ride.min_age != null && minAge != null && minAge < ride.min_age) {
    checks.push({ key: 'AGE', ok: false, detail: `${age ?? `≤${minAge}`} < ${ride.min_age}` });
    return log(c, ride, sp, cred, ticket, null, 'DENIED', 'TOO_YOUNG', checks, tsnap, ctx, out, rideInfo);
  }
  if (ride.max_age != null && maxAge != null && maxAge > ride.max_age) {
    checks.push({ key: 'AGE', ok: false, detail: `${age ?? `≥${maxAge}`} > ${ride.max_age}` });
    return log(c, ride, sp, cred, ticket, null, 'DENIED', 'TOO_OLD', checks, tsnap, ctx, out, rideInfo);
  }
  if (ride.min_age != null || ride.max_age != null) checks.push({ key: 'AGE', ok: true, detail: age != null ? String(age) : 'by ticket type' });
  // Height: measured height on the wristband if recorded, else the ticket type's height band.
  const h = cred.height_cm ?? null;
  const hMax = h ?? ticket?.tt_max_height ?? null;
  const hMin = h ?? ticket?.tt_min_height ?? null;
  if (ride.min_height != null && hMax != null && hMax < ride.min_height) {
    checks.push({ key: 'HEIGHT', ok: false, detail: `${hMax} < ${ride.min_height} cm` });
    return log(c, ride, sp, cred, ticket, null, 'DENIED', 'TOO_SHORT', checks, tsnap, ctx, out, rideInfo);
  }
  if (ride.max_height != null && hMin != null && hMin > ride.max_height) {
    checks.push({ key: 'HEIGHT', ok: false, detail: `${hMin} > ${ride.max_height} cm` });
    return log(c, ride, sp, cred, ticket, null, 'DENIED', 'TOO_TALL', checks, tsnap, ctx, out, rideInfo);
  }
  if (ride.min_height != null || ride.max_height != null) checks.push({ key: 'HEIGHT', ok: true, detail: h != null ? `${h} cm` : 'verify visually' });

  const ents = await entitlementsFor(c, cred, tickets.map((t) => t.id));
  const pick = pickEntitlement(ents, ride.id, now);
  if (!pick) {
    const reason = hasExhausted(ents, ride.id) ? 'USES_EXHAUSTED' : 'NOT_INCLUDED';
    checks.push({ key: 'ENTITLEMENT', ok: false });
    let offer: RideScanResult['offer'] = null;
    if (ride.addon_enabled && ride.addon_price != null && sp.payment_enabled && settings.ride.allowAddonPurchase) {
      const member = cred.member_id ? await memberPricingCtx(c, cred.member_id) : null;
      const pr = await rideAddonPrice(c, ride, member, ride.branch_id);
      const methods = (sp.payment_methods as string[]).filter((m) => settings.parkPayment.methods[m]);
      offer = { price: pr.price, memberPriced: pr.memberPriced, methods, walletBalance: profile?.wallet ? Number(profile.wallet.balance) : null };
    }
    const r = await log(c, ride, sp, cred, ticket, null, 'NOT_INCLUDED', reason, checks, tsnap, ctx, out, rideInfo);
    return { ...r, offer };
  }
  // Virtual queue: a CALLED number boards now.
  let queueEntry: any = null;
  if (ride.queue_enabled) {
    queueEntry = await one<any>(`SELECT * FROM ride_queues WHERE ride_id=$1 AND credential_id=$2 AND status='CALLED' FOR UPDATE`, [ride.id, cred.id], c);
    if (queueEntry) {
      await query(`UPDATE ride_queues SET status='BOARDED', boarded_at=now(), ended_at=now() WHERE id=$1`, [queueEntry.id], c);
      checks.push({ key: 'QUEUE', ok: true, detail: queueEntry.queue_no });
    }
  }
  let usesLeft: number | null = pick.uses_left;
  if (pick.type === 'ONE_TIME' || pick.type === 'MULTI_USE') {
    const u = await one<any>(
      `UPDATE ride_entitlements SET uses_left = uses_left - 1, status = CASE WHEN uses_left - 1 = 0 THEN 'EXHAUSTED' ELSE status END
        WHERE id=$1 AND uses_left > 0 RETURNING uses_left`,
      [pick.id],
      c,
    );
    if (!u) throw conflict('ENTITLEMENT_RACE', 'Please scan again');
    usesLeft = u.uses_left;
  }
  checks.push({ key: 'ENTITLEMENT', ok: true, detail: usesLeft == null ? pick.type : `${usesLeft} left` });
  const r = await log(c, ride, sp, cred, ticket, pick, 'GRANTED', null, checks, tsnap, ctx, out, rideInfo);
  await query(`INSERT INTO ride_entitlement_usage (entitlement_id, ride_id, credential_id, access_log_id, operator_id, uses_left_after) VALUES ($1,$2,$3,$4,$5,$6)`, [
    pick.id, ride.id, cred.id, r.logId, ctx.staffId ?? null, usesLeft,
  ], c);
  if (cred.account_id) out.add(rooms.account(cred.account_id), EVENTS.CREDENTIAL_UPDATED, { credentialId: cred.id, reason: 'RIDE_USED', rideId: ride.id });
  return { ...r, entitlement: { id: pick.id, type: pick.type, usesLeft, validUntil: pick.valid_until ? new Date(pick.valid_until).toISOString() : null, fastPass: !!pick.is_fast_pass }, queue: queueEntry };
}

async function log(c: Tx, ride: any, sp: any, cred: any, ticket: any, ent: any, result: RideScanResult['result'], reason: string | null, checks: CheckResult[], snap: CustomerSnapshot, ctx: any, out: Outbox, rideInfo: any): Promise<RideScanResult> {
  const row = await one<any>(
    `INSERT INTO ride_access_logs (branch_id, ride_id, scan_point_id, credential_id, ticket_id, member_id, entitlement_id, result, reason_code, checks, operator_id, manual, device_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, created_at`,
    [ride.branch_id, ride.id, sp?.id ?? null, cred?.id ?? null, ticket?.id ?? null, cred?.member_id ?? ticket?.member_id ?? null, ent?.id ?? null, result, reason, JSON.stringify(checks), ctx.staffId ?? null, !!ctx.manual, ctx.deviceId ?? null],
    c,
  );
  if (sp?.id) await query(`UPDATE ride_scan_points SET last_scan_at=now() WHERE id=$1`, [sp.id], c);
  const ev = { logId: row.id, rideId: ride.id, scanPointId: sp?.id ?? null, result, reasonCode: reason, checks, customer: snap, at: row.created_at };
  out.add([rooms.ride(ride.id), rooms.branchRides(ride.branch_id), ...(sp?.id ? [rooms.scanPoint(sp.id)] : [])], EVENTS.RIDE_SCAN, ev);
  return { logId: row.id, result, reasonCode: reason, checks, customer: snap, ride: rideInfo };
}

export async function rideScan(scanPointId: string, raw: string | null, ctx: { deviceId?: string | null; staffId?: string | null; credentialId?: string | null; manual?: boolean }) {
  const out = new Outbox();
  const r = await tx(async (c) => rideScanTx(c, await loadScanPoint(c, scanPointId), raw, ctx, out));
  await out.flush();
  return r;
}

/**
 * BUY RIDE AT SCANNER. Wallet: sale + payment + entitlement + access grant in ONE transaction (the guest is
 * never charged without getting the ride). Other methods return a pending sale (PromptPay QR, card terminal,
 * cash request to the operator); once paid the scanner calls redeemSale() to grant access.
 */
export async function buyRideAtScanner(scanPointId: string, a: { raw?: string | null; credentialId?: string | null; method: 'WALLET' | 'PROMPTPAY' | 'CARD' | 'CASH'; idempotencyKey: string; deviceId?: string | null; staffId?: string | null; language?: any }) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const sp = await loadScanPoint(c, scanPointId);
    if (!sp.payment_enabled) throw conflict('PAYMENT_DISABLED', 'Purchases are disabled at this scanner');
    if (!(sp.payment_methods as string[]).includes(a.method)) throw badRequest('PAYMENT_METHOD_DISABLED');
    let cred: any = null;
    if (a.credentialId) cred = await one<any>(`SELECT * FROM credentials WHERE id=$1`, [a.credentialId], c);
    else {
      const res = await resolveScan(a.raw ?? '', c);
      if (!res.ok) throw conflict(res.reason!, 'Card / QR not valid');
      cred = res.credential;
    }
    if (!cred) throw notFound('Credential');
    const existing = await one<any>(`SELECT * FROM sales WHERE client_ref=$1`, [`ride:${a.idempotencyKey}`], c);
    const actor: ParkActor = a.staffId ? { type: 'STAFF', id: a.staffId } : { type: 'DEVICE', id: a.deviceId ?? null };
    const { sale } = existing
      ? { sale: existing }
      : await createSaleTx(c, {
          branchId: sp.branch_id, channel: 'RIDE', credentialId: cred.id, lines: [{ type: 'RIDE_ADDON', refId: sp.ride_id, qty: 1, meta: { credentialId: cred.id, scanPointId } }],
          clientRef: `ride:${a.idempotencyKey}`, staffId: a.staffId ?? null, deviceId: a.deviceId ?? null, language: a.language ?? 'th', expiresMinutes: (await parkSettings(sp.branch_id, c)).ride.pendingPaymentMinutes,
        }, out);
    if (sale.status === 'PAID') {
      const scan = await rideScanTx(c, sp, null, { credentialId: cred.id, deviceId: a.deviceId, staffId: a.staffId }, out);
      return { sale, payment: null, scan, completed: true };
    }
    const pay = await addPaymentTx(c, sale.id, { method: a.method, credentialId: cred.id, idempotencyKey: `ridepay:${a.idempotencyKey}` }, { actor, staffId: a.staffId, deviceId: a.deviceId, channel: 'RIDE' }, out);
    if (pay.completed) {
      const scan = await rideScanTx(c, sp, null, { credentialId: cred.id, deviceId: a.deviceId, staffId: a.staffId }, out);
      return { sale: pay.sale, payment: pay.payment, scan, completed: true };
    }
    return { sale: pay.sale, payment: { id: pay.payment.id, method: pay.payment.method, status: pay.payment.status, amount: Number(pay.payment.amount), qr_payload: pay.payment.qr_payload, expires_at: pay.payment.expires_at }, scan: null, completed: false };
  });
  await out.flush();
  return r;
}

/** After an external payment (PromptPay / card / cash) completes, grant the ride on the same screen. */
export async function redeemSaleAtScanner(scanPointId: string, saleId: string, ctx: { deviceId?: string | null; staffId?: string | null }) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const sale = await one<any>(`SELECT * FROM sales WHERE id=$1`, [saleId], c);
    if (!sale) throw notFound('Sale');
    if (sale.status !== 'PAID') return { paid: false, status: sale.status };
    const sp = await loadScanPoint(c, scanPointId);
    const item = await one<any>(`SELECT * FROM sale_items WHERE sale_id=$1 AND item_type='RIDE_ADDON' AND ref_id=$2`, [saleId, sp.ride_id], c);
    if (!item) throw badRequest('SALE_NOT_FOR_RIDE');
    const credId = item.meta?.credentialId ?? sale.credential_id;
    // Already redeemed? (each purchase grants exactly its uses)
    const ent = await one<any>(`SELECT * FROM ride_entitlements WHERE sale_item_id=$1`, [item.id], c);
    if (ent && ent.uses_total != null && ent.uses_left < ent.uses_total) return { paid: true, alreadyRedeemed: true };
    const scan = await rideScanTx(c, sp, null, { credentialId: credId, deviceId: ctx.deviceId, staffId: ctx.staffId }, out);
    return { paid: true, scan };
  });
  await out.flush();
  return r;
}

/** Ride operator: OPEN / CLOSED / MAINTENANCE / TEMPORARILY_CLOSED and pause entry. */
export async function setRideStatus(rideId: string, a: { status?: string; paused?: boolean; reason?: string | null }, actor: ParkActor) {
  const out = new Outbox();
  const ride = await tx(async (c) => {
    const r = await one<any>(`SELECT * FROM rides WHERE id=$1 FOR UPDATE`, [rideId], c);
    if (!r) throw notFound('Ride');
    const status = a.status ?? r.status;
    const paused = a.paused ?? r.entry_paused;
    const row = await one<any>(
      `UPDATE rides SET status=$2, entry_paused=$3, status_changed_at = CASE WHEN status<>$2 THEN now() ELSE status_changed_at END WHERE id=$1 RETURNING *`,
      [rideId, status, paused],
      c,
    );
    out.add([rooms.ride(rideId), rooms.branchRides(r.branch_id), rooms.branchAdmin(r.branch_id), rooms.branchPublic(r.branch_id)], EVENTS.RIDE_UPDATED, { rideId, status, paused, reason: a.reason ?? null });
    if (r.status === 'OPEN' && status !== 'OPEN') {
      await notify({
        audience: 'STAFF', branchId: r.branch_id, type: 'RIDE_CLOSED', severity: status === 'MAINTENANCE' ? 'WARNING' : 'INFO',
        title: { th: `${r.name.th ?? r.code} ปิด (${status})`, en: `${r.name.en ?? r.code} ${status}`, zh: `${r.name.zh ?? r.code} ${status}` },
        body: { th: a.reason ?? '', en: a.reason ?? '', zh: a.reason ?? '' },
        data: { rideId, by: actor.name ?? null },
      }, c, out);
    }
    return row;
  });
  await out.flush();
  return ride;
}

/** Ride board (operator / dashboard / public map). */
export async function rideBoard(db: Db, branchId: string) {
  const s = await parkSettings(branchId, db);
  const rows = await query<any>(
    `SELECT r.id, r.code, r.name, r.image_url, r.zone_id, r.status, r.entry_paused, r.capacity, r.duration_minutes, r.queue_enabled, r.addon_price, r.member_price,
            r.min_height, r.max_height, r.min_age, r.max_age, r.map, r.sort, z.name AS zone_name, u.name AS operator_name,
            (SELECT COUNT(*)::int FROM ride_queues q WHERE q.ride_id=r.id AND q.status='WAITING') AS queue_waiting,
            (SELECT COUNT(*)::int FROM ride_queues q WHERE q.ride_id=r.id AND q.status='CALLED') AS queue_called,
            (SELECT COUNT(*)::int FROM ride_access_logs l WHERE l.ride_id=r.id AND l.result='GRANTED' AND l.created_at > date_trunc('day', now())) AS guests_today,
            (SELECT COUNT(*)::int FROM ride_access_logs l WHERE l.ride_id=r.id AND l.result='GRANTED' AND l.created_at > now() - interval '1 hour') AS guests_last_hour,
            (SELECT max(created_at) FROM ride_access_logs l WHERE l.ride_id=r.id) AS last_scan_at
       FROM rides r LEFT JOIN zones z ON z.id=r.zone_id LEFT JOIN users u ON u.id=r.operator_id
      WHERE r.branch_id=$1 AND r.is_active ORDER BY r.sort, r.code`,
    [branchId],
    db,
  );
  return rows.map((r) => ({
    ...r,
    wait_minutes: Math.ceil(Math.ceil(r.queue_waiting / Math.max(1, r.capacity)) * Number(r.duration_minutes)),
    queue_too_long: Math.ceil(Math.ceil(r.queue_waiting / Math.max(1, r.capacity)) * Number(r.duration_minutes)) >= s.notification.queueTooLongMinutes,
  }));
}

export { pool };
