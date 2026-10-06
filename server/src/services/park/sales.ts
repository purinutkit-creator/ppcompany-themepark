import crypto from 'node:crypto';
import {
  buildPromptPayPayload,
  EVENTS,
  priceParkCart,
  rooms,
  type I18nText,
  type Lang,
  type ParkLine,
  type ParkMemberCtx,
  type SaleChannel,
  type SaleItemType,
} from '@kiosk/shared';
import { one, pool, query, tx, type Db, type Tx } from '../../db/pool';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { Outbox } from '../../lib/realtime';
import { getSettings } from '../../lib/settings';
import { getProvider } from '../providers';
import { branchInfo, branchToday, createAccount, genPaymentNo, genRefundNo, genSaleNo, genTicketNo, parkSettings, round2, type ParkActor } from './common';
import { checkPackageAvailability, loadPackage, loadParkPromotions, packagePriceRow, resolvePackagePrice, rideAddonPrice } from './catalog';
import { effectiveStatus, issueCredential, payloadsFor, resolveScan } from './credentials';
import { createAddonEntitlement, createTicketEntitlements, packageBenefits } from './entitlements';
import { applyMembership, memberPricingCtx, membershipQuote } from './members';
import { notify } from './notifications';
import { announcePoints, computeEarn, pointsPost } from './points';
import { announceWallet, walletPost } from './wallet';
import { deductInventory, returnInventory } from './inventory';
import { endLockerSessionTx, startLockerSessionTx } from './lockers';
import { printSaleDocuments } from './print';

export interface SaleLineInput {
  type: SaleItemType;
  refId?: string | null;
  ticketTypeId?: string | null;
  qty: number;
  amount?: number | null;
  meta?: Record<string, any>;
}

export interface SaleCreateInput {
  branchId: string;
  channel: SaleChannel;
  storeId?: string | null;
  credentialId?: string | null;
  credentialPayload?: string | null;
  memberId?: string | null;
  accountId?: string | null;
  customer?: { name?: string | null; phone?: string | null; email?: string | null };
  lines: SaleLineInput[];
  codes?: string[];
  visitDate?: string | null;
  clientRef?: string | null;
  language?: Lang;
  staffId?: string | null;
  deviceId?: string | null;
  printerId?: string | null;
  manualDiscount?: { amount: number; reason: string } | null;
  note?: string | null;
  expiresMinutes?: number | null;
  /** Booking flow creates tickets with this booking id later. */
  forBooking?: boolean;
  /** Free (zero total) sales complete immediately. */
  autoCompleteZero?: boolean;
}

export interface SaleCtx {
  actor: ParkActor;
  staffId?: string | null;
  deviceId?: string | null;
  channel?: string | null;
}

const OPEN_PAYMENT = ['PENDING', 'WAITING_VERIFICATION', 'WAITING_CASH', 'WAITING_CARD', 'PROCESSING'];
const KIND_BY_TYPE: Record<string, string> = {
  PACKAGE: 'TICKET', MEMBERSHIP: 'MEMBERSHIP', MEMBERSHIP_RENEWAL: 'MEMBERSHIP', MEMBERSHIP_UPGRADE: 'MEMBERSHIP', TOPUP: 'TOPUP',
  PRODUCT: 'RETAIL', SERVICE: 'RETAIL', LOCKER: 'LOCKER', RIDE_ADDON: 'RIDE_ADDON',
};
const BENEFIT_BY_PRODUCT: Record<string, string> = { FOOD: 'FOOD', DRINK: 'FOOD', LOCKER: 'LOCKER' };

interface ResolvedLine {
  input: SaleLineInput;
  itemType: SaleItemType;
  refId: string | null;
  sku: string | null;
  name: I18nText;
  qty: number;
  unitPrice: number;
  basePrice: number;
  pointsCategory: string;
  benefitCategory?: string;
  discountable: boolean;
  explicitOnly: boolean;
  ticketTypeId: string | null;
  categoryId: string | null;
  meta: Record<string, any>;
  pkg?: any;
}

/** Resolve who the sale is for: scanned credential → account / member; or a logged-in member. */
async function resolveParty(db: Db, input: SaleCreateInput) {
  let credential: any = null;
  if (input.credentialPayload) {
    const r = await resolveScan(input.credentialPayload, db, { allowStaticDigital: input.channel !== 'RIDE' });
    if (!r.ok) throw conflict(r.reason!, 'Card / QR not valid');
    credential = r.credential;
  } else if (input.credentialId) {
    credential = await one<any>(`SELECT * FROM credentials WHERE id=$1`, [input.credentialId], db);
    if (!credential) throw notFound('Credential');
  }
  if (credential) {
    const st = await effectiveStatus(db, credential);
    if (st !== 'ACTIVE') throw conflict(`CARD_${st}`, `Card is ${st}`);
  }
  let memberId = input.memberId ?? credential?.member_id ?? null;
  let accountId = input.accountId ?? credential?.account_id ?? null;
  if (memberId && !accountId) accountId = (await one<any>(`SELECT account_id FROM members WHERE id=$1`, [memberId], db))?.account_id ?? null;
  if (!memberId && accountId) memberId = (await one<any>(`SELECT id FROM members WHERE account_id=$1`, [accountId], db))?.id ?? null;
  const member = memberId ? await one<any>(`SELECT id, account_id, first_name, last_name, phone, email, tier_id, status FROM members WHERE id=$1`, [memberId], db) : null;
  if (member && member.status !== 'ACTIVE') throw conflict('MEMBER_NOT_ACTIVE');
  return { credential, memberId, accountId, member };
}

async function resolveLines(db: Db, input: SaleCreateInput, party: Awaited<ReturnType<typeof resolveParty>>, member: ParkMemberCtx | null, today: string) {
  const s = await parkSettings(input.branchId, db);
  const out: ResolvedLine[] = [];
  for (const l of input.lines) {
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 100) throw badRequest('INVALID_QTY');
    const meta = { ...(l.meta ?? {}) };
    if (l.type === 'PACKAGE') {
      const pkg = await loadPackage(db, l.refId!);
      const visitDate = pkg.requires_visit_date ? (meta.visitDate ?? input.visitDate ?? today) : null;
      if (pkg.member_only && !party.memberId) throw forbidden('MEMBERS_ONLY', 'This package is for members only');
      if (pkg.tier_ids?.length && !(member?.tierId && pkg.tier_ids.includes(member.tierId))) throw forbidden('TIER_REQUIRED', 'Your membership tier cannot buy this package');
      if (l.qty < pkg.min_qty || l.qty > pkg.max_qty) throw badRequest('INVALID_QTY', `Quantity must be ${pkg.min_qty}–${pkg.max_qty}`);
      const guests = pkg.kind === 'ADMISSION' ? l.qty * pkg.guests_per_unit : 0;
      const av = await checkPackageAvailability(db, pkg, input.branchId, visitDate, input.channel, guests);
      if (!av.available) throw conflict(av.reason ?? 'UNAVAILABLE', `Package not available: ${av.reason}`, { packageId: pkg.id, remaining: av.remaining });
      const priceRow = await packagePriceRow(db, pkg.id, l.ticketTypeId ?? null);
      const pr = resolvePackagePrice(priceRow, visitDate, member);
      const tt = l.ticketTypeId ? await one<any>(`SELECT name FROM ticket_types WHERE id=$1`, [l.ticketTypeId], db) : null;
      const name: I18nText = tt
        ? { th: `${pkg.name.th ?? ''} - ${tt.name.th ?? ''}`, en: `${pkg.name.en ?? ''} - ${tt.name.en ?? ''}`, zh: `${pkg.name.zh ?? ''} - ${tt.name.zh ?? ''}` }
        : pkg.name;
      out.push({
        input: l, itemType: 'PACKAGE', refId: pkg.id, sku: pkg.code, name, qty: l.qty, unitPrice: pr.unit, basePrice: pr.base,
        pointsCategory: pkg.kind === 'ADMISSION' ? 'TICKET' : 'PACKAGE', benefitCategory: pr.memberPriced ? undefined : 'TICKET',
        discountable: true, explicitOnly: false, ticketTypeId: l.ticketTypeId ?? null, categoryId: null, meta: { ...meta, visitDate, kind: pkg.kind }, pkg,
      });
    } else if (l.type === 'MEMBERSHIP' || l.type === 'MEMBERSHIP_RENEWAL' || l.type === 'MEMBERSHIP_UPGRADE') {
      if (!party.memberId) throw badRequest('MEMBER_REQUIRED', 'Register or select the member first');
      const kind = l.type === 'MEMBERSHIP' ? 'NEW' : l.type === 'MEMBERSHIP_RENEWAL' ? 'RENEWAL' : 'UPGRADE';
      const q = await membershipQuote(db, party.memberId, kind, l.refId!, today);
      out.push({
        input: l, itemType: l.type, refId: q.product.id, sku: q.product.code, name: q.product.name, qty: 1, unitPrice: q.price, basePrice: q.base,
        pointsCategory: 'MEMBERSHIP', discountable: true, explicitOnly: true, ticketTypeId: null, categoryId: null, meta: { ...meta, kind, note: q.note },
      });
    } else if (l.type === 'TOPUP') {
      if (!party.accountId) throw badRequest('CARD_REQUIRED', 'Scan the card / wristband to top up');
      const amount = round2(Number(l.amount ?? 0));
      if (!(amount >= s.wallet.minTopup) || amount > s.wallet.maxTopup) throw badRequest('INVALID_TOPUP_AMOUNT', `Top-up must be ${s.wallet.minTopup}–${s.wallet.maxTopup}`);
      out.push({
        input: l, itemType: 'TOPUP', refId: party.accountId, sku: 'TOPUP', name: { th: 'เติมเงินเข้าบัตร', en: 'Wallet top-up', zh: '钱包充值' }, qty: 1,
        unitPrice: amount, basePrice: amount, pointsCategory: 'TOPUP', discountable: false, explicitOnly: false, ticketTypeId: null, categoryId: null, meta: { ...meta, amount },
      });
    } else if (l.type === 'PRODUCT' || l.type === 'SERVICE') {
      const p = await one<any>(
        `SELECT p.*, COALESCE(json_object_agg(t.lang, t.name) FILTER (WHERE t.lang IS NOT NULL), '{}') AS names,
                (SELECT qty FROM inventory i WHERE i.product_id=p.id AND i.store_id=$2) AS store_qty
           FROM products p LEFT JOIN product_translations t ON t.product_id=p.id WHERE p.id=$1 AND p.deleted_at IS NULL GROUP BY p.id`,
        [l.refId, input.storeId ?? null],
        db,
      );
      if (!p || p.status !== 'AVAILABLE') throw conflict('PRODUCT_UNAVAILABLE', 'Product is not available', { productId: l.refId });
      if (input.storeId) {
        const st = await one<any>(`SELECT category_ids FROM stores WHERE id=$1`, [input.storeId], db);
        if (st?.category_ids?.length && !st.category_ids.includes(p.category_id)) throw conflict('PRODUCT_NOT_IN_STORE', 'Product is not sold in this store');
        if (p.track_stock && Number(p.store_qty ?? 0) < l.qty) throw conflict('OUT_OF_STOCK', 'Not enough stock', { productId: p.id, available: Number(p.store_qty ?? 0) });
      }
      const cat = BENEFIT_BY_PRODUCT[p.product_type] ?? 'RETAIL';
      out.push({
        input: l, itemType: 'PRODUCT', refId: p.id, sku: p.sku, name: p.names, qty: l.qty, unitPrice: Number(p.price), basePrice: Number(p.price),
        pointsCategory: cat, benefitCategory: cat, discountable: true, explicitOnly: false, ticketTypeId: null, categoryId: p.category_id, meta: { ...meta, productType: p.product_type, trackStock: p.track_stock },
      });
    } else if (l.type === 'LOCKER') {
      if (!party.credential && !meta.credentialId) throw badRequest('CARD_REQUIRED', 'Scan the card / wristband that will open the locker');
      const rate = await one<any>(`SELECT * FROM locker_rates WHERE id=$1 AND is_active`, [l.refId], db);
      if (!rate) throw notFound('Locker rate');
      if (meta.lockerId) {
        const lk = await one<any>(`SELECT status, size, branch_id FROM lockers WHERE id=$1 AND is_active`, [meta.lockerId], db);
        if (!lk || lk.branch_id !== input.branchId) throw notFound('Locker');
        if (lk.status !== 'AVAILABLE') throw conflict('LOCKER_TAKEN', 'Locker is not available');
      }
      const price = party.memberId && rate.member_price != null ? Number(rate.member_price) : Number(rate.price);
      out.push({
        input: l, itemType: 'LOCKER', refId: rate.id, sku: 'LOCKER', name: { th: `ล็อกเกอร์ ${rate.label.th ?? ''}`, en: `Locker ${rate.label.en ?? ''}`, zh: `储物柜 ${rate.label.zh ?? ''}` },
        qty: 1, unitPrice: price, basePrice: Number(rate.price), pointsCategory: 'LOCKER', benefitCategory: party.memberId && rate.member_price != null ? undefined : 'LOCKER',
        discountable: true, explicitOnly: false, ticketTypeId: null, categoryId: null, meta: { ...meta, minutes: rate.minutes, size: rate.size, credentialId: meta.credentialId ?? party.credential?.id },
      });
    } else if (l.type === 'RIDE_ADDON') {
      const ride = await one<any>(`SELECT * FROM rides WHERE id=$1 AND is_active`, [l.refId], db);
      if (!ride || ride.branch_id !== input.branchId) throw notFound('Ride');
      if (!party.credential && !meta.credentialId) throw badRequest('CARD_REQUIRED', 'Scan the card / wristband');
      const pr = await rideAddonPrice(db, ride, member, input.branchId);
      out.push({
        input: l, itemType: 'RIDE_ADDON', refId: ride.id, sku: ride.code, name: ride.name, qty: l.qty, unitPrice: pr.price, basePrice: Number(ride.addon_price),
        pointsCategory: 'RIDE', benefitCategory: pr.memberPriced ? undefined : 'RIDE', discountable: true, explicitOnly: false, ticketTypeId: null, categoryId: null,
        meta: { ...meta, credentialId: meta.credentialId ?? party.credential?.id, peak: pr.peak },
      });
    } else throw badRequest('UNSUPPORTED_ITEM');
  }
  return out;
}

