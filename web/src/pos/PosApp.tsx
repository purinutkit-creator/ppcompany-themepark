import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Banknote, CreditCard, Lock, LogOut, Package, Search, ShoppingBag, Store, Trash2, Unlock, User, UtensilsCrossed, Wallet, X } from 'lucide-react';
import { EVENTS } from '@kiosk/shared';
import { newKey, parkApi, staffApi, storage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money } from '../lib/format';
import { LangSwitcher, defineStrings, useT } from '../lib/lang';
import { useSocketEvent } from '../lib/socket';
import { Badge, Button, ConnectionDot, Empty, Input, Loading, Modal, NumberInput, Tabs, promptDialog, toast, withManagerApproval } from '../components/ui';
import { StaffShell, useStaffRt } from '../components/StaffShell';
import { ModifierPicker } from '../park/ModifierPicker';
import { ScanBar, useScanner } from '../park/scan';
import { ShiftPanel, useCurrentShift } from '../park/ShiftPanel';
import { PStatus, SafeImg, StaffPayDialog, Stepper, TierBadge } from '../park/ui';

const PS2 = defineStrings('pos', {
  title: { th: 'POS', en: 'POS', zh: 'POS' },
  chooseStore: { th: 'เลือกร้าน / จุดขาย', en: 'Choose store', zh: '选择门店' },
  sell: { th: 'ขาย', en: 'Sell', zh: '销售' },
  shift: { th: 'กะ', en: 'Shift', zh: '班次' },
  search: { th: 'ค้นหาสินค้า หรือสแกนบาร์โค้ด', en: 'Search or scan a barcode', zh: '搜索或扫描条码' },
  stock: { th: 'คงเหลือ {n}', en: '{n} in stock', zh: '库存 {n}' },
  outOfStock: { th: 'หมด', en: 'Out', zh: '缺货' },
  cart: { th: 'ตะกร้า', en: 'Cart', zh: '购物车' },
  empty: { th: 'สแกนสินค้าหรือแตะเพื่อเพิ่ม', en: 'Scan or tap items to add', zh: '扫描或点击商品添加' },
  customerCard: { th: 'สแกนบัตร / ริสแบนด์ / QR สมาชิก', en: 'Scan card / wristband / member QR', zh: '扫描卡 / 腕带 / 会员码' },
  pay: { th: 'ชำระเงิน', en: 'Pay', zh: '付款' },
  payWallet: { th: 'ตัดเงินในบัตร', en: 'Charge card wallet', zh: '卡内扣款' },
  payCash: { th: 'เงินสด', en: 'Cash', zh: '现金' },
  received: { th: 'รับเงินมา', en: 'Received', zh: '实收' },
  sentKitchen: { th: 'ส่งเข้าครัวแล้ว — ออเดอร์ #{n}', en: 'Sent to kitchen — order #{n}', zh: '已送厨房 — 订单 #{n}' },
  orderCreated: { th: 'สร้างออเดอร์ #{n} — รอชำระ', en: 'Order #{n} created — awaiting payment', zh: '订单 #{n} 已创建 — 待付款' },
  paid: { th: 'ชำระแล้ว', en: 'Paid', zh: '已付款' },
  change: { th: 'เงินทอน {c}', en: 'Change {c}', zh: '找零 {c}' },
  newSale: { th: 'รายการใหม่', en: 'New sale', zh: '新销售' },
  receipts: { th: 'พิมพ์ใบเสร็จลูกค้า + พนักงานแล้ว', en: 'Customer + staff receipts printed', zh: '已打印客户联和员工联' },
  balance: { th: 'ยอดคงเหลือ', en: 'Balance', zh: '余额' },
  dineIn: { th: 'ทานที่ร้าน', en: 'Dine in', zh: '堂食' },
  takeAway: { th: 'กลับบ้าน', en: 'Take away', zh: '外带' },
  lockers: { th: 'ล็อกเกอร์', en: 'Lockers', zh: '储物柜' },
  rent: { th: 'เช่า', en: 'Rent', zh: '租用' },
  openLocker: { th: 'เปิด', en: 'Open', zh: '打开' },
  forceOpen: { th: 'เปิดฉุกเฉิน', en: 'Force open', zh: '强制打开' },
  endSession: { th: 'คืนล็อกเกอร์', en: 'End rental', zh: '结束租用' },
  chooseRate: { th: 'เลือกอัตรา', en: 'Choose rate', zh: '选择费率' },
  scanToRent: { th: 'สแกนบัตรลูกค้าเพื่อเช่า (ตัดเงินในบัตร)', en: 'Scan the guest card to rent (charged to wallet)', zh: '扫描客户卡租用（卡内扣款）' },
  rentCash: { th: 'เช่าแบบเงินสด', en: 'Rent with cash', zh: '现金租用' },
  free: { th: 'ว่าง', en: 'Free', zh: '空闲' },
  until: { th: 'ถึง {t}', en: 'until {t}', zh: '至 {t}' },
  reason: { th: 'เหตุผล', en: 'Reason', zh: '原因' },
  noShift: { th: 'ยังไม่ได้เปิดกะ — ต้องเปิดกะก่อนรับเงินสด', en: 'No open shift — open one before taking cash', zh: '未开班 — 收现金前请先开班' },
});

