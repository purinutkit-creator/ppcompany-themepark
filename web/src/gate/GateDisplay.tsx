import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, Camera, CameraOff, CheckCircle2, Hand, Loader2, QrCode as QrIcon, ShieldAlert, UserCheck, WifiOff, XCircle } from 'lucide-react';
import { EVENTS, type GateState } from '@kiosk/shared';
import { parkDeviceApi } from '../lib/api';
import { LangSwitcher, defineStrings, useT } from '../lib/lang';
import { chime } from '../lib/sound';
import { useSocketEvent, watch } from '../lib/socket';
import { Loading } from '../components/ui';
import { DeviceShell, useParkDevice } from '../park/device';
import { CameraScanner, useScanner } from '../park/scan';

export const GS = defineStrings('gate', {
  scanHere: { th: 'กรุณาสแกน QR / บาร์โค้ด / ริสแบนด์', en: 'Please scan your QR / barcode / wristband', zh: '请扫描二维码 / 条码 / 腕带' },
  scanSub: { th: 'ตั๋ว · บัตรสมาชิก · QR ในแอป', en: 'Ticket · member card · app QR', zh: '门票 · 会员卡 · App二维码' },
  checking: { th: 'กำลังตรวจสอบ…', en: 'Checking…', zh: '验证中…' },
  waitStaff: { th: 'กรุณารอเจ้าหน้าที่ตรวจสอบ', en: 'Please wait for staff approval', zh: '请等待工作人员确认' },
  welcome: { th: 'ยินดีต้อนรับ', en: 'Welcome', zh: '欢迎' },
  goodbye: { th: 'ขอบคุณที่มาเที่ยว', en: 'Thank you for visiting', zh: '感谢光临' },
  pleaseEnter: { th: 'เชิญผ่านประตูได้เลย', en: 'Please walk through', zh: '请通行' },
  pleaseExit: { th: 'เชิญออกได้เลย', en: 'Please exit', zh: '请通行' },
  accessDenied: { th: 'ไม่สามารถผ่านได้', en: 'Access denied', zh: '禁止通行' },
  contactStaff: { th: 'กรุณาติดต่อเจ้าหน้าที่ที่เคาน์เตอร์', en: 'Please contact staff at the counter', zh: '请联系柜台工作人员' },
  emergency: { th: 'โหมดฉุกเฉิน', en: 'EMERGENCY MODE', zh: '紧急模式' },
  emergencySub: { th: 'ประตูเปิดค้าง กรุณาเดินออกอย่างเป็นระเบียบ', en: 'Gates are open — please exit calmly', zh: '闸门已打开，请有序离开' },
  offline: { th: 'ประตูนี้ไม่พร้อมใช้งาน', en: 'This gate is unavailable', zh: '此闸门暂停使用' },
  offlineSub: { th: 'กรุณาใช้ประตูอื่น', en: 'Please use another gate', zh: '请使用其他闸门' },
  entry: { th: 'ทางเข้า', en: 'ENTRANCE', zh: '入口' },
  exit: { th: 'ทางออก', en: 'EXIT', zh: '出口' },
  firstEntry: { th: 'เข้าแล้วที่ {gate} เวลา {time}', en: 'Already entered at {gate}, {time}', zh: '已于 {time} 从 {gate} 入园' },
  chooseGate: { th: 'เลือกประตูสำหรับหน้าจอนี้', en: 'Choose the gate for this screen', zh: '选择此屏幕对应的闸门' },
  remainingRides: { th: 'สิทธิ์คงเหลือ', en: 'Remaining passes', zh: '剩余权益' },
});

const TONE: Record<string, { bg: string; icon: any }> = {
  IDLE: { bg: 'from-slate-900 via-slate-800 to-indigo-950', icon: QrIcon },
  SCANNING: { bg: 'from-slate-900 via-slate-800 to-indigo-950', icon: QrIcon },
  VALIDATING: { bg: 'from-amber-500 to-orange-600', icon: Loader2 },
  WAITING_APPROVAL: { bg: 'from-amber-500 to-orange-600', icon: Hand },
  APPROVED: { bg: 'from-emerald-500 to-green-700', icon: CheckCircle2 },
  OPENING: { bg: 'from-emerald-500 to-green-700', icon: CheckCircle2 },
  OPEN: { bg: 'from-emerald-500 to-green-700', icon: CheckCircle2 },
  CLOSING: { bg: 'from-emerald-600 to-green-800', icon: CheckCircle2 },
  DENIED: { bg: 'from-rose-600 to-red-800', icon: XCircle },
  EMERGENCY: { bg: 'from-red-600 to-red-900', icon: AlertTriangle },
  ERROR: { bg: 'from-slate-600 to-slate-800', icon: WifiOff },
  OFFLINE: { bg: 'from-slate-600 to-slate-800', icon: WifiOff },
};

