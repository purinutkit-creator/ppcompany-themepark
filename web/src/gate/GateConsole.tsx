import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, Bell, CheckCircle2, DoorOpen, Hand, LogOut, Monitor, RotateCcw, ShieldAlert, ShieldCheck, Users, Volume2, XCircle } from 'lucide-react';
import { EVENTS } from '@kiosk/shared';
import { parkApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { time } from '../lib/format';
import { LangSwitcher, defineStrings, useT } from '../lib/lang';
import { chime, unlockAudio } from '../lib/sound';
import { useSocketEvent } from '../lib/socket';
import { Button, ConnectionDot, Loading, Modal, confirmDialog, promptDialog, toast, withManagerApproval } from '../components/ui';
import { StaffShell, useStaffRt } from '../components/StaffShell';
import { ChecksList, PStatus, SnapshotCard } from '../park/ui';

const GC = defineStrings('gatecon', {
  title: { th: 'ควบคุมประตูทางเข้า', en: 'Gate operator console', zh: '闸门操作台' },
  inside: { th: 'ในสวนตอนนี้', en: 'Inside now', zh: '园内人数' },
  capacity: { th: 'ความจุ', en: 'Capacity', zh: '容量' },
  entering: { th: 'กำลังเข้า', en: 'Entering', zh: '正在入园' },
  pending: { th: 'รออนุมัติ', en: 'Waiting approval', zh: '待批准' },
  approve: { th: 'อนุมัติ', en: 'Approve', zh: '批准' },
  deny: { th: 'ปฏิเสธ', en: 'Deny', zh: '拒绝' },
  override: { th: 'อนุญาตพิเศษ (Override)', en: 'Override', zh: '强制放行' },
  manualOpen: { th: 'เปิดประตูด้วยมือ', en: 'Manual open', zh: '手动开闸' },
  close: { th: 'ปิดประตู', en: 'Close gate', zh: '关闸' },
  reset: { th: 'รีเซ็ต', en: 'Reset', zh: '复位' },
  resend: { th: 'ส่งคำสั่งเปิดอีกครั้ง', en: 'Resend open', zh: '重发开闸' },
  emergencyAll: { th: 'ฉุกเฉิน: เปิดทุกประตู', en: 'Emergency: open all gates', zh: '紧急：打开所有闸门' },
  emergencyOff: { th: 'ยกเลิกโหมดฉุกเฉิน', en: 'End emergency', zh: '解除紧急模式' },
  emergencyConfirm: { th: 'ยืนยันเปิดทุกประตูค้างไว้ (ฉุกเฉิน)? ระบบตั๋วจะถูกข้าม', en: 'Hold ALL gates open (emergency)? The ticket system is bypassed.', zh: '确认打开所有闸门（紧急）？将绕过票务系统。' },
  emergencyGate: { th: 'ฉุกเฉินประตูนี้', en: 'Emergency (this gate)', zh: '此闸门紧急' },
  modeAuto: { th: 'อัตโนมัติ', en: 'AUTO', zh: '自动' },
  modeManual: { th: 'ต้องอนุมัติ', en: 'MANUAL', zh: '人工' },
  scansToday: { th: 'สแกนวันนี้', en: 'Scans today', zh: '今日扫描' },
  deniedToday: { th: 'ปฏิเสธ', en: 'Denied', zh: '拒绝' },
  dupToday: { th: 'ซ้ำ', en: 'Duplicate', zh: '重复' },
  lastScan: { th: 'การสแกนล่าสุด', en: 'Last scan', zh: '最近扫描' },
  reasonPrompt: { th: 'ระบุเหตุผล', en: 'Reason', zh: '原因' },
  security: { th: 'แจ้งเตือนความปลอดภัย', en: 'Security alerts', zh: '安全警报' },
  ack: { th: 'รับทราบ', en: 'Acknowledge', zh: '确认' },
  duplicate: { th: 'พบการใช้ QR ซ้ำ', en: 'DUPLICATE ENTRY ATTEMPT', zh: '重复入园尝试' },
  firstEntry: { th: 'เข้าแล้วที่ {gate} เวลา {time}', en: 'First entry {gate} at {time}', zh: '首次入园 {gate} {time}' },
  devices: { th: 'อุปกรณ์', en: 'Devices', zh: '设备' },
  recent: { th: 'ประวัติการสแกน', en: 'Recent scans', zh: '扫描记录' },
  openDisplay: { th: 'เปิดจอลูกค้า', en: 'Open customer display', zh: '打开客户显示屏' },
  takeOver: { th: 'ดูแลประตูนี้', en: 'Assign to me', zh: '由我负责' },
  operator: { th: 'ผู้ดูแล', en: 'Operator', zh: '操作员' },
  sound: { th: 'เปิดเสียงแจ้งเตือน', en: 'Enable alert sounds', zh: '开启提示音' },
  full: { th: 'สวนเต็มแล้ว', en: 'Park is full', zh: '园区已满' },
});

const STATE_TONE: Record<string, string> = {
  IDLE: 'bg-slate-100 text-slate-700', SCANNING: 'bg-sky-100 text-sky-800', VALIDATING: 'bg-amber-100 text-amber-800', WAITING_APPROVAL: 'bg-amber-500 text-white',
  APPROVED: 'bg-emerald-500 text-white', OPENING: 'bg-emerald-500 text-white', OPEN: 'bg-emerald-600 text-white', CLOSING: 'bg-emerald-200 text-emerald-900',
  DENIED: 'bg-rose-600 text-white', ERROR: 'bg-slate-500 text-white', OFFLINE: 'bg-slate-400 text-white', EMERGENCY: 'bg-red-700 text-white animate-pulse',
};

export default function GateConsole() {
  return (
    <StaffShell perms={['gates.view', 'gates.operate']} surface="gate">
      <Console />
    </StaffShell>
  );
}

function Console() {
  const t = useT(GC);
  const { user, logout, can } = useAuth();
  const { socket, connected } = useStaffRt();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['gates'], queryFn: () => parkApi('/gates'), refetchInterval: 15_000 });
  const alerts = useQuery({ queryKey: ['gate-security'], queryFn: () => parkApi('/gates/log/security'), enabled: can('security.view'), refetchInterval: 60_000 });
  const [sel, setSel] = useState<string | null>(null);
  const [sound, setSound] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = () => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void qc.invalidateQueries({ queryKey: ['gates'] });
      void qc.invalidateQueries({ queryKey: ['gate-detail'] });
    }, 250);
  };
  useSocketEvent(socket, [EVENTS.GATE_STATE, EVENTS.GATE_SCAN, EVENTS.OCCUPANCY_UPDATED, EVENTS.DEVICE_STATUS], (d, ev) => {
    refresh();
    if (ev === EVENTS.GATE_SCAN && d?.result === 'PENDING' && sound) chime('ding');
  });
  useSocketEvent(socket, [EVENTS.SECURITY_ALERT, EVENTS.CAPACITY_ALERT], (d, ev) => {
    if (sound) chime('alert');
    if (ev === EVENTS.SECURITY_ALERT) toast.warning(`${d.gate ?? ''} · ${d.type === 'DUPLICATE_ENTRY' ? t('duplicate') : t.reason(d.type) || d.type}`, d.ticketNo ?? undefined);
    else toast.warning(t('capacity'), `${d.pct ?? ''}%`);
    void qc.invalidateQueries({ queryKey: ['gate-security'] });
  });
  if (!q.data) return <Loading />;
  const occ = q.data.occupancy;
  const gates: any[] = q.data.gates;
  const anyEmergency = gates.some((g) => g.state === 'EMERGENCY');
  const pending = gates.filter((g) => g.state === 'WAITING_APPROVAL');
  const openAlerts = (alerts.data ?? []).filter((a: any) => !a.acknowledged_at).slice(0, 8);
  const emergency = async (on: boolean, gateId?: string) => {
    if (on && !(await confirmDialog(t('emergencyAll'), t('emergencyConfirm'), true))) return;
    try {
      await parkApi('/gates/emergency', { body: { on, gateId: gateId ?? null } });
      refresh();
    } catch (e) { toast.error(t.err(e)); }
  };
  return (
    <div className="flex h-full flex-col bg-slate-100">
      <header className="flex flex-wrap items-center gap-3 border-b bg-white px-4 py-3">
        <ShieldCheck className="h-6 w-6 text-primary" />
        <div className="font-bold">{t('title')}</div>
        <ConnectionDot connected={connected} />
        <div className="ml-2 flex flex-wrap items-center gap-2">
          <Kpi icon={Users} label={t('inside')} value={`${occ.inside} / ${occ.capacity}`} tone={occ.pct >= 100 ? 'rose' : occ.pct >= 90 ? 'amber' : 'slate'} />
          <Kpi icon={DoorOpen} label={t('entering')} value={occ.entering} />
          <Kpi icon={Hand} label={t('pending')} value={pending.length} tone={pending.length ? 'amber' : 'slate'} />
          <div className="h-2.5 w-36 overflow-hidden rounded-full bg-slate-200"><div className={clsx('h-full', occ.pct >= 100 ? 'bg-rose-600' : occ.pct >= 90 ? 'bg-amber-500' : occ.pct >= 80 ? 'bg-yellow-400' : 'bg-emerald-500')} style={{ width: `${Math.min(100, occ.pct)}%` }} /></div>
          <span className="text-sm font-semibold">{occ.pct}%</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {!sound && <Button size="sm" variant="outline" icon={<Volume2 className="h-4 w-4" />} onClick={() => { unlockAudio(); setSound(true); }}>{t('sound')}</Button>}
          {can('gates.emergency') && (anyEmergency
            ? <Button size="sm" variant="dark" onClick={() => emergency(false)}>{t('emergencyOff')}</Button>
            : <Button size="sm" variant="danger" icon={<AlertTriangle className="h-4 w-4" />} onClick={() => emergency(true)}>{t('emergencyAll')}</Button>)}
          <LangSwitcher compact />
          <span className="hidden text-sm text-slate-600 md:inline">{user?.name}</span>
          <button onClick={() => logout()} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><LogOut className="h-5 w-5" /></button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <main className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
            {gates.map((g) => <GateTile key={g.id} g={g} onOpen={() => setSel(g.id)} onChanged={refresh} />)}
          </div>
        </main>
        {openAlerts.length > 0 && (
          <aside className="scroll-thin hidden w-80 shrink-0 overflow-y-auto border-l bg-white p-3 xl:block">
            <div className="mb-2 flex items-center gap-2 font-semibold"><Bell className="h-4 w-4 text-rose-600" />{t('security')}</div>
            {openAlerts.map((a: any) => (
              <div key={a.id} className="mb-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm">
                <div className="flex items-center justify-between"><b className="text-rose-800">{a.type === 'DUPLICATE_ENTRY' ? t('duplicate') : t.reason(a.type) || a.type}</b><span className="text-xs text-slate-500">{time(a.created_at)}</span></div>
                <div className="text-slate-700">{a.gate_code ?? a.data?.gate} · {a.data?.ticketNo ?? a.ticket_no ?? ''}</div>
                {a.data?.firstGate && <div className="text-xs text-slate-600">{t('firstEntry', { gate: a.data.firstGate, time: a.data.firstAt ? time(a.data.firstAt) : '-' })}</div>}
                <Button size="sm" variant="ghost" className="mt-1" onClick={async () => { await parkApi(`/gates/log/security/${a.id}/ack`, { method: 'POST' }).catch(() => {}); void alerts.refetch(); }}>{t('ack')}</Button>
              </div>
            ))}
          </aside>
        )}
      </div>
      {sel && <GateDetail gateId={sel} onClose={() => setSel(null)} onChanged={refresh} />}
    </div>
  );
}

