import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EVENTS, type Lang, type MenuProduct, type OrderType } from '@kiosk/shared';
import { ApiError, kioskApi, storage } from '../lib/api';
import { applyFont, applyTheme } from '../lib/theme';
import { makeT, type Overrides } from '../lib/i18n';
import { useOnReconnect, useRealtime, useSocketEvent } from '../lib/socket';
import { chime } from '../lib/sound';
import { outbox, offlineRef as makeOfflineRef } from '../lib/offline';
import { APP_VERSION } from '../lib/device';
import { money as fmtMoney } from '../lib/format';
import { useBrowserPrintExecutor } from '../printing/executor';
import { KioskContext, type KioskContextValue } from './context';
import { useKioskData } from './useKioskData';
import { useKiosk, type ActiveOrder, type ActivePayment } from './store';
import { KioskSetup } from './KioskSetup';
import { WelcomeScreen } from './WelcomeScreen';
import { OrderTypeScreen } from './OrderTypeScreen';
import { MenuScreen, useCartPricing } from './MenuScreen';
import { ProductModal, UpsellModal } from './ProductModal';
import { CartScreen } from './CartScreen';
import { CardScreen, CounterScreen, FailedScreen, KioskBlocking, OfflineSavedScreen, PaymentMethodScreen, QrScreen, SuccessScreen, uploadSlip, VerifyingScreen, type Method } from './PaymentScreens';
import { KButton } from './components';
import { KioskMaintenance } from './KioskMaintenance';

type Screen = 'welcome' | 'orderType' | 'menu' | 'cart' | 'payment' | 'qr' | 'verifying' | 'counter' | 'card' | 'failed' | 'success' | 'offlineSaved';
const IDLE_SCREENS: Screen[] = ['orderType', 'menu', 'cart', 'payment', 'failed', 'qr'];

export default function KioskApp() {
  const [token, setToken] = useState(storage.get('kiosk_token'));
  const [err, setErr] = useState<string | null>(null);
  if (!token) return <KioskSetup onPaired={setToken} initialError={err} />;
  return (
    <KioskRuntime
      key={token}
      token={token}
      onUnpair={(why) => {
        storage.set('kiosk_token', null);
        setErr(why ?? null);
        setToken(null);
      }}
    />
  );
}

function toOrder(o: any, items: any[] = []): ActiveOrder {
  return {
    id: o.id,
    number: o.order_number,
    total: Number(o.total),
    subtotal: Number(o.subtotal),
    discount: Number(o.discount),
    serviceCharge: Number(o.service_charge),
    vat: Number(o.vat),
    orderType: o.order_type,
    items,
  };
}
function toPayment(p: any): ActivePayment {
  return { id: p.id, method: p.method, status: p.status, qrPayload: p.qr_payload ?? null, expiresAt: p.expires_at ?? null, amount: Number(p.amount) };
}