export default function GateDisplay() {
  return (
    <DeviceShell surface="gate" staffPerms={['gates.operate']}>
      <Picker />
    </DeviceShell>
  );
}

function Picker() {
  const t = useT(GS);
  const { gateId } = useParams();
  const nav = useNavigate();
  const { assignment } = useParkDevice();
  // A device can be bound to the same gate in several roles (display + scanner): one entry per gate.
  const own: any[] = Object.values(Object.fromEntries((assignment?.gates ?? []).map((g: any) => [g.id, g])));
  const list = useQuery({ queryKey: ['gates-list-display'], queryFn: () => parkDeviceApi('/gates'), enabled: !gateId && !own.length });
  const id = gateId ?? (own.length === 1 ? own[0].id : null);
  if (id) return <Display gateId={id} />;
  const gates = own.length ? own : list.data?.gates;
  if (!gates) return <Loading />;
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 bg-slate-900 p-8 text-white">
      <div className="text-2xl font-bold">{t('chooseGate')}</div>
      <div className="grid w-full max-w-4xl grid-cols-2 gap-3 sm:grid-cols-5">
        {gates.map((g: any) => (
          <button key={g.id} onClick={() => nav(`/gate/${g.id}`)} className="press rounded-2xl bg-white/10 p-5 text-center hover:bg-white/20">
            <div className="text-3xl font-extrabold">{g.number}</div>
            <div className="text-sm text-white/70">{g.code}</div>
          </button>
        ))}
      </div>
      <LangSwitcher dark />
    </div>
  );
}

interface View {
  state: GateState;
  result?: string | null;
  reasonCode?: string | null;
  customer?: any;
  duplicate?: { firstGate: string | null; firstAt: string | null } | null;
  direction?: string | null;
  at: number;
}

