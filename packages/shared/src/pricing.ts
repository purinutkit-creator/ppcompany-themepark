import type {
  AppliedPromotion,
  CartLineInput,
  OrderType,
  PricedLine,
  PricingResult,
  Promotion,
  TaxSettings,
} from './types';
import { fromMinor, toMinor } from './money';
import { inTimeWindow, localNow } from './time';

export interface PricingOptions {
  promotions: Promotion[];
  tax: TaxSettings;
  orderType: OrderType;
  promoCode?: string | null;
  branchId?: string | null;
  now?: Date;
  timeZone?: string;
}

/** Whether a promotion is currently valid (dates, time window, weekday, branch, usage). */
export function isPromotionLive(p: Promotion, now: Date, timeZone: string, branchId?: string | null): boolean {
  if (!p.is_active) return false;
  const n = localNow(now, timeZone);
  if (p.start_date && n.date < p.start_date.slice(0, 10)) return false;
  if (p.end_date && n.date > p.end_date.slice(0, 10)) return false;
  if (!inTimeWindow(n.time, p.start_time, p.end_time)) return false;
  if (p.days?.length && !p.days.includes(n.dow)) return false;
  if (branchId && p.branch_ids?.length && !p.branch_ids.includes(branchId)) return false;
  if (p.usage_limit != null && p.usage_count >= p.usage_limit) return false;
  return true;
}

export function promotionMatchesLine(p: Promotion, line: { productId: string; categoryId: string }): boolean {
  if (p.scope === 'PRODUCT') return p.product_ids.includes(line.productId);
  if (p.scope === 'CATEGORY') return p.category_ids.includes(line.categoryId);
  return true;
}

interface WorkLine extends CartLineInput {
  unit: number; // minor
  total: number; // minor
  disc: number; // minor (line level)
}

/**
 * Authoritative cart pricing. The kiosk uses it for display and the server re-runs it on
 * order creation, so both always agree. All math in minor units.
 */
