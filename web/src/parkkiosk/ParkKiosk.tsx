import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, Banknote, CheckCircle2, CreditCard, Search, Ticket, Timer, UtensilsCrossed, Wallet, QrCode as QrIcon } from 'lucide-react';
import { EVENTS } from '@kiosk/shared';
import { kioskApi, newKey, parkKioskApi, storage } from '../lib/api';
import { money } from '../lib/format';
import { LangSwitcher, defineStrings, useT } from '../lib/lang';
import { useRealtime, useSocketEvent, watch } from '../lib/socket';
import { Button, Loading, toast } from '../components/ui';
import { KioskSetup } from '../kiosk/KioskSetup';
import { CustomerProvider, useBoot } from '../park/CustomerShell';
import { CameraScanner, QrCode, useScanner } from '../park/scan';
import { Stepper } from '../park/ui';

const K = defineStrings('pkiosk', {
  welcome: { th: 'ยินดีต้อนรับ', en: 'Welcome', zh: '欢迎' },
  touch: { th: 'แตะเพื่อเริ่มต้น', en: 'Touch to start', zh: '点击开始' },
  buyTickets: { th: 'ซื้อบัตรเข้าสวน', en: 'Buy tickets', zh: '购买门票' },
  checkCard: { th: 'เช็คยอดเงิน / สิทธิ์', en: 'Check balance & passes', zh: '查询余额和权益' },
  topup: { th: 'เติมเงินเข้าบัตร', en: 'Top up card', zh: '卡充值' },
  queue: { th: 'จองคิวเครื่องเล่น', en: 'Join a ride queue', zh: '游乐设施排队' },
  food: { th: 'สั่งอาหาร', en: 'Order food', zh: '点餐' },
  scanCard: { th: 'สแกนบัตร / ริสแบนด์ / QR ที่เครื่องอ่าน', en: 'Scan your card / wristband / QR at the reader', zh: '请在读卡器扫描卡 / 腕带 / 二维码' },
  checkout: { th: 'ชำระเงิน', en: 'Checkout', zh: '结算' },
  howToPay: { th: 'เลือกวิธีชำระเงิน', en: 'How would you like to pay?', zh: '请选择支付方式' },
  payQr: { th: 'สแกนจ่าย พร้อมเพย์', en: 'PromptPay QR', zh: 'PromptPay 扫码' },
  payCard: { th: 'บัตรเครดิต / เดบิต', en: 'Credit / debit card', zh: '银行卡' },
  payCash: { th: 'เงินสดที่เคาน์เตอร์', en: 'Cash at the counter', zh: '柜台现金' },
  payWallet: { th: 'เงินในบัตร', en: 'Card wallet', zh: '卡内余额' },
  scanToPay: { th: 'สแกน QR ด้วยแอปธนาคาร', en: 'Scan with your banking app', zh: '用银行App扫码' },
  tapCard: { th: 'แตะ / เสียบบัตรที่เครื่องรูดบัตร', en: 'Tap or insert your card on the terminal', zh: '请在刷卡机上挥卡或插卡' },
  cashAt: { th: 'แจ้งหมายเลขนี้ที่เคาน์เตอร์เพื่อชำระเงินสด', en: 'Show this number at the counter to pay cash', zh: '请到柜台出示此号码现金付款' },
  success: { th: 'ชำระเงินสำเร็จ!', en: 'Payment successful!', zh: '支付成功！' },
  takeTickets: { th: 'กรุณารับตั๋วและใบเสร็จจากเครื่องพิมพ์', en: 'Please take your tickets and receipt', zh: '请取走门票和收据' },
  ticketsBelow: { th: 'หรือถ่ายรูป QR ด้านล่างเก็บไว้', en: 'Or take a photo of the QR codes below', zh: '或拍下下方二维码' },
  amount: { th: 'จำนวนเงิน', en: 'Amount', zh: '金额' },
  partySize: { th: 'จำนวนคน', en: 'Party size', zh: '人数' },
  yourQueue: { th: 'หมายเลขคิวของคุณ', en: 'Your queue number', zh: '您的排队号' },
  ahead: { th: 'รออีก {n} คิว · ประมาณ {m} นาที', en: '{n} ahead · about {m} min', zh: '前面{n}位 · 约{m}分钟' },
  notOpen: { th: 'ปิด', en: 'Closed', zh: '关闭' },
  restart: { th: 'เริ่มใหม่', en: 'Start over', zh: '重新开始' },
  name: { th: 'ชื่อ', en: 'Name', zh: '姓名' },
  noTickets: { th: 'ไม่มีตั๋วที่ใช้งาน', en: 'No active tickets', zh: '没有有效门票' },
  usesLeft: { th: 'เหลือ {n} ครั้ง', en: '{n} left', zh: '剩余{n}次' },
  unlimited: { th: 'ไม่จำกัด', en: 'Unlimited', zh: '无限次' },
  simulate: { th: 'จำลองชำระสำเร็จ', en: 'Simulate success', zh: '模拟成功' },
});

