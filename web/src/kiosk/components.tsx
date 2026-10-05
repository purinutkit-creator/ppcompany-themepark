import { useContext, type ReactNode } from 'react';
import clsx from 'clsx';
import { Home, Minus, Plus, Search, WifiOff } from 'lucide-react';
import { tr, type I18nText, type Lang } from '@kiosk/shared';
import { LANG_META } from '../lib/i18n';
import { KioskContext, useK } from './context';

export function KButton({ children, onClick, variant = 'primary', size = 'lg', className, disabled, icon }: { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'secondary' | 'ghost' | 'dark' | 'success' | 'danger'; size?: 'md' | 'lg' | 'xl'; className?: string; disabled?: boolean; icon?: ReactNode }) {
  const v = {
    primary: 'bg-btn text-btn-text shadow-lg shadow-black/10',
    secondary: 'bg-white text-ink border-2 border-black/10',
    ghost: 'bg-transparent text-ink',
    dark: 'bg-secondary text-white',
    success: 'bg-emerald-600 text-white',
    danger: 'bg-rose-600 text-white',
  }[variant];
  const s = { md: 'h-14 px-6 text-lg', lg: 'h-[72px] px-8 text-xl', xl: 'h-24 px-10 text-3xl' }[size];
  return (
    <button disabled={disabled} onClick={onClick} className={clsx('press inline-flex items-center justify-center gap-3 rounded-brand font-semibold disabled:opacity-40', v, s, className)}>
      {icon}
      {children}
    </button>
  );
}

export function Stepper({ value, onChange, min = 0, max = 99, size = 'md' }: { value: number; onChange: (v: number) => void; min?: number; max?: number; size?: 'md' | 'lg' }) {
  const b = size === 'lg' ? 'h-16 w-16' : 'h-12 w-12';
  return (
    <div className="inline-flex items-center gap-3 rounded-full bg-black/5 p-1.5">
      <button aria-label="decrease" className={clsx('press flex items-center justify-center rounded-full bg-white shadow disabled:opacity-40', b)} disabled={value <= min} onClick={() => onChange(value - 1)}>
        <Minus className="h-6 w-6" />
      </button>
      <span className={clsx('min-w-10 text-center font-bold tabular-nums', size === 'lg' ? 'text-3xl' : 'text-2xl')}>{value}</span>
      <button aria-label="increase" className={clsx('press flex items-center justify-center rounded-full bg-btn text-btn-text shadow disabled:opacity-40', b)} disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Plus className="h-6 w-6" />
      </button>
    </div>
  );
}

export function LangSwitch({ compact = false }: { compact?: boolean }) {
  const { lang, setLang, enabledLangs } = useK();
  return (
    <div className="flex gap-2">
      {enabledLangs.map((l: Lang) => (
        <button
          key={l}
          onClick={(e) => {
            e.stopPropagation();
            setLang(l);
          }}
          className={clsx(
            'press flex items-center gap-2 rounded-full font-semibold',
            compact ? 'h-12 px-4 text-base' : 'h-16 px-6 text-xl',
            lang === l ? 'bg-secondary text-white shadow-lg' : 'bg-white/90 text-ink shadow',
          )}
        >
          <span className={compact ? 'text-xl' : 'text-2xl'}>{LANG_META[l].flag}</span>
          {LANG_META[l].label}
        </button>
      ))}
    </div>
  );
}

export function Logo({ size = 56, light = false }: { size?: number; light?: boolean }) {
  // Also rendered on the loading screen, before the kiosk context exists.
  const ctx = useContext(KioskContext);
  const lang = ctx?.lang ?? 'th';
  const s = ctx?.data.boot?.settings;
  const url = s?.theme?.logoUrl || s?.store?.logoUrl;
  const name = tr(s?.store?.name, lang, 'Krua Hub');
  return (
    <div className="flex items-center gap-3">
      {url ? (
        <img src={url} alt={name} style={{ height: size }} className="object-contain" />
      ) : (
        <div style={{ height: size, width: size }} className="flex items-center justify-center rounded-2xl bg-primary text-white shadow-lg">
          <svg viewBox="0 0 48 48" style={{ height: size * 0.62 }} fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 22h32a16 16 0 0 1-32 0Z" fill="currentColor" fillOpacity=".15" />
            <path d="M8 22h32a16 16 0 0 1-32 0Z" />
            <path d="M17 14c0-3 3-3 3-6M24 14c0-3 3-3 3-6M31 14c0-3 3-3 3-6" />
          </svg>
        </div>
      )}
      <div className={clsx('leading-tight font-bold', light ? 'text-white' : 'text-ink')} style={{ fontSize: size * 0.42 }}>
        {name}
      </div>
    </div>
  );
}

export function KioskHeader({ onHome, onSearch, right }: { onHome: () => void; onSearch?: () => void; right?: ReactNode }) {
  const { t, online } = useK();
  return (
    <header className="flex h-24 shrink-0 items-center justify-between gap-4 border-b border-black/5 bg-surface px-6">
      <Logo size={52} />
      <div className="flex items-center gap-3">
        {!online && (
          <span className="flex items-center gap-2 rounded-full bg-amber-100 px-4 py-2 text-base font-semibold text-amber-800">
            <WifiOff className="h-5 w-5" /> {t('offline')}
          </span>
        )}
        {onSearch && (
          <button onClick={onSearch} className="press flex h-12 items-center gap-2 rounded-full bg-black/5 px-5 text-lg font-medium">
            <Search className="h-5 w-5" /> {t('search')}
          </button>
        )}
        <LangSwitch compact />
        <button onClick={onHome} className="press flex h-12 items-center gap-2 rounded-full bg-black/5 px-5 text-lg font-medium">
          <Home className="h-5 w-5" /> {t('home')}
        </button>
        {right}
      </div>
    </header>
  );
}

export function ProductImage({ src, alt, className }: { src: string | null | undefined; alt: string; className?: string }) {
  return src ? (
    <img src={src} alt={alt} draggable={false} loading="lazy" className={clsx('object-contain', className)} />
  ) : (
    <div className={clsx('flex items-center justify-center bg-gradient-to-br from-accent/30 to-primary/20 text-5xl', className)}>🍽️</div>
  );
}

export const trI = (v: I18nText | null | undefined, lang: Lang) => tr(v, lang);
