import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Banknote, Camera, CameraOff, CheckCircle2, CreditCard, Loader2, QrCode as QrIcon, Ticket, Wallet, XCircle } from 'lucide-react';
import { EVENTS } from '@kiosk/shared';
import { newKey, parkDeviceApi } from '../lib/api';
import { money } from '../lib/format';
import { LangSwitcher, defineStrings, useT } from '../lib/lang';
import { chime } from '../lib/sound';
import { useSocketEvent, watch } from '../lib/socket';
import { Button, Loading } from '../components/ui';
import { DeviceShell, useParkDevice } from '../park/device';
import { CameraScanner, QrCode, useScanner } from '../park/scan';

export const RS = defineStrings('ridescan', {
  scan: { th: 'สแกนบัตร / ริสแบนด์ / QR เพื่อเล่น', en: 'Scan your card / wristband / QR to ride', zh: '扫描卡 / 腕带 / 二维码乘坐' },
  checking: { th: 'กำลังตรวจสอบ…', en: 'Checking…', zh: '验证中…' },
  enjoy: { th: 'ขอให้สนุก!', en: 'Enjoy the ride!', zh: '祝您玩得开心！' },
  usesLeft: { th: 'เหลือสิทธิ์ {n} ครั้ง', en: '{n} rides left', zh: '剩余{n}次' },
  unlimited: { th: 'เล่นได้ไม่จำกัด', en: 'Unlimited rides', zh: '无限次畅玩' },
  denied: { th: 'ไม่สามารถเล่นได้', en: 'Cannot ride', zh: '无法乘坐' },
  notIncluded: { th: 'ตั๋วของคุณไม่รวมเครื่องเล่นนี้', en: 'Your ticket does not include this ride', zh: '您的门票不含此项目' },
  buyRide: { th: 'ซื้อสิทธิ์เล่น {p}', en: 'Buy this ride for {p}', zh: '购买此项目 {p}' },
  memberPrice: { th: 'ราคาสมาชิก', en: 'Member price', zh: '会员价' },
  payWallet: { th: 'จ่ายด้วยเงินในบัตร', en: 'Pay with card wallet', zh: '使用卡内余额' },
  balance: { th: 'ยอดคงเหลือ {b}', en: 'Balance {b}', zh: '余额 {b}' },
  payQr: { th: 'พร้อมเพย์', en: 'PromptPay', zh: 'PromptPay' },
  payCard: { th: 'บัตรเครดิต', en: 'Card', zh: '银行卡' },
  payCash: { th: 'เงินสด (เจ้าหน้าที่)', en: 'Cash (staff)', zh: '现金（工作人员）' },
  scanToPay: { th: 'สแกนจ่ายด้วยแอปธนาคาร', en: 'Scan with your banking app', zh: '用银行App扫码支付' },
  waitCash: { th: 'กรุณาชำระเงินสดกับเจ้าหน้าที่', en: 'Please pay the staff in cash', zh: '请向工作人员支付现金' },
  waitCard: { th: 'แตะบัตรที่เครื่องรูดบัตร', en: 'Tap your card on the terminal', zh: '请在刷卡机上挥卡' },
  cancel: { th: 'ยกเลิก', en: 'Cancel', zh: '取消' },
  closed: { th: 'เครื่องเล่นปิดให้บริการ', en: 'Ride closed', zh: '设施已关闭' },
  paused: { th: 'หยุดรับผู้เล่นชั่วคราว', en: 'Boarding paused', zh: '暂停登乘' },
  wait: { th: 'เวลารอ ~{n} นาที', en: 'Wait ~{n} min', zh: '等待约{n}分钟' },
  queueNo: { th: 'คิว {q}', en: 'Queue {q}', zh: '排队号 {q}' },
  choose: { th: 'เลือกจุดสแกนของเครื่องนี้', en: 'Choose this scanner’s ride', zh: '选择此扫描点' },
  minHeight: { th: 'ส่วนสูงขั้นต่ำ {n} ซม.', en: 'Min height {n} cm', zh: '最低身高 {n} 厘米' },
});

