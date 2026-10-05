import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { staffApi } from '../lib/api';
import { dateOnly, dateTime, money } from '../lib/format';
import { Card, Empty, Field, Input, Loading, Select, StatusBadge, Table, Td, Stat } from '../components/ui';

export function PaymentHistory() {
  const [from, setFrom] = useState(dateOnly(new Date()));
  const [to, setTo] = useState(dateOnly(new Date()));
  const [method, setMethod] = useState('');
  const [status, setStatus] = useState('PAID');
  const fromIso = new Date(`${from}T00:00:00`).toISOString();
  const toIso = new Date(new Date(`${to}T00:00:00`).getTime() + 86400000).toISOString();
  const q = useQuery({
    queryKey: ['payment-history', from, to, method, status],
    queryFn: () => staffApi<any[]>(`/payments/history?from=${fromIso}&to=${toIso}${method ? `&method=${method}` : ''}${status ? `&status=${status}` : ''}`),
  });
  const rows = q.data ?? [];
  const sum = (m?: string) => rows.filter((r) => r.status === 'PAID' && (!m || r.method === m)).reduce((s, r) => s + Number(r.amount), 0);
  return (
    <div className="scroll-thin h-full overflow-y-auto p-5">
      <div className="mb-4 grid gap-3 md:grid-cols-4">
        <Stat label="Total collected" value={money(sum())} tone="green" />
        <Stat label="Cash" value={money(sum('CASH'))} />
        <Stat label="QR / Transfer" value={money(sum('QR'))} />
        <Stat label="Card" value={money(sum('CARD'))} />
      </div>
      <Card>
        <div className="mb-4 grid gap-3 md:grid-cols-4">
          <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="">All</option><option value="CASH">Cash</option><option value="QR">QR / Transfer</option><option value="CARD">Card</option><option value="OTHER">Other</option>
            </Select>
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option><option value="PAID">Paid</option><option value="REJECTED">Rejected</option><option value="CANCELLED">Cancelled</option><option value="DECLINED">Declined</option>
            </Select>
          </Field>
        </div>
        {q.isLoading ? <Loading /> : rows.length === 0 ? <Empty title="No payments" /> : (
          <Table head={['Time', 'Order', 'Kiosk', 'Method', 'Amount', 'Received', 'Change', 'Reference', 'By', 'Status']}>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>{dateTime(r.paid_at ?? r.created_at)}</Td>
                <Td className="font-bold">#{r.order_number}</Td>
                <Td>{r.kiosk_code ?? '—'}</Td>
                <Td>{r.method} <span className="text-xs text-slate-400">{r.provider}</span></Td>
                <Td className="font-semibold">{money(r.amount)}</Td>
                <Td>{r.received_amount != null ? money(r.received_amount) : '—'}</Td>
                <Td>{r.change_amount != null ? money(r.change_amount) : '—'}</Td>
                <Td>{r.card_last4 ? `${r.card_brand ?? ''} ****${r.card_last4}` : r.reference ?? r.approval_code ?? '—'}</Td>
                <Td>{r.confirmed_by_name ?? '—'}</Td>
                <Td><StatusBadge status={r.status} /></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