/** Build + price a sale (no writes). Used for quotes and inside createSale. */
export async function buildSale(db: Db, input: SaleCreateInput) {
  if (!input.lines.length) throw badRequest('EMPTY_CART', 'Cart is empty');
  const settings = await parkSettings(input.branchId, db);
  const b = await branchInfo(input.branchId, db);
  const today = await branchToday(input.branchId, db);
  const party = await resolveParty(db, input);
  const memberCtx = await memberPricingCtx(db, party.memberId);
  const lines = await resolveLines(db, input, party, memberCtx, today);
  const codes = [...new Set((input.codes ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean))];
  const couponPromotions: Record<string, { promotionId: string; couponId: string }> = {};
  for (const code of codes) {
    const cp = await one<any>(
      `SELECT id, promotion_id, member_id FROM coupons WHERE upper(code)=$1 AND status='ACTIVE' AND used_count < max_uses
         AND (valid_from IS NULL OR valid_from <= $2::date) AND (valid_to IS NULL OR valid_to >= $2::date)`,
      [code, today],
      db,
    );
    if (cp && (!cp.member_id || cp.member_id === party.memberId)) couponPromotions[code] = { promotionId: cp.promotion_id, couponId: cp.id };
  }
  const parkLines: ParkLine[] = lines.map((l, i) => ({
    key: String(i), itemType: l.itemType, refId: l.refId, ticketTypeId: l.ticketTypeId, categoryId: l.categoryId, qty: l.qty, unitPrice: l.unitPrice,
    discountable: l.discountable, explicitOnly: l.explicitOnly, benefitCategory: l.benefitCategory,
  }));
  const visitDate = input.visitDate ?? lines.find((l) => l.meta.visitDate)?.meta.visitDate ?? null;
  const pricing = priceParkCart(parkLines, {
    promotions: await loadParkPromotions(db),
    channel: input.channel,
    branchId: input.branchId,
    tax: { vatRate: settings.tax.vatRate, vatMode: 'INCLUDED' },
    timeZone: b.timezone,
    visitDate,
    member: memberCtx,
    codes,
    couponPromotions,
    memberDiscount: { priority: settings.member.discountPriority, stackable: settings.member.discountStackable },
  });
  let manual = 0;
  if (input.manualDiscount && input.manualDiscount.amount > 0) {
    manual = Math.min(round2(input.manualDiscount.amount), pricing.total);
    // Spread proportionally over discountable lines for refund math.
    const net = pricing.lines.filter((l) => l.discountable !== false).reduce((s, l) => s + l.net, 0);
    let left = manual;
    const ds = pricing.lines.filter((l) => l.discountable !== false && l.net > 0);
    ds.forEach((l, i) => {
      const d = i === ds.length - 1 ? left : round2((manual * l.net) / Math.max(net, 0.01));
      l.discount = round2(l.discount + d);
      l.net = round2(l.net - d);
      left = round2(left - d);
    });
    pricing.discount = round2(pricing.discount + manual);
    pricing.total = round2(pricing.total - manual);
    pricing.vat = round2((pricing.total * settings.tax.vatRate) / (100 + settings.tax.vatRate));
    pricing.applied.push({ promotionId: 'manual', name: { th: 'ส่วนลดพิเศษ', en: 'Manual discount', zh: '手动折扣' }, amount: manual, kind: 'PROMOTION', code: null });
  }
  return { lines, pricing, party, memberCtx, today, timezone: b.timezone, settings, visitDate };
}

export async function quoteSale(input: SaleCreateInput) {
  const r = await buildSale(pool, input);
  return {
    lines: r.lines.map((l, i) => ({
      type: l.itemType, refId: l.refId, name: l.name, qty: l.qty, unitPrice: l.unitPrice, basePrice: l.basePrice,
      discount: r.pricing.lines[i].discount, total: r.pricing.lines[i].net, meta: l.meta,
    })),
    subtotal: r.pricing.subtotal,
    discount: r.pricing.discount,
    vat: r.pricing.vat,
    total: r.pricing.total,
    promotions: r.pricing.applied,
    invalidCodes: r.pricing.invalidCodes,
    member: r.party.member ? { id: r.party.member.id, name: `${r.party.member.first_name} ${r.party.member.last_name}`.trim() } : null,
  };
}

