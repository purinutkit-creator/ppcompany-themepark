import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Banknote, Bell, CheckCircle2, LogOut, Megaphone, Monitor, Pause, Play, Timer, Users, XCircle } from 'lucide-react';
import { EVENTS } from '@kiosk/shared';
import { newKey, parkApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, time } from '../lib/format';
import { LangSwitcher, defineStrings, useT } from '../lib/lang';
import { chime } from '../lib/sound';
import { useSocketEvent } from '../lib/socket';
import { Button, ConnectionDot, Field, Input, Loading, Modal, NumberInput, Select, toast } from '../components/ui';
import { StaffShell, useStaffRt } from '../components/StaffShell';
import { PStatus } from '../park/ui';

const RO = defineStrings('rideop', {
  title: { th: 'ควบคุมเครื่องเล่น', en: 'Ride operator', zh: '游乐设施操作台' },
  waiting: { th: 'รอคิว', en: 'Waiting', zh: '排队中' },
  called: { th: 'เรียกแล้ว', en: 'Called', zh: '已叫号' },
  guestsToday: { th: 'ผู้เล่นวันนี้', en: 'Guests today', zh: '今日游客' },
  lastHour: { th: '1 ชม.ล่าสุด', en: 'Last hour', zh: '近1小时' },
  wait: { th: 'รอ ~{n} นาที', en: '~{n} min wait', zh: '约等{n}分钟' },
  callNext: { th: 'เรียกคิวถัดไป', en: 'Call next', zh: '叫下一位' },
  callCount: { th: 'จำนวนที่เรียก', en: 'How many', zh: '叫号数量' },
  pause: { th: 'หยุดรับชั่วคราว', en: 'Pause boarding', zh: '暂停登乘' },
  resume: { th: 'เปิดรับต่อ', en: 'Resume', zh: '恢复' },
  setStatus: { th: 'สถานะเครื่องเล่น', en: 'Ride status', zh: '设施状态' },
  queue: { th: 'คิวเสมือน', en: 'Virtual queue', zh: '虚拟排队' },
  manual: { th: 'อนุมัติ/ปฏิเสธด้วยตนเอง', en: 'Manual approve / deny', zh: '人工批准/拒绝' },
  approve: { th: 'อนุมัติ', en: 'Approve', zh: '批准' },
  deny: { th: 'ปฏิเสธ', en: 'Deny', zh: '拒绝' },
  cardCode: { th: 'รหัสบัตร / ริสแบนด์', en: 'Card / wristband code', zh: '卡/腕带代码' },
  cashWaiting: { th: 'รอรับเงินสด', en: 'Cash to collect', zh: '待收现金' },
  confirmCash: { th: 'รับเงินแล้ว', en: 'Cash received', zh: '已收款' },
  live: { th: 'การสแกนล่าสุด', en: 'Live scans', zh: '实时扫描' },
  openScanner: { th: 'เปิดจอสแกน', en: 'Open scanner screen', zh: '打开扫描屏' },
  tooLong: { th: 'คิวยาวเกินกำหนด', en: 'Queue too long', zh: '排队过长' },
  cancelEntry: { th: 'ยกเลิก', en: 'Cancel', zh: '取消' },
});

export default function RideOperator() {
  return (
    <StaffShell perms={['rides.view', 'rides.operate']} surface="ride">
      <Board />
    </StaffShell>
  );
}

