import type { I18nText, TaxSettings } from '../types';
import { fromMinor, toMinor } from '../money';
import { inTimeWindow, localNow } from '../time';
import type { SaleChannel, SaleItemType } from './types';

/** Rule-based promotion row (park fields extend the restaurant promotions table). */
export interface ParkPromotion {
  id: string;
  code: string | null;
  name: I18nText;
  type: 'PERCENT' | 'FIXED' | 'BUY_X_GET_Y' | 'COMBO' | 'SET_MENU' | 'COUPON' | 'PROMO_CODE';
  value_type: 'PERCENT' | 'FIXED';
  value: number;
  buy_qty: number | null;
  get_qty: number | null;
  min_order: number | null;
  max_discount: number | null;
  scope: 'ORDER' | 'PRODUCT' | 'CATEGORY';
  product_ids: string[];
  category_ids: string[];
  branch_ids: string[];
  start_date: string | null;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  days: number[];
  usage_limit: number | null;
  usage_count: number;
  requires_code: boolean;
  priority: number;
  is_active: boolean;
  applies_to: 'FOOD' | 'PARK' | 'ALL';
  channels: string[];
  item_types: string[];
  package_ids: string[];
  ticket_type_ids: string[];
  tier_ids: string[];
  min_qty: number | null;
  max_units: number | null;
  advance_days: number | null;
  birthday_only: boolean;
  members_only: boolean;
  stackable: boolean;
  usage_per_member: number | null;
}

export interface ParkLine {
  key: string;
  itemType: SaleItemType;
  refId: string | null;
  ticketTypeId?: string | null;
  categoryId?: string | null;
  qty: number;
  unitPrice: number;
  /** Top-ups are never discountable. */
  discountable?: boolean;
  /** Only promotions that explicitly list this item type apply (membership fees…). */
  explicitOnly?: boolean;
  /** TICKET / FOOD / RETAIL / LOCKER / RIDE — used by member tier discounts and points rules. */
  benefitCategory?: string;
}

export interface ParkMemberCtx {
  memberId: string;
  tierId: string | null;
  birthday: string | null; // YYYY-MM-DD
  /** Times each promotion was already used by this member. */
  usage: Record<string, number>;
  /** Tier benefit discounts in percent, keyed by benefit category (TICKET, FOOD, RETAIL, LOCKER, RIDE). */
  discounts: Record<string, number>;
  tierName?: I18nText;
}

export interface ParkPricingOptions {
  promotions: ParkPromotion[];
  channel: SaleChannel;
  branchId: string;
  tax: Pick<TaxSettings, 'vatRate' | 'vatMode'>;
  now?: Date;
  timeZone?: string;
  /** Visit date of a booking (for early-bird rules). */
  visitDate?: string | null;
  member?: ParkMemberCtx | null;
  /** Codes typed by the customer (promo codes or coupon codes). */
  codes?: string[];
  /** Coupon code → promotion id (resolved and validated server-side). */
  couponPromotions?: Record<string, { promotionId: string; couponId: string }>;
  /** Member tier discount: priority and whether it can combine with other promotions. */
  memberDiscount?: { priority: number; stackable: boolean };
}

export interface ParkAppliedPromotion {
  promotionId: string;
  name: I18nText;
  amount: number;
  code?: string | null;
  couponId?: string | null;
  kind: 'PROMOTION' | 'MEMBER' | 'COUPON';
}

export interface ParkPricedLine extends ParkLine {
  lineTotal: number;
  discount: number;
  net: number;
}