/** Create the sale (and, for admission packages, UNPAID tickets that hold capacity). Idempotent on clientRef. */
export async function createSaleTx(c: Tx, input: SaleCreateInput, out: Outbox) {
  if (input.clientRef) {
    const dup = await one<any>(`SELECT * FROM sales WHERE client_ref=$1`, [input.clientRef], c);
    if (dup) return { sale: dup, duplicate: true };
  }
  // Serialise capacity checks per branch + visit date (advisory lock released at COMMIT).
  const dates = new Set<string>();
  for (const l of input.lines) if (l.type === 'PACKAGE') dates.add(l.meta?.visitDate ?? input.visitDate ?? 'today');
  for (const d of dates) await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`cap:${input.branchId}:${d}`]);
  const r = await buildSale(c, input);
  if (r.pricing.invalidCodes.length) throw badRequest('INVALID_PROMO_CODE', `Invalid or expired code: ${r.pricing.invalidCodes.join(', ')}`, { codes: r.pricing.invalidCodes });
  if (['ONLINE', 'PORTAL'].includes(input.channel) && r.settings.park.stopOnlineSalesWhenFull && r.lines.some((l) => l.meta.visitDate === r.today && l.meta.kind === 'ADMISSION')) {
    const inside = await one<any>(`SELECT COUNT(*)::int AS n FROM tickets WHERE branch_id=$1 AND presence <> 'OUTSIDE'`, [input.branchId], c);
    if (inside.n >= r.settings.park.maxCapacity) throw conflict('PARK_FULL', 'The park is at capacity today — online sales are paused');
  }
  const kinds = new Set(r.lines.map((l) => KIND_BY_TYPE[l.itemType]));
  const kind = input.forBooking ? 'BOOKING' : kinds.size === 1 ? [...kinds][0] : 'MIXED';
  const shift = input.staffId ? await one<any>(`SELECT id FROM shifts WHERE user_id=$1 AND status='OPEN'`, [input.staffId], c) : null;
  const holdMin = input.expiresMinutes ?? (['ONLINE', 'PORTAL', 'KIOSK', 'RIDE'].includes(input.channel) ? r.settings.booking.holdMinutes : null);
  if (!r.party.accountId && r.lines.some((l) => l.itemType === 'PACKAGE' && l.pkg?.kind === 'ADMISSION')) {
    // Every admission sale gets an account so its tickets / wristbands share one wallet (guest wallet).
    r.party.accountId = (await createAccount(c, { branchId: input.branchId, kind: 'GUEST', name: input.customer?.name, phone: input.customer?.phone, email: input.customer?.email })).id;
  }
  const sale = await one<any>(
    `INSERT INTO sales (sale_no, branch_id, store_id, channel, kind, account_id, member_id, credential_id, customer_name, phone, email, subtotal, discount, vat,
        vat_rate, total, applied_promotions, coupon_codes, language, shift_id, device_id, printer_id, client_ref, note, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
             CASE WHEN $26::int IS NULL THEN NULL ELSE now() + ($26::int || ' minutes')::interval END) RETURNING *`,
    [await genSaleNo(c, r.today), input.branchId, input.storeId ?? null, input.channel, kind, r.party.accountId, r.party.memberId, r.party.credential?.id ?? null,
     input.customer?.name ?? (r.party.member ? `${r.party.member.first_name} ${r.party.member.last_name}`.trim() : null), input.customer?.phone ?? r.party.member?.phone ?? null,
     input.customer?.email ?? r.party.member?.email ?? null, r.pricing.subtotal, r.pricing.discount, r.pricing.vat, r.settings.tax.vatRate, r.pricing.total,
     JSON.stringify(r.pricing.applied), Object.keys(Object.fromEntries(r.pricing.applied.filter((a) => a.code).map((a) => [a.code, 1]))), input.language ?? 'th',
     shift?.id ?? null, input.deviceId ?? null, input.printerId ?? null, input.clientRef ?? null, input.note ?? null, input.staffId ?? null, holdMin],
    c,
  );
  for (let i = 0; i < r.lines.length; i++) {
    const l = r.lines[i];
    const p = r.pricing.lines[i];
    const item = await one<any>(
      `INSERT INTO sale_items (sale_id, item_type, ref_id, sku, name, qty, base_price, unit_price, discount, line_total, points_category, meta, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [sale.id, l.itemType, l.refId, l.sku, JSON.stringify(l.name), l.qty, l.basePrice, l.unitPrice, p.discount, p.net, l.pointsCategory, JSON.stringify(l.meta), i],
      c,
    );
    if (l.itemType === 'PACKAGE' && l.pkg.kind === 'ADMISSION') await createTicketsForLine(c, sale, item, l, r.today);
  }
  out.add([rooms.branchAdmin(input.branchId)], EVENTS.SALE_UPDATED, { saleId: sale.id, saleNo: sale.sale_no, status: sale.status });
  if (Number(sale.total) === 0 && input.autoCompleteZero !== false) {
    await completeSaleTx(c, sale.id, out, { strict: true, actor: { type: 'SYSTEM' } });
    return { sale: await one<any>(`SELECT * FROM sales WHERE id=$1`, [sale.id], c), duplicate: false };
  }
  return { sale, duplicate: false };
}

/** One UNPAID ticket per guest (bundles expand, e.g. FAMILY = 2 adults + 2 children). */
async function createTicketsForLine(c: Tx, sale: any, item: any, l: ResolvedLine, today: string) {
  const pkg = l.pkg;
  const visit = l.meta.visitDate as string;
  const validTo = pkg.usage_mode === 'FLEX_DAYS' ? addDaysStr(visit, Math.max(pkg.flex_window_days, pkg.days) - 1) : addDaysStr(visit, pkg.days - 1);
  const composition: { ticketTypeId: string | null; count: number }[] = [];
  const bundle = pkg.bundle && Object.keys(pkg.bundle).length ? pkg.bundle : null;
  if (bundle) {
    for (const [code, n] of Object.entries(bundle)) {
      const tt = await one<any>(`SELECT id FROM ticket_types WHERE code=$1`, [code], c);
      composition.push({ ticketTypeId: tt?.id ?? null, count: Number(n) });
    }
  } else composition.push({ ticketTypeId: l.ticketTypeId, count: pkg.guests_per_unit });
  const perUnitGuests = composition.reduce((s, x) => s + x.count, 0);
  const totalGuests = perUnitGuests * l.qty;
  const pricePer = round2(Number(item.line_total) / Math.max(1, totalGuests));
  const names: string[] = Array.isArray(l.meta.guestNames) ? l.meta.guestNames : [];
  let idx = 0;
  for (let u = 0; u < l.qty; u++) {
    for (const comp of composition) {
      for (let k = 0; k < comp.count; k++) {
        const no = await genTicketNo(c, today);
        const t = await one<any>(
          `INSERT INTO tickets (ticket_no, branch_id, sale_id, sale_item_id, account_id, member_id, package_id, ticket_type_id, guest_name, visit_date, valid_from, valid_to,
              days_allowed, entries_per_day, time_start, time_end, reentry, transferable, zone_ids, status, price)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,$16,$17,$18,'UNPAID',$19) RETURNING *`,
          [no, sale.branch_id, sale.id, item.id, sale.account_id, sale.member_id, pkg.id, comp.ticketTypeId, names[idx] ?? null, visit, validTo, pkg.days,
           pkg.entries_per_day, pkg.time_start, pkg.time_end, pkg.reentry, pkg.transferable, pkg.zone_ids ?? [], pricePer],
          c,
        );
        const cred = await issueCredential(c, { type: 'QR_TICKET', code: no, branchId: sale.branch_id, accountId: sale.account_id, memberId: sale.member_id, status: 'ACTIVE' });
        await query(`UPDATE tickets SET credential_id=$2 WHERE id=$1`, [t.id, cred.id], c);
        idx++;
      }
    }
  }
}

function addDaysStr(d: string, n: number) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

export async function createSale(input: SaleCreateInput) {
  const out = new Outbox();
  try {
    const r = await tx((c) => createSaleTx(c, input, out));
    await out.flush();
    return r;
  } catch (e: any) {
    if (e?.code === '23505' && String(e?.constraint).includes('client_ref') && input.clientRef) {
      const sale = await one<any>(`SELECT * FROM sales WHERE client_ref=$1`, [input.clientRef]);
      if (sale) return { sale, duplicate: true };
    }
    throw e;
  }
}

// ------------------------------------------------------------------ payments
export interface PaymentInput {
  method: 'CASH' | 'PROMPTPAY' | 'CARD' | 'EWALLET' | 'BANK_TRANSFER' | 'MOBILE_BANKING' | 'WALLET' | 'POINTS' | 'VOUCHER' | 'COMP';
  amount?: number | null;
  received?: number | null;
  credentialPayload?: string | null;
  credentialId?: string | null;
  reference?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  approvalCode?: string | null;
  /** Counter EDC / manual card: staff confirms the terminal approved it. */
  confirmNow?: boolean;
  idempotencyKey?: string | null;
  /** Wallet payment from a logged-in member (portal) — uses the member's own account. */
  ownAccountId?: string | null;
}

async function lockSale(c: Tx, saleId: string) {
  const s = await one<any>(`SELECT * FROM sales WHERE id=$1 FOR UPDATE`, [saleId], c);
  if (!s) throw notFound('Sale');
  return s;
}

async function requireShift(c: Tx, staffId: string | null | undefined, branchId: string) {
  const s = await getSettings(c);
  if (!staffId) return null;
  const shift = await one<any>(`SELECT * FROM shifts WHERE user_id=$1 AND status='OPEN'`, [staffId], c);
  if (!shift && s.shift.requireForCash) throw conflict('SHIFT_REQUIRED', 'Open a shift before taking cash');
  if (shift && shift.branch_id !== branchId) throw conflict('SHIFT_OTHER_BRANCH');
  return shift;
}

/**
 * Add a payment to a sale (split payments supported). Immediate methods (staff cash, wallet, points,
 * confirmed EDC card, comp) are PAID inside this transaction; external ones (PromptPay, gateway card,
 * e-wallet, transfer) are created PENDING and confirmed later by verification / webhook. When the paid
 * amount reaches the total the sale is completed (fulfilment, points, receipts) in the same transaction.
 */
export async function addPayment(saleId: string, p: PaymentInput, ctx: SaleCtx) {
  const out = new Outbox();
  const res = await tx((c) => addPaymentTx(c, saleId, p, ctx, out));
  await out.flush();
  return res;
}

export async function addPaymentTx(c: Tx, saleId: string, p: PaymentInput, ctx: SaleCtx, out: Outbox) {
  // Lock first: a concurrent duplicate (double tap) waits here, then sees the first payment as a replay.
  const sale = await lockSale(c, saleId);
  if (p.idempotencyKey) {
    const dup = await one<any>(`SELECT * FROM sale_payments WHERE idempotency_key=$1`, [p.idempotencyKey], c);
    if (dup) {
      if (dup.sale_id !== saleId) throw conflict('IDEMPOTENCY_KEY_REUSED');
      return { payment: dup, sale: await one<any>(`SELECT * FROM sales WHERE id=$1`, [saleId], c), replay: true, completed: false };
    }
  }
  if (sale.status === 'PAID') throw conflict('ALREADY_PAID', 'Sale is already paid');
  if (!['OPEN', 'PENDING_PAYMENT'].includes(sale.status)) throw conflict('SALE_NOT_PAYABLE', `Sale is ${sale.status}`);
  const settings = await parkSettings(sale.branch_id, c);
  if (!settings.parkPayment.methods[p.method] && p.method !== 'COMP') throw badRequest('PAYMENT_METHOD_DISABLED', `${p.method} is disabled`);
  const outstanding = round2(Number(sale.total) - Number(sale.paid_amount));
  if (outstanding <= 0) throw conflict('NOTHING_DUE');
  let amount = round2(p.amount ?? outstanding);
  if (p.method === 'CASH' && p.received != null && p.amount == null) amount = Math.min(round2(p.received), outstanding);
  if (!(amount > 0) || amount > outstanding + 0.001) throw badRequest('INVALID_AMOUNT', `Amount must be between 0.01 and ${outstanding}`);
  const isStaff = ctx.actor.type === 'STAFF';
  const today = await branchToday(sale.branch_id, c);
  const base = {
    id: crypto.randomUUID(),
    payment_no: await genPaymentNo(c, today),
    channel: ctx.channel ?? sale.channel,
    cashier_id: isStaff ? ctx.staffId ?? null : null,
    device_id: ctx.deviceId ?? null,
  };
  let status = 'PENDING';
  let provider: string = p.method;
  let qr: string | null = null;
  let providerTxnId: string | null = null;
  let expiresAt: Date | null = null;
  let ledgerId: string | null = null;
  let pointsUsed: number | null = null;
  let shiftId: string | null = null;
  let received: number | null = null;
  let change: number | null = null;

  if (p.method === 'CASH') {
    if (isStaff) {
      const shift = await requireShift(c, ctx.staffId, sale.branch_id);
      shiftId = shift?.id ?? null;
      received = round2(p.received ?? amount);
      if (received + 0.001 < amount) throw badRequest('INSUFFICIENT_CASH', 'Received amount is less than the amount due');
      change = round2(received - amount);
      status = 'PAID';
    } else status = 'WAITING_CASH';
  } else if (p.method === 'WALLET') {
    if (sale.kind === 'TOPUP' || (await one(`SELECT 1 FROM sale_items WHERE sale_id=$1 AND item_type='TOPUP'`, [sale.id], c))) throw badRequest('WALLET_FOR_TOPUP', 'A top-up cannot be paid from the wallet');
    let accountId = p.ownAccountId ?? null;
    let credentialId: string | null = null;
    if (!accountId) {
      let cred: any = null;
      if (p.credentialPayload) {
        const r = await resolveScan(p.credentialPayload, c, { allowStaticDigital: isStaff });
        if (!r.ok) throw conflict(r.reason!, 'Card / QR not valid');
        cred = r.credential;
      } else if (p.credentialId) cred = await one<any>(`SELECT * FROM credentials WHERE id=$1`, [p.credentialId], c);
      else if (sale.credential_id) cred = await one<any>(`SELECT * FROM credentials WHERE id=$1`, [sale.credential_id], c);
      if (!cred) throw badRequest('CARD_REQUIRED', 'Scan the card / wristband to pay');
      if ((await effectiveStatus(c, cred)) !== 'ACTIVE') throw conflict(`CARD_${cred.status}`, `Card is ${cred.status}`);
      if (!cred.account_id) throw conflict('NO_WALLET', 'This card has no wallet');
      accountId = cred.account_id;
      credentialId = cred.id;
    }
    const m = await one<any>(`SELECT id FROM members WHERE account_id=$1`, [accountId], c);
    const led = await walletPost(c, {
      accountId: accountId!, type: 'PAYMENT', amount: -amount, branchId: sale.branch_id, credentialId, memberId: m?.id ?? null, reference: sale.sale_no,
      refType: 'SALE', refId: sale.id, storeId: sale.store_id, deviceId: ctx.deviceId ?? null, staffId: isStaff ? ctx.staffId ?? null : null,
      idempotencyKey: p.idempotencyKey ? `sale-pay:${p.idempotencyKey}` : null,
    });
    ledgerId = led.entry.id;
    // Attach the payer to an anonymous sale (points, history).
    if (!sale.account_id) await query(`UPDATE sales SET account_id=$2, member_id=COALESCE(member_id,$3), credential_id=COALESCE(credential_id,$4) WHERE id=$1`, [sale.id, accountId, m?.id ?? null, credentialId], c);
    await announceWallet(out, c, accountId!, sale.branch_id, { reason: 'PAYMENT', saleNo: sale.sale_no });
    status = 'PAID';
    provider = 'WALLET';
  } else if (p.method === 'POINTS') {
    if (!settings.points.allowAsPayment) throw badRequest('POINTS_PAYMENT_DISABLED');
    if (!sale.member_id) throw badRequest('MEMBER_REQUIRED', 'Points can only be used by members');
    pointsUsed = Math.ceil(amount / settings.points.redeemValue);
    await pointsPost(c, { memberId: sale.member_id, type: 'PAYMENT', points: -pointsUsed, reference: sale.sale_no, refType: 'SALE', refId: sale.id, branchId: sale.branch_id, staffId: ctx.staffId ?? null, idempotencyKey: p.idempotencyKey ? `sale-points:${p.idempotencyKey}` : null });
    await query(`UPDATE sales SET points_redeemed = points_redeemed + $2 WHERE id=$1`, [sale.id, pointsUsed], c);
    await announcePoints(out, c, sale.member_id);
    status = 'PAID';
  } else if (p.method === 'COMP') {
    if (!isStaff) throw forbidden('COMP_STAFF_ONLY');
    status = 'PAID';
  } else if (p.method === 'PROMPTPAY' || p.method === 'BANK_TRANSFER') {
    const qrSet = (await getSettings(c)).payment.qr;
    expiresAt = new Date(Date.now() + settings.parkPayment.qrCountdownSec * 1000);
    if (p.method === 'PROMPTPAY') {
      if (qrSet.mode === 'GATEWAY') {
        const prov = getProvider(qrSet.gatewayProvider);
        provider = prov.name;
        const r = await prov.createQr!({ paymentId: base.id, amount, orderNumber: sale.sale_no });
        qr = r.qrPayload;
        providerTxnId = r.providerTxnId;
      } else {
        provider = 'PROMPTPAY';
        qr = buildPromptPayPayload(qrSet.promptpayId, amount);
      }
    } else provider = 'BANK_TRANSFER';
    if (isStaff && p.confirmNow) {
      status = 'PAID';
    }
  } else {
    // CARD / EWALLET / MOBILE_BANKING
    if (isStaff && p.confirmNow) {
      status = 'PAID';
      provider = p.method === 'CARD' ? 'EDC' : p.method;
    } else {
      const provName = p.method === 'CARD' ? (await getSettings(c)).payment.card.provider : (await getSettings(c)).payment.qr.gatewayProvider;
      const prov = getProvider(provName);
      provider = prov.name;
      if (p.method === 'CARD') {
        const r = await prov.startCardCharge!({ paymentId: base.id, amount, orderNumber: sale.sale_no });
        providerTxnId = r.providerTxnId;
        status = 'WAITING_CARD';
        expiresAt = new Date(Date.now() + (await getSettings(c)).payment.card.timeoutSec * 1000);
      } else {
        const r = await prov.createQr!({ paymentId: base.id, amount, orderNumber: sale.sale_no });
        qr = r.qrPayload;
        providerTxnId = r.providerTxnId;
        expiresAt = new Date(Date.now() + settings.parkPayment.qrCountdownSec * 1000);
      }
    }
  }
  if (status === 'PAID' && isStaff && !shiftId) shiftId = (await one<any>(`SELECT id FROM shifts WHERE user_id=$1 AND status='OPEN'`, [ctx.staffId], c))?.id ?? null;
  const payment = await one<any>(
    `INSERT INTO sale_payments (id, payment_no, sale_id, method, provider, status, amount, received_amount, change_amount, reference, provider_txn_id, qr_payload,
        card_brand, card_last4, approval_code, wallet_ledger_id, points_used, idempotency_key, channel, cashier_id, shift_id, device_id, expires_at, paid_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, CASE WHEN $6='PAID' THEN now() END) RETURNING *`,
    [base.id, base.payment_no, sale.id, p.method, provider, status, amount, received, change, p.reference ?? null, providerTxnId, qr,
     p.cardBrand ?? null, p.cardLast4 && /^\d{4}$/.test(p.cardLast4) ? p.cardLast4 : null, p.approvalCode ?? null, ledgerId, pointsUsed, p.idempotencyKey ?? null,
     base.channel, base.cashier_id, shiftId, base.device_id, expiresAt],
    c,
  );
  if (ledgerId) await query(`UPDATE wallet_ledger SET ref_id=$2 WHERE id=$1 AND ref_id IS NULL`, [ledgerId, sale.id], c);
  let completed = false;
  if (status === 'PAID') {
    await recordCash(c, payment, sale);
    completed = await afterPaid(c, sale.id, out, { strict: true, actor: ctx.actor });
  } else {
    await query(`UPDATE sales SET status='PENDING_PAYMENT' WHERE id=$1 AND status='OPEN'`, [sale.id], c);
    await syncBookingPayment(c, sale.id, out);
    if (status === 'WAITING_CASH') {
      out.add([rooms.branchCounter(sale.branch_id), rooms.branchRides(sale.branch_id), rooms.branchAdmin(sale.branch_id)], EVENTS.PARK_PAYMENT_WAITING, {
        kind: 'CASH', saleId: sale.id, saleNo: sale.sale_no, paymentId: payment.id, amount, channel: sale.channel, deviceId: ctx.deviceId ?? null,
      });
    }
  }
  out.add([rooms.sale(sale.id)], EVENTS.SALE_UPDATED, { saleId: sale.id, paymentId: payment.id, paymentStatus: payment.status, completed });
  return { payment, sale: await one<any>(`SELECT * FROM sales WHERE id=$1`, [sale.id], c), replay: false, completed };
}

async function recordCash(c: Tx, payment: any, sale: any) {
  if (payment.method !== 'CASH' || !payment.shift_id) return;
  const topup = sale.kind === 'TOPUP';
  await query(
    `INSERT INTO cash_movements (shift_id, type, amount, ref_type, ref_id, user_id) VALUES ($1,$2,$3,'SALE_PAYMENT',$4,$5) ON CONFLICT DO NOTHING`,
    [payment.shift_id, topup ? 'CASH_TOPUP' : 'CASH_SALE', payment.amount, payment.id, payment.cashier_id],
    c,
  );
}

/** Recompute paid amount; complete the sale when fully paid. Returns true when the sale just completed. */
async function afterPaid(c: Tx, saleId: string, out: Outbox, o: { strict: boolean; actor: ParkActor }) {
  const agg = await one<any>(`SELECT COALESCE(SUM(amount),0) AS paid FROM sale_payments WHERE sale_id=$1 AND status='PAID'`, [saleId], c);
  const sale = await one<any>(`UPDATE sales SET paid_amount=$2 WHERE id=$1 RETURNING *`, [saleId, agg.paid], c);
  if (Number(sale.paid_amount) + 0.001 < Number(sale.total)) {
    await query(`UPDATE sales SET status='PENDING_PAYMENT' WHERE id=$1 AND status='OPEN'`, [saleId], c);
    await syncBookingPayment(c, saleId, out);
    return false;
  }
  if (sale.status === 'PAID') return false;
  await completeSaleTx(c, saleId, out, o);
  return true;
}

/** Mark the sale PAID, cancel other open attempts, fulfil, earn points, queue receipts, announce. */
export async function completeSaleTx(c: Tx, saleId: string, out: Outbox, o: { strict: boolean; actor: ParkActor }) {
  const sale = await one<any>(`UPDATE sales SET status='PAID', paid_at=COALESCE(paid_at, now()), expires_at=NULL WHERE id=$1 RETURNING *`, [saleId], c);
  await query(`UPDATE sale_payments SET status='CANCELLED' WHERE sale_id=$1 AND status = ANY($2)`, [saleId, OPEN_PAYMENT], c);
  await query(`UPDATE payment_verification_requests SET status='CANCELLED', decided_at=now() WHERE sale_id=$1 AND status='WAITING_VERIFICATION'`, [saleId], c);
  if (o.strict) await fulfilSaleTx(c, sale, out);
  else {
    await c.query('SAVEPOINT fulfil');
    try {
      await fulfilSaleTx(c, sale, out);
      await c.query('RELEASE SAVEPOINT fulfil');
    } catch (e: any) {
      // Money was captured externally: keep the payment, flag the sale for reconciliation (retried in background).
      await c.query('ROLLBACK TO SAVEPOINT fulfil');
      await query(`UPDATE sales SET fulfil_status='FAILED', fulfil_error=$2, fulfil_attempts=fulfil_attempts+1 WHERE id=$1`, [saleId, String(e?.message ?? e).slice(0, 500)], c);
      await notify({
        audience: 'STAFF', branchId: sale.branch_id, type: 'FULFILMENT_FAILED', severity: 'CRITICAL', dedupeKey: `fulfil:${saleId}`,
        title: { th: 'ชำระเงินแล้วแต่ออกสิทธิ์ไม่สำเร็จ', en: 'Paid but fulfilment failed', zh: '已付款但发放失败' },
        body: { th: `${sale.sale_no}: ${e?.message ?? ''} — ระบบจะลองใหม่อัตโนมัติ`, en: `${sale.sale_no}: ${e?.message ?? ''} — will retry automatically`, zh: `${sale.sale_no}: ${e?.message ?? ''} — 将自动重试` },
        data: { saleId },
      }, c, out);
    }
  }
  await syncBookingPayment(c, saleId, out);
  const fresh = await one<any>(`SELECT * FROM sales WHERE id=$1`, [saleId], c);
  if (fresh.fulfil_status === 'DONE') await printSaleDocuments(c, fresh, out, {}).catch(() => {});
  const targets = [rooms.sale(saleId), rooms.branchAdmin(sale.branch_id), rooms.branchCounter(sale.branch_id)];
  if (sale.account_id) targets.push(rooms.account(sale.account_id));
  out.add(targets, EVENTS.SALE_PAID, { saleId, saleNo: sale.sale_no, total: Number(sale.total), channel: sale.channel, kind: sale.kind, fulfilled: fresh.fulfil_status === 'DONE' });
  out.add([rooms.branchAdmin(sale.branch_id)], EVENTS.DASHBOARD_TICK, { kind: 'SALE' });
}

/** Deliver everything that was bought. Idempotent per item (fulfilled_at). */
export async function fulfilSaleTx(c: Tx, sale: any, out: Outbox) {
  const b = await branchInfo(sale.branch_id, c);
  const today = await branchToday(sale.branch_id, c);
  const settings = await parkSettings(sale.branch_id, c);
  const items = await query<any>(`SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY sort FOR UPDATE`, [sale.id], c);
  for (const it of items) {
    if (it.fulfilled_at) continue;
    const meta = it.meta ?? {};
    if (it.item_type === 'PACKAGE') {
      const pkg = await loadPackage(c, it.ref_id);
      if (pkg.kind === 'ADMISSION') {
        const tickets = await query<any>(`UPDATE tickets SET status='ACTIVE', activated_at=now() WHERE sale_item_id=$1 AND status IN ('UNPAID','PAID') RETURNING *`, [it.id], c);
        for (const t of tickets) await createTicketEntitlements(c, t, pkg, b.timezone);
        await grantPackageBenefits(c, sale, it, pkg, tickets.length || it.qty, b.timezone, out);
        out.add([rooms.branchAdmin(sale.branch_id)], EVENTS.TICKET_UPDATED, { saleId: sale.id, count: tickets.length });
      } else {
        // Add-on packages (ride pass, fast pass, wallet credit, food voucher…) attach to the buyer.
        const fake = { id: null, account_id: sale.account_id, member_id: sale.member_id, branch_id: sale.branch_id, sale_id: sale.id, sale_item_id: it.id, valid_from: meta.visitDate ?? today, valid_to: meta.visitDate ?? today };
        if (!sale.account_id) throw conflict('CARD_REQUIRED', 'Add-on packages need a card / member');
        await createAccountEntitlements(c, fake, pkg, sale.credential_id, b.timezone, it.qty);
        await grantPackageBenefits(c, sale, it, pkg, it.qty, b.timezone, out);
      }
    } else if (it.item_type === 'MEMBERSHIP' || it.item_type === 'MEMBERSHIP_RENEWAL' || it.item_type === 'MEMBERSHIP_UPGRADE') {
      const kind = it.item_type === 'MEMBERSHIP' ? 'NEW' : it.item_type === 'MEMBERSHIP_RENEWAL' ? 'RENEWAL' : 'UPGRADE';
      await applyMembership(c, { memberId: sale.member_id, productId: it.ref_id, kind, saleId: sale.id, price: Number(it.line_total), today });
      out.add(rooms.account(sale.account_id), EVENTS.MEMBER_UPDATED, { memberId: sale.member_id, reason: kind });
    } else if (it.item_type === 'TOPUP') {
      await walletPost(c, {
        accountId: it.ref_id, type: 'TOPUP', amount: Number(meta.amount ?? it.line_total), branchId: sale.branch_id, credentialId: sale.credential_id, memberId: sale.member_id,
        reference: sale.sale_no, refType: 'SALE', refId: sale.id, storeId: sale.store_id, deviceId: sale.device_id, staffId: sale.created_by,
        idempotencyKey: `topup:${it.id}`, maxBalance: settings.wallet.maxBalance,
      });
      await announceWallet(out, c, it.ref_id, sale.branch_id, { reason: 'TOPUP', saleNo: sale.sale_no });
    } else if (it.item_type === 'PRODUCT') {
      if (sale.store_id) await deductInventory(c, { storeId: sale.store_id, productId: it.ref_id, qty: it.qty, refId: sale.id, userId: sale.created_by }, out);
    } else if (it.item_type === 'LOCKER') {
      await startLockerSessionTx(c, { sale, item: it, credentialId: meta.credentialId ?? sale.credential_id }, out);
    } else if (it.item_type === 'RIDE_ADDON') {
      const ride = await one<any>(`SELECT * FROM rides WHERE id=$1`, [it.ref_id], c);
      const cred = meta.credentialId ? await one<any>(`SELECT id, account_id, member_id FROM credentials WHERE id=$1`, [meta.credentialId], c) : null;
      await createAddonEntitlement(c, {
        ride, accountId: cred?.account_id ?? sale.account_id, credentialId: cred?.id ?? sale.credential_id, memberId: cred?.member_id ?? sale.member_id,
        branchId: sale.branch_id, saleId: sale.id, saleItemId: it.id, qty: it.qty, tz: b.timezone,
      });
      if (cred?.account_id) out.add(rooms.account(cred.account_id), EVENTS.CREDENTIAL_UPDATED, { credentialId: cred.id, reason: 'RIDE_ADDON' });
    }
    await query(`UPDATE sale_items SET fulfilled_at=now() WHERE id=$1`, [it.id], c);
  }
  // Promotions / coupons usage.
  for (const a of (sale.applied_promotions ?? []) as any[]) {
    if (!a.promotionId || a.promotionId === 'manual' || String(a.promotionId).startsWith('member:')) continue;
    const ins = await one(
      `INSERT INTO promotion_redemptions (promotion_id, coupon_id, member_id, sale_id, amount) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
      [a.promotionId, a.couponId ?? null, sale.member_id, sale.id, a.amount],
      c,
    );
    if (ins) {
      await query(`UPDATE promotions SET usage_count = usage_count + 1 WHERE id=$1`, [a.promotionId], c);
      if (a.couponId) await query(`UPDATE coupons SET used_count = used_count + 1, status = CASE WHEN used_count + 1 >= max_uses THEN 'USED' ELSE status END WHERE id=$1`, [a.couponId], c);
    }
  }
  // Points (amounts paid with points do not earn points).
  if (sale.member_id && Number(sale.total) > 0) {
    const pointsPaid = await one<any>(`SELECT COALESCE(SUM(amount),0) AS a FROM sale_payments WHERE sale_id=$1 AND status='PAID' AND method='POINTS'`, [sale.id], c);
    const factor = Math.max(0, 1 - Number(pointsPaid.a) / Number(sale.total));
    const byCat: Record<string, number> = {};
    for (const it of items) byCat[it.points_category] = (byCat[it.points_category] ?? 0) + Number(it.line_total) * factor;
    const pts = await computeEarn(c, sale.member_id, byCat);
    if (pts > 0) {
      await pointsPost(c, { memberId: sale.member_id, type: 'EARN', points: pts, reference: sale.sale_no, refType: 'SALE', refId: sale.id, branchId: sale.branch_id, idempotencyKey: `earn:sale:${sale.id}` });
      await query(`UPDATE sales SET points_earned=$2 WHERE id=$1`, [sale.id, pts], c);
      await announcePoints(out, c, sale.member_id);
    }
    await query(`UPDATE members SET total_spend = total_spend + $2 WHERE id=$1`, [sale.member_id, sale.total], c);
  }
  await query(`UPDATE sales SET fulfil_status='DONE', fulfil_error=NULL WHERE id=$1`, [sale.id], c);
}

