import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, XCircle, ImageOff } from 'lucide-react';
import { tr } from '@kiosk/shared';
import { staffApi, errorMessage } from '../lib/api';
import { dateTime, money, time, elapsed } from '../lib/format';
import { Button, Empty, Field, Input, Loading, NumberInput, StatusBadge, Tabs, promptDialog, toast } from '../components/ui';

/** Slip Verification Center: queue on the left, order + slip + big APPROVE / REJECT on the right. */
export function VerificationCenter() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'WAITING_VERIFICATION' | 'APPROVED,REJECTED'>('WAITING_VERIFICATION');
  const list = useQuery({ queryKey: ['verifications', filter], queryFn: () => staffApi<any[]>(`/payments/verifications?status=${filter}`), refetchInterval: 15000 });
  const current = id ?? (filter === 'WAITING_VERIFICATION' ? list.data?.[0]?.id : undefined);
  const detail = useQuery({ queryKey: ['verification', current], queryFn: () => staffApi<any>(`/payments/verifications/${current}`), enabled: !!current });
  const [paidAmount, setPaidAmount] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  useEffect(() => {
    setPaidAmount(detail.data ? Number(detail.data.verification.expected_amount) : null);
    setNote('');
  }, [detail.data]);

  const done = () => {
    void qc.invalidateQueries({ queryKey: ['verifications'] });
    void qc.invalidateQueries({ queryKey: ['verification'] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
    nav('/cashier/verify');
  };
  const approve = async () => {
    setBusy('approve');
    try {
      const r = await staffApi<any>(`/payments/verifications/${current}/approve`, { body: { paidAmount, note: note || null }, idempotencyKey: `approve-${current}` });
      toast.success(r.alreadyPaid ? 'Already approved' : `Approved #${detail.data.order.order_number}`, 'Kiosk notified · kitchen & receipt printing');
      done();
    } catch (e) {
      toast.error(errorMessage(e));
      void detail.refetch();
    } finally {
      setBusy(null);
    }
  };
  const reject = async () => {
    const reason = await promptDialog('Reason for rejection', 'e.g. Transfer not received / amount mismatch');
    if (!reason) return;
    setBusy('reject');
    try {
      await staffApi(`/payments/verifications/${current}/reject`, { body: { reason } });
      toast.info(`Rejected #${detail.data.order.order_number}`, 'Customer has been notified on the kiosk');
      done();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const d = detail.data;
  const v = d?.verification;
  const mismatch = v && paidAmount != null && Math.abs(paidAmount - Number(v.expected_amount)) > 0.005;
  return (
    <div className="flex h-full">
      <aside className="flex w-96 shrink-0 flex-col border-r bg-white">
        <div className="p-3">
          <Tabs tabs={[{ id: 'WAITING_VERIFICATION', label: 'Waiting', count: filter === 'WAITING_VERIFICATION' ? list.data?.length : undefined, tone: 'bg-orange-500 text-white' }, { id: 'APPROVED,REJECTED', label: 'Decided (24h)' }]} value={filter} onChange={(f) => { setFilter(f); nav('/cashier/verify'); }} />
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto">
          {list.isLoading && <Loading />}
          {list.data?.length === 0 && <Empty title="No pending verifications" sub="New requests pop up here in real time." />}
          {list.data?.map((x) => (
            <button key={x.id} onClick={() => nav(`/cashier/verify/${x.id}`)} className={clsx('flex w-full items-center gap-3 border-b px-4 py-3 text-left hover:bg-slate-50', current === x.id && 'bg-primary/5 ring-2 ring-primary ring-inset')}>
              <div className="flex-1">
                <div className="text-xl font-black tracking-wider">#{x.order_number}</div>
                <div className="text-xs text-slate-500">
                  {x.kiosk_code ?? '—'} · {time(x.requested_at)} · waiting {elapsed(x.requested_at)}
                </div>
              </div>
              <div className="text-right">
                <div className="font-bold">{money(x.total)}</div>
                {x.status !== 'WAITING_VERIFICATION' ? <StatusBadge status={x.status} /> : x.slip_url ? <span className="text-xs text-emerald-600">slip ✓</span> : <span className="text-xs text-slate-400">no slip</span>}
              </div>
            </button>
          ))}
        </div>
      </aside>
      <section className="scroll-thin min-w-0 flex-1 overflow-y-auto p-6">
        {!current ? (
          <Empty title="Select a request" />
        ) : detail.isLoading || !d ? (
          <Loading />
        ) : (
          <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white p-5 shadow-sm">
                <div>
                  <div className="text-sm text-slate-500">Order</div>
                  <div className="text-5xl font-black tracking-wider">#{d.order.order_number}</div>
                  <div className="mt-1 text-sm text-slate-500">
                    {d.order.kiosk_code ?? 'POS'} · {d.order.order_type === 'DINE_IN' ? 'Dine in' : 'Take away'} · ordered {dateTime(d.order.created_at)}
                  </div>
                </div>
                <StatusBadge status={v.status} className="text-sm" />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <Info label="Expected amount" value={money(v.expected_amount)} big />
                <Info label="Payment method" value={`QR / Transfer (${d.payments.find((p: any) => p.id === v.payment_id)?.provider ?? ''})`} />
                <Info label="Requested at" value={dateTime(v.requested_at)} />
                <Info label="Customer reference" value={v.customer_reference || '—'} />
              </div>
              <div className="rounded-2xl bg-white p-5 shadow-sm">
                <div className="mb-2 font-semibold">Items</div>
                {d.items.map((i: any) => (
                  <div key={i.id} className="flex justify-between border-b py-1.5 text-sm last:border-0">
                    <span>
                      {i.qty} × {tr(i.name, 'th')}
                      {i.modifiers.length > 0 && <span className="text-slate-500"> ({i.modifiers.map((m: any) => tr(m.name, 'th')).join(', ')})</span>}
                    </span>
                    <span>{money(i.line_total)}</span>
                  </div>
                ))}
                <div className="mt-2 flex justify-between font-bold">
                  <span>Order total</span>
                  <span>{money(d.order.total)}</span>
                </div>
              </div>
              {v.status === 'WAITING_VERIFICATION' && (
                <div className="rounded-2xl bg-white p-5 shadow-sm">
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label="Paid amount (from bank app / slip)" error={mismatch ? 'Differs from expected amount' : null}>
                      <NumberInput value={paidAmount} onChange={setPaidAmount} step="0.01" />
                    </Field>
                    <Field label="Note (optional)">
                      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Bank ref / last 4 digits" />
                    </Field>
                  </div>
                  <div className="mt-5 grid gap-3 md:grid-cols-2">
                    <Button size="xl" variant="success" loading={busy === 'approve'} disabled={!!busy} icon={<CheckCircle2 className="h-7 w-7" />} onClick={approve}>
                      ✓ APPROVE
                    </Button>
                    <Button size="xl" variant="danger" loading={busy === 'reject'} disabled={!!busy} icon={<XCircle className="h-7 w-7" />} onClick={reject}>
                      ✕ REJECT
                    </Button>
                  </div>
                </div>
              )}
              {v.status !== 'WAITING_VERIFICATION' && (
                <div className="rounded-2xl bg-white p-5 text-sm shadow-sm">
                  Decided by <b>{v.decided_by_name ?? '—'}</b> at {dateTime(v.decided_at)} {v.reason && <>— {v.reason}</>}
                </div>
              )}
            </div>
            <div className="rounded-2xl bg-white p-4 shadow-sm">
              <div className="mb-2 font-semibold">Payment slip</div>
              {v.slip_url ? (
                <a href={v.slip_url} target="_blank" rel="noreferrer">
                  <img src={v.slip_url} alt="slip" className="w-full rounded-xl border" />
                </a>
              ) : (
                <div className="flex h-80 flex-col items-center justify-center gap-2 rounded-xl bg-slate-50 text-slate-400">
                  <ImageOff className="h-10 w-10" />
                  No slip uploaded — check the bank app for {money(v.expected_amount)}
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Info({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={clsx('font-semibold', big ? 'text-3xl text-primary' : 'text-base')}>{value}</div>
    </div>
  );
}
