import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { staffApi } from '../lib/api';
import { dateTime } from '../lib/format';
import { Badge, Button, Card, Empty, Field, Input, Loading, Modal, PageHeader, Select, Table, Td } from '../components/ui';

export default function Audit() {
  const [action, setAction] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<any>(null);
  const actions = useQuery({ queryKey: ['audit-actions'], queryFn: () => staffApi<string[]>('/settings/audit/actions') });
  const p = new URLSearchParams({ limit: '100', offset: String(offset) });
  if (action) p.set('action', action);
  if (q) p.set('q', q);
  if (from) p.set('from', new Date(`${from}T00:00:00`).toISOString());
  if (to) p.set('to', new Date(new Date(`${to}T00:00:00`).getTime() + 86400000).toISOString());
  const list = useQuery({ queryKey: ['audit', p.toString()], queryFn: () => staffApi<any[]>(`/settings/audit?${p}`) });
  return (
    <div>
      <PageHeader title="Audit logs" sub="Every sensitive action: who, what, old → new value, when, from which device" />
      <Card>
        <div className="mb-4 grid gap-3 md:grid-cols-4">
          <Field label="Action">
            <Select value={action} onChange={(e) => { setAction(e.target.value); setOffset(0); }}>
              <option value="">All</option>
              {actions.data?.map((a) => <option key={a}>{a}</option>)}
            </Select>
          </Field>
          <Field label="Search (user / entity / order #)"><Input value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} /></Field>
          <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        {list.isLoading ? <Loading /> : !list.data?.length ? <Empty title="No log entries" /> : (
          <Table head={['Date / time', 'User', 'Role', 'Action', 'Entity', 'Order', 'Approved by', 'IP / device', '']}>
            {list.data.map((a) => (
              <tr key={a.id}>
                <Td className="whitespace-nowrap">{dateTime(a.created_at)}</Td>
                <Td>{a.user_name}</Td>
                <Td><Badge>{a.role}</Badge></Td>
                <Td className="font-medium">{a.action}</Td>
                <Td className="max-w-40 truncate text-xs">{a.entity} {a.entity_id}</Td>
                <Td>{a.order_number ? <Link to={`/admin/orders/${a.order_id}`} className="text-primary">#{a.order_number}</Link> : '—'}</Td>
                <Td>{a.approved_by_name ?? '—'}</Td>
                <Td className="max-w-48 truncate text-xs text-slate-500" >{a.ip} {a.device}</Td>
                <Td><Button size="sm" variant="ghost" onClick={() => setView(a)}>View</Button></Td>
              </tr>
            ))}
          </Table>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - 100))}>Previous</Button>
          <Button size="sm" variant="outline" disabled={(list.data?.length ?? 0) < 100} onClick={() => setOffset((o) => o + 100)}>Next</Button>
        </div>
      </Card>
      <Modal open={!!view} onClose={() => setView(null)} title={view?.action} size="lg">
        {view && (
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-1 text-sm font-semibold">Old value</div>
              <pre className="max-h-96 overflow-auto rounded-xl bg-slate-50 p-3 text-xs">{JSON.stringify(view.old_value, null, 2) ?? '—'}</pre>
            </div>
            <div>
              <div className="mb-1 text-sm font-semibold">New value</div>
              <pre className="max-h-96 overflow-auto rounded-xl bg-slate-50 p-3 text-xs">{JSON.stringify(view.new_value, null, 2) ?? '—'}</pre>
            </div>
            <div className="text-xs text-slate-500 md:col-span-2">{view.ip} · {view.device}</div>
          </div>
        )}
      </Modal>
    </div>
  );
}