async function createAccountEntitlements(c: Tx, holder: any, pkg: any, credentialId: string | null, tz: string, qty: number) {
  const { dayBounds } = await import('./entitlements');
  const { start, end } = await dayBounds(c, holder.valid_from, holder.valid_to, tz);
  const rides = await query<any>(`SELECT * FROM package_rides WHERE package_id=$1`, [pkg.id], c);
  const list = pkg.all_rides ? [{ ride_id: null, entitlement_type: pkg.all_rides_type, uses: pkg.all_rides_uses }] : rides;
  for (const r of list) {
    const counted = r.entitlement_type === 'ONE_TIME' || r.entitlement_type === 'MULTI_USE';
    const uses = counted ? (r.entitlement_type === 'ONE_TIME' ? 1 : r.uses ?? 1) * qty : null;
    await query(
      `INSERT INTO ride_entitlements (account_id, credential_id, member_id, branch_id, ride_id, type, uses_total, uses_left, valid_from, valid_until, is_fast_pass, source, sale_id, sale_item_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,'PACKAGE',$11,$12)`,
      [holder.account_id, credentialId, holder.member_id, holder.branch_id, r.ride_id, r.entitlement_type, uses, start, end, pkg.kind === 'FAST_PASS', holder.sale_id, holder.sale_item_id],
      c,
    );
  }
}