type Screen = 'home' | 'buy' | 'card' | 'topup' | 'queue' | 'pay' | 'done';

export default function ParkKiosk() {
  const [token, setToken] = useState(storage.get('kiosk_token'));
  if (!token) return <KioskSetup onPaired={(t) => { history.replaceState(null, '', '/park-kiosk'); setToken(t); }} />;
  return (
    <CustomerProvider surface="kiosk">
      <KioskInner token={token} />
    </CustomerProvider>
  );
}

function KioskInner({ token }: { token: string }) {
  const t = useT(K);
  const b = useBoot();
  const [screen, setScreen] = useState<Screen>('home');
  const [sale, setSale] = useState<any>(null);
  const [card, setCard] = useState<string | null>(null);
  const { socket } = useRealtime({ kioskToken: token });
  const lastTouch = useRef(Date.now());
  const reset = () => {
    setScreen('home');
    setSale(null);
    setCard(null);
  };
  useEffect(() => {
    const touch = () => (lastTouch.current = Date.now());
    window.addEventListener('pointerdown', touch);
    window.addEventListener('keydown', touch);
    const i = setInterval(() => {
      if (screen !== 'home' && screen !== 'pay' && Date.now() - lastTouch.current > 90_000) reset();
    }, 5000);
    return () => {
      window.removeEventListener('pointerdown', touch);
      window.removeEventListener('keydown', touch);
      clearInterval(i);
    };
  }, [screen]);
  const startPay = (s: any) => {
    setSale(s);
    setScreen('pay');
  };
  return (
    <div className="kiosk-root flex h-full flex-col">
      <header className="flex items-center gap-3 px-6 py-4">
        {screen !== 'home' && <button onClick={reset} className="press rounded-2xl bg-white p-3 shadow"><ArrowLeft className="h-7 w-7" /></button>}
        <img src={b.settings.park.logoUrl || '/icon.svg'} alt="" className="h-12 w-12 rounded-2xl" />
        <div className="text-2xl font-extrabold">{t.tr(b.settings.park.name)}</div>
        <div className="ml-auto"><LangSwitcher /></div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        {screen === 'home' && <Home go={setScreen} />}
        {screen === 'buy' && <BuyTickets onCheckout={startPay} />}
        {screen === 'card' && <CardCheck />}
        {screen === 'topup' && <Topup card={card} setCard={setCard} onCheckout={startPay} />}
        {screen === 'queue' && <Queue />}
        {screen === 'pay' && sale && <Pay sale={sale} socket={socket} onPaid={(d) => { setSale(d); setScreen('done'); }} onCancel={reset} />}
        {screen === 'done' && sale && <Done sale={sale} onDone={reset} />}
      </main>
    </div>
  );
}

