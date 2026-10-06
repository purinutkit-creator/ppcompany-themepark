import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Ban, Banknote, BellRing, CheckCircle2, Printer, RotateCcw, Undo2, PackageCheck, ShieldCheck, XCircle, ZoomIn } from 'lucide-react';
import { tr } from '@kiosk/shared';
import { staffApi, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, money, time } from '../lib/format';
import { Badge, Button, ErrorBox, Loading, Modal, NumberInput, Field, Select, StatusBadge, Input, confirmDialog, promptDialog, toast, withManagerApproval } from './ui';
import { CashDialog } from './CashDialog';
import { tt } from '../lib/legacy-i18n';

const EVENT_LABEL: Record<string, string> = {
  ORDER_CREATED: 'Order created',
  PAYMENT_SELECTED: 'Payment selected',
  VERIFICATION_REQUESTED: 'Verification requested',
  SLIP_UPLOADED: 'Slip uploaded',
  PAYMENT_APPROVED: 'Payment approved',
  PAYMENT_REJECTED: 'Payment rejected',
  PAYMENT_CONFIRMED: 'Payment confirmed',
  PAYMENT_CANCELLED: 'Payment attempt cancelled',
  ORDER_CONFIRMED: 'Order confirmed',
  KITCHEN_RECEIVED: 'Kitchen received',
  PRINT_QUEUED: 'Print jobs queued',
  PRINTED: 'Printed',
  PRINT_RETRYING: 'Print failed — retrying',
  PRINT_FAILED: 'Print failed',
  PRINT_SKIPPED: 'Print skipped',
  PREPARING: 'Preparing',
  READY: 'Ready',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Partially refunded',
  QUEUE_CALLED: 'Queue number called',
  STAFF_CALLED: 'Customer called staff',
  REPRINT: 'Reprint requested',
  CARD_PROCESSING: 'Card processing',
  CARD_DECLINED: 'Card declined',
  CARD_CANCELLED: 'Card cancelled',
  LATE_PAYMENT_NEEDS_REFUND: 'Late payment — refund needed',
  PAYMENT_AMOUNT_MISMATCH: 'Payment amount mismatch',
};

export function useOrderDetail(id: string | null) {
  return useQuery({ queryKey: ['order', id], queryFn: () => staffApi<any>(`/orders/${id}`), enabled: !!id, refetchInterval: 15000 });
}

