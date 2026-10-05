import { useState } from 'react';
import clsx from 'clsx';
import { Pencil, ShoppingBag, Trash2, Utensils, TicketPercent } from 'lucide-react';
import { tr, type PricingResult } from '@kiosk/shared';
import { kioskApi } from '../lib/api';
import { useK } from './context';
import { KButton, KioskHeader, ProductImage, Stepper } from './components';
import { useCartPricing } from './MenuScreen';
import { useKiosk } from './store';

export function Summary({ p, big = false }: { p: Pick<PricingResult, 'subtotal' | 'discount' | 'serviceCharge' | 'vat' | 'total'> & { appliedPromotions?: PricingResult['appliedPromotions'] }; big?: boolean }) {
  const { t, money, data, lang } = useK();
  const vatIncluded = data.boot?.settings?.tax?.vatMode !== 'EXCLUDED';
  const row = (label: string, v: string, cls = '') => (
    <div className={clsx('flex justify-between', cls)}>
      <span>{label}</span>
      <span className="tabular-nums">{v}</span>
    </div>
  );
  return (
    <div className={clsx('space-y-2', big ? 'text-xl' : 'text-lg')}>
      {row(t('subtotal'), money(p.subtotal), 'text-black/70')}
      {p.discount > 0 && (
        <>
          {row(t('discount'), `−${money(p.discount)}`, 'font-semibold text-emerald-600')}
          {p.appliedPromotions?.map((a) => (
            <div key={a.promotionId} className="flex justify-between pl-4 text-base text-emerald-700/80">
              <span>• {tr(a.name, lang)}</span>
              <span>−{money(a.amount)}</span>
            </div>
          ))}
        </>
      )}
      {p.serviceCharge > 0 && row(t('serviceCharge'), money(p.serviceCharge), 'text-black/70')}
      {row(vatIncluded ? `${t('vat')} (${t('vatIncluded')})` : t('vat'), money(p.vat), 'text-black/50 text-base')}
      <div className="my-2 border-t-2 border-dashed border-black/10" />
      <div className="flex items-end justify-between">
        <span className="text-2xl font-bold">{t('grandTotal')}</span>
        <span className="text-[2.6rem] leading-none font-extrabold text-primary tabular-nums">{money(p.total)}</span>
      </div>
    </div>
  );
}

