import { useEffect, useMemo, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock, Download, Gauge, MapPin, Ticket, Timer, Users } from 'lucide-react';
import { EVENTS } from '@kiosk/shared';
import { newKey, parkPublicApi, storage } from '../lib/api';
import { money } from '../lib/format';
import { defineStrings, useT } from '../lib/lang';
import { useRealtime, useSocketEvent } from '../lib/socket';
import { Button, Empty, Field, Input, Loading, toast } from '../components/ui';
import { CS, CustomerProvider, SiteHeader, useBoot } from '../park/CustomerShell';
import { OnlinePay } from '../park/OnlinePay';
import { Barcode, QrCode } from '../park/scan';
import { PStatus, SafeImg, Stepper } from '../park/ui';

const S = defineStrings('web', {
  heroCta: { th: 'จองบัตรออนไลน์', en: 'Book tickets online', zh: '在线订票' },
  heroSub: { th: 'บัตรเดียวใช้ได้ทุกอย่าง — เข้าสวน เล่นเครื่องเล่น ซื้ออาหาร และของที่ระลึก', en: 'One QR for everything — entry, rides, food and souvenirs', zh: '一个二维码畅玩全园 — 入园、游乐、餐饮和纪念品' },
  crowd: { th: 'ความหนาแน่นตอนนี้', en: 'Crowd right now', zh: '当前人流' },
  NORMAL: { th: 'ปกติ', en: 'Normal', zh: '正常' },
  BUSY: { th: 'ค่อนข้างหนาแน่น', en: 'Busy', zh: '较拥挤' },
  CROWDED: { th: 'หนาแน่นมาก', en: 'Very crowded', zh: '非常拥挤' },
  wait: { th: 'รอ {n} นาที', en: '{n} min wait', zh: '等待{n}分钟' },
  packages: { th: 'แพ็กเกจบัตร', en: 'Ticket packages', zh: '门票套餐' },
  from: { th: 'เริ่มต้น', en: 'From', zh: '起' },
  memberPrice: { th: 'ราคาสมาชิก', en: 'Member price', zh: '会员价' },
  step1: { th: 'เลือกวันที่', en: 'Choose a date', zh: '选择日期' },
  step2: { th: 'เลือกบัตร', en: 'Choose tickets', zh: '选择门票' },
  step3: { th: 'ข้อมูลผู้จอง', en: 'Your details', zh: '预订人信息' },
  soldOut: { th: 'เต็ม', en: 'Sold out', zh: '已售罄' },
  fewLeft: { th: 'ใกล้เต็ม', en: 'Few left', zh: '余量不多' },
  remaining: { th: 'เหลือ {n} ที่', en: '{n} left', zh: '剩余{n}' },
  unavailable: { th: 'ไม่สามารถซื้อได้', en: 'Unavailable', zh: '不可购买' },
  includes: { th: 'รวม', en: 'Includes', zh: '包含' },
  allRides: { th: 'เล่นได้ทุกเครื่อง', en: 'All rides', zh: '全部游乐设施' },
  days: { th: '{n} วัน', en: '{n} days', zh: '{n}天' },
  cart: { th: 'รายการที่เลือก', en: 'Your selection', zh: '已选项目' },
  promo: { th: 'โค้ดส่วนลด', en: 'Promo code', zh: '优惠码' },
  apply: { th: 'ใช้โค้ด', en: 'Apply', zh: '使用' },
  invalidCode: { th: 'โค้ดไม่ถูกต้อง', en: 'Invalid code', zh: '优惠码无效' },
  fullName: { th: 'ชื่อ-นามสกุล', en: 'Full name', zh: '姓名' },
  payNow: { th: 'ชำระเงินออนไลน์ตอนนี้', en: 'Pay online now', zh: '现在在线付款' },
  payAtPark: { th: 'ชำระที่สวนสนุก (จองไว้ก่อน)', en: 'Reserve now, pay at the park', zh: '先预订，到园付款' },
  confirmBooking: { th: 'ยืนยันการจอง', en: 'Confirm booking', zh: '确认预订' },
  bookingNo: { th: 'หมายเลขการจอง', en: 'Booking number', zh: '预订号' },
  showAtGate: { th: 'แสดง QR นี้ที่ประตูทางเข้า หรือที่เคาน์เตอร์เพื่อรับริสแบนด์', en: 'Show this QR at the entrance gate or at the counter for wristbands', zh: '在入口闸门或柜台出示此二维码领取腕带' },
  yourTickets: { th: 'ตั๋วของคุณ', en: 'Your tickets', zh: '您的门票' },
  ticketsAfterPay: { th: 'QR ของตั๋วจะใช้งานได้หลังชำระเงิน', en: 'Ticket QR codes activate once paid', zh: '付款后门票二维码生效' },
  payAtCounter: { th: 'กรุณาชำระเงินที่เคาน์เตอร์ในวันเข้าชม', en: 'Please pay at the counter on your visit day', zh: '请在游玩当天到柜台付款' },
  saveLink: { th: 'บันทึกลิงก์นี้ไว้เพื่อดูการจองภายหลัง', en: 'Keep this link to view your booking later', zh: '请保存此链接以便日后查看' },
  cancelBooking: { th: 'ยกเลิกการจอง', en: 'Cancel booking', zh: '取消预订' },
  cancelConfirm: { th: 'ต้องการยกเลิกการจองนี้?', en: 'Cancel this booking?', zh: '确认取消此预订？' },
  guests: { th: 'ผู้เข้าชม', en: 'Guests', zh: '人数' },
  noBookings: { th: 'ยังไม่มีการจองบนอุปกรณ์นี้', en: 'No bookings on this device yet', zh: '此设备上暂无预订' },
  findBooking: { th: 'ค้นหาการจอง', en: 'Find a booking', zh: '查找预订' },
  accessCode: { th: 'รหัสเข้าถึง (จากอีเมล/ลิงก์)', en: 'Access code (from your link)', zh: '访问码（来自链接）' },
  closedNow: { th: 'ปิด', en: 'Closed', zh: '关闭' },
  heightMin: { th: 'สูง {n} ซม.+', en: '{n} cm+', zh: '身高{n}cm+' },
  addonPrice: { th: 'เล่นเพิ่ม {p}', en: 'Add-on {p}', zh: '加购 {p}' },
  saveTicket: { th: 'บันทึกภาพหน้าจอเก็บไว้ได้', en: 'You can save a screenshot', zh: '可截图保存' },
  memberLoginHint: { th: 'สมาชิกเข้าสู่ระบบเพื่อรับราคาสมาชิกและคะแนน', en: 'Members: sign in for member prices and points', zh: '会员登录可享会员价和积分' },
});