function Kpi({ icon: I, label, value, tone = 'slate' }: { icon: any; label: string; value: any; tone?: 'slate' | 'amber' | 'rose' }) {
  return (
    <div className={clsx('flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm', tone === 'rose' ? 'bg-rose-100 text-rose-800' : tone === 'amber' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100')}>
      <I className="h-4 w-4" /><span className="text-xs">{label}</span><b className="tabular-nums">{value}</b>
    </div>
  );
}

function useGateActions(g: any, onChanged: () => void) {
  const t = useT(GC);
  const run = async (fn: () => Promise<any>) => {
    try {
      await fn();
      onChanged();
    } catch (e) { toast.error(t.err(e)); }
  };
  const scanId = g.current_scan_id ?? g.last_scan?.id;
  return {
    approve: () => run(() => parkApi(`/gates/${g.id}/approve`, { body: { scanId } })),
    deny: () => run(() => parkApi(`/gates/${g.id}/deny`, { body: { scanId } })),
    override: () => run(async () => {
      const reason = await promptDialog(t('reasonPrompt'));
      if (!reason || reason.length < 3) return;
      await withManagerApproval(t('override'), (a) => parkApi(`/gates/${g.id}/override`, { body: { scanId: g.last_scan?.id, reason, ...a } }));
    }),
    manualOpen: () => run(async () => {
      const reason = await promptDialog(t('reasonPrompt'));
      if (!reason || reason.length < 3) return;
      await withManagerApproval(t('manualOpen'), (a) => parkApi(`/gates/${g.id}/open`, { body: { reason, ...a } }));
    }),
    close: () => run(() => parkApi(`/gates/${g.id}/close`, { method: 'POST' })),
    reset: () => run(() => parkApi(`/gates/${g.id}/reset`, { method: 'POST' })),
    resend: () => run(() => parkApi(`/gates/${g.id}/resend-open`, { method: 'POST' })),
    mode: (mode: 'AUTO' | 'MANUAL') => run(() => parkApi(`/gates/${g.id}/mode`, { body: { mode } })),
    emergency: (on: boolean) => run(() => parkApi('/gates/emergency', { body: { on, gateId: g.id } })),
    takeOver: () => run(() => parkApi(`/gates/${g.id}/operator`, { body: {} })),
  };
}

function GateTile({ g, onOpen, onChanged }: { g: any; onOpen: () => void; onChanged: () => void }) {
  const t = useT(GC);
  const { can } = useAuth();
  const a = useGateActions(g, onChanged);
  const s = g.last_scan;
  const waiting = g.state === 'WAITING_APPROVAL';
  const devOffline = (g.devices ?? []).some((d: any) => d.status === 'OFFLINE');
  return (
    <div className={clsx('flex flex-col rounded-2xl border-2 bg-white p-3 shadow-sm', waiting ? 'animate-pulse border-amber-500' : g.state === 'DENIED' ? 'border-rose-400' : g.state === 'EMERGENCY' ? 'border-red-700' : 'border-transparent')}>
      <button onClick={onOpen} className="flex items-start gap-2 text-left">
        <div className="rounded-xl bg-slate-900 px-2.5 py-1 text-xl font-extrabold text-white">{g.number}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{t.tr(g.name) || g.code}</div>
          <div className="text-xs text-slate-500">{g.direction} · {g.mode === 'AUTO' ? t('modeAuto') : t('modeManual')}{g.operator_name ? ` · ${g.operator_name}` : ''}</div>
        </div>
        <span className={clsx('rounded-full px-2 py-0.5 text-[11px] font-bold', STATE_TONE[g.state])}>{t.status(g.state)}</span>
      </button>
      <div className="mt-2 min-h-16 rounded-xl bg-slate-50 p-2 text-sm">
        {s ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{s.customer?.name || s.customer?.ticketNo || '—'}</span>
              <PStatus s={s.result} />
            </div>
            {s.reason_code && <div className="text-xs font-semibold text-rose-700">{t.reason(s.reason_code)}</div>}
            <div className="text-[11px] text-slate-500">{time(s.created_at)} · {t.tr(s.customer?.ticketType)}</div>
          </>
        ) : <span className="text-slate-400">—</span>}
      </div>
      {waiting && can('gates.operate') && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Button variant="success" icon={<CheckCircle2 className="h-4 w-4" />} onClick={a.approve}>{t('approve')}</Button>
          <Button variant="danger" icon={<XCircle className="h-4 w-4" />} onClick={a.deny}>{t('deny')}</Button>
        </div>
      )}
      <div className="mt-2 flex items-center gap-3 text-[11px] text-slate-500">
        <span>{t('scansToday')} <b className="text-slate-700">{g.scans_today}</b></span>
        <span>{t('deniedToday')} <b className="text-rose-700">{g.denied_today}</b></span>
        <span>{t('dupToday')} <b className="text-amber-700">{g.duplicate_today}</b></span>
        {devOffline && <span className="ml-auto rounded-full bg-slate-200 px-2 text-slate-700">{t('offline')}</span>}
      </div>
    </div>
  );
}