/** FAST_PASS / WALLET_CREDIT / FOOD_VOUCHER / LOCKER / COUPON benefits of a package. */
async function grantPackageBenefits(c: Tx, sale: any, item: any, pkg: any, units: number, tz: string, out: Outbox) {
  const benefits = await packageBenefits(c, pkg.id);
  for (const bn of benefits) {
    const n = units * (bn.qty ?? 1);
    if (bn.type === 'WALLET_CREDIT' && sale.account_id && Number(bn.value) > 0) {
      await walletPost(c, { accountId: sale.account_id, type: 'BONUS', amount: Number(bn.value) * units, bonus: true, branchId: sale.branch_id, reference: sale.sale_no, refType: 'SALE', refId: sale.id, idempotencyKey: `bonus:${item.id}:${bn.id}`, note: 'Package wallet credit' });
      await announceWallet(out, c, sale.account_id, sale.branch_id, { reason: 'BONUS' });
    } else if (bn.type === 'FAST_PASS' && sale.account_id) {
      const { dayBounds } = await import('./entitlements');
      const d = item.meta?.visitDate ?? (await branchToday(sale.branch_id, c));
      const { start, end } = await dayBounds(c, d, d, tz);
      await query(
        `INSERT INTO ride_entitlements (account_id, credential_id, member_id, branch_id, ride_id, type, uses_total, uses_left, valid_from, valid_until, is_fast_pass, source, sale_id, sale_item_id)
         VALUES ($1,$2,$3,$4,$5,'MULTI_USE',$6,$6,$7,$8,true,'PACKAGE',$9,$10)`,
        [sale.account_id, sale.credential_id, sale.member_id, sale.branch_id, bn.config?.rideId ?? null, n, start, end, sale.id, item.id],
        c,
      );
    } else if ((bn.type === 'FOOD_VOUCHER' || bn.type === 'COUPON' || bn.type === 'LOCKER') && bn.config?.promotionId) {
      for (let i = 0; i < n; i++) {
        await query(
          `INSERT INTO coupons (code, promotion_id, member_id, max_uses, valid_from, valid_to, source) VALUES ($1,$2,$3,1,$4,$5,'PACKAGE')`,
          [`PK${crypto.randomBytes(4).toString('hex').toUpperCase()}`, bn.config.promotionId, sale.member_id, item.meta?.visitDate ?? null, item.meta?.visitDate ?? null],
          c,
        );
      }
    }
  }
}

