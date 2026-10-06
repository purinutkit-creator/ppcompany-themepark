import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ShoppingCart } from 'lucide-react';
import { applyTheme } from '../lib/theme';
import { Button, Card, Field, Input, Loading, MediaInput, NumberInput, PageHeader, Select } from '../components/ui';
import { useSettings, useSaveSetting } from './hooks';
import { tt } from '../lib/legacy-i18n';

const COLORS: [string, string][] = [['primary', 'Primary'], ['secondary', 'Secondary'], ['accent', 'Accent'], ['background', 'Background'], ['surface', 'Card / surface'], ['buttonColor', 'Button'], ['buttonText', 'Button text'], ['text', 'Text']];
const PRESETS: Record<string, any> = {
  'Krua Hub (default)': { primary: '#E4572E', secondary: '#2D3142', accent: '#FFC145', background: '#FFF8F0', surface: '#FFFFFF', buttonColor: '#E4572E', buttonText: '#FFFFFF', text: '#1F2333' },
  'Fresh green': { primary: '#2F9E44', secondary: '#1B4332', accent: '#FFD43B', background: '#F4FBF4', surface: '#FFFFFF', buttonColor: '#2F9E44', buttonText: '#FFFFFF', text: '#14281D' },
  'Midnight premium': { primary: '#C9A227', secondary: '#111111', accent: '#C9A227', background: '#F6F3EC', surface: '#FFFFFF', buttonColor: '#111111', buttonText: '#F6E7B8', text: '#111111' },
  'Ocean': { primary: '#1971C2', secondary: '#0B2545', accent: '#5BC0EB', background: '#F1F7FD', surface: '#FFFFFF', buttonColor: '#1971C2', buttonText: '#FFFFFF', text: '#0B2545' },
};

