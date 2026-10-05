import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Delete } from 'lucide-react';
import { staffApi, errorMessage } from '../lib/api';
import { money } from '../lib/format';
import { Button, Modal, toast } from './ui';
import { useQuery } from '@tanstack/react-query';

/** Cash payment: quick amounts (Exact / 100 / 500 / 1000), keypad, automatic change calculation. */
export function CashDialog({ order, onClose, onDone }: { order: any; onClose: () => void; onDone: () => void }) {
  const total = Number(order.total);
  const client = useQuery({ queryKey: ['client-settings'], queryFn: () => staffApi<any>('/settings/client') });
  const quick: number[] = client.data?.settings?.payment?.cash?.quickAmounts ?? [100, 500, 1000];
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const idem = useMemo(() => `cash-${order.id}-${crypto.randomUUID()}`, [order.id]);
  const received = input ? Number(input) : 0;
  const change = received - total;

  const submit = async () => {
    setBusy(true);
    try {
      const r = await staffApi<any>(`/orders/${order.id}/cash`, { body: { received }, idempotencyKey: idem });
      toast.success(r.alreadyPaid ? 'Order was already paid' : `Paid — change ${money(r.change ?? change)}`);
      onDone();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const key = (k: string) => setInput((v) => (k === '.' && v.includes('.') ? v : (v + k).replace(/^0(\d)/, '$1').slice(0, 9)));

  return (
    <Modal open onClose={onClose} title={`Cash payment — #${order.order_number}`} size="md">
      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-3">
          <div className="rounded-2xl bg-slate-900 p-4 text-white">
            <div className="text-sm text-white/60">Amount due</div>
            <div className="text-4xl font-bold tabular-nums">{money(total)}</div>
          </div>
          <div className="rounded-2xl border p-4">
            <div className="text-sm text-slate-500">Received</div>
            <div className="text-3xl font-bold tabular-nums">{money(received)}</div>
          </div>
          <div className={clsx('rounded-2xl p-4', change >= 0 ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-700')}>
            <div className="text-sm">{change >= 0 ? 'Change / เงินทอน' : 'Still due'}</div>
            <div className="text-4xl font-bold tabular-nums">{money(Math.abs(change))}</div>
          </div>
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Button size="lg" variant="dark" onClick={() => setInput(total.toFixed(2))}>
              Exact
            </Button>
            {quick.map((q) => (
              <Button key={q} size="lg" variant="outline" onClick={() => setInput(String(q))}>
                {money(q).replace('.00', '')}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0'].map((k) => (
              <button key={k} onClick={() => key(k)} className="press h-12 rounded-xl bg-slate-100 text-xl font-semibold hover:bg-slate-200">
                {k}
              </button>
            ))}
            <button onClick={() => setInput((v) => v.slice(0, -1))} className="press flex h-12 items-center justify-center rounded-xl bg-slate-100">
              <Delete className="h-5 w-5" />
            </button>
          </div>
          <Button className="w-full" size="xl" variant="success" disabled={received < total} loading={busy} onClick={submit}>
            Confirm payment
          </Button>
        </div>
      </div>
    </Modal>
  );
}