export default function RideScanner() {
  return (
    <DeviceShell surface="ride" staffPerms={['rides.operate']}>
      <Picker />
    </DeviceShell>
  );
}

function Picker() {
  const t = useT(RS);
  const { scanPointId } = useParams();
  const nav = useNavigate();
  const { assignment } = useParkDevice();
  const own: any[] = Object.values(Object.fromEntries((assignment?.scanPoints ?? []).map((s: any) => [s.id, s])));
  const id = scanPointId ?? (own.length === 1 ? own[0].id : null);
  const list = useQuery({ queryKey: ['rides-board-picker'], queryFn: () => parkDeviceApi('/rides/scan-points/list/all'), enabled: !id && !own.length });
  if (id) return <Scanner spId={id} />;
  const items = own.length ? own : list.data;
  if (!items) return <Loading />;
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 bg-slate-900 p-8 text-white">
      <div className="text-2xl font-bold">{t('choose')}</div>
      <div className="grid w-full max-w-4xl grid-cols-2 gap-3 sm:grid-cols-4">
        {items.map((s: any) => (
          <button key={s.id} onClick={() => nav(`/ride/${s.id}`)} className="press rounded-2xl bg-white/10 p-5 text-left hover:bg-white/20">
            <div className="text-lg font-bold">{t.tr(s.ride_name) || s.ride_code}</div>
            <div className="text-sm text-white/60">{s.code}</div>
          </button>
        ))}
      </div>
      <LangSwitcher dark />
    </div>
  );
}

type Phase = { kind: 'idle' } | { kind: 'checking' } | { kind: 'result'; r: any; code: string } | { kind: 'paying'; r: any; code: string; buy: any };