export default function Theme() {
  const s = useSettings();
  const save = useSaveSetting();
  const [t, setT] = useState<any>(null);
  const preview = useRef<HTMLDivElement>(null);
  useEffect(() => setT(s.data?.settings.theme), [s.data]);
  useEffect(() => {
    if (t && preview.current) applyTheme(t, preview.current);
  }, [t]);
  if (!t) return <Loading />;
  const set = (k: string, v: any) => setT({ ...t, [k]: v });
  return (
    <div>
      <PageHeader title={tt('Theme')} sub={tt('Brand colors, radius, logo and welcome media — live preview, applied to every kiosk instantly on save')} actions={<Button onClick={() => save.mutate({ key: 'theme', value: t })} loading={save.isPending}>{tt('Save & apply')}</Button>} />
      <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
        <Card title={tt('Settings')}>
          <div className="mb-4 flex flex-wrap gap-2">
            {Object.entries(PRESETS).map(([n, p]) => (
              <button key={n} onClick={() => setT({ ...t, ...p })} className="flex items-center gap-2 rounded-full border px-3 py-1 text-xs hover:bg-slate-50">
                <span className="h-3 w-3 rounded-full" style={{ background: p.primary }} />{n}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {COLORS.map(([k, l]) => (
              <Field key={k} label={l}>
                <div className="flex gap-2">
                  <input type="color" value={t[k]} onChange={(e) => set(k, e.target.value)} className="h-10 w-12 cursor-pointer rounded-lg border" />
                  <Input value={t[k]} onChange={(e) => set(k, e.target.value)} className="font-mono text-xs" />
                </div>
              </Field>
            ))}
            <Field label={tt('Corner radius (px)')}><NumberInput value={t.radius} onChange={(v) => set('radius', v ?? 16)} min={0} max={40} /></Field>
            <Field label={tt('Product card style')}><Select value={t.cardStyle} onChange={(e) => set('cardStyle', e.target.value)}><option value="ELEVATED">{tt('Elevated')}</option><option value="FLAT">{tt('Flat')}</option><option value="OUTLINE">{tt('Outline')}</option></Select></Field>
          </div>
          <div className="mt-4 space-y-4">
            <MediaInput label={tt('Logo')} value={t.logoUrl} onChange={(v) => set('logoUrl', v)} />
            <MediaInput label={tt('Welcome image')} value={t.welcomeImageUrl} onChange={(v) => set('welcomeImageUrl', v)} />
            <MediaInput label={tt('Welcome video (mp4/webm)')} kind="video" value={t.welcomeVideoUrl} onChange={(v) => set('welcomeVideoUrl', v)} />
            <p className="text-xs text-slate-500">{tt('Fonts are managed in Admin → Fonts.')}</p>
          </div>
        </Card>
        <Card title={tt('Live preview — kiosk')}>
          <div ref={preview} className="overflow-hidden rounded-2xl border" style={{ background: 'var(--brand-bg)', color: 'var(--brand-text)', fontFamily: 'var(--font-app)' }}>
            <div className="flex items-center justify-between px-5 py-3" style={{ background: 'var(--brand-surface)' }}>
              <div className="flex items-center gap-2 font-bold">{t.logoUrl ? <img src={t.logoUrl} className="h-8" alt="" /> : <span className="h-8 w-8 rounded-lg" style={{ background: 'var(--brand-primary)' }} />} Krua Hub</div>
              <div className="flex gap-1 text-xs"><span className="rounded-full px-3 py-1 text-white" style={{ background: 'var(--brand-secondary)' }}>ไทย</span><span className="rounded-full bg-black/5 px-3 py-1">EN</span><span className="rounded-full bg-black/5 px-3 py-1">中文</span></div>
            </div>
            <div className="flex">
              <div className="w-28 space-y-2 p-3" style={{ background: 'var(--brand-surface)' }}>
                {['🍔 Burger', '🍗 Chicken', '🥤 Drinks'].map((c, i) => (
                  <div key={c} className="p-2 text-center text-xs font-semibold" style={{ borderRadius: 'var(--brand-radius)', background: i === 0 ? 'var(--brand-primary)' : 'transparent', color: i === 0 ? '#fff' : undefined }}>{c}</div>
                ))}
              </div>
              <div className="grid flex-1 grid-cols-3 gap-3 p-4">
                {['burger', 'chicken', 'cola'].map((img, i) => (
                  <div key={img} className={clsx('overflow-hidden', t.cardStyle === 'ELEVATED' && 'shadow-lg', t.cardStyle === 'OUTLINE' && 'border-2 border-black/10')} style={{ borderRadius: 'var(--brand-radius)', background: 'var(--brand-surface)' }}>
                    <div className="relative flex aspect-[4/3] items-center justify-center bg-black/5 p-3">
                      <img src={`/menu/${img}.svg`} className="h-full" alt="" />
                      {i === 0 && <span className="absolute top-2 left-2 rounded-full px-2 text-[10px] font-bold text-white" style={{ background: 'var(--brand-primary)' }}>-20%</span>}
                    </div>
                    <div className="p-3">
                      <div className="text-sm font-bold">{['Cheese Burger', 'Fried Chicken', 'Cola'][i]}</div>
                      <div className="mt-1 flex items-center justify-between">
                        <span className="font-extrabold" style={{ color: 'var(--brand-primary)' }}>฿{[129, 99, 35][i]}</span>
                        <span className="flex h-7 w-7 items-center justify-center rounded-full text-white" style={{ background: 'var(--brand-button)', color: 'var(--brand-button-text)' }}>+</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="m-4 flex items-center gap-3 p-3 text-white" style={{ background: 'var(--brand-secondary)', borderRadius: 'var(--brand-radius)' }}>
              <ShoppingCart className="h-6 w-6" />
              <span className="flex-1 font-bold">฿263.00</span>
              <span className="px-5 py-2 font-bold" style={{ background: 'var(--brand-button)', color: 'var(--brand-button-text)', borderRadius: 'var(--brand-radius)' }}>{tt('View cart →')}</span>
            </div>
            <div className="m-4 mt-0 h-2 rounded" style={{ background: 'var(--brand-accent)' }} />
          </div>
        </Card>
      </div>
    </div>
  );
}