export function CartScreen({ onHome, onMore, onCheckout, busy }: { onHome: () => void; onMore: () => void; onCheckout: () => void; busy: boolean }) {
  const { t, lang, money, data, openProduct } = useK();
  const { lines, setQty, removeLine, orderType, promoCode, setPromo, setOrderType } = useKiosk();
  const pricing = useCartPricing();
  const [code, setCode] = useState(promoCode ?? '');
  const [codeMsg, setCodeMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const allowPromo = data.boot?.settings?.kiosk?.allowPromoCode !== false;
  const products = new Map((data.menu?.products ?? []).map((p) => [p.id, p]));
  const blocked = lines.some((l) => {
    const p = products.get(l.productId);
    return !p || data.availability(p) !== 'OK';
  });

  const applyCode = async () => {
    const c = code.trim().toUpperCase();
    if (!c) return;
    setChecking(true);
    try {
      const r = await kioskApi<PricingResult>('/quote', {
        body: { orderType: orderType ?? 'DINE_IN', promoCode: c, items: lines.map((l) => ({ productId: l.productId, qty: l.qty, modifierIds: l.modifierIds, upsellSourceProductId: l.upsellSourceProductId ?? null })) },
      });
      if (r.invalidCode) {
        setCodeMsg({ ok: false, text: t('invalidCode') });
        setPromo(null);
      } else {
        setPromo(c);
        setCodeMsg({ ok: true, text: t('codeApplied') });
      }
    } catch {
      setCodeMsg({ ok: false, text: t('errorNetwork') });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <KioskHeader onHome={onHome} />
      <div className="flex min-h-0 flex-1 flex-col gap-6 p-6 lg:flex-row">
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-[2.4rem] font-extrabold">{t('yourOrder')}</h2>
            <button
              onClick={() => setOrderType(orderType === 'DINE_IN' ? 'TAKE_AWAY' : 'DINE_IN')}
              className="press flex items-center gap-2 rounded-full bg-secondary px-5 py-3 text-lg font-semibold text-white"
            >
              {orderType === 'TAKE_AWAY' ? <ShoppingBag className="h-5 w-5" /> : <Utensils className="h-5 w-5" />}
              {orderType === 'TAKE_AWAY' ? t('takeAway') : t('dineIn')}
            </button>
          </div>
          {!lines.length && (
            <div className="flex flex-col items-center gap-4 py-24 text-center">
              <div className="text-7xl">🛒</div>
              <div className="text-3xl font-bold">{t('emptyCart')}</div>
              <div className="text-xl text-black/50">{t('emptyCartSub')}</div>
              <KButton onClick={onMore}>{t('orderMore')}</KButton>
            </div>
          )}
          <div className="space-y-4">
            {lines.map((l) => {
              const p = products.get(l.productId);
              if (!p) return null;
              const priced = pricing.lines.find((x) => x.key === l.key);
              const av = data.availability(p);
              const mods = p.modifier_groups.flatMap((g) => g.modifiers.filter((m) => l.modifierIds.includes(m.id)).map((m) => ({ m, g })));
              return (
                <div key={l.key} className={clsx('anim-up flex gap-5 rounded-brand bg-surface p-5 shadow-sm', av !== 'OK' && 'ring-4 ring-rose-400')}>
                  <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-2xl bg-black/[0.04] p-2">
                    <ProductImage src={p.image_url} alt="" className="h-full w-full" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-2xl leading-tight font-bold">{tr(p.name, lang)}</div>
                      <div className="text-2xl font-extrabold tabular-nums">{money(priced?.lineTotal ?? 0)}</div>
                    </div>
                    {av !== 'OK' && <div className="text-lg font-bold text-rose-600">{av === 'SOLD_OUT' ? t('soldOut') : t('unavailable')}</div>}
                    <div className="mt-1 space-y-0.5 text-lg text-black/60">
                      {mods.map(({ m, g }) => (
                        <div key={m.id}>
                          {g.kind === 'REMOVE' ? '− ' : '+ '}
                          {tr(m.name, lang)}
                          {Number(m.price_delta) ? ` (${money(m.price_delta)})` : ''}
                        </div>
                      ))}
                      {l.specialRequest && <div className="italic">“{l.specialRequest}”</div>}
                    </div>
                    <div className="mt-1 text-base text-black/45">
                      {t('each')} {money(priced?.unitPrice ?? 0)}
                    </div>
                    <div className="mt-3 flex items-center gap-3">
                      <Stepper value={l.qty} onChange={(v) => setQty(l.key, v)} min={1} />
                      <button onClick={() => openProduct(p, { lineKey: l.key, upsellSourceProductId: l.upsellSourceProductId })} className="press flex h-12 items-center gap-2 rounded-full bg-black/5 px-5 text-lg font-medium">
                        <Pencil className="h-5 w-5" /> {t('edit')}
                      </button>
                      <button onClick={() => removeLine(l.key)} className="press ml-auto flex h-12 items-center gap-2 rounded-full bg-rose-50 px-5 text-lg font-medium text-rose-600">
                        <Trash2 className="h-5 w-5" /> {t('remove')}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-5 rounded-[calc(var(--brand-radius)*1.3)] bg-surface p-6 shadow-xl lg:w-[440px]">
          {allowPromo && (
            <div>
              <div className="mb-2 flex items-center gap-2 text-lg font-semibold">
                <TicketPercent className="h-5 w-5" /> {t('promoCode')}
              </div>
              <div className="flex gap-2">
                <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="h-14 min-w-0 flex-1 rounded-2xl border-2 border-black/10 px-4 text-xl uppercase outline-none focus:border-primary" />
                <KButton size="md" variant="dark" onClick={applyCode} disabled={checking || !code.trim()}>
                  {t('apply')}
                </KButton>
              </div>
              {codeMsg && <div className={clsx('mt-2 text-lg font-medium', codeMsg.ok ? 'text-emerald-600' : 'text-rose-600')}>{codeMsg.text}</div>}
            </div>
          )}
          <div className="mt-auto">
            <Summary p={pricing} />
          </div>
          <KButton size="xl" onClick={onCheckout} disabled={!lines.length || blocked || busy}>
            {busy ? t('processing') : t('checkout')}
          </KButton>
          <KButton variant="secondary" onClick={onMore}>
            + {t('orderMore')}
          </KButton>
        </aside>
      </div>
    </div>
  );
}
