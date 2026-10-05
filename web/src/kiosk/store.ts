import { create } from 'zustand';
import type { Lang, MenuProduct, OrderType } from '@kiosk/shared';

export interface CartLine {
  key: string;
  productId: string;
  qty: number;
  modifierIds: string[];
  specialRequest: string;
  upsellSourceProductId?: string | null;
}

export interface ActiveOrder {
  id: string;
  number: string;
  total: number;
  subtotal: number;
  discount: number;
  serviceCharge: number;
  vat: number;
  orderType: OrderType;
  items: any[];
}

export interface ActivePayment {
  id: string;
  method: 'QR' | 'CASH' | 'CARD' | 'OTHER';
  status: string;
  qrPayload: string | null;
  expiresAt: string | null;
  amount: number;
}

interface KioskState {
  lang: Lang;
  orderType: OrderType | null;
  lines: CartLine[];
  promoCode: string | null;
  clientOrderId: string | null;
  order: ActiveOrder | null;
  payment: ActivePayment | null;
  offlineRef: string | null;
  setLang: (l: Lang) => void;
  setOrderType: (t: OrderType) => void;
  addLine: (l: Omit<CartLine, 'key'>) => void;
  updateLine: (key: string, patch: Partial<CartLine>) => void;
  removeLine: (key: string) => void;
  setQty: (key: string, qty: number) => void;
  setPromo: (c: string | null) => void;
  setOrder: (o: ActiveOrder | null, clientOrderId?: string | null) => void;
  setPayment: (p: ActivePayment | null) => void;
  setOfflineRef: (r: string | null) => void;
  reset: (lang: Lang) => void;
}

const sameSelection = (a: CartLine, b: Omit<CartLine, 'key'>) =>
  a.productId === b.productId &&
  a.specialRequest === b.specialRequest &&
  (a.upsellSourceProductId ?? null) === (b.upsellSourceProductId ?? null) &&
  [...a.modifierIds].sort().join() === [...b.modifierIds].sort().join();

/** In-memory only — nothing about a customer survives a reset (no persistence on purpose). */
export const useKiosk = create<KioskState>((set) => ({
  lang: 'th',
  orderType: null,
  lines: [],
  promoCode: null,
  clientOrderId: null,
  order: null,
  payment: null,
  offlineRef: null,
  setLang: (lang) => set({ lang }),
  setOrderType: (orderType) => set({ orderType }),
  addLine: (l) =>
    set((s) => {
      const same = s.lines.find((x) => sameSelection(x, l));
      if (same) return { lines: s.lines.map((x) => (x === same ? { ...x, qty: Math.min(99, x.qty + l.qty) } : x)) };
      return { lines: [...s.lines, { ...l, key: crypto.randomUUID() }] };
    }),
  updateLine: (key, patch) => set((s) => ({ lines: s.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) })),
  removeLine: (key) => set((s) => ({ lines: s.lines.filter((l) => l.key !== key) })),
  setQty: (key, qty) => set((s) => ({ lines: qty <= 0 ? s.lines.filter((l) => l.key !== key) : s.lines.map((l) => (l.key === key ? { ...l, qty: Math.min(99, qty) } : l)) })),
  setPromo: (promoCode) => set({ promoCode }),
  setOrder: (order, clientOrderId) => set((s) => ({ order, clientOrderId: clientOrderId === undefined ? s.clientOrderId : clientOrderId })),
  setPayment: (payment) => set({ payment }),
  setOfflineRef: (offlineRef) => set({ offlineRef }),
  reset: (lang) => set({ lang, orderType: null, lines: [], promoCode: null, clientOrderId: null, order: null, payment: null, offlineRef: null }),
}));

export type ProductAvailability = 'OK' | 'SOLD_OUT' | 'UNAVAILABLE' | 'NOT_NOW';

export function modifierTotal(p: MenuProduct, ids: string[]) {
  let t = 0;
  for (const g of p.modifier_groups) for (const m of g.modifiers) if (ids.includes(m.id)) t += Number(m.price_delta);
  return t;
}
