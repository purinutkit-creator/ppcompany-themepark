import { Suspense, lazy, useState } from 'react';
import { NavLink, Route, Routes, Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  BadgeCheck, BarChart3, Bell, Boxes, Building2, CalendarDays, ChefHat, ClipboardList, Cpu, CreditCard, Crown, DoorOpen, Gamepad2, Gift, Globe, LayoutDashboard, ListTree, Lock, LogOut,
  Map as MapIcon, MapPinned, Menu as MenuIcon, MonitorSmartphone, Palette, Percent, Printer, Receipt, ScanLine, ScrollText, Settings, Shield, ShieldAlert, SlidersHorizontal, Star, Store, Tags, Ticket,
  TicketPercent, Timer, Tv, Type, Users, UtensilsCrossed, Wallet, Warehouse,
} from 'lucide-react';
import { LangSwitcher, useT } from '../lib/lang';
import { EVENTS, tr } from '@kiosk/shared';
import { useAuth } from '../lib/auth';
import { useSocketEvent } from '../lib/socket';
import { StaffShell, useStaffRt } from '../components/StaffShell';
import { ConnectionDot, Loading, Select, toast } from '../components/ui';
import { tt } from '../lib/legacy-i18n';

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
const ParkSettings = lazy(() => import('./park/ParkSettings'));
const pk = <K extends string>(name: K) => lazy(() => import('./park/Catalog').then((m: any) => ({ default: m[name] })));
const op = <K extends string>(name: K) => lazy(() => import('./park/Ops').then((m: any) => ({ default: m[name] })));
const P = {
  TicketTypes: pk('TicketTypes'), Packages: pk('Packages'), Rides: pk('Rides'), ScanPoints: pk('ScanPoints'), Zones: pk('Zones'), Stores: pk('Stores'), Tiers: pk('Tiers'),
  MembershipProducts: pk('MembershipProducts'), Rewards: pk('Rewards'), GatesConfig: pk('GatesConfig'), LockersConfig: pk('LockersConfig'), Devices: pk('Devices'), Coupons: pk('Coupons'),
  ParkDashboard: op('ParkDashboard'), LiveMap: op('LiveMap'), BookingsAdmin: op('BookingsAdmin'), CardsAdmin: op('CardsAdmin'), VerifyAdmin: op('VerifyAdmin'), Members: op('Members'),
  Transactions: op('Transactions'), ShiftsAdmin: op('ShiftsAdmin'), Inventory: op('Inventory'), Notifications: op('Notifications'), Security: op('Security'), ParkReports: op('ParkReports'),
};