const mon = (d: string) => d.slice(0, 7);
const addMonth = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
/** "Today" in the park's time zone (the server decides; the visitor's device clock / zone may differ). */
function useBranchToday(code: string) {
  const q = useQuery({ queryKey: ['park-catalog', code, 'home'], queryFn: () => parkPublicApi(`/branches/${code}/catalog`, { headers: memberHeaders() }), enabled: !!code });
  return (q.data?.date as string | undefined) ?? null;
}
const memberHeaders = (): Record<string, string> => {
  const t = storage.get('member_token');
  return t ? { Authorization: `Bearer ${t}` } : {};
};

interface SavedBooking { no: string; token: string; date: string }
const savedBookings = (): SavedBooking[] => {
  try {
    return JSON.parse(storage.get('my_bookings') || '[]');
  } catch {
    return [];
  }
};
const saveBooking = (b: SavedBooking) => storage.set('my_bookings', JSON.stringify([b, ...savedBookings().filter((x) => x.no !== b.no)].slice(0, 30)));

export default function PublicSite() {
  return (
    <CustomerProvider surface="web">
      <div className="min-h-full bg-[var(--brand-bg)]">
        <SiteHeader />
        <Routes>
          <Route index element={<Home />} />
          <Route path="book" element={<Book />} />
          <Route path="live" element={<Live />} />
          <Route path="booking/:no" element={<BookingPage />} />
          <Route path="bookings" element={<MyBookings />} />
          <Route path=":branchCode/book" element={<Book />} />
        </Routes>
      </div>
    </CustomerProvider>
  );
}

function useBranchCode() {
  const b = useBoot();
  const { branchCode } = useParams();
  return (branchCode || storage.get('park_branch') || b.branches[0]?.code || '').toUpperCase();
}