function Board() {
  const t = useT(RO);
  const { user, logout } = useAuth();
  const { socket, connected } = useStaffRt();
  const qc = useQueryClient();
  const board = useQuery({ queryKey: ['ride-board'], queryFn: () => parkApi('/rides'), refetchInterval: 30_000 });
  const [sel, setSel] = useState<string | null>(null);
  const [scans, setScans] = useState<any[]>([]);
  const [cash, setCash] = useState<any[]>([]);
  useSocketEvent(socket, [EVENTS.RIDE_UPDATED, EVENTS.RIDE_QUEUE_UPDATED, EVENTS.RIDE_SCAN], (d, ev) => {
    void qc.invalidateQueries({ queryKey: ['ride-board'] });
    void qc.invalidateQueries({ queryKey: ['ride-queue'] });
    if (ev === EVENTS.RIDE_SCAN) setScans((s) => [d, ...s].slice(0, 40));
  });
  useSocketEvent(socket, EVENTS.PARK_PAYMENT_WAITING, (d) => {
    if (d?.kind !== 'CASH' || d.channel !== 'RIDE') return;
    chime('ding');
    setCash((c) => [d, ...c.filter((x) => x.paymentId !== d.paymentId)]);
  });
  useSocketEvent(socket, [EVENTS.SALE_PAID, EVENTS.SALE_UPDATED], (d) => {
    if (d?.status === 'PAID' || d?.status === 'CANCELLED' || d?.status === 'EXPIRED' || d?.paymentStatus === 'PAID' || d?.paymentStatus === 'CANCELLED') setCash((c) => c.filter((x) => x.saleId !== d.saleId));
  });
  if (!board.data) return <Loading />;
  const rides: any[] = board.data;
  const rideName = (id: string) => t.tr(rides.find((r) => r.id === id)?.name);
  return (
    <div className="flex h-full flex-col bg-slate-100">
      <header className="flex flex-wrap items-center gap-3 border-b bg-white px-4 py-3">
        <Timer className="h-6 w-6 text-primary" />
        <div className="font-bold">{t('title')}</div>
        <ConnectionDot connected={connected} />
        <div className="ml-auto flex items-center gap-2">
          <LangSwitcher compact />
          <span className="hidden text-sm text-slate-600 md:inline">{user?.name}</span>
          <button onClick={() => logout()} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><LogOut className="h-5 w-5" /></button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <main className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
          {cash.length > 0 && (
            <div className="mb-4 rounded-2xl border-2 border-amber-400 bg-amber-50 p-3">
              <div className="mb-2 flex items-center gap-2 font-semibold text-amber-900"><Banknote className="h-5 w-5" />{t('cashWaiting')}</div>
              <div className="flex flex-wrap gap-2">
                {cash.map((c) => (
                  <div key={c.paymentId} className="flex items-center gap-3 rounded-xl bg-white px-3 py-2 shadow-sm">
                    <span className="font-mono text-sm">{c.saleNo}</span>
                    <b>{money(c.amount)}</b>
                    <Button size="sm" variant="success" onClick={async () => {
                      try {
                        await parkApi(`/sales/${c.saleId}/payments/${c.paymentId}/confirm-cash`, { body: { received: c.amount }, idempotencyKey: newKey() });
                        setCash((x) => x.filter((y) => y.paymentId !== c.paymentId));
                      } catch (e) { toast.error(t.err(e)); }
                    }}>{t('confirmCash')}</Button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {rides.map((r) => (
              <button key={r.id} onClick={() => setSel(r.id)} className={clsx('rounded-2xl border-2 bg-white p-4 text-left shadow-sm', r.queue_too_long ? 'border-amber-400' : 'border-transparent')}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-bold">{t.tr(r.name)}</div>
                    <div className="text-xs text-slate-500">{r.code} · {t.tr(r.zone_name)}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1"><PStatus s={r.status} />{r.entry_paused && <span className="rounded-full bg-amber-100 px-2 text-[11px] font-bold text-amber-800">{t('pause')}</span>}</div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <Stat label={t('waiting')} value={r.queue_waiting} />
                  <Stat label={t('guestsToday')} value={r.guests_today} />
                  <Stat label={t('lastHour')} value={r.guests_last_hour} />
                </div>
                <div className={clsx('mt-2 text-sm font-semibold', r.queue_too_long ? 'text-amber-700' : 'text-slate-600')}>{t('wait', { n: r.wait_minutes })}{r.queue_too_long ? ` · ${t('tooLong')}` : ''}</div>
              </button>
            ))}
          </div>
        </main>
        <aside className="scroll-thin hidden w-80 shrink-0 overflow-y-auto border-l bg-white p-3 lg:block">
          <div className="mb-2 flex items-center gap-2 font-semibold"><Bell className="h-4 w-4" />{t('live')}</div>
          {scans.map((s, i) => (
            <div key={`${s.logId}-${i}`} className="mb-1.5 flex items-center gap-2 rounded-lg bg-slate-50 px-2 py-1.5 text-xs">
              {s.result === 'GRANTED' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-rose-600" />}
              <span className="flex-1 truncate">{rideName(s.rideId)} · {s.customer?.name ?? s.by ?? ''}</span>
              {s.reasonCode && <span className="text-rose-700">{t.reason(s.reasonCode)}</span>}
              <span className="text-slate-400">{time(s.at)}</span>
            </div>
          ))}
        </aside>
      </div>
      {sel && <RideDetail ride={rides.find((r) => r.id === sel)} onClose={() => setSel(null)} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: any }) {
  return <div className="rounded-xl bg-slate-50 py-1.5"><div className="text-lg font-bold tabular-nums">{value}</div><div className="text-[10px] text-slate-500">{label}</div></div>;
}

function RideDetail({ ride, onClose }: { ride: any; onClose: () => void }) {
  const t = useT(RO);
  const { can } = useAuth();
  const qc = useQueryClient();
  const queue = useQuery({ queryKey: ['ride-queue', ride.id], queryFn: () => parkApi(`/rides/${ride.id}/queue`), enabled: ride.queue_enabled });
  const sps = useQuery({ queryKey: ['scan-points-all'], queryFn: () => parkApi('/rides/scan-points/list/all') });
  const [count, setCount] = useState<number | null>(ride.capacity ?? 1);
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const run = async (fn: () => Promise<any>, ok?: string) => {
    try {
      await fn();
      if (ok) toast.success(ok);
      void qc.invalidateQueries({ queryKey: ['ride-board'] });
      void qc.invalidateQueries({ queryKey: ['ride-queue'] });
    } catch (e) { toast.error(t.err(e)); }
  };
  const sp = (sps.data ?? []).find((s: any) => s.ride_id === ride.id);
  const entries: any[] = Array.isArray(queue.data) ? queue.data : queue.data?.entries ?? [];
  return (
    <Modal open onClose={onClose} size="lg" title={t.tr(ride.name)}>
      <div className="space-y-4">
        {can('rides.operate') && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('setStatus')}>
              <Select value={ride.status} onChange={(e) => run(() => parkApi(`/rides/${ride.id}/status`, { body: { status: e.target.value } }))}>
                {['OPEN', 'TEMPORARILY_CLOSED', 'MAINTENANCE', 'CLOSED'].map((s) => <option key={s} value={s}>{t.status(s)}</option>)}
              </Select>
            </Field>
            <Button variant="outline" icon={ride.entry_paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />} onClick={() => run(() => parkApi(`/rides/${ride.id}/status`, { body: { paused: !ride.entry_paused } }))}>{ride.entry_paused ? t('resume') : t('pause')}</Button>
            {sp && <a href={`/ride/${sp.id}`} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 text-sm text-primary"><Monitor className="h-4 w-4" />{t('openScanner')}</a>}
          </div>
        )}
        {ride.queue_enabled && (
          <div className="rounded-2xl border p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <b>{t('queue')}</b>
              <span className="text-sm text-slate-500"><Users className="mr-1 inline h-4 w-4" />{ride.queue_waiting} · {t('called')} {ride.queue_called}</span>
              {can('queue.rides') && (
                <div className="ml-auto flex items-center gap-2">
                  <div className="w-20"><NumberInput value={count} onChange={setCount} min={1} /></div>
                  <Button icon={<Megaphone className="h-4 w-4" />} onClick={() => run(() => parkApi(`/rides/${ride.id}/queue/call`, { body: { count: count ?? 1 } }))}>{t('callNext')}</Button>
                </div>
              )}
            </div>
            <div className="scroll-thin max-h-64 space-y-1 overflow-y-auto">
              {entries.map((e: any) => (
                <div key={e.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-2 py-1.5 text-sm">
                  <b className="w-16 font-mono">{e.queue_no ?? e.queueNo}</b>
                  <span className="flex-1 text-slate-600">{e.party_size ?? e.partySize} · {time(e.joined_at ?? e.joinedAt)}</span>
                  <PStatus s={e.status} />
                  {can('queue.rides') && <Button size="sm" variant="ghost" onClick={() => run(() => parkApi(`/rides/queue/${e.id}/cancel`, { method: 'POST' }))}>{t('cancelEntry')}</Button>}
                </div>
              ))}
            </div>
          </div>
        )}
        {can('rides.operate') && (
          <div className="rounded-2xl border p-3">
            <div className="mb-2 font-semibold">{t('manual')}</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label={t('cardCode')}><Input value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" /></Field>
              <Field label={t('reason')}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            </div>
            <div className="mt-2 flex gap-2">
              <Button variant="success" disabled={reason.length < 2} onClick={() => run(() => parkApi(`/rides/${ride.id}/manual`, { body: { decision: 'APPROVE', code: code || null, reason } }), t('approve'))}>{t('approve')}</Button>
              <Button variant="danger" disabled={reason.length < 2} onClick={() => run(() => parkApi(`/rides/${ride.id}/manual`, { body: { decision: 'DENY', code: code || null, reason } }), t('deny'))}>{t('deny')}</Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