export interface ParkPricingResult {
  lines: ParkPricedLine[];
  subtotal: number;
  discount: number;
  vat: number;
  total: number;
  applied: ParkAppliedPromotion[];
  invalidCodes: string[];
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function isParkPromotionLive(p: ParkPromotion, o: ParkPricingOptions, todayLocal: { date: string; time: string; dow: number }): boolean {
  if (!p.is_active) return false;
  if (p.applies_to === 'FOOD') return false;
  if (p.start_date && todayLocal.date < p.start_date.slice(0, 10)) return false;
  if (p.end_date && todayLocal.date > p.end_date.slice(0, 10)) return false;
  if (!inTimeWindow(todayLocal.time, p.start_time, p.end_time)) return false;
  if (p.days?.length && !p.days.includes(todayLocal.dow)) return false;
  if (p.branch_ids?.length && !p.branch_ids.includes(o.branchId)) return false;
  if (p.channels?.length && !p.channels.includes(o.channel)) return false;
  if (p.usage_limit != null && p.usage_count >= p.usage_limit) return false;
  const m = o.member;
  if ((p.members_only || p.tier_ids?.length || p.birthday_only) && !m) return false;
  if (p.tier_ids?.length && (!m?.tierId || !p.tier_ids.includes(m.tierId))) return false;
  if (p.birthday_only) {
    // Birthday month of the visit (or today).
    const ref = o.visitDate ?? todayLocal.date;
    if (!m?.birthday || m.birthday.slice(5, 7) !== ref.slice(5, 7)) return false;
  }
  if (p.usage_per_member != null && m && (m.usage[p.id] ?? 0) >= p.usage_per_member) return false;
  if (p.advance_days != null) {
    if (!o.visitDate) return false;
    if (daysBetween(todayLocal.date, o.visitDate) < p.advance_days) return false;
  }
  return true;
}

export function parkLineMatches(p: ParkPromotion, l: ParkLine): boolean {
  if (l.discountable === false) return false;
  if (p.item_types?.length && !p.item_types.includes(l.itemType)) return false;
  if (l.explicitOnly && !p.item_types?.includes(l.itemType)) return false;
  if (p.package_ids?.length && !(l.itemType === 'PACKAGE' && l.refId && p.package_ids.includes(l.refId))) return false;
  if (p.ticket_type_ids?.length && !(l.ticketTypeId && p.ticket_type_ids.includes(l.ticketTypeId))) return false;
  if (p.product_ids?.length && !(l.refId && p.product_ids.includes(l.refId))) return false;
  if (p.category_ids?.length && !(l.categoryId && p.category_ids.includes(l.categoryId))) return false;
  return true;
}

interface Work extends ParkLine {
  total: number; // minor
  disc: number; // minor
  unit: number; // minor
}

/**
 * Authoritative pricing for park sales (tickets, packages, retail, lockers, ride add-ons).
 * Promotions are applied in priority order; a NON-STACKABLE promotion only applies when nothing else has
 * been applied, and once applied blocks every later promotion. Member tier discounts take part as a
 * synthetic promotion with configurable priority / stackability. All math is in minor units.
 */
export function priceParkCart(input: ParkLine[], o: ParkPricingOptions): ParkPricingResult {
  const now = o.now ?? new Date();
  const local = localNow(now, o.timeZone ?? 'Asia/Bangkok');
  const lines: Work[] = input.map((l) => {
    const unit = toMinor(l.unitPrice);
    return { ...l, unit, total: unit * l.qty, disc: 0 };
  });
  const subtotal = lines.reduce((s, l) => s + l.total, 0);
  const codes = [...new Set((o.codes ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean))];
  const couponMap = Object.fromEntries(Object.entries(o.couponPromotions ?? {}).map(([k, v]) => [k.toUpperCase(), v]));
  const usedCodes = new Set<string>();

  type Cand = { p: ParkPromotion; code: string | null; couponId: string | null; kind: ParkAppliedPromotion['kind']; memberCategory?: string };
  const cands: Cand[] = [];
  for (const p of o.promotions) {
    if (!isParkPromotionLive(p, o, local)) continue;
    if (p.requires_code) {
      const byPromoCode = codes.find((c) => p.code && c === p.code.toUpperCase());
      const byCoupon = codes.find((c) => couponMap[c]?.promotionId === p.id);
      if (byPromoCode) cands.push({ p, code: byPromoCode, couponId: null, kind: 'PROMOTION' });
      else if (byCoupon) cands.push({ p, code: byCoupon, couponId: couponMap[byCoupon].couponId, kind: 'COUPON' });
      continue;
    }
    cands.push({ p, code: null, couponId: null, kind: 'PROMOTION' });
  }
  // Member tier discounts (one synthetic promotion per benefit category).
  if (o.member) {
    for (const [cat, pct] of Object.entries(o.member.discounts)) {
      if (!(pct > 0)) continue;
      cands.push({
        kind: 'MEMBER',
        code: null,
        couponId: null,
        memberCategory: cat,
        p: {
          id: `member:${cat}`, code: null, name: o.member.tierName ?? { th: 'ส่วนลดสมาชิก', en: 'Member discount', zh: '会员折扣' },
          type: 'PERCENT', value_type: 'PERCENT', value: Math.min(100, pct), buy_qty: null, get_qty: null, min_order: null, max_discount: null,
          scope: 'PRODUCT', product_ids: [], category_ids: [], branch_ids: [], start_date: null, end_date: null, start_time: null, end_time: null,
          days: [], usage_limit: null, usage_count: 0, requires_code: false, priority: o.memberDiscount?.priority ?? 50, is_active: true,
          applies_to: 'PARK', channels: [], item_types: [], package_ids: [], ticket_type_ids: [], tier_ids: [], min_qty: null, max_units: null,
          advance_days: null, birthday_only: false, members_only: true, stackable: o.memberDiscount?.stackable ?? true, usage_per_member: null,
        },
      });
    }
  }
  cands.sort((a, b) => b.p.priority - a.p.priority);

  const applied: ParkAppliedPromotion[] = [];
  let exclusive = false;
  const remaining = (l: Work) => l.total - l.disc;

  for (const c of cands) {
    if (exclusive) break;
    const p = c.p;
    if (!p.stackable && applied.length) continue;
    const matching = lines.filter(
      (l) => remaining(l) > 0 && parkLineMatches(p, l) && (!c.memberCategory || l.benefitCategory === c.memberCategory),
    );
    if (!matching.length) continue;
    const matchQty = matching.reduce((s, l) => s + l.qty, 0);
    if (p.min_qty != null && matchQty < p.min_qty) continue;
    const matchTotal = matching.reduce((s, l) => s + remaining(l), 0);
    if (p.min_order != null && subtotal < toMinor(p.min_order)) continue;

    const isPercent = p.type === 'PERCENT' || ((p.type === 'COUPON' || p.type === 'PROMO_CODE') && p.value_type === 'PERCENT');
    const per = new Map<Work, number>();
    if (p.type === 'BUY_X_GET_Y') {
      const x = Math.max(1, p.buy_qty ?? 1);
      const y = Math.max(1, p.get_qty ?? 1);
      const pct = p.value > 0 && p.value <= 100 ? p.value : 100;
      const units: { l: Work; price: number }[] = [];
      for (const l of matching) for (let i = 0; i < l.qty; i++) units.push({ l, price: Math.floor(remaining(l) / l.qty) });
      units.sort((a, b) => b.price - a.price);
      const groups = Math.floor(units.length / (x + y));
      for (let g = 0; g < groups; g++) {
        for (const u of units.slice(g * (x + y) + x, (g + 1) * (x + y))) per.set(u.l, (per.get(u.l) ?? 0) + Math.round((u.price * pct) / 100));
      }
    } else if (isPercent || p.type === 'FIXED' || p.type === 'COUPON' || p.type === 'PROMO_CODE') {
      if (p.max_units != null) {
        // Discount only the N most expensive units (e.g. "birthday child enters free" = 100% on 1 unit).
        const units: { l: Work; price: number }[] = [];
        for (const l of matching) for (let i = 0; i < l.qty; i++) units.push({ l, price: Math.floor(remaining(l) / l.qty) });
        units.sort((a, b) => b.price - a.price);
        for (const u of units.slice(0, p.max_units)) {
          const d = isPercent ? Math.round((u.price * p.value) / 100) : Math.min(u.price, toMinor(p.value));
          per.set(u.l, (per.get(u.l) ?? 0) + d);
        }
      } else if (isPercent) {
        for (const l of matching) per.set(l, Math.round((remaining(l) * p.value) / 100));
      } else if (p.scope === 'ORDER') {
        // One fixed amount, spread proportionally over matching lines.
        const amount = Math.min(toMinor(p.value), matchTotal);
        let left = amount;
        matching.forEach((l, i) => {
          const d = i === matching.length - 1 ? left : Math.floor((amount * remaining(l)) / matchTotal);
          per.set(l, d);
          left -= d;
        });
      } else {
        for (const l of matching) per.set(l, Math.min(remaining(l), toMinor(p.value) * l.qty));
      }
    }
    // Clamp, cap and commit.
    let total = 0;
    for (const [l, d] of per) {
      const v = Math.max(0, Math.min(d, remaining(l)));
      per.set(l, v);
      total += v;
    }
    if (p.max_discount != null && total > toMinor(p.max_discount)) {
      const cap = toMinor(p.max_discount);
      let left = cap;
      const entries = [...per.entries()];
      entries.forEach(([l, d], i) => {
        const v = i === entries.length - 1 ? left : Math.floor((d * cap) / total);
        per.set(l, v);
        left -= v;
      });
      total = cap;
    }
    if (total <= 0) continue;
    for (const [l, d] of per) l.disc += d;
    if (c.code) usedCodes.add(c.code);
    applied.push({ promotionId: p.id, name: p.name, amount: fromMinor(total), code: c.code, couponId: c.couponId, kind: c.kind });
    if (!p.stackable) exclusive = true;
  }

  const discount = lines.reduce((s, l) => s + l.disc, 0);
  const net = subtotal - discount;
  let vat: number;
  let total: number;
  if (o.tax.vatMode === 'EXCLUDED') {
    vat = Math.round((net * o.tax.vatRate) / 100);
    total = net + vat;
  } else {
    vat = Math.round((net * o.tax.vatRate) / (100 + o.tax.vatRate));
    total = net;
  }
  return {
    lines: lines.map(({ unit: _u, total: lt, disc, ...l }) => ({ ...l, lineTotal: fromMinor(lt), discount: fromMinor(disc), net: fromMinor(lt - disc) })),
    subtotal: fromMinor(subtotal),
    discount: fromMinor(discount),
    vat: fromMinor(vat),
    total: fromMinor(total),
    applied,
    invalidCodes: codes.filter((c) => !usedCodes.has(c)),
  };
}

/** Points earned for an amount under a "N baht = 1 point" rule with a tier multiplier (floored). */
export function pointsFor(amount: number, bahtPerPoint: number, multiplier = 1): number {
  if (!(bahtPerPoint > 0) || !(amount > 0)) return 0;
  return Math.floor((Math.floor(amount / bahtPerPoint) * Math.round(multiplier * 100)) / 100);
}
