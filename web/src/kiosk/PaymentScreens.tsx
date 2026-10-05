import { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import QRCode from 'qrcode';
import { Banknote, BellRing, CreditCard, Loader2, QrCode, Receipt, RefreshCw, ShoppingBag, Upload, Utensils, Wallet, WifiOff, XCircle, Check, Nfc } from 'lucide-react';
import { tr } from '@kiosk/shared';
import { kioskApi } from '../lib/api';
import { useK } from './context';
import { KButton, KioskHeader, Logo } from './components';
import { Summary } from './CartScreen';
import type { ActiveOrder, ActivePayment } from './store';

export type Method = 'QR' | 'CASH' | 'CARD' | 'OTHER';

function Shell({ children, onHome, header = true }: { children: ReactNode; onHome?: () => void; header?: boolean }) {
  return (
    <div className="flex h-full flex-col">
      {header && onHome && <KioskHeader onHome={onHome} />}
      <div className="scroll-thin flex flex-1 flex-col items-center justify-center overflow-y-auto p-8">{children}</div>
    </div>
  );
}

function BigNumber({ n, tone = 'primary' }: { n: string; tone?: 'primary' | 'dark' }) {
  return <div className={clsx('font-black tracking-[0.06em] tabular-nums', tone === 'primary' ? 'text-primary' : 'text-ink')} style={{ fontSize: 'clamp(5rem, 14vmin, 11rem)', lineHeight: 1 }}>#{n}</div>;
}

export function useCountdown(until: string | number | null, active = true) {
  const target = until ? (typeof until === 'number' ? until : new Date(until).getTime()) : 0;
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((target - Date.now()) / 1000)));
  useEffect(() => {
    if (!target || !active) return;
    setLeft(Math.max(0, Math.ceil((target - Date.now()) / 1000)));
    const id = setInterval(() => setLeft(Math.max(0, Math.ceil((target - Date.now()) / 1000))), 250);
    return () => clearInterval(id);
  }, [target, active]);
  return left;
}