function GateDetail({ gateId, onClose, onChanged }: { gateId: string; onClose: () => void; onChanged: () => void }) {
  const t = useT(GC);
  const { can } = useAuth();
  const d = useQuery({ queryKey: ['gate-detail', gateId], queryFn: () => parkApi(`/gates/${gateId}`) });
  const scans = useQuery({ queryKey: ['gate-detail', gateId, 'scans'], queryFn: () => parkApi(`/gates/${gateId}/scans`) });
  const g = d.data;
  const a = useGateActions(g ?? { id: gateId }, onChanged);
  const s = g?.last_scan;
  const recent = useMemo(() => (scans.data ?? []).slice(0, 30), [scans.data]);
  return (
    <Modal open onClose={onClose} size="xl" title={g ? `${g.number} · ${t.tr(g.name) || g.code}` : ''}>
      {!g ? <Loading /> : (
        <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={clsx('rounded-full px-3 py-1 text-sm font-bold', STATE_TONE[g.state])}>{t.status(g.state)}</span>
              <div className="inline-flex rounded-xl bg-slate-100 p-0.5">
                {(['AUTO', 'MANUAL'] as const).map((m) => (
                  <button key={m} onClick={() => a.mode(m)} disabled={!can('gates.operate')} className={clsx('rounded-lg px-3 py-1 text-sm font-semibold', g.mode === m ? 'bg-white shadow-sm' : 'text-slate-500')}>{m === 'AUTO' ? t('modeAuto') : t('modeManual')}</button>
                ))}
              </div>
              <span className="text-sm text-slate-500">{t('operator')}: {g.operator_name ?? '—'}</span>
              <Button size="sm" variant="ghost" onClick={a.takeOver}>{t('takeOver')}</Button>
              <a href={`/gate/${g.id}`} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 text-sm text-primary"><Monitor className="h-4 w-4" />{t('openDisplay')}</a>
            </div>
            {s && (
              <div className="rounded-2xl border p-3">
                <div className="mb-2 flex items-center justify-between text-sm"><b>{t('lastScan')}</b><span className="text-slate-500">{time(s.created_at, true)} · {s.direction}</span></div>
                <div className="mb-2 flex items-center gap-2"><PStatus s={s.result} />{s.reason_code && <span className="font-semibold text-rose-700">{t.reason(s.reason_code)}</span>}</div>
                <SnapshotCard c={s.customer} />
                <div className="mt-3"><ChecksList checks={s.checks} /></div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {g.state === 'WAITING_APPROVAL' && can('gates.operate') && <><Button variant="success" onClick={a.approve}>{t('approve')}</Button><Button variant="danger" onClick={a.deny}>{t('deny')}</Button></>}
              {s?.result === 'DENIED' && can('gates.override') && <Button variant="outline" icon={<ShieldAlert className="h-4 w-4" />} onClick={a.override}>{t('override')}</Button>}
              {can('gates.open') && <Button variant="outline" icon={<DoorOpen className="h-4 w-4" />} onClick={a.manualOpen}>{t('manualOpen')}</Button>}
              {can('gates.operate') && <Button variant="outline" onClick={a.close}>{t('close')}</Button>}
              {can('gates.operate') && g.state === 'APPROVED' && <Button variant="outline" onClick={a.resend}>{t('resend')}</Button>}
              {can('gates.operate') && <Button variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={a.reset}>{t('reset')}</Button>}
              {can('gates.emergency') && <Button variant={g.state === 'EMERGENCY' ? 'dark' : 'danger'} onClick={() => a.emergency(g.state !== 'EMERGENCY')}>{g.state === 'EMERGENCY' ? t('emergencyOff') : t('emergencyGate')}</Button>}
            </div>
          </div>
          <div>
            <div className="mb-2 text-sm font-semibold">{t('recent')}</div>
            <div className="scroll-thin max-h-[60vh] space-y-1 overflow-y-auto">
              {recent.map((r: any) => (
                <div key={r.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-2 py-1.5 text-xs">
                  <span className="w-14 text-slate-500">{time(r.created_at, true)}</span>
                  <span className="flex-1 truncate">{r.customer?.name || r.code}</span>
                  {r.reason_code && <span className="text-rose-700">{t.reason(r.reason_code)}</span>}
                  <PStatus s={r.result} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