/** Keep the booking row in step with its sale. */
export async function syncBookingPayment(c: Tx, saleId: string, out: Outbox) {
  const bk = await one<any>(`SELECT * FROM bookings WHERE sale_id=$1 FOR UPDATE`, [saleId], c);
  if (!bk) return;
  const sale = await one<any>(`SELECT * FROM sales WHERE id=$1`, [saleId], c);
  const waiting = await one(`SELECT 1 FROM payment_verification_requests WHERE sale_id=$1 AND status='WAITING_VERIFICATION'`, [saleId], c);
  let payment = bk.payment_status;
  let status = bk.status;
  if (sale.status === 'PAID') {
    payment = 'PAID';
    if (['PENDING_PAYMENT', 'RESERVED', 'WAITING_VERIFICATION'].includes(status)) status = 'CONFIRMED';
  } else if (sale.status === 'REFUNDED') {
    payment = 'REFUNDED';
    status = 'REFUNDED';
  } else if (sale.status === 'PARTIALLY_REFUNDED') payment = 'PARTIALLY_REFUNDED';
  else if (waiting) {
    payment = 'WAITING_VERIFICATION';
    if (['PENDING_PAYMENT', 'RESERVED'].includes(status)) status = 'WAITING_VERIFICATION';
  } else if (Number(sale.paid_amount) > 0) payment = 'PENDING';
  else if (status === 'WAITING_VERIFICATION') status = bk.pay_mode === 'PAY_AT_PARK' ? 'RESERVED' : 'PENDING_PAYMENT';
  if (sale.status === 'CANCELLED' || sale.status === 'EXPIRED') status = sale.status === 'EXPIRED' ? 'EXPIRED' : 'CANCELLED';
  if (payment === 'WAITING_VERIFICATION' && sale.status !== 'PENDING_PAYMENT' && sale.status !== 'OPEN') payment = bk.payment_status;
  if (payment !== bk.payment_status || status !== bk.status) {
    await query(`UPDATE bookings SET payment_status=$2, status=$3, expires_at = CASE WHEN $3 IN ('CONFIRMED','CHECKED_IN') THEN NULL ELSE expires_at END WHERE id=$1`, [bk.id, payment, status], c);
  }
  out.add([rooms.booking(bk.id), rooms.branchCounter(bk.branch_id), rooms.branchAdmin(bk.branch_id)], EVENTS.BOOKING_UPDATED, {
    bookingId: bk.id, bookingNo: bk.booking_no, status, paymentStatus: payment, saleId,
  });
}

// ------------------------------------------------------------------ external confirmations
export interface ConfirmDetails {
  providerTxnId?: string | null;
  reference?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  approvalCode?: string | null;
  received?: number | null;
  verificationId?: string | null;
  staffId?: string | null;
}

/** PAID confirmation for a pending payment (verification approval, webhook, cash confirmation). Idempotent. */
export async function confirmSalePaymentTx(c: Tx, paymentId: string, d: ConfirmDetails, out: Outbox, actor: ParkActor) {
  const pay = await one<any>(`SELECT * FROM sale_payments WHERE id=$1`, [paymentId], c);
  if (!pay) throw notFound('Payment');
  const sale = await lockSale(c, pay.sale_id);
  const cur = await one<any>(`SELECT * FROM sale_payments WHERE id=$1 FOR UPDATE`, [paymentId], c);
  if (cur.status === 'PAID') return { alreadyPaid: true, sale };
  if (!OPEN_PAYMENT.includes(cur.status) && cur.status !== 'REJECTED' && cur.status !== 'EXPIRED' && cur.status !== 'CANCELLED') throw conflict('PAYMENT_NOT_OPEN', `Payment is ${cur.status}`);
  if (sale.status === 'PAID' || !['OPEN', 'PENDING_PAYMENT', 'EXPIRED', 'CANCELLED'].includes(sale.status)) {
    // Money arrived for a sale already settled / closed: never drop it silently.
    await query(`UPDATE sale_payments SET status='PAID', paid_at=now(), provider_txn_id=COALESCE($2,provider_txn_id), reference=COALESCE($3,reference) WHERE id=$1`, [paymentId, d.providerTxnId ?? null, d.reference ?? null], c);
    await notify({
      audience: 'STAFF', branchId: sale.branch_id, type: 'LATE_PAYMENT_NEEDS_REFUND', severity: 'CRITICAL', dedupeKey: `late:${paymentId}`,
      title: { th: 'ได้รับเงินซ้ำ/ล่าช้า ต้องคืนเงิน', en: 'Duplicate / late payment needs refund', zh: '重复/迟到付款需退款' },
      body: { th: `${sale.sale_no} ฿${cur.amount}`, en: `${sale.sale_no} ฿${cur.amount}`, zh: `${sale.sale_no} ฿${cur.amount}` },
      data: { saleId: sale.id, paymentId },
    }, c, out);
    return { alreadyPaid: true, lateRefundNeeded: true, sale };
  }
  if (sale.status === 'EXPIRED' || sale.status === 'CANCELLED') {
    // Re-open an expired hold when payment still arrives (tickets back to UNPAID if capacity allows).
    await query(`UPDATE sales SET status='PENDING_PAYMENT', cancelled_at=NULL, cancel_reason=NULL WHERE id=$1`, [sale.id], c);
    await query(`UPDATE tickets SET status='UNPAID', cancelled_at=NULL WHERE sale_id=$1 AND status='CANCELLED'`, [sale.id], c);
    await query(`UPDATE bookings SET status='PENDING_PAYMENT' WHERE sale_id=$1 AND status IN ('EXPIRED','CANCELLED')`, [sale.id], c);
  }
  let shiftId: string | null = cur.shift_id;
  let received: number | null = null;
  let change: number | null = null;
  if (cur.method === 'CASH') {
    const shift = await requireShift(c, d.staffId, sale.branch_id);
    shiftId = shift?.id ?? null;
    received = round2(d.received ?? Number(cur.amount));
    if (received + 0.001 < Number(cur.amount)) throw badRequest('INSUFFICIENT_CASH');
    change = round2(received - Number(cur.amount));
  }
  const paid = await one<any>(
    `UPDATE sale_payments SET status='PAID', paid_at=now(), provider_txn_id=COALESCE($2,provider_txn_id), reference=COALESCE($3,reference), card_brand=COALESCE($4,card_brand),
        card_last4=COALESCE($5,card_last4), approval_code=COALESCE($6,approval_code), cashier_id=COALESCE($7,cashier_id), shift_id=$8,
        received_amount=COALESCE($9,received_amount), change_amount=COALESCE($10,change_amount) WHERE id=$1 RETURNING *`,
    [paymentId, d.providerTxnId ?? null, d.reference ?? null, d.cardBrand ?? null, d.cardLast4 && /^\d{4}$/.test(d.cardLast4) ? d.cardLast4 : null, d.approvalCode ?? null,
     d.staffId ?? null, shiftId, received, change],
    c,
  );
  if (d.verificationId) {
    await query(`UPDATE payment_verification_requests SET status='APPROVED', decided_by=$2, decided_at=now() WHERE id=$1`, [d.verificationId, d.staffId ?? null], c);
  }
  await recordCash(c, paid, sale);
  const completed = await afterPaid(c, sale.id, out, { strict: cur.method === 'CASH', actor });
  out.add([rooms.sale(sale.id)], EVENTS.SALE_UPDATED, { saleId: sale.id, paymentId, paymentStatus: 'PAID', completed });
  return { alreadyPaid: false, completed, sale };
}

export async function confirmSalePayment(paymentId: string, d: ConfirmDetails, actor: ParkActor) {
  const out = new Outbox();
  const r = await tx((c) => confirmSalePaymentTx(c, paymentId, d, out, actor));
  await out.flush();
  return r;
}