export function priceCart(input: CartLineInput[], opts: PricingOptions): PricingResult {
  const now = opts.now ?? new Date();
  const tz = opts.timeZone ?? 'Asia/Bangkok';
  const lines: WorkLine[] = input.map((l) => {
    const unit = toMinor(l.basePrice) + toMinor(l.modifierTotal);
    return { ...l, unit, total: unit * l.qty, disc: 0 };
  });
  const subtotal = lines.reduce((s, l) => s + l.total, 0);
  const code = opts.promoCode?.trim().toUpperCase() || null;
  let orderDisc = 0;
  const applied: AppliedPromotion[] = [];
  let codeUsed = false;

  const promos = [...opts.promotions]
    .filter((p) => isPromotionLive(p, now, tz, opts.branchId))
    .filter((p) => !p.requires_code || (code && p.code?.toUpperCase() === code))
    .sort((a, b) => b.priority - a.priority);

  const remaining = (l: WorkLine) => l.total - l.disc;

  for (const p of promos) {
    if (p.min_order != null && subtotal < toMinor(p.min_order)) continue;
    let amount = 0;
    const matching = lines.filter((l) => promotionMatchesLine(p, l) && remaining(l) > 0);
    const isPercent =
      p.type === 'PERCENT' || ((p.type === 'COUPON' || p.type === 'PROMO_CODE') && p.value_type === 'PERCENT');

    if (p.type === 'PERCENT' || p.type === 'FIXED' || p.type === 'COUPON' || p.type === 'PROMO_CODE') {
      if (p.scope === 'ORDER') {
        const base = subtotal - lines.reduce((s, l) => s + l.disc, 0) - orderDisc;
        amount = isPercent ? Math.round((base * p.value) / 100) : toMinor(p.value);
        if (p.max_discount != null) amount = Math.min(amount, toMinor(p.max_discount));
        amount = Math.max(0, Math.min(amount, base));
        orderDisc += amount;
      } else {
        const per = matching.map((l) =>
          Math.min(remaining(l), isPercent ? Math.round((remaining(l) * p.value) / 100) : toMinor(p.value) * l.qty),
        );
        let total = per.reduce((s, v) => s + v, 0);
        if (p.max_discount != null && total > toMinor(p.max_discount)) {
          const cap = toMinor(p.max_discount);
          const scaled = per.map((v) => Math.floor((v * cap) / total));
          per.splice(0, per.length, ...scaled);
          total = scaled.reduce((s, v) => s + v, 0);
        }
        matching.forEach((l, i) => (l.disc += per[i]));
        amount = total;
      }
    } else if (p.type === 'BUY_X_GET_Y') {
      const x = Math.max(1, p.buy_qty ?? 1);
      const y = Math.max(1, p.get_qty ?? 1);
      const pct = p.value > 0 && p.value <= 100 ? p.value : 100;
      const units: { line: WorkLine; price: number }[] = [];
      for (const l of matching) for (let i = 0; i < l.qty; i++) units.push({ line: l, price: l.unit });
      units.sort((a, b) => b.price - a.price);
      const groups = Math.floor(units.length / (x + y));
      // Within each group of x+y (sorted desc), the cheapest y are discounted.
      for (let g = 0; g < groups; g++) {
        const group = units.slice(g * (x + y), (g + 1) * (x + y));
        for (const u of group.slice(x)) {
          const d = Math.min(remaining(u.line), Math.round((u.price * pct) / 100));
          u.line.disc += d;
          amount += d;
        }
      }
      if (p.max_discount != null) amount = Math.min(amount, toMinor(p.max_discount));
    } else if (p.type === 'COMBO' || p.type === 'SET_MENU') {
      const ids = p.product_ids;
      if (ids.length && p.combo_price != null) {
        const avail = (id: string) => lines.filter((l) => l.productId === id).reduce((s, l) => s + l.qty, 0);
        const combos = Math.min(...ids.map(avail));
        for (let c = 0; c < combos; c++) {
          const parts = ids.map((id) => lines.filter((l) => l.productId === id).sort((a, b) => b.unit - a.unit)[0]);
          const base = parts.reduce((s, l) => s + toMinor(l.basePrice), 0);
          const d = Math.max(0, base - toMinor(p.combo_price));
          if (!d) break;
          let left = d;
          parts.forEach((l, i) => {
            const share = i === parts.length - 1 ? left : Math.round((d * toMinor(l.basePrice)) / base);
            const take = Math.min(share, remaining(l));
            l.disc += take;
            left -= take;
            amount += take;
          });
        }
      }
    }
    if (amount > 0) {
      if (p.requires_code) codeUsed = true;
      applied.push({ promotionId: p.id, name: p.name, type: p.type, amount: fromMinor(amount), code: p.requires_code ? p.code ?? undefined : undefined });
    }
  }

  const lineDisc = lines.reduce((s, l) => s + l.disc, 0);
  let discount = Math.min(subtotal, lineDisc + orderDisc);
  orderDisc = discount - lineDisc;

  // Allocate order-level discount proportionally to lines so VAT can be computed per line rate.
  const afterLine = lines.map((l) => l.total - l.disc);
  const afterLineSum = afterLine.reduce((s, v) => s + v, 0);
  const alloc = afterLine.map((v) => (afterLineSum ? Math.floor((v * orderDisc) / afterLineSum) : 0));
  let rest = orderDisc - alloc.reduce((s, v) => s + v, 0);
  for (let i = 0; rest > 0 && i < alloc.length; i++) {
    if (afterLine[i] - alloc[i] > 0) {
      alloc[i]++;
      rest--;
    }
  }
  const net = afterLine.map((v, i) => v - alloc[i]);
  const netSum = net.reduce((s, v) => s + v, 0);

  const scRate = opts.tax.serviceChargeOrderTypes.includes(opts.orderType) ? opts.tax.serviceChargeRate : 0;
  const serviceCharge = Math.round((netSum * scRate) / 100);

  let vat = 0;
  net.forEach((v, i) => {
    const share = netSum ? v + Math.round((serviceCharge * v) / netSum) : 0;
    const rate = lines[i].vatRate ?? opts.tax.vatRate;
    vat += opts.tax.vatMode === 'INCLUDED' ? (share * rate) / (100 + rate) : (share * rate) / 100;
  });
  vat = Math.round(vat);
  const total = netSum + serviceCharge + (opts.tax.vatMode === 'EXCLUDED' ? vat : 0);

  const priced: PricedLine[] = lines.map((l) => ({
    key: l.key,
    productId: l.productId,
    categoryId: l.categoryId,
    qty: l.qty,
    basePrice: l.basePrice,
    modifierTotal: l.modifierTotal,
    vatRate: l.vatRate,
    unitPrice: fromMinor(l.unit),
    lineTotal: fromMinor(l.total),
    discount: fromMinor(l.disc),
  }));

  return {
    lines: priced,
    subtotal: fromMinor(subtotal),
    discount: fromMinor(discount),
    serviceCharge: fromMinor(serviceCharge),
    vat: fromMinor(vat),
    total: fromMinor(total),
    appliedPromotions: applied,
    invalidCode: code && !codeUsed ? code : undefined,
  };
}
