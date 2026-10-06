import { Link } from 'react-router-dom';
import {
  Cable, ChefHat, CreditCard, DoorOpen, Globe, LayoutDashboard, Lock, MonitorSmartphone, ShieldCheck, ShoppingBag, Ticket, Timer, Tv, UserRound, Wallet, Gamepad2,
} from 'lucide-react';
import { LangSwitcher, defineStrings, useT } from '../lib/lang';

const L = defineStrings('launcher', {
  title: { th: 'แพลตฟอร์มสวนสนุก & ร้านอาหาร', en: 'Theme Park & Restaurant Platform', zh: '乐园与餐饮平台' },
  sub: { th: 'เลือกโหมดการใช้งานของเครื่องนี้', en: 'Choose what this device is used for', zh: '选择此设备的用途' },
  customers: { th: 'สำหรับลูกค้า', en: 'For guests', zh: '面向游客' },
  park: { th: 'งานสวนสนุก', en: 'Park operations', zh: '乐园运营' },
  restaurant: { th: 'ร้านอาหาร', en: 'Restaurant', zh: '餐饮' },
  backoffice: { th: 'หลังบ้าน', en: 'Back office', zh: '后台' },
  web: { th: 'เว็บไซต์ & จองบัตร', en: 'Website & booking', zh: '官网与订票' },
  member: { th: 'สมาชิก / บัตรดิจิทัล', en: 'Member portal', zh: '会员中心' },
  pkiosk: { th: 'ตู้ขายบัตรอัตโนมัติ', en: 'Ticket kiosk', zh: '自助售票机' },
  locker: { th: 'ตู้ล็อกเกอร์', en: 'Locker station', zh: '储物柜站' },
  counter: { th: 'เคาน์เตอร์ขายบัตร', en: 'Box office', zh: '售票处' },
  pos: { th: 'POS ร้านค้า / อาหาร', en: 'POS (retail / food)', zh: 'POS（零售/餐饮）' },
  gates: { th: 'ควบคุมประตู', en: 'Gate console', zh: '闸门操作台' },
  gate: { th: 'จอประตูทางเข้า', en: 'Gate display', zh: '闸门显示屏' },
  rides: { th: 'ควบคุมเครื่องเล่น', en: 'Ride operator', zh: '游乐设施操作' },
  ride: { th: 'จอสแกนเครื่องเล่น', en: 'Ride scanner', zh: '游乐设施扫描屏' },
  kiosk: { th: 'ตู้สั่งอาหาร', en: 'Food ordering kiosk', zh: '自助点餐机' },
  cashier: { th: 'แคชเชียร์', en: 'Cashier', zh: '收银' },
  kds: { th: 'จอครัว', en: 'Kitchen display', zh: '厨房显示' },
  queue: { th: 'จอเรียกคิว', en: 'Queue display', zh: '叫号屏' },
  admin: { th: 'ระบบหลังบ้าน', en: 'Admin dashboard', zh: '管理后台' },
});

type App = { to: string; icon: any; key: keyof typeof L.d; tone: string };
const GROUPS: { key: keyof typeof L.d; apps: App[] }[] = [
  { key: 'customers', apps: [
    { to: '/park', icon: Globe, key: 'web', tone: 'from-orange-500 to-rose-600' },
    { to: '/member', icon: UserRound, key: 'member', tone: 'from-amber-500 to-orange-600' },
    { to: '/park-kiosk', icon: MonitorSmartphone, key: 'pkiosk', tone: 'from-fuchsia-500 to-purple-700' },
    { to: '/locker', icon: Lock, key: 'locker', tone: 'from-cyan-500 to-sky-700' },
  ] },
  { key: 'park', apps: [
    { to: '/counter', icon: Ticket, key: 'counter', tone: 'from-emerald-500 to-teal-700' },
    { to: '/pos', icon: ShoppingBag, key: 'pos', tone: 'from-lime-500 to-green-700' },
    { to: '/gates', icon: ShieldCheck, key: 'gates', tone: 'from-indigo-500 to-blue-800' },
    { to: '/gate', icon: DoorOpen, key: 'gate', tone: 'from-slate-600 to-slate-900' },
    { to: '/rides', icon: Timer, key: 'rides', tone: 'from-violet-500 to-indigo-700' },
    { to: '/ride', icon: Gamepad2, key: 'ride', tone: 'from-pink-500 to-rose-700' },
  ] },
  { key: 'restaurant', apps: [
    { to: '/kiosk', icon: CreditCard, key: 'kiosk', tone: 'from-[#E4572E] to-[#c23e18]' },
    { to: '/cashier', icon: Wallet, key: 'cashier', tone: 'from-emerald-600 to-emerald-800' },
    { to: '/kds', icon: ChefHat, key: 'kds', tone: 'from-amber-500 to-orange-700' },
    { to: '/queue', icon: Tv, key: 'queue', tone: 'from-sky-500 to-indigo-600' },
  ] },
  { key: 'backoffice', apps: [{ to: '/admin', icon: LayoutDashboard, key: 'admin', tone: 'from-slate-700 to-slate-900' }] },
];

export default function Launcher() {
  const t = useT(L);
  return (
    <div className="min-h-full bg-[#FFF8F0] p-4 md:p-10">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex flex-wrap items-center gap-4">
          <img src="/icon.svg" alt="" className="h-14 w-14" />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-extrabold text-slate-900 md:text-3xl">{t('title')}</h1>
            <p className="text-slate-500">{t('sub')}</p>
          </div>
          <LangSwitcher />
        </div>
        {GROUPS.map((g) => (
          <section key={g.key} className="mb-8">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-bold tracking-wider text-slate-500 uppercase"><Cable className="h-4 w-4" />{t(g.key)}</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {g.apps.map((a) => (
                <Link key={a.to} to={a.to} className={`press group flex min-h-32 flex-col justify-between rounded-3xl bg-gradient-to-br ${a.tone} p-5 text-white shadow-lg`}>
                  <a.icon className="h-9 w-9 opacity-90" />
                  <div className="text-lg leading-tight font-bold">{t(a.key)}</div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
