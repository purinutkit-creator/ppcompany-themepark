import { useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, X } from 'lucide-react';
import { defaultModifierSelection, tr, validateModifierSelection, type MenuModifierGroup, type MenuProduct } from '@kiosk/shared';
import { useK } from './context';
import { KButton, ProductImage, Stepper } from './components';
import { modifierTotal, type CartLine } from './store';

export function ProductModal({ product, line, specialPrice, onClose, onSave }: { product: MenuProduct; line?: CartLine; specialPrice?: number | null; onClose: () => void; onSave: (v: { qty: number; modifierIds: string[]; specialRequest: string }) => void }) {
  const { t, lang, money } = useK();
  const [sel, setSel] = useState<string[]>(line?.modifierIds ?? defaultModifierSelection(product.modifier_groups));
  const [qty, setQty] = useState(line?.qty ?? 1);
  const [note, setNote] = useState(line?.specialRequest ?? '');
  const [showErrors, setShowErrors] = useState(false);
  const groupRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const errors = useMemo(() => validateModifierSelection(product.modifier_groups, sel), [product, sel]);
  const unit = (specialPrice ?? Number(product.price)) + modifierTotal(product, sel);

  const toggle = (g: MenuModifierGroup, id: string) => {
    setSel((s) => {
      const inGroup = s.filter((x) => g.modifiers.some((m) => m.id === x));
      if (g.selection === 'SINGLE') {
        if (s.includes(id) && !g.required) return s.filter((x) => x !== id);
        return [...s.filter((x) => !inGroup.includes(x)), id];
      }
      if (s.includes(id)) return s.filter((x) => x !== id);
      const max = g.max_select > 0 ? g.max_select : Infinity;
      if (inGroup.length >= max) return max === 1 ? [...s.filter((x) => !inGroup.includes(x)), id] : s;
      return [...s, id];
    });
  };

  const submit = () => {
    if (errors.length) {
      setShowErrors(true);
      const first = errors.find((e) => e.groupId)?.groupId;
      if (first) groupRefs.current[first]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    onSave({ qty, modifierIds: sel, specialRequest: note.trim() });
  };

  const rule = (g: MenuModifierGroup) => {
    if (g.selection === 'SINGLE') return t('chooseOne');
    if (g.max_select > 0) return t('chooseUpTo', { n: g.max_select });
    if (g.min_select > 0) return t('chooseAtLeast', { n: g.min_select });
    return t('optional');
  };

  return (
    <div className="anim-fade fixed inset-0 z-40 flex items-end justify-center bg-black/55 md:items-center" onClick={onClose}>
      <div className="anim-up flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-[2rem] bg-bg shadow-2xl md:rounded-[2rem]" onClick={(e) => e.stopPropagation()}>
        <div className="relative flex shrink-0 items-center gap-6 bg-surface p-6">
          <div className="flex h-44 w-44 shrink-0 items-center justify-center rounded-brand bg-black/[0.04] p-3">
            <ProductImage src={product.image_url} alt={tr(product.name, lang)} className="h-full w-full" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[2rem] leading-tight font-extrabold">{tr(product.name, lang)}</h3>
            <p className="mt-2 text-lg text-black/60">{tr(product.description, lang) || tr(product.short_description, lang)}</p>
            <div className="mt-3 text-3xl font-extrabold text-primary">
              {specialPrice != null && <span className="mr-3 text-xl text-black/35 line-through">{money(product.price)}</span>}
              {money(specialPrice ?? product.price)}
            </div>
          </div>
          <button onClick={onClose} className="press absolute top-4 right-4 flex h-14 w-14 items-center justify-center rounded-full bg-black/5" aria-label="close">
            <X className="h-7 w-7" />
          </button>
        </div>

        <div className="scroll-thin flex-1 space-y-6 overflow-y-auto p-6">
          {product.modifier_groups.map((g) => {
            const err = showErrors && errors.find((e) => e.groupId === g.id);
            return (
              <div key={g.id} ref={(el) => { groupRefs.current[g.id] = el; }} className={clsx('rounded-brand bg-surface p-5 transition', err && 'ring-4 ring-rose-400')}>
                <div className="mb-4 flex items-center justify-between">
                  <div className="text-2xl font-bold">{tr(g.name, lang)}</div>
                  <div className="flex items-center gap-2">
                    <span className="text-base text-black/50">{rule(g)}</span>
                    <span className={clsx('rounded-full px-3 py-1 text-sm font-bold', g.required ? 'bg-primary/10 text-primary' : 'bg-black/5 text-black/50')}>{g.required ? t('required') : t('optional')}</span>
                  </div>
                </div>
                {err && <div className="mb-3 text-lg font-semibold text-rose-600">{t('pleaseChoose', { group: tr(g.name, lang) })}</div>}
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                  {g.modifiers
                    .filter((m) => m.is_active)
                    .map((m) => {
                      const on = sel.includes(m.id);
                      return (
                        <button
                          key={m.id}
                          onClick={() => toggle(g, m.id)}
                          className={clsx('press flex min-h-20 items-center gap-3 rounded-2xl border-[3px] px-4 py-3 text-left', on ? 'border-primary bg-primary/10' : 'border-black/10 bg-white')}
                        >
                          <span className={clsx('flex h-8 w-8 shrink-0 items-center justify-center border-2', g.selection === 'SINGLE' ? 'rounded-full' : 'rounded-lg', on ? 'border-primary bg-primary text-white' : 'border-black/25')}>
                            {on && <Check className="h-5 w-5" strokeWidth={3} />}
                          </span>
                          <span className="flex-1">
                            <span className="block text-xl leading-tight font-semibold">
                              {g.kind === 'REMOVE' ? '− ' : ''}
                              {tr(m.name, lang)}
                            </span>
                            {Number(m.price_delta) !== 0 && <span className="text-lg font-semibold text-primary">{Number(m.price_delta) > 0 ? '+' : ''}{money(m.price_delta)}</span>}
                          </span>
                        </button>
                      );
                    })}
                </div>
              </div>
            );
          })}
          <div className="rounded-brand bg-surface p-5">
            <div className="mb-3 text-2xl font-bold">{t('specialRequest')}</div>
            <textarea value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={t('specialPlaceholder')} className="h-24 w-full rounded-2xl border-2 border-black/10 p-4 text-xl outline-none focus:border-primary" />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-5 border-t border-black/5 bg-surface p-5">
          <Stepper value={qty} onChange={setQty} min={1} size="lg" />
          <KButton className="flex-1" size="xl" onClick={submit}>
            <span>{line ? t('updateItem') : t('addToCart')}</span>
            <span className="tabular-nums">{money(unit * qty)}</span>
          </KButton>
        </div>
      </div>
    </div>
  );
}

export function UpsellModal({ source, onAdd, onClose }: { source: MenuProduct; onAdd: (p: MenuProduct, specialPrice: number | null) => void; onClose: () => void }) {
  const { t, lang, money, data } = useK();
  const recs = source.recommendations
    .map((r) => ({ r, p: data.menu?.products.find((x) => x.id === r.product_id) }))
    .filter((x): x is { r: (typeof source.recommendations)[number]; p: MenuProduct } => !!x.p && data.availability(x.p) === 'OK');
  if (!recs.length) return null;
  return (
    <div className="anim-fade fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-6" onClick={onClose}>
      <div className="anim-pop w-full max-w-4xl rounded-[2rem] bg-bg p-8 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-6 text-center text-[2.4rem] font-extrabold">{t('upsellTitle')}</h3>
        <div className={clsx('grid gap-5', recs.length > 1 ? 'md:grid-cols-2' : 'mx-auto max-w-md')}>
          {recs.map(({ r, p }) => (
            <div key={p.id} className="flex flex-col items-center gap-3 rounded-brand bg-surface p-6 text-center shadow-lg">
              <div className="text-2xl font-bold text-primary">{tr(r.message, lang)}</div>
              <ProductImage src={p.image_url} alt="" className="h-40 w-40" />
              <div className="text-2xl font-bold">{tr(p.name, lang)}</div>
              <div className="text-2xl font-extrabold">
                {r.special_price != null && <span className="mr-2 text-lg text-black/35 line-through">{money(p.price)}</span>}
                {money(r.special_price ?? p.price)}
              </div>
              <KButton className="w-full" onClick={() => onAdd(p, r.special_price)}>
                + {t('add')}
              </KButton>
            </div>
          ))}
        </div>
        <div className="mt-6 text-center">
          <KButton variant="secondary" size="lg" onClick={onClose} className="min-w-80">
            {t('noThanks')}
          </KButton>
        </div>
      </div>
    </div>
  );
}