function KioskRuntime({ token, onUnpair }: { token: string; onUnpair: (why?: string) => void }) {
  const data = useKioskData();
  const store = useKiosk();
  const { lang, lines, orderType, order, payment } = store;
  const [screen, setScreen] = useState<Screen>('welcome');
  const [modal, setModal] = useState<{ product: MenuProduct; lineKey?: string; upsellSourceProductId?: string | null; specialPrice?: number | null } | null>(null);
  const [upsell, setUpsell] = useState<MenuProduct | null>(null);
  const [busyMethod, setBusyMethod] = useState<Method | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failReason, setFailReason] = useState<string | null>(null);
  const [cardStatus, setCardStatus] = useState<{ status: string; reason?: string | null }>({ status: 'WAITING_CARD' });
  const [idleLeft, setIdleLeft] = useState<number | null>(null);
  const [maint, setMaint] = useState(false);
  const [confirmHome, setConfirmHome] = useState(false);
  const lastTouch = useRef(Date.now());
  const offlineTotalRef = useRef(0);
  const cartTotalRef = useRef(0);
  const screenRef = useRef(screen);
  screenRef.current = screen;

  const { socket, connected } = useRealtime({ kioskToken: token });
  const [browserOnline, setBrowserOnline] = useState(navigator.onLine);
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    const on = () => setBrowserOnline(true);
    const off = () => setBrowserOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const g = setTimeout(() => setGraceOver(true), 5000);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      clearTimeout(g);
    };
  }, []);
  const online = browserOnline && (connected || !graceOver);
  const printer = useBrowserPrintExecutor(socket, true);

  // Token revoked / kiosk deleted → back to pairing.
  useEffect(() => {
    if (data.error?.status === 401) onUnpair('This kiosk token is no longer valid. Please pair again.');
  }, [data.error, onUnpair]);

  const boot = data.boot;
  const defaultLang: Lang = (boot?.kiosk.defaultLanguage as Lang) ?? 'th';
  useEffect(() => {
    if (boot && screenRef.current === 'welcome') store.setLang(defaultLang);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot?.kiosk.defaultLanguage]);

  useEffect(() => {
    if (!boot) return;
    applyTheme({ ...boot.settings.theme, ...(boot.kiosk.theme ?? {}) });
    applyFont(boot.settings.fonts?.kiosk, boot.fonts);
    document.documentElement.lang = lang;
  }, [boot, lang]);

  const overrides: Overrides = useMemo(() => Object.fromEntries((boot?.languages ?? []).map((l) => [l.code, l.overrides ?? {}])), [boot]);
  const t = useMemo(() => makeT(lang, overrides), [lang, overrides]);
  const enabledLangs = useMemo(() => ((boot?.languages ?? []).filter((l) => l.enabled).map((l) => l.code) as Lang[]).filter((l) => ['th', 'en', 'zh'].includes(l)), [boot]);
  const sym = boot?.settings?.store?.currencySymbol ?? '฿';
  const money = useCallback((n: number | string | null | undefined) => fmtMoney(n, sym), [sym]);

  const orderTypes: OrderType[] = useMemo(() => {
    const s = (boot?.settings?.order?.orderTypes ?? {}) as Record<string, boolean>;
    return (['DINE_IN', 'TAKE_AWAY'] as OrderType[]).filter((x) => s[x] !== false && (boot?.kiosk.orderTypes ?? ['DINE_IN', 'TAKE_AWAY']).includes(x));
  }, [boot]);
  const methods: Method[] = useMemo(() => {
    const s = (boot?.settings?.payment?.methods ?? {}) as Record<string, boolean>;
    return (['QR', 'CASH', 'CARD', 'OTHER'] as Method[]).filter((m) => s[m] && (boot?.kiosk.paymentMethods ?? []).includes(m));
  }, [boot]);

  /* ------------------------------------------------------------ session reset */
  const resetSession = useCallback(
    (opts: { cancelOrder?: boolean } = {}) => {
      const st = useKiosk.getState();
      if (opts.cancelOrder && st.order) kioskApi(`/orders/${st.order.id}/cancel`, { method: 'POST' }).catch(() => {});
      st.reset(defaultLang);
      setModal(null);
      setUpsell(null);
      setNotice(null);
      setFailReason(null);
      setIdleLeft(null);
      setBusy(false);
      setBusyMethod(null);
      setScreen('welcome');
    },
    [defaultLang],
  );

  /* ------------------------------------------------------------ idle timeout */
  const touch = useCallback(() => {
    lastTouch.current = Date.now();
    setIdleLeft((v) => (v != null ? null : v));
  }, []);
  useEffect(() => {
    const idleSec = boot?.kiosk.idleTimeout ?? boot?.settings?.kiosk?.idleTimeoutSec ?? 60;
    const warn = boot?.settings?.kiosk?.idleWarningSec ?? 10;
    const id = setInterval(() => {
      if (!IDLE_SCREENS.includes(screenRef.current)) return;
      const limit = (screenRef.current === 'qr' ? idleSec * 3 : idleSec) * 1000;
      const since = Date.now() - lastTouch.current;
      if (since >= limit + warn * 1000) resetSession({ cancelOrder: true });
      else if (since >= limit) setIdleLeft(Math.ceil((limit + warn * 1000 - since) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [boot, resetSession]);

  /* ------------------------------------------------------------ realtime */
  const goSuccess = useCallback(() => {
    chime('success');
    setScreen('success');
  }, []);
  useSocketEvent(socket, EVENTS.PAYMENT_APPROVED, (d) => {
    if (d?.orderId && d.orderId === useKiosk.getState().order?.id) goSuccess();
  });
  useSocketEvent(socket, EVENTS.PAYMENT_REJECTED, (d) => {
    if (d?.orderId === useKiosk.getState().order?.id) {
      setFailReason(d.reason ?? null);
      chime('alert');
      setScreen('failed');
      touch();
    }
  });
  useSocketEvent(socket, EVENTS.PAYMENT_STATUS, (d) => {
    if (d?.orderId === useKiosk.getState().order?.id) setCardStatus({ status: d.status, reason: d.reason });
  });
  useSocketEvent(socket, EVENTS.ORDER_CANCELLED, (d) => {
    if (d?.id === useKiosk.getState().order?.id && !['success', 'welcome'].includes(screenRef.current)) {
      setNotice(t('errorGeneric'));
      setTimeout(() => resetSession(), 3000);
    }
  });
  useSocketEvent(socket, [EVENTS.MENU_UPDATED], () => void data.reloadMenu());
  useSocketEvent(socket, EVENTS.STOCK_UPDATED, (d) => data.applyStock(d));
  useSocketEvent(socket, EVENTS.SETTINGS_UPDATED, (d) => {
    if (d?.reload && screenRef.current === 'welcome') location.reload();
    void data.reloadBoot();
  });
  useOnReconnect(socket, () => {
    void data.reloadMenu();
    void syncOutbox();
  });

  // Polling fallback while waiting on staff / terminal (covers missed socket events).
  useEffect(() => {
    if (!order || !['verifying', 'counter', 'card', 'qr'].includes(screen)) return;
    const id = setInterval(async () => {
      try {
        const r = await kioskApi<any>(`/orders/${order.id}`);
        if (r.order.payment_status === 'PAID') goSuccess();
        else if (r.order.status === 'CANCELLED') resetSession();
        else if (screenRef.current === 'verifying') {
          const last = r.verifications[r.verifications.length - 1];
          if (last?.status === 'REJECTED') {
            setFailReason(last.reason);
            setScreen('failed');
          }
        }
      } catch {
        /* offline: keep waiting */
      }
    }, 5000);
    return () => clearInterval(id);
  }, [order, screen, goSuccess, resetSession]);

  /* ------------------------------------------------------------ heartbeat + offline sync */
  const syncOutbox = useCallback(async () => {
    if (!navigator.onLine) return;
    for (const o of await outbox.list()) {
      if (o.status !== 'SYNC_PENDING') {
        if (o.status === 'SYNCED' && Date.now() - o.createdAt > 86400000) await outbox.remove(o.clientOrderId);
        continue;
      }
      try {
        const r = await kioskApi<any>('/orders', { body: o.payload });
        if (r.order.status === 'CREATED') await kioskApi(`/orders/${r.orderId}/payments`, { body: { method: 'CASH' } }).catch(() => {});
        await outbox.update(o.clientOrderId, { status: 'SYNCED', orderNumber: r.order.order_number });
      } catch (e) {
        if (e instanceof ApiError && !e.isNetwork && e.status < 500) await outbox.update(o.clientOrderId, { status: 'FAILED', error: e.message, attempts: o.attempts + 1 });
        else await outbox.update(o.clientOrderId, { attempts: o.attempts + 1 });
        if (e instanceof ApiError && e.isNetwork) break;
      }
    }
  }, []);
  useEffect(() => {
    const beat = async () => {
      socket?.emit('heartbeat', { version: APP_VERSION });
      const pending = (await outbox.list()).filter((o) => o.status === 'SYNC_PENDING').length;
      kioskApi('/heartbeat', { body: { version: APP_VERSION, pendingSync: pending } }).catch(() => {});
      if (pending) void syncOutbox();
    };
    void beat();
    const id = setInterval(beat, 30000);
    return () => clearInterval(id);
  }, [socket, syncOutbox]);

  useEffect(() => {
    const h = () => setMaint(true);
    let taps = 0;
    let timer: any;
    const counter = () => {
      taps++;
      clearTimeout(timer);
      timer = setTimeout(() => (taps = 0), 2500);
      if (taps >= 5) {
        taps = 0;
        h();
      }
    };
    window.addEventListener('kiosk-admin-tap', counter);
    return () => window.removeEventListener('kiosk-admin-tap', counter);
  }, []);

  /* ------------------------------------------------------------ actions */
  const start = () => {
    touch();
    document.documentElement.requestFullscreen?.().catch(() => {});
    if (orderTypes.length === 1) {
      store.setOrderType(orderTypes[0]);
      setScreen('menu');
    } else setScreen('orderType');
  };

  const openProduct: KioskContextValue['openProduct'] = (p, opts) => {
    touch();
    const special =
      opts?.upsellSourceProductId != null
        ? data.menu?.products.find((x) => x.id === opts.upsellSourceProductId)?.recommendations.find((r) => r.product_id === p.id)?.special_price ?? null
        : null;
    setModal({ product: p, lineKey: opts?.lineKey, upsellSourceProductId: opts?.upsellSourceProductId ?? null, specialPrice: special });
  };

  const saveProduct = (v: { qty: number; modifierIds: string[]; specialRequest: string }) => {
    if (!modal) return;
    const { product, lineKey, upsellSourceProductId } = modal;
    if (lineKey) store.updateLine(lineKey, v);
    else store.addLine({ productId: product.id, ...v, upsellSourceProductId: upsellSourceProductId ?? null });
    setModal(null);
    const upsellOn = boot?.settings?.kiosk?.upsellEnabled !== false;
    if (!lineKey && !upsellSourceProductId && upsellOn && product.recommendations.some((r) => {
      const rp = data.menu?.products.find((x) => x.id === r.product_id);
      return rp && data.availability(rp) === 'OK' && !useKiosk.getState().lines.some((l) => l.productId === rp.id);
    })) setUpsell(product);
  };

  const addUpsell = (p: MenuProduct, specialPrice: number | null) => {
    const source = upsell!;
    setUpsell(null);
    const needsChoice = p.modifier_groups.some((g) => g.required);
    if (needsChoice) setModal({ product: p, upsellSourceProductId: source.id, specialPrice });
    else store.addLine({ productId: p.id, qty: 1, modifierIds: p.modifier_groups.flatMap((g) => g.modifiers.filter((m) => m.is_default).map((m) => m.id)), specialRequest: '', upsellSourceProductId: source.id });
  };

  const cartItems = () =>
    useKiosk.getState().lines.map((l) => ({ productId: l.productId, qty: l.qty, modifierIds: l.modifierIds, specialRequest: l.specialRequest || null, upsellSourceProductId: l.upsellSourceProductId ?? null }));

  const errorText = (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.isNetwork) return t('errorNetwork');
      if (e.code === 'OUT_OF_STOCK') return t('errorOutOfStock');
      if (['PRODUCT_UNAVAILABLE', 'PRODUCT_NOT_IN_SCHEDULE'].includes(e.code)) return t('errorUnavailable');
      if (e.code === 'INVALID_PROMO_CODE') return t('invalidCode');
    }
    return t('errorGeneric');
  };

  const saveOffline = async () => {
    const st = useKiosk.getState();
    offlineTotalRef.current = cartTotalRef.current;
    const clientOrderId = st.clientOrderId ?? crypto.randomUUID();
    const ref = makeOfflineRef(boot?.kiosk.code ?? 'K');
    await outbox.add({
      clientOrderId,
      offlineRef: ref,
      createdAt: Date.now(),
      status: 'SYNC_PENDING',
      attempts: 0,
      payload: { clientOrderId, orderType: st.orderType, language: st.lang, items: cartItems(), promoCode: st.promoCode, offlineRef: ref },
    });
    st.setOfflineRef(ref);
    setScreen('offlineSaved');
  };

  const pickMethod = async (m: Method) => {
    touch();
    setBusyMethod(m);
    setNotice(null);
    try {
      if (!online && m === 'CASH') return await saveOffline();
      let st = useKiosk.getState();
      if (!st.order) {
        const clientOrderId = st.clientOrderId ?? crypto.randomUUID();
        store.setOrder(null, clientOrderId);
        const r = await kioskApi<any>('/orders', { body: { clientOrderId, orderType: st.orderType ?? 'DINE_IN', language: st.lang, items: cartItems(), promoCode: st.promoCode } });
        store.setOrder(toOrder(r.order, r.items), clientOrderId);
        st = useKiosk.getState();
      }
      const p = await kioskApi<any>(`/orders/${st.order!.id}/payments`, { body: { method: m } });
      store.setPayment(toPayment(p.payment));
      setCardStatus({ status: 'WAITING_CARD' });
      setScreen(m === 'QR' ? 'qr' : m === 'CARD' ? 'card' : 'counter');
    } catch (e) {
      if (e instanceof ApiError && e.isNetwork && m === 'CASH' && !useKiosk.getState().order) return await saveOffline();
      if (e instanceof ApiError && e.code === 'ALREADY_PAID') return goSuccess();
      setNotice(errorText(e));
      if (e instanceof ApiError && ['OUT_OF_STOCK', 'PRODUCT_UNAVAILABLE', 'PRODUCT_NOT_IN_SCHEDULE', 'INVALID_PROMO_CODE'].includes(e.code)) {
        void data.reloadMenu();
        store.setOrder(null, null);
        setScreen('cart');
      }
    } finally {
      setBusyMethod(null);
    }
  };

  const verify = async (slip: File | null) => {
    const st = useKiosk.getState();
    if (!st.order || !st.payment) return;
    setBusy(true);
    try {
      const slipUrl = slip ? await uploadSlip(st.order.id, slip) : null;
      const r = await kioskApi<any>(`/orders/${st.order.id}/payments/${st.payment.id}/verify`, { body: { slipUrl } });
      if (r.alreadyPaid) goSuccess();
      else setScreen('verifying');
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const callStaff = () => {
    const st = useKiosk.getState();
    (st.order ? kioskApi(`/orders/${st.order.id}/call-staff`, { method: 'POST' }) : kioskApi('/call-staff', { method: 'POST' })).catch(() => {});
    setNotice(t('staffCalled'));
  };

  const backToCartFromPayment = () => {
    const st = useKiosk.getState();
    if (st.order) kioskApi(`/orders/${st.order.id}/cancel`, { method: 'POST' }).catch(() => {});
    store.setOrder(null, null);
    store.setPayment(null);
    setScreen('cart');
  };

  const cancelCard = async () => {
    const st = useKiosk.getState();
    if (st.order && st.payment) await kioskApi(`/orders/${st.order.id}/payments/${st.payment.id}/cancel`, { method: 'POST' }).catch(() => {});
    setScreen('payment');
  };

  const home = () => {
    if (order || lines.length) {
      setNotice(null);
      setConfirmHome(true);
    } else resetSession();
  };

  /* ------------------------------------------------------------ render */
  if (!boot || !data.menu) {
    if (data.error && data.error.status !== 401) return <KioskBlocking title="Cannot load kiosk" sub={data.error.message} />;
    return <KioskBlocking title="Loading menu…" sub={!browserOnline ? 'Offline — waiting for connection' : undefined} />;
  }

  const ctx: KioskContextValue = { t, lang, setLang: (l) => { store.setLang(l); touch(); }, money, data, enabledLangs, online, openProduct, touch };
  const offlineTotal = offlineTotalRef.current;

  return (
    <KioskContext.Provider value={ctx}>
      <div className="kiosk-root relative h-full w-full overflow-hidden text-ink" lang={lang} onPointerDown={touch} onKeyDown={touch} onContextMenu={(e) => e.preventDefault()}>
        {screen === 'welcome' && <WelcomeScreen onStart={start} />}
        {screen === 'orderType' && (
          <OrderTypeScreen
            types={orderTypes}
            onHome={() => resetSession()}
            onPick={(tp) => {
              store.setOrderType(tp);
              setScreen('menu');
            }}
          />
        )}
        {screen === 'menu' && <MenuScreen onHome={home} onCart={() => setScreen('cart')} />}
        {screen === 'cart' && <CartScreen onHome={home} onMore={() => setScreen('menu')} onCheckout={() => setScreen('payment')} busy={busy} />}
        {screen === 'payment' && <PaymentStep methods={methods} order={order} onPick={pickMethod} onBack={() => (order ? backToCartFromPayment() : setScreen('cart'))} onHome={home} busy={busyMethod} offline={!online} totalRef={cartTotalRef} />}
        {screen === 'qr' && order && payment && <QrScreen order={order} payment={payment} busy={busy} onVerify={verify} onRenew={() => pickMethod('QR')} onChangeMethod={() => setScreen('payment')} onHome={home} />}
        {screen === 'verifying' && order && <VerifyingScreen order={order} onCallStaff={callStaff} onChangeMethod={() => setScreen('payment')} />}
        {screen === 'counter' && order && <CounterScreen order={order} onChangeMethod={() => setScreen('payment')} onCancel={() => setConfirmHome(true)} />}
        {screen === 'card' && order && <CardScreen order={order} status={cardStatus.status} reason={cardStatus.reason} onCancel={cancelCard} onRetry={() => pickMethod('CARD')} onChangeMethod={() => setScreen('payment')} />}
        {screen === 'failed' && <FailedScreen reason={failReason} onRetry={() => (payment?.method === 'QR' ? setScreen('qr') : pickMethod(payment?.method ?? 'QR'))} onChangeMethod={() => setScreen('payment')} onCallStaff={callStaff} />}
        {screen === 'success' && order && <SuccessScreen order={order} seconds={boot.settings.kiosk?.resetAfterOrderSec ?? 10} onDone={() => resetSession()} />}
        {screen === 'offlineSaved' && store.offlineRef && <OfflineSavedScreen refCode={store.offlineRef} total={offlineTotal} seconds={(boot.settings.kiosk?.resetAfterOrderSec ?? 10) + 10} onDone={() => resetSession()} />}

        {modal && (
          <ProductModal
            product={modal.product}
            specialPrice={modal.specialPrice}
            line={modal.lineKey ? lines.find((l) => l.key === modal.lineKey) : undefined}
            onClose={() => setModal(null)}
            onSave={saveProduct}
          />
        )}
        {upsell && <UpsellModal source={upsell} onAdd={addUpsell} onClose={() => setUpsell(null)} />}

        {notice && (
          <div className="anim-up absolute inset-x-0 top-28 z-50 mx-auto w-fit max-w-[90%] rounded-2xl bg-secondary px-8 py-4 text-center text-2xl font-semibold text-white shadow-2xl" onClick={() => setNotice(null)}>
            {notice}
          </div>
        )}

        {idleLeft != null && (
          <div className="anim-fade absolute inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={touch}>
            <div className="anim-pop rounded-[2rem] bg-surface p-10 text-center shadow-2xl">
              <div className="text-5xl">⏳</div>
              <div className="mt-4 text-[2.6rem] font-extrabold">{t('stillThere')}</div>
              <div className="mt-2 text-2xl text-black/60">{t('stillThereSub', { n: idleLeft })}</div>
              <div className="mt-8 flex gap-4">
                <KButton onClick={touch} className="min-w-64">
                  {t('continueOrdering')}
                </KButton>
                <KButton variant="secondary" onClick={() => resetSession({ cancelOrder: true })}>
                  {t('startOver')}
                </KButton>
              </div>
            </div>
          </div>
        )}

        {confirmHome && (
          <div className="anim-fade absolute inset-0 z-[60] flex items-center justify-center bg-black/60">
            <div className="anim-pop max-w-xl rounded-[2rem] bg-surface p-10 text-center shadow-2xl">
              <div className="text-[2.2rem] font-extrabold">{t('cancelOrderConfirm')}</div>
              <div className="mt-8 flex justify-center gap-4">
                <KButton
                  variant="danger"
                  onClick={() => {
                    setConfirmHome(false);
                    resetSession({ cancelOrder: true });
                  }}
                >
                  {t('yes')}
                </KButton>
                <KButton variant="secondary" onClick={() => setConfirmHome(false)}>
                  {t('no')}
                </KButton>
              </div>
            </div>
          </div>
        )}

        {maint && <KioskMaintenance boot={boot} printer={printer} connected={connected} onClose={() => setMaint(false)} onUnpair={() => onUnpair()} onSync={syncOutbox} />}
      </div>
    </KioskContext.Provider>
  );
}

function PaymentStep({ methods, order, onPick, onBack, onHome, busy, offline, totalRef }: { methods: Method[]; order: ActiveOrder | null; onPick: (m: Method) => void; onBack: () => void; onHome: () => void; busy: Method | null; offline: boolean; totalRef: { current: number } }) {
  const pricing = useCartPricing();
  totalRef.current = pricing.total;
  const totals = order ? { subtotal: order.subtotal, discount: order.discount, serviceCharge: order.serviceCharge, vat: order.vat, total: order.total } : pricing;
  return <PaymentMethodScreen methods={methods} total={totals} onPick={onPick} onBack={onBack} onHome={onHome} busy={busy} offline={offline} />;
}

