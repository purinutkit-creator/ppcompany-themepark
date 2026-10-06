import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { parkPublicApi } from '../lib/api';
import { LangSwitcher, defineStrings, useSurfaceFont, useT, useUiLang } from '../lib/lang';
import { applyTheme } from '../lib/theme';
import { Loading } from '../components/ui';

export const CS = defineStrings('site', {
  home: { th: 'หน้าแรก', en: 'Home', zh: '首页' },
  buyTickets: { th: 'ซื้อบัตร', en: 'Buy tickets', zh: '购票' },
  liveStatus: { th: 'สถานะเครื่องเล่น', en: 'Live rides', zh: '实时状态' },
  membership: { th: 'สมาชิก', en: 'Membership', zh: '会员' },
  myBookings: { th: 'การจองของฉัน', en: 'My bookings', zh: '我的预订' },
  myAccount: { th: 'บัญชีของฉัน', en: 'My account', zh: '我的账户' },
  openHours: { th: 'เปิดทุกวัน {open} – {close} น.', en: 'Open daily {open} – {close}', zh: '每日 {open} – {close} 开放' },
});

interface Boot {
  settings: any;
  branches: any[];
  languages: any[];
  fonts: any[];
  ticketTypes: any[];
}
const Ctx = createContext<Boot | null>(null);
export const useBoot = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('CustomerShell missing');
  return c;
};

/** Theme + fonts (per language) + language overrides for the public website / member portal / park kiosk. */
export function CustomerProvider({ children, surface = 'web' }: { children: ReactNode; surface?: string }) {
  const q = useQuery({ queryKey: ['park-bootstrap'], queryFn: () => parkPublicApi<Boot>('/bootstrap'), staleTime: 60_000 });
  const setOverrides = useUiLang((s) => s.setOverrides);
  useEffect(() => {
    if (!q.data) return;
    applyTheme(q.data.settings.theme);
    setOverrides(q.data.languages);
  }, [q.data, setOverrides]);
  useSurfaceFont(q.data?.settings.fonts, q.data?.fonts, surface);
  if (!q.data) return <Loading />;
  return <Ctx.Provider value={q.data}>{children}</Ctx.Provider>;
}

export function SiteHeader({ right }: { right?: ReactNode }) {
  const t = useT(CS);
  const b = useBoot();
  const s = b.settings.park;
  const nav = [
    { to: '/park', label: t('home'), end: true },
    { to: '/park/book', label: t('buyTickets') },
    { to: '/park/live', label: t('liveStatus') },
    { to: '/member', label: t('myAccount') },
  ];
  return (
    <header className="sticky top-0 z-30 border-b border-black/5 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
        <Link to="/park" className="flex min-w-0 items-center gap-2.5">
          <img src={s.logoUrl || '/icon.svg'} alt="" className="h-9 w-9 rounded-xl object-contain" />
          <div className="min-w-0">
            <div className="truncate font-extrabold leading-tight">{t.tr(s.name)}</div>
            <div className="hidden truncate text-xs text-slate-500 sm:block">{t('openHours', { open: s.openTime, close: s.closeTime })}</div>
          </div>
        </Link>
        <nav className="ml-4 hidden items-center gap-1 md:flex">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => clsx('rounded-xl px-3 py-2 text-sm font-medium', isActive ? 'bg-primary/10 text-primary' : 'text-slate-600 hover:bg-slate-100')}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {right}
          <LangSwitcher compact />
        </div>
      </div>
      <nav className="no-scrollbar flex gap-1 overflow-x-auto px-3 pb-2 md:hidden">
        {nav.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => clsx('shrink-0 rounded-full px-3 py-1.5 text-sm', isActive ? 'bg-primary text-white' : 'bg-slate-100 text-slate-700')}>
            {n.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
