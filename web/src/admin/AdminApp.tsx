import { Suspense, lazy, useState } from 'react';
import { NavLink, Route, Routes, Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  BarChart3, Boxes, ChefHat, ClipboardList, CreditCard, FileText, Globe, LayoutDashboard, ListTree, LogOut, Menu as MenuIcon, MonitorSmartphone, Palette, Printer,
  ScrollText, Settings, Shield, SlidersHorizontal, Store, Tags, Timer, Tv, Type, Users, UtensilsCrossed,
} from 'lucide-react';
import { EVENTS, tr } from '@kiosk/shared';
import { useAuth } from '../lib/auth';
import { useSocketEvent } from '../lib/socket';
import { StaffShell, useStaffRt } from '../components/StaffShell';
import { ConnectionDot, Loading, Select, toast } from '../components/ui';

const Dashboard = lazy(() => import('./Dashboard'));
const Orders = lazy(() => import('./Orders'));
const Products = lazy(() => import('./Products'));
const Categories = lazy(() => import('./Categories'));
const Modifiers = lazy(() => import('./Modifiers'));
const Promotions = lazy(() => import('./Promotions'));
const Schedules = lazy(() => import('./Schedules'));
const Stock = lazy(() => import('./Stock'));
const Payments = lazy(() => import('./Payments'));
const Kiosks = lazy(() => import('./Kiosks'));
const Kitchen = lazy(() => import('./Kitchen'));
const QueueSettings = lazy(() => import('./QueueSettings'));
const Printers = lazy(() => import('./Printers'));
const Fonts = lazy(() => import('./Fonts'));
const Languages = lazy(() => import('./Languages'));
const Theme = lazy(() => import('./Theme'));
const Staff = lazy(() => import('./Staff'));
const Roles = lazy(() => import('./Roles'));
const Reports = lazy(() => import('./Reports'));
const Audit = lazy(() => import('./Audit'));
const SettingsPage = lazy(() => import('./Settings'));
const Branches = lazy(() => import('./Branches'));

const NAV: { group: string; items: { to: string; label: string; th: string; icon: any; perm?: string }[] }[] = [
  { group: 'Overview', items: [
    { to: '/admin', label: 'Dashboard', th: 'แดชบอร์ด', icon: LayoutDashboard, perm: 'dashboard.view' },
    { to: '/admin/orders', label: 'Orders', th: 'ออเดอร์', icon: ClipboardList, perm: 'orders.view' },
    { to: '/admin/payments', label: 'Payments', th: 'การชำระเงิน', icon: CreditCard, perm: 'payments.view' },
    { to: '/admin/reports', label: 'Reports', th: 'รายงาน', icon: BarChart3, perm: 'reports.view' },
  ] },
  { group: 'Menu', items: [
    { to: '/admin/products', label: 'Products', th: 'สินค้า', icon: UtensilsCrossed, perm: 'products.manage' },
    { to: '/admin/categories', label: 'Categories', th: 'หมวดหมู่', icon: ListTree, perm: 'categories.manage' },
    { to: '/admin/modifiers', label: 'Modifiers', th: 'ตัวเลือกเสริม', icon: SlidersHorizontal, perm: 'modifiers.manage' },
    { to: '/admin/promotions', label: 'Promotions', th: 'โปรโมชั่น', icon: Tags, perm: 'promotions.manage' },
    { to: '/admin/schedules', label: 'Menu schedules', th: 'ช่วงเวลาขาย', icon: Timer, perm: 'products.manage' },
    { to: '/admin/stock', label: 'Stock', th: 'สต็อก', icon: Boxes, perm: 'stock.view' },
  ] },
  { group: 'Operations', items: [
    { to: '/admin/kiosks', label: 'Kiosks', th: 'เครื่องคีออส', icon: MonitorSmartphone, perm: 'kiosks.manage' },
    { to: '/admin/kitchen', label: 'Kitchen stations', th: 'ครัว', icon: ChefHat, perm: 'kitchen.stations' },
    { to: '/admin/queue', label: 'Queue display', th: 'จอเรียกคิว', icon: Tv, perm: 'queue.manage' },
    { to: '/admin/printers', label: 'Printers', th: 'เครื่องพิมพ์', icon: Printer, perm: 'printers.manage' },
    { to: '/admin/branches', label: 'Branches', th: 'สาขา', icon: Store, perm: 'branches.manage' },
  ] },
  { group: 'People', items: [
    { to: '/admin/staff', label: 'Staff', th: 'พนักงาน', icon: Users, perm: 'staff.manage' },
    { to: '/admin/roles', label: 'Roles & permissions', th: 'สิทธิ์', icon: Shield, perm: 'roles.manage' },
  ] },
  { group: 'Appearance', items: [
    { to: '/admin/theme', label: 'Theme', th: 'ธีม', icon: Palette, perm: 'theme.manage' },
    { to: '/admin/fonts', label: 'Fonts', th: 'ฟอนต์', icon: Type, perm: 'fonts.manage' },
    { to: '/admin/languages', label: 'Languages', th: 'ภาษา', icon: Globe, perm: 'languages.manage' },
  ] },
  { group: 'System', items: [
    { to: '/admin/settings', label: 'Settings', th: 'ตั้งค่าระบบ', icon: Settings, perm: 'settings.manage' },
    { to: '/admin/audit', label: 'Audit logs', th: 'บันทึกกิจกรรม', icon: ScrollText, perm: 'audit.view' },
  ] },
];

