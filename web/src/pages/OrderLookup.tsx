import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { tr } from '@kiosk/shared';
import { publicApi } from '../lib/api';
import { money, dateTime } from '../lib/format';
import { ErrorBox, Loading, StatusBadge } from '../components/ui';

/** Customer order lookup (QR code on the receipt). */
export default function OrderLookup() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['lookup', id], queryFn: () => publicApi<any>(`/orders/${id}`), refetchInterval: 10000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <div className="p-6"><ErrorBox error={q.error} /></div>;
  const o = q.data;
  return (
    <div className="min-h-full bg-[#FFF8F0] p-6">
      <div className="mx-auto max-w-md rounded-3xl bg-white p-6 shadow-xl">
        <div className="text-sm text-slate-500">{tr(o.branch_name, 'th')}</div>
        <div className="mt-2 text-6xl font-black tracking-wider text-primary">#{o.order_number}</div>
        <div className="mt-3 flex gap-2">
          <StatusBadge status={o.status} />
          <StatusBadge status={o.payment_status} />
        </div>
        <div className="mt-5 divide-y">
          {(o.items ?? []).map((i: any, k: number) => (
            <div key={k} className="flex justify-between py-2">
              <span>
                {i.qty} × {tr(i.name, 'th')}
              </span>
              <span>{money(i.total)}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-between text-lg font-bold">
          <span>Total</span>
          <span>{money(o.total)}</span>
        </div>
        <div className="mt-4 text-xs text-slate-500">Ordered {dateTime(o.created_at)}{o.ready_at ? ` · Ready ${dateTime(o.ready_at)}` : ''}</div>
      </div>
    </div>
  );
}