type T3 = { th: string; en: string; zh: string };
const L = (th: string, en: string, zh: string): T3 => ({ th, en, zh });
const NAV: { group: T3; items: { to: string; label: T3; icon: any; perm?: string }[] }[] = [
  { group: L('ภาพรวม', 'Overview', '概览'), items: [
    { to: '/admin', label: L('แดชบอร์ดสวนสนุก', 'Park dashboard', '乐园仪表盘'), icon: LayoutDashboard, perm: 'dashboard.view' },
    { to: '/admin/park/map', label: L('แผนที่สด', 'Live map', '实时地图'), icon: MapIcon, perm: 'dashboard.view' },
    { to: '/admin/park/transactions', label: L('ศูนย์ธุรกรรม / คืนเงิน', 'Transactions & refunds', '交易/退款'), icon: Receipt, perm: 'transactions.view' },
    { to: '/admin/park/reports', label: L('รายงานสวนสนุก', 'Park reports', '乐园报表'), icon: BarChart3, perm: 'reports.view' },
    { to: '/admin/park/notifications', label: L('การแจ้งเตือน', 'Notifications', '通知'), icon: Bell },
  ] },
  { group: L('ขาย & ลูกค้า', 'Sales & guests', '销售与客户'), items: [
    { to: '/admin/park/bookings', label: L('การจอง', 'Bookings', '预订'), icon: CalendarDays, perm: 'bookings.view' },
    { to: '/admin/park/verify', label: L('ตรวจสอบการชำระเงิน', 'Payment verification', '付款核对'), icon: BadgeCheck, perm: 'payments.verify' },
    { to: '/admin/park/members', label: L('สมาชิก', 'Members', '会员'), icon: Users, perm: 'members.view' },
    { to: '/admin/park/cards', label: L('บัตร / ริสแบนด์ / กระเป๋าเงิน', 'Cards, wristbands & wallets', '卡/腕带/钱包'), icon: CreditCard, perm: 'cards.view' },
    { to: '/admin/park/shifts', label: L('กะการทำงาน', 'Shifts', '班次'), icon: Wallet, perm: 'shifts.manage' },
  ] },
  { group: L('สินค้า & ราคา', 'Catalogue & pricing', '商品与定价'), items: [
    { to: '/admin/park/packages', label: L('แพ็กเกจบัตร', 'Ticket packages', '门票套餐'), icon: Ticket, perm: 'tickets.manage' },
    { to: '/admin/park/ticket-types', label: L('ประเภทตั๋ว', 'Ticket types', '票种'), icon: Tags, perm: 'tickets.manage' },
    { to: '/admin/park/memberships', label: L('แพ็กเกจสมาชิก', 'Membership products', '会员产品'), icon: Crown, perm: 'membership.manage' },
    { to: '/admin/park/tiers', label: L('ระดับสมาชิก', 'Member tiers', '会员等级'), icon: Star, perm: 'membership.manage' },
    { to: '/admin/park/rewards', label: L('ของรางวัล', 'Rewards', '积分兑换'), icon: Gift, perm: 'rewards.manage' },
    { to: '/admin/promotions', label: L('โปรโมชั่น', 'Promotions', '促销'), icon: Percent, perm: 'promotions.manage' },
    { to: '/admin/park/coupons', label: L('คูปอง', 'Coupons', '优惠券'), icon: TicketPercent, perm: 'promotions.manage' },
  ] },
  { group: L('สวนสนุก', 'Park operations', '乐园运营'), items: [
    { to: '/admin/park/rides', label: L('เครื่องเล่น', 'Rides', '游乐设施'), icon: Gamepad2, perm: 'rides.manage' },
    { to: '/admin/park/scan-points', label: L('จุดสแกนเครื่องเล่น', 'Ride scan points', '设施扫描点'), icon: ScanLine, perm: 'rides.manage' },
    { to: '/admin/park/gates', label: L('ประตูทางเข้า', 'Gates', '闸门'), icon: DoorOpen, perm: 'gates.manage' },
    { to: '/admin/park/zones', label: L('โซน', 'Zones', '区域'), icon: MapPinned, perm: 'zones.manage' },
    { to: '/admin/park/lockers', label: L('ล็อกเกอร์', 'Lockers', '储物柜'), icon: Lock, perm: 'lockers.manage' },
    { to: '/admin/park/devices', label: L('อุปกรณ์', 'Devices', '设备'), icon: Cpu, perm: 'devices.manage' },
    { to: '/admin/park/security', label: L('ความปลอดภัย / บันทึกเข้าออก', 'Security & entry log', '安全/出入记录'), icon: ShieldAlert, perm: 'security.view' },
    { to: '/admin/park/settings', label: L('ตั้งค่าสวนสนุก', 'Park settings', '乐园设置'), icon: SlidersHorizontal, perm: 'settings.manage' },
  ] },
  { group: L('ร้านค้า & อาหาร', 'Stores & food', '门店与餐饮'), items: [
    { to: '/admin/park/stores', label: L('ร้านค้า / คลัง', 'Stores & warehouses', '门店/仓库'), icon: Store, perm: 'inventory.manage' },
    { to: '/admin/park/inventory', label: L('สต็อกตามร้าน', 'Inventory', '库存'), icon: Warehouse, perm: 'inventory.view' },
    { to: '/admin/restaurant', label: L('แดชบอร์ดร้านอาหาร', 'Restaurant dashboard', '餐饮仪表盘'), icon: UtensilsCrossed, perm: 'dashboard.view' },
    { to: '/admin/orders', label: L('ออเดอร์อาหาร', 'Food orders', '餐饮订单'), icon: ClipboardList, perm: 'orders.view' },
    { to: '/admin/payments', label: L('การชำระเงิน (อาหาร)', 'Payments (food)', '支付（餐饮）'), icon: CreditCard, perm: 'payments.view' },
    { to: '/admin/products', label: L('สินค้า / เมนู', 'Products & menu', '商品/菜单'), icon: Boxes, perm: 'products.manage' },
    { to: '/admin/categories', label: L('หมวดหมู่', 'Categories', '分类'), icon: ListTree, perm: 'categories.manage' },
    { to: '/admin/modifiers', label: L('ตัวเลือกเสริม', 'Modifiers', '加料选项'), icon: SlidersHorizontal, perm: 'modifiers.manage' },
    { to: '/admin/schedules', label: L('ช่วงเวลาขาย', 'Menu schedules', '售卖时段'), icon: Timer, perm: 'products.manage' },
    { to: '/admin/stock', label: L('สต็อกอาหาร', 'Food stock', '餐饮库存'), icon: Boxes, perm: 'stock.view' },
    { to: '/admin/reports', label: L('รายงานร้านอาหาร', 'Restaurant reports', '餐饮报表'), icon: BarChart3, perm: 'reports.view' },
    { to: '/admin/kiosks', label: L('เครื่องคีออส', 'Kiosks', '自助机'), icon: MonitorSmartphone, perm: 'kiosks.manage' },
    { to: '/admin/kitchen', label: L('ครัว', 'Kitchen stations', '厨房工位'), icon: ChefHat, perm: 'kitchen.stations' },
    { to: '/admin/queue', label: L('จอเรียกคิว', 'Queue display', '叫号屏'), icon: Tv, perm: 'queue.manage' },
  ] },
  { group: L('ระบบ', 'System', '系统'), items: [
    { to: '/admin/printers', label: L('เครื่องพิมพ์', 'Printers', '打印机'), icon: Printer, perm: 'printers.manage' },
    { to: '/admin/branches', label: L('สาขา', 'Branches', '分店'), icon: Building2, perm: 'branches.manage' },
    { to: '/admin/staff', label: L('พนักงาน', 'Staff', '员工'), icon: Users, perm: 'staff.manage' },
    { to: '/admin/roles', label: L('สิทธิ์การใช้งาน', 'Roles & permissions', '角色与权限'), icon: Shield, perm: 'roles.manage' },
    { to: '/admin/theme', label: L('ธีม', 'Theme', '主题'), icon: Palette, perm: 'theme.manage' },
    { to: '/admin/fonts', label: L('ฟอนต์', 'Fonts', '字体'), icon: Type, perm: 'fonts.manage' },
    { to: '/admin/languages', label: L('ภาษา / ข้อความ', 'Languages & texts', '语言/文案'), icon: Globe, perm: 'languages.manage' },
    { to: '/admin/settings', label: L('ตั้งค่าระบบ', 'System settings', '系统设置'), icon: Settings, perm: 'settings.manage' },
    { to: '/admin/audit', label: L('บันทึกกิจกรรม', 'Audit logs', '审计日志'), icon: ScrollText, perm: 'audit.view' },
  ] },
];

