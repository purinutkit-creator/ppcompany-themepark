import { useEffect, useMemo, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { create } from 'zustand';
import {
  Bell, CalendarDays, ChevronRight, Crown, Gift, History, Home, IdCard, KeyRound, Lock, LogOut, Menu as MenuIcon, ShieldCheck, ShoppingBag, Ticket, Timer, User, UtensilsCrossed, Wallet,
} from 'lucide-react';
import { EVENTS, tr } from '@kiosk/shared';
import { memberApi, newKey, parkPublicApi, storage } from '../lib/api';
import { dateTime, money } from '../lib/format';
import { defineStrings, useT } from '../lib/lang';
import { chime } from '../lib/sound';
import { useRealtime, useSocketEvent } from '../lib/socket';
import { Button, Empty, Field, Input, Loading, Modal, Select, toast } from '../components/ui';
import { CustomerProvider, SiteHeader, useBoot } from '../park/CustomerShell';
import { OnlinePay } from '../park/OnlinePay';
import { Barcode, QrCode } from '../park/scan';
import { PStatus, SafeImg, Stepper, TierBadge } from '../park/ui';
import { ModifierPicker } from '../park/ModifierPicker';

const M = defineStrings('member', {
  welcome: { th: 'สมาชิก', en: 'Members', zh: '会员' },
  signIn: { th: 'เข้าสู่ระบบสมาชิก', en: 'Member sign in', zh: '会员登录' },
  phoneOrEmail: { th: 'เบอร์โทรหรืออีเมล', en: 'Phone or email', zh: '手机号或邮箱' },
  password: { th: 'รหัสผ่าน', en: 'Password', zh: '密码' },
  register: { th: 'สมัครสมาชิก', en: 'Create account', zh: '注册会员' },
  haveAccount: { th: 'มีบัญชีแล้ว? เข้าสู่ระบบ', en: 'Already a member? Sign in', zh: '已有账户？登录' },
  noAccount: { th: 'ยังไม่เป็นสมาชิก? สมัครฟรี', en: 'Not a member yet? Join free', zh: '还不是会员？免费注册' },
  otpLogin: { th: 'เข้าสู่ระบบด้วย OTP', en: 'Sign in with OTP', zh: '验证码登录' },
  forgot: { th: 'ลืมรหัสผ่าน', en: 'Forgot password', zh: '忘记密码' },
  sendOtp: { th: 'ส่งรหัส OTP', en: 'Send OTP', zh: '发送验证码' },
  otp: { th: 'รหัส OTP', en: 'OTP code', zh: '验证码' },
  otpSent: { th: 'ส่งรหัสแล้ว', en: 'Code sent', zh: '验证码已发送' },
  newPassword: { th: 'รหัสผ่านใหม่', en: 'New password', zh: '新密码' },
  currentPassword: { th: 'รหัสผ่านปัจจุบัน', en: 'Current password', zh: '当前密码' },
  firstName: { th: 'ชื่อ', en: 'First name', zh: '名' },
  lastName: { th: 'นามสกุล', en: 'Last name', zh: '姓' },
  birthday: { th: 'วันเกิด', en: 'Birthday', zh: '生日' },
  gender: { th: 'เพศ', en: 'Gender', zh: '性别' },
  address: { th: 'ที่อยู่', en: 'Address', zh: '地址' },
  emergency: { th: 'ผู้ติดต่อฉุกเฉิน', en: 'Emergency contact', zh: '紧急联系人' },
  suspicious: { th: 'พบการเข้าสู่ระบบจากอุปกรณ์ใหม่ — หากไม่ใช่คุณ กรุณาออกจากระบบทุกอุปกรณ์', en: 'New device sign-in detected — if this was not you, log out all devices', zh: '检测到新设备登录 — 如非本人操作，请退出所有设备' },
  tabCard: { th: 'บัตรสมาชิก', en: 'Card', zh: '会员卡' },
  tabTickets: { th: 'ตั๋ว', en: 'Tickets', zh: '门票' },
  tabWallet: { th: 'เติมเงิน', en: 'Wallet', zh: '钱包' },
  tabRewards: { th: 'แลกของรางวัล', en: 'Rewards', zh: '兑换' },
  tabQueue: { th: 'คิว', en: 'Queue', zh: '排队' },
  tabMore: { th: 'เพิ่มเติม', en: 'More', zh: '更多' },
  showAtGate: { th: 'ใช้ QR นี้เข้าสวน เล่นเครื่องเล่น ชำระเงิน และรับคะแนน', en: 'Use this QR for entry, rides, payments and points', zh: '此二维码可用于入园、游乐、付款和积分' },
  qrRefresh: { th: 'QR เปลี่ยนทุก {s} วินาที (ป้องกันการแคปหน้าจอ)', en: 'QR refreshes every {s}s (screenshots won’t work)', zh: '二维码每{s}秒刷新（截图无效）' },
  validUntil: { th: 'หมดอายุ {d}', en: 'Valid until {d}', zh: '有效期至 {d}' },
  daysLeft: { th: 'เหลือ {n} วัน', en: '{n} days left', zh: '剩余{n}天' },
  noMembership: { th: 'ยังไม่มีแพ็กเกจสมาชิก', en: 'No membership package yet', zh: '尚未购买会员' },
  buyMembership: { th: 'สมัคร / ต่ออายุ / อัปเกรด', en: 'Join / renew / upgrade', zh: '购买 / 续费 / 升级' },
  benefits: { th: 'สิทธิประโยชน์', en: 'Benefits', zh: '会员权益' },
  topup: { th: 'เติมเงินเข้าบัตร', en: 'Top up', zh: '充值' },
  topupAmount: { th: 'จำนวนเงินที่ต้องการเติม', en: 'Top-up amount', zh: '充值金额' },
  history: { th: 'ประวัติ', en: 'History', zh: '记录' },
  pointsBalance: { th: 'คะแนนสะสม', en: 'Points balance', zh: '积分余额' },
  redeem: { th: 'แลก', en: 'Redeem', zh: '兑换' },
  pointsRequired: { th: '{n} คะแนน', en: '{n} pts', zh: '{n}积分' },
  notEnough: { th: 'คะแนนไม่พอ', en: 'Not enough points', zh: '积分不足' },
  redeemed: { th: 'แลกสำเร็จ', en: 'Redeemed', zh: '兑换成功' },
  myRedemptions: { th: 'รายการที่แลกแล้ว', en: 'My redemptions', zh: '我的兑换' },
  joinQueue: { th: 'จองคิว', en: 'Join queue', zh: '排队' },
  myQueues: { th: 'คิวของฉัน', en: 'My queues', zh: '我的排队' },
  ahead: { th: 'รออีก {n} คิว', en: '{n} ahead', zh: '前面{n}位' },
  estWait: { th: 'ประมาณ {n} นาที', en: '~{n} min', zh: '约{n}分钟' },
  calledNow: { th: 'ถึงคิวแล้ว! กรุณาไปที่เครื่องเล่น', en: "It's your turn! Please go to the ride", zh: '轮到您了！请前往游乐设施' },
  leave: { th: 'ยกเลิกคิว', en: 'Leave', zh: '取消排队' },
  party: { th: 'จำนวนคน', en: 'Party size', zh: '人数' },
  bookings: { th: 'การจอง', en: 'Bookings', zh: '预订' },
  membership: { th: 'แพ็กเกจสมาชิก', en: 'Membership', zh: '会员套餐' },
  coupons: { th: 'คูปองของฉัน', en: 'My coupons', zh: '我的优惠券' },
  notifications: { th: 'การแจ้งเตือน', en: 'Notifications', zh: '通知' },
  security: { th: 'ความปลอดภัย', en: 'Security', zh: '安全' },
  profile: { th: 'ข้อมูลส่วนตัว', en: 'Profile', zh: '个人资料' },
  transactions: { th: 'ประวัติการใช้จ่าย', en: 'Transactions', zh: '消费记录' },
  rideHistory: { th: 'ประวัติการเล่น', en: 'Ride history', zh: '游玩记录' },
  food: { th: 'สั่งอาหาร', en: 'Order food', zh: '点餐' },
  foodOrders: { th: 'ออเดอร์อาหาร', en: 'Food orders', zh: '餐饮订单' },
  placeOrder: { th: 'สั่งและจ่ายด้วยเงินในบัตร', en: 'Order & pay with wallet', zh: '下单并用钱包支付' },
  orderPlaced: { th: 'สั่งอาหารแล้ว หมายเลข {n}', en: 'Order placed — number {n}', zh: '已下单 — 号码 {n}' },
  sessions: { th: 'อุปกรณ์ที่เข้าสู่ระบบ', en: 'Signed-in devices', zh: '已登录设备' },
  thisDevice: { th: 'อุปกรณ์นี้', en: 'This device', zh: '本设备' },
  logoutAll: { th: 'ออกจากระบบทุกอุปกรณ์', en: 'Log out all devices', zh: '退出所有设备' },
  changePassword: { th: 'เปลี่ยนรหัสผ่าน', en: 'Change password', zh: '修改密码' },
  rides: { th: 'สิทธิ์เครื่องเล่น', en: 'Ride passes', zh: '游乐权益' },
  usesLeft: { th: 'เหลือ {n} ครั้ง', en: '{n} left', zh: '剩余{n}次' },
  unlimited: { th: 'ไม่จำกัด', en: 'Unlimited', zh: '无限次' },
  payFor: { th: 'ชำระเงิน', en: 'Payment', zh: '付款' },
  paidDone: { th: 'ชำระเงินสำเร็จ', en: 'Payment successful', zh: '支付成功' },
  renew: { th: 'ต่ออายุ', en: 'Renew', zh: '续费' },
  upgrade: { th: 'อัปเกรด', en: 'Upgrade', zh: '升级' },
  join: { th: 'สมัคร', en: 'Join', zh: '购买' },
  current: { th: 'แพ็กเกจปัจจุบัน', en: 'Current', zh: '当前' },
  markRead: { th: 'อ่านทั้งหมด', en: 'Mark all read', zh: '全部已读' },
  myCards: { th: 'บัตร / ริสแบนด์ของฉัน', en: 'My cards & wristbands', zh: '我的卡/腕带' },
  visits: { th: 'จำนวนครั้งที่มา', en: 'Visits', zh: '到访次数' },
  spend: { th: 'ยอดใช้จ่ายสะสม', en: 'Total spend', zh: '累计消费' },
  passwordChanged: { th: 'เปลี่ยนรหัสผ่านแล้ว กรุณาเข้าสู่ระบบใหม่', en: 'Password changed — please sign in again', zh: '密码已修改，请重新登录' },
  mustVerifyPhone: { th: 'ยืนยันเบอร์โทรด้วย OTP', en: 'Verify your phone with OTP', zh: '用验证码验证手机号' },
  devCode: { th: 'รหัสทดสอบ', en: 'Test code', zh: '测试码' },
});

const useMember = create<{ token: string | null; set: (t: string | null) => void }>((set) => ({
  token: storage.get('member_token'),
  set: (token) => {
    storage.set('member_token', token);
    set({ token });
  },
}));

const branchCodeOf = (b: ReturnType<typeof useBoot>) => (storage.get('park_branch') || b.branches[0]?.code || '').toUpperCase();

export default function MemberPortal() {
  return (
    <CustomerProvider surface="web">
      <div className="min-h-full bg-[var(--brand-bg)]">
        <SiteHeader />
        <Gate />
      </div>
    </CustomerProvider>
  );
}

function Gate() {
  const token = useMember((s) => s.token);
  const set = useMember((s) => s.set);
  useEffect(() => {
    const h = () => set(null);
    window.addEventListener('member-unauthorized', h);
    return () => window.removeEventListener('member-unauthorized', h);
  }, [set]);
  return token ? <Portal /> : <Auth />;
}

// ------------------------------------------------------------------ sign in / register
function Auth() {
  const t = useT(M);
  const b = useBoot();
  const setToken = useMember((s) => s.set);
  const [mode, setMode] = useState<'login' | 'register' | 'otp' | 'reset'>('login');
  const [f, setF] = useState<any>({ login: '', password: '', phone: '', firstName: '', lastName: '', email: '', birthday: '', code: '', newPassword: '' });
  const [busy, setBusy] = useState(false);
  const [dev, setDev] = useState<string | null>(null);
  const set = (k: string, v: string) => setF((x: any) => ({ ...x, [k]: v }));
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(t.err(e));
    } finally {
      setBusy(false);
    }
  };
  const sendOtp = (target: string, purpose: string) => run(async () => {
    const r = await memberApi('/otp', { body: { target, purpose } });
    toast.success(t('otpSent'));
    setDev(r.devCode ?? null);
  });
  const done = (r: any) => {
    if (r.suspicious) toast.info(t('suspicious'));
    setToken(r.token);
  };
  const otpRequired = b.settings.member.otp.enabled && b.settings.member.otp.requireOnRegister;
  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <div className="rounded-3xl bg-white p-6 shadow-sm">
        <div className="mb-5 text-center">
          <Crown className="mx-auto mb-2 h-10 w-10 text-primary" />
          <h1 className="text-2xl font-bold">{mode === 'register' ? t('register') : mode === 'reset' ? t('forgot') : t('signIn')}</h1>
        </div>
        {mode === 'login' && (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => done(await memberApi('/login', { body: { login: f.login, password: f.password } }))); }}>
            <Field label={t('phoneOrEmail')}><Input value={f.login} onChange={(e) => set('login', e.target.value)} autoComplete="username" /></Field>
            <Field label={t('password')}><Input type="password" value={f.password} onChange={(e) => set('password', e.target.value)} autoComplete="current-password" /></Field>
            <Button type="submit" size="lg" className="w-full" loading={busy}>{t('login')}</Button>
          </form>
        )}
        {mode === 'otp' && (
          <div className="space-y-3">
            <Field label={t('phoneOrEmail')}><div className="flex gap-2"><Input value={f.login} onChange={(e) => set('login', e.target.value)} /><Button variant="outline" onClick={() => sendOtp(f.login, 'LOGIN')} disabled={!f.login}>{t('sendOtp')}</Button></div></Field>
            <Field label={t('otp')}><Input value={f.code} onChange={(e) => set('code', e.target.value)} inputMode="numeric" /></Field>
            {dev && <div className="text-xs text-slate-500">{t('devCode')}: <b>{dev}</b></div>}
            <Button size="lg" className="w-full" loading={busy} onClick={() => run(async () => done(await memberApi('/login/otp', { body: { login: f.login, code: f.code } })))}>{t('login')}</Button>
          </div>
        )}
        {mode === 'reset' && (
          <div className="space-y-3">
            <Field label={t('phoneOrEmail')}><div className="flex gap-2"><Input value={f.login} onChange={(e) => set('login', e.target.value)} /><Button variant="outline" onClick={() => sendOtp(f.login, 'RESET_PASSWORD')} disabled={!f.login}>{t('sendOtp')}</Button></div></Field>
            <Field label={t('otp')}><Input value={f.code} onChange={(e) => set('code', e.target.value)} inputMode="numeric" /></Field>
            {dev && <div className="text-xs text-slate-500">{t('devCode')}: <b>{dev}</b></div>}
            <Field label={t('newPassword')}><Input type="password" value={f.newPassword} onChange={(e) => set('newPassword', e.target.value)} autoComplete="new-password" /></Field>
            <Button size="lg" className="w-full" loading={busy} onClick={() => run(async () => { await memberApi('/password/reset', { body: { login: f.login, code: f.code, newPassword: f.newPassword } }); toast.success(t('saved')); setMode('login'); })}>{t('save')}</Button>
          </div>
        )}
        {mode === 'register' && (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => done(await memberApi('/register', { body: { phone: f.phone, firstName: f.firstName, lastName: f.lastName, email: f.email || null, password: f.password, birthday: f.birthday || null, language: t.lang, otp: f.code || null, branchCode: branchCodeOf(b) } }))); }}>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('firstName')}><Input value={f.firstName} onChange={(e) => set('firstName', e.target.value)} autoComplete="given-name" /></Field>
              <Field label={t('lastName')}><Input value={f.lastName} onChange={(e) => set('lastName', e.target.value)} autoComplete="family-name" /></Field>
            </div>
            <Field label={t('phone')}><div className="flex gap-2"><Input value={f.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" autoComplete="tel" />{otpRequired && <Button variant="outline" type="button" onClick={() => sendOtp(f.phone, 'REGISTER')} disabled={!f.phone}>{t('sendOtp')}</Button>}</div></Field>
            {otpRequired && <Field label={t('otp')} hint={dev ? `${t('devCode')}: ${dev}` : t('mustVerifyPhone')}><Input value={f.code} onChange={(e) => set('code', e.target.value)} inputMode="numeric" /></Field>}
            <Field label={t('email')}><Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} autoComplete="email" /></Field>
            <Field label={t('birthday')}><Input type="date" value={f.birthday} onChange={(e) => set('birthday', e.target.value)} /></Field>
            <Field label={t('password')} hint={`≥ ${b.settings.member.passwordMinLength}`}><Input type="password" value={f.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" /></Field>
            <Button type="submit" size="lg" className="w-full" loading={busy}>{t('register')}</Button>
          </form>
        )}
        <div className="mt-5 space-y-1 text-center text-sm">
          {mode !== 'login' && <button className="block w-full py-1 text-primary" onClick={() => setMode('login')}>{t('haveAccount')}</button>}
          {mode !== 'register' && <button className="block w-full py-1 text-primary" onClick={() => setMode('register')}>{t('noAccount')}</button>}
          {mode === 'login' && b.settings.member.otp.enabled && <button className="block w-full py-1 text-slate-600" onClick={() => setMode('otp')}>{t('otpLogin')}</button>}
          {mode === 'login' && <button className="block w-full py-1 text-slate-500" onClick={() => setMode('reset')}>{t('forgot')}</button>}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ portal
