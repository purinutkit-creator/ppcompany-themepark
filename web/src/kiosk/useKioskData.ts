import { useCallback, useEffect, useMemo, useState } from 'react';
import { isScheduleOpen, localNow, type Lang, type MenuCategory, type MenuProduct, type MenuSchedule, type Promotion, isPromotionLive, promotionMatchesLine } from '@kiosk/shared';
import { ApiError, kioskApi } from '../lib/api';
import { cache } from '../lib/offline';
import type { ProductAvailability } from './store';

export interface Bootstrap {
  kiosk: { id: string; code: string; name: string; branchId: string; defaultLanguage: Lang; idleTimeout: number; paymentMethods: string[]; orderTypes: string[]; theme: Record<string, any> };
  branch: { id: string; code: string; name: Record<string, string>; timezone: string };
  languages: { code: Lang; enabled: boolean; is_default: boolean; overrides: Record<string, string>; native_name: string; flag: string }[];
  fonts: any[];
  settings: any;
}
export interface Menu {
  categories: MenuCategory[];
  products: MenuProduct[];
  schedules: MenuSchedule[];
  promotions: Promotion[];
  generatedAt: string;
}

/**
 * Loads kiosk configuration + menu. Online → refreshes and caches to IndexedDB.
 * Offline → serves the last cached copy so customers can still browse and order (cash).
 */
export function useKioskData() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [tick, setTick] = useState(0);

  const loadBoot = useCallback(async () => {
    try {
      const b = await kioskApi<Bootstrap>('/bootstrap');
      setBoot(b);
      void cache.save('bootstrap', b);
      setError(null);
    } catch (e) {
      const c = await cache.load<Bootstrap>('bootstrap');
      if (c && (e as ApiError).isNetwork) {
        setBoot(c.value);
        setFromCache(true);
      } else setError(e as ApiError);
    }
  }, []);

  const loadMenu = useCallback(async () => {
    try {
      const m = await kioskApi<Menu>('/menu');
      setMenu(m);
      setFromCache(false);
      void cache.save('menu', m);
    } catch (e) {
      const c = await cache.load<Menu>('menu');
      if (c) {
        setMenu(c.value);
        setFromCache(true);
      } else if (!(e as ApiError).isNetwork) setError(e as ApiError);
    }
  }, []);

  useEffect(() => {
    void loadBoot();
    void loadMenu();
    // Re-evaluate menu schedules every minute (breakfast → lunch etc.)
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, [loadBoot, loadMenu]);

  const applyStock = useCallback((d: { productId: string; available: number }) => {
    setMenu((m) => (m ? { ...m, products: m.products.map((p) => (p.id === d.productId ? { ...p, available_stock: d.available } : p)) } : m));
  }, []);

  const tz = boot?.branch.timezone ?? 'Asia/Bangkok';
  const helpers = useMemo(() => {
    const now = localNow(new Date(), tz);
    const sched = new Map((menu?.schedules ?? []).map((s) => [s.id, s]));
    const cats = new Map((menu?.categories ?? []).map((c) => [c.id, c]));
    const livePromos = (menu?.promotions ?? []).filter((p) => !p.requires_code && isPromotionLive(p, new Date(), tz, boot?.kiosk.branchId));
    const availability = (p: MenuProduct): ProductAvailability => {
      if (p.status === 'SOLD_OUT' || (p.track_stock && (p.available_stock ?? 0) <= 0)) return 'SOLD_OUT';
      if (p.status !== 'AVAILABLE') return 'UNAVAILABLE';
      const c = cats.get(p.category_id);
      if (!isScheduleOpen(sched.get(p.schedule_id ?? ''), now) || !isScheduleOpen(sched.get(c?.schedule_id ?? ''), now)) return 'NOT_NOW';
      return 'OK';
    };
    const promoFor = (p: MenuProduct) =>
      livePromos.find((pr) => (pr.scope !== 'ORDER' && promotionMatchesLine(pr, { productId: p.id, categoryId: p.category_id })) || ((pr.type === 'COMBO' || pr.type === 'SET_MENU') && pr.product_ids.includes(p.id)));
    const visibleCategories = (menu?.categories ?? []).filter((c) => c.is_active && isScheduleOpen(sched.get(c.schedule_id ?? ''), now));
    const productsIn = (c: MenuCategory) => {
      const list = menu?.products ?? [];
      if (c.kind === 'RECOMMENDED') return list.filter((p) => p.is_recommended);
      if (c.kind === 'PROMOTION') return list.filter((p) => !!promoFor(p));
      return list.filter((p) => p.category_id === c.id);
    };
    return { availability, promoFor, visibleCategories, productsIn, livePromos };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, tz, tick, boot?.kiosk.branchId]);

  return { boot, menu, error, fromCache, reloadBoot: loadBoot, reloadMenu: loadMenu, applyStock, ...helpers };
}
