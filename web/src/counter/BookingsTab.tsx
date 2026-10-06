import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CalendarDays, CheckCircle2, Users } from 'lucide-react';
import { EVENTS } from '@kiosk/shared';
import { parkApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, money } from '../lib/format';
import { defineStrings, useT } from '../lib/lang';
import { useSocketEvent } from '../lib/socket';
import { Button, Empty, Input, Loading, promptDialog, toast, withManagerApproval } from '../components/ui';
import { useStaffRt } from '../components/StaffShell';
import { QrCode, ScanBar } from '../park/scan';
import { PStatus, StaffPayDialog } from '../park/ui';
import { BindWristband } from './BindWristband';

export const BK = defineStrings('bookings', {
  scanBooking: { th: 'สแกน QR การจอง / ตั๋ว หรือพิมพ์เลขการจอง', en: 'Scan booking / ticket QR or type the booking number', zh: '扫描预订 / 门票二维码或输入预订号' },
  search: { th: 'ค้นหาชื่อ เบอร์ เลขสมาชิก', en: 'Search name, phone, member no.', zh: '搜索姓名、电话、会员号' },
  TODAY: { th: 'วันนี้', en: 'Today', zh: '今天' },
  TOMORROW: { th: 'พรุ่งนี้', en: 'Tomorrow', zh: '明天' },
  UPCOMING: { th: 'ล่วงหน้า', en: 'Upcoming', zh: '即将到来' },
  UNPAID: { th: 'ยังไม่ชำระ', en: 'Unpaid', zh: '未付款' },
  PENDING_VERIFICATION: { th: 'รอตรวจสอบ', en: 'Pending verification', zh: '待核对' },
  CHECKED_IN: { th: 'เช็คอินแล้ว', en: 'Checked in', zh: '已入园' },
  CANCELLED: { th: 'ยกเลิก', en: 'Cancelled', zh: '已取消' },
  REFUNDED: { th: 'คืนเงิน', en: 'Refunded', zh: '已退款' },
  NO_SHOW: { th: 'ไม่มา', en: 'No show', zh: '未到场' },
  ALL: { th: 'ทั้งหมด', en: 'All', zh: '全部' },
  checkIn: { th: 'เช็คอิน', en: 'Check in', zh: '登记入园' },
  takePayment: { th: 'รับชำระเงิน', en: 'Take payment', zh: '收款' },
  cancelBooking: { th: 'ยกเลิกการจอง', en: 'Cancel booking', zh: '取消预订' },
  guests: { th: 'ผู้เข้าชม', en: 'Guests', zh: '人数' },
  tickets: { th: 'ตั๋ว', en: 'Tickets', zh: '门票' },
  checkedIn: { th: 'เช็คอินแล้ว', en: 'Checked in', zh: '已登记' },
  outstanding: { th: 'ค้างชำระ', en: 'Outstanding', zh: '待付' },
  channel: { th: 'ช่องทาง', en: 'Channel', zh: '渠道' },
  printTickets: { th: 'พิมพ์ตั๋ว', en: 'Print tickets', zh: '打印门票' },
});

const FILTERS = ['TODAY', 'TOMORROW', 'UPCOMING', 'UNPAID', 'PENDING_VERIFICATION', 'CHECKED_IN', 'CANCELLED', 'REFUNDED', 'NO_SHOW', 'ALL'] as const;

