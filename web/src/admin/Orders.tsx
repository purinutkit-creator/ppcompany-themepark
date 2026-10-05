import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { staffApi } from '../lib/api';
import { dateOnly, dateTime, money } from '../lib/format';
import { Button, Card, Empty, Field, Input, Loading, PageHeader, Select, StatusBadge, Table, Td } from '../components/ui';
import { OrderDetail } from '../components/OrderDetail';
import { useList } from './hooks';

const STATUSES = ['CREATED', 'WAITING_PAYMENT', 'WAITING_CASH_PAYMENT', 'WAITING_CARD', 'WAITING_VERIFICATION', 'PAID', 'CONFIRMED', 'NEW', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED', 'REFUNDED'];

export default function Orders() {
  const { id } = useParams();
  const nav = useNavigate();
  if (id)
    return (
      <div>
        <Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => nav('/admin/orders')} className="mb-3">
          Back to orders
        </Button>
        <Card>
          <OrderDetail id={id} />
        </Card>
      </div>
    );
  return <OrderList />;
}

function OrderList() {
  const [from, setFrom] = useState(dateOnly(new Date()));
  const [to, setTo] = useState(dateOnly(new Date()));
  const [status, setStatus] = useState('');
  const [method, setMethod] = useState('');
  const [kioskId, setKioskId] = useState('');
  const [q, setQ] = useState('');
  const kiosks = useList('kiosks', '/devices/kiosks');
  const params = new URLSearchParams();
  params.set('from', new Date(`${from}T00:00:00`).toISOString());
  params.set('to', new Date(new Date(`${to}T00:00:00`).getTime() + 86400000).toISOString());
  if (status) params.set('status', status);
  if (method) params.set('method', method);
  if (kioskId) params.set('kioskId', kioskId);
  if (q) params.set('q', q);
  params.set('limit', '500');
  const list = useQuery({ queryKey: ['orders', 'admin', params.toString()], queryFn: () => staffApi<any>(`/orders?${params}`) });
  const rows = list.data?.orders ?? [];
  return (
    <div>
      <PageHeader title="Orders" sub="All orders with filters — click an order for its full timeline" />
      <Card>
        <div className="mb-4 grid gap-3 md:grid-cols-6">
          <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {STATUSES.map((s) => <option key={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label="Payment">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="">All</option><option>QR</option><option>CASH</option><option>CARD</option><option>OTHER</option>
            </Select>
          </Field>
          <Field label="Kiosk">
            <Select value={kioskId} onChange={(e) => setKioskId(e.target.value)}>
              <option value="">All</option>
              {kiosks.data?.map((k: any) => <option key={k.id} value={k.id}>{k.code}</option>)}
            </Select>
          </Field>
          <Field label="Order #"><Input value={q} onChange={(e) => setQ(e.target.value.replace(/\D/g, '').slice(0, 5))} placeholder="48271" /></Field>
        </div>
        {list.isLoading ? <Loading /> : rows.length === 0 ? <Empty title="No orders" /> : (
          <Table head={['Order #', 'Created', 'Kiosk', 'Type', 'Items', 'Total', 'Payment', 'Status', 'Payment status']}>
            {rows.map((o: any) => (
              <tr key={o.id} className="hover:bg-slate-50">
                <Td><Link to={`/admin/orders/${o.id}`} className="font-bold text-primary">#{o.order_number}</Link></Td>
                <Td>{dateTime(o.created_at)}</Td>
                <Td>{o.kiosk_code ?? o.source}</Td>
                <Td>{o.order_type === 'DINE_IN' ? 'Dine in' : 'Take away'}</Td>
                <Td>{o.item_count}</Td>
                <Td className="font-semibold">{money(o.total)}</Td>
                <Td>{o.payment_method ?? '—'}</Td>
                <Td><StatusBadge status={o.status} /></Td>
                <Td><StatusBadge status={o.payment_status} /></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