/** Customer: "ตรวจสอบการชำระเงิน" / slip upload → WAITING_VERIFICATION in the Payment Verification Center. */
export async function requestSaleVerification(saleId: string, paymentId: string, info: { slipUrl?: string | null; reference?: string | null; paymentTime?: string | null }, actor: ParkActor) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const sale = await lockSale(c, saleId);
    if (sale.status === 'PAID') return { alreadyPaid: true, verification: null };
    const pay = await one<any>(`SELECT * FROM sale_payments WHERE id=$1 AND sale_id=$2 FOR UPDATE`, [paymentId, saleId], c);
    if (!pay || !['PROMPTPAY', 'BANK_TRANSFER', 'MOBILE_BANKING', 'EWALLET'].includes(pay.method)) throw badRequest('INVALID_PAYMENT');
    if (!['PENDING', 'WAITING_VERIFICATION', 'REJECTED'].includes(pay.status)) throw conflict('PAYMENT_NOT_OPEN', `Payment is ${pay.status}`);
    const existing = await one<any>(`SELECT * FROM payment_verification_requests WHERE sale_payment_id=$1 AND status='WAITING_VERIFICATION'`, [paymentId], c);
    if (existing) {
      if (info.slipUrl) await query(`UPDATE payment_verification_requests SET slip_url=$2 WHERE id=$1`, [existing.id, info.slipUrl], c);
      return { alreadyPaid: false, verification: existing };
    }
    const bk = await one<any>(`SELECT id FROM bookings WHERE sale_id=$1`, [saleId], c);
    const v = await one<any>(
      `INSERT INTO payment_verification_requests (branch_id, sale_id, sale_payment_id, booking_id, method, expected_amount, slip_url, reference, payment_time, customer_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [sale.branch_id, saleId, paymentId, bk?.id ?? null, pay.method, pay.amount, info.slipUrl ?? null, info.reference?.slice(0, 100) ?? null, info.paymentTime ?? null, sale.customer_name],
      c,
    );
    await query(`UPDATE sale_payments SET status='WAITING_VERIFICATION', expires_at=NULL WHERE id=$1`, [paymentId], c);
    await query(`UPDATE sales SET status='PENDING_PAYMENT', expires_at=NULL WHERE id=$1`, [saleId], c);
    await syncBookingPayment(c, saleId, out);
    out.add([rooms.branchCounter(sale.branch_id), rooms.branchAdmin(sale.branch_id)], EVENTS.PARK_PAYMENT_WAITING, {
      kind: 'VERIFICATION', verificationId: v.id, saleId, saleNo: sale.sale_no, bookingId: bk?.id ?? null, amount: Number(pay.amount), method: pay.method,
      customer: sale.customer_name, slipUrl: v.slip_url, createdAt: v.requested_at,
    });
    out.add([rooms.sale(saleId)], EVENTS.SALE_UPDATED, { saleId, paymentId, paymentStatus: 'WAITING_VERIFICATION' });
    return { alreadyPaid: false, verification: v };
  });
  await out.flush();
  return r;
}

export async function approveSaleVerification(verificationId: string, staff: { id: string; name: string }) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const v = await one<any>(`SELECT * FROM payment_verification_requests WHERE id=$1 FOR UPDATE`, [verificationId], c);
    if (!v) throw notFound('Verification');
    if (v.status === 'APPROVED') return { alreadyPaid: true, saleId: v.sale_id };
    if (v.status !== 'WAITING_VERIFICATION') throw conflict('VERIFICATION_CLOSED', `Verification is ${v.status}`);
    const res = await confirmSalePaymentTx(c, v.sale_payment_id, { verificationId, staffId: staff.id, reference: v.reference }, out, { type: 'STAFF', id: staff.id, name: staff.name });
    return { alreadyPaid: res.alreadyPaid, saleId: v.sale_id };
  });
  await out.flush();
  return r;
}

export async function rejectSaleVerification(verificationId: string, staff: { id: string; name: string }, reason: string, requestNewSlip: boolean) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const v = await one<any>(`SELECT * FROM payment_verification_requests WHERE id=$1 FOR UPDATE`, [verificationId], c);
    if (!v) throw notFound('Verification');
    if (v.status !== 'WAITING_VERIFICATION') throw conflict('VERIFICATION_CLOSED', `Verification is ${v.status}`);
    const status = requestNewSlip ? 'NEW_SLIP_REQUESTED' : 'REJECTED';
    await query(`UPDATE payment_verification_requests SET status=$2, decided_by=$3, decided_at=now(), reason=$4 WHERE id=$1`, [verificationId, status, staff.id, reason], c);
    await query(`UPDATE sale_payments SET status=$2 WHERE id=$1 AND status='WAITING_VERIFICATION'`, [v.sale_payment_id, requestNewSlip ? 'PENDING' : 'REJECTED'], c);
    await syncBookingPayment(c, v.sale_id, out);
    out.add([rooms.sale(v.sale_id)], EVENTS.SALE_UPDATED, { saleId: v.sale_id, paymentId: v.sale_payment_id, paymentStatus: requestNewSlip ? 'NEW_SLIP_REQUESTED' : 'REJECTED', reason });
    out.add([rooms.branchCounter(v.branch_id), rooms.branchAdmin(v.branch_id)], EVENTS.PARK_PAYMENT_WAITING, { kind: 'VERIFICATION_DECIDED', verificationId, status });
    return { ...v, status };
  });
  await out.flush();
  return r;
}

export async function cancelPaymentAttempt(saleId: string, paymentId: string) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    await lockSale(c, saleId);
    const p = await one<any>(`SELECT * FROM sale_payments WHERE id=$1 AND sale_id=$2 FOR UPDATE`, [paymentId, saleId], c);
    if (!p) throw notFound('Payment');
    if (p.status === 'PAID') throw conflict('ALREADY_PAID');
    if (!OPEN_PAYMENT.includes(p.status) && p.status !== 'REJECTED') return p;
    if (p.provider_txn_id) await getProvider(p.provider).cancel?.(p.provider_txn_id).catch(() => {});
    await query(`UPDATE sale_payments SET status='CANCELLED' WHERE id=$1`, [paymentId], c);
    await query(`UPDATE payment_verification_requests SET status='CANCELLED', decided_at=now() WHERE sale_payment_id=$1 AND status='WAITING_VERIFICATION'`, [paymentId], c);
    await syncBookingPayment(c, saleId, out);
    out.add([rooms.sale(saleId)], EVENTS.SALE_UPDATED, { saleId, paymentId, paymentStatus: 'CANCELLED' });
    return { ...p, status: 'CANCELLED' };
  });
  await out.flush();
  return r;
}

/** Cancel an unpaid sale (releases ticket holds). Paid sales must be refunded instead. */
export async function cancelSale(saleId: string, reason: string, actor: ParkActor, expired = false) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const sale = await lockSale(c, saleId);
    if (['CANCELLED', 'EXPIRED'].includes(sale.status)) return sale;
    if (!['OPEN', 'PENDING_PAYMENT'].includes(sale.status)) throw conflict('SALE_NOT_CANCELLABLE', `Sale is ${sale.status} — refund instead`);
    const paidParts = await query<any>(`SELECT * FROM sale_payments WHERE sale_id=$1 AND status='PAID'`, [saleId], c);
    // Partial payments (split) are reversed automatically where we hold the money.
    for (const p of paidParts) await reversePayment(c, sale, p, Number(p.amount), reason, actor, null, out);
    await query(`UPDATE sale_payments SET status='CANCELLED' WHERE sale_id=$1 AND status = ANY($2)`, [saleId, OPEN_PAYMENT], c);
    await query(`UPDATE payment_verification_requests SET status='CANCELLED', decided_at=now() WHERE sale_id=$1 AND status='WAITING_VERIFICATION'`, [saleId], c);
    await query(`UPDATE tickets SET status='CANCELLED', cancelled_at=now() WHERE sale_id=$1 AND status IN ('UNPAID','PAID')`, [saleId], c);
    await query(`UPDATE sales SET status=$2, cancelled_at=now(), cancel_reason=$3, paid_amount=0 WHERE id=$1`, [saleId, expired ? 'EXPIRED' : 'CANCELLED', reason], c);
    await syncBookingPayment(c, saleId, out);
    out.add([rooms.sale(saleId), rooms.branchAdmin(sale.branch_id)], EVENTS.SALE_UPDATED, { saleId, status: expired ? 'EXPIRED' : 'CANCELLED' });
    return sale;
  });
  await out.flush();
  return r;
}

/** Return money of one payment to where it came from. */
async function reversePayment(c: Tx, sale: any, p: any, amount: number, reason: string, actor: ParkActor, approvedBy: string | null, out: Outbox, refundMethod?: string | null) {
  const today = await branchToday(sale.branch_id, c);
  let ledgerId: string | null = null;
  let shiftId: string | null = null;
  const method = refundMethod ?? (p.method === 'CASH' ? 'CASH' : p.method === 'WALLET' ? 'WALLET' : p.method === 'POINTS' ? 'POINTS' : 'ORIGINAL');
  if (method === 'WALLET') {
    const accountId = p.method === 'WALLET' ? (await one<any>(`SELECT account_id FROM wallet_ledger WHERE id=$1`, [p.wallet_ledger_id], c))?.account_id : sale.account_id;
    if (!accountId) throw conflict('NO_WALLET', 'No wallet to refund to');
    const led = await walletPost(c, { accountId, type: 'REFUND', amount, branchId: sale.branch_id, reference: sale.sale_no, refType: 'SALE', refId: sale.id, staffId: actor.type === 'STAFF' ? actor.id : null, idempotencyKey: `refund:${p.id}:${p.refunded_amount}:${amount}`, note: reason });
    ledgerId = led.entry.id;
    await announceWallet(out, c, accountId, sale.branch_id, { reason: 'REFUND' });
  } else if (method === 'POINTS' && sale.member_id) {
    await pointsPost(c, { memberId: sale.member_id, type: 'REVERSE', points: Math.round(amount / Math.max(0.01, (await getSettings(c)).points.redeemValue)), reference: sale.sale_no, refType: 'SALE', refId: sale.id, idempotencyKey: `refund-points:${p.id}:${p.refunded_amount}` });
  } else if (method === 'CASH') {
    if (actor.type === 'STAFF') {
      const shift = await one<any>(`SELECT id FROM shifts WHERE user_id=$1 AND status='OPEN'`, [actor.id], c);
      shiftId = shift?.id ?? null;
      if (!shift && (await getSettings(c)).shift.requireForCash) throw conflict('SHIFT_REQUIRED', 'Open a shift to pay out cash');
    }
  } else if (p.provider_txn_id) {
    await (getProvider(p.provider) as any).refund?.(p.provider_txn_id, amount).catch(() => {});
  }
  const refundedTotal = round2(Number(p.refunded_amount) + amount);
  await query(`UPDATE sale_payments SET refunded_amount=$2, status = CASE WHEN $2 >= amount THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END WHERE id=$1`, [p.id, refundedTotal], c);
  const rf = await one<any>(
    `INSERT INTO refunds (refund_no, sale_id, sale_payment_id, branch_id, amount, reason, method, refund_method, type, created_by, approved_by, wallet_ledger_id, shift_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [await genRefundNo(c, today), sale.id, p.id, sale.branch_id, amount, reason, p.method, method, amount >= Number(p.amount) ? 'FULL' : 'PARTIAL',
     actor.type === 'STAFF' ? actor.id : null, approvedBy, ledgerId, shiftId],
    c,
  );
  if (shiftId) await query(`INSERT INTO cash_movements (shift_id, type, amount, ref_type, ref_id, user_id) VALUES ($1,'CASH_REFUND',$2,'REFUND',$3,$4)`, [shiftId, -amount, rf.id, actor.id], c);
  return rf;
}

export interface RefundInput {
  amount?: number | null;
  items?: { saleItemId: string; qty: number }[];
  reason: string;
  refundMethod?: 'ORIGINAL' | 'CASH' | 'WALLET' | null;
  /** Bypass package refund policy / used-ticket checks (requires tickets.override). */
  override?: boolean;
}

/**
 * Full or partial refund of a paid sale. Revokes what was delivered (unused tickets, entitlements,
 * membership, wallet top-up, locker, stock back), reverses earned points, then returns money per payment.
 */