function Home() {
  const t = useT(S);
  const tc = useT(CS);
  const b = useBoot();
  const code = useBranchCode();
  const live = useQuery({ queryKey: ['park-live', code], queryFn: () => parkPublicApi(`/branches/${code}/live`), refetchInterval: 30_000, enabled: !!code });
  const cat = useQuery({ queryKey: ['park-catalog', code, 'home'], queryFn: () => parkPublicApi(`/branches/${code}/catalog`, { headers: memberHeaders() }), enabled: !!code });
  return (
    <div>
      <section className="relative overflow-hidden bg-gradient-to-br from-primary to-secondary text-white">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-14 md:grid-cols-[1.4fr_1fr] md:py-20">
          <div>
            <h1 className="text-4xl leading-tight font-extrabold md:text-5xl">{t.tr(b.settings.park.name)}</h1>
            <p className="mt-3 max-w-xl text-lg text-white/85">{t.tr(b.settings.park.tagline)}</p>
            <p className="mt-2 text-white/70">{t('heroSub')}</p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link to="/park/book" className="press rounded-2xl bg-white px-7 py-4 text-lg font-bold text-primary shadow-xl">{t('heroCta')}</Link>
              <Link to="/member" className="press rounded-2xl border border-white/40 px-6 py-4 font-semibold">{tc('membership')}</Link>
            </div>
            <div className="mt-5 flex items-center gap-2 text-sm text-white/80"><Clock className="h-4 w-4" />{tc('openHours', { open: b.settings.park.openTime, close: b.settings.park.closeTime })}</div>
          </div>
          {live.data && (
            <div className="rounded-3xl bg-white/10 p-5 backdrop-blur">
              <div className="flex items-center gap-2 text-sm text-white/80"><Gauge className="h-4 w-4" /> {t('crowd')}</div>
              <div className="mt-1 text-3xl font-extrabold">{t(live.data.occupancy.level)}</div>
              <div className="mt-3 h-3 overflow-hidden rounded-full bg-white/20"><div className="h-full rounded-full bg-white" style={{ width: `${Math.min(100, live.data.occupancy.pct)}%` }} /></div>
              <div className="mt-5 space-y-2">
                {live.data.rides.slice(0, 5).map((r: any) => (
                  <div key={r.id} className="flex items-center justify-between text-sm">
                    <span>{t.tr(r.name)}</span>
                    <span className="font-semibold">{r.status !== 'OPEN' ? t.status(r.status) : t('wait', { n: r.wait_minutes ?? 0 })}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
      <section className="mx-auto max-w-6xl px-4 py-10">
        <h2 className="mb-5 text-2xl font-bold">{t('packages')}</h2>
        {!cat.data ? <Loading /> : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cat.data.packages.filter((p: any) => p.kind === 'ADMISSION').map((p: any) => <PackageCard key={p.id} p={p} />)}
          </div>
        )}
      </section>
    </div>
  );
}

function PackageCard({ p, children }: { p: any; children?: React.ReactNode }) {
  const t = useT(S);
  const paid = p.prices.map((x: any) => x.unit_price).filter((v: number) => v > 0);
  const min = paid.length ? Math.min(...paid) : Number(p.base_price);
  return (
    <div className="flex flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="h-2" style={{ background: p.color }} />
      {p.image_url && <SafeImg src={p.image_url} className="h-36 w-full object-cover" />}
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-lg font-bold">{t.tr(p.name)}</h3>
          {p.days > 1 && <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs">{t('days', { n: p.days })}</span>}
        </div>
        <p className="mt-1 line-clamp-3 text-sm text-slate-600">{t.tr(p.description)}</p>
        <div className="mt-2 flex flex-wrap gap-1">
          {p.all_rides && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">{t('allRides')}</span>}
          {p.rides.slice(0, 4).map((r: any) => <span key={r.ride_id} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{t.tr(r.name)}</span>)}
        </div>
        <div className="mt-auto pt-4">
          <div className="text-xs text-slate-500">{t('from')}</div>
          <div className="text-2xl font-extrabold text-primary">{money(min)}</div>
          {p.prices.some((x: any) => x.member_priced) && <div className="text-xs font-semibold text-amber-600">{t('memberPrice')}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

function Calendar({ code, today, value, onChange, maxDays }: { code: string; today: string; value: string; onChange: (d: string) => void; maxDays: number }) {
  const t = useT(S);
  const [month, setMonth] = useState(mon(value));
  const cal = useQuery({ queryKey: ['park-cal', code, month], queryFn: () => parkPublicApi(`/branches/${code}/calendar?month=${month}`) });
  const last = new Date(Date.parse(`${today}T00:00:00Z`) + maxDays * 86400000).toISOString().slice(0, 10);
  const first = new Date(`${month}-01T00:00:00Z`);
  const pad = first.getUTCDay();
  const dim = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const byDate = Object.fromEntries((cal.data?.days ?? []).map((d: any) => [d.date, d]));
  const dows = t.lang === 'th' ? ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'] : t.lang === 'zh' ? ['日', '一', '二', '三', '四', '五', '六'] : ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const label = new Date(`${month}-01T00:00:00`).toLocaleDateString(t.lang === 'zh' ? 'zh-CN' : t.lang === 'th' ? 'th-TH' : 'en-GB', { month: 'long', year: 'numeric' });
  return (
    <div className="rounded-3xl border bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <button className="press rounded-xl p-2 hover:bg-slate-100 disabled:opacity-30" disabled={month <= mon(today)} onClick={() => setMonth(addMonth(month, -1))}><ChevronLeft className="h-5 w-5" /></button>
        <div className="font-bold">{label}</div>
        <button className="press rounded-xl p-2 hover:bg-slate-100 disabled:opacity-30" disabled={month >= mon(last)} onClick={() => setMonth(addMonth(month, 1))}><ChevronRight className="h-5 w-5" /></button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs text-slate-500">{dows.map((d) => <div key={d}>{d}</div>)}</div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {Array.from({ length: pad }).map((_, i) => <div key={`p${i}`} />)}
        {Array.from({ length: dim }).map((_, i) => {
          const d = `${month}-${String(i + 1).padStart(2, '0')}`;
          const info = byDate[d];
          const disabled = d < today || d > last || info?.soldOut;
          return (
            <button
              key={d}
              disabled={disabled}
              onClick={() => onChange(d)}
              className={clsx(
                'press flex h-11 flex-col items-center justify-center rounded-xl text-sm sm:h-12',
                d === value ? 'bg-primary font-bold text-white' : disabled ? 'text-slate-300' : 'hover:bg-slate-100',
              )}
            >
              {i + 1}
              {info && !disabled && d !== value && <span className={clsx('mt-0.5 h-1 w-1 rounded-full', info.pct >= 90 ? 'bg-rose-500' : info.pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500')} />}
              {info?.soldOut && <span className="text-[9px]">{t('soldOut')}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

type Cart = Record<string, number>; // key `${packageId}|${ticketTypeId ?? ''}` → qty

function Book() {
  const t = useT(S);
  const b = useBoot();
  const nav = useNavigate();
  const code = useBranchCode();
  const today = useBranchToday(code);
  const [date, setDate] = useState<string | null>(null);
  useEffect(() => {
    if (today && !date) setDate(today);
  }, [today, date]);
  const [cart, setCart] = useState<Cart>({});
  const [codes, setCodes] = useState<string[]>([]);
  const [promo, setPromo] = useState('');
  const [cust, setCust] = useState({ name: '', phone: '', email: '' });
  const [payMode, setPayMode] = useState<'PAY_NOW' | 'PAY_AT_PARK'>('PAY_NOW');
  const [busy, setBusy] = useState(false);
  const [clientRef] = useState(newKey());
  const cat = useQuery({ queryKey: ['park-catalog', code, date], queryFn: () => parkPublicApi(`/branches/${code}/catalog?date=${date}`, { headers: memberHeaders() }), enabled: !!code && !!date });
  const items = useMemo(
    () => Object.entries(cart).filter(([, q]) => q > 0).map(([k, qty]) => {
      const [packageId, tt] = k.split('|');
      return { packageId, ticketTypeId: tt || null, qty };
    }),
    [cart],
  );
  const quote = useQuery({
    queryKey: ['park-quote', code, date, items, codes],
    queryFn: () => parkPublicApi('/quote', { body: { branchCode: code, visitDate: date, items, codes }, headers: memberHeaders() }),
    enabled: items.length > 0 && !!date,
    retry: false,
  });
  useEffect(() => setCart({}), [date]);
  const setQty = (k: string, q: number) => setCart((c) => ({ ...c, [k]: q }));
  const submit = async () => {
    setBusy(true);
    try {
      const r = await parkPublicApi('/bookings', { body: { branchCode: code, visitDate: date, items, codes, payMode, language: t.lang, customer: { name: cust.name, phone: cust.phone || null, email: cust.email || null }, clientRef }, headers: memberHeaders() });
      saveBooking({ no: r.booking.booking_no, token: r.accessToken, date: date! });
      nav(`/park/booking/${r.booking.booking_no}?t=${r.accessToken}`);
    } catch (e) {
      toast.error(t.err(e));
    } finally {
      setBusy(false);
    }
  };
  const guests = items.reduce((n, i) => n + i.qty, 0);
  return (
    <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 lg:grid-cols-[1fr_380px]">
      <div className="space-y-6">
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-xl font-bold"><CalendarDays className="h-5 w-5 text-primary" /> 1. {t('step1')}</h2>
          {date && today ? <Calendar code={code} today={today} value={date} onChange={setDate} maxDays={b.settings.booking.advanceDays} /> : <Loading />}
        </section>
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-xl font-bold"><Ticket className="h-5 w-5 text-primary" /> 2. {t('step2')}</h2>
          {!storage.get('member_token') && <div className="mb-3 rounded-xl bg-amber-50 px-4 py-2 text-sm text-amber-800"><Link to="/member" className="underline">{t('memberLoginHint')}</Link></div>}
          {!cat.data ? <Loading /> : (
            <div className="space-y-3">
              {cat.data.packages.filter((p: any) => p.kind === 'ADMISSION').map((p: any) => (
                <div key={p.id} className={clsx('rounded-3xl border bg-white p-4', !p.availability.available && 'opacity-60')}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ background: p.color }} /><b className="text-lg">{t.tr(p.name)}</b></div>
                      <div className="text-sm text-slate-600">{t.tr(p.description)}</div>
                    </div>
                    <div className="text-right text-xs">
                      {!p.availability.available ? <span className="font-semibold text-rose-600">{p.availability.reason === 'SOLD_OUT' ? t('soldOut') : t.reason(p.availability.reason) || t('unavailable')}</span>
                        : p.availability.remaining != null && p.availability.remaining < 30 ? <span className="font-semibold text-amber-600">{t('remaining', { n: p.availability.remaining })}</span> : null}
                    </div>
                  </div>
                  {p.availability.available && (
                    <div className="mt-3 divide-y rounded-2xl bg-slate-50">
                      {(p.prices.length ? p.prices : [{ ticket_type_id: null, unit_price: Number(p.base_price), price: Number(p.base_price), ticket_type_name: null }]).map((pr: any) => {
                        const k = `${p.id}|${pr.ticket_type_id ?? ''}`;
                        return (
                          <div key={k} className="flex items-center gap-3 px-4 py-2.5">
                            <div className="flex-1">
                              <div className="font-medium">{pr.ticket_type_name ? t.tr(pr.ticket_type_name) : t.tr(p.name)}</div>
                              {pr.ticket_type_description && <div className="text-xs text-slate-500">{t.tr(pr.ticket_type_description)}</div>}
                            </div>
                            <div className="text-right">
                              <div className="font-bold">{money(pr.unit_price)}</div>
                              {pr.member_priced && <div className="text-[11px] text-slate-400 line-through">{money(pr.price)}</div>}
                            </div>
                            <Stepper value={cart[k] ?? 0} onChange={(v) => setQty(k, v)} max={p.max_qty} />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
        {items.length > 0 && (
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-xl font-bold"><Users className="h-5 w-5 text-primary" /> 3. {t('step3')}</h2>
            <div className="grid gap-3 rounded-3xl border bg-white p-5 sm:grid-cols-2">
              <Field label={t('fullName')} className="sm:col-span-2"><Input value={cust.name} onChange={(e) => setCust({ ...cust, name: e.target.value })} autoComplete="name" /></Field>
              <Field label={t('phone')}><Input value={cust.phone} onChange={(e) => setCust({ ...cust, phone: e.target.value })} inputMode="tel" autoComplete="tel" /></Field>
              <Field label={t('email')}><Input value={cust.email} onChange={(e) => setCust({ ...cust, email: e.target.value })} type="email" autoComplete="email" /></Field>
              <div className="space-y-2 sm:col-span-2">
                <label className={clsx('flex cursor-pointer items-center gap-3 rounded-2xl border-2 p-3', payMode === 'PAY_NOW' ? 'border-primary bg-primary/5' : 'border-slate-200')}>
                  <input type="radio" checked={payMode === 'PAY_NOW'} onChange={() => setPayMode('PAY_NOW')} /> {t('payNow')}
                </label>
                {b.settings.booking.payAtParkEnabled && (
                  <label className={clsx('flex cursor-pointer items-center gap-3 rounded-2xl border-2 p-3', payMode === 'PAY_AT_PARK' ? 'border-primary bg-primary/5' : 'border-slate-200')}>
                    <input type="radio" checked={payMode === 'PAY_AT_PARK'} onChange={() => setPayMode('PAY_AT_PARK')} /> {t('payAtPark')}
                  </label>
                )}
              </div>
            </div>
          </section>
        )}
      </div>
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <div className="rounded-3xl border bg-white p-5 shadow-sm">
          <h3 className="mb-3 font-bold">{t('cart')}</h3>
          <div className="mb-3 flex items-center gap-2 text-sm text-slate-600"><CalendarDays className="h-4 w-4" /> {date ?? '—'} · {t('guests')}: {guests}</div>
          {!items.length ? <div className="py-6 text-center text-sm text-slate-400">—</div> : quote.isError ? (
            <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{t.err(quote.error)}</div>
          ) : !quote.data ? <Loading /> : (
            <div className="space-y-1.5 text-sm">
              {quote.data.lines.map((l: any, i: number) => (
                <div key={i} className="flex justify-between gap-2"><span>{t.tr(l.name)} × {l.qty}</span><span className="tabular-nums">{money(l.basePrice * l.qty)}</span></div>
              ))}
              {quote.data.promotions.map((p: any, i: number) => (
                <div key={`p${i}`} className="flex justify-between gap-2 text-emerald-700"><span>{t.tr(p.name)}</span><span className="tabular-nums">−{money(p.amount)}</span></div>
              ))}
              <div className="flex justify-between border-t pt-2 text-lg font-bold"><span>{t('total')}</span><span className="tabular-nums">{money(quote.data.total)}</span></div>
              <div className="text-right text-xs text-slate-500">{t('vatIncluded')}</div>
            </div>
          )}
          <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (promo.trim()) { setCodes([...new Set([...codes, promo.trim().toUpperCase()])]); setPromo(''); } }}>
            <Input value={promo} onChange={(e) => setPromo(e.target.value)} placeholder={t('promo')} className="uppercase" />
            <Button type="submit" variant="outline">{t('apply')}</Button>
          </form>
          {codes.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {codes.map((c) => <button key={c} onClick={() => setCodes(codes.filter((x) => x !== c))} className={clsx('rounded-full px-2 py-0.5 font-mono text-xs', quote.data?.invalidCodes?.includes(c) ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700')}>{c} ✕</button>)}
            </div>
          )}
          <Button size="lg" className="mt-4 w-full" disabled={!items.length || !cust.name.trim() || !quote.data || quote.data.invalidCodes?.length > 0} loading={busy} onClick={submit}>{t('confirmBooking')}</Button>
        </div>
      </aside>
    </div>
  );
}

function BookingPage() {
  const t = useT(S);
  const b = useBoot();
  const { no = '' } = useParams();
  const [sp] = useSearchParams();
  const token = sp.get('t') || savedBookings().find((x) => x.no === no)?.token || '';
  const qc = useQueryClient();
  const key = ['park-booking', no];
  const q = useQuery({ queryKey: key, queryFn: () => parkPublicApi(`/bookings/${no}`, { headers: { 'X-Booking-Token': token } }), enabled: !!token });
  const { socket } = useRealtime(token ? { bookingNo: no, bookingToken: token } : null);
  useSocketEvent(socket, [EVENTS.BOOKING_UPDATED, EVENTS.SALE_PAID, EVENTS.SALE_UPDATED, EVENTS.TICKET_UPDATED], () => void qc.invalidateQueries({ queryKey: key }));
  useEffect(() => {
    if (q.data) saveBooking({ no, token, date: q.data.booking.visit_date });
  }, [q.data, no, token]);
  if (!token) return <div className="mx-auto max-w-lg p-6"><Empty title={t('noBookings')} /></div>;
  if (q.isError) return <div className="mx-auto max-w-lg p-6"><Empty title={t.err(q.error)} /></div>;
  if (!q.data) return <Loading />;
  const d = q.data;
  const bk = d.booking;
  const hdr = { 'X-Booking-Token': token };
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const online = Object.entries(b.settings.payment.online ?? {}).filter(([, v]) => v).map(([k]) => k).filter((k) => k !== 'WALLET');
  const paidOk = ['CONFIRMED', 'CHECKED_IN', 'COMPLETED'].includes(bk.status);
  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-8">
      <div className="rounded-3xl bg-white p-6 text-center shadow-sm">
        {paidOk && <CheckCircle2 className="mx-auto mb-2 h-12 w-12 text-emerald-500" />}
        <div className="text-sm text-slate-500">{t('bookingNo')}</div>
        <div className="font-mono text-2xl font-extrabold tracking-wider">{bk.booking_no}</div>
        <div className="mt-2 flex justify-center gap-2"><PStatus s={bk.status} /><PStatus s={bk.payment_status} /></div>
        <div className="mt-3 flex flex-wrap justify-center gap-4 text-sm text-slate-600">
          <span className="flex items-center gap-1"><CalendarDays className="h-4 w-4" />{bk.visit_date}</span>
          <span className="flex items-center gap-1"><Users className="h-4 w-4" />{bk.guests}</span>
          <span className="flex items-center gap-1"><MapPin className="h-4 w-4" />{t.tr(bk.branch_name)}</span>
        </div>
        {bk.qr && (
          <div className="mt-5 flex flex-col items-center gap-3">
            <QrCode value={bk.qr} size={220} />
            <Barcode value={bk.barcode} height={50} />
            <p className="max-w-sm text-sm text-slate-600">{t('showAtGate')}</p>
          </div>
        )}
      </div>
      {bk.status === 'PENDING_PAYMENT' && bk.pay_mode === 'PAY_NOW' && (
        <div className="rounded-3xl bg-white p-5 shadow-sm">
          <OnlinePay
            outstanding={bk.outstanding}
            methods={online}
            payments={d.payments}
            verifications={d.verifications}
            accountName={b.settings.payment.qr.accountName}
            allowSlip={b.settings.payment.allowSlipUpload}
            start={async (m) => {
              if (m === '__CHANGE__') {
                const open = d.payments.find((p: any) => ['PENDING', 'WAITING_CARD', 'PROCESSING'].includes(p.status));
                if (open) await parkPublicApi(`/bookings/${no}/payments/${open.id}/cancel`, { method: 'POST', headers: hdr });
              } else await parkPublicApi(`/bookings/${no}/payments`, { body: { method: m }, headers: hdr, idempotencyKey: newKey() });
              await refresh();
            }}
            verify={async (pid, reference) => {
              await parkPublicApi(`/bookings/${no}/payments/${pid}/verify`, { body: { reference }, headers: hdr });
              await refresh();
            }}
            uploadSlip={async (file) => {
              const fd = new FormData();
              fd.append('file', file);
              await parkPublicApi(`/bookings/${no}/slip`, { method: 'POST', body: fd, headers: hdr, timeoutMs: 60000 });
            }}
            simulate={async (pid, outcome) => {
              await parkPublicApi(`/bookings/${no}/payments/${pid}/sandbox`, { body: { outcome }, headers: hdr });
              await refresh();
            }}
          />
        </div>
      )}
      {bk.status === 'RESERVED' && <div className="rounded-2xl bg-sky-50 p-4 text-center text-sky-800">{t('payAtCounter')} · <b>{money(bk.outstanding)}</b></div>}
      <div className="rounded-3xl bg-white p-5 shadow-sm">
        <h3 className="mb-3 font-bold">{t('yourTickets')}</h3>
        {!paidOk && <p className="mb-3 text-sm text-amber-700">{t('ticketsAfterPay')}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          {d.tickets.map((tk: any) => (
            <div key={tk.id} className="rounded-2xl border p-4 text-center">
              <div className="font-semibold">{t.tr(tk.package_name)}</div>
              <div className="text-sm text-slate-500">{t.tr(tk.ticket_type_name)}{tk.guest_name ? ` · ${tk.guest_name}` : ''}</div>
              <div className={clsx('my-3 flex justify-center', tk.status !== 'ACTIVE' && 'opacity-25 blur-[2px]')}><QrCode value={tk.qr} size={160} /></div>
              <div className="font-mono text-xs">{tk.ticket_no}</div>
              <div className="mt-1 flex justify-center gap-1"><PStatus s={tk.status} />{tk.presence !== 'OUTSIDE' && <PStatus s={tk.presence} />}</div>
            </div>
          ))}
        </div>
        <p className="mt-3 flex items-center justify-center gap-1 text-xs text-slate-500"><Download className="h-3 w-3" /> {t('saveTicket')} · {t('saveLink')}</p>
      </div>
      <div className="rounded-3xl bg-white p-5 shadow-sm">
        <div className="space-y-1 text-sm">
          {d.items.map((it: any) => <div key={it.id} className="flex justify-between"><span>{t.tr(it.name)} × {it.qty}</span><span className="tabular-nums">{money(it.line_total)}</span></div>)}
          {Number(bk.discount) > 0 && <div className="flex justify-between text-emerald-700"><span>{t('discount')}</span><span>−{money(bk.discount)}</span></div>}
          <div className="flex justify-between border-t pt-2 text-lg font-bold"><span>{t('total')}</span><span>{money(bk.sale_total)}</span></div>
        </div>
        {['PENDING_PAYMENT', 'RESERVED'].includes(bk.status) && (
          <Button variant="ghost" className="mt-3 text-rose-600" onClick={async () => {
            if (!window.confirm(t('cancelConfirm'))) return;
            try {
              await parkPublicApi(`/bookings/${no}/cancel`, { method: 'POST', headers: hdr });
              await refresh();
            } catch (e) { toast.error(t.err(e)); }
          }}>{t('cancelBooking')}</Button>
        )}
      </div>
    </div>
  );
}

function Live() {
  const t = useT(S);
  const code = useBranchCode();
  const qc = useQueryClient();
  const live = useQuery({ queryKey: ['park-live', code], queryFn: () => parkPublicApi(`/branches/${code}/live`), refetchInterval: 30_000 });
  const { socket } = useRealtime(code ? { display: 'park', branchCode: code } : null);
  useSocketEvent(socket, [EVENTS.RIDE_UPDATED, EVENTS.RIDE_QUEUE_UPDATED, EVENTS.OCCUPANCY_UPDATED], () => void qc.invalidateQueries({ queryKey: ['park-live', code] }));
  if (!live.data) return <Loading />;
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-5 flex items-center gap-3 rounded-3xl bg-white p-5 shadow-sm">
        <Gauge className="h-8 w-8 text-primary" />
        <div className="flex-1">
          <div className="text-sm text-slate-500">{t('crowd')}</div>
          <div className="text-2xl font-bold">{t(live.data.occupancy.level)}</div>
        </div>
        <div className="h-3 w-40 overflow-hidden rounded-full bg-slate-100"><div className={clsx('h-full', live.data.occupancy.pct >= 90 ? 'bg-rose-500' : live.data.occupancy.pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${Math.min(100, live.data.occupancy.pct)}%` }} /></div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {live.data.rides.map((r: any) => (
          <div key={r.id} className="overflow-hidden rounded-3xl border bg-white shadow-sm">
            {r.image_url && <SafeImg src={r.image_url} className="h-32 w-full object-cover" />}
            <div className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-bold">{t.tr(r.name)}</div>
                  <div className="text-xs text-slate-500">{t.tr(r.zone_name)}</div>
                </div>
                <PStatus s={r.status} />
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span className="flex items-center gap-1 text-lg font-bold"><Timer className="h-5 w-5 text-primary" />{r.status === 'OPEN' ? t('wait', { n: r.wait_minutes ?? 0 }) : t('closedNow')}</span>
                <span className="text-xs text-slate-500">{r.min_height ? t('heightMin', { n: r.min_height }) : ''}</span>
              </div>
              {r.addon_price != null && <div className="mt-1 text-xs text-slate-500">{t('addonPrice', { p: money(r.addon_price) })}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MyBookings() {
  const t = useT(S);
  const list = savedBookings();
  const nav = useNavigate();
  const [no, setNo] = useState('');
  const [tok, setTok] = useState('');
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-8">
      {!list.length ? <Empty title={t('noBookings')} /> : list.map((b) => (
        <Link key={b.no} to={`/park/booking/${b.no}?t=${b.token}`} className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-sm">
          <span className="font-mono font-bold">{b.no}</span>
          <span className="text-sm text-slate-500">{b.date}</span>
        </Link>
      ))}
      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="mb-2 font-semibold">{t('findBooking')}</div>
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input value={no} onChange={(e) => setNo(e.target.value.toUpperCase())} placeholder={t('bookingNo')} />
          <Input value={tok} onChange={(e) => setTok(e.target.value)} placeholder={t('accessCode')} />
          <Button onClick={() => nav(`/park/booking/${no}?t=${tok}`)} disabled={!no || !tok}>{t('search')}</Button>
        </div>
      </div>
    </div>
  );
}