export function OrderDetail({ id, compact = false }: { id: string; compact?: boolean }) {
  const q = useOrderDetail(id);
  const qc = useQueryClient();
  const { can } = useAuth();
  const [cash, setCash] = useState(false);
  const [slip, setSlip] = useState<string | null>(null);
  const [refund, setRefund] = useState(false);
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const o = d.order;
  const paid = ['PAID', 'PARTIALLY_REFUNDED'].includes(o.payment_status);
  const open = !['CANCELLED', 'REFUNDED', 'COMPLETED'].includes(o.status);
  const openVerification = d.verifications.find((v: any) => v.status === 'WAITING_VERIFICATION');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['order', id] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
    void qc.invalidateQueries({ queryKey: ['verifications'] });
  };
  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (r !== null) toast.success(ok);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-4xl font-black tracking-wider text-slate-900">#{o.order_number}</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge status={o.status} />
            <StatusBadge status={o.payment_status} />
            <Badge className="bg-slate-800 text-white">{o.order_type === 'DINE_IN' ? 'DINE IN' : 'TAKE AWAY'}</Badge>
            <Badge>{o.kiosk_code ?? (o.source === 'CASHIER' ? 'POS' : '—')}</Badge>
            {o.offline_ref && <Badge className="bg-amber-100 text-amber-800">{tt('Offline')} {o.offline_ref}</Badge>}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Created {dateTime(o.created_at)} · ID <span className="font-mono">{o.id.slice(0, 8)}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm text-slate-500">{tt('Total')}</div>
          <div className="text-3xl font-bold">{money(o.total)}</div>
          {Number(o.refunded_amount) > 0 && <div className="text-sm text-fuchsia-700">{tt('Refunded')} {money(o.refunded_amount)}</div>}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        {open && !paid && can('payments.cash') && (
          <Button variant="success" icon={<Banknote className="h-4 w-4" />} onClick={() => setCash(true)}>
            {tt('Receive cash')}
          </Button>
        )}
        {openVerification && can('payments.verify') && (
          <>
            <Button
              variant="success"
              icon={<CheckCircle2 className="h-4 w-4" />}
              loading={busy === 'approve'}
              onClick={() => act('approve', () => staffApi(`/payments/verifications/${openVerification.id}/approve`, { body: {}, idempotencyKey: `approve-${openVerification.id}` }), 'Payment approved')}
            >
              ✓ ยืนยันการชำระเงิน
            </Button>
            <Button
              variant="danger"
              icon={<XCircle className="h-4 w-4" />}
              onClick={async () => {
                const reason = await promptDialog(tt('Reject payment — reason'), 'e.g. Amount does not match / slip not found');
                if (reason) await act('reject', () => staffApi(`/payments/verifications/${openVerification.id}/reject`, { body: { reason } }), 'Payment rejected');
              }}
            >
              ✕ ไม่ถูกต้อง
            </Button>
          </>
        )}
        {open && !paid && (
          <Button variant="outline" icon={<ShieldCheck className="h-4 w-4" />} onClick={() => setManual(true)}>
            {tt('Manual approval')}
          </Button>
        )}
        {paid && ['PAID', 'CONFIRMED', 'NEW', 'PREPARING', 'READY'].includes(o.status) && can('orders.manage') && (
          <Button variant="primary" icon={<PackageCheck className="h-4 w-4" />} loading={busy === 'complete'} onClick={() => act('complete', () => staffApi(`/orders/${id}/complete`, { method: 'POST' }), 'Order completed')}>
            {tt('Picked up / Complete')}
          </Button>
        )}
        {paid && open && can('queue.manage') && (
          <Button variant="outline" icon={<BellRing className="h-4 w-4" />} onClick={() => act('call', () => staffApi(`/orders/${id}/call`, { method: 'POST' }), 'Number called')}>
            {tt('Call again')}
          </Button>
        )}
        {paid && (
          <>
            <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => act('rr', () => withManagerApproval(tt('Reprint receipt'), (a) => staffApi(`/orders/${id}/reprint`, { body: { kind: 'RECEIPT', ...a } })), 'Receipt reprint queued')}>
              {tt('Reprint receipt')}
            </Button>
            <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => act('rk', () => withManagerApproval(tt('Reprint kitchen ticket'), (a) => staffApi(`/orders/${id}/reprint`, { body: { kind: 'KITCHEN_TICKET', ...a } })), 'Kitchen reprint queued')}>
              {tt('Reprint kitchen')}
            </Button>
          </>
        )}
        {paid && (
          <Button variant="outline" icon={<Undo2 className="h-4 w-4" />} onClick={() => setRefund(true)}>
            {tt('Refund')}
          </Button>
        )}
        {open && (
          <Button
            variant="ghost"
            className="text-rose-600"
            icon={<Ban className="h-4 w-4" />}
            onClick={async () => {
              const reason = await promptDialog(paid ? 'Void / cancel PAID order' : 'Cancel order', 'Reason', paid ? 'This order is paid. A manager PIN may be required. Stock is returned if the kitchen has not started.' : undefined);
              if (!reason) return;
              await act('cancel', () => withManagerApproval(paid ? 'Void paid order' : 'Cancel order', (a) => staffApi(`/orders/${id}/${paid ? 'void' : 'cancel'}`, { body: { reason, ...a } })), paid ? 'Order voided' : 'Order cancelled');
            }}
          >
            {paid ? 'Void' : tt('Cancel')}
          </Button>
        )}
      </div>

      <div className={clsx('grid gap-5', !compact && 'lg:grid-cols-2')}>
        <div className="space-y-5">
          <section>
            <h3 className="mb-2 font-semibold text-slate-800">{tt('Items')}</h3>
            <div className="divide-y rounded-xl border">
              {d.items.map((i: any) => (
                <div key={i.id} className="flex gap-3 p-3">
                  {i.image_url && <img src={i.image_url} className="h-12 w-12 rounded-lg bg-slate-50 object-contain" alt="" />}
                  <div className="flex-1">
                    <div className="flex justify-between font-medium">
                      <span>
                        {i.qty} × {tr(i.name, 'th')} <span className="text-xs text-slate-400">{tr(i.name, 'en')}</span>
                      </span>
                      <span>{money(i.line_total)}</span>
                    </div>
                    {i.modifiers.map((m: any) => (
                      <div key={m.id} className="text-sm text-slate-500">
                        {m.kind === 'REMOVE' ? '− ' : '+ '}
                        {tr(m.name, 'th')}
                        {Number(m.price_delta) ? ` (${money(m.price_delta)})` : ''}
                      </div>
                    ))}
                    {i.special_request && <div className="text-sm text-amber-700">“{i.special_request}”</div>}
                    <div className="text-xs text-slate-400">
                      {money(i.unit_price)} each · {tr(i.station_name, 'en')}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 space-y-1 text-sm">
              <Row k="Subtotal" v={money(o.subtotal)} />
              {Number(o.discount) > 0 && <Row k={`Discount ${(o.applied_promotions ?? []).map((p: any) => tr(p.name, 'en')).join(', ')}`} v={`−${money(o.discount)}`} cls="text-emerald-700" />}
              {Number(o.service_charge) > 0 && <Row k="Service charge" v={money(o.service_charge)} />}
              <Row k={`VAT ${o.vat_rate}% (${o.vat_mode.toLowerCase()})`} v={money(o.vat)} />
              <Row k="Grand total" v={money(o.total)} cls="text-base font-bold" />
            </div>
          </section>

          <section>
            <h3 className="mb-2 font-semibold text-slate-800">{tt('Payments')}</h3>
            {d.payments.length === 0 && <div className="text-sm text-slate-500">{tt('No payment yet')}</div>}
            {d.payments.map((p: any) => (
              <div key={p.id} className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3 text-sm">
                <div>
                  <div className="font-medium">
                    {p.method} · {p.provider}
                  </div>
                  <div className="text-xs text-slate-500">
                    {dateTime(p.created_at)}
                    {p.paid_at && ` · paid ${time(p.paid_at, true)}`}
                    {p.confirmed_by_name && ` · by ${p.confirmed_by_name}`}
                    {p.card_last4 && ` · ${p.card_brand ?? ''} ****${p.card_last4}`}
                    {p.reference && ` · ref ${p.reference}`}
                  </div>
                  {p.received_amount != null && (
                    <div className="text-xs text-slate-600">
                      Received {money(p.received_amount)} · Change {money(p.change_amount)}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{money(p.amount)}</span>
                  <StatusBadge status={p.status} />
                </div>
              </div>
            ))}
            {d.verifications.map((v: any) => (
              <div key={v.id} className="mb-2 flex items-center gap-3 rounded-xl border border-dashed p-3 text-sm">
                {v.slip_url ? (
                  <button onClick={() => setSlip(v.slip_url)} className="relative">
                    <img src={v.slip_url} className="h-16 w-12 rounded object-cover" alt="slip" />
                    <ZoomIn className="absolute right-0 bottom-0 h-4 w-4 rounded bg-white" />
                  </button>
                ) : (
                  <div className="flex h-16 w-12 items-center justify-center rounded bg-slate-100 text-[10px] text-slate-400">{tt('no slip')}</div>
                )}
                <div className="flex-1">
                  <div>Verification · expected {money(v.expected_amount)}</div>
                  <div className="text-xs text-slate-500">
                    {dateTime(v.requested_at)}
                    {v.decided_by_name && ` · ${v.decided_by_name}`}
                    {v.reason && ` · ${v.reason}`}
                  </div>
                </div>
                <StatusBadge status={v.status} />
              </div>
            ))}
            {d.refunds.map((r: any) => (
              <div key={r.id} className="mb-2 flex justify-between rounded-xl bg-fuchsia-50 p-3 text-sm">
                <span>
                  Refund — {r.reason} ({r.created_by_name})
                </span>
                <span className="font-semibold">−{money(r.amount)}</span>
              </div>
            ))}
          </section>

          <section>
            <h3 className="mb-2 font-semibold text-slate-800">{tt('Print jobs')}</h3>
            {d.prints.length === 0 && <div className="text-sm text-slate-500">{tt('No print jobs')}</div>}
            {d.prints.map((j: any) => (
              <div key={j.id} className="mb-1.5 flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
                <span>
                  {j.document_type === 'RECEIPT' ? '🧾 Receipt' : '🍳 Kitchen'} {j.is_reprint && <Badge className="bg-amber-100 text-amber-800">reprint</Badge>} → {j.printer_name ?? '—'}
                  {j.last_error && <span className="block text-xs text-rose-600">{j.last_error}</span>}
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={j.status} />
                  {['FAILED', 'RETRYING', 'CANCELLED'].includes(j.status) && (
                    <Button size="sm" variant="outline" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => act('retry', () => staffApi(`/print/jobs/${j.id}/retry`, { method: 'POST' }), 'Retry queued')}>
                      {tt('Retry')}
                    </Button>
                  )}
                </span>
              </div>
            ))}
          </section>
        </div>

        <section>
          <h3 className="mb-2 font-semibold text-slate-800">{tt('Timeline')}</h3>
          <ol className="relative ml-2 border-l-2 border-slate-200">
            {d.events.map((e: any) => (
              <li key={e.id} className="mb-3 ml-4">
                <span className={clsx('absolute -left-[7px] mt-1.5 h-3 w-3 rounded-full border-2 border-white', e.type.includes('REJECT') || e.type.includes('FAIL') || e.type === 'CANCELLED' ? 'bg-rose-500' : e.type.includes('APPROV') || e.type === 'COMPLETED' || e.type === 'READY' ? 'bg-emerald-500' : 'bg-slate-400')} />
                <div className="flex items-baseline gap-3 text-sm">
                  <span className="font-mono text-xs text-slate-500 tabular-nums">{time(e.created_at, true)}</span>
                  <span className="font-medium text-slate-800">{EVENT_LABEL[e.type] ?? e.type}</span>
                </div>
                <div className="text-xs text-slate-500">
                  {e.actor_type}
                  {e.actor_name ? ` · ${e.actor_name}` : ''}
                  {e.data && Object.keys(e.data).length > 0 && ` · ${summarize(e.data)}`}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {cash && <CashDialog order={o} onClose={() => setCash(false)} onDone={refresh} />}
      {refund && <RefundDialog order={o} onClose={() => setRefund(false)} onDone={refresh} />}
      {manual && <ManualApproveDialog order={o} onClose={() => setManual(false)} onDone={refresh} />}
      <Modal open={!!slip} onClose={() => setSlip(null)} title={tt('Payment slip')} size="lg">
        {slip && <img src={slip} alt="slip" className="mx-auto max-h-[75vh] rounded-xl" />}
      </Modal>
    </div>
  );
}

function summarize(d: Record<string, any>) {
  return Object.entries(d)
    .filter(([, v]) => v != null && typeof v !== 'object')
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
}
function Row({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className={clsx('flex justify-between', cls)}>
      <span className="text-slate-600">{k}</span>
      <span className="tabular-nums">{v}</span>
    </div>
  );
}

function RefundDialog({ order, onClose, onDone }: { order: any; onClose: () => void; onDone: () => void }) {
  const max = Number(order.total) - Number(order.refunded_amount);
  const [amount, setAmount] = useState<number | null>(max);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await withManagerApproval(tt('Refund'), (a) => staffApi(`/orders/${order.id}/refund`, { body: { amount, reason, ...a }, idempotencyKey: `refund-${order.id}-${amount}-${reason}` }));
      if (r) {
        toast.success(tt('Refund recorded'));
        onDone();
        onClose();
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Refund #${order.order_number}`} size="sm" footer={<><Button variant="ghost" onClick={onClose}>{tt('Cancel')}</Button><Button variant="danger" loading={busy} disabled={!amount || amount > max || !reason} onClick={submit}>Refund {money(amount ?? 0)}</Button></>}>
      <div className="space-y-3">
        <Field label={`Amount (max ${money(max)})`}>
          <NumberInput value={amount} onChange={setAmount} min={0} max={max} step="0.01" />
        </Field>
        <Field label={tt('Reason')}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tt('Customer complaint / wrong item…')} />
        </Field>
      </div>
    </Modal>
  );
}

function ManualApproveDialog({ order, onClose, onDone }: { order: any; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState<'QR' | 'CASH' | 'CARD' | 'OTHER'>(order.payment_method ?? 'OTHER');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!(await confirmDialog(tt('Confirm manual payment approval'), `Mark #${order.order_number} (${money(order.total)}) as PAID via ${method}? This is logged with your name.`))) return;
    setBusy(true);
    try {
      const r = await withManagerApproval(tt('Manual payment approval'), (a) => staffApi(`/orders/${order.id}/manual-payment`, { body: { method, reference: reference || null, ...a }, idempotencyKey: `manual-${order.id}` }));
      if (r) {
        toast.success(tt('Payment approved'));
        onDone();
        onClose();
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={tt('Manual payment approval')} size="sm" footer={<><Button variant="ghost" onClick={onClose}>{tt('Cancel')}</Button><Button variant="success" loading={busy} onClick={submit}>Approve {money(order.total)}</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">{tt('Use when payment was verified outside the system (e.g. offline EDC terminal, voucher). Requires manager approval if configured.')}</p>
        <Field label={tt('Method')}>
          <Select value={method} onChange={(e) => setMethod(e.target.value as any)}>
            <option value="QR">{tt('QR / Transfer')}</option>
            <option value="CARD">{tt('Card (EDC)')}</option>
            <option value="CASH">{tt('Cash')}</option>
            <option value="OTHER">{tt('Other')}</option>
          </Select>
        </Field>
        <Field label={tt('Reference (slip ref / approval code)')}>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
