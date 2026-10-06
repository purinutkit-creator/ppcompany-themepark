import { useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { BadgeCheck, CalendarCheck, CreditCard, LogOut, Printer, ShoppingCart, Ticket, Trash2, User, Wallet, X } from 'lucide-react';
import { EVENTS } from '@kiosk/shared';
import { newKey, parkApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money } from '../lib/format';
import { LangSwitcher, defineStrings, useT } from '../lib/lang';
import { useSocketEvent } from '../lib/socket';
import { Badge, Button, ConnectionDot, Field, Input, Loading, Modal, NumberInput, toast, withManagerApproval } from '../components/ui';
import { StaffShell, useStaffRt } from '../components/StaffShell';
import { ScanBar, QrCode } from '../park/scan';
import { ShiftPanel, useCurrentShift } from '../park/ShiftPanel';
import { PStatus, StaffPayDialog, Stepper, TierBadge } from '../park/ui';
import { BookingsTab } from './BookingsTab';
import { CardsTab } from './CardsTab';
import { VerifyTab } from './VerifyTab';
import { BindWristband } from './BindWristband';

export const CT = defineStrings('counter', {
  title: { th: 'เคาน์เตอร์ขายบัตร', en: 'Box office', zh: '售票处' },
  sell: { th: 'ขาย', en: 'Sell', zh: '销售' },
  bookings: { th: 'การจอง / เช็คอิน', en: 'Bookings & check-in', zh: '预订 / 入园登记' },
  cards: { th: 'บัตร / ริสแบนด์', en: 'Cards & wristbands', zh: '卡 / 腕带' },
  verify: { th: 'ตรวจสอบการชำระ', en: 'Payment verification', zh: '付款核对' },
  shift: { th: 'กะ / ปิดยอด', en: 'Shift', zh: '班次' },
  noShift: { th: 'ยังไม่ได้เปิดกะ — ต้องเปิดกะก่อนรับเงินสด', en: 'No open shift — open one before taking cash', zh: '未开班 — 收现金前请先开班' },
  customer: { th: 'ลูกค้า', en: 'Customer', zh: '客户' },
  scanMember: { th: 'สแกนบัตรสมาชิก / ริสแบนด์ (ราคาสมาชิก + คะแนน)', en: 'Scan member card / wristband (member price + points)', zh: '扫描会员卡 / 腕带（会员价 + 积分）' },
  walkIn: { th: 'ลูกค้าทั่วไป', en: 'Walk-in guest', zh: '散客' },
  name: { th: 'ชื่อ', en: 'Name', zh: '姓名' },
  packages: { th: 'แพ็กเกจ', en: 'Packages', zh: '套餐' },
  topup: { th: 'เติมเงินเข้าบัตร', en: 'Wallet top-up', zh: '钱包充值' },
  membership: { th: 'สมาชิก', en: 'Membership', zh: '会员' },
  cart: { th: 'ตะกร้า', en: 'Cart', zh: '购物车' },
  empty: { th: 'ยังไม่มีรายการ', en: 'Cart is empty', zh: '购物车为空' },
  promo: { th: 'โค้ดโปรโมชั่น / คูปอง', en: 'Promo / coupon code', zh: '优惠码 / 优惠券' },
  manualDiscount: { th: 'ส่วนลดพิเศษ', en: 'Manual discount', zh: '手动折扣' },
  checkout: { th: 'ชำระเงิน', en: 'Checkout', zh: '结账' },
  clear: { th: 'ล้าง', en: 'Clear', zh: '清空' },
  needCard: { th: 'ต้องสแกนบัตรก่อน', en: 'Scan a card first', zh: '请先扫描卡' },
  needMember: { th: 'ต้องเป็นสมาชิก (สแกนบัตรสมาชิก)', en: 'Member required (scan member card)', zh: '需要会员（扫描会员卡）' },
  done: { th: 'ขายสำเร็จ', en: 'Sale complete', zh: '销售完成' },
  receipts: { th: 'ใบเสร็จ (ลูกค้า + พนักงาน) และตั๋วถูกส่งพิมพ์แล้ว', en: 'Customer + staff receipts and tickets sent to the printer', zh: '客户联、员工联和门票已发送打印' },
  newSale: { th: 'ขายรายการใหม่', en: 'New sale', zh: '新销售' },
  bindHint: { th: 'ผูกริสแบนด์กับตั๋วแต่ละใบ (สแกนริสแบนด์ หรือออกริสแบนด์ใหม่)', en: 'Bind a wristband to each ticket (scan one or issue a new one)', zh: '为每张门票绑定腕带（扫描或新发）' },
  reprint: { th: 'พิมพ์ซ้ำ', en: 'Reprint', zh: '重新打印' },
  amount: { th: 'จำนวนเงิน', en: 'Amount', zh: '金额' },
  reason: { th: 'เหตุผล', en: 'Reason', zh: '原因' },
  visitDate: { th: 'วันเข้าชม', en: 'Visit date', zh: '游玩日期' },
});

export default function CounterApp() {
  return (
    <StaffShell perms={['tickets.sell', 'bookings.checkin', 'cards.view', 'payments.verify', 'wallet.topup']} surface="counter">
      <Layout />
    </StaffShell>
  );
}

function Layout() {
  const t = useT(CT);
  const { user, logout, can } = useAuth();
  const { connected } = useStaffRt();
  const shift = useCurrentShift();
  const tabs = [
    { to: 'sell', label: t('sell'), icon: ShoppingCart, show: can('tickets.sell') },
    { to: 'bookings', label: t('bookings'), icon: CalendarCheck, show: can('bookings.view') || can('bookings.checkin') },
    { to: 'cards', label: t('cards'), icon: CreditCard, show: can('cards.view') },
    { to: 'verify', label: t('verify'), icon: BadgeCheck, show: can('payments.verify') },
    { to: 'shift', label: t('shift'), icon: Wallet, show: can('shifts.open') },
  ].filter((x) => x.show);
  return (
    <div className="flex h-full flex-col bg-slate-100">
      <header className="flex flex-wrap items-center gap-2 border-b bg-white px-3 py-2">
        <Ticket className="h-6 w-6 text-primary" />
        <div className="mr-2 font-bold">{t('title')}</div>
        <nav className="no-scrollbar flex gap-1 overflow-x-auto">
          {tabs.map((x) => (
            <NavLink key={x.to} to={`/counter/${x.to}`} className={({ isActive }) => clsx('flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium', isActive ? 'bg-primary text-white' : 'text-slate-600 hover:bg-slate-100')}>
              <x.icon className="h-4 w-4" />{x.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ConnectionDot connected={connected} />
          <LangSwitcher compact />
          <span className="hidden text-sm text-slate-600 md:inline">{user?.name}</span>
          <button onClick={() => logout()} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><LogOut className="h-5 w-5" /></button>
        </div>
      </header>
      {can('shifts.open') && shift.data === null && <div className="bg-amber-100 px-4 py-1.5 text-sm text-amber-900"><NavLink to="/counter/shift" className="underline">{t('noShift')}</NavLink></div>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Routes>
          <Route index element={<Navigate to={tabs[0]?.to ?? 'sell'} replace />} />
          <Route path="sell" element={<Sell />} />
          <Route path="bookings" element={<BookingsTab />} />
          <Route path="cards" element={<CardsTab />} />
          <Route path="verify" element={<VerifyTab />} />
          <Route path="shift" element={<div className="p-4"><ShiftPanel terminal="COUNTER" /></div>} />
        </Routes>
      </div>
    </div>
  );
}

interface Line {
  key: string;
  type: 'PACKAGE' | 'TOPUP' | 'MEMBERSHIP' | 'MEMBERSHIP_RENEWAL' | 'MEMBERSHIP_UPGRADE';
  refId?: string | null;
  ticketTypeId?: string | null;
  qty: number;
  amount?: number | null;
  label: string;
  price: number;
}

function Sell() {
  const t = useT(CT);
  const { can } = useAuth();
  const { socket, client } = useStaffRt();
  const qc = useQueryClient();
  const [card, setCard] = useState<{ code: string; profile: any } | null>(null);
  const memberId = card?.profile?.member?.id ?? null;
  const cat = useQuery({ queryKey: ['counter-packages', memberId], queryFn: () => parkApi(`/pos/packages${memberId ? `?memberId=${memberId}` : ''}`) });
  const [lines, setLines] = useState<Line[]>([]);
  const [codes, setCodes] = useState<string[]>([]);
  const [promo, setPromo] = useState('');
  const [cust, setCust] = useState({ name: '', phone: '' });
  const [disc, setDisc] = useState<{ amount: number; reason: string } | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  const [done, setDone] = useState<any>(null);
  const [topupAmt, setTopupAmt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const body = useMemo(() => ({
    channel: 'COUNTER',
    visitDate: cat.data?.date ?? null,
    credentialCode: card?.code ?? null,
    customer: { name: cust.name || null, phone: cust.phone || null },
    lines: lines.map((l) => ({ type: l.type, refId: l.refId ?? null, ticketTypeId: l.ticketTypeId ?? null, qty: l.qty, amount: l.amount ?? null, meta: l.type === 'PACKAGE' ? { visitDate: cat.data?.date } : {} })),
    codes,
    manualDiscount: disc ? { amount: disc.amount, reason: disc.reason } : null,
    language: t.lang,
  }), [lines, codes, card, cust, disc, cat.data, t.lang]);
  const quote = useQuery({ queryKey: ['counter-quote', body], queryFn: () => parkApi('/sales/quote', { body }), enabled: lines.length > 0, retry: false });
  useSocketEvent(socket, [EVENTS.SETTINGS_UPDATED], () => void qc.invalidateQueries({ queryKey: ['counter-packages'] }));
  const add = (l: Omit<Line, 'key' | 'qty'>) => setLines((ls) => {
    const key = `${l.type}|${l.refId ?? ''}|${l.ticketTypeId ?? ''}|${l.amount ?? ''}`;
    const ex = ls.find((x) => x.key === key);
    return ex ? ls.map((x) => (x.key === key ? { ...x, qty: x.qty + 1 } : x)) : [...ls, { ...l, key, qty: 1 }];
  });
  const scanCard = async (code: string) => {
    try {
      const p = await parkApi('/cards/scan', { body: { code } });
      setCard({ code, profile: p });
    } catch (e) { toast.error(t.err(e)); }
  };
  const reset = () => {
    setLines([]); setCodes([]); setCard(null); setCust({ name: '', phone: '' }); setDisc(null); setDone(null); setPaying(null);
  };
  const checkout = async () => {
    setBusy(true);
    try {
      const clientRef = newKey();
      // A manual discount needs a manager PIN: the server asks for it and the dialog collects it.
      const d = await withManagerApproval(t('manualDiscount'), (a) => parkApi('/sales', { body: { ...body, ...a, clientRef } }));
      if (!d) return;
      if (d.sale.status === 'PAID') setDone(d);
      else setPaying(d.sale.id);
    } catch (e) { toast.error(t.err(e)); } finally { setBusy(false); }
  };
  if (done) return <SaleDone d={done} onNew={reset} />;
  if (!cat.data) return <Loading />;
  const quickTopup: number[] = client?.settings?.wallet?.quickAmounts ?? cat.data.topupAmounts ?? [100, 300, 500, 1000];
  return (
    <div className="grid min-h-full gap-3 p-3 lg:grid-cols-[1fr_380px]">
      <div className="space-y-3">
        <div className="rounded-2xl bg-white p-3 shadow-sm">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><User className="h-4 w-4" />{t('customer')}</div>
          {card ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 p-2">
              <span className="font-semibold">{card.profile.member ? `${card.profile.member.first_name} ${card.profile.member.last_name}` : card.profile.account?.display_name ?? card.profile.credential.code}</span>
              {card.profile.member && <TierBadge tier={{ name: card.profile.member.tier_name, color: card.profile.member.tier_color }} />}
              <span className="font-mono text-xs text-slate-500">{card.profile.credential.code}</span>
              {card.profile.wallet && <Badge>{t('balance')} {money(card.profile.wallet.balance)}</Badge>}
              <button className="ml-auto rounded-lg p-1 text-slate-500 hover:bg-slate-200" onClick={() => setCard(null)}><X className="h-4 w-4" /></button>
            </div>
          ) : (
            <div className="grid gap-2 md:grid-cols-[1fr_200px_160px]">
              <ScanBar onScan={scanCard} placeholder={t('scanMember')} autoFocus={false} />
              <Input placeholder={`${t('walkIn')} · ${t('name')}`} value={cust.name} onChange={(e) => setCust({ ...cust, name: e.target.value })} />
              <Input placeholder={t('phone')} value={cust.phone} onChange={(e) => setCust({ ...cust, phone: e.target.value })} />
            </div>
          )}
        </div>
        <div className="rounded-2xl bg-white p-3 shadow-sm">
          <div className="mb-2 flex items-center justify-between text-sm font-semibold"><span>{t('packages')}</span><span className="text-slate-500">{t('visitDate')}: {cat.data.date}</span></div>
          <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
            {cat.data.packages.filter((p: any) => p.kind === 'ADMISSION' || p.kind === 'RIDE_PASS' || p.kind === 'FAST_PASS').map((p: any) => (
              <div key={p.id} className={clsx('rounded-xl border p-2.5', !p.availability.available && 'opacity-50')}>
                <div className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ background: p.color }} /><b className="text-sm">{t.tr(p.name)}</b>{!p.availability.available && <span className="ml-auto text-[11px] text-rose-600">{t.reason(p.availability.reason)}</span>}</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {(p.prices.length ? p.prices : [{ ticket_type_id: null, unit_price: Number(p.base_price), ticket_type_name: null }]).map((pr: any) => (
                    <button key={pr.ticket_type_id ?? 'x'} disabled={!p.availability.available} onClick={() => add({ type: 'PACKAGE', refId: p.id, ticketTypeId: pr.ticket_type_id, label: `${t.tr(p.name)}${pr.ticket_type_name ? ` · ${t.tr(pr.ticket_type_name)}` : ''}`, price: pr.unit_price })} className="press rounded-lg bg-slate-100 px-2.5 py-1.5 text-left text-xs hover:bg-primary/10 disabled:opacity-40">
                      <div className="font-medium">{pr.ticket_type_name ? t.tr(pr.ticket_type_name) : t.tr(p.name)}</div>
                      <div className={clsx('font-bold', pr.member_priced && 'text-amber-600')}>{money(pr.unit_price)}</div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {can('wallet.topup') && (
            <div className="rounded-2xl bg-white p-3 shadow-sm">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Wallet className="h-4 w-4" />{t('topup')}</div>
              <div className="flex flex-wrap gap-1.5">
                {quickTopup.map((a) => <Button key={a} size="sm" variant="secondary" disabled={!card} onClick={() => add({ type: 'TOPUP', amount: a, label: `${t('topup')} ${money(a)}`, price: a })}>{money(a)}</Button>)}
                <div className="flex items-center gap-1"><div className="w-24"><NumberInput value={topupAmt} onChange={setTopupAmt} min={1} /></div><Button size="sm" disabled={!card || !topupAmt} onClick={() => topupAmt && add({ type: 'TOPUP', amount: topupAmt, label: `${t('topup')} ${money(topupAmt)}`, price: topupAmt })}>+</Button></div>
              </div>
              {!card && <div className="mt-1 text-xs text-slate-500">{t('needCard')}</div>}
            </div>
          )}
          {cat.data.membershipProducts?.length > 0 && (
            <div className="rounded-2xl bg-white p-3 shadow-sm">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><BadgeCheck className="h-4 w-4" />{t('membership')}</div>
              <div className="flex flex-wrap gap-1.5">
                {cat.data.membershipProducts.map((mp: any) => (
                  <Button key={mp.id} size="sm" variant="secondary" disabled={!memberId} onClick={() => add({ type: 'MEMBERSHIP', refId: mp.id, label: t.tr(mp.name), price: Number(mp.price) })}>
                    <span className="h-2 w-2 rounded-full" style={{ background: mp.tier_color }} />{t.tr(mp.name)} {money(mp.price)}
                  </Button>
                ))}
              </div>
              {!memberId && <div className="mt-1 text-xs text-slate-500">{t('needMember')}</div>}
            </div>
          )}
        </div>
      </div>
      <aside className="flex flex-col rounded-2xl bg-white p-3 shadow-sm lg:sticky lg:top-3 lg:max-h-[calc(100vh-7rem)]">
        <div className="mb-2 flex items-center justify-between font-semibold"><span>{t('cart')}</span>{lines.length > 0 && <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setLines([])}>{t('clear')}</Button>}</div>
        <div className="scroll-thin min-h-24 flex-1 space-y-1.5 overflow-y-auto">
          {!lines.length ? <div className="py-8 text-center text-sm text-slate-400">{t('empty')}</div> : lines.map((l) => (
            <div key={l.key} className="flex items-center gap-2 rounded-xl bg-slate-50 p-2 text-sm">
              <div className="min-w-0 flex-1"><div className="truncate font-medium">{l.label}</div><div className="text-xs text-slate-500">{money(l.price)}</div></div>
              {l.type === 'PACKAGE' ? <Stepper value={l.qty} min={0} onChange={(v) => setLines((ls) => (v === 0 ? ls.filter((x) => x.key !== l.key) : ls.map((x) => (x.key === l.key ? { ...x, qty: v } : x))))} /> : <button onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="p-1 text-slate-400"><X className="h-4 w-4" /></button>}
            </div>
          ))}
        </div>
        <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (promo.trim()) { setCodes([...new Set([...codes, promo.trim().toUpperCase()])]); setPromo(''); } }}>
          <Input value={promo} onChange={(e) => setPromo(e.target.value)} placeholder={t('promo')} className="uppercase" />
          <Button type="submit" variant="outline">+</Button>
        </form>
        {codes.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{codes.map((c) => <button key={c} onClick={() => setCodes(codes.filter((x) => x !== c))} className={clsx('rounded-full px-2 py-0.5 font-mono text-xs', quote.data?.invalidCodes?.includes(c) ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700')}>{c} ✕</button>)}</div>}
        {can('pos.discount') && (
          <div className="mt-2">
            {disc ? (
              <div className="flex items-center justify-between rounded-xl bg-amber-50 px-3 py-1.5 text-sm"><span>{t('manualDiscount')}: −{money(disc.amount)} ({disc.reason})</span><button onClick={() => setDisc(null)}><X className="h-4 w-4" /></button></div>
            ) : <ManualDiscountButton onSet={setDisc} />}
          </div>
        )}
        <div className="mt-3 space-y-1 border-t pt-2 text-sm">
          {quote.isError && <div className="rounded-lg bg-rose-50 p-2 text-rose-700">{t.err(quote.error)}</div>}
          {quote.data && (
            <>
              <div className="flex justify-between"><span>{t('subtotal')}</span><span>{money(quote.data.subtotal)}</span></div>
              {quote.data.promotions.map((p: any, i: number) => <div key={i} className="flex justify-between text-emerald-700"><span className="truncate">{t.tr(p.name)}</span><span>−{money(p.amount)}</span></div>)}
              <div className="flex justify-between text-xl font-extrabold"><span>{t('total')}</span><span>{money(quote.data.total)}</span></div>
              <div className="text-right text-[11px] text-slate-500">{t('vatIncluded')} {money(quote.data.vat)}</div>
            </>
          )}
        </div>
        <Button size="lg" className="mt-2 w-full" disabled={!lines.length || !quote.data || quote.data.invalidCodes?.length > 0} loading={busy} onClick={checkout}>{t('checkout')}{quote.data ? ` · ${money(quote.data.total)}` : ''}</Button>
      </aside>
      {paying && (
        <StaffPayDialog
          saleId={paying}
          socket={socket}
          defaultCredential={card?.code ?? null}
          methods={['CASH', 'CARD', 'PROMPTPAY', 'WALLET', 'BANK_TRANSFER', ...(can('pos.discount') ? (['COMP'] as const) : [])]}
          onClose={async () => {
            await parkApi(`/sales/${paying}/cancel`, { body: { reason: 'COUNTER_CANCELLED' } }).catch(() => {});
            setPaying(null);
          }}
          onPaid={(d) => { setPaying(null); setDone(d); }}
        />
      )}
    </div>
  );
}

function ManualDiscountButton({ onSet }: { onSet: (d: { amount: number; reason: string }) => void }) {
  const t = useT(CT);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>+ {t('manualDiscount')}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('manualDiscount')} size="sm" footer={<Button disabled={!amount || reason.length < 2} onClick={() => {
        onSet({ amount: amount!, reason });
        setOpen(false);
      }}>{t('save')}</Button>}>
        <div className="space-y-3">
          <Field label={t('amount')}><NumberInput value={amount} onChange={setAmount} min={1} /></Field>
          <Field label={t('reason')}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>
      </Modal>
    </>
  );
}

function SaleDone({ d, onNew }: { d: any; onNew: () => void }) {
  const t = useT(CT);
  const qc = useQueryClient();
  const sale = useQuery({ queryKey: ['counter-sale', d.sale.id], queryFn: () => parkApi(`/sales/${d.sale.id}`), initialData: d });
  const s = sale.data;
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div className="rounded-2xl bg-emerald-50 p-5 text-center">
        <div className="text-2xl font-extrabold text-emerald-800">{t('done')} · {money(s.sale.total)}</div>
        <div className="font-mono text-sm text-emerald-700">{s.sale.sale_no}</div>
        <div className="mt-1 flex items-center justify-center gap-1 text-sm text-emerald-800"><Printer className="h-4 w-4" />{t('receipts')}</div>
        <div className="mt-2 flex flex-wrap justify-center gap-1">{(s.prints ?? []).map((p: any) => <Badge key={p.id}>{p.title} · {t.status(p.status)}</Badge>)}</div>
        <div className="mt-3 flex justify-center gap-2">
          <Button variant="outline" onClick={async () => {
            try {
              await withManagerApproval(t('reprint'), (a) => parkApi(`/sales/${s.sale.id}/reprint`, { body: { ...a } }));
              void qc.invalidateQueries({ queryKey: ['counter-sale', s.sale.id] });
            } catch (e) { toast.error(t.err(e)); }
          }}>{t('reprint')}</Button>
          <Button onClick={onNew}>{t('newSale')}</Button>
        </div>
      </div>
      {s.tickets?.length > 0 && (
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <div className="mb-3 text-sm text-slate-600">{t('bindHint')}</div>
          <div className="grid gap-3 md:grid-cols-2">
            {s.tickets.map((tk: any) => (
              <div key={tk.id} className="flex gap-3 rounded-xl border p-3">
                {tk.qr && <QrCode value={tk.qr} size={96} />}
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{t.tr(tk.package_name)} · {t.tr(tk.ticket_type_name)}</div>
                  <div className="font-mono text-xs">{tk.ticket_no}</div>
                  <div className="mt-1"><PStatus s={tk.status} /></div>
                  <BindWristband ticketId={tk.id} onDone={() => void qc.invalidateQueries({ queryKey: ['counter-sale', s.sale.id] })} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
