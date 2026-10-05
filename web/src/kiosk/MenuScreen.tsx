import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Plus, ShoppingCart, Star, Tag, X, Search } from 'lucide-react';
import { priceCart, tr, type MenuCategory, type MenuProduct } from '@kiosk/shared';
import { useK } from './context';
import { KioskHeader, ProductImage } from './components';
import { modifierTotal, useKiosk, type ProductAvailability } from './store';

export function useCartPricing() {
  const { data } = useK();
  const { lines, orderType, promoCode } = useKiosk();
  return useMemo(() => {
    const byId = new Map((data.menu?.products ?? []).map((p) => [p.id, p]));
    const input = lines
      .filter((l) => byId.has(l.productId))
      .map((l) => {
        const p = byId.get(l.productId)!;
        const rec = l.upsellSourceProductId && lines.some((x) => x.productId === l.upsellSourceProductId)
          ? byId.get(l.upsellSourceProductId)?.recommendations.find((r) => r.product_id === p.id)
          : null;
        return { key: l.key, productId: p.id, categoryId: p.category_id, qty: l.qty, basePrice: rec?.special_price ?? Number(p.price), modifierTotal: modifierTotal(p, l.modifierIds), vatRate: p.vat_rate };
      });
    return priceCart(input, {
      promotions: data.menu?.promotions ?? [],
      tax: data.boot?.settings?.tax ?? { vatRate: 7, vatMode: 'INCLUDED', serviceChargeRate: 0, serviceChargeOrderTypes: [] },
      orderType: orderType ?? 'DINE_IN',
      promoCode,
      branchId: data.boot?.kiosk.branchId,
      timeZone: data.boot?.branch.timezone,
    });
  }, [data.menu, data.boot, lines, orderType, promoCode]);
}

const ICONS: Record<string, string> = { star: '⭐', tag: '🏷️', set: '🍱', burger: '🍔', chicken: '🍗', rice: '🍛', noodles: '🍜', drink: '🥤', dessert: '🍨', other: '🍟' };

function CategoryIcon({ c }: { c: MenuCategory }) {
  if (c.image_url) return <img src={c.image_url} alt="" className="h-14 w-14 object-contain" draggable={false} />;
  if (c.kind === 'RECOMMENDED') return <Star className="h-10 w-10" />;
  if (c.kind === 'PROMOTION') return <Tag className="h-10 w-10" />;
  return <span className="text-4xl">{ICONS[c.icon ?? ''] ?? '🍽️'}</span>;
}

