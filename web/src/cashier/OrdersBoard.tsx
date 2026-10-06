import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Search } from 'lucide-react';
import { staffApi } from '../lib/api';
import { money, time, elapsed } from '../lib/format';
import { Empty, ErrorBox, Input, Loading, StatusBadge, Tabs } from '../components/ui';
import { OrderDetail } from '../components/OrderDetail';
import { tt } from '../lib/legacy-i18n';

const TABS = [
  { id: 'WAITING_PAYMENT', label: 'Waiting Payment', tone: 'bg-amber-500 text-white' },
  { id: 'VERIFICATION', label: 'Slip Verification', tone: 'bg-orange-500 text-white' },
  { id: 'PAID', label: 'Paid', tone: 'bg-emerald-500 text-white' },
  { id: 'PREPARING', label: 'Preparing', tone: 'bg-indigo-500 text-white' },
  { id: 'READY', label: 'Ready', tone: 'bg-green-600 text-white' },
  { id: 'COMPLETED', label: 'Completed' },
  { id: 'CANCELLED', label: 'Cancelled' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export function OrdersBoard() {
  const [tab, setTab] = useState<Tab>('WAITING_PAYMENT');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['orders', tab, q],
    queryFn: () => staffApi<{ orders: any[]; tabCounts: Record<string, number> }>(`/orders?${q ? `q=${encodeURIComponent(q)}` : `tab=${tab}`}`),
    refetchInterval: 20000,
  });
  const orders = list.data?.orders ?? [];
  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Tabs tabs={TABS.map((t) => ({ ...t, count: list.data?.tabCounts?.[t.id] }))} value={tab} onChange={(v) => { setTab(v); setQ(''); }} className="flex-1" />
          <div className="relative w-64">
            <Search className="absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
            <Input className="pl-9" placeholder={tt('Search order #')} value={q} inputMode="numeric" onChange={(e) => setQ(e.target.value.replace(/\D/g, '').slice(0, 5))} />
          </div>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto rounded-2xl border bg-white">
          {list.isLoading ? (
            <Loading />
          ) : list.error ? (
            <div className="p-4"><ErrorBox error={list.error} onRetry={() => list.refetch()} /></div>
          ) : orders.length === 0 ? (
            <Empty title={q ? tt('No order matches') : tt('No orders in this tab')} />
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  {['Order #', 'Time', 'Kiosk', 'Type', 'Items', 'Amount', 'Payment', 'Status', 'Waiting'].map((h) => (
                    <th key={h} className="px-3 py-2.5 text-left font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {orders.map((o) => (
                  <tr key={o.id} onClick={() => setSelected(o.id)} className={clsx('cursor-pointer hover:bg-slate-50', selected === o.id && 'bg-primary/5')}>
                    <td className="px-3 py-3 text-lg font-black tracking-wider">#{o.order_number}</td>
                    <td className="px-3 py-3">{time(o.created_at)}</td>
                    <td className="px-3 py-3">{o.kiosk_code ?? o.source}</td>
                    <td className="px-3 py-3">{o.order_type === 'DINE_IN' ? tt('Dine in') : tt('Take away')}</td>
                    <td className="px-3 py-3">{o.item_count}</td>
                    <td className="px-3 py-3 font-semibold">{money(o.total)}</td>
                    <td className="px-3 py-3">{o.payment_method ?? '—'}</td>
                    <td className="px-3 py-3"><StatusBadge status={o.status} /></td>
                    <td className="px-3 py-3 text-slate-500 tabular-nums">{elapsed(o.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {selected && (
        <aside className="scroll-thin w-[560px] shrink-0 overflow-y-auto border-l bg-white p-5">
          <div className="mb-2 flex justify-end">
            <button className="text-sm text-slate-500 hover:text-slate-900" onClick={() => setSelected(null)}>{tt('Close ✕')}</button>
          </div>
          <OrderDetail id={selected} compact />
        </aside>
      )}
    </div>
  );
}
