import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Bell, CalendarDays, CheckCheck, CreditCard, FileSpreadsheet, Gauge, Printer, RefreshCcw, ShieldAlert, ShoppingBag, Ticket, TrendingUp, Users, UtensilsCrossed, Wallet } from 'lucide-react';
import { EVENTS, tr } from '@kiosk/shared';
import { downloadStaff, parkApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateOnly, dateTime, money } from '../../lib/format';
import { defineStrings, useT } from '../../lib/lang';
import { useSocketEvent } from '../../lib/socket';
import { Badge, Button, Card, Empty, Field, Input, Loading, Modal, NumberInput, PageHeader, Select, Stat, Table, Tabs, Td, toast, withManagerApproval } from '../../components/ui';
import { useStaffRt } from '../../components/StaffShell';
import { BookingsTab } from '../../counter/BookingsTab';
import { CardsTab } from '../../counter/CardsTab';
import { VerifyTab } from '../../counter/VerifyTab';
import { PStatus, TierBadge } from '../../park/ui';
import { SimpleBars } from '../charts';

const O = defineStrings('parkops', {
  dashboard: { th: 'แดชบอร์ดสวนสนุก', en: 'Park dashboard', zh: '乐园仪表盘' },
  live: { th: 'ข้อมูลสด', en: 'Live', zh: '实时' },
  visitors: { th: 'ผู้เข้าชมวันนี้', en: 'Visitors today', zh: '今日游客' },
  inside: { th: 'อยู่ในสวนตอนนี้', en: 'Inside now', zh: '园内人数' },
  revenue: { th: 'รายได้รวมวันนี้', en: 'Revenue today', zh: '今日总收入' },
  ticketSales: { th: 'ขายบัตร', en: 'Ticket sales', zh: '门票销售' },
  foodSales: { th: 'ขายอาหาร', en: 'Food sales', zh: '餐饮销售' },
  retailSales: { th: 'ขายสินค้า', en: 'Retail sales', zh: '零售销售' },
  topups: { th: 'เติมเงิน', en: 'Wallet top-ups', zh: '钱包充值' },
  memberships: { th: 'สมาชิก', en: 'Memberships', zh: '会员销售' },
  rideAddons: { th: 'ซื้อเครื่องเล่นเพิ่ม', en: 'Ride add-ons', zh: '游乐加购' },
  lockers: { th: 'ล็อกเกอร์', en: 'Lockers', zh: '储物柜' },
  refunds: { th: 'คืนเงิน', en: 'Refunds', zh: '退款' },
  hourly: { th: 'ผู้เข้าชมรายชั่วโมง', en: 'Visitors by hour', zh: '每小时游客' },
  revenueHour: { th: 'รายได้รายชั่วโมง', en: 'Revenue by hour', zh: '每小时收入' },
  byType: { th: 'ยอดขายตามประเภทตั๋ว', en: 'Sales by ticket type', zh: '按票种销售' },
  byStore: { th: 'ยอดขายตามร้าน / ช่องทาง', en: 'Sales by store / channel', zh: '按门店/渠道销售' },
  rideUsage: { th: 'การใช้เครื่องเล่น', en: 'Ride usage', zh: '设施使用' },
  queueTimes: { th: 'เวลารอคิว (นาที)', en: 'Queue wait (min)', zh: '排队时长（分钟）' },
  gateTraffic: { th: 'การผ่านประตู', en: 'Gate traffic', zh: '闸门通行' },
  capacity: { th: 'ความจุ', en: 'Capacity', zh: '容量' },
  map: { th: 'แผนที่สด', en: 'Live park map', zh: '实时地图' },
  NORMAL: { th: 'ปกติ', en: 'Normal', zh: '正常' },
  BUSY: { th: 'หนาแน่น', en: 'Busy', zh: '拥挤' },
  CROWDED: { th: 'แออัด', en: 'Crowded', zh: '非常拥挤' },
  CLOSED: { th: 'ปิด', en: 'Closed', zh: '关闭' },
  guests: { th: 'คน', en: 'guests', zh: '人' },
  wait: { th: 'รอ {n} นาที', en: '{n} min', zh: '{n}分钟' },
  bookings: { th: 'การจอง', en: 'Bookings', zh: '预订' },
  calendar: { th: 'ปฏิทินการจอง', en: 'Booking calendar', zh: '预订日历' },
  members: { th: 'สมาชิก', en: 'Members', zh: '会员' },
  search: { th: 'ค้นหา', en: 'Search', zh: '搜索' },
  points: { th: 'คะแนน', en: 'Points', zh: '积分' },
  adjustPoints: { th: 'ปรับคะแนน', en: 'Adjust points', zh: '调整积分' },
  cards: { th: 'บัตร / ริสแบนด์', en: 'Cards & wristbands', zh: '卡/腕带' },
  transactions: { th: 'ศูนย์รายการธุรกรรม', en: 'Transaction center', zh: '交易中心' },
  refund: { th: 'คืนเงิน / ยกเลิก', en: 'Refund / void', zh: '退款/作废' },
  refundAmount: { th: 'จำนวนเงิน (ว่าง = ทั้งหมด)', en: 'Amount (empty = full)', zh: '金额（空=全额）' },
  refundMethod: { th: 'คืนเงินทาง', en: 'Refund to', zh: '退款方式' },
  voidSale: { th: 'ยกเลิกบิล (Void)', en: 'Void sale', zh: '作废' },
  shifts: { th: 'กะการทำงาน', en: 'Shifts', zh: '班次' },
  inventory: { th: 'สต็อกสินค้า', en: 'Inventory', zh: '库存' },
  lowStock: { th: 'ใกล้หมด', en: 'Low stock', zh: '库存不足' },
  operation: { th: 'ปรับสต็อก', en: 'Stock operation', zh: '库存操作' },
  transfer: { th: 'โอนระหว่างร้าน', en: 'Transfer', zh: '调拨' },
  movements: { th: 'ความเคลื่อนไหว', en: 'Movements', zh: '库存流水' },
  notifications: { th: 'การแจ้งเตือน', en: 'Notifications', zh: '通知' },
  markAll: { th: 'อ่านทั้งหมด', en: 'Mark all read', zh: '全部已读' },
  security: { th: 'เหตุการณ์ความปลอดภัย', en: 'Security events', zh: '安全事件' },
  ack: { th: 'รับทราบ', en: 'Acknowledge', zh: '确认' },
  approvals: { th: 'การอนุมัติโดยผู้จัดการ', en: 'Manager approvals', zh: '经理审批' },
  reports: { th: 'รายงานสวนสนุก', en: 'Park reports', zh: '乐园报表' },
  pdf: { th: 'พิมพ์ / PDF', en: 'Print / PDF', zh: '打印 / PDF' },
  verify: { th: 'ตรวจสอบการชำระเงิน', en: 'Payment verification', zh: '付款核对' },
  consolidated: { th: 'ภาพรวมทุกสาขา', en: 'All branches', zh: '全部分店' },
  entryLog: { th: 'บันทึกการเข้า-ออก', en: 'Entry log', zh: '出入记录' },
  store: { th: 'ร้าน', en: 'Store', zh: '门店' },
  product: { th: 'สินค้า', en: 'Product', zh: '商品' },
  onHand: { th: 'คงเหลือ', en: 'On hand', zh: '库存' },
  min: { th: 'ขั้นต่ำ', en: 'Minimum', zh: '最低' },
  to: { th: 'ไปยัง', en: 'To', zh: '至' },
});

