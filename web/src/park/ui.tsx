import { useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Banknote, CreditCard, QrCode as QrIcon, Wallet, Gift, Ticket, User, Star, Lock, Timer, CheckCircle2, XCircle } from 'lucide-react';
import type { Socket } from 'socket.io-client';
import { EVENTS, checkLabel, type CustomerSnapshot } from '@kiosk/shared';
import { newKey, parkApi } from '../lib/api';
import { money } from '../lib/format';
import { defineStrings, useT } from '../lib/lang';
import { useSocketEvent, watch } from '../lib/socket';
import { Badge, Button, Field, Input, Modal, NumberInput, toast } from '../components/ui';
import { QrCode, ScanBar } from './scan';

export const PS = defineStrings('park', {
  customerProfile: { th: 'ข้อมูลลูกค้า', en: 'Customer profile', zh: '客户资料' },
  cardStatus: { th: 'สถานะบัตร', en: 'Card status', zh: '卡状态' },
  walletBalance: { th: 'ยอดเงินในบัตร', en: 'Wallet balance', zh: '卡内余额' },
  bonus: { th: 'โบนัส', en: 'Bonus', zh: '赠送' },
  memberNo: { th: 'เลขสมาชิก', en: 'Member no.', zh: '会员号' },
  tier: { th: 'ระดับสมาชิก', en: 'Tier', zh: '会员等级' },
  expires: { th: 'หมดอายุ', en: 'Expires', zh: '到期' },
  visitDate: { th: 'วันเข้าชม', en: 'Visit date', zh: '游玩日期' },
  validTo: { th: 'ใช้ได้ถึง', en: 'Valid to', zh: '有效期至' },
  package: { th: 'แพ็กเกจ', en: 'Package', zh: '套餐' },
  ticketType: { th: 'ประเภทตั๋ว', en: 'Ticket type', zh: '票种' },
  rideRights: { th: 'สิทธิ์เครื่องเล่น', en: 'Ride entitlements', zh: '游乐设施权益' },
  usesLeft: { th: 'เหลือ {n} ครั้ง', en: '{n} left', zh: '剩余{n}次' },
  unlimited: { th: 'ไม่จำกัด', en: 'Unlimited', zh: '无限次' },
  lockers: { th: 'ล็อกเกอร์ที่ใช้อยู่', en: 'Active lockers', zh: '使用中的储物柜' },
  queues: { th: 'คิวที่จองไว้', en: 'Virtual queues', zh: '虚拟排队' },
  linkedCards: { th: 'บัตร/ริสแบนด์ที่เชื่อมกัน', en: 'Linked cards / wristbands', zh: '关联的卡/腕带' },
  noTickets: { th: 'ไม่มีตั๋ว', en: 'No tickets', zh: '没有门票' },
  payCash: { th: 'เงินสด', en: 'Cash', zh: '现金' },
  payCard: { th: 'บัตรเครดิต (EDC)', en: 'Card (EDC)', zh: '银行卡 (EDC)' },
  payQr: { th: 'พร้อมเพย์ QR', en: 'PromptPay QR', zh: 'PromptPay 二维码' },
  payWallet: { th: 'เงินในบัตร', en: 'Card wallet', zh: '卡内余额' },
  payPoints: { th: 'คะแนนสะสม', en: 'Points', zh: '积分' },
  payTransfer: { th: 'โอนเงิน', en: 'Bank transfer', zh: '转账' },
  payComp: { th: 'ฟรี (Complimentary)', en: 'Complimentary', zh: '免单' },
  amountToPay: { th: 'ยอดที่ชำระครั้งนี้', en: 'Amount for this payment', zh: '本次支付金额' },
  splitHint: { th: 'ชำระบางส่วนได้ (แยกชำระหลายวิธี)', en: 'Partial amounts allowed (split payment)', zh: '可部分支付（组合支付）' },
  cashReceived: { th: 'รับเงินมา', en: 'Cash received', zh: '收到现金' },
  approvalCode: { th: 'รหัสอนุมัติ', en: 'Approval code', zh: '授权码' },
  last4: { th: 'เลขท้ายบัตร 4 หลัก', en: 'Card last 4', zh: '卡号后4位' },
  scanCardToPay: { th: 'สแกนบัตร / ริสแบนด์ / QR สมาชิก เพื่อตัดเงิน', en: 'Scan card / wristband / member QR to charge', zh: '扫描卡 / 腕带 / 会员码扣款' },
  waitingQr: { th: 'รอลูกค้าสแกนจ่าย…', en: 'Waiting for the customer to pay…', zh: '等待客户扫码付款…' },
  simulatePaid: { th: 'จำลองชำระสำเร็จ (Sandbox)', en: 'Simulate paid (sandbox)', zh: '模拟支付成功（沙盒）' },
  paymentComplete: { th: 'ชำระเงินครบแล้ว', en: 'Payment complete', zh: '付款完成' },
  paidSoFar: { th: 'ชำระแล้ว', en: 'Paid so far', zh: '已付' },
  remaining: { th: 'คงเหลือ', en: 'Remaining', zh: '剩余' },
  confirmPayment: { th: 'ยืนยันการชำระ', en: 'Confirm payment', zh: '确认付款' },
  printed: { th: 'ส่งพิมพ์ใบเสร็จลูกค้า + พนักงานแล้ว', en: 'Customer + staff receipts sent to printer', zh: '客户联+员工联已发送打印' },
  checks: { th: 'ผลการตรวจสอบ', en: 'Checks', zh: '检查结果' },
  guestOf: { th: 'ลูกค้า {i} จาก {n}', en: 'Guest {i} of {n}', zh: '第{i}位，共{n}位' },
});