export function BookingsTab() {
  const t = useT(BK);
  const { socket } = useStaffRt();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('TODAY');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['bookings', filter, q], queryFn: () => parkApi(`/bookings?${new URLSearchParams({ ...(filter !== 'ALL' ? { filter } : {}), ...(q ? { q } : {}) })}`) });
  useSocketEvent(socket, [EVENTS.BOOKING_UPDATED, EVENTS.SALE_PAID], () => void qc.invalidateQueries({ queryKey: ['bookings'] }));
  const scan = async (code: string) => {
    try {
      const d = await parkApi('/bookings/scan', { body: { code } });
      setSel(d.booking.id);
    } catch (e) { toast.error(t.err(e)); }
  };
  return (
    <div className="grid min-h-full gap-3 p-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="space-y-3">
        <div className="rounded-2xl bg-white p-3 shadow-sm"><ScanBar onScan={scan} placeholder={t('scanBooking')} /></div>
        <div className="rounded-2xl bg-white p-3 shadow-sm">
          <div className="no-scrollbar mb-2 flex gap-1 overflow-x-auto">
            {FILTERS.map((f) => <button key={f} onClick={() => setFilter(f)} className={clsx('shrink-0 rounded-full px-3 py-1 text-xs font-medium', filter === f ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600')}>{t(f)}</button>)}
          </div>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} className="mb-2" />
          {!list.data ? <Loading /> : !list.data.length ? <Empty /> : (
            <div className="space-y-1">
              {list.data.map((b: any) => (
                <button key={b.id} onClick={() => setSel(b.id)} className={clsx('flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm', sel === b.id ? 'bg-primary/10' : 'hover:bg-slate-50')}>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono font-semibold">{b.booking_no}</div>
                    <div className="truncate text-xs text-slate-500">{b.customer_name} · {b.phone ?? ''} {b.member_no ? `· ${b.member_no}` : ''}</div>
                  </div>
                  <div className="text-right text-xs"><div>{b.visit_date}</div><div className="text-slate-500"><Users className="mr-0.5 inline h-3 w-3" />{b.guests}</div></div>
                  <PStatus s={b.status} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div>{sel ? <BookingDetail id={sel} /> : <div className="rounded-2xl bg-white p-6 shadow-sm"><Empty title={t('scanBooking')} /></div>}</div>
    </div>
  );
}

export function BookingDetail({ id }: { id: string }) {
  const t = useT(BK);
  const { can } = useAuth();
  const { socket } = useStaffRt();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['booking', id], queryFn: () => parkApi(`/bookings/${id}`) });
  const [paying, setPaying] = useState(false);
  useSocketEvent(socket, [EVENTS.BOOKING_UPDATED, EVENTS.SALE_PAID, EVENTS.TICKET_UPDATED, EVENTS.CREDENTIAL_UPDATED], () => void qc.invalidateQueries({ queryKey: ['booking', id] }));
  if (!q.data) return <Loading />;
  const d = q.data;
  const bk = d.booking;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['booking', id] });
    void qc.invalidateQueries({ queryKey: ['bookings'] });
  };
  const run = async (fn: () => Promise<any>) => {
    try {
      await fn();
      refresh();
    } catch (e) { toast.error(t.err(e)); }
  };
  const payable = ['PENDING_PAYMENT', 'RESERVED'].includes(bk.status) && bk.outstanding > 0;
  return (
    <div className="space-y-3">
      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start gap-4">
          {bk.qr && <QrCode value={bk.qr} size={110} />}
          <div className="min-w-0 flex-1">
            <div className="font-mono text-xl font-extrabold">{bk.booking_no}</div>
            <div className="font-semibold">{bk.customer_name}</div>
            <div className="text-sm text-slate-500">{bk.phone ?? ''} {bk.email ?? ''} {bk.member_no ? `· ${bk.member_no}` : ''}</div>
            <div className="mt-1 flex flex-wrap gap-1.5"><PStatus s={bk.status} /><PStatus s={bk.payment_status} /><span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{t('channel')}: {bk.channel}</span></div>
          </div>
          <div className="text-right text-sm">
            <div className="flex items-center justify-end gap-1"><CalendarDays className="h-4 w-4" />{bk.visit_date}</div>
            <div className="flex items-center justify-end gap-1"><Users className="h-4 w-4" />{bk.guests}</div>
            <div className="mt-1 text-xl font-bold">{money(bk.sale_total)}</div>
            {bk.outstanding > 0 && <div className="font-semibold text-rose-600">{t('outstanding')} {money(bk.outstanding)}</div>}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {payable && can('tickets.sell') && <Button onClick={() => setPaying(true)}>{t('takePayment')}</Button>}
          {['CONFIRMED'].includes(bk.status) && can('bookings.checkin') && <Button variant="success" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => run(() => parkApi(`/bookings/${id}/checkin`, { method: 'POST' }))}>{t('checkIn')}</Button>}
          {['CONFIRMED', 'CHECKED_IN'].includes(bk.status) && can('tickets.sell') && <Button variant="outline" onClick={() => run(() => withManagerApproval(t('printTickets'), (a) => parkApi(`/sales/${bk.sale_id}/reprint`, { body: { only: 'TICKETS', ...a } })))}>{t('printTickets')}</Button>}
          {['PENDING_PAYMENT', 'RESERVED', 'CONFIRMED'].includes(bk.status) && can('bookings.manage') && (
            <Button variant="ghost" className="text-rose-600" onClick={async () => {
              const reason = await promptDialog(t('cancelBooking'), t('reason'));
              if (reason) await run(() => withManagerApproval(t('cancelBooking'), (a) => parkApi(`/bookings/${id}/cancel`, { body: { reason, ...a } })));
            }}>{t('cancelBooking')}</Button>
          )}
        </div>
      </div>
      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="mb-2 font-semibold">{t('tickets')}</div>
        <div className="space-y-2">
          {d.tickets.map((tk: any) => (
            <div key={tk.id} className="rounded-xl border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{tk.ticket_no}</span>
                <span className="font-medium">{t.tr(tk.package_name)} · {t.tr(tk.ticket_type_name)}</span>
                {tk.guest_name && <span className="text-sm text-slate-500">{tk.guest_name}</span>}
                <span className="ml-auto flex gap-1"><PStatus s={tk.status} /><PStatus s={tk.presence} /></span>
              </div>
              {['ACTIVE', 'PAID'].includes(tk.status) && can('cards.issue') && <BindWristband ticketId={tk.id} existing={tk.wristbands} onDone={refresh} />}
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-2xl bg-white p-4 text-sm shadow-sm">
        {d.items.map((it: any) => <div key={it.id} className="flex justify-between"><span>{t.tr(it.name)} × {it.qty}</span><span>{money(it.line_total)}</span></div>)}
        <div className="mt-2 space-y-1 border-t pt-2">
          {d.payments.map((p: any) => <div key={p.id} className="flex justify-between text-xs"><span>{t.method(p.method)} · {dateTime(p.paid_at ?? p.created_at)}</span><span>{money(p.amount)} <PStatus s={p.status} /></span></div>)}
        </div>
      </div>
      {paying && <StaffPayDialog saleId={bk.sale_id} socket={socket} onClose={() => setPaying(false)} onPaid={() => { setPaying(false); refresh(); }} />}
    </div>
  );
}