function Home({ go }: { go: (s: Screen) => void }) {
  const t = useT(K);
  const tiles = [
    { s: 'buy' as Screen, icon: Ticket, label: t('buyTickets'), tone: 'from-primary to-orange-600' },
    { s: 'topup' as Screen, icon: Wallet, label: t('topup'), tone: 'from-emerald-500 to-emerald-700' },
    { s: 'card' as Screen, icon: Search, label: t('checkCard'), tone: 'from-sky-500 to-indigo-600' },
    { s: 'queue' as Screen, icon: Timer, label: t('queue'), tone: 'from-violet-500 to-fuchsia-600' },
  ];
  return (
    <div className="mx-auto grid max-w-5xl gap-5 pt-6 sm:grid-cols-2">
      {tiles.map((x) => (
        <button key={x.s} onClick={() => go(x.s)} className={`press flex min-h-52 flex-col justify-between rounded-[2rem] bg-gradient-to-br ${x.tone} p-8 text-left text-white shadow-xl`}>
          <x.icon className="h-16 w-16" />
          <span className="text-3xl font-extrabold">{x.label}</span>
        </button>
      ))}
      <a href="/kiosk" className="press flex items-center gap-4 rounded-[2rem] bg-white p-6 text-2xl font-bold shadow sm:col-span-2"><UtensilsCrossed className="h-10 w-10 text-primary" /> {t('food')}</a>
    </div>
  );
}

function ScanPrompt({ onScan, busy }: { onScan: (c: string) => void; busy?: boolean }) {
  const t = useT(K);
  const [cam, setCam] = useState(false);
  useScanner(onScan, { enabled: !busy });
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-5 pt-10 text-center">
      <QrIcon className="h-24 w-24 animate-pulse text-primary" />
      <div className="text-3xl font-bold">{t('scanCard')}</div>
      <Button variant="outline" size="lg" onClick={() => setCam((c) => !c)}>{t('camera')}</Button>
      {cam && <CameraScanner active onScan={onScan} className="aspect-video w-full" facing="user" />}
    </div>
  );
}