export async function refundSale(saleId: string, r: RefundInput, staff: { id: string; name: string }, approvedBy: string | null) {
  const out = new Outbox();
  const actor: ParkActor = { type: 'STAFF', id: staff.id, name: staff.name };
  const res = await tx(async (c) => {
    const sale = await lockSale(c, saleId);
    if (!['PAID', 'PARTIALLY_REFUNDED'].includes(sale.status)) throw conflict('SALE_NOT_PAID', 'Only paid sales can be refunded');
    const items = await query<any>(`SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY sort`, [saleId], c);
    const refundable = round2(Number(sale.total) - Number(sale.refunded_amount));
    let amount = 0;
    const revoked: any[] = [];
    const selection = r.items?.length ? r.items : items.map((i) => ({ saleItemId: i.id, qty: i.qty - i.refunded_qty }));
    for (const sel of selection) {
      const it = items.find((i) => i.id === sel.saleItemId);
      if (!it) throw notFound('Sale item');
      const qty = Math.min(sel.qty, it.qty - it.refunded_qty);
      if (qty <= 0) continue;
      const per = round2(Number(it.line_total) / it.qty);
      let lineAmount = round2(per * qty);
      lineAmount = await revokeItem(c, sale, it, qty, !!r.override, out, revoked, lineAmount);
      await query(`UPDATE sale_items SET refunded_qty = refunded_qty + $2 WHERE id=$1`, [it.id, qty], c);
      amount = round2(amount + lineAmount);
    }
    if (r.amount != null) amount = Math.min(round2(r.amount), refundable);
    if (!(amount > 0)) throw badRequest('NOTHING_TO_REFUND');
    if (amount > refundable + 0.001) throw badRequest('INVALID_REFUND_AMOUNT', `Refundable amount is ${refundable}`);
    // Money back: newest payments first (wallet / points / cash / original channel).
    const pays = await query<any>(`SELECT * FROM sale_payments WHERE sale_id=$1 AND status IN ('PAID','PARTIALLY_REFUNDED') ORDER BY created_at DESC`, [saleId], c);
    let left = amount;
    const refunds: any[] = [];
    for (const p of pays) {
      if (left <= 0) break;
      const avail = round2(Number(p.amount) - Number(p.refunded_amount) - (p.method === 'CASH' ? 0 : 0));
      const take = Math.min(avail, left);
      if (take <= 0) continue;
      refunds.push(await reversePayment(c, sale, p, take, r.reason, actor, approvedBy, out, r.refundMethod && r.refundMethod !== 'ORIGINAL' ? r.refundMethod : null));
      left = round2(left - take);
    }
    // Points earned on the refunded part are taken back (clamped at the current balance).
    if (sale.member_id && sale.points_earned > 0) {
      const back = Math.floor((sale.points_earned * amount) / Math.max(0.01, Number(sale.total)));
      if (back > 0) await pointsPost(c, { memberId: sale.member_id, type: 'REVERSE', points: -back, reference: sale.sale_no, refType: 'SALE', refId: sale.id, clamp: true, idempotencyKey: `unearn:${sale.id}:${Number(sale.refunded_amount)}:${amount}` });
      await announcePoints(out, c, sale.member_id);
    }
    const newRefunded = round2(Number(sale.refunded_amount) + amount);
    const full = newRefunded + 0.001 >= Number(sale.total);
    await query(`UPDATE sales SET refunded_amount=$2, status=$3 WHERE id=$1`, [saleId, newRefunded, full ? 'REFUNDED' : 'PARTIALLY_REFUNDED'], c);
    if (sale.member_id) await query(`UPDATE members SET total_spend = GREATEST(0, total_spend - $2) WHERE id=$1`, [sale.member_id, amount], c);
    await syncBookingPayment(c, saleId, out);
    out.add([rooms.sale(saleId), rooms.branchAdmin(sale.branch_id)], EVENTS.SALE_UPDATED, { saleId, status: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED' });
    return { amount, full, refunds, revoked };
  });
  await out.flush();
  return res;
}

async function revokeItem(c: Tx, sale: any, it: any, qty: number, override: boolean, out: Outbox, revoked: any[], lineAmount: number): Promise<number> {
  if (it.item_type === 'PACKAGE') {
    const pkg = await loadPackage(c, it.ref_id);
    const today = await branchToday(sale.branch_id, c);
    const visit = it.meta?.visitDate as string | undefined;
    if (!override) {
      if (pkg.refund_policy === 'NON_REFUNDABLE') throw forbidden('NON_REFUNDABLE', 'This package is non-refundable (supervisor override required)');
      if (pkg.refund_policy !== 'ANYTIME' && visit) {
        const cutoffMs = Date.parse(`${visit}T00:00:00+07:00`) - pkg.refund_cutoff_hours * 3600_000;
        if (Date.now() > cutoffMs || today >= visit) throw forbidden('REFUND_WINDOW_CLOSED', 'Refund window has closed (supervisor override required)');
      }
    }
    if (pkg.kind === 'ADMISSION') {
      const tickets = await query<any>(
        `SELECT * FROM tickets WHERE sale_item_id=$1 AND status IN ('ACTIVE','PAID','UNPAID') ${override ? '' : "AND entry_count=0 AND presence='OUTSIDE'"} ORDER BY entry_count, created_at LIMIT $2 FOR UPDATE`,
        [it.id, qty * (pkg.bundle && Object.keys(pkg.bundle).length ? Object.values(pkg.bundle as Record<string, number>).reduce((a, b) => a + Number(b), 0) : pkg.guests_per_unit)],
        c,
      );
      if (!tickets.length) throw conflict('TICKETS_USED', 'Tickets were already used — supervisor override required');
      const ids = tickets.map((t) => t.id);
      await query(`UPDATE tickets SET status='REFUNDED', cancelled_at=now(), presence='OUTSIDE' WHERE id = ANY($1)`, [ids], c);
      await query(`UPDATE ride_entitlements SET status='REFUNDED' WHERE ticket_id = ANY($1) AND status='ACTIVE'`, [ids], c);
      revoked.push({ tickets: tickets.map((t) => t.ticket_no) });
    }
    if (pkg.refund_fee_pct > 0 && !override) lineAmount = round2(lineAmount * (1 - Number(pkg.refund_fee_pct) / 100));
    await query(`UPDATE ride_entitlements SET status='REFUNDED' WHERE sale_item_id=$1 AND ticket_id IS NULL AND status='ACTIVE'`, [it.id], c);
  } else if (it.item_type === 'TOPUP') {
    const w = await one<any>(`SELECT * FROM wallet_accounts WHERE account_id=$1`, [it.ref_id], c);
    const take = Math.min(Number(w?.balance ?? 0) - Number(w?.bonus_balance ?? 0), lineAmount);
    if (take + 0.001 < lineAmount) throw conflict('TOPUP_ALREADY_SPENT', `Only ${take.toFixed(2)} of this top-up is still in the wallet`);
    await walletPost(c, { accountId: it.ref_id, type: 'REVERSAL', amount: -lineAmount, branchId: sale.branch_id, reference: sale.sale_no, refType: 'SALE', refId: sale.id, idempotencyKey: `topup-reverse:${it.id}:${it.refunded_qty}`, note: 'Top-up refunded' });
    await announceWallet(out, c, it.ref_id, sale.branch_id, { reason: 'REFUND' });
  } else if (it.item_type === 'PRODUCT') {
    if (sale.store_id) await returnInventory(c, { storeId: sale.store_id, productId: it.ref_id, qty, refId: sale.id }, out);
  } else if (it.item_type === 'RIDE_ADDON') {
    const ent = await one<any>(`SELECT * FROM ride_entitlements WHERE sale_item_id=$1 FOR UPDATE`, [it.id], c);
    if (ent && !override && ent.uses_total != null && ent.uses_left < ent.uses_total) throw conflict('RIDE_ALREADY_USED', 'Ride already used — supervisor override required');
    await query(`UPDATE ride_entitlements SET status='REFUNDED' WHERE sale_item_id=$1`, [it.id], c);
  } else if (it.item_type === 'LOCKER') {
    const s = await one<any>(`SELECT * FROM locker_sessions WHERE sale_item_id=$1 AND status='ACTIVE'`, [it.id], c);
    if (s) await endLockerSessionTx(c, s.id, 'ENDED', out);
  } else if (it.item_type.startsWith('MEMBERSHIP')) {
    await query(`UPDATE memberships SET status='REFUNDED' WHERE sale_id=$1 AND status='ACTIVE'`, [sale.id], c);
    const still = await one(`SELECT 1 FROM memberships WHERE member_id=$1 AND status='ACTIVE'`, [sale.member_id], c);
    if (!still) await query(`UPDATE members SET tier_id=(SELECT id FROM member_tiers WHERE is_default LIMIT 1) WHERE id=$1`, [sale.member_id], c);
  }
  return lineAmount;
}

// ------------------------------------------------------------------ queries
export async function getSaleDetail(db: Db, saleId: string) {
  const sale = await one<any>(
    `SELECT s.*, b.code AS branch_code, b.name AS branch_name, b.timezone, st.name AS store_name, st.code AS store_code, u.name AS created_by_name,
            m.member_no, m.first_name, m.last_name, bk.id AS booking_id, bk.booking_no, c.code AS credential_code
       FROM sales s JOIN branches b ON b.id=s.branch_id LEFT JOIN stores st ON st.id=s.store_id LEFT JOIN users u ON u.id=s.created_by
       LEFT JOIN members m ON m.id=s.member_id LEFT JOIN bookings bk ON bk.sale_id=s.id LEFT JOIN credentials c ON c.id=s.credential_id
      WHERE s.id=$1`,
    [saleId],
    db,
  );
  if (!sale) throw notFound('Sale');
  const [items, payments, refunds, tickets, verifications, prints] = [
    await query<any>(`SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY sort`, [saleId], db),
    await query<any>(`SELECT p.*, u.name AS cashier_name FROM sale_payments p LEFT JOIN users u ON u.id=p.cashier_id WHERE p.sale_id=$1 ORDER BY p.created_at`, [saleId], db),
    await query<any>(`SELECT r.*, u.name AS created_by_name, a.name AS approved_by_name FROM refunds r LEFT JOIN users u ON u.id=r.created_by LEFT JOIN users a ON a.id=r.approved_by WHERE r.sale_id=$1 ORDER BY r.created_at`, [saleId], db),
    await query<any>(
      `SELECT t.*, p.name AS package_name, tt.name AS ticket_type_name, c.code AS credential_code, c.token_version
         FROM tickets t JOIN packages p ON p.id=t.package_id LEFT JOIN ticket_types tt ON tt.id=t.ticket_type_id LEFT JOIN credentials c ON c.id=t.credential_id
        WHERE t.sale_id=$1 ORDER BY t.ticket_no`,
      [saleId],
      db,
    ),
    await query<any>(`SELECT v.*, u.name AS decided_by_name FROM payment_verification_requests v LEFT JOIN users u ON u.id=v.decided_by WHERE v.sale_id=$1 ORDER BY v.requested_at`, [saleId], db),
    await query<any>(`SELECT j.id, j.status, j.payload->>'title' AS title, j.created_at, j.printed_at, j.last_error, pr.name AS printer_name FROM print_jobs j LEFT JOIN printers pr ON pr.id=j.printer_id WHERE j.sale_id=$1 ORDER BY j.created_at`, [saleId], db),
  ];
  // Signed QR / barcode payloads for usable tickets (printed tickets, kiosk / counter display).
  const withPayloads = tickets.map((t) => (['PAID', 'ACTIVE'].includes(t.status) ? { ...t, ...payloadsFor({ code: t.credential_code ?? t.ticket_no, token_version: t.token_version ?? 1 }) } : t));
  return { sale, items, payments, refunds, tickets: withPayloads, verifications, prints };
}

// ------------------------------------------------------------------ background jobs
/** Unpaid holds past their deadline are released (never while a slip is waiting for verification). */
export async function expireSales(): Promise<number> {
  const rows = await query<any>(
    `SELECT s.id FROM sales s WHERE s.status IN ('OPEN','PENDING_PAYMENT') AND s.expires_at < now()
        AND NOT EXISTS (SELECT 1 FROM sale_payments p WHERE p.sale_id=s.id AND p.status IN ('WAITING_VERIFICATION','PROCESSING','WAITING_CARD'))
        AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.sale_id=s.id AND b.pay_mode='PAY_AT_PARK')
      LIMIT 100`,
  );
  let n = 0;
  for (const r of rows) {
    try {
      await cancelSale(r.id, 'EXPIRED', { type: 'SYSTEM', name: 'expiry' }, true);
      n++;
    } catch {
      /* raced with a payment */
    }
  }
  return n;
}

/** Retry failed fulfilments (money captured, delivery failed) — reconciliation. */
export async function reconcileFulfilment(): Promise<number> {
  const rows = await query<any>(`SELECT id FROM sales WHERE status='PAID' AND fulfil_status='FAILED' AND fulfil_attempts < 6 LIMIT 20`);
  let ok = 0;
  for (const r of rows) {
    const out = new Outbox();
    try {
      await tx(async (c) => {
        const sale = await lockSale(c, r.id);
        if (sale.fulfil_status !== 'FAILED') return;
        await fulfilSaleTx(c, sale, out);
        await syncBookingPayment(c, sale.id, out);
        await printSaleDocuments(c, await one<any>(`SELECT * FROM sales WHERE id=$1`, [sale.id], c), out, {}).catch(() => {});
      });
      await out.flush();
      ok++;
    } catch (e: any) {
      await query(`UPDATE sales SET fulfil_attempts=fulfil_attempts+1, fulfil_error=$2 WHERE id=$1`, [r.id, String(e?.message ?? e).slice(0, 500)]);
    }
  }
  return ok;
}

export { AppError };