function Display({ gateId }: { gateId: string }) {
  const t = useT(GS);
  const qc = useQueryClient();
  const { socket, connected, mode } = useParkDevice();
  const gate = useQuery({ queryKey: ['gate', gateId], queryFn: () => parkDeviceApi(`/gates/${gateId}`), refetchInterval: 30_000 });
  const [view, setView] = useState<View | null>(null);
  const [cam, setCam] = useState(false);
  const [busy, setBusy] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => (mode === 'staff' ? watch(socket, 'gate', gateId) : undefined), [socket, gateId, mode]);
  useEffect(() => {
    if (gate.data && !view) setView({ state: gate.data.state, at: Date.now() });
  }, [gate.data, view]);
  const holdThenIdle = (ms: number) => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => void qc.invalidateQueries({ queryKey: ['gate', gateId] }).then(() => setView((v) => (v && ['DENIED'].includes(v.state) ? { state: 'IDLE', at: Date.now() } : v))), ms);
  };
  useSocketEvent(socket, EVENTS.GATE_STATE, (d) => {
    if (d?.gateId !== gateId) return;
    setView((v) => {
      // Keep the customer details while the gate goes APPROVED → OPENING → OPEN → CLOSING; clear on IDLE.
      if (d.state === 'IDLE') return v && v.state === 'DENIED' && Date.now() - v.at < 2500 ? v : { state: 'IDLE', at: Date.now() };
      return { ...(v ?? { at: Date.now() }), state: d.state, at: Date.now() };
    });
    if (d.state === 'APPROVED') chime('success');
    void qc.invalidateQueries({ queryKey: ['gate', gateId] });
  });
  useSocketEvent(socket, EVENTS.GATE_SCAN, (d) => {
    if (d?.gateId !== gateId) return;
    setView((v) => ({ state: v?.state ?? 'VALIDATING', result: d.result, reasonCode: d.reasonCode, customer: d.customer, duplicate: d.duplicate, direction: d.direction, at: Date.now() }));
  });
  const scan = async (code: string, source: 'USB' | 'CAMERA' = 'USB') => {
    if (busy) return;
    setBusy(true);
    setView((v) => ({ state: 'VALIDATING', at: Date.now(), direction: v?.direction }));
    try {
      const r = await parkDeviceApi(`/gates/${gateId}/scan`, { body: { code, source } });
      if (r.ignoredDuplicate) return;
      const state: GateState = r.result === 'DENIED' ? 'DENIED' : r.result === 'PENDING' ? 'WAITING_APPROVAL' : 'APPROVED';
      setView({ state, result: r.result, reasonCode: r.reasonCode, customer: r.customer, duplicate: r.duplicate, direction: r.direction, at: Date.now() });
      if (state === 'DENIED') {
        chime('alert');
        holdThenIdle(4000);
      }
    } catch (e: any) {
      chime('alert');
      setView({ state: 'DENIED', reasonCode: e?.code ?? 'ERROR', at: Date.now() });
      holdThenIdle(3500);
    } finally {
      setBusy(false);
    }
  };
  useScanner((c) => void scan(c, 'USB'));
  if (!gate.data || !view) return <Loading />;
  const g = gate.data;
  const state: GateState = g.state === 'EMERGENCY' ? 'EMERGENCY' : g.state === 'OFFLINE' || g.state === 'ERROR' ? g.state : view.state;
  const tone = TONE[state] ?? TONE.IDLE;
  const Icon = tone.icon;
  const isExit = (view.direction ?? g.direction) === 'EXIT';
  const c = view.customer ?? {};
  const name = c.name || null;
  let title = t('scanHere');
  let sub: string | null = t('scanSub');
  if (state === 'VALIDATING') [title, sub] = [t('checking'), null];
  else if (state === 'WAITING_APPROVAL') [title, sub] = [t('waitStaff'), name];
  else if (['APPROVED', 'OPENING', 'OPEN', 'CLOSING'].includes(state)) [title, sub] = [isExit ? t('goodbye') : `${t('welcome')}${name ? `, ${name}` : ''}`, isExit ? t('pleaseExit') : t('pleaseEnter')];
  else if (state === 'DENIED') [title, sub] = [t('accessDenied'), t.reason(view.reasonCode) || t('contactStaff')];
  else if (state === 'EMERGENCY') [title, sub] = [t('emergency'), t('emergencySub')];
  else if (state === 'OFFLINE' || state === 'ERROR') [title, sub] = [t('offline'), t('offlineSub')];
  return (
    <div className={clsx('relative flex h-full flex-col overflow-hidden bg-gradient-to-br text-white transition-colors duration-300', tone.bg, state === 'EMERGENCY' && 'animate-pulse')}>
      <header className="flex items-center gap-4 px-8 py-5">
        <div className="rounded-2xl bg-white/15 px-5 py-2 text-3xl font-extrabold tracking-wide">{g.number}</div>
        <div>
          <div className="text-xl font-bold">{t.tr(g.name) || g.code}</div>
          <div className="text-sm text-white/70">{g.direction === 'EXIT' ? t('exit') : g.direction === 'BOTH' ? `${t('entry')} / ${t('exit')}` : t('entry')}</div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {!connected && <span className="flex items-center gap-1 rounded-full bg-black/30 px-3 py-1 text-sm"><WifiOff className="h-4 w-4" /> {t('offline')}</span>}
          <button onClick={() => setCam((x) => !x)} className="rounded-xl bg-white/10 p-2.5 hover:bg-white/20" title={t('camera')}>{cam ? <CameraOff className="h-5 w-5" /> : <Camera className="h-5 w-5" />}</button>
          <LangSwitcher dark />
        </div>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-8 text-center">
        <Icon className={clsx('h-40 w-40 drop-shadow-lg', state === 'VALIDATING' && 'animate-spin', state === 'IDLE' && 'animate-pulse opacity-90')} strokeWidth={1.5} />
        <div className="max-w-5xl text-5xl leading-tight font-extrabold md:text-7xl">{title}</div>
        {sub && <div className="max-w-4xl text-2xl text-white/90 md:text-4xl">{sub}</div>}
        {state === 'DENIED' && view.duplicate?.firstGate && (
          <div className="flex items-center gap-2 rounded-2xl bg-black/25 px-6 py-3 text-xl"><ShieldAlert className="h-6 w-6" />{t('firstEntry', { gate: view.duplicate.firstGate, time: view.duplicate.firstAt ? new Date(view.duplicate.firstAt).toLocaleTimeString() : '-' })}</div>
        )}
        {['APPROVED', 'OPENING', 'OPEN', 'WAITING_APPROVAL'].includes(state) && (c.ticketType || c.packageName) && (
          <div className="flex items-center gap-3 rounded-2xl bg-black/20 px-6 py-3 text-2xl">
            <UserCheck className="h-7 w-7" />
            {t.tr(c.packageName)} {c.ticketType ? `· ${t.tr(c.ticketType)}` : ''} {c.guestCount > 1 ? `· ${c.guestIndex}/${c.guestCount}` : ''}
          </div>
        )}
      </main>
      {cam && (
        <div className="absolute right-6 bottom-6 w-80">
          <CameraScanner active onScan={(code) => void scan(code, 'CAMERA')} className="aspect-[4/3] w-full shadow-2xl" facing="user" />
        </div>
      )}
      <footer className="px-8 py-4 text-center text-sm text-white/50">{g.mode} · {g.code}{mode === 'device' ? '' : ' · staff'}</footer>
    </div>
  );
}
