import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { DoorOpen, Lock, Unlock } from 'lucide-react';
import { EVENTS } from '@kiosk/shared';
import { newKey, parkDeviceApi } from '../lib/api';
import { money } from '../lib/format';
import { LangSwitcher, defineStrings, useT } from '../lib/lang';
import { useSocketEvent } from '../lib/socket';
import { Button, Loading, toast } from '../components/ui';
import { DeviceShell, useParkDevice } from '../park/device';
import { CameraScanner, useScanner } from '../park/scan';

const L = defineStrings('lockerst', {
  title: { th: 'ตู้ล็อกเกอร์', en: 'Lockers', zh: '储物柜' },
  rent: { th: 'เช่าล็อกเกอร์', en: 'Rent a locker', zh: '租用储物柜' },
  open: { th: 'เปิดล็อกเกอร์ของฉัน', en: 'Open my locker', zh: '打开我的储物柜' },
  chooseRate: { th: 'เลือกระยะเวลา', en: 'Choose duration', zh: '选择时长' },
  scan: { th: 'สแกนริสแบนด์ / บัตร / QR สมาชิก', en: 'Scan wristband / card / member QR', zh: '扫描腕带 / 卡 / 会员码' },
  payWallet: { th: 'ชำระด้วยเงินในบัตร', en: 'Paid from card wallet', zh: '使用卡内余额支付' },
  yourLocker: { th: 'ล็อกเกอร์ของคุณ', en: 'Your locker', zh: '您的储物柜' },
  opened: { th: 'เปิดล็อกเกอร์แล้ว', en: 'Locker opened', zh: '储物柜已打开' },
  until: { th: 'ใช้ได้ถึง {t}', en: 'Valid until {t}', zh: '有效期至 {t}' },
  free: { th: 'ว่าง {n}', en: '{n} free', zh: '空闲 {n}' },
  release: { th: 'เปิดและคืนล็อกเกอร์', en: 'Open & finish', zh: '打开并归还' },
});

export default function LockerStation() {
  return (
    <DeviceShell surface="kiosk" staffPerms={['lockers.operate']}>
      <Station />
    </DeviceShell>
  );
}

function Station() {
  const t = useT(L);
  const { socket } = useParkDevice();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['locker-station'], queryFn: () => parkDeviceApi('/lockers') });
  useSocketEvent(socket, EVENTS.LOCKER_UPDATED, () => void qc.invalidateQueries({ queryKey: ['locker-station'] }));
  const [mode, setMode] = useState<'home' | 'rent' | 'open'>('home');
  const [rate, setRate] = useState<any>(null);
  const [result, setResult] = useState<{ title: string; code?: string; sub?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [cam, setCam] = useState(false);
  const reset = () => {
    setMode('home');
    setRate(null);
    setResult(null);
    setCam(false);
  };
  const onScan = async (code: string) => {
    if (busy || mode === 'home' || (mode === 'rent' && !rate)) return;
    setBusy(true);
    try {
      if (mode === 'rent') {
        const r = await parkDeviceApi('/lockers/rent', { body: { code, rateId: rate.id, method: 'WALLET', language: t.lang }, idempotencyKey: newKey() });
        setResult({ title: t('yourLocker'), code: r.session?.locker_code, sub: r.session?.expire_at ? t('until', { t: new Date(r.session.expire_at).toLocaleTimeString() }) : t('payWallet') });
      } else {
        const r = await parkDeviceApi('/lockers/open', { body: { code } });
        if (!r.ok) {
          toast.error(t.reason(r.reason) || r.reason, r.locker?.code);
          return;
        }
        setResult({ title: t('opened'), code: r.locker?.code, sub: r.expireAt ? t('until', { t: new Date(r.expireAt).toLocaleTimeString() }) : undefined });
      }
      setTimeout(reset, 8000);
    } catch (e) {
      toast.error(t.err(e));
    } finally {
      setBusy(false);
    }
  };
  useScanner(onScan, { enabled: mode !== 'home' });
  if (!q.data) return <Loading />;
  const free = q.data.lockers.filter((l: any) => l.status === 'AVAILABLE').length;
  return (
    <div className="kiosk-root flex h-full flex-col">
      <header className="flex items-center gap-3 px-6 py-4">
        <Lock className="h-8 w-8 text-primary" />
        <div className="text-2xl font-extrabold">{t('title')}</div>
        <span className="rounded-full bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-800">{t('free', { n: free })}</span>
        <div className="ml-auto"><LangSwitcher /></div>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
        {result ? (
          <div className="rounded-[2rem] bg-white p-10 text-center shadow-xl">
            <DoorOpen className="mx-auto h-20 w-20 text-emerald-500" />
            <div className="mt-2 text-2xl">{result.title}</div>
            {result.code && <div className="my-3 text-7xl font-extrabold text-primary">{result.code}</div>}
            {result.sub && <div className="text-lg text-slate-600">{result.sub}</div>}
            <Button size="lg" className="mt-6" onClick={reset}>{t('done')}</Button>
          </div>
        ) : mode === 'home' ? (
          <div className="grid w-full max-w-3xl gap-5 sm:grid-cols-2">
            <button onClick={() => setMode('rent')} className="press flex min-h-48 flex-col justify-between rounded-[2rem] bg-gradient-to-br from-primary to-orange-600 p-8 text-left text-3xl font-extrabold text-white shadow-xl"><Lock className="h-14 w-14" />{t('rent')}</button>
            <button onClick={() => setMode('open')} className="press flex min-h-48 flex-col justify-between rounded-[2rem] bg-gradient-to-br from-sky-500 to-indigo-600 p-8 text-left text-3xl font-extrabold text-white shadow-xl"><Unlock className="h-14 w-14" />{t('open')}</button>
          </div>
        ) : mode === 'rent' && !rate ? (
          <div className="w-full max-w-3xl">
            <div className="mb-4 text-center text-2xl font-bold">{t('chooseRate')}</div>
            <div className="grid gap-4 sm:grid-cols-2">
              {q.data.rates.map((r: any) => (
                <button key={r.id} onClick={() => setRate(r)} className="press rounded-[2rem] bg-white p-6 text-left shadow">
                  <div className="text-2xl font-bold">{t.tr(r.label)}</div>
                  <div className="text-3xl font-extrabold text-primary">{money(r.price)}</div>
                  {r.size && <div className="text-slate-500">{r.size}</div>}
                </button>
              ))}
            </div>
            <Button variant="ghost" className="mt-4" onClick={reset}>{t('back')}</Button>
          </div>
        ) : (
          <div className="flex w-full max-w-xl flex-col items-center gap-4 text-center">
            {rate && <div className="text-xl">{t.tr(rate.label)} · <b>{money(rate.price)}</b> · {t('payWallet')}</div>}
            <div className={clsx('text-3xl font-bold', busy && 'animate-pulse')}>{t('scan')}</div>
            <Button variant="outline" onClick={() => setCam((c) => !c)}>{t('camera')}</Button>
            {cam && <CameraScanner active onScan={onScan} className="aspect-video w-full" facing="user" />}
            <Button variant="ghost" onClick={reset}>{t('back')}</Button>
          </div>
        )}
      </main>
    </div>
  );
}