// ------------------------------------------------------------------ dashboard
export function ParkDashboard() {
  const t = useT(O);
  const { socket } = useStaffRt();
  const qc = useQueryClient();
  const [all, setAll] = useState(false);
  const q = useQuery({ queryKey: ['park-dashboard'], queryFn: () => parkApi('/dashboard'), refetchInterval: 60_000 });
  const cons = useQuery({ queryKey: ['park-dashboard-all'], queryFn: () => parkApi('/dashboard/consolidated'), enabled: all });
  useSocketEvent(socket, [EVENTS.DASHBOARD_TICK, EVENTS.OCCUPANCY_UPDATED, EVENTS.SALE_PAID], () => void qc.invalidateQueries({ queryKey: ['park-dashboard'] }));
  if (!q.data) return <Loading />;
  const k = q.data.kpis;
  const c = q.data.charts;
  const occ = q.data.occupancy;
  const hours = c.hours.filter((h: any) => h.visitors > 0 || h.revenue > 0 || (h.hour >= 9 && h.hour <= 21)).map((h: any) => ({ ...h, label: `${String(h.hour).padStart(2, '0')}` }));
  const named = (rows: any[], key = 'name') => rows.map((r) => ({ ...r, label: tr(r[key], t.lang, r.code ?? '') }));
  return (
    <div>
      <PageHeader title={t('dashboard')} sub={`${q.data.date} · ${t('live')}`} actions={<Tabs value={all ? 'all' : 'branch'} onChange={(v) => setAll(v === 'all')} tabs={[{ id: 'branch', label: t('branch') }, { id: 'all', label: t('consolidated') }]} />} />
      {all ? (
        !cons.data ? <Loading /> : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label={t('visitors')} value={cons.data.totals.todayVisitors} icon={<Users className="h-5 w-5" />} tone="blue" />
              <Stat label={t('inside')} value={cons.data.totals.currentInside} icon={<Gauge className="h-5 w-5" />} tone="amber" />
              <Stat label={t('revenue')} value={money(cons.data.totals.totalRevenue)} icon={<TrendingUp className="h-5 w-5" />} tone="green" />
              <Stat label={t('ticketSales')} value={money(cons.data.totals.ticketSales)} icon={<Ticket className="h-5 w-5" />} />
            </div>
            <Card padded={false}>
              <Table head={[t('branch'), t('visitors'), t('inside'), t('ticketSales'), t('foodSales'), t('retailSales'), t('revenue')]}>
                {cons.data.branches.map((b: any) => (
                  <tr key={b.id}><Td className="font-semibold">{b.code} · {tr(b.name, t.lang)}</Td><Td>{b.kpis.todayVisitors}</Td><Td>{b.kpis.currentInside}</Td><Td>{money(b.kpis.ticketSales)}</Td><Td>{money(b.kpis.foodSales)}</Td><Td>{money(b.kpis.retailSales)}</Td><Td className="font-bold">{money(b.kpis.totalRevenue)}</Td></tr>
                ))}
              </Table>
            </Card>
          </div>
        )
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label={t('visitors')} value={k.todayVisitors} icon={<Users className="h-5 w-5" />} tone="blue" />
            <Stat label={t('inside')} value={`${k.currentInside} / ${occ.capacity}`} sub={`${occ.pct}%`} icon={<Gauge className="h-5 w-5" />} tone={occ.pct >= 90 ? 'rose' : occ.pct >= 80 ? 'amber' : 'slate'} />
            <Stat label={t('revenue')} value={money(k.totalRevenue)} icon={<TrendingUp className="h-5 w-5" />} tone="green" sub={k.refunds ? `${t('refunds')} ${money(k.refunds)}` : undefined} />
            <Stat label={t('ticketSales')} value={money(k.ticketSales)} icon={<Ticket className="h-5 w-5" />} tone="violet" />
            <Stat label={t('foodSales')} value={money(k.foodSales)} sub={`${k.foodOrders}`} icon={<UtensilsCrossed className="h-5 w-5" />} />
            <Stat label={t('retailSales')} value={money(k.retailSales)} icon={<ShoppingBag className="h-5 w-5" />} />
            <Stat label={t('topups')} value={money(k.walletTopup)} icon={<Wallet className="h-5 w-5" />} />
            <Stat label={`${t('memberships')} · ${t('rideAddons')} · ${t('lockers')}`} value={<span className="text-base">{money(k.membershipSales)} · {money(k.rideAddons)} · {money(k.lockerSales)}</span>} icon={<CreditCard className="h-5 w-5" />} />
          </div>
          <div className="mt-5 grid gap-5 xl:grid-cols-2">
            <Card title={t('hourly')}><SimpleBars data={hours} x="label" y="visitors" isMoney={false} label={t('visitors')} /></Card>
            <Card title={t('revenueHour')}><SimpleBars data={hours} x="label" y="revenue" label={t('revenue')} /></Card>
            <Card title={t('byType')}>{c.ticketTypes.length ? <SimpleBars data={named(c.ticketTypes)} x="label" y="amount" horizontal height={Math.max(160, c.ticketTypes.length * 36)} /> : <Empty />}</Card>
            <Card title={t('byStore')}>{c.byStore.length ? <SimpleBars data={named(c.byStore)} x="label" y="amount" horizontal height={Math.max(160, c.byStore.length * 36)} /> : <Empty />}</Card>
            <Card title={t('rideUsage')}><SimpleBars data={named(c.rideUsage)} x="label" y="rides" horizontal isMoney={false} height={Math.max(160, c.rideUsage.length * 32)} label={t('rides')} /></Card>
            <Card title={t('queueTimes')}>{c.queueTimes.length ? <SimpleBars data={named(c.queueTimes)} x="label" y="wait" horizontal isMoney={false} height={Math.max(120, c.queueTimes.length * 40)} label={t('minutes')} /> : <Empty />}</Card>
          </div>
          <Card title={t('gateTraffic')} className="mt-5" padded={false}>
            <Table head={[t('gate'), t.x({ th: 'อนุญาต', en: 'Approved', zh: '通过' }), t.x({ th: 'ปฏิเสธ', en: 'Denied', zh: '拒绝' }), t.x({ th: 'ซ้ำ', en: 'Duplicate', zh: '重复' })]}>
              {c.gateTraffic.map((g: any) => <tr key={g.code}><Td className="font-semibold">{g.number} · {g.code}</Td><Td className="text-emerald-700">{g.approved}</Td><Td className="text-rose-700">{g.denied}</Td><Td className="text-amber-700">{g.duplicate}</Td></tr>)}
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ live map
const LEVEL: Record<string, string> = { NORMAL: '#22c55e', BUSY: '#f59e0b', CROWDED: '#ef4444', CLOSED: '#64748b' };
export function LiveMap() {
  const t = useT(O);
  const { socket } = useStaffRt();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['park-map'], queryFn: () => parkApi('/map'), refetchInterval: 30_000 });
  useSocketEvent(socket, [EVENTS.OCCUPANCY_UPDATED, EVENTS.RIDE_UPDATED, EVENTS.RIDE_QUEUE_UPDATED, EVENTS.RIDE_SCAN], () => void qc.invalidateQueries({ queryKey: ['park-map'] }));
  if (!q.data) return <Loading />;
  const d = q.data;
  return (
    <div>
      <PageHeader title={t('map')} sub={`${t('inside')} ${d.occupancy.inside} / ${d.occupancy.capacity} · ${d.occupancy.pct}%`} actions={<div className="flex gap-2 text-xs">{['NORMAL', 'BUSY', 'CROWDED', 'CLOSED'].map((l) => <span key={l} className="flex items-center gap-1"><span className="h-3 w-3 rounded-full" style={{ background: LEVEL[l] }} />{t(l as any)}</span>)}</div>} />
      <div className="relative aspect-[16/10] w-full overflow-hidden rounded-3xl border bg-gradient-to-br from-emerald-50 to-sky-50 shadow-inner">
        {d.zones.map((z: any) => (
          <div key={z.id} className="absolute flex flex-col items-start justify-between rounded-2xl border-2 p-2 text-xs" style={{ left: `${z.map?.x ?? 0}%`, top: `${z.map?.y ?? 0}%`, width: `${z.map?.w ?? 10}%`, height: `${z.map?.h ?? 10}%`, borderColor: LEVEL[z.level] ?? z.color, background: `${z.color}22` }}>
            <b className="text-slate-800">{tr(z.name, t.lang, z.code)}</b>
            <span className="rounded-full px-2 py-0.5 font-semibold text-white" style={{ background: LEVEL[z.level] }}>{z.guests}{z.capacity ? ` / ${z.capacity}` : ''} {t('guests')}</span>
          </div>
        ))}
        {d.rides.map((r: any) => (
          <div key={r.id} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${r.map?.x ?? 50}%`, top: `${r.map?.y ?? 50}%` }}>
            <div className="flex items-center gap-1 rounded-full border-2 bg-white px-2 py-1 text-[11px] font-semibold shadow" style={{ borderColor: LEVEL[r.level] }}>
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: LEVEL[r.level] }} />
              {tr(r.name, t.lang, r.code)}
              {r.status === 'OPEN' ? <span className="text-slate-500">· {t('wait', { n: r.wait_minutes })}</span> : <span className="text-slate-500">· {t.status(r.status)}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ bookings (+ calendar), cards, verification
export function BookingsAdmin() {
  const t = useT(O);
  const [tab, setTab] = useState<'list' | 'calendar'>('list');
  const [month, setMonth] = useState(dateOnly(new Date()).slice(0, 7));
  const cal = useQuery({ queryKey: ['booking-calendar', month], queryFn: () => parkApi(`/bookings/calendar?month=${month}`), enabled: tab === 'calendar' });
  return (
    <div>
      <PageHeader title={t('bookings')} actions={<Tabs value={tab} onChange={setTab} tabs={[{ id: 'list', label: t('bookings') }, { id: 'calendar', label: t('calendar') }]} />} />
      {tab === 'list' ? <div className="-m-3"><BookingsTab /></div> : (
        <Card title={<span className="flex items-center gap-2"><CalendarDays className="h-4 w-4" />{t('calendar')}</span>} actions={<Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" />}>
          {!cal.data ? <Loading /> : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {cal.data.days.map((d: any) => (
                <div key={d.date} className="rounded-xl border p-2 text-sm">
                  <div className="flex justify-between font-semibold"><span>{d.date.slice(8)}</span><span className={clsx(d.pct >= 90 ? 'text-rose-600' : d.pct >= 70 ? 'text-amber-600' : 'text-emerald-600')}>{d.pct}%</span></div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className={clsx('h-full', d.pct >= 90 ? 'bg-rose-500' : d.pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${Math.min(100, d.pct)}%` }} /></div>
                  <div className="mt-1 text-xs text-slate-500">{d.bookings ?? d.count ?? 0} · {d.guests} {t('guests')}</div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 text-xs text-slate-500">{t('capacity')}: {cal.data?.capacity}</div>
        </Card>
      )}
    </div>
  );
}
export function CardsAdmin() {
  const t = useT(O);
  return <div><PageHeader title={t('cards')} /><div className="-m-3"><CardsTab /></div></div>;
}
export function VerifyAdmin() {
  const t = useT(O);
  return <div><PageHeader title={t('verify')} /><div className="-m-3"><VerifyTab /></div></div>;
}