function Scanner({ spId }: { spId: string }) {
  const t = useT(RS);
  const qc = useQueryClient();
  const { socket, mode } = useParkDevice();
  const info = useQuery({ queryKey: ['scan-point', spId], queryFn: () => parkDeviceApi(`/rides/scan-points/${spId}`), refetchInterval: 30_000 });
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [cam, setCam] = useState(false);
  const [busy, setBusy] = useState(false);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backToIdle = (ms: number) => {
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(() => setPhase({ kind: 'idle' }), ms);
  };
  useEffect(() => (mode === 'staff' ? watch(socket, 'scanpoint', spId) : undefined), [socket, spId, mode]);
  useSocketEvent(socket, [EVENTS.RIDE_UPDATED, EVENTS.RIDE_QUEUE_UPDATED], () => void qc.invalidateQueries({ queryKey: ['scan-point', spId] }));
  const show = (r: any, code: string) => {
    setPhase({ kind: 'result', r, code });
    chime(r.result === 'GRANTED' ? 'success' : 'alert');
    backToIdle(r.result === 'NOT_INCLUDED' && r.offer ? 30_000 : r.result === 'GRANTED' ? 4000 : 5000);
  };
  const scan = async (code: string) => {
    if (busy || phase.kind === 'paying') return;
    setBusy(true);
    setPhase({ kind: 'checking' });
    try {
      show(await parkDeviceApi(`/rides/scan-points/${spId}/scan`, { body: { code, source: 'USB' } }), code);
    } catch (e: any) {
      show({ result: 'DENIED', reasonCode: e?.code ?? 'ERROR', error: t.err(e) }, code);
    } finally {
      setBusy(false);
    }
  };
  useScanner((c) => void scan(c));
  const buy = async (method: string) => {
    if (phase.kind !== 'result') return;
    setBusy(true);
    try {
      const r = await parkDeviceApi(`/rides/scan-points/${spId}/buy`, { body: { credentialId: phase.r.customer?.credentialId ?? null, code: phase.r.customer?.credentialId ? null : phase.code, method, language: t.lang }, idempotencyKey: newKey() });
      if (r.completed && r.scan) show(r.scan, phase.code);
      else {
        setPhase({ kind: 'paying', r: phase.r, code: phase.code, buy: r });
        if (idle.current) clearTimeout(idle.current);
      }
    } catch (e: any) {
      show({ ...phase.r, result: 'DENIED', reasonCode: e?.code, error: t.err(e) }, phase.code);
    } finally {
      setBusy(false);
    }
  };
  if (!info.data) return <Loading />;
  const ride = info.data.ride;
  return (
    <div className="flex h-full flex-col bg-slate-950 text-white">
      <header className="flex items-center gap-4 px-6 py-4">
        <Ticket className="h-8 w-8 text-amber-400" />
        <div>
          <div className="text-2xl font-extrabold">{t.tr(ride.name)}</div>
          <div className="text-sm text-white/60">{ride.min_height ? t('minHeight', { n: ride.min_height }) : ''}</div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <button onClick={() => setCam((x) => !x)} className="rounded-xl bg-white/10 p-2.5">{cam ? <CameraOff className="h-5 w-5" /> : <Camera className="h-5 w-5" />}</button>
          <LangSwitcher dark />
        </div>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
        {ride.status !== 'OPEN' || ride.entry_paused ? (
          <Banner tone="slate" icon={XCircle} title={ride.entry_paused ? t('paused') : t('closed')} sub={t.status(ride.status)} />
        ) : phase.kind === 'idle' ? (
          <Banner tone="indigo" icon={QrIcon} title={t('scan')} pulse />
        ) : phase.kind === 'checking' ? (
          <Banner tone="amber" icon={Loader2} title={t('checking')} spin />
        ) : phase.kind === 'paying' ? (
          <Paying spId={spId} buy={phase.buy} onDone={(r) => show(r, phase.code)} onCancel={() => setPhase({ kind: 'idle' })} />
        ) : (
          <Result r={phase.r} busy={busy} onBuy={buy} />
        )}
      </main>
      {cam && <div className="absolute right-6 bottom-6 w-72"><CameraScanner active onScan={(c) => void scan(c)} className="aspect-[4/3] w-full" facing="user" /></div>}
    </div>
  );
}

function Banner({ tone, icon: I, title, sub, spin, pulse }: { tone: 'indigo' | 'amber' | 'green' | 'red' | 'slate'; icon: any; title: string; sub?: string | null; spin?: boolean; pulse?: boolean }) {
  const bg = { indigo: 'from-indigo-600 to-slate-900', amber: 'from-amber-500 to-orange-700', green: 'from-emerald-500 to-green-800', red: 'from-rose-600 to-red-900', slate: 'from-slate-600 to-slate-800' }[tone];
  return (
    <div className={clsx('flex w-full max-w-4xl flex-col items-center gap-4 rounded-[2.5rem] bg-gradient-to-br p-12 shadow-2xl', bg)}>
      <I className={clsx('h-32 w-32', spin && 'animate-spin', pulse && 'animate-pulse')} strokeWidth={1.5} />
      <div className="text-5xl leading-tight font-extrabold">{title}</div>
      {sub && <div className="text-3xl text-white/90">{sub}</div>}
    </div>
  );
}