function BuyTickets({ onCheckout }: { onCheckout: (s: any) => void }) {
  const t = useT(K);
  const cat = useQuery({ queryKey: ['pk-catalog'], queryFn: () => kioskApi('/park/catalog') });
  const [cart, setCart] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  if (!cat.data) return <Loading />;
  const lines = Object.entries(cart).filter(([, q]) => q > 0).map(([k, qty]) => {
    const [refId, tt] = k.split('|');
    return { type: 'PACKAGE', refId, ticketTypeId: tt || null, qty };
  });
  const priceOf = (k: string) => {
    const [pid, tt] = k.split('|');
    const p = cat.data.packages.find((x: any) => x.id === pid);
    const pr = p?.prices.find((x: any) => (x.ticket_type_id ?? '') === tt);
    return pr?.unit_price ?? Number(p?.base_price ?? 0);
  };
  const total = Object.entries(cart).reduce((s, [k, q]) => s + priceOf(k) * q, 0);
  return (
    <div className="mx-auto max-w-5xl">
      <div className="space-y-4">
        {cat.data.packages.filter((p: any) => p.kind === 'ADMISSION' && p.availability.available).map((p: any) => (
          <div key={p.id} className="rounded-[2rem] bg-white p-5 shadow">
            <div className="flex items-center gap-3"><span className="h-5 w-5 rounded-full" style={{ background: p.color }} /><span className="text-2xl font-bold">{t.tr(p.name)}</span></div>
            <div className="mt-1 text-slate-600">{t.tr(p.description)}</div>
            <div className="mt-3 divide-y">
              {(p.prices.length ? p.prices : [{ ticket_type_id: null, unit_price: Number(p.base_price) }]).map((pr: any) => {
                const k = `${p.id}|${pr.ticket_type_id ?? ''}`;
                return (
                  <div key={k} className="flex items-center gap-4 py-3 text-xl">
                    <span className="flex-1">{pr.ticket_type_name ? t.tr(pr.ticket_type_name) : t.tr(p.name)}</span>
                    <b>{money(pr.unit_price)}</b>
                    <Stepper value={cart[k] ?? 0} onChange={(v) => setCart({ ...cart, [k]: v })} max={p.max_qty} />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="sticky bottom-0 mt-5 flex items-center gap-4 rounded-[2rem] bg-slate-900 p-5 text-white shadow-2xl">
        <div className="flex-1 text-3xl font-extrabold">{money(total)}</div>
        <Button size="xl" disabled={!lines.length} loading={busy} onClick={async () => {
          setBusy(true);
          try {
            const d = await parkKioskApi('/sales', { body: { channel: 'KIOSK', lines, clientRef: newKey(), language: t.lang } });
            onCheckout(d);
          } catch (e) { toast.error(t.err(e)); } finally { setBusy(false); }
        }}>{t('checkout')}</Button>
      </div>
    </div>
  );
}

function Pay({ sale, socket, onPaid, onCancel }: { sale: any; socket: any; onPaid: (d: any) => void; onCancel: () => void }) {
  const t = useT(K);
  const [payment, setPayment] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const saleId = sale.sale.id;
  const check = async () => {
    const d = await parkKioskApi(`/sales/${saleId}`);
    if (d.sale.status === 'PAID') onPaid(d);
  };
  useEffect(() => watch(socket, 'sale', saleId), [socket, saleId]);
  useSocketEvent(socket, [EVENTS.SALE_PAID, EVENTS.SALE_UPDATED], (d) => d?.saleId === saleId && void check());
  useEffect(() => {
    const i = setInterval(() => void check(), 5000);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saleId]);
  const start = async (method: string) => {
    setBusy(true);
    try {
      if (payment) await parkKioskApi(`/sales/${saleId}/payments/${payment.id}/cancel`, { method: 'POST' }).catch(() => {});
      const r = await parkKioskApi(`/sales/${saleId}/payments`, { body: { method }, idempotencyKey: newKey() });
      setPayment(r.payment);
      if (r.completed) await check();
    } catch (e) { toast.error(t.err(e)); } finally { setBusy(false); }
  };
  const total = Number(sale.sale.total);
  const methods = [
    { m: 'PROMPTPAY', icon: QrIcon, label: t('payQr') },
    { m: 'CARD', icon: CreditCard, label: t('payCard') },
    { m: 'CASH', icon: Banknote, label: t('payCash') },
  ];
  return (
    <div className="mx-auto max-w-4xl text-center">
      <div className="text-xl text-slate-600">{t('total')}</div>
      <div className="text-6xl font-extrabold">{money(total)}</div>
      {!payment ? (
        <>
          <div className="mt-8 mb-4 text-2xl font-bold">{t('howToPay')}</div>
          <div className="grid gap-4 sm:grid-cols-3">
            {methods.map((x) => (
              <button key={x.m} disabled={busy} onClick={() => start(x.m)} className="press flex flex-col items-center gap-3 rounded-[2rem] bg-white p-8 text-xl font-bold shadow-lg">
                <x.icon className="h-14 w-14 text-primary" />{x.label}
              </button>
            ))}
          </div>
        </>
      ) : payment.qr_payload ? (
        <div className="mt-6 inline-flex flex-col items-center gap-3 rounded-[2rem] bg-white p-8 shadow-lg">
          <QrCode value={payment.qr_payload} size={300} />
          <div className="text-xl">{t('scanToPay')}</div>
          {payment.provider === 'sandbox' && <Button variant="ghost" size="sm" onClick={() => parkKioskApi(`/sales/${saleId}/payments/${payment.id}/sandbox`, { body: { outcome: 'succeeded' } }).then(check).catch((e) => toast.error(t.err(e)))}>Sandbox · {t('simulate')}</Button>}
        </div>
      ) : payment.status === 'WAITING_CASH' ? (
        <div className="mt-6 rounded-[2rem] bg-white p-8 shadow-lg">
          <div className="text-xl">{t('cashAt')}</div>
          <div className="my-4 font-mono text-5xl font-extrabold tracking-widest">{sale.sale.sale_no}</div>
          <QrCode value={sale.sale.sale_no} size={160} className="mx-auto" />
        </div>
      ) : (
        <div className="mt-6 rounded-[2rem] bg-white p-8 shadow-lg">
          <CreditCard className="mx-auto h-20 w-20 animate-pulse text-primary" />
          <div className="mt-3 text-2xl">{t('tapCard')}</div>
          {payment.provider === 'sandbox' && <Button variant="ghost" size="sm" className="mt-3" onClick={() => parkKioskApi(`/sales/${saleId}/payments/${payment.id}/sandbox`, { body: { outcome: 'succeeded' } }).then(check).catch((e) => toast.error(t.err(e)))}>Sandbox · {t('simulate')}</Button>}
        </div>
      )}
      <div className="mt-8 flex justify-center gap-3">
        {payment && <Button variant="outline" size="lg" onClick={() => setPayment(null)}>{t('back')}</Button>}
        <Button variant="ghost" size="lg" onClick={async () => { await parkKioskApi(`/sales/${saleId}/cancel`, { body: { reason: 'KIOSK_CANCELLED' } }).catch(() => {}); onCancel(); }}>{t('cancel')}</Button>
      </div>
    </div>
  );
}

function Done({ sale, onDone }: { sale: any; onDone: () => void }) {
  const t = useT(K);
  const [n, setN] = useState(45);
  useEffect(() => {
    const i = setInterval(() => setN((x) => (x <= 1 ? (onDone(), 0) : x - 1)), 1000);
    return () => clearInterval(i);
  }, [onDone]);
  return (
    <div className="mx-auto max-w-4xl text-center">
      <CheckCircle2 className="mx-auto h-24 w-24 text-emerald-500" />
      <div className="mt-2 text-4xl font-extrabold">{t('success')}</div>
      <div className="mt-2 text-xl text-slate-600">{t('takeTickets')}</div>
      {sale.tickets?.length > 0 && (
        <>
          <div className="mt-1 text-slate-500">{t('ticketsBelow')}</div>
          <div className="mt-5 flex flex-wrap justify-center gap-4">
            {sale.tickets.map((tk: any) => (
              <div key={tk.id} className="rounded-3xl bg-white p-4 shadow">
                {tk.qr ? <QrCode value={tk.qr} size={140} /> : null}
                <div className="mt-1 font-mono text-xs">{tk.ticket_no}</div>
                <div className="text-sm">{t.tr(tk.ticket_type_name)}</div>
              </div>
            ))}
          </div>
        </>
      )}
      <Button size="xl" className="mt-8" onClick={onDone}>{t('done')} ({n})</Button>
    </div>
  );
}

function CardSummary({ d }: { d: any }) {
  const t = useT(K);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="rounded-[2rem] bg-slate-900 p-6 text-white">
        <div className="text-white/70">{d.name ?? d.code}</div>
        <div className="text-5xl font-extrabold">{d.balance != null ? money(d.balance) : '—'}</div>
        {d.points != null && <div className="mt-1 text-lg">{t('points')}: {d.points}</div>}
      </div>
      <div className="rounded-[2rem] bg-white p-5 shadow">
        {!d.tickets.length ? <div className="text-slate-500">{t('noTickets')}</div> : d.tickets.map((x: any) => (
          <div key={x.ticketNo} className="flex justify-between py-2 text-lg"><span>{t.tr(x.package)} · {t.tr(x.ticketType)}</span><span>{t.status(x.status)}</span></div>
        ))}
      </div>
      {d.rides.length > 0 && (
        <div className="flex flex-wrap gap-2 rounded-[2rem] bg-white p-5 shadow">
          {d.rides.map((r: any, i: number) => <span key={i} className="rounded-full bg-emerald-50 px-4 py-2 text-emerald-800">{t.tr(r.ride) || '★'} · {r.type === 'UNLIMITED' ? t('unlimited') : t('usesLeft', { n: r.usesLeft ?? 0 })}</span>)}
        </div>
      )}
      {d.queues.length > 0 && <div className="rounded-[2rem] bg-white p-5 shadow">{d.queues.map((q: any) => <div key={q.queueNo} className="text-lg"><b>{q.queueNo}</b> · {t.tr(q.ride)} · {t.status(q.status)}</div>)}</div>}
    </div>
  );
}

function CardCheck() {
  const t = useT(K);
  const [d, setD] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const scan = async (code: string) => {
    setBusy(true);
    try {
      setD(await kioskApi('/park/card', { body: { code } }));
    } catch (e) { toast.error(t.err(e)); } finally { setBusy(false); }
  };
  return d ? <CardSummary d={d} /> : <ScanPrompt onScan={scan} busy={busy} />;
}

function Topup({ card, setCard, onCheckout }: { card: string | null; setCard: (c: string) => void; onCheckout: (s: any) => void }) {
  const t = useT(K);
  const b = useBoot();
  const [info, setInfo] = useState<any>(null);
  const [amount, setAmount] = useState<number>(b.settings.wallet.quickAmounts?.[1] ?? 300);
  const [busy, setBusy] = useState(false);
  if (!card || !info) return <ScanPrompt busy={busy} onScan={async (code) => {
    setBusy(true);
    try {
      setInfo(await kioskApi('/park/card', { body: { code } }));
      setCard(code);
    } catch (e) { toast.error(t.err(e)); } finally { setBusy(false); }
  }} />;
  return (
    <div className="mx-auto max-w-3xl text-center">
      <div className="text-xl text-slate-600">{info.name ?? info.code} · {t('balance')} {money(info.balance ?? 0)}</div>
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {(b.settings.wallet.quickAmounts ?? [100, 300, 500, 1000]).map((a: number) => (
          <button key={a} onClick={() => setAmount(a)} className={clsx('press rounded-[1.5rem] border-4 bg-white py-8 text-3xl font-extrabold shadow', amount === a ? 'border-primary text-primary' : 'border-transparent')}>{money(a)}</button>
        ))}
      </div>
      <Button size="xl" className="mt-8" loading={busy} onClick={async () => {
        setBusy(true);
        try {
          onCheckout(await parkKioskApi('/sales', { body: { channel: 'KIOSK', credentialCode: card, lines: [{ type: 'TOPUP', amount, qty: 1 }], clientRef: newKey(), language: t.lang } }));
        } catch (e) { toast.error(t.err(e)); } finally { setBusy(false); }
      }}>{t('topup')} {money(amount)}</Button>
    </div>
  );
}

function Queue() {
  const t = useT(K);
  const rides = useQuery({ queryKey: ['pk-rides'], queryFn: () => parkKioskApi('/rides') });
  const [ride, setRide] = useState<any>(null);
  const [party, setParty] = useState(1);
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  if (res) return (
    <div className="mx-auto max-w-xl rounded-[2rem] bg-white p-10 text-center shadow-lg">
      <div className="text-xl text-slate-600">{t.tr(res.ride.name)} · {t('yourQueue')}</div>
      <div className="my-4 text-8xl font-extrabold text-primary">{res.queueNo}</div>
      <div className="text-xl">{t('ahead', { n: res.ahead, m: res.waitMinutes })}</div>
    </div>
  );
  if (ride) return (
    <div>
      <div className="mb-4 flex items-center justify-center gap-4 text-2xl font-bold">{t.tr(ride.name)} · {t('partySize')} <Stepper value={party} onChange={setParty} min={1} max={10} /></div>
      <ScanPrompt busy={busy} onScan={async (code) => {
        setBusy(true);
        try {
          setRes(await parkKioskApi(`/rides/${ride.id}/queue/join`, { body: { code, partySize: party } }));
        } catch (e) { toast.error(t.err(e)); } finally { setBusy(false); }
      }} />
    </div>
  );
  if (!rides.data) return <Loading />;
  return (
    <div className="mx-auto grid max-w-5xl gap-4 sm:grid-cols-2">
      {rides.data.filter((r: any) => r.queue_enabled).map((r: any) => (
        <button key={r.id} disabled={r.status !== 'OPEN'} onClick={() => setRide(r)} className="press flex items-center gap-4 rounded-[2rem] bg-white p-6 text-left shadow disabled:opacity-40">
          <Timer className="h-10 w-10 text-primary" />
          <div className="flex-1"><div className="text-2xl font-bold">{t.tr(r.name)}</div><div className="text-slate-500">{r.status === 'OPEN' ? `~${r.wait_minutes ?? 0} ${t('minutes')}` : t('notOpen')}</div></div>
        </button>
      ))}
    </div>
  );
}
