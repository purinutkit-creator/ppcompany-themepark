import { Link } from 'react-router-dom';
import { ChefHat, LayoutDashboard, MonitorSmartphone, Tv, Wallet } from 'lucide-react';

const APPS = [
  { to: '/kiosk', icon: MonitorSmartphone, title: 'Self-Ordering Kiosk', th: 'ตู้สั่งอาหารด้วยตนเอง', tone: 'from-[#E4572E] to-[#c23e18]' },
  { to: '/cashier', icon: Wallet, title: 'Cashier / POS', th: 'แคชเชียร์ & ตรวจสอบการชำระเงิน', tone: 'from-emerald-500 to-emerald-700' },
  { to: '/kds', icon: ChefHat, title: 'Kitchen Display', th: 'หน้าจอครัว (KDS)', tone: 'from-amber-500 to-orange-600' },
  { to: '/queue', icon: Tv, title: 'Queue Display', th: 'หน้าจอเรียกคิว', tone: 'from-sky-500 to-indigo-600' },
  { to: '/admin', icon: LayoutDashboard, title: 'Admin Dashboard', th: 'ระบบหลังร้าน', tone: 'from-slate-700 to-slate-900' },
];

export default function Launcher() {
  return (
    <div className="min-h-full bg-[#FFF8F0] p-6 md:p-12">
      <div className="mx-auto max-w-6xl">
        <div className="mb-10 flex items-center gap-4">
          <img src="/icon.svg" alt="" className="h-16 w-16" />
          <div>
            <h1 className="text-3xl font-extrabold text-slate-900">Krua Hub Platform</h1>
            <p className="text-slate-500">เลือกโหมดการใช้งานของเครื่องนี้ · Choose what this device is used for</p>
          </div>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {APPS.map((a) => (
            <Link key={a.to} to={a.to} className={`press group flex min-h-48 flex-col justify-between rounded-3xl bg-gradient-to-br ${a.tone} p-7 text-white shadow-xl`}>
              <a.icon className="h-12 w-12 opacity-90" />
              <div>
                <div className="text-2xl font-bold">{a.title}</div>
                <div className="text-white/80">{a.th}</div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