export default function PosApp() {
  return (
    <StaffShell perms={['pos.sell', 'lockers.operate']} surface="pos">
      <Layout />
    </StaffShell>
  );
}

function Layout() {
  const t = useT(PS2);
  const { user, logout, can } = useAuth();
  const { connected } = useStaffRt();
  const stores = useQuery({ queryKey: ['pos-stores'], queryFn: () => parkApi('/pos/stores') });
  const [storeId, setStoreId] = useState<string | null>(storage.get('pos_store'));
  const [tab, setTab] = useState<'sell' | 'shift'>('sell');
  const shift = useCurrentShift();
  const store = stores.data?.find((s: any) => s.id === storeId);
  const pick = (id: string | null) => {
    storage.set('pos_store', id);
    setStoreId(id);
  };
  if (!stores.data) return <Loading />;
  const sellable = stores.data.filter((s: any) => ['RETAIL', 'RESTAURANT', 'SERVICE', 'LOCKER', 'TICKETING'].includes(s.type) && s.type !== 'WAREHOUSE');
  return (
    <div className="flex h-full flex-col bg-slate-100">
      <header className="flex flex-wrap items-center gap-2 border-b bg-white px-3 py-2">
        <Store className="h-6 w-6 text-primary" />
        <button onClick={() => pick(null)} className="font-bold">{store ? t.tr(store.name) : t('chooseStore')}</button>
        {store && <Tabs value={tab} onChange={setTab} tabs={[{ id: 'sell', label: t('sell') }, ...(can('shifts.open') ? [{ id: 'shift' as const, label: t('shift') }] : [])]} className="ml-2" />}
        <div className="ml-auto flex items-center gap-2">
          <ConnectionDot connected={connected} />
          <LangSwitcher compact />
          <span className="hidden text-sm text-slate-600 md:inline">{user?.name}</span>
          <button onClick={() => logout()} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><LogOut className="h-5 w-5" /></button>
        </div>
      </header>
      {store && can('shifts.open') && shift.data === null && <button onClick={() => setTab('shift')} className="bg-amber-100 px-4 py-1.5 text-left text-sm text-amber-900 underline">{t('noShift')}</button>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!store ? (
          <div className="mx-auto grid max-w-4xl gap-3 p-6 sm:grid-cols-2 lg:grid-cols-3">
            {sellable.map((s: any) => {
              const I = s.type === 'RESTAURANT' ? UtensilsCrossed : s.type === 'LOCKER' ? Lock : s.type === 'TICKETING' ? Package : ShoppingBag;
              return (
                <button key={s.id} onClick={() => pick(s.id)} className="press flex flex-col gap-3 rounded-2xl bg-white p-5 text-left shadow-sm">
                  <I className="h-8 w-8 text-primary" />
                  <div><div className="text-lg font-bold">{t.tr(s.name)}</div><div className="text-xs text-slate-500">{s.code} · {s.type}</div></div>
                </button>
              );
            })}
          </div>
        ) : tab === 'shift' ? (
          <div className="p-4"><ShiftPanel terminal={store.type === 'LOCKER' ? 'LOCKER' : 'POS'} storeId={store.id} /></div>
        ) : (
          <StoreScreen store={store} />
        )}
      </div>
    </div>
  );
}