export function Section({ title, icon, children, className }: { title: ReactNode; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('rounded-2xl border border-slate-200 bg-white p-4', className)}>
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-800', NEW: 'bg-sky-100 text-sky-800', SUSPENDED: 'bg-amber-100 text-amber-800', LOST: 'bg-rose-100 text-rose-800',
  BLOCKED: 'bg-rose-200 text-rose-900', EXPIRED: 'bg-slate-200 text-slate-700', REPLACED: 'bg-violet-100 text-violet-800', CLOSED: 'bg-slate-200 text-slate-700',
  PAID: 'bg-emerald-100 text-emerald-800', UNPAID: 'bg-amber-100 text-amber-800', USED: 'bg-slate-200 text-slate-700', CANCELLED: 'bg-rose-100 text-rose-800', REFUNDED: 'bg-rose-100 text-rose-800',
  INSIDE: 'bg-emerald-600 text-white', OUTSIDE: 'bg-slate-100 text-slate-700', ENTERING: 'bg-sky-600 text-white', EXHAUSTED: 'bg-slate-200 text-slate-600',
  CONFIRMED: 'bg-emerald-100 text-emerald-800', CHECKED_IN: 'bg-emerald-600 text-white', PENDING_PAYMENT: 'bg-amber-100 text-amber-800', RESERVED: 'bg-sky-100 text-sky-800',
  WAITING_VERIFICATION: 'bg-violet-100 text-violet-800', GRANTED: 'bg-emerald-600 text-white', DENIED: 'bg-rose-600 text-white', PENDING: 'bg-amber-500 text-white',
};
export function PStatus({ s }: { s: string | null | undefined }) {
  const t = useT();
  if (!s) return null;
  return <Badge className={STATUS_TONE[s] ?? 'bg-slate-100 text-slate-700'}>{t.status(s)}</Badge>;
}

export function TierBadge({ tier }: { tier: { name: any; color?: string | null } | null | undefined }) {
  const t = useT();
  if (!tier) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold text-white shadow-sm" style={{ background: tier.color || '#64748b' }}>
      <Star className="h-3 w-3" /> {t.tr(tier.name)}
    </span>
  );
}