export default function AdminApp() {
  return (
    <StaffShell perms={['dashboard.view', 'products.manage', 'reports.view', 'settings.manage', 'orders.view']} surface="admin">
      <AdminLayout />
    </StaffShell>
  );
}

function AdminLayout() {
  const { user, logout, can, branches, branchId, setBranch } = useAuth();
  const { socket, connected } = useStaffRt();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  useSocketEvent(socket, [EVENTS.ORDER_CREATED, EVENTS.ORDER_UPDATED, EVENTS.ORDER_CONFIRMED, EVENTS.ORDER_READY, EVENTS.ORDER_COMPLETED, EVENTS.ORDER_CANCELLED, EVENTS.PAYMENT_APPROVED], () => {
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
    void qc.invalidateQueries({ queryKey: ['order'] });
  });
  useSocketEvent(socket, [EVENTS.KIOSK_STATUS, EVENTS.PRINTER_STATUS, EVENTS.PRINT_JOB_CREATED, EVENTS.PRINT_JOB_UPDATED], () => {
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    void qc.invalidateQueries({ queryKey: ['printers'] });
    void qc.invalidateQueries({ queryKey: ['print-jobs'] });
    void qc.invalidateQueries({ queryKey: ['kiosks'] });
  });
  useSocketEvent(socket, EVENTS.STOCK_UPDATED, () => void qc.invalidateQueries({ queryKey: ['stock'] }));
  useSocketEvent(socket, EVENTS.PRINTER_ERROR, (d) => toast.error(d.message, d.orderNumber ? `Order #${d.orderNumber}` : d.error));

  return (
    <div className="flex h-full bg-slate-50">
      <aside className={clsx('scroll-thin fixed inset-y-0 left-0 z-40 w-64 shrink-0 overflow-y-auto border-r bg-white transition-transform lg:static lg:translate-x-0', open ? 'translate-x-0' : '-translate-x-full')}>
        <Link to="/admin" className="flex items-center gap-3 border-b px-5 py-4">
          <img src="/icon.svg" className="h-9 w-9" alt="" />
          <div>
            <div className="font-bold">Krua Hub</div>
            <div className="text-xs text-slate-500">Back office</div>
          </div>
        </Link>
        <nav className="p-3">
          {NAV.map((g) => {
            const items = g.items.filter((i) => !i.perm || can(i.perm));
            if (!items.length) return null;
            return (
              <div key={g.group} className="mb-4">
                <div className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{g.group}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.to === '/admin'} onClick={() => setOpen(false)} className={({ isActive }) => clsx('flex items-center gap-3 rounded-xl px-3 py-2 text-sm', isActive ? 'bg-primary font-semibold text-white' : 'text-slate-700 hover:bg-slate-100')}>
                    <i.icon className="h-4 w-4" />
                    <span className="flex-1">{i.label}</span>
                    <span className="text-[10px] opacity-60">{i.th}</span>
                  </NavLink>
                ))}
              </div>
            );
          })}
          <div className="mt-6 border-t px-3 pt-4 text-xs text-slate-500">
            <a href="/kiosk" className="block py-1 hover:text-slate-900">→ Open kiosk</a>
            <a href="/cashier" className="block py-1 hover:text-slate-900">→ Open cashier</a>
            <a href="/kds" className="block py-1 hover:text-slate-900">→ Open KDS</a>
          </div>
        </nav>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-white px-4">
          <button className="lg:hidden" onClick={() => setOpen(true)}>
            <MenuIcon className="h-6 w-6" />
          </button>
          {!user?.branchId && branches.length > 0 ? (
            <Select value={branchId ?? ''} onChange={(e) => setBranch(e.target.value)} className="w-56">
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.code} — {tr(b.name, 'th')}</option>
              ))}
            </Select>
          ) : (
            <span className="text-sm font-medium text-slate-600">{branches.find((b) => b.id === branchId)?.code}</span>
          )}
          <div className="ml-auto flex items-center gap-3">
            <ConnectionDot connected={connected} />
            <div className="text-right text-sm leading-tight">
              <div className="font-medium">{user?.name}</div>
              <div className="text-xs text-slate-500">{user?.role}</div>
            </div>
            <button onClick={() => logout()} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" title="Logout">
              <LogOut className="h-5 w-5" />
            </button>
          </div>
        </header>
        <main className="scroll-thin min-h-0 flex-1 overflow-y-auto p-5 lg:p-7">
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route index element={<Dashboard />} />
              <Route path="orders" element={<Orders />} />
              <Route path="orders/:id" element={<Orders />} />
              <Route path="payments" element={<Payments />} />
              <Route path="reports" element={<Reports />} />
              <Route path="products" element={<Products />} />
              <Route path="categories" element={<Categories />} />
              <Route path="modifiers" element={<Modifiers />} />
              <Route path="promotions" element={<Promotions />} />
              <Route path="schedules" element={<Schedules />} />
              <Route path="stock" element={<Stock />} />
              <Route path="kiosks" element={<Kiosks />} />
              <Route path="kitchen" element={<Kitchen />} />
              <Route path="queue" element={<QueueSettings />} />
              <Route path="printers" element={<Printers />} />
              <Route path="branches" element={<Branches />} />
              <Route path="staff" element={<Staff />} />
              <Route path="roles" element={<Roles />} />
              <Route path="theme" element={<Theme />} />
              <Route path="fonts" element={<Fonts />} />
              <Route path="languages" element={<Languages />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="audit" element={<Audit />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  );
}