/* -------------------------------------------------------------- choose method */
export function PaymentMethodScreen({ methods, total, onPick, onBack, onHome, busy, offline }: { methods: Method[]; total: { subtotal: number; discount: number; serviceCharge: number; vat: number; total: number; appliedPromotions?: any[] }; onPick: (m: Method) => void; onBack: () => void; onHome: () => void; busy: Method | null; offline: boolean }) {
  const { t, data, lang } = useK();
  const info: Record<Method, { icon: any; title: string; sub: string; tone: string }> = {
    QR: { icon: QrCode, title: t('payQR'), sub: t('payQRSub'), tone: 'bg-sky-600' },
    CASH: { icon: Banknote, title: t('payCash'), sub: t('payCashSub'), tone: 'bg-emerald-600' },
    CARD: { icon: CreditCard, title: t('payCard'), sub: t('payCardSub'), tone: 'bg-violet-600' },
    OTHER: { icon: Wallet, title: tr(data.boot?.settings?.payment?.other?.label, lang) || t('payOther'), sub: t('payOtherSub'), tone: 'bg-slate-600' },
  };
  return (
    <div className="flex h-full flex-col">
      <KioskHeader onHome={onHome} />
      <div className="flex min-h-0 flex-1 flex-col gap-6 p-8 lg:flex-row">
        <div className="flex-1">
          <h2 className="mb-6 text-[2.4rem] font-extrabold">{t('choosePayment')}</h2>
          {offline && (
            <div className="mb-5 flex items-center gap-3 rounded-brand bg-amber-100 p-5 text-xl font-semibold text-amber-900">
              <WifiOff className="h-7 w-7" /> {t('offlineCashOnly')}
            </div>
          )}
          <div className="grid gap-5 md:grid-cols-2">
            {methods.map((m, i) => {
              const I = info[m];
              const disabled = (offline && m !== 'CASH') || !!busy;
              return (
                <button
                  key={m}
                  disabled={disabled}
                  onClick={() => onPick(m)}
                  style={{ animationDelay: `${i * 60}ms` }}
                  className="press anim-pop flex min-h-44 items-center gap-6 rounded-brand bg-surface p-7 text-left shadow-lg disabled:opacity-40"
                >
                  <div className={clsx('flex h-24 w-24 shrink-0 items-center justify-center rounded-3xl text-white', I.tone)}>{busy === m ? <Loader2 className="h-12 w-12 animate-spin" /> : <I.icon className="h-12 w-12" />}</div>
                  <div>
                    <div className="text-[1.8rem] leading-tight font-bold">{I.title}</div>
                    <div className="mt-1 text-lg text-black/55">{I.sub}</div>
                  </div>
                </button>
              );
            })}
          </div>
          <KButton variant="secondary" className="mt-8" onClick={onBack} disabled={!!busy}>
            ← {t('back')}
          </KButton>
        </div>
        <aside className="w-full shrink-0 self-start rounded-[calc(var(--brand-radius)*1.3)] bg-surface p-7 shadow-xl lg:w-[420px]">
          <Summary p={total} big />
        </aside>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- QR */
export function QrScreen({ order, payment, onVerify, onRenew, onChangeMethod, onHome, busy }: { order: ActiveOrder; payment: ActivePayment; onVerify: (slip: File | null) => void; onRenew: () => void; onChangeMethod: () => void; onHome: () => void; busy: boolean }) {
  const { t, money, data } = useK();
  const canvas = useRef<HTMLCanvasElement>(null);
  const left = useCountdown(payment.expiresAt);
  const [slip, setSlip] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const qr = data.boot?.settings?.payment?.qr ?? {};
  useEffect(() => {
    if (canvas.current && payment.qrPayload) void QRCode.toCanvas(canvas.current, payment.qrPayload, { width: 380, margin: 1, errorCorrectionLevel: 'M' });
  }, [payment.qrPayload]);
  const expired = !!payment.expiresAt && left <= 0;
  return (
    <Shell onHome={onHome}>
      <div className="grid w-full max-w-6xl items-center gap-10 lg:grid-cols-2">
        <div className="text-center lg:text-left">
          <div className="text-2xl font-semibold text-black/60">{t('orderRef')} #{order.number}</div>
          <div className="mt-4 text-3xl font-bold tracking-wide">{t('total')}</div>
          <div className="text-[clamp(4rem,10vmin,7.5rem)] leading-none font-black text-primary tabular-nums">{money(order.total)}</div>
          <div className="mt-6 text-2xl">{t('scanToPay')}</div>
          {qr.accountName && <div className="mt-2 text-xl text-black/55">{qr.bankName} · {qr.accountName}</div>}
          <div className="mt-8 flex flex-wrap gap-4">
            <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => setSlip(e.target.files?.[0] ?? null)} />
            {data.boot?.settings?.kiosk?.allowSlipUpload !== false && (
              <KButton variant="secondary" onClick={() => fileRef.current?.click()} icon={slip ? <Check className="h-6 w-6 text-emerald-600" /> : <Upload className="h-6 w-6" />}>
                {slip ? t('slipAttached') : t('uploadSlip')}
              </KButton>
            )}
          </div>
        </div>
        <div className="flex flex-col items-center gap-5 rounded-[2rem] bg-surface p-8 shadow-2xl">
          <div className="rounded-2xl bg-[#113566] px-6 py-2 text-xl font-bold tracking-wide text-white">PromptPay · QR</div>
          <div className={clsx('relative rounded-2xl bg-white p-3', expired && 'opacity-20 blur-sm')}>
            <canvas ref={canvas} className="h-[min(380px,40vh)] w-[min(380px,40vh)]" />
          </div>
          {expired ? (
            <div className="flex flex-col items-center gap-3">
              <div className="text-2xl font-bold text-rose-600">{t('qrExpired')}</div>
              <KButton onClick={onRenew} icon={<RefreshCw className="h-6 w-6" />}>
                {t('newQr')}
              </KButton>
            </div>
          ) : (
            payment.expiresAt && (
              <div className="text-xl text-black/60">
                {t('qrExpiresIn')} <span className={clsx('font-bold tabular-nums', left < 60 ? 'text-rose-600' : 'text-ink')}>{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>
              </div>
            )
          )}
        </div>
      </div>
      <div className="mt-10 flex w-full max-w-6xl flex-col gap-4 md:flex-row">
        <KButton size="xl" className="flex-1" onClick={() => onVerify(slip)} disabled={busy || expired} icon={busy ? <Loader2 className="h-8 w-8 animate-spin" /> : <Check className="h-9 w-9" />}>
          {t('checkPayment')}
        </KButton>
        <KButton variant="secondary" size="xl" onClick={onChangeMethod} disabled={busy}>
          {t('changeMethod')}
        </KButton>
      </div>
    </Shell>
  );
}

/* -------------------------------------------------------------- waiting verification */
export function VerifyingScreen({ order, onCallStaff, onChangeMethod }: { order: ActiveOrder; onCallStaff: () => void; onChangeMethod: () => void }) {
  const { t, money } = useK();
  return (
    <Shell>
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="relative flex h-44 w-44 items-center justify-center">
          <div className="absolute inset-0 animate-ping rounded-full bg-primary/20" />
          <div className="relative flex h-36 w-36 items-center justify-center rounded-full bg-primary text-white shadow-2xl">
            <Loader2 className="h-20 w-20 animate-spin" />
          </div>
        </div>
        <h2 className="text-[clamp(2.4rem,5vmin,4rem)] font-extrabold">{t('waitingVerification')}</h2>
        <p className="max-w-2xl text-2xl text-black/60">{t('waitingVerificationSub')}</p>
        <div className="rounded-brand bg-surface px-10 py-6 shadow-lg">
          <div className="text-xl text-black/50">{t('orderRef')}</div>
          <div className="text-6xl font-black tracking-wider">#{order.number}</div>
          <div className="mt-2 text-3xl font-bold text-primary">{money(order.total)}</div>
        </div>
        <div className="mt-4 flex gap-4">
          <KButton variant="secondary" onClick={onCallStaff} icon={<BellRing className="h-6 w-6" />}>
            {t('callStaff')}
          </KButton>
          <KButton variant="ghost" onClick={onChangeMethod}>
            {t('changeMethod')}
          </KButton>
        </div>
      </div>
    </Shell>
  );
}

/* -------------------------------------------------------------- cash / other at counter */
export function CounterScreen({ order, onChangeMethod, onCancel }: { order: ActiveOrder; onChangeMethod: () => void; onCancel: () => void }) {
  const { t, money } = useK();
  return (
    <Shell>
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="flex h-32 w-32 items-center justify-center rounded-full bg-emerald-600 text-white shadow-2xl">
          <Banknote className="h-16 w-16" />
        </div>
        <h2 className="text-[clamp(2.4rem,5vmin,4rem)] font-extrabold">{t('payAtCounter')}</h2>
        <p className="text-2xl text-black/60">{t('payAtCounterSub')}</p>
        <div className="rounded-[2rem] bg-surface px-16 py-8 shadow-2xl">
          <div className="text-2xl text-black/50">{t('orderRef')}</div>
          <BigNumber n={order.number} />
          <div className="mt-3 text-4xl font-extrabold">{money(order.total)}</div>
        </div>
        <div className="flex items-center gap-3 text-xl text-black/55">
          <Loader2 className="h-6 w-6 animate-spin" /> {t('waitingCashier')}
        </div>
        <div className="mt-2 flex gap-4">
          <KButton variant="secondary" onClick={onChangeMethod}>
            {t('changeMethod')}
          </KButton>
          <KButton variant="ghost" onClick={onCancel}>
            {t('cancelOrder')}
          </KButton>
        </div>
      </div>
    </Shell>
  );
}

/* -------------------------------------------------------------- card */
export function CardScreen({ order, status, reason, onCancel, onRetry, onChangeMethod }: { order: ActiveOrder; status: string; reason?: string | null; onCancel: () => void; onRetry: () => void; onChangeMethod: () => void }) {
  const { t, money } = useK();
  const declined = status === 'DECLINED' || status === 'CANCELLED';
  return (
    <Shell>
      <div className="flex flex-col items-center gap-6 text-center">
        <div className={clsx('flex h-40 w-40 items-center justify-center rounded-full text-white shadow-2xl', declined ? 'bg-rose-600' : 'anim-pulse-ring bg-violet-600')}>
          {declined ? <XCircle className="h-20 w-20" /> : status === 'PROCESSING' ? <Loader2 className="h-20 w-20 animate-spin" /> : <Nfc className="h-20 w-20" />}
        </div>
        <div className="text-3xl font-bold tracking-wide">{t('total')}</div>
        <div className="text-[clamp(4rem,10vmin,7rem)] leading-none font-black text-primary">{money(order.total)}</div>
        <h2 className="max-w-3xl text-[clamp(2rem,4vmin,3.2rem)] font-bold">{declined ? t('cardDeclined') : status === 'PROCESSING' ? t('cardProcessing') : t('tapCard')}</h2>
        {declined && reason && <div className="text-xl text-black/50">{reason}</div>}
        <div className="mt-4 flex gap-4">
          {declined ? (
            <>
              <KButton onClick={onRetry} icon={<RefreshCw className="h-6 w-6" />}>
                {t('tryAgain')}
              </KButton>
              <KButton variant="secondary" onClick={onChangeMethod}>
                {t('changeMethod')}
              </KButton>
            </>
          ) : (
            <KButton variant="secondary" onClick={onCancel} disabled={status === 'PROCESSING'}>
              {t('cancel')}
            </KButton>
          )}
        </div>
      </div>
    </Shell>
  );
}

/* -------------------------------------------------------------- rejected / failed */
export function FailedScreen({ onRetry, onChangeMethod, onCallStaff, reason }: { onRetry: () => void; onChangeMethod: () => void; onCallStaff: () => void; reason?: string | null }) {
  const { t } = useK();
  const [called, setCalled] = useState(false);
  return (
    <Shell>
      <div className="flex max-w-3xl flex-col items-center gap-6 text-center">
        <div className="flex h-36 w-36 items-center justify-center rounded-full bg-rose-600 text-white shadow-2xl">
          <XCircle className="h-20 w-20" />
        </div>
        <h2 className="text-[clamp(2.2rem,4.5vmin,3.6rem)] font-extrabold">{t('paymentFailed')}</h2>
        <p className="text-2xl leading-relaxed text-black/70">{t('paymentRejected')}</p>
        {reason && <p className="rounded-xl bg-rose-50 px-5 py-3 text-xl text-rose-700">{reason}</p>}
        <div className="mt-4 grid w-full gap-4 md:grid-cols-3">
          <KButton onClick={onRetry} icon={<RefreshCw className="h-6 w-6" />}>
            {t('tryAgain')}
          </KButton>
          <KButton variant="dark" onClick={onChangeMethod}>
            {t('changeMethod')}
          </KButton>
          <KButton
            variant="secondary"
            onClick={() => {
              onCallStaff();
              setCalled(true);
            }}
            icon={<BellRing className="h-6 w-6" />}
          >
            {t('callStaff')}
          </KButton>
        </div>
        {called && <div className="text-xl font-semibold text-emerald-700">{t('staffCalled')}</div>}
      </div>
    </Shell>
  );
}

/* -------------------------------------------------------------- success */
export function SuccessScreen({ order, onDone, seconds }: { order: ActiveOrder; onDone: () => void; seconds: number }) {
  const { t } = useK();
  const left = useCountdown(Date.now() + seconds * 1000);
  const fired = useRef(false);
  useEffect(() => {
    if (left <= 0 && !fired.current) {
      fired.current = true;
      onDone();
    }
  }, [left, onDone]);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-gradient-to-b from-emerald-50 to-bg p-8 text-center">
      <svg viewBox="0 0 52 52" className="h-40 w-40 drop-shadow-xl">
        <circle cx="26" cy="26" r="25" fill="#16a34a" />
        <path className="check-path" fill="none" stroke="white" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" d="M14 27 l8 8 l16 -17" />
      </svg>
      <h2 className="text-[clamp(2.4rem,5.5vmin,4.4rem)] font-black tracking-wide text-emerald-700">✓ {t('paymentSuccess')}</h2>
      <div className="anim-pop rounded-[2.4rem] bg-surface px-20 py-10 shadow-2xl">
        <div className="text-3xl font-semibold text-black/55">{t('yourNumber')}</div>
        <BigNumber n={order.number} />
        <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-secondary px-6 py-2 text-2xl font-bold text-white">
          {order.orderType === 'TAKE_AWAY' ? <ShoppingBag className="h-6 w-6" /> : <Utensils className="h-6 w-6" />}
          {order.orderType === 'TAKE_AWAY' ? t('takeAwayBadge') : t('dineInBadge')}
        </div>
      </div>
      <div className="flex items-center gap-3 text-2xl text-black/70">
        <Receipt className="h-8 w-8" /> {t('takeReceipt')}
      </div>
      <div className="text-xl text-black/45">{t('backHomeIn', { n: left })}</div>
      <KButton size="lg" onClick={onDone} className="min-w-72">
        {t('done')}
      </KButton>
    </div>
  );
}

/* -------------------------------------------------------------- offline saved */
export function OfflineSavedScreen({ refCode, total, onDone, seconds }: { refCode: string; total: number; onDone: () => void; seconds: number }) {
  const { t, money } = useK();
  const left = useCountdown(Date.now() + seconds * 1000);
  const fired = useRef(false);
  useEffect(() => {
    if (left <= 0 && !fired.current) {
      fired.current = true;
      onDone();
    }
  }, [left, onDone]);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="flex h-32 w-32 items-center justify-center rounded-full bg-amber-500 text-white shadow-2xl">
        <WifiOff className="h-16 w-16" />
      </div>
      <h2 className="text-[clamp(2.2rem,5vmin,4rem)] font-extrabold">{t('offlineSaved')}</h2>
      <p className="max-w-3xl text-2xl text-black/60">{t('offlineSavedSub')}</p>
      <div className="rounded-[2rem] bg-surface px-16 py-8 shadow-2xl">
        <div className="text-6xl font-black tracking-wider text-primary">{refCode}</div>
        <div className="mt-3 text-4xl font-extrabold">{money(total)}</div>
      </div>
      <div className="text-xl text-black/45">{t('backHomeIn', { n: left })}</div>
      <KButton onClick={onDone}>{t('done')}</KButton>
    </div>
  );
}

export function KioskBlocking({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-bg p-10 text-center">
      <Logo size={80} />
      <Loader2 className="h-12 w-12 animate-spin text-primary" />
      <div className="text-3xl font-bold">{title}</div>
      {sub && <div className="max-w-xl text-xl text-black/55">{sub}</div>}
    </div>
  );
}

export async function uploadSlip(orderId: string, file: File): Promise<string | null> {
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await kioskApi<{ url: string }>(`/orders/${orderId}/slip`, { method: 'POST', body: fd, timeoutMs: 60000 });
    return r.url;
  } catch {
    return null;
  }
}