function StoreScreen({ store }: { store: any }) {
  const cat = useQuery({ queryKey: ['pos-catalog', store.id], queryFn: () => parkApi(`/pos/stores/${store.id}/catalog`) });
  if (!cat.data) return <Loading />;
  if (cat.data.mode === 'RESTAURANT') return <RestaurantPos store={store} menu={cat.data.menu} />;
  if (store.type === 'LOCKER') return <LockerPos />;
  return <RetailPos store={store} cat={cat.data} />;
}

/** Scanned customer card shown on every POS mode (member discount, points, wallet payment). */
function useCustomer() {
  const t = useT(PS2);
  const [card, setCard] = useState<{ code: string; p: any } | null>(null);
  const scan = async (code: string) => {
    try {
      setCard({ code, p: await parkApi('/pos/card', { body: { code } }) });
    } catch (e) { toast.error(t.err(e)); }
  };
  const chip = card ? (
    <div className="flex items-center gap-2 rounded-xl bg-slate-50 p-2 text-sm">
      <User className="h-4 w-4 text-slate-500" />
      <span className="font-semibold">{card.p.member ? `${card.p.member.first_name} ${card.p.member.last_name}` : card.p.credential.code}</span>
      {card.p.member && <TierBadge tier={{ name: card.p.member.tier_name, color: card.p.member.tier_color }} />}
      {card.p.wallet && <Badge>{t('balance')} {money(card.p.wallet.balance)}</Badge>}
      <button className="ml-auto p-1 text-slate-400" onClick={() => setCard(null)}><X className="h-4 w-4" /></button>
    </div>
  ) : null;
  return { card, setCard, scan, chip };
}