export function ProductCard({ p, onOpen }: { p: MenuProduct; onOpen: () => void }) {
  const { t, lang, money, data } = useK();
  const av: ProductAvailability = data.availability(p);
  const promo = data.promoFor(p);
  const cardStyle = data.boot?.settings?.theme?.cardStyle ?? 'ELEVATED';
  const disabled = av !== 'OK';
  return (
    <button
      onClick={onOpen}
      disabled={disabled}
      className={clsx(
        'press group relative flex flex-col overflow-hidden rounded-brand bg-surface text-left',
        cardStyle === 'ELEVATED' && 'shadow-[0_8px_30px_rgba(0,0,0,0.08)]',
        cardStyle === 'OUTLINE' && 'border-2 border-black/10',
        disabled && 'cursor-not-allowed',
      )}
    >
      <div className="relative flex aspect-[4/3] items-center justify-center bg-gradient-to-b from-black/[0.03] to-black/[0.06] p-4">
        <ProductImage src={p.image_url} alt={tr(p.name, lang)} className={clsx('h-full w-full transition group-active:scale-95', disabled && 'opacity-40 grayscale')} />
        {promo && !disabled && <span className="absolute top-3 left-3 rounded-full bg-primary px-3 py-1 text-sm font-bold text-white shadow">{tr(promo.badge, lang) || t('promotion')}</span>}
        {p.is_recommended && !promo && !disabled && <span className="absolute top-3 left-3 rounded-full bg-accent px-3 py-1 text-sm font-bold text-ink shadow">★ {t('recommended')}</span>}
        {disabled && (
          <span className={clsx('absolute inset-x-0 top-1/2 -translate-y-1/2 -rotate-6 py-2 text-center text-2xl font-black tracking-wide text-white shadow-lg', av === 'SOLD_OUT' ? 'bg-rose-600' : 'bg-slate-700')}>
            {av === 'SOLD_OUT' ? t('soldOut') : av === 'NOT_NOW' ? t('notNow') : t('unavailable')}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-4">
        <div className="line-clamp-2 text-[1.35rem] leading-tight font-bold">{tr(p.name, lang)}</div>
        <div className="line-clamp-2 text-base text-black/55">{tr(p.short_description, lang)}</div>
        <div className="mt-auto flex items-end justify-between pt-2">
          <span className="text-2xl font-extrabold text-primary">{money(p.price)}</span>
          {!disabled && <span className="flex h-11 w-11 items-center justify-center rounded-full bg-btn text-btn-text shadow"><Plus className="h-6 w-6" strokeWidth={3} /></span>}
        </div>
      </div>
    </button>
  );
}

export function MenuScreen({ onHome, onCart }: { onHome: () => void; onCart: () => void }) {
  const { t, lang, money, data, openProduct } = useK();
  const lines = useKiosk((s) => s.lines);
  const pricing = useCartPricing();
  const cats = data.visibleCategories.filter((c) => data.productsIn(c).length > 0);
  const [active, setActive] = useState<string | null>(null);
  const [search, setSearch] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const activeCat = cats.find((c) => c.id === active) ?? cats[0];

  useEffect(() => {
    gridRef.current?.scrollTo({ top: 0 });
  }, [active]);

  const products = useMemo(() => {
    if (search !== null) {
      const q = search.trim().toLowerCase();
      if (!q) return [];
      return (data.menu?.products ?? []).filter((p) => [p.name.th, p.name.en, p.name.zh, p.sku].some((s) => s?.toLowerCase().includes(q)));
    }
    return activeCat ? data.productsIn(activeCat) : [];
  }, [search, activeCat, data]);

  const count = lines.reduce((s, l) => s + l.qty, 0);

  return (
    <div className="flex h-full flex-col">
      <KioskHeader onHome={onHome} onSearch={() => setSearch('')} />
      <div className="flex min-h-0 flex-1">
        <nav className="no-scrollbar w-40 shrink-0 overflow-y-auto border-r border-black/5 bg-surface py-3 lg:w-48">
          {cats.map((c) => {
            const on = search === null && activeCat?.id === c.id;
            return (
              <button
                key={c.id}
                onClick={() => {
                  setSearch(null);
                  setActive(c.id);
                }}
                className={clsx('press relative mx-2 mb-2 flex w-[calc(100%-1rem)] flex-col items-center gap-2 rounded-brand px-2 py-4 text-center', on ? 'bg-primary text-white shadow-lg' : 'text-ink hover:bg-black/5')}
              >
                <CategoryIcon c={c} />
                <span className="text-lg leading-tight font-semibold">{tr(c.name, lang)}</span>
              </button>
            );
          })}
        </nav>
        <main ref={gridRef} className="scroll-thin min-w-0 flex-1 overflow-y-auto p-6 pb-40">
          {search !== null ? (
            <div className="mb-6 flex items-center gap-3">
              <div className="flex h-16 flex-1 items-center gap-3 rounded-full bg-surface px-6 shadow">
                <Search className="h-6 w-6 text-black/40" />
                <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('searchPlaceholder')} className="h-full flex-1 bg-transparent text-2xl outline-none" />
              </div>
              <button onClick={() => setSearch(null)} className="press flex h-16 w-16 items-center justify-center rounded-full bg-surface shadow">
                <X className="h-7 w-7" />
              </button>
            </div>
          ) : (
            <h2 className="mb-5 text-[2.2rem] font-extrabold">{tr(activeCat?.name, lang)}</h2>
          )}
          {search !== null && search.trim() && products.length === 0 && <div className="py-24 text-center text-2xl text-black/40">{t('noResults')}</div>}
          <div className="grid grid-cols-2 gap-5 xl:grid-cols-3 2xl:grid-cols-4">
            {products.map((p, i) => (
              <div key={p.id} className="anim-pop" style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}>
                <ProductCard p={p} onOpen={() => openProduct(p)} />
              </div>
            ))}
          </div>
        </main>
      </div>

      <div className={clsx('absolute inset-x-0 bottom-0 z-20 p-5 transition-transform duration-300', count ? 'translate-y-0' : 'translate-y-full')}>
        <div className="mx-auto flex max-w-5xl items-center gap-4 rounded-[calc(var(--brand-radius)*1.3)] bg-secondary p-3 pl-6 text-white shadow-2xl">
          <div className="relative">
            <ShoppingCart className="h-10 w-10" />
            <span className="absolute -top-2 -right-3 flex h-7 min-w-7 items-center justify-center rounded-full bg-accent px-1.5 text-base font-bold text-ink">{count}</span>
          </div>
          <div className="ml-3 flex-1">
            <div className="text-base text-white/70">{t('orderTotalItems', { n: count })}</div>
            <div className="text-3xl font-extrabold tabular-nums">{money(pricing.total)}</div>
          </div>
          <button onClick={onCart} className="press h-20 rounded-brand bg-btn px-10 text-2xl font-bold text-btn-text shadow-lg">
            {t('viewCart')} →
          </button>
        </div>
      </div>
    </div>
  );
}