export default function AdminApp() {
  return (
    <StaffShell perms={['dashboard.view', 'products.manage', 'reports.view', 'settings.manage', 'orders.view', 'transactions.view', 'tickets.manage', 'members.view']} surface="admin">
      <AdminLayout />
    </StaffShell>
  );
}

function AdminLayout() {
  const t = useT();
  const { user, logout, can, branches, branchId, setBranch } = useAuth();
  const { socket, connected, client } = useStaffRt();
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
            <div className="font-bold">{t.tr(client?.settings?.park?.name) || 'Park'}</div>
            <div className="text-xs text-slate-500">{t.x(L('ระบบหลังบ้าน', 'Back office', '管理后台'))}</div>
          </div>
        </Link>
        <nav className="p-3">
          {NAV.map((g) => {
            const items = g.items.filter((i) => !i.perm || can(i.perm));
            if (!items.length) return null;
            return (
              <div key={g.group.en} className="mb-4">
                <div className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{t.x(g.group)}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.to === '/admin'} onClick={() => setOpen(false)} className={({ isActive }) => clsx('flex items-center gap-3 rounded-xl px-3 py-2 text-sm', isActive ? 'bg-primary font-semibold text-white' : 'text-slate-700 hover:bg-slate-100')}>
                    <i.icon className="h-4 w-4" />
                    <span className="flex-1">{t.x(i.label)}</span>
                  </NavLink>
                ))}
              </div>
            );
          })}
          <div className="mt-6 border-t px-3 pt-4 text-xs text-slate-500">
            {[['/', L('เลือกแอปทั้งหมด', 'All apps', '全部应用')], ['/counter', L('เคาน์เตอร์ขายบัตร', 'Box office', '售票处')], ['/gates', L('ควบคุมประตู', 'Gate console', '闸门操作台')], ['/rides', L('ควบคุมเครื่องเล่น', 'Ride operator', '设施操作')], ['/pos', L('POS', 'POS', 'POS')], ['/park', L('เว็บไซต์', 'Website', '官网')]].map(([href, lab]) => (
              <a key={href as string} href={href as string} className="block py-1 hover:text-slate-900">→ {t.x(lab as T3)}</a>
            ))}
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
                <option key={b.id} value={b.id}>{b.code} — {tr(b.name, t.lang)}</option>
              ))}
            </Select>
          ) : (
            <span className="text-sm font-medium text-slate-600">{branches.find((b) => b.id === branchId)?.code}</span>
          )}
          <div className="ml-auto flex items-center gap-3">
            <LangSwitcher compact />
            <ConnectionDot connected={connected} />
            <div className="text-right text-sm leading-tight">
              <div className="font-medium">{user?.name}</div>
              <div className="text-xs text-slate-500">{user?.role}</div>
            </div>
            <button onClick={() => logout()} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" title={tt('Logout')}>
              <LogOut className="h-5 w-5" />
            </button>
          </div>
        </header>
        <main className="scroll-thin min-h-0 flex-1 overflow-y-auto p-5 lg:p-7">
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route index element={<P.ParkDashboard />} />
              <Route path="restaurant" element={<Dashboard />} />
              <Route path="park/map" element={<P.LiveMap />} />
              <Route path="park/transactions" element={<P.Transactions />} />
              <Route path="park/reports" element={<P.ParkReports />} />
              <Route path="park/notifications" element={<P.Notifications />} />
              <Route path="park/bookings" element={<P.BookingsAdmin />} />
              <Route path="park/verify" element={<P.VerifyAdmin />} />
              <Route path="park/members" element={<P.Members />} />
              <Route path="park/cards" element={<P.CardsAdmin />} />
              <Route path="park/shifts" element={<P.ShiftsAdmin />} />
              <Route path="park/packages" element={<P.Packages />} />
              <Route path="park/ticket-types" element={<P.TicketTypes />} />
              <Route path="park/memberships" element={<P.MembershipProducts />} />
              <Route path="park/tiers" element={<P.Tiers />} />
              <Route path="park/rewards" element={<P.Rewards />} />
              <Route path="park/coupons" element={<P.Coupons />} />
              <Route path="park/rides" element={<P.Rides />} />
              <Route path="park/scan-points" element={<P.ScanPoints />} />
              <Route path="park/gates" element={<P.GatesConfig />} />
              <Route path="park/zones" element={<P.Zones />} />
              <Route path="park/lockers" element={<P.LockersConfig />} />
              <Route path="park/devices" element={<P.Devices />} />
              <Route path="park/security" element={<P.Security />} />
              <Route path="park/settings" element={<ParkSettings />} />
              <Route path="park/stores" element={<P.Stores />} />
              <Route path="park/inventory" element={<P.Inventory />} />
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