function RetailPos({ store, cat }: { store: any; cat: any }) {
  const t = useT(PS2);
  const qc = useQueryClient();
  const { socket } = useStaffRt();
  const cust = useCustomer();
  const [catId, setCatId] = useState('');
  const [q, setQ] = useState('');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [paying, setPaying] = useState<string | null>(null);
  const [done, setDone] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const byId = useMemo(() => Object.fromEntries(cat.products.map((p: any) => [p.id, p])), [cat.products]);
  const byBarcode = useMemo(() => Object.fromEntries(cat.products.filter((p: any) => p.barcode).map((p: any) => [String(p.barcode), p])), [cat.products]);
  useSocketEvent(socket, [EVENTS.INVENTORY_UPDATED, EVENTS.STOCK_UPDATED], () => void qc.invalidateQueries({ queryKey: ['pos-catalog', store.id] }));
  const add = (p: any) => {
    if (p.track_stock && p.stock != null && (cart[p.id] ?? 0) >= Number(p.stock)) return toast.error(t('outOfStock'));
    setCart((c) => ({ ...c, [p.id]: (c[p.id] ?? 0) + 1 }));
  };
  // One scanner for everything: product barcodes add to the cart, anything else is a customer card.
  useScanner((code) => {
    const p = byBarcode[code];
    if (p) add(p);
    else void cust.scan(code);
  }, { enabled: !paying && !done });
  const lines = Object.entries(cart).filter(([, n]) => n > 0);
  const total = lines.reduce((s, [id, n]) => s + Number(byId[id]?.price ?? 0) * n, 0);
  const list = cat.products.filter((p: any) => (!catId || p.category_id === catId) && (!q || t.tr(p.name).toLowerCase().includes(q.toLowerCase()) || p.sku.toLowerCase().includes(q.toLowerCase()) || String(p.barcode ?? '').includes(q)));
  const checkout = async () => {
    setBusy(true);
    try {
      const d = await parkApi('/sales', { body: { channel: 'POS', storeId: store.id, credentialCode: cust.card?.code ?? null, lines: lines.map(([refId, qty]) => ({ type: 'PRODUCT', refId, qty })), clientRef: newKey(), language: t.lang } });
      if (d.sale.status === 'PAID') setDone(d);
      else setPaying(d.sale.id);
    } catch (e) { toast.error(t.err(e)); } finally { setBusy(false); }
  };
  if (done) return <Done d={done} onNew={() => { setDone(null); setCart({}); cust.setCard(null); void qc.invalidateQueries({ queryKey: ['pos-catalog', store.id] }); }} />;
  return (
    <div className="grid min-h-full gap-3 p-3 lg:grid-cols-[1fr_360px]">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2 rounded-2xl bg-white p-3 shadow-sm">
          <div className="relative min-w-60 flex-1"><Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} className="pl-9" /></div>
          <div className="no-scrollbar flex gap-1 overflow-x-auto">
            <button onClick={() => setCatId('')} className={clsx('shrink-0 rounded-full px-3 py-1.5 text-sm', !catId ? 'bg-slate-900 text-white' : 'bg-slate-100')}>{t('all')}</button>
            {cat.categories.map((c: any) => <button key={c.id} onClick={() => setCatId(c.id)} className={clsx('shrink-0 rounded-full px-3 py-1.5 text-sm', catId === c.id ? 'bg-slate-900 text-white' : 'bg-slate-100')}>{t.tr(c.name)}</button>)}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {list.map((p: any) => {
            const out = p.track_stock && p.stock != null && Number(p.stock) <= 0;
            return (
              <button key={p.id} disabled={out || p.status === 'SOLD_OUT'} onClick={() => add(p)} className="press flex flex-col overflow-hidden rounded-2xl bg-white text-left shadow-sm disabled:opacity-40">
                <SafeImg src={p.image_url} className="h-24 w-full object-cover" />
                <div className="flex flex-1 flex-col p-2.5">
                  <div className="line-clamp-2 text-sm font-semibold">{t.tr(p.name)}</div>
                  <div className="mt-auto flex items-end justify-between pt-1">
                    <b className="text-primary">{money(p.price)}</b>
                    {p.track_stock && <span className={clsx('text-[11px]', out ? 'text-rose-600' : 'text-slate-500')}>{out ? t('outOfStock') : t('stock', { n: p.stock ?? 0 })}</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <aside className="flex flex-col gap-2 rounded-2xl bg-white p-3 shadow-sm lg:sticky lg:top-3 lg:max-h-[calc(100vh-6rem)]">
        {cust.chip ?? <ScanBar onScan={cust.scan} placeholder={t('customerCard')} autoFocus={false} camera />}
        <div className="flex items-center justify-between font-semibold"><span>{t('cart')}</span>{lines.length > 0 && <button onClick={() => setCart({})} className="p-1 text-slate-400"><Trash2 className="h-4 w-4" /></button>}</div>
        <div className="scroll-thin min-h-24 flex-1 space-y-1.5 overflow-y-auto">
          {!lines.length ? <div className="py-8 text-center text-sm text-slate-400">{t('empty')}</div> : lines.map(([id, n]) => (
            <div key={id} className="flex items-center gap-2 rounded-xl bg-slate-50 p-2 text-sm">
              <div className="min-w-0 flex-1"><div className="truncate font-medium">{t.tr(byId[id]?.name)}</div><div className="text-xs text-slate-500">{money(byId[id]?.price)}</div></div>
              <Stepper value={n} min={0} onChange={(v) => setCart((c) => ({ ...c, [id]: v }))} />
            </div>
          ))}
        </div>
        <div className="flex justify-between border-t pt-2 text-xl font-extrabold"><span>{t('total')}</span><span>{money(total)}</span></div>
        <Button size="lg" disabled={!lines.length} loading={busy} onClick={checkout}>{t('pay')}</Button>
      </aside>
      {paying && (
        <StaffPayDialog saleId={paying} socket={socket} defaultCredential={cust.card?.code ?? null} methods={['CASH', 'CARD', 'PROMPTPAY', 'WALLET']}
          onClose={async () => { await parkApi(`/sales/${paying}/cancel`, { body: { reason: 'POS_CANCELLED' } }).catch(() => {}); setPaying(null); }}
          onPaid={(d) => { setPaying(null); setDone(d); }} />
      )}
    </div>
  );
}

function Done({ d, onNew }: { d: any; onNew: () => void }) {
  const t = useT(PS2);
  return (
    <div className="mx-auto max-w-lg p-6 text-center">
      <div className="rounded-3xl bg-emerald-50 p-8">
        <div className="text-3xl font-extrabold text-emerald-800">{t('paid')} · {money(d.sale.total)}</div>
        <div className="font-mono text-sm text-emerald-700">{d.sale.sale_no}</div>
        <div className="mt-2 text-sm text-emerald-800">{t('receipts')}</div>
        {d.payments?.filter((p: any) => Number(p.change_amount) > 0).map((p: any) => <div key={p.id} className="mt-2 text-xl font-bold">{t('change', { c: money(p.change_amount) })}</div>)}
        <Button size="lg" className="mt-5" onClick={onNew}>{t('newSale')}</Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ restaurant POS (orders go to the KDS)
function RestaurantPos({ store, menu }: { store: any; menu: any }) {
  const t = useT(PS2);
  const cust = useCustomer();
  const [catId, setCatId] = useState('');
  const [cart, setCart] = useState<{ productId: string; qty: number; modifierIds: string[]; name: any; price: number }[]>([]);
  const [orderType, setOrderType] = useState<'DINE_IN' | 'TAKE_AWAY'>('DINE_IN');
  const [pick, setPick] = useState<any>(null);
  const [order, setOrder] = useState<any>(null);
  const [received, setReceived] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useScanner((code) => void cust.scan(code), { enabled: !order });
  const cats = menu.categories.filter((c: any) => c.kind === 'STANDARD');
  const products = menu.products.filter((p: any) => (!catId || p.category_id === catId) && p.status === 'AVAILABLE');
  const total = cart.reduce((s, l) => s + l.price * l.qty, 0);
  const add = (p: any, modifierIds: string[]) => {
    const delta = p.modifier_groups.flatMap((g: any) => g.modifiers).filter((m: any) => modifierIds.includes(m.id)).reduce((s: number, m: any) => s + Number(m.price_delta), 0);
    setCart((c) => [...c, { productId: p.id, qty: 1, modifierIds, name: p.name, price: Number(p.price) + delta }]);
  };
  const create = async () => {
    setBusy(true);
    try {
      const r = await parkApi('/pos/orders', { body: { clientOrderId: newKey(), storeId: store.id, orderType, language: t.lang, memberCode: cust.card?.code ?? null, items: cart.map((l) => ({ productId: l.productId, qty: l.qty, modifierIds: l.modifierIds })) } });
      setOrder(r);
      toast.info(t('orderCreated', { n: r.order?.order_number ?? r.orderNumber }));
    } catch (e) { toast.error(t.err(e)); } finally { setBusy(false); }
  };
  const finish = (msg: string) => {
    toast.success(msg);
    setOrder(null);
    setCart([]);
    setReceived(null);
    cust.setCard(null);
  };
  const num = order?.order?.order_number ?? order?.orderNumber;
  const orderTotal = Number(order?.order?.total ?? order?.total ?? total);
  return (
    <div className="grid min-h-full gap-3 p-3 lg:grid-cols-[1fr_360px]">
      <div className="space-y-3">
        <div className="no-scrollbar flex gap-1 overflow-x-auto rounded-2xl bg-white p-2 shadow-sm">
          <button onClick={() => setCatId('')} className={clsx('shrink-0 rounded-full px-3 py-1.5 text-sm', !catId ? 'bg-slate-900 text-white' : 'bg-slate-100')}>{t('all')}</button>
          {cats.map((c: any) => <button key={c.id} onClick={() => setCatId(c.id)} className={clsx('shrink-0 rounded-full px-3 py-1.5 text-sm', catId === c.id ? 'bg-slate-900 text-white' : 'bg-slate-100')}>{t.tr(c.name)}</button>)}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
          {products.map((p: any) => (
            <button key={p.id} disabled={!!order} onClick={() => (p.modifier_groups.length ? setPick(p) : add(p, []))} className="press overflow-hidden rounded-2xl bg-white text-left shadow-sm disabled:opacity-50">
              <SafeImg src={p.image_url} className="h-24 w-full object-cover" />
              <div className="p-2.5"><div className="line-clamp-2 text-sm font-semibold">{t.tr(p.name)}</div><b className="text-primary">{money(p.price)}</b></div>
            </button>
          ))}
        </div>
      </div>
      <aside className="flex flex-col gap-2 rounded-2xl bg-white p-3 shadow-sm lg:sticky lg:top-3 lg:max-h-[calc(100vh-6rem)]">
        {cust.chip ?? <ScanBar onScan={cust.scan} placeholder={t('customerCard')} autoFocus={false} />}
        <Tabs value={orderType} onChange={setOrderType} tabs={[{ id: 'DINE_IN', label: t('dineIn') }, { id: 'TAKE_AWAY', label: t('takeAway') }]} />
        <div className="scroll-thin min-h-24 flex-1 space-y-1.5 overflow-y-auto">
          {!cart.length ? <div className="py-8 text-center text-sm text-slate-400">{t('empty')}</div> : cart.map((l, i) => (
            <div key={i} className="flex items-center gap-2 rounded-xl bg-slate-50 p-2 text-sm">
              <div className="min-w-0 flex-1"><div className="truncate font-medium">{t.tr(l.name)}</div><div className="text-xs text-slate-500">{money(l.price)}</div></div>
              {!order && <Stepper value={l.qty} min={0} onChange={(v) => setCart((c) => (v === 0 ? c.filter((_, j) => j !== i) : c.map((x, j) => (j === i ? { ...x, qty: v } : x))))} />}
            </div>
          ))}
        </div>
        <div className="flex justify-between border-t pt-2 text-xl font-extrabold"><span>{t('total')}</span><span>{money(order ? orderTotal : total)}</span></div>
        {!order ? (
          <Button size="lg" disabled={!cart.length} loading={busy} onClick={create}>{t('pay')}</Button>
        ) : (
          <div className="space-y-2 rounded-xl bg-slate-50 p-2">
            <div className="text-center text-sm font-semibold">#{num}</div>
            <Button className="w-full" icon={<Wallet className="h-4 w-4" />} disabled={!cust.card} loading={busy} onClick={async () => {
              setBusy(true);
              try {
                await parkApi(`/pos/orders/${order.orderId}/wallet`, { body: { code: cust.card!.code }, idempotencyKey: newKey() });
                finish(t('sentKitchen', { n: num }));
              } catch (e) { toast.error(t.err(e)); } finally { setBusy(false); }
            }}>{t('payWallet')}</Button>
            <div className="flex gap-2">
              <div className="flex-1"><NumberInput value={received} onChange={setReceived} placeholder={t('received')} /></div>
              <Button icon={<Banknote className="h-4 w-4" />} disabled={!received || received < orderTotal} loading={busy} onClick={async () => {
                setBusy(true);
                try {
                  const r = await staffApi(`/orders/${order.orderId}/cash`, { body: { received }, idempotencyKey: newKey() });
                  finish(`${t('sentKitchen', { n: num })} · ${t('change', { c: money(r.change ?? 0) })}`);
                } catch (e) { toast.error(t.err(e)); } finally { setBusy(false); }
              }}>{t('payCash')}</Button>
            </div>
            <Button variant="ghost" size="sm" className="w-full" icon={<CreditCard className="h-4 w-4" />} onClick={async () => {
              try {
                await withManagerApproval(t('pay'), (a) => staffApi(`/orders/${order.orderId}/manual-payment`, { body: { method: 'CARD', ...a }, idempotencyKey: newKey() }));
                finish(t('sentKitchen', { n: num }));
              } catch (e) { toast.error(t.err(e)); }
            }}>EDC</Button>
          </div>
        )}
      </aside>
      {pick && <ModifierPicker p={pick} onClose={() => setPick(null)} onAdd={(ids) => { add(pick, ids); setPick(null); }} />}
    </div>
  );
}

// ------------------------------------------------------------------ lockers (staff station)
function LockerPos() {
  const t = useT(PS2);
  const { can } = useAuth();
  const { socket } = useStaffRt();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['lockers'], queryFn: () => parkApi('/lockers') });
  const [sel, setSel] = useState<any>(null);
  const [rateId, setRateId] = useState<string | null>(null);
  const [cash, setCash] = useState<number | null>(null);
  useSocketEvent(socket, EVENTS.LOCKER_UPDATED, () => void qc.invalidateQueries({ queryKey: ['lockers'] }));
  if (!q.data) return <Loading />;
  const banks = [...new Set(q.data.lockers.map((l: any) => l.bank))] as string[];
  const refresh = () => void qc.invalidateQueries({ queryKey: ['lockers'] });
  const rent = async (body: Record<string, unknown>) => {
    try {
      const r = await parkApi('/lockers/rent', { body: { rateId, lockerId: sel?.id ?? null, language: t.lang, ...body }, idempotencyKey: newKey() });
      toast.success(`${r.session?.locker_code ?? ''}`, r.session?.expire_at ? t('until', { t: new Date(r.session.expire_at).toLocaleTimeString() }) : undefined);
      setSel(null);
      refresh();
    } catch (e) { toast.error(t.err(e)); }
  };
  return (
    <div className="space-y-4 p-3">
      <div className="rounded-2xl bg-white p-3 shadow-sm"><ScanBar onScan={async (code) => {
        try {
          const r = await parkApi('/lockers/open', { body: { code } });
          if (r.ok) toast.success(`${t('openLocker')} ${r.locker?.code}`);
          else toast.error(t.reason(r.reason) || r.reason);
          refresh();
        } catch (e) { toast.error(t.err(e)); }
      }} placeholder={`${t('openLocker')} — ${t('customerCard')}`} /></div>
      {banks.map((b) => (
        <div key={b} className="rounded-2xl bg-white p-3 shadow-sm">
          <div className="mb-2 font-semibold">{t('lockers')} {b}</div>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-10">
            {q.data.lockers.filter((l: any) => l.bank === b).map((l: any) => (
              <button key={l.id} onClick={() => setSel(l)} className={clsx('press rounded-xl p-2 text-center text-xs', l.status === 'AVAILABLE' ? 'bg-emerald-50 text-emerald-800' : l.status === 'OCCUPIED' ? 'bg-sky-100 text-sky-900' : 'bg-slate-200 text-slate-500')}>
                <div className="text-sm font-bold">{l.code}</div>
                <div>{l.size}</div>
                {l.status === 'OCCUPIED' && l.expire_at && <div className="truncate">{new Date(l.expire_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>}
              </button>
            ))}
          </div>
        </div>
      ))}
      {sel && (
        <Modal open onClose={() => setSel(null)} title={`${t('lockers')} ${sel.code}`} size="md">
          {sel.status === 'AVAILABLE' ? (
            <div className="space-y-3">
              <div className="text-sm font-semibold">{t('chooseRate')}</div>
              <div className="grid grid-cols-2 gap-2">
                {q.data.rates.filter((r: any) => !r.size || r.size === sel.size).map((r: any) => (
                  <button key={r.id} onClick={() => setRateId(r.id)} className={clsx('rounded-xl border-2 p-3 text-left', rateId === r.id ? 'border-primary bg-primary/5' : 'border-slate-200')}>
                    <div className="font-semibold">{t.tr(r.label)}</div><div className="font-bold text-primary">{money(r.price)}</div>
                  </button>
                ))}
              </div>
              {rateId && (
                <>
                  <div className="text-sm text-slate-600">{t('scanToRent')}</div>
                  <ScanBar onScan={(code) => rent({ code, method: 'WALLET' })} />
                  {can('payments.cash') && (
                    <div className="flex items-end gap-2 border-t pt-3">
                      <div className="flex-1"><NumberInput value={cash} onChange={setCash} placeholder={t('received')} /></div>
                      <ScanBar className="flex-1" camera={false} autoFocus={false} placeholder={`${t('rentCash')} — ${t('customerCard')}`} onScan={(code) => rent({ code, method: 'CASH', received: cash })} />
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2"><PStatus s={sel.status} />{sel.credential_code && <span className="font-mono text-sm">{sel.credential_code}</span>}{sel.first_name && <span>{sel.first_name}</span>}</div>
              {sel.expire_at && <div className="text-sm">{t('until', { t: new Date(sel.expire_at).toLocaleString() })}</div>}
              <div className="flex flex-wrap gap-2">
                {can('lockers.force_open') && <Button variant="outline" icon={<Unlock className="h-4 w-4" />} onClick={async () => {
                  const reason = (await promptDialog(t('reason'))) ?? '';
                  if (reason.length < 3) return;
                  try {
                    await withManagerApproval(t('forceOpen'), (a) => parkApi(`/lockers/${sel.id}/force-open`, { body: { reason, release: false, ...a } }));
                    refresh();
                  } catch (e) { toast.error(t.err(e)); }
                }}>{t('forceOpen')}</Button>}
                {sel.session_id && <Button variant="danger" onClick={async () => {
                  try {
                    await parkApi(`/lockers/sessions/${sel.session_id}/end`, { body: {} });
                    setSel(null);
                    refresh();
                  } catch (e) { toast.error(t.err(e)); }
                }}>{t('endSession')}</Button>}
              </div>
            </div>
          )}
        </Modal>
      )}
      {!q.data.lockers.length && <Empty />}
    </div>
  );
}
