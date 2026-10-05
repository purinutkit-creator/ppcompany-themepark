import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Banknote, CreditCard, QrCode, Receipt, ShoppingCart, TrendingUp, Users, AlertTriangle } from 'lucide-react';
import { tr } from '@kiosk/shared';
import { staffApi } from '../lib/api';
import { money, dateTime } from '../lib/format';
import { Card, Empty, ErrorBox, Loading, PageHeader, Stat, StatusBadge } from '../components/ui';
import { SimpleBars } from './charts';

export default function Dashboard() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => staffApi<any>('/reports/dashboard'), refetchInterval: 30000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const s = d.summary;
  const st = Object.fromEntries(d.statuses.map((x: any) => [x.status, x.n]));
  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: `${String(h).padStart(2, '0')}`, sales: Number(d.hourly.find((x: any) => x.hour === h)?.sales ?? 0) })).filter((x, i, arr) => i >= 6 || x.sales > 0 || arr.slice(0, 6).some((y) => y.sales > 0));
  const waiting = (st.CREATED ?? 0) + (st.WAITING_PAYMENT ?? 0) + (st.WAITING_CASH_PAYMENT ?? 0) + (st.WAITING_CARD ?? 0) + (st.WAITING_VERIFICATION ?? 0);
  return (
    <div>
      <PageHeader title="Dashboard" sub={`Today · ${d.timezone} · live`} />
      {d.pendingVerifications > 0 && (
        <Link to="/cashier/verify" className="mb-4 flex items-center gap-2 rounded-xl border border-orange-300 bg-orange-50 px-4 py-3 text-sm font-medium text-orange-800">
          <AlertTriangle className="h-4 w-4" /> {d.pendingVerifications} payment(s) waiting for verification — open Slip Verification Center →
        </Link>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Sales today" value={money(s.sales)} icon={<TrendingUp className="h-5 w-5" />} tone="green" sub={Number(s.refunded) ? `Refunded ${money(s.refunded)}` : undefined} />
        <Stat label="Orders" value={s.orders} icon={<Receipt className="h-5 w-5" />} tone="blue" />
        <Stat label="Average order value" value={money(s.aov)} icon={<ShoppingCart className="h-5 w-5" />} tone="violet" />
        <Stat label="Customers" value={s.customers} icon={<Users className="h-5 w-5" />} tone="amber" />
        <Stat label="Cash" value={money(s.cash)} icon={<Banknote className="h-5 w-5" />} />
        <Stat label="Transfer / QR" value={money(s.transfer)} icon={<QrCode className="h-5 w-5" />} />
        <Stat label="Card" value={money(s.card)} icon={<CreditCard className="h-5 w-5" />} />
        <Stat label="Order status" value={<span className="text-base">Waiting {waiting} · Preparing {(st.NEW ?? 0) + (st.PREPARING ?? 0) + (st.PAID ?? 0) + (st.CONFIRMED ?? 0)} · Ready {st.READY ?? 0} · Done {st.COMPLETED ?? 0}</span>} />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card title="Hourly sales" className="xl:col-span-2">
          {d.hourly.length ? <SimpleBars data={hourly} x="hour" y="sales" /> : <Empty title="No sales yet today" />}
        </Card>
        <Card title="Best sellers">
          {d.bestSellers.length === 0 ? <Empty title="No sales yet" /> : (
            <ol className="space-y-2">
              {d.bestSellers.map((b: any, i: number) => (
                <li key={i} className="flex items-center gap-3">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-xs font-bold">{i + 1}</span>
                  <span className="flex-1 truncate text-sm">{tr(b.name_i18n, 'th')}</span>
                  <span className="text-sm font-semibold">{b.qty}</span>
                  <span className="w-24 text-right text-xs text-slate-500">{money(b.sales)}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card title="Category sales">
          {d.categories.length ? <SimpleBars data={d.categories.map((c: any) => ({ ...c, sales: Number(c.sales) }))} x="name" y="sales" horizontal height={Math.max(160, d.categories.length * 34)} /> : <Empty title="No sales yet" />}
        </Card>
        <Card title="Kiosk status" actions={<Link className="text-sm text-primary" to="/admin/kiosks">Manage</Link>}>
          {d.kiosks.length === 0 ? <Empty title="No kiosks" /> : d.kiosks.map((k: any) => (
            <div key={k.id} className="flex items-center justify-between border-b py-2 text-sm last:border-0">
              <div>
                <div className="font-medium">{k.code}</div>
                <div className="text-xs text-slate-500">Last seen {dateTime(k.last_seen_at)} · v{k.app_version ?? '—'}</div>
              </div>
              <StatusBadge status={k.status} />
            </div>
          ))}
        </Card>
        <Card title="Printer status" actions={<Link className="text-sm text-primary" to="/admin/printers">Manage</Link>}>
          {d.agents.map((a: any) => (
            <div key={a.id} className="flex items-center justify-between border-b py-2 text-sm">
              <div>
                <div className="font-medium">🖥 {a.name}</div>
                <div className="text-xs text-slate-500">Print agent · {dateTime(a.last_seen_at)}</div>
              </div>
              <StatusBadge status={a.status} />
            </div>
          ))}
          {d.printers.map((p: any) => (
            <div key={p.id} className="flex items-center justify-between border-b py-2 text-sm last:border-0">
              <div>
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-slate-500">{p.type} · {p.connection}{p.last_error ? ` · ${p.last_error}` : ''}</div>
              </div>
              <StatusBadge status={p.is_enabled ? p.status : 'OFFLINE'} />
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