function Result({ r, busy, onBuy }: { r: any; busy: boolean; onBuy: (m: string) => void }) {
  const t = useT(RS);
  const name = r.customer?.name;
  if (r.result === 'GRANTED') {
    const e = r.entitlement;
    return (
      <>
        <Banner tone="green" icon={CheckCircle2} title={`${t('enjoy')}`} sub={[name, e ? (e.type === 'UNLIMITED' ? t('unlimited') : e.usesLeft != null ? t('usesLeft', { n: e.usesLeft }) : null) : null].filter(Boolean).join(' · ') || null} />
        {r.queue && <div className="text-2xl">{t('queueNo', { q: r.queue.queueNo ?? r.queue.queue_no })}</div>}
      </>
    );
  }
  if (r.result === 'NOT_INCLUDED' && r.offer) {
    const o = r.offer;
    const ICON: Record<string, any> = { WALLET: Wallet, PROMPTPAY: QrIcon, CARD: CreditCard, CASH: Banknote };
    const LABEL: Record<string, string> = { WALLET: t('payWallet'), PROMPTPAY: t('payQr'), CARD: t('payCard'), CASH: t('payCash') };
    return (
      <div className="w-full max-w-4xl rounded-[2.5rem] bg-white p-10 text-slate-900 shadow-2xl">
        <div className="text-2xl text-slate-600">{t.reason(r.reasonCode) || t('notIncluded')}</div>
        <div className="mt-2 text-5xl font-extrabold">{t('buyRide', { p: money(o.price) })}</div>
        {o.memberPriced && <div className="mt-1 font-semibold text-amber-600">{t('memberPrice')}</div>}
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {o.methods.map((m: string) => {
            const I = ICON[m] ?? CreditCard;
            const low = m === 'WALLET' && o.walletBalance != null && o.walletBalance < o.price;
            return (
              <button key={m} disabled={busy || low} onClick={() => onBuy(m)} className="press flex items-center gap-4 rounded-3xl border-4 border-slate-200 p-6 text-left text-2xl font-bold hover:border-primary disabled:opacity-40">
                <I className="h-12 w-12 text-primary" />
                <div>
                  {LABEL[m] ?? m}
                  {m === 'WALLET' && o.walletBalance != null && <div className={clsx('text-base font-medium', low ? 'text-rose-600' : 'text-slate-500')}>{t('balance', { b: money(o.walletBalance) })}</div>}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  return <Banner tone="red" icon={XCircle} title={t('denied')} sub={r.error ?? (t.reason(r.reasonCode) || null)} />;
}

function Paying({ spId, buy, onDone, onCancel }: { spId: string; buy: any; onDone: (r: any) => void; onCancel: () => void }) {
  const t = useT(RS);
  const { socket } = useParkDevice();
  const saleId = buy.sale.id;
  const p = buy.payment;
  const redeemed = useRef(false);
  const redeem = async () => {
    if (redeemed.current) return;
    const r = await parkDeviceApi(`/rides/scan-points/${spId}/redeem`, { body: { saleId } }).catch(() => null);
    if (r?.paid && r.scan) {
      redeemed.current = true;
      onDone(r.scan);
    }
  };
  useEffect(() => watch(socket, 'sale', saleId), [socket, saleId]);
  useSocketEvent(socket, [EVENTS.SALE_PAID, EVENTS.SALE_UPDATED], (d) => d?.saleId === saleId && void redeem());
  useEffect(() => {
    const i = setInterval(() => void redeem(), 4000);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saleId]);
  return (
    <div className="flex w-full max-w-3xl flex-col items-center gap-4 rounded-[2.5rem] bg-white p-10 text-slate-900 shadow-2xl">
      <div className="text-4xl font-extrabold">{money(p.amount)}</div>
      {p.qr_payload ? (
        <>
          <QrCode value={p.qr_payload} size={300} />
          <div className="text-2xl">{t('scanToPay')}</div>
        </>
      ) : p.status === 'WAITING_CASH' ? (
        <><Banknote className="h-24 w-24 animate-pulse text-primary" /><div className="text-3xl font-bold">{t('waitCash')}</div><div className="font-mono text-slate-500">{buy.sale.sale_no}</div></>
      ) : (
        <><CreditCard className="h-24 w-24 animate-pulse text-primary" /><div className="text-3xl font-bold">{t('waitCard')}</div></>
      )}
      <Button variant="ghost" size="lg" onClick={async () => { await parkDeviceApi(`/sales/${saleId}/cancel`, { body: { reason: 'RIDE_CANCELLED' } }).catch(() => {}); onCancel(); }}>{t('cancel')}</Button>
    </div>
  );
}
