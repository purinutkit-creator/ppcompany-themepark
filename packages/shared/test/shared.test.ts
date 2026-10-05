import { describe, expect, it } from 'vitest';
import { buildPromptPayPayload, crc16ccitt } from '../src/promptpay';
import { priceCart } from '../src/pricing';
import { validateModifierSelection } from '../src/modifiers';
import { inTimeWindow } from '../src/time';
import type { Promotion, TaxSettings } from '../src/types';

const tax: TaxSettings = { vatRate: 7, vatMode: 'INCLUDED', serviceChargeRate: 0, serviceChargeOrderTypes: ['DINE_IN'] };
const promo = (p: Partial<Promotion>): Promotion => ({
  id: 'p', code: null, name: { en: 'P' }, description: {}, badge: {}, type: 'PERCENT', value_type: 'PERCENT', value: 10,
  buy_qty: null, get_qty: null, combo_price: null, min_order: null, max_discount: null, scope: 'ORDER',
  product_ids: [], category_ids: [], branch_ids: [], start_date: null, end_date: null, start_time: null, end_time: null,
  days: [], usage_limit: null, usage_count: 0, requires_code: false, priority: 0, is_active: true, ...p,
});
const line = (productId: string, price: number, qty = 1, mod = 0) => ({
  key: productId + price, productId, categoryId: 'c1', qty, basePrice: price, modifierTotal: mod, vatRate: null,
});

describe('promptpay', () => {
  it('matches the reference static payload', () => {
    expect(buildPromptPayPayload('0801234567')).toBe('00020101021129370016A000000677010111011300668012345675802TH530376463046197');
  });
  it('embeds amount for dynamic QR with valid CRC', () => {
    const p = buildPromptPayPayload('0801234567', 459);
    expect(p).toContain('5406459.00');
    expect(crc16ccitt(p.slice(0, -4))).toBe(p.slice(-4));
  });
});

describe('pricing', () => {
  it('computes VAT included totals', () => {
    const r = priceCart([line('a', 100, 2, 20)], { promotions: [], tax, orderType: 'TAKE_AWAY' });
    expect(r.subtotal).toBe(240);
    expect(r.total).toBe(240);
    expect(r.vat).toBeCloseTo(15.7, 2);
  });
  it('adds VAT + service charge when excluded', () => {
    const r = priceCart([line('a', 100)], {
      promotions: [], orderType: 'DINE_IN',
      tax: { vatRate: 7, vatMode: 'EXCLUDED', serviceChargeRate: 10, serviceChargeOrderTypes: ['DINE_IN'] },
    });
    expect(r.serviceCharge).toBe(10);
    expect(r.vat).toBe(7.7);
    expect(r.total).toBe(117.7);
  });
  it('applies order percent discount with cap', () => {
    const r = priceCart([line('a', 1000)], { promotions: [promo({ value: 50, max_discount: 100 })], tax, orderType: 'DINE_IN' });
    expect(r.discount).toBe(100);
    expect(r.total).toBe(900);
  });
  it('applies buy 1 get 1 on cheapest unit', () => {
    const r = priceCart([line('a', 50, 1), line('b', 80, 1)], {
      promotions: [promo({ type: 'BUY_X_GET_Y', buy_qty: 1, get_qty: 1, value: 100, scope: 'PRODUCT', product_ids: ['a', 'b'] })],
      tax, orderType: 'DINE_IN',
    });
    expect(r.discount).toBe(50);
  });
  it('applies combo price', () => {
    const r = priceCart([line('burger', 129), line('cola', 45), line('fries', 59)], {
      promotions: [promo({ type: 'COMBO', product_ids: ['burger', 'cola', 'fries'], combo_price: 199 })],
      tax, orderType: 'DINE_IN',
    });
    expect(r.discount).toBe(34);
    expect(r.total).toBe(199);
  });
  it('requires promo code and reports invalid ones', () => {
    const p = promo({ type: 'PROMO_CODE', requires_code: true, code: 'SAVE20', value_type: 'FIXED', value: 20 });
    expect(priceCart([line('a', 100)], { promotions: [p], tax, orderType: 'DINE_IN' }).discount).toBe(0);
    expect(priceCart([line('a', 100)], { promotions: [p], tax, orderType: 'DINE_IN', promoCode: 'save20' }).discount).toBe(20);
    expect(priceCart([line('a', 100)], { promotions: [p], tax, orderType: 'DINE_IN', promoCode: 'nope' }).invalidCode).toBe('NOPE');
  });
});

describe('modifiers', () => {
  const groups = [
    { id: 'size', name: {}, selection: 'SINGLE' as const, required: true, min_select: 1, max_select: 1, kind: 'OPTION' as const, sort: 0,
      modifiers: [{ id: 's', group_id: 'size', name: {}, price_delta: 0, is_default: true, is_active: true, sort: 0 },
                  { id: 'l', group_id: 'size', name: {}, price_delta: 10, is_default: false, is_active: true, sort: 1 }] },
    { id: 'top', name: {}, selection: 'MULTIPLE' as const, required: false, min_select: 0, max_select: 1, kind: 'ADD' as const, sort: 1,
      modifiers: [{ id: 'c', group_id: 'top', name: {}, price_delta: 20, is_default: false, is_active: true, sort: 0 },
                  { id: 'e', group_id: 'top', name: {}, price_delta: 15, is_default: false, is_active: true, sort: 1 }] },
  ];
  it('flags missing required and too many', () => {
    expect(validateModifierSelection(groups, []).map((e) => e.code)).toEqual(['REQUIRED']);
    expect(validateModifierSelection(groups, ['s', 'c', 'e']).map((e) => e.code)).toEqual(['MAX']);
    expect(validateModifierSelection(groups, ['s', 'l']).map((e) => e.code)).toEqual(['SINGLE']);
    expect(validateModifierSelection(groups, ['l', 'c'])).toEqual([]);
  });
});

describe('time windows', () => {
  it('handles overnight windows', () => {
    expect(inTimeWindow('23:30', '22:00', '02:00')).toBe(true);
    expect(inTimeWindow('03:00', '22:00', '02:00')).toBe(false);
    expect(inTimeWindow('10:00', '06:00', '11:00')).toBe(true);
  });
});