function Portal() {
  const t = useT(M);
  const token = useMember((s) => s.token)!;
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['m', 'me'], queryFn: () => memberApi('/me') });
  const { socket } = useRealtime({ memberToken: token });
  useSocketEvent(socket, [EVENTS.WALLET_UPDATED, EVENTS.POINTS_UPDATED, EVENTS.MEMBER_UPDATED, EVENTS.TICKET_UPDATED, EVENTS.CREDENTIAL_UPDATED, EVENTS.RIDE_QUEUE_UPDATED, EVENTS.NOTIFICATION, EVENTS.ORDER_UPDATED, EVENTS.ORDER_READY, EVENTS.LOCKER_UPDATED], () => void qc.invalidateQueries({ queryKey: ['m'] }));
  useSocketEvent(socket, EVENTS.QUEUE_CALLED, (d) => {
    chime('alert');
    toast.success(t('calledNow'), `${d?.queueNo ?? ''} ${d?.ride ? tr(d.ride, t.lang) : ''}`);
    void qc.invalidateQueries({ queryKey: ['m'] });
  });
  useSocketEvent(socket, EVENTS.ORDER_READY, (d) => {
    chime('success');
    toast.success(t.x({ th: 'อาหารพร้อมรับแล้ว', en: 'Your food is ready', zh: '您的餐点已备好' }), d?.orderNumber ? `#${d.orderNumber}` : undefined);
  });
  if (me.isError) return <div className="p-6"><Empty title={t.err(me.error)} /></div>;
  if (!me.data) return <Loading />;
  const tabs = [
    { to: '/member', label: t('tabCard'), icon: IdCard, end: true },
    { to: '/member/tickets', label: t('tabTickets'), icon: Ticket },
    { to: '/member/wallet', label: t('tabWallet'), icon: Wallet },
    { to: '/member/rewards', label: t('tabRewards'), icon: Gift },
    { to: '/member/queue', label: t('tabQueue'), icon: Timer },
    { to: '/member/more', label: t('tabMore'), icon: MenuIcon },
  ];
  return (
    <div className="mx-auto max-w-3xl px-4 pt-5 pb-28">
      <Routes>
        <Route index element={<CardTab me={me.data} />} />
        <Route path="tickets" element={<TicketsTab />} />
        <Route path="wallet" element={<WalletTab me={me.data} />} />
        <Route path="rewards" element={<RewardsTab me={me.data} />} />
        <Route path="queue" element={<QueueTab />} />
        <Route path="more" element={<MoreTab />} />
        <Route path="bookings" element={<BookingsTab />} />
        <Route path="membership" element={<MembershipTab me={me.data} />} />
        <Route path="food" element={<FoodTab me={me.data} />} />
        <Route path="coupons" element={<CouponsTab />} />
        <Route path="notifications" element={<NotificationsTab />} />
        <Route path="history" element={<HistoryTab />} />
        <Route path="security" element={<SecurityTab />} />
        <Route path="profile" element={<ProfileTab me={me.data} />} />
      </Routes>
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t bg-white/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto grid max-w-3xl grid-cols-6">
          {tabs.map((x) => (
            <NavLink key={x.to} to={x.to} end={x.end} className={({ isActive }) => clsx('flex flex-col items-center gap-0.5 py-2 text-[11px]', isActive ? 'font-semibold text-primary' : 'text-slate-500')}>
              <x.icon className="h-5 w-5" />
              {x.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

function H({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return <div className="mb-3 flex items-center justify-between"><h2 className="text-xl font-bold">{children}</h2>{right}</div>;
}

function CardTab({ me }: { me: any }) {
  const t = useT(M);
  const m = me.member;
  const qr = useQuery({ queryKey: ['m', 'qr'], queryFn: () => memberApi('/qr'), refetchInterval: (q) => Math.max(5, ((q.state.data as any)?.ttlSec ?? 60) - 5) * 1000, refetchIntervalInBackground: false, retry: false });
  const ent = useQuery({ queryKey: ['m', 'ent'], queryFn: () => memberApi('/entitlements') });
  const physical = me.cards.filter((c: any) => c.type !== 'DIGITAL_CARD');
  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-3xl p-5 text-white shadow-lg" style={{ background: `linear-gradient(135deg, ${m.tier_color || '#334155'}, #0f172a)` }}>
        <div className="flex items-start justify-between">
          <div>
            <div className="text-sm text-white/70">{t('welcome')}</div>
            <div className="text-2xl font-bold">{m.first_name} {m.last_name}</div>
            <div className="mt-1 flex items-center gap-2"><TierBadge tier={{ name: m.tier_name, color: 'rgba(255,255,255,0.25)' }} /><span className="font-mono text-sm text-white/80">{m.member_no}</span></div>
          </div>
          <div className="text-right">
            <div className="text-xs text-white/70">{t('balance')}</div>
            <div className="text-2xl font-extrabold tabular-nums">{money(m.wallet_balance ?? 0)}</div>
            <div className="text-sm text-white/80">{Number(m.points).toLocaleString()} {t('points')}</div>
          </div>
        </div>
        <div className="mt-5 flex flex-col items-center rounded-2xl bg-white p-4 text-slate-900">
          {qr.data ? (
            <>
              <QrCode value={qr.data.qr} size={210} />
              <Barcode value={qr.data.barcode} height={46} module={1.6} showText={false} className="mt-2" />
              <div className="mt-1 font-mono text-xs text-slate-500">{qr.data.code}</div>
              <div className="mt-1 text-[11px] text-slate-400">{t('qrRefresh', { s: qr.data.ttlSec })}</div>
            </>
          ) : qr.isError ? <div className="py-8 text-sm text-slate-500">{t.err(qr.error)}</div> : <Loading />}
        </div>
        <p className="mt-3 text-center text-sm text-white/80">{t('showAtGate')}</p>
      </div>
      <div className="rounded-3xl bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-slate-500">{t('membership')}</div>
            {me.membership ? (
              <>
                <div className="font-bold">{t.tr(me.membership.product_name)}</div>
                <div className="text-sm text-slate-600">{me.membership.end_date ? t('validUntil', { d: me.membership.end_date }) : t('unlimited')}{me.membership.days_remaining != null && ` · ${t('daysLeft', { n: me.membership.days_remaining })}`}</div>
              </>
            ) : <div className="text-slate-600">{t('noMembership')}</div>}
          </div>
          <NavLink to="/member/membership"><Button variant="outline" size="sm">{t('buyMembership')}</Button></NavLink>
        </div>
        {me.benefits.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">{me.benefits.map((x: any, i: number) => <span key={i} className="rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-800">{t.tr(x.name) || x.type}</span>)}</div>
        )}
      </div>
      {ent.data?.length > 0 && (
        <div className="rounded-3xl bg-white p-4 shadow-sm">
          <div className="mb-2 font-semibold">{t('rides')}</div>
          <div className="flex flex-wrap gap-1.5">
            {ent.data.map((e: any) => <span key={e.id} className="rounded-full bg-emerald-50 px-3 py-1 text-xs text-emerald-800">{t.tr(e.ride_name) || e.category || '★'} · {e.type === 'UNLIMITED' ? t('unlimited') : e.uses_left != null ? t('usesLeft', { n: e.uses_left }) : e.type}</span>)}
          </div>
        </div>
      )}
      {physical.length > 0 && (
        <div className="rounded-3xl bg-white p-4 shadow-sm">
          <div className="mb-2 font-semibold">{t('myCards')}</div>
          {physical.map((c: any) => <div key={c.id} className="flex items-center justify-between py-1 text-sm"><span className="font-mono">{c.code}</span><span className="text-slate-500">{c.type.replace(/_/g, ' ')}</span><PStatus s={c.status} /></div>)}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 text-center">
        <div className="rounded-2xl bg-white p-3 shadow-sm"><div className="text-xs text-slate-500">{t('visits')}</div><div className="text-xl font-bold">{m.visit_count ?? 0}</div></div>
        <div className="rounded-2xl bg-white p-3 shadow-sm"><div className="text-xs text-slate-500">{t('spend')}</div><div className="text-xl font-bold">{money(m.total_spend ?? 0)}</div></div>
      </div>
    </div>
  );
}

function TicketsTab() {
  const t = useT(M);
  const q = useQuery({ queryKey: ['m', 'tickets'], queryFn: () => memberApi('/tickets') });
  const [open, setOpen] = useState<any>(null);
  return (
    <div>
      <H right={<NavLink to="/park/book"><Button size="sm">{t.x({ th: 'ซื้อบัตร', en: 'Buy tickets', zh: '购票' })}</Button></NavLink>}>{t('tabTickets')}</H>
      {!q.data ? <Loading /> : !q.data.length ? <Empty /> : (
        <div className="space-y-2">
          {q.data.map((tk: any) => (
            <button key={tk.id} onClick={() => tk.qr && setOpen(tk)} className="flex w-full items-center gap-3 rounded-2xl bg-white p-4 text-left shadow-sm">
              <div className="h-12 w-2 rounded-full" style={{ background: tk.color }} />
              <div className="flex-1">
                <div className="font-semibold">{t.tr(tk.package_name)} · {t.tr(tk.ticket_type_name)}</div>
                <div className="text-xs text-slate-500">{tk.visit_date}{tk.valid_to !== tk.visit_date ? ` → ${tk.valid_to}` : ''} · <span className="font-mono">{tk.ticket_no}</span></div>
              </div>
              <PStatus s={tk.status} />
              {tk.qr && <ChevronRight className="h-4 w-4 text-slate-400" />}
            </button>
          ))}
        </div>
      )}
      {open && (
        <Modal open onClose={() => setOpen(null)} title={t.tr(open.package_name)} size="sm">
          <div className="flex flex-col items-center gap-2">
            <QrCode value={open.qr} size={240} />
            <Barcode value={open.barcode} height={46} />
            <div className="text-sm text-slate-500">{open.visit_date} · {t.tr(open.ticket_type_name)}</div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Portal purchase: create a sale and pay online (or with the wallet). */
function usePortalPurchase() {
  const b = useBoot();
  const t = useT(M);
  const [sale, setSale] = useState<any>(null);
  const start = async (lines: any[]) => {
    try {
      const d = await memberApi('/sales', { body: { branchCode: branchCodeOf(b), lines, clientRef: newKey(), language: t.lang } });
      setSale(d);
    } catch (e) {
      toast.error(t.err(e));
    }
  };
  const node = sale ? <PurchaseModal saleId={sale.sale.id} allowWallet={sale.sale.kind !== 'TOPUP'} onClose={() => setSale(null)} /> : null;
  return { start, node };
}

function PurchaseModal({ saleId, allowWallet, onClose }: { saleId: string; allowWallet: boolean; onClose: () => void }) {
  const t = useT(M);
  const b = useBoot();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['m', 'sale', saleId], queryFn: () => memberApi(`/sales/${saleId}`), refetchInterval: 4000 });
  const paid = q.data?.sale.status === 'PAID';
  useEffect(() => {
    if (paid) void qc.invalidateQueries({ queryKey: ['m'] });
  }, [paid, qc]);
  const methods = [...Object.entries(b.settings.payment.online ?? {}).filter(([k, v]) => v && k !== 'WALLET').map(([k]) => k), ...(allowWallet ? ['WALLET'] : [])];
  const refresh = () => q.refetch();
  return (
    <Modal open onClose={onClose} title={t('payFor')} size="md">
      {!q.data ? <Loading /> : paid ? (
        <div className="py-6 text-center">
          <ShieldCheck className="mx-auto h-14 w-14 text-emerald-500" />
          <div className="mt-2 text-xl font-bold">{t('paidDone')}</div>
          <Button className="mt-4" onClick={onClose}>{t('done')}</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1 text-sm">{q.data.items.map((i: any) => <div key={i.id} className="flex justify-between"><span>{t.tr(i.name)} × {i.qty}</span><span>{money(i.line_total)}</span></div>)}</div>
          <OnlinePay
            outstanding={Number(q.data.sale.total) - Number(q.data.sale.paid_amount)}
            methods={methods}
            payments={q.data.payments}
            verifications={q.data.verifications}
            accountName={b.settings.payment.qr.accountName}
            start={async (m) => {
              if (m === '__CHANGE__') {
                const open = q.data.payments.find((p: any) => ['PENDING', 'WAITING_CARD', 'PROCESSING'].includes(p.status));
                if (open) await memberApi(`/sales/${saleId}/payments/${open.id}/cancel`, { method: 'POST' });
              } else await memberApi(`/sales/${saleId}/payments`, { body: { method: m }, idempotencyKey: newKey() });
              await refresh();
            }}
            verify={async (pid, reference) => {
              await memberApi(`/sales/${saleId}/payments/${pid}/verify`, { body: { reference } });
              await refresh();
            }}
            simulate={async (pid, outcome) => {
              await memberApi(`/sales/${saleId}/payments/${pid}/sandbox`, { body: { outcome } });
              await refresh();
            }}
          />
        </div>
      )}
    </Modal>
  );
}

function WalletTab({ me }: { me: any }) {
  const t = useT(M);
  const b = useBoot();
  const q = useQuery({ queryKey: ['m', 'wallet'], queryFn: () => memberApi('/wallet') });
  const [amount, setAmount] = useState<number>(b.settings.wallet.quickAmounts?.[1] ?? 300);
  const buy = usePortalPurchase();
  return (
    <div className="space-y-4">
      <div className="rounded-3xl bg-slate-900 p-5 text-white">
        <div className="text-sm text-white/70">{t('balance')}</div>
        <div className="text-4xl font-extrabold tabular-nums">{money(q.data?.wallet?.balance ?? me.member.wallet_balance ?? 0)}</div>
        {Number(q.data?.wallet?.bonus_balance ?? 0) > 0 && <div className="text-sm text-amber-300">+ {money(q.data.wallet.bonus_balance)} bonus</div>}
      </div>
      <div className="rounded-3xl bg-white p-4 shadow-sm">
        <div className="mb-2 font-semibold">{t('topup')}</div>
        <div className="grid grid-cols-4 gap-2">
          {(b.settings.wallet.quickAmounts ?? [100, 300, 500, 1000]).map((a: number) => (
            <button key={a} onClick={() => setAmount(a)} className={clsx('press rounded-xl border-2 py-3 font-bold', amount === a ? 'border-primary bg-primary/5 text-primary' : 'border-slate-200')}>{money(a)}</button>
          ))}
        </div>
        <Field label={t('topupAmount')} className="mt-3"><Input type="number" min={b.settings.wallet.minTopup} max={b.settings.wallet.maxTopup} value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></Field>
        <Button size="lg" className="mt-3 w-full" disabled={amount < b.settings.wallet.minTopup || amount > b.settings.wallet.maxTopup} onClick={() => buy.start([{ type: 'TOPUP', amount, qty: 1 }])}>{t('topup')} {money(amount)}</Button>
      </div>
      <div className="rounded-3xl bg-white p-4 shadow-sm">
        <div className="mb-2 font-semibold">{t('history')}</div>
        {!q.data ? <Loading /> : !q.data.ledger.length ? <Empty /> : q.data.ledger.map((l: any) => (
          <div key={l.txn_no} className="flex items-center justify-between border-b py-2 text-sm last:border-0">
            <div><div className="font-medium">{t.status(l.type)}</div><div className="text-xs text-slate-500">{dateTime(l.created_at)} {l.reference ? `· ${l.reference}` : ''}</div></div>
            <div className={clsx('font-bold tabular-nums', Number(l.credit) > 0 ? 'text-emerald-600' : 'text-rose-600')}>{Number(l.credit) > 0 ? `+${money(l.credit)}` : `−${money(l.debit)}`}</div>
          </div>
        ))}
      </div>
      {buy.node}
    </div>
  );
}

function RewardsTab({ me }: { me: any }) {
  const t = useT(M);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['m', 'rewards'], queryFn: () => memberApi('/rewards') });
  const pts = useQuery({ queryKey: ['m', 'points'], queryFn: () => memberApi('/points') });
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <div className="rounded-3xl bg-gradient-to-br from-amber-400 to-orange-500 p-5 text-white">
        <div className="text-sm text-white/80">{t('pointsBalance')}</div>
        <div className="text-4xl font-extrabold">{Number(me.member.points).toLocaleString()}</div>
      </div>
      {!q.data ? <Loading /> : (
        <div className="grid gap-3 sm:grid-cols-2">
          {q.data.rewards.map((r: any) => (
            <div key={r.id} className="flex flex-col rounded-3xl bg-white p-4 shadow-sm">
              <SafeImg src={r.image_url} className="mb-2 h-28 w-full rounded-2xl object-cover" />
              <div className="font-semibold">{t.tr(r.name)}</div>
              <div className="text-sm text-slate-500">{t.tr(r.description)}</div>
              <div className="mt-auto flex items-center justify-between pt-3">
                <span className="font-bold text-amber-600">{t('pointsRequired', { n: r.points_required })}</span>
                <Button size="sm" disabled={!r.eligible} loading={busy === r.id} onClick={async () => {
                  setBusy(r.id);
                  try {
                    await memberApi(`/rewards/${r.id}/redeem`, { method: 'POST', idempotencyKey: newKey() });
                    toast.success(t('redeemed'));
                    void qc.invalidateQueries({ queryKey: ['m'] });
                  } catch (e) { toast.error(t.err(e)); } finally { setBusy(null); }
                }}>{r.eligible ? t('redeem') : r.reason === 'POINTS' ? t('notEnough') : t.status(r.reason)}</Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {q.data?.redemptions?.length > 0 && (
        <div className="rounded-3xl bg-white p-4 shadow-sm">
          <div className="mb-2 font-semibold">{t('myRedemptions')}</div>
          {q.data.redemptions.map((x: any) => <div key={x.id} className="flex justify-between border-b py-2 text-sm last:border-0"><span>{t.tr(x.reward_name)} {x.voucher_code && <b className="font-mono">{x.voucher_code}</b>}</span><span className="text-slate-500">−{x.points}</span></div>)}
        </div>
      )}
      <div className="rounded-3xl bg-white p-4 shadow-sm">
        <div className="mb-2 font-semibold">{t('history')}</div>
        {(pts.data ?? []).map((p: any, i: number) => <div key={i} className="flex justify-between border-b py-2 text-sm last:border-0"><span>{t.status(p.type)} <span className="text-xs text-slate-500">{dateTime(p.created_at)}</span></span><b className={p.points > 0 ? 'text-emerald-600' : 'text-rose-600'}>{p.points > 0 ? '+' : ''}{p.points}</b></div>)}
      </div>
    </div>
  );
}

function QueueTab() {
  const t = useT(M);
  const b = useBoot();
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: ['m', 'queues'], queryFn: () => memberApi('/queues'), refetchInterval: 30_000 });
  const live = useQuery({ queryKey: ['park-live', branchCodeOf(b)], queryFn: () => parkPublicApi(`/branches/${branchCodeOf(b)}/live`), refetchInterval: 30_000 });
  const [party, setParty] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <H>{t('myQueues')}</H>
      {!mine.data ? <Loading /> : !mine.data.length ? <Empty /> : mine.data.map((q: any) => (
        <div key={q.id} className={clsx('rounded-3xl p-5 shadow-sm', q.status === 'CALLED' ? 'animate-pulse bg-emerald-500 text-white' : 'bg-white')}>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm opacity-80">{t.tr(q.ride.name)}</div>
              <div className="text-4xl font-extrabold">{q.queueNo}</div>
            </div>
            <div className="text-right">
              {q.status === 'CALLED' ? <div className="font-bold">{t('calledNow')}</div> : <><div className="font-semibold">{t('ahead', { n: q.ahead })}</div><div className="text-sm opacity-70">{t('estWait', { n: q.waitMinutes })}</div></>}
            </div>
          </div>
          <Button size="sm" variant={q.status === 'CALLED' ? 'secondary' : 'ghost'} className="mt-3" onClick={async () => { await memberApi(`/queues/${q.id}`, { method: 'DELETE' }).catch((e) => toast.error(t.err(e))); void qc.invalidateQueries({ queryKey: ['m'] }); }}>{t('leave')}</Button>
        </div>
      ))}
      <H right={<div className="flex items-center gap-2 text-sm">{t('party')} <Stepper value={party} onChange={setParty} min={1} max={10} /></div>}>{t('joinQueue')}</H>
      <div className="space-y-2">
        {(live.data?.rides ?? []).filter((r: any) => r.queue_enabled).map((r: any) => (
          <div key={r.id} className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm">
            <div className="flex-1">
              <div className="font-semibold">{t.tr(r.name)}</div>
              <div className="text-xs text-slate-500">{r.status === 'OPEN' ? t('estWait', { n: r.wait_minutes ?? 0 }) : t.status(r.status)}</div>
            </div>
            <Button size="sm" disabled={r.status !== 'OPEN'} loading={busy === r.id} onClick={async () => {
              setBusy(r.id);
              try {
                const res = await memberApi('/queues', { body: { rideId: r.id, partySize: party } });
                toast.success(`${res.queueNo}`, t('ahead', { n: res.ahead }));
                void qc.invalidateQueries({ queryKey: ['m'] });
              } catch (e) { toast.error(t.err(e)); } finally { setBusy(null); }
            }}>{t('joinQueue')}</Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function MoreTab() {
  const t = useT(M);
  const nav = useNavigate();
  const setToken = useMember((s) => s.set);
  const items = [
    { to: 'bookings', label: t('bookings'), icon: CalendarDays },
    { to: 'membership', label: t('membership'), icon: Crown },
    { to: 'food', label: t('food'), icon: UtensilsCrossed },
    { to: 'history', label: t('transactions'), icon: History },
    { to: 'coupons', label: t('coupons'), icon: ShoppingBag },
    { to: 'notifications', label: t('notifications'), icon: Bell },
    { to: 'profile', label: t('profile'), icon: User },
    { to: 'security', label: t('security'), icon: Lock },
  ];
  return (
    <div className="space-y-2">
      {items.map((i) => (
        <button key={i.to} onClick={() => nav(`/member/${i.to}`)} className="flex w-full items-center gap-3 rounded-2xl bg-white p-4 text-left shadow-sm">
          <i.icon className="h-5 w-5 text-primary" />
          <span className="flex-1 font-medium">{i.label}</span>
          <ChevronRight className="h-4 w-4 text-slate-400" />
        </button>
      ))}
      <button onClick={async () => { await memberApi('/logout', { method: 'POST' }).catch(() => {}); setToken(null); }} className="flex w-full items-center gap-3 rounded-2xl bg-white p-4 text-left text-rose-600 shadow-sm">
        <LogOut className="h-5 w-5" /> {t('logout')}
      </button>
      <button onClick={() => nav('/park')} className="flex w-full items-center gap-3 rounded-2xl p-4 text-left text-slate-500"><Home className="h-5 w-5" /> {t.x({ th: 'กลับหน้าเว็บไซต์', en: 'Back to website', zh: '返回网站' })}</button>
    </div>
  );
}

function BookingsTab() {
  const t = useT(M);
  const q = useQuery({ queryKey: ['m', 'bookings'], queryFn: () => memberApi('/bookings') });
  return (
    <div>
      <H>{t('bookings')}</H>
      {!q.data ? <Loading /> : !q.data.length ? <Empty /> : q.data.map((b: any) => (
        <NavLink key={b.id} to={`/park/booking/${b.booking_no}?t=${b.access_token}`} className="mb-2 flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm">
          <div className="flex-1"><div className="font-mono font-bold">{b.booking_no}</div><div className="text-xs text-slate-500">{b.visit_date} · {b.guests} · {money(b.total)}</div></div>
          <PStatus s={b.status} />
          <ChevronRight className="h-4 w-4 text-slate-400" />
        </NavLink>
      ))}
    </div>
  );
}

function MembershipTab({ me }: { me: any }) {
  const t = useT(M);
  const q = useQuery({ queryKey: ['park-membership-products'], queryFn: () => parkPublicApi('/membership-products') });
  const buy = usePortalPurchase();
  const cur = me.membership;
  return (
    <div>
      <H>{t('membership')}</H>
      {!q.data ? <Loading /> : (
        <div className="space-y-3">
          {q.data.map((p: any) => {
            const isCur = cur?.product_id === p.id;
            const rank = me.member.tier_rank ?? 0;
            const type = isCur ? 'MEMBERSHIP_RENEWAL' : cur && p.tier_rank > rank ? 'MEMBERSHIP_UPGRADE' : 'MEMBERSHIP';
            return (
              <div key={p.id} className={clsx('rounded-3xl bg-white p-5 shadow-sm', isCur && 'ring-2 ring-primary')}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <TierBadge tier={{ name: p.tier_name, color: p.tier_color }} />
                    <div className="mt-1 text-lg font-bold">{t.tr(p.name)}</div>
                    <div className="text-sm text-slate-600">{t.tr(p.description)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-extrabold text-primary">{money(isCur ? p.renewal_price ?? p.price : p.price)}</div>
                    <div className="text-xs text-slate-500">{p.validity_value} {p.validity_unit?.toLowerCase()}</div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">{p.benefits.map((x: any, i: number) => <span key={i} className="rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-800">{t.tr(x.name) || x.type}</span>)}</div>
                <Button className="mt-4 w-full" variant={isCur ? 'outline' : 'primary'} onClick={() => buy.start([{ type, refId: p.id, qty: 1 }])}>
                  {isCur ? t('renew') : type === 'MEMBERSHIP_UPGRADE' ? t('upgrade') : t('join')}
                </Button>
              </div>
            );
          })}
        </div>
      )}
      {buy.node}
    </div>
  );
}

function FoodTab({ me }: { me: any }) {
  const t = useT(M);
  const b = useBoot();
  const qc = useQueryClient();
  const code = branchCodeOf(b);
  const menu = useQuery({ queryKey: ['m', 'menu', code], queryFn: () => memberApi(`/menu?branchCode=${code}`) });
  const orders = useQuery({ queryKey: ['m', 'food-orders'], queryFn: () => memberApi('/food-orders') });
  const [cart, setCart] = useState<{ productId: string; qty: number; modifierIds: string[]; name: any; price: number }[]>([]);
  const [pick, setPick] = useState<any>(null);
  const [cat, setCat] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const cats = (menu.data?.categories ?? []).filter((c: any) => c.kind === 'STANDARD');
  const products = (menu.data?.products ?? []).filter((p: any) => (!cat || p.category_id === cat) && p.status === 'AVAILABLE');
  const total = cart.reduce((s, l) => s + l.price * l.qty, 0);
  const add = (p: any, modifierIds: string[]) => {
    const delta = p.modifier_groups.flatMap((g: any) => g.modifiers).filter((m: any) => modifierIds.includes(m.id)).reduce((s: number, m: any) => s + Number(m.price_delta), 0);
    setCart((c) => [...c, { productId: p.id, qty: 1, modifierIds, name: p.name, price: Number(p.price) + delta }]);
  };
  return (
    <div className="space-y-4">
      <H>{t('food')}</H>
      {!menu.data ? <Loading /> : (
        <>
          <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
            <button onClick={() => setCat('')} className={clsx('shrink-0 rounded-full px-3 py-1.5 text-sm', !cat ? 'bg-primary text-white' : 'bg-white')}>{t('all')}</button>
            {cats.map((c: any) => <button key={c.id} onClick={() => setCat(c.id)} className={clsx('shrink-0 rounded-full px-3 py-1.5 text-sm', cat === c.id ? 'bg-primary text-white' : 'bg-white')}>{t.tr(c.name)}</button>)}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {products.map((p: any) => (
              <button key={p.id} onClick={() => (p.modifier_groups.length ? setPick(p) : add(p, []))} className="press overflow-hidden rounded-2xl bg-white text-left shadow-sm">
                <SafeImg src={p.image_url} className="h-24 w-full object-cover" />
                <div className="p-3"><div className="line-clamp-2 text-sm font-semibold">{t.tr(p.name)}</div><div className="font-bold text-primary">{money(p.price)}</div></div>
              </button>
            ))}
          </div>
        </>
      )}
      {cart.length > 0 && (
        <div className="sticky bottom-20 rounded-3xl bg-white p-4 shadow-xl">
          {cart.map((l, i) => (
            <div key={i} className="flex items-center justify-between py-1 text-sm">
              <span>{t.tr(l.name)}</span>
              <span className="flex items-center gap-2"><Stepper value={l.qty} onChange={(v) => setCart((c) => (v === 0 ? c.filter((_, j) => j !== i) : c.map((x, j) => (j === i ? { ...x, qty: v } : x))))} />{money(l.price * l.qty)}</span>
            </div>
          ))}
          <div className="mt-2 flex items-center justify-between border-t pt-2 text-sm text-slate-500"><span>{t('balance')}</span><span>{money(me.member.wallet_balance ?? 0)}</span></div>
          <Button size="lg" className="mt-2 w-full" loading={busy} onClick={async () => {
            setBusy(true);
            try {
              const r = await memberApi('/food-orders', { body: { branchCode: code, clientOrderId: newKey(), language: t.lang, items: cart.map((l) => ({ productId: l.productId, qty: l.qty, modifierIds: l.modifierIds })) } });
              toast.success(t('orderPlaced', { n: r.orderNumber }));
              setCart([]);
              void qc.invalidateQueries({ queryKey: ['m'] });
            } catch (e) { toast.error(t.err(e)); } finally { setBusy(false); }
          }}>{t('placeOrder')} · {money(total)}</Button>
        </div>
      )}
      {orders.data?.length > 0 && (
        <div className="rounded-3xl bg-white p-4 shadow-sm">
          <div className="mb-2 font-semibold">{t('foodOrders')}</div>
          {orders.data.map((o: any) => <div key={o.id} className="flex items-center justify-between border-b py-2 text-sm last:border-0"><span><b>#{o.order_number}</b> {(o.items ?? []).map((i: any) => `${t.tr(i.name)}×${i.qty}`).join(', ')}</span><PStatus s={o.status} /></div>)}
        </div>
      )}
      {pick && <ModifierPicker p={pick} onClose={() => setPick(null)} onAdd={(ids) => { add(pick, ids); setPick(null); }} />}
    </div>
  );
}

function CouponsTab() {
  const t = useT(M);
  const q = useQuery({ queryKey: ['m', 'coupons'], queryFn: () => memberApi('/coupons') });
  return (
    <div>
      <H>{t('coupons')}</H>
      {!q.data ? <Loading /> : !q.data.length ? <Empty /> : q.data.map((c: any) => (
        <div key={c.id} className="mb-2 flex items-center gap-3 rounded-2xl border-2 border-dashed border-primary/40 bg-white p-4">
          <Gift className="h-6 w-6 text-primary" />
          <div className="flex-1"><div className="font-semibold">{t.tr(c.name)}</div><div className="text-xs text-slate-500">{c.valid_from ?? ''} → {c.valid_to ?? '∞'}</div></div>
          <div className="text-right"><div className="font-mono font-bold">{c.code}</div><PStatus s={c.status} /></div>
        </div>
      ))}
    </div>
  );
}

function NotificationsTab() {
  const t = useT(M);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['m', 'notifications'], queryFn: () => memberApi('/notifications') });
  return (
    <div>
      <H right={<Button size="sm" variant="ghost" onClick={async () => { await memberApi('/notifications/read', { method: 'POST' }); void qc.invalidateQueries({ queryKey: ['m', 'notifications'] }); }}>{t('markRead')}</Button>}>{t('notifications')}</H>
      {!q.data ? <Loading /> : !q.data.length ? <Empty /> : q.data.map((n: any) => (
        <div key={n.id} className={clsx('mb-2 rounded-2xl bg-white p-4 shadow-sm', !n.read_at && 'border-l-4 border-primary')}>
          <div className="font-semibold">{t.tr(n.title)}</div>
          <div className="text-sm text-slate-600">{t.tr(n.body)}</div>
          <div className="mt-1 text-xs text-slate-400">{dateTime(n.created_at)}</div>
        </div>
      ))}
    </div>
  );
}

function HistoryTab() {
  const t = useT(M);
  const tx = useQuery({ queryKey: ['m', 'transactions'], queryFn: () => memberApi('/transactions') });
  const rides = useQuery({ queryKey: ['m', 'rides'], queryFn: () => memberApi('/rides') });
  return (
    <div className="space-y-4">
      <H>{t('transactions')}</H>
      {!tx.data ? <Loading /> : !tx.data.length ? <Empty /> : tx.data.map((s: any) => (
        <div key={s.id} className="rounded-2xl bg-white p-4 shadow-sm">
          <div className="flex justify-between"><span className="font-mono text-sm">{s.sale_no}</span><b>{money(s.total)}</b></div>
          <div className="text-xs text-slate-500">{dateTime(s.created_at)} · {t.tr(s.store_name) || s.channel} {s.points_earned ? `· +${s.points_earned} ${t('points')}` : ''}</div>
          <div className="mt-1 text-sm">{(s.items ?? []).map((i: any) => `${t.tr(i.name)}×${i.qty}`).join(', ')}</div>
        </div>
      ))}
      <H>{t('rideHistory')}</H>
      {(rides.data ?? []).map((r: any) => <div key={r.id} className="flex justify-between rounded-2xl bg-white p-3 text-sm shadow-sm"><span>{t.tr(r.ride_name)}</span><span className="text-slate-500">{dateTime(r.created_at)}</span></div>)}
    </div>
  );
}

function SecurityTab() {
  const t = useT(M);
  const setToken = useMember((s) => s.set);
  const q = useQuery({ queryKey: ['m', 'sessions'], queryFn: () => memberApi('/sessions') });
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  return (
    <div className="space-y-4">
      <H>{t('security')}</H>
      <div className="rounded-3xl bg-white p-4 shadow-sm">
        <div className="mb-2 font-semibold">{t('sessions')}</div>
        {(q.data ?? []).filter((s: any) => !s.revoked_at).map((s: any) => (
          <div key={s.id} className="border-b py-2 text-sm last:border-0">
            <div className="flex items-center gap-2">{s.current && <span className="rounded-full bg-emerald-100 px-2 text-xs text-emerald-800">{t('thisDevice')}</span>}{s.suspicious && <span className="rounded-full bg-rose-100 px-2 text-xs text-rose-800">!</span>}<span className="truncate text-slate-600">{s.user_agent}</span></div>
            <div className="text-xs text-slate-400">{s.ip} · {dateTime(s.last_seen_at ?? s.created_at)}</div>
          </div>
        ))}
        <Button variant="danger" className="mt-3" onClick={async () => { await memberApi('/logout-all', { method: 'POST' }); setToken(null); }}>{t('logoutAll')}</Button>
      </div>
      <div className="space-y-3 rounded-3xl bg-white p-4 shadow-sm">
        <div className="font-semibold"><KeyRound className="mr-1 inline h-4 w-4" />{t('changePassword')}</div>
        <Field label={t('currentPassword')}><Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></Field>
        <Field label={t('newPassword')}><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></Field>
        <Button onClick={async () => {
          try {
            await memberApi('/password', { body: { current: cur, next } });
            toast.success(t('passwordChanged'));
            setToken(null);
          } catch (e) { toast.error(t.err(e)); }
        }} disabled={!cur || next.length < 6}>{t('save')}</Button>
      </div>
    </div>
  );
}

function ProfileTab({ me }: { me: any }) {
  const t = useT(M);
  const qc = useQueryClient();
  const m = me.member;
  const [f, setF] = useState({ firstName: m.first_name, lastName: m.last_name ?? '', email: m.email ?? '', birthday: m.birthday ? String(m.birthday).slice(0, 10) : '', gender: m.gender ?? 'UNSPECIFIED', address: m.address ?? '', emergencyContact: m.emergency_contact ?? '', language: m.language ?? t.lang });
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const genders = useMemo(() => [['UNSPECIFIED', '—'], ['MALE', t.x({ th: 'ชาย', en: 'Male', zh: '男' })], ['FEMALE', t.x({ th: 'หญิง', en: 'Female', zh: '女' })], ['OTHER', t.x({ th: 'อื่นๆ', en: 'Other', zh: '其他' })]], [t]);
  return (
    <div className="space-y-3 rounded-3xl bg-white p-5 shadow-sm">
      <H>{t('profile')}</H>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('firstName')}><Input value={f.firstName} onChange={(e) => set('firstName', e.target.value)} /></Field>
        <Field label={t('lastName')}><Input value={f.lastName} onChange={(e) => set('lastName', e.target.value)} /></Field>
      </div>
      <Field label={t('phone')}><Input value={m.phone} disabled /></Field>
      <Field label={t('email')}><Input value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
      <Field label={t('birthday')}><Input type="date" value={f.birthday} disabled={!!m.birthday} onChange={(e) => set('birthday', e.target.value)} /></Field>
      <Field label={t('gender')}><Select value={f.gender} onChange={(e) => set('gender', e.target.value)}>{genders.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
      <Field label={t('address')}><Input value={f.address} onChange={(e) => set('address', e.target.value)} /></Field>
      <Field label={t('emergency')}><Input value={f.emergencyContact} onChange={(e) => set('emergencyContact', e.target.value)} /></Field>
      <Button onClick={async () => {
        try {
          await memberApi('/me', { method: 'PUT', body: { ...f, email: f.email || null, birthday: f.birthday || null, address: f.address || null, emergencyContact: f.emergencyContact || null, language: t.lang } });
          toast.success(t('saved'));
          void qc.invalidateQueries({ queryKey: ['m'] });
        } catch (e) { toast.error(t.err(e)); }
      }}>{t('save')}</Button>
    </div>
  );
}