/** Compact customer card after a scan (gate operator, ride, POS). */
export function SnapshotCard({ c, className, big }: { c: CustomerSnapshot | null | undefined; className?: string; big?: boolean }) {
  const t = useT(PS);
  if (!c || (!c.name && !c.ticketNo && !c.credentialCode)) return null;
  return (
    <div className={clsx('rounded-2xl border border-slate-200 bg-white p-4', className)}>
      <div className="flex items-start gap-3">
        <div className={clsx('flex shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500', big ? 'h-16 w-16' : 'h-11 w-11')}>
          <User className={big ? 'h-8 w-8' : 'h-5 w-5'} />
        </div>
        <div className="min-w-0 flex-1">
          <div className={clsx('truncate font-bold', big ? 'text-2xl' : 'text-base')}>{c.name || t('guest')}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
            {c.memberNo && <span className="font-mono">{c.memberNo}</span>}
            <TierBadge tier={c.tier} />
            {c.credentialCode && <span className="font-mono">{c.credentialCode}</span>}
            {c.guestCount && c.guestCount > 1 && <Badge>{t('guestOf', { i: c.guestIndex ?? 1, n: c.guestCount })}</Badge>}
          </div>
        </div>
        {c.walletBalance != null && (
          <div className="text-right">
            <div className="text-[11px] text-slate-500">{t('walletBalance')}</div>
            <div className={clsx('font-bold tabular-nums', big ? 'text-xl' : '')}>{money(c.walletBalance)}</div>
          </div>
        )}
      </div>
      {(c.ticketNo || c.packageName) && (
        <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-2.5 text-sm">
          <div><div className="text-[11px] text-slate-500">{t('package')}</div><div className="font-medium">{t.tr(c.packageName as any) || '-'}</div></div>
          <div><div className="text-[11px] text-slate-500">{t('ticketType')}</div><div className="font-medium">{t.tr(c.ticketType as any) || '-'}</div></div>
          <div><div className="text-[11px] text-slate-500">{t('ticket')}</div><div className="font-mono text-xs">{c.ticketNo ?? '-'}</div></div>
          <div><div className="text-[11px] text-slate-500">{t('visitDate')}</div><div className="font-medium">{c.visitDate ?? '-'}</div></div>
        </div>
      )}
    </div>
  );
}