// ------------------------------------------------------------------ members
export function Members() {
  const t = useT(O);
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['members', q], queryFn: () => parkApi(`/members?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`) });
  return (
    <div>
      <PageHeader title={t('members')} actions={<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} className="w-72" />} />
      <Card padded={false}>
        {!list.data ? <Loading /> : !list.data.length ? <Empty /> : (
          <Table head={[t('member'), t('phone'), t.x({ th: 'ระดับ', en: 'Tier', zh: '等级' }), t('points'), t('balance'), t.x({ th: 'หมดอายุ', en: 'Expires', zh: '到期' }), t('status')]}>
            {list.data.map((m: any) => (
              <tr key={m.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setSel(m.id)}>
                <Td><div className="font-medium">{m.first_name} {m.last_name}</div><div className="font-mono text-xs text-slate-500">{m.member_no}</div></Td>
                <Td>{m.phone}</Td>
                <Td><TierBadge tier={{ name: m.tier_name, color: m.tier_color }} /></Td>
                <Td>{Number(m.points).toLocaleString()}</Td>
                <Td>{money(m.balance ?? 0)}</Td>
                <Td className="text-xs">{m.membership_end ?? '—'}</Td>
                <Td><PStatus s={m.status} /></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {sel && <MemberDetail id={sel} onClose={() => setSel(null)} canPoints={can('members.points')} />}
    </div>
  );
}

function MemberDetail({ id, onClose, canPoints }: { id: string; onClose: () => void; canPoints: boolean }) {
  const t = useT(O);
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ['member', id], queryFn: () => parkApi(`/members/${id}`) });
  const h = useQuery({ queryKey: ['member', id, 'history'], queryFn: () => parkApi(`/members/${id}/history`) });
  const [pts, setPts] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const m = d.data?.member;
  return (
    <Modal open onClose={onClose} size="xl" title={m ? `${m.first_name} ${m.last_name} · ${m.member_no}` : ''}>
      {!m ? <Loading /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="rounded-2xl p-4 text-white" style={{ background: m.tier_color || '#334155' }}>
              <div className="text-lg font-bold">{tr(m.tier_name, t.lang)}</div>
              <div>{m.phone} · {m.email ?? ''}</div>
              <div className="mt-2 flex gap-4 text-sm"><span>{t('points')}: <b>{Number(m.points).toLocaleString()}</b></span><span>{t('balance')}: <b>{money(m.wallet_balance ?? 0)}</b></span></div>
              {d.data.membership && <div className="mt-1 text-sm">{tr(d.data.membership.product_name, t.lang)} → {d.data.membership.end_date ?? '∞'}</div>}
            </div>
            <div className="flex flex-wrap gap-1.5">{d.data.cards.map((c: any) => <Badge key={c.id}>{c.code} · {c.type.replace(/_/g, ' ')} · {t.status(c.status)}</Badge>)}</div>
            {canPoints && (
              <div className="flex flex-wrap items-end gap-2 rounded-xl border p-3">
                <Field label={t('adjustPoints')}><NumberInput value={pts} onChange={setPts} /></Field>
                <Field label={t('reason')}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                <Button disabled={!pts || reason.length < 3} onClick={async () => {
                  try {
                    await withManagerApproval(t('adjustPoints'), (a) => parkApi(`/members/${id}/points`, { body: { points: pts, reason, ...a } }));
                    setPts(null); setReason('');
                    void qc.invalidateQueries({ queryKey: ['member', id] });
                  } catch (e) { toast.error(t.err(e)); }
                }}>{t('save')}</Button>
              </div>
            )}
            <Button variant="outline" onClick={() => parkApi(`/members/${id}/logout-all`, { method: 'POST' }).then(() => toast.success(t('done'))).catch((e) => toast.error(t.err(e)))}>{t.x({ th: 'บังคับออกจากระบบทุกอุปกรณ์', en: 'Log out all devices', zh: '强制退出所有设备' })}</Button>
          </div>
          <div className="scroll-thin max-h-[65vh] space-y-1 overflow-y-auto text-xs">
            {!h.data ? <Loading /> : Object.entries(h.data).flatMap(([k, rows]: any) => (Array.isArray(rows) ? rows.slice(0, 30).map((r: any, i: number) => (
              <div key={`${k}-${i}`} className="flex justify-between gap-2 rounded-lg bg-slate-50 px-2 py-1.5">
                <span className="font-semibold text-slate-500">{k}</span>
                <span className="min-w-0 flex-1 truncate">{r.sale_no ?? r.txn_no ?? r.ticket_no ?? (r.ride_name ? tr(r.ride_name, t.lang) : r.product_name ? tr(r.product_name, t.lang) : r.type ?? r.ip ?? '')} {r.reference ?? ''}</span>
                <span>{r.total != null ? money(r.total) : r.points ?? (r.credit != null ? money(Number(r.credit) - Number(r.debit)) : '')}</span>
                <span className="text-slate-400">{dateTime(r.created_at)}</span>
              </div>
            )) : []))}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ transactions + refunds
export function Transactions() {
  const t = useT(O);
  const { can } = useAuth();
  const today = dateOnly(new Date());
  const [f, setF] = useState({ q: '', type: '', method: '', from: today, to: today });
  const params = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]);
  const q = useQuery({ queryKey: ['transactions', params.toString()], queryFn: () => parkApi(`/transactions?${params}`) });
  const [refund, setRefund] = useState<any>(null);
  const total = useMemo(() => (q.data ?? []).filter((r: any) => ['PAID', 'POSTED'].includes(r.status)).reduce((s: number, r: any) => s + Number(r.amount), 0), [q.data]);
  return (
    <div>
      <PageHeader title={t('transactions')} sub={`${(q.data ?? []).length} · ${money(total)}`} />
      <Card className="mb-3">
        <div className="grid gap-2 sm:grid-cols-5">
          <Input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder={t('search')} />
          <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="">{t('type')}: {t('all')}</option>{['TICKET', 'TOPUP', 'MEMBERSHIP', 'RETAIL', 'FOOD', 'LOCKER', 'RIDE_ADDON', 'REFUND'].map((x) => <option key={x}>{x}</option>)}</Select>
          <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="">{t('paymentMethod')}: {t('all')}</option>{['CASH', 'CARD', 'PROMPTPAY', 'WALLET', 'BANK_TRANSFER', 'POINTS', 'QR'].map((x) => <option key={x} value={x}>{t.method(x)}</option>)}</Select>
          <Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          <Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </div>
      </Card>
      <Card padded={false}>
        {!q.data ? <Loading /> : !q.data.length ? <Empty /> : (
          <Table head={[t('time'), 'Txn', t('type'), t('details'), t('paymentMethod'), t('amount'), t('staff'), t('status'), '']}>
            {q.data.map((r: any) => (
              <tr key={`${r.module}-${r.id}`}>
                <Td className="text-xs whitespace-nowrap">{dateTime(r.at)}</Td>
                <Td className="font-mono text-xs">{r.txn_no}</Td>
                <Td><Badge>{r.module} · {r.type}</Badge></Td>
                <Td className="max-w-64 truncate text-xs">{r.reference} {r.booking_no ?? ''} {r.customer_name ?? ''} {r.member_no ?? ''}</Td>
                <Td className="text-xs">{t.method(r.method)}</Td>
                <Td className={clsx('font-semibold tabular-nums', Number(r.amount) < 0 && 'text-rose-700')}>{money(r.amount)}</Td>
                <Td className="text-xs">{r.staff_name ?? '—'}</Td>
                <Td><PStatus s={r.status} /></Td>
                <Td>{r.module === 'PARK' && r.sale_id && r.status === 'PAID' && can('payments.refund') && <Button size="sm" variant="ghost" onClick={() => setRefund(r)}>{t('refund')}</Button>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {refund && <RefundDialog row={refund} onClose={() => setRefund(null)} onDone={() => { setRefund(null); void q.refetch(); }} />}
    </div>
  );
}

function RefundDialog({ row, onClose, onDone }: { row: any; onClose: () => void; onDone: () => void }) {
  const t = useT(O);
  const { can } = useAuth();
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<'ORIGINAL' | 'CASH' | 'WALLET'>('ORIGINAL');
  const [busy, setBusy] = useState(false);
  const go = async (isVoid: boolean) => {
    setBusy(true);
    try {
      const r = await withManagerApproval(isVoid ? t('voidSale') : t('refund'), (a) => parkApi(`/sales/${row.sale_id}/refund`, { body: { amount, reason, refundMethod: method, void: isVoid, ...a } }));
      if (r) {
        toast.success(`${t('refund')} ${money(r.amount)}`);
        onDone();
      }
    } catch (e) { toast.error(t.err(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`${t('refund')} · ${row.reference}`} size="md" footer={<>{can('sales.void') && <Button variant="outline" loading={busy} disabled={reason.length < 1} onClick={() => go(true)}>{t('voidSale')}</Button>}<Button variant="danger" loading={busy} disabled={reason.length < 1} onClick={() => go(false)}>{t('refund')}</Button></>}>
      <div className="space-y-3">
        <div className="text-sm">{t('amount')}: <b>{money(row.amount)}</b> · {t.method(row.method)}</div>
        <Field label={t('refundAmount')}><NumberInput value={amount} onChange={setAmount} min={0} /></Field>
        <Field label={t('refundMethod')}><Select value={method} onChange={(e) => setMethod(e.target.value as any)}><option value="ORIGINAL">{t.x({ th: 'ช่องทางเดิม', en: 'Original method', zh: '原支付方式' })}</option><option value="CASH">{t.method('CASH')}</option><option value="WALLET">{t.method('WALLET')}</option></Select></Field>
        <Field label={t('reason')}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ shifts
export function ShiftsAdmin() {
  const t = useT(O);
  const q = useQuery({ queryKey: ['shifts-admin'], queryFn: () => parkApi('/shifts') });
  return (
    <div>
      <PageHeader title={t('shifts')} />
      <Card padded={false}>
        {!q.data ? <Loading /> : !q.data.length ? <Empty /> : (
          <Table head={[t('staff'), t.x({ th: 'จุด', en: 'Terminal', zh: '终端' }), t.x({ th: 'เปิด', en: 'Opened', zh: '开班' }), t.x({ th: 'ปิด', en: 'Closed', zh: '交班' }), t.x({ th: 'ควรมี', en: 'Expected', zh: '应有' }), t.x({ th: 'นับได้', en: 'Counted', zh: '实点' }), t.x({ th: 'ขาด/เกิน', en: 'Over / short', zh: '长短款' }), t('status')]}>
            {q.data.map((s: any) => (
              <tr key={s.id}>
                <Td className="font-medium">{s.user_name}</Td>
                <Td>{s.terminal}{s.store_name ? ` · ${tr(s.store_name, t.lang)}` : ''}</Td>
                <Td className="text-xs">{dateTime(s.opened_at)}</Td>
                <Td className="text-xs">{s.closed_at ? dateTime(s.closed_at) : '—'}</Td>
                <Td>{s.expected_cash != null ? money(s.expected_cash) : '—'}</Td>
                <Td>{s.actual_cash != null ? money(s.actual_cash) : '—'}</Td>
                <Td className={clsx('font-semibold', Number(s.over_short) < 0 ? 'text-rose-700' : Number(s.over_short) > 0 ? 'text-amber-700' : '')}>{s.over_short != null ? money(s.over_short) : '—'}</Td>
                <Td><PStatus s={s.status} /></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ inventory
export function Inventory() {
  const t = useT(O);
  const { can } = useAuth();
  const qc = useQueryClient();
  const stores = useQuery({ queryKey: ['opt', 'stores-inv'], queryFn: () => parkApi('/admin/stores') });
  const [storeId, setStoreId] = useState('');
  const [low, setLow] = useState(false);
  const [tab, setTab] = useState<'stock' | 'moves'>('stock');
  const inv = useQuery({ queryKey: ['inventory', storeId, low], queryFn: () => parkApi(`/inventory?${new URLSearchParams({ ...(storeId ? { storeId } : {}), ...(low ? { low: 'true' } : {}) })}`) });
  const moves = useQuery({ queryKey: ['inventory-moves', storeId], queryFn: () => parkApi(`/inventory/movements${storeId ? `?storeId=${storeId}` : ''}`), enabled: tab === 'moves' });
  const [op, setOp] = useState<any>(null);
  const [xfer, setXfer] = useState<any>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['inventory'] });
    void qc.invalidateQueries({ queryKey: ['inventory-moves'] });
  };
  return (
    <div>
      <PageHeader title={t('inventory')} actions={<>
        <Select value={storeId} onChange={(e) => setStoreId(e.target.value)} className="w-56"><option value="">{t('store')}: {t('all')}</option>{(stores.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.code} · {tr(s.name, t.lang)}</option>)}</Select>
        <Button variant={low ? 'primary' : 'outline'} onClick={() => setLow((x) => !x)}>{t('lowStock')}</Button>
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'stock', label: t('inventory') }, { id: 'moves', label: t('movements') }]} />
      </>} />
      <Card padded={false}>
        {tab === 'stock' ? (!inv.data ? <Loading /> : !inv.data.length ? <Empty /> : (
          <Table head={[t('store'), 'SKU', t('product'), t('onHand'), t('min'), '']}>
            {inv.data.map((r: any) => (
              <tr key={`${r.store_id}-${r.product_id}`} className={Number(r.min_qty) > 0 && Number(r.qty) <= Number(r.min_qty) ? 'bg-amber-50' : ''}>
                <Td className="text-xs">{r.store_code}</Td>
                <Td className="font-mono text-xs">{r.sku}</Td>
                <Td>{tr(r.name, t.lang, r.sku)}</Td>
                <Td className="font-bold tabular-nums">{Number(r.qty)}</Td>
                <Td className="tabular-nums">{Number(r.min_qty)}</Td>
                <Td className="text-right whitespace-nowrap">{can('inventory.manage') && <><Button size="sm" variant="outline" onClick={() => setOp({ storeId: r.store_id, productId: r.product_id, name: tr(r.name, t.lang, r.sku), type: 'IN', qty: null, minQty: Number(r.min_qty), note: '' })}>{t('operation')}</Button><Button size="sm" variant="ghost" onClick={() => setXfer({ fromStoreId: r.store_id, toStoreId: '', productId: r.product_id, name: tr(r.name, t.lang, r.sku), qty: null })}>{t('transfer')}</Button></>}</Td>
              </tr>
            ))}
          </Table>
        )) : (!moves.data ? <Loading /> : (
          <Table head={[t('time'), t('store'), 'SKU', t('type'), t('qty'), t('note'), t('staff')]}>
            {moves.data.map((m: any) => <tr key={m.id}><Td className="text-xs">{dateTime(m.created_at)}</Td><Td className="text-xs">{m.store_code}</Td><Td className="font-mono text-xs">{m.sku}</Td><Td><Badge>{m.type}</Badge></Td><Td className={clsx('tabular-nums', Number(m.qty) < 0 && 'text-rose-700')}>{Number(m.qty)}</Td><Td className="text-xs">{m.note ?? m.reference ?? ''}</Td><Td className="text-xs">{m.user_name ?? ''}</Td></tr>)}
          </Table>
        ))}
      </Card>
      {op && (
        <Modal open onClose={() => setOp(null)} title={`${t('operation')} · ${op.name}`} size="md" footer={<Button disabled={op.qty == null} onClick={async () => {
          try {
            await parkApi('/inventory/operation', { body: { storeId: op.storeId, productId: op.productId, type: op.type, qty: op.qty, note: op.note || null, minQty: op.minQty } });
            setOp(null); refresh();
          } catch (e) { toast.error(t.err(e)); }
        }}>{t('save')}</Button>}>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('type')}><Select value={op.type} onChange={(e) => setOp({ ...op, type: e.target.value })}>{['IN', 'OUT', 'ADJUST', 'WASTE'].map((x) => <option key={x}>{x}</option>)}</Select></Field>
            <Field label={t('qty')}><NumberInput value={op.qty} onChange={(v) => setOp({ ...op, qty: v })} min={0} /></Field>
            <Field label={t('min')}><NumberInput value={op.minQty} onChange={(v) => setOp({ ...op, minQty: v })} min={0} /></Field>
            <Field label={t('note')}><Input value={op.note} onChange={(e) => setOp({ ...op, note: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
      {xfer && (
        <Modal open onClose={() => setXfer(null)} title={`${t('transfer')} · ${xfer.name}`} size="md" footer={<Button disabled={!xfer.toStoreId || !xfer.qty} onClick={async () => {
          try {
            await parkApi('/inventory/transfer', { body: { fromStoreId: xfer.fromStoreId, toStoreId: xfer.toStoreId, items: [{ productId: xfer.productId, qty: xfer.qty }] } });
            setXfer(null); refresh();
          } catch (e) { toast.error(t.err(e)); }
        }}>{t('save')}</Button>}>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('to')}><Select value={xfer.toStoreId} onChange={(e) => setXfer({ ...xfer, toStoreId: e.target.value })}><option value="">—</option>{(stores.data ?? []).filter((s: any) => s.id !== xfer.fromStoreId).map((s: any) => <option key={s.id} value={s.id}>{s.code}</option>)}</Select></Field>
            <Field label={t('qty')}><NumberInput value={xfer.qty} onChange={(v) => setXfer({ ...xfer, qty: v })} min={1} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ notifications, security, approvals, entry log
export function Notifications() {
  const t = useT(O);
  const { socket } = useStaffRt();
  const q = useQuery({ queryKey: ['park-notifications'], queryFn: () => parkApi('/notifications') });
  useSocketEvent(socket, EVENTS.NOTIFICATION, () => void q.refetch());
  return (
    <div>
      <PageHeader title={t('notifications')} actions={<Button variant="outline" icon={<CheckCheck className="h-4 w-4" />} onClick={() => parkApi('/notifications/read-all', { method: 'POST' }).then(() => q.refetch())}>{t('markAll')}</Button>} />
      {!q.data ? <Loading /> : !q.data.length ? <Empty /> : (
        <div className="space-y-2">
          {q.data.map((n: any) => (
            <div key={n.id} className={clsx('flex items-start gap-3 rounded-2xl border bg-white p-3', !n.read_at && 'border-l-4 border-l-primary')}>
              <Bell className={clsx('mt-0.5 h-5 w-5', n.severity === 'CRITICAL' ? 'text-rose-600' : n.severity === 'WARNING' ? 'text-amber-600' : 'text-slate-400')} />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{tr(n.title, t.lang)}</div>
                <div className="text-sm text-slate-600">{tr(n.body, t.lang)}</div>
                <div className="text-xs text-slate-400">{n.type} · {dateTime(n.created_at)}</div>
              </div>
              {!n.read_at && <Button size="sm" variant="ghost" onClick={() => parkApi(`/notifications/${n.id}/read`, { method: 'POST' }).then(() => q.refetch())}>✓</Button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Security() {
  const t = useT(O);
  const [tab, setTab] = useState<'security' | 'entries' | 'approvals'>('security');
  const sec = useQuery({ queryKey: ['gate-security-admin'], queryFn: () => parkApi('/gates/log/security'), enabled: tab === 'security' });
  const ent = useQuery({ queryKey: ['entry-log'], queryFn: () => parkApi('/gates/log/entries'), enabled: tab === 'entries' });
  const apr = useQuery({ queryKey: ['approvals'], queryFn: () => parkApi('/approvals'), enabled: tab === 'approvals' });
  return (
    <div>
      <PageHeader title={t('security')} actions={<Tabs value={tab} onChange={setTab} tabs={[{ id: 'security', label: t('security') }, { id: 'entries', label: t('entryLog') }, { id: 'approvals', label: t('approvals') }]} />} />
      <Card padded={false}>
        {tab === 'security' && (!sec.data ? <Loading /> : (
          <Table head={[t('time'), t('type'), t('gate'), t('ticket'), t('details'), '']}>
            {sec.data.map((s: any) => (
              <tr key={s.id} className={!s.acknowledged_at ? 'bg-rose-50/50' : ''}>
                <Td className="text-xs">{dateTime(s.created_at)}</Td>
                <Td><Badge className={s.severity === 'CRITICAL' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'}><ShieldAlert className="h-3 w-3" />{t.reason(s.type) || s.type}</Badge></Td>
                <Td>{s.gate_code}</Td>
                <Td className="font-mono text-xs">{s.ticket_no ?? s.credential_code ?? ''}</Td>
                <Td className="text-xs">{s.data?.firstGate ? `${s.data.firstGate} · ${s.data.firstAt ? dateTime(s.data.firstAt) : ''}` : ''}</Td>
                <Td>{s.acknowledged_at ? <span className="text-xs text-slate-500">{s.acknowledged_by_name}</span> : <Button size="sm" variant="ghost" onClick={() => parkApi(`/gates/log/security/${s.id}/ack`, { method: 'POST' }).then(() => sec.refetch())}>{t('ack')}</Button>}</Td>
              </tr>
            ))}
          </Table>
        ))}
        {tab === 'entries' && (!ent.data ? <Loading /> : (
          <Table head={[t('time'), t('gate'), t.x({ th: 'ทิศทาง', en: 'Direction', zh: '方向' }), t('ticket'), t('name'), t('status')]}>
            {ent.data.map((e: any) => <tr key={e.id}><Td className="text-xs">{dateTime(e.created_at)}</Td><Td>{e.gate_code ?? e.gate}</Td><Td>{e.direction}</Td><Td className="font-mono text-xs">{e.ticket_no ?? ''}</Td><Td>{e.member_no ?? e.credential_code ?? ''}</Td><Td><PStatus s={e.status} /></Td></tr>)}
          </Table>
        ))}
        {tab === 'approvals' && (!apr.data ? <Loading /> : (
          <Table head={[t('time'), t('actions'), t('staff'), t.x({ th: 'ผู้อนุมัติ', en: 'Approved by', zh: '审批人' }), t('reason'), t.x({ th: 'อ้างอิง', en: 'Reference', zh: '参考' })]}>
            {apr.data.map((a: any) => <tr key={a.id}><Td className="text-xs">{dateTime(a.created_at)}</Td><Td><Badge>{a.action}</Badge></Td><Td>{a.staff_name}</Td><Td>{a.manager_name}</Td><Td className="text-xs">{a.reason ?? ''}</Td><Td className="font-mono text-xs">{a.reference ?? a.entity_id ?? ''}</Td></tr>)}
          </Table>
        ))}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ park reports (3-language titles / columns)
const REPORT_TITLES: Record<string, { th: string; en: string; zh: string }> = {
  'park-daily-sales': { th: 'ยอดขายรายวัน (ทุกช่องทาง)', en: 'Daily sales (all streams)', zh: '每日销售（全部）' },
  'ticket-sales': { th: 'ยอดขายบัตร', en: 'Ticket sales', zh: '门票销售' },
  visitors: { th: 'ผู้เข้าชม', en: 'Visitors', zh: '游客' },
  gates: { th: 'รายงานประตู', en: 'Gate report', zh: '闸门报表' },
  rides: { th: 'รายงานเครื่องเล่น', en: 'Ride report', zh: '设施报表' },
  queues: { th: 'รายงานคิว', en: 'Queue report', zh: '排队报表' },
  'food-sales': { th: 'ยอดขายอาหาร', en: 'Food sales', zh: '餐饮销售' },
  'retail-sales': { th: 'ยอดขายสินค้า', en: 'Retail sales', zh: '零售销售' },
  wallet: { th: 'สรุปกระเป๋าเงิน', en: 'Wallet ledger summary', zh: '钱包汇总' },
  topups: { th: 'การเติมเงิน', en: 'Top-ups', zh: '充值' },
  refunds: { th: 'การคืนเงิน', en: 'Refunds', zh: '退款' },
  promotions: { th: 'โปรโมชั่น', en: 'Promotions', zh: '促销' },
  members: { th: 'สมาชิก', en: 'Members', zh: '会员' },
  staff: { th: 'ผลงานพนักงาน', en: 'Staff performance', zh: '员工业绩' },
  shifts: { th: 'กะการทำงาน', en: 'Shifts', zh: '班次' },
  stock: { th: 'สต็อกตามร้าน', en: 'Stock by store', zh: '门店库存' },
  transactions: { th: 'รายการธุรกรรม', en: 'Transactions', zh: '交易' },
  occupancy: { th: 'ความหนาแน่นรายชั่วโมง', en: 'Occupancy by hour', zh: '每小时人数' },
};
const COL: Record<string, { th: string; zh: string }> = {
  Amount: { th: 'จำนวนเงิน', zh: '金额' }, Date: { th: 'วันที่', zh: '日期' }, Time: { th: 'เวลา', zh: '时间' }, Hour: { th: 'ชั่วโมง', zh: '小时' }, Count: { th: 'จำนวน', zh: '数量' },
  Qty: { th: 'จำนวน', zh: '数量' }, Tickets: { th: 'บัตร', zh: '门票' }, Food: { th: 'อาหาร', zh: '餐饮' }, Retail: { th: 'สินค้า', zh: '零售' }, 'Wallet top-up': { th: 'เติมเงิน', zh: '充值' },
  Membership: { th: 'สมาชิก', zh: '会员' }, 'Ride add-ons': { th: 'เครื่องเล่นเพิ่ม', zh: '游乐加购' }, Lockers: { th: 'ล็อกเกอร์', zh: '储物柜' }, Refunds: { th: 'คืนเงิน', zh: '退款' },
  'Net revenue': { th: 'รายได้สุทธิ', zh: '净收入' }, Package: { th: 'แพ็กเกจ', zh: '套餐' }, 'Ticket type': { th: 'ประเภทตั๋ว', zh: '票种' }, Channel: { th: 'ช่องทาง', zh: '渠道' },
  'Used / entered': { th: 'ใช้แล้ว', zh: '已使用' }, 'Unique visitors': { th: 'ผู้เข้าชม', zh: '游客数' }, Entries: { th: 'เข้า', zh: '入园' }, Exits: { th: 'ออก', zh: '出园' },
  'Member visits': { th: 'สมาชิกเข้าชม', zh: '会员到访' }, Gate: { th: 'ประตู', zh: '闸门' }, Scans: { th: 'สแกน', zh: '扫描' }, Approved: { th: 'อนุญาต', zh: '通过' }, Denied: { th: 'ปฏิเสธ', zh: '拒绝' },
  'Duplicate attempts': { th: 'ใช้ซ้ำ', zh: '重复尝试' }, Overrides: { th: 'อนุญาตพิเศษ', zh: '强制放行' }, 'Avg approval (s)': { th: 'อนุมัติเฉลี่ย (วิ)', zh: '平均审批（秒）' }, Ride: { th: 'เครื่องเล่น', zh: '设施' },
  Rides: { th: 'จำนวนเล่น', zh: '乘坐次数' }, 'Not included': { th: 'ไม่รวมในตั๋ว', zh: '不含' }, 'Add-on sales': { th: 'ขายเพิ่ม', zh: '加购次数' }, 'Add-on revenue': { th: 'รายได้ขายเพิ่ม', zh: '加购收入' },
  Joined: { th: 'จองคิว', zh: '排队' }, Boarded: { th: 'ขึ้นเล่น', zh: '已乘坐' }, 'No-show': { th: 'ไม่มา', zh: '未到' }, Cancelled: { th: 'ยกเลิก', zh: '取消' }, 'Avg wait (min)': { th: 'รอเฉลี่ย (นาที)', zh: '平均等待（分钟）' },
  Item: { th: 'รายการ', zh: '项目' }, Store: { th: 'ร้าน', zh: '门店' }, Cost: { th: 'ต้นทุน', zh: '成本' }, Margin: { th: 'กำไร', zh: '毛利' }, Type: { th: 'ประเภท', zh: '类型' }, Credit: { th: 'เข้า', zh: '收入' },
  Debit: { th: 'ออก', zh: '支出' }, Method: { th: 'วิธีชำระ', zh: '方式' }, Card: { th: 'บัตร', zh: '卡' }, Reference: { th: 'อ้างอิง', zh: '参考' }, 'Balance after': { th: 'คงเหลือ', zh: '余额' }, Staff: { th: 'พนักงาน', zh: '员工' },
  Refund: { th: 'เลขคืนเงิน', zh: '退款号' }, Reason: { th: 'เหตุผล', zh: '原因' }, 'Approved by': { th: 'ผู้อนุมัติ', zh: '审批人' }, 'Paid back via': { th: 'คืนทาง', zh: '退款方式' }, Promotion: { th: 'โปรโมชั่น', zh: '促销' },
  'Discount given': { th: 'ส่วนลด', zh: '折扣' }, Uses: { th: 'ครั้ง', zh: '次数' }, Tier: { th: 'ระดับ', zh: '等级' }, Members: { th: 'สมาชิก', zh: '会员' }, 'New in period': { th: 'สมัครใหม่', zh: '新增' },
  'Active memberships': { th: 'สมาชิกที่ใช้งาน', zh: '有效会员' }, 'Points outstanding': { th: 'คะแนนคงค้าง', zh: '未用积分' }, 'Lifetime spend': { th: 'ยอดใช้จ่ายสะสม', zh: '累计消费' }, Role: { th: 'ตำแหน่ง', zh: '角色' },
  'Payments taken': { th: 'รับชำระ', zh: '收款笔数' }, 'Gate decisions': { th: 'อนุมัติที่ประตู', zh: '闸门决策' }, Shift: { th: 'กะ', zh: '班次' }, Terminal: { th: 'จุด', zh: '终端' }, Opened: { th: 'เปิด', zh: '开班' },
  Closed: { th: 'ปิด', zh: '交班' }, Opening: { th: 'เงินตั้งต้น', zh: '备用金' }, Expected: { th: 'ควรมี', zh: '应有' }, Actual: { th: 'นับได้', zh: '实点' }, 'Over / short': { th: 'ขาด/เกิน', zh: '长短款' },
  SKU: { th: 'รหัสสินค้า', zh: 'SKU' }, 'On hand': { th: 'คงเหลือ', zh: '库存' }, Minimum: { th: 'ขั้นต่ำ', zh: '最低' }, 'Low stock': { th: 'ใกล้หมด', zh: '库存不足' }, 'Sold in period': { th: 'ขายในช่วง', zh: '期间销量' },
  Txn: { th: 'เลขรายการ', zh: '交易号' }, Module: { th: 'ระบบ', zh: '模块' }, Status: { th: 'สถานะ', zh: '状态' }, 'Sale / order': { th: 'บิล / ออเดอร์', zh: '销售/订单' }, Sale: { th: 'บิล', zh: '销售' },
  Member: { th: 'สมาชิก', zh: '会员' }, Code: { th: 'รหัส', zh: '代码' }, Source: { th: 'ที่มา', zh: '来源' }, 'Paid by wallet / points': { th: 'จ่ายด้วยบัตร/คะแนน', zh: '钱包/积分支付' },
};
export function ParkReports() {
  const t = useT(O);
  const { can, branch } = useAuth();
  const today = dateOnly(new Date());
  const [type, setType] = useState('park-daily-sales');
  const [from, setFrom] = useState(dateOnly(new Date(Date.now() - 6 * 86400000)));
  const [to, setTo] = useState(today);
  const p = new URLSearchParams({ from, to });
  const q = useQuery({ queryKey: ['park-report', type, p.toString()], queryFn: () => parkApi<any>(`/reports/${type}?${p}`) });
  const col = (label: string) => (t.lang === 'en' ? label : COL[label]?.[t.lang] ?? label);
  const title = REPORT_TITLES[type] ? t.x(REPORT_TITLES[type]) : q.data?.title ?? type;
  const fmt = (c: any, v: any) => (v == null ? '—' : c.type === 'money' ? money(v) : c.type === 'datetime' ? dateTime(v) : c.type === 'percent' ? `${v}%` : typeof v === 'object' ? tr(v, t.lang) : String(v));
  const exportPdf = () => {
    if (!q.data) return;
    const w = window.open('', '_blank');
    if (!w) return;
    const esc = (s: string) => String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m]!);
    w.document.write(`<!doctype html><html lang="${t.lang}"><head><meta charset="utf-8"><title>${esc(title)}</title><link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;700&family=Noto+Sans+SC&display=swap" rel="stylesheet"><style>body{font-family:Sarabun,'Noto Sans SC',sans-serif;padding:24px;color:#111}table{border-collapse:collapse;width:100%;margin-top:16px;font-size:12px}th,td{border:1px solid #ccc;padding:6px;text-align:left}th{background:#f1f5f9}</style></head><body><h1>${esc(title)}</h1><div>${esc(branch?.code ?? '')} · ${from} → ${to}</div><table><thead><tr>${q.data.columns.map((c: any) => `<th>${esc(col(c.label))}</th>`).join('')}</tr></thead><tbody>${q.data.rows.map((r: any) => `<tr>${q.data.columns.map((c: any) => `<td>${esc(fmt(c, r[c.key]))}</td>`).join('')}</tr>`).join('')}</tbody></table><script>document.fonts.ready.then(()=>setTimeout(()=>print(),300))</script></body></html>`);
    w.document.close();
  };
  return (
    <div>
      <PageHeader title={t('reports')} actions={<>
        <Select value={type} onChange={(e) => setType(e.target.value)} className="w-64">{Object.keys(REPORT_TITLES).map((k) => <option key={k} value={k}>{t.x(REPORT_TITLES[k])}</option>)}</Select>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        {can('reports.export') && <><Button variant="outline" icon={<FileSpreadsheet className="h-4 w-4" />} onClick={() => downloadStaff(`/park/reports/${type}?${p}&format=xlsx`, `${type}-${from}-${to}.xlsx`).catch((e) => toast.error(t.err(e)))}>Excel</Button><Button variant="outline" onClick={() => downloadStaff(`/park/reports/${type}?${p}&format=csv`, `${type}-${from}-${to}.csv`).catch((e) => toast.error(t.err(e)))}>CSV</Button></>}
        <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={exportPdf}>{t('pdf')}</Button>
      </>} />
      <Card title={title} padded={false} actions={<Button size="sm" variant="ghost" icon={<RefreshCcw className="h-4 w-4" />} onClick={() => q.refetch()} />}>
        {!q.data ? <Loading /> : !q.data.rows.length ? <Empty /> : (
          <Table head={q.data.columns.map((c: any) => col(c.label))}>
            {q.data.rows.map((r: any, i: number) => <tr key={i}>{q.data.columns.map((c: any) => <Td key={c.key} className={c.type === 'money' || c.type === 'number' ? 'tabular-nums' : ''}>{fmt(c, r[c.key])}</Td>)}</tr>)}
          </Table>
        )}
      </Card>
    </div>
  );
}