export function ChecksList({ checks }: { checks: { key: string; ok: boolean; detail?: string | null }[] | null | undefined }) {
  const t = useT();
  if (!checks?.length) return null;
  return (
    <ul className="space-y-1">
      {checks.map((c) => (
        <li key={c.key} className={clsx('flex items-center gap-2 text-sm', c.ok ? 'text-emerald-700' : 'font-semibold text-rose-700')}>
          {c.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
          <span>{checkLabel(c.key, t.lang)}</span>
          {c.detail && <span className="text-xs font-normal text-slate-500">({c.detail})</span>}
        </li>
      ))}
    </ul>
  );
}

/** Full card profile (counter / POS / admin card page). */
export function ProfilePanel({ p, actions }: { p: any; actions?: ReactNode }) {
  const t = useT(PS);
  if (!p) return null;
  const c = p.credential;
  const m = p.member;
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-900 to-slate-700 p-4 text-white">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-white/60">{c.type.replace(/_/g, ' ')}</div>
            <div className="font-mono text-lg font-bold tracking-wider">{c.code}</div>
            <div className="mt-1 text-lg font-semibold">{m ? `${m.first_name} ${m.last_name}` : p.account?.display_name || c.label || t('guest')}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <PStatus s={c.status} />
              {m && <TierBadge tier={{ name: m.tier_name, color: m.tier_color }} />}
              {m && <span className="font-mono text-xs text-white/70">{m.member_no}</span>}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-white/60">{t('walletBalance')}</div>
            <div className="text-2xl font-extrabold tabular-nums">{p.wallet ? money(p.wallet.balance) : '—'}</div>
            {p.wallet && Number(p.wallet.bonus_balance) > 0 && <div className="text-xs text-amber-300">{t('bonus')} {money(p.wallet.bonus_balance)}</div>}
            {m && <div className="mt-1 text-sm text-white/80">{t('points')}: <b>{Number(m.points).toLocaleString()}</b></div>}
          </div>
        </div>
        {c.expires_at && <div className="mt-2 text-xs text-white/60">{t('expires')}: {new Date(c.expires_at).toLocaleString()}</div>}
        {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
      </div>
      <Section title={t('tickets')} icon={<Ticket className="h-4 w-4" />}>
        {!p.tickets?.length ? (
          <div className="text-sm text-slate-500">{t('noTickets')}</div>
        ) : (
          <div className="space-y-1.5">
            {p.tickets.map((tk: any) => (
              <div key={tk.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-sm">
                <span className="font-mono text-xs">{tk.ticket_no}</span>
                <span className="font-medium">{t.tr(tk.package_name)}</span>
                <span className="text-slate-500">{t.tr(tk.ticket_type_name)}</span>
                <span className="text-xs text-slate-500">{tk.visit_date}{tk.valid_to && tk.valid_to !== tk.visit_date ? ` → ${tk.valid_to}` : ''}</span>
                <span className="ml-auto flex gap-1"><PStatus s={tk.status} /><PStatus s={tk.presence} /></span>
              </div>
            ))}
          </div>
        )}
      </Section>
      {p.entitlements?.length > 0 && (
        <Section title={t('rideRights')} icon={<Gift className="h-4 w-4" />}>
          <div className="flex flex-wrap gap-1.5">
            {p.entitlements.map((e: any) => (
              <span key={e.id} className={clsx('rounded-full px-3 py-1 text-xs', e.status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-500 line-through')}>
                {t.tr(e.ride_name) || e.category || '★'} · {e.type === 'UNLIMITED' ? t('unlimited') : e.uses_left != null ? t('usesLeft', { n: e.uses_left }) : e.type}
              </span>
            ))}
          </div>
        </Section>
      )}
      {(p.lockers?.length > 0 || p.queues?.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {p.lockers?.length > 0 && (
            <Section title={t('lockers')} icon={<Lock className="h-4 w-4" />}>
              {p.lockers.map((l: any) => <div key={l.id} className="text-sm"><b>{l.locker_code}</b> · {t('expires')} {l.expire_at ? new Date(l.expire_at).toLocaleTimeString() : '-'}</div>)}
            </Section>
          )}
          {p.queues?.length > 0 && (
            <Section title={t('queues')} icon={<Timer className="h-4 w-4" />}>
              {p.queues.map((q: any) => <div key={q.id} className="text-sm"><b>{q.queue_no}</b> · {t.tr(q.ride_name)} <PStatus s={q.status} /></div>)}
            </Section>
          )}
        </div>
      )}
      {p.linkedCredentials?.length > 0 && (
        <Section title={t('linkedCards')}>
          <div className="flex flex-wrap gap-1.5">
            {p.linkedCredentials.map((l: any) => <span key={l.id} className="rounded-full bg-slate-100 px-3 py-1 font-mono text-xs">{l.code} · {l.type.replace(/_/g, ' ')} · {t.status(l.status)}</span>)}
          </div>
        </Section>
      )}
    </div>
  );
}

type Method = 'CASH' | 'CARD' | 'PROMPTPAY' | 'WALLET' | 'BANK_TRANSFER' | 'POINTS' | 'COMP';
const METHOD_ICON: Record<Method, any> = { CASH: Banknote, CARD: CreditCard, PROMPTPAY: QrIcon, WALLET: Wallet, BANK_TRANSFER: QrIcon, POINTS: Star, COMP: Gift };

/**
 * Staff payment for a park sale: cash (with change), card EDC, PromptPay QR (realtime), wallet by scanning
 * a card / wristband, points, complimentary — repeatable for split payments until fully paid.
 */
export function StaffPayDialog({ saleId, socket, onClose, onPaid, methods = ['CASH', 'CARD', 'PROMPTPAY', 'WALLET', 'BANK_TRANSFER'], defaultCredential, quickCash = [100, 500, 1000] }: {
  saleId: string;
  socket: Socket | null;
  onClose: () => void;
  onPaid: (detail: any) => void;
  methods?: Method[];
  defaultCredential?: string | null;
  quickCash?: number[];
}) {
  const t = useT(PS);
  const [detail, setDetail] = useState<any>(null);
  const [method, setMethod] = useState<Method>(methods[0]);
  const [amount, setAmount] = useState<number | null>(null);
  const [received, setReceived] = useState<number | null>(null);
  const [approval, setApproval] = useState('');
  const [last4, setLast4] = useState('');
  const [pending, setPending] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const d = await parkApi(`/sales/${saleId}`);
    setDetail(d);
    const rem = Math.max(0, Number(d.sale.total) - Number(d.sale.paid_amount));
    setAmount(rem);
    if (d.sale.status === 'PAID') onPaid(d);
    return d;
  };
  useEffect(() => {
    void load();
    return watch(socket, 'sale', saleId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saleId, socket]);
  useSocketEvent(socket, [EVENTS.SALE_PAID, EVENTS.SALE_UPDATED], (d) => {
    if (d?.saleId === saleId) void load();
  });
  if (!detail) return null;
  const total = Number(detail.sale.total);
  const paid = Number(detail.sale.paid_amount);
  const remaining = Math.max(0, total - paid);
  const pay = async (extra: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const body: any = { method, amount: amount && amount < remaining ? amount : null, ...extra };
      if (method === 'CASH') body.received = received ?? amount ?? remaining;
      if (method === 'CARD' || method === 'BANK_TRANSFER') Object.assign(body, { confirmNow: true, approvalCode: approval || null, cardLast4: last4 || null, reference: approval || null });
      const r = await parkApi(`/sales/${saleId}/payments`, { body, idempotencyKey: newKey() });
      if (r.payment.status === 'PAID') {
        if (method === 'CASH' && Number(r.payment.change_amount) > 0) toast.success(`${t('change')} ${money(r.payment.change_amount)}`);
        setPending(null);
        setReceived(null);
        const d = await load();
        if (d.sale.status !== 'PAID') toast.success(t('paid'), `${t('remaining')} ${money(Number(d.sale.total) - Number(d.sale.paid_amount))}`);
      } else setPending(r.payment);
    } catch (e) {
      toast.error(t.err(e));
    } finally {
      setBusy(false);
    }
  };
  const change = method === 'CASH' && received != null ? received - (amount ?? remaining) : null;
  return (
    <Modal open onClose={onClose} title={`${t('pay')} · ${detail.sale.sale_no}`} size="lg">
      <div className="grid gap-5 md:grid-cols-[1fr_260px]">
        <div>
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {methods.map((m) => {
              const I = METHOD_ICON[m];
              return (
                <button key={m} onClick={() => { setMethod(m); setPending(null); }} className={clsx('press flex h-16 flex-col items-center justify-center gap-1 rounded-xl border-2 text-sm font-semibold', method === m ? 'border-primary bg-primary/5 text-primary' : 'border-slate-200 text-slate-700')}>
                  <I className="h-5 w-5" />
                  {t.method(m)}
                </button>
              );
            })}
          </div>
          <Field label={t('amountToPay')} hint={t('splitHint')}>
            <NumberInput value={amount} onChange={setAmount} min={0} max={remaining} />
          </Field>
          {method === 'CASH' && (
            <div className="mt-3 space-y-2">
              <Field label={t('cashReceived')}><NumberInput value={received} onChange={setReceived} /></Field>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="secondary" onClick={() => setReceived(amount ?? remaining)}>{money(amount ?? remaining)}</Button>
                {quickCash.map((q) => <Button key={q} size="sm" variant="secondary" onClick={() => setReceived(q)}>{money(q)}</Button>)}
              </div>
              {change != null && <div className={clsx('rounded-xl p-3 text-lg font-bold', change < 0 ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700')}>{t('change')}: {money(Math.max(0, change))}</div>}
              <Button size="lg" className="w-full" loading={busy} disabled={change != null && change < 0} onClick={() => pay()}>{t('confirmPayment')}</Button>
            </div>
          )}
          {(method === 'CARD' || method === 'BANK_TRANSFER') && (
            <div className="mt-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('approvalCode')}><Input value={approval} onChange={(e) => setApproval(e.target.value)} /></Field>
                {method === 'CARD' && <Field label={t('last4')}><Input value={last4} maxLength={4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, ''))} /></Field>}
              </div>
              <Button size="lg" className="w-full" loading={busy} onClick={() => pay()}>{t('confirmPayment')}</Button>
            </div>
          )}
          {method === 'PROMPTPAY' && (
            <div className="mt-3">
              {!pending ? (
                <Button size="lg" className="w-full" loading={busy} onClick={() => pay()}>{t('payQr')}</Button>
              ) : (
                <div className="flex flex-col items-center gap-2 rounded-2xl bg-slate-50 p-4">
                  <QrCode value={pending.qr_payload} size={220} />
                  <div className="text-2xl font-bold">{money(pending.amount)}</div>
                  <div className="animate-pulse text-sm text-slate-500">{t('waitingQr')}</div>
                  <div className="flex gap-2">
                    {pending.provider === 'sandbox' && <Button size="sm" variant="outline" onClick={async () => { await parkApi(`/sales/${saleId}/payments/${pending.id}/sandbox`, { body: { outcome: 'succeeded' } }).catch((e) => toast.error(t.err(e))); }}>{t('simulatePaid')}</Button>}
                    <Button size="sm" variant="ghost" onClick={async () => { await parkApi(`/sales/${saleId}/payments/${pending.id}/cancel`, { method: 'POST' }).catch(() => {}); setPending(null); }}>{t('cancel')}</Button>
                  </div>
                </div>
              )}
            </div>
          )}
          {(method === 'WALLET' || method === 'POINTS') && (
            <div className="mt-3 space-y-2">
              <div className="text-sm text-slate-600">{t('scanCardToPay')}</div>
              {defaultCredential && <Button variant="secondary" loading={busy} onClick={() => pay({ credentialCode: defaultCredential })}>{t('confirmPayment')} · {defaultCredential.slice(0, 16)}</Button>}
              <ScanBar busy={busy} onScan={(code) => pay({ credentialCode: code })} />
            </div>
          )}
          {method === 'COMP' && <Button size="lg" className="mt-3 w-full" loading={busy} onClick={() => pay({ confirmNow: true })}>{t('confirmPayment')}</Button>}
        </div>
        <div className="space-y-2 rounded-2xl bg-slate-50 p-4">
          <div className="flex justify-between text-sm"><span>{t('total')}</span><b>{money(total)}</b></div>
          <div className="flex justify-between text-sm text-emerald-700"><span>{t('paidSoFar')}</span><b>{money(paid)}</b></div>
          <div className="flex justify-between border-t pt-2 text-lg"><span>{t('remaining')}</span><b>{money(remaining)}</b></div>
          <div className="space-y-1 pt-2">
            {detail.payments.map((p: any) => (
              <div key={p.id} className="flex items-center justify-between text-xs">
                <span>{t.method(p.method)}</span>
                <span className="tabular-nums">{money(p.amount)} <PStatus s={p.status} /></span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Small "+ / −" stepper. */
export function Stepper({ value, onChange, min = 0, max = 99 }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <div className="inline-flex items-center rounded-xl border border-slate-300 bg-white">
      <button type="button" className="press h-9 w-9 text-lg font-bold text-slate-600 disabled:opacity-30" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <span className="w-8 text-center font-semibold tabular-nums">{value}</span>
      <button type="button" className="press h-9 w-9 text-lg font-bold text-slate-600 disabled:opacity-30" disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>+</button>
    </div>
  );
}

/** Image that hides itself when the URL is missing / broken (catalogue images are optional). */
export function SafeImg({ src, className, alt = '' }: { src: string | null | undefined; className?: string; alt?: string }) {
  const [ok, setOk] = useState(true);
  if (!src || !ok) return null;
  return <img src={src} alt={alt} className={className} onError={() => setOk(false)} loading="lazy" />;
}
