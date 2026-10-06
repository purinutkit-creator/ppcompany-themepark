import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { staffApi, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { Badge, Button, Card, Empty, Field, Input, Loading, Modal, NumberInput, PageHeader, Select, StatusBadge, Table, Td, Tabs, toast } from '../components/ui';
import { tt } from '../lib/legacy-i18n';

export default function Stock() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'stock' | 'moves'>('stock');
  const list = useQuery({ queryKey: ['stock'], queryFn: () => staffApi<any[]>('/stock') });
  const moves = useQuery({ queryKey: ['stock-moves'], queryFn: () => staffApi<any[]>('/stock/movements?limit=200'), enabled: tab === 'moves' });
  const [adj, setAdj] = useState<any | null>(null);
  const tracked = (list.data ?? []).filter((r) => r.track_stock);
  return (
    <div>
      <PageHeader title={tt('Stock')} sub={tt('Current, reserved (unpaid orders) and available. Committed when payment is confirmed; kiosks show SOLD OUT in real time.')} />
      <Tabs className="mb-4 w-fit" tabs={[{ id: 'stock', label: 'Stock levels' }, { id: 'moves', label: 'Movements' }]} value={tab} onChange={setTab} />
      {tab === 'stock' ? (
        <Card>
          {list.isLoading ? <Loading /> : !tracked.length ? <Empty title={tt('No stock-tracked products')} sub={tt('Enable “Track stock” on a product.')} /> : (
            <Table head={['Product', 'SKU', 'Current', 'Reserved', 'Available', 'Minimum', 'Status', 'Updated', '']}>
              {tracked.map((r) => {
                const low = Number(r.available) <= Number(r.minimum);
                return (
                  <tr key={r.product_id}>
                    <Td className="font-medium">{r.name_th}<div className="text-xs text-slate-500">{r.name_en}</div></Td>
                    <Td className="font-mono text-xs">{r.sku}</Td>
                    <Td className="tabular-nums">{Number(r.current)}</Td>
                    <Td className="tabular-nums text-amber-700">{Number(r.reserved)}</Td>
                    <Td className="font-bold tabular-nums">{Number(r.available)}</Td>
                    <Td className="tabular-nums">{Number(r.minimum)}</Td>
                    <Td>{Number(r.available) <= 0 ? <Badge className="bg-rose-100 text-rose-700">SOLD OUT</Badge> : low ? <Badge className="bg-amber-100 text-amber-800">LOW</Badge> : <StatusBadge status={r.status} />}</Td>
                    <Td className="text-xs text-slate-500">{dateTime(r.updated_at)}</Td>
                    <Td>{can('stock.manage') && <Button size="sm" variant="outline" onClick={() => setAdj({ ...r, type: 'RESTOCK', qty: 0, minimum: Number(r.minimum), note: '' })}>{tt('Adjust')}</Button>}</Td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Card>
      ) : (
        <Card>
          {moves.isLoading ? <Loading /> : !moves.data?.length ? <Empty icon={<History className="h-6 w-6" />} title={tt('No movements')} /> : (
            <Table head={['Time', 'Product', 'Type', 'Qty', 'Current after', 'Reserved after', 'Order', 'By', 'Note']}>
              {moves.data.map((m) => (
                <tr key={m.id}>
                  <Td className="text-xs">{dateTime(m.created_at)}</Td>
                  <Td>{m.product_name}</Td>
                  <Td><Badge>{m.type}</Badge></Td>
                  <Td className="tabular-nums">{Number(m.qty)}</Td>
                  <Td className="tabular-nums">{m.current_after ?? '—'}</Td>
                  <Td className="tabular-nums">{m.reserved_after ?? '—'}</Td>
                  <Td>{m.order_number ? `#${m.order_number}` : '—'}</Td>
                  <Td>{m.user_name ?? 'system'}</Td>
                  <Td className="text-xs">{m.note}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
      {adj && (
        <Modal open onClose={() => setAdj(null)} title={`Adjust stock — ${adj.name_th}`} size="sm" footer={<><Button variant="ghost" onClick={() => setAdj(null)}>{tt('Cancel')}</Button><Button onClick={async () => {
          try {
            await staffApi(`/stock/${adj.product_id}/adjust`, { body: { type: adj.type, qty: adj.qty, minimum: adj.minimum, note: adj.note || undefined } });
            toast.success(tt('Stock updated'));
            setAdj(null);
            void list.refetch();
          } catch (e) { toast.error(errorMessage(e)); }
        }}>{tt('Save')}</Button></>}>
          <div className="space-y-3">
            <div className="text-sm text-slate-600">{tt('Current')} {Number(adj.current)} · {tt('reserved')} {Number(adj.reserved)}</div>
            <Field label={tt('Action')}>
              <Select value={adj.type} onChange={(e) => setAdj({ ...adj, type: e.target.value })}>
                <option value="RESTOCK">{tt('Restock (+)')}</option><option value="WASTE">{tt('Waste / spoilage (−)')}</option><option value="ADJUST">{tt('Set exact count')}</option>
              </Select>
            </Field>
            <Field label={adj.type === 'ADJUST' ? 'New current count' : 'Quantity'}><NumberInput value={adj.qty} onChange={(v) => setAdj({ ...adj, qty: v ?? 0 })} min={0} /></Field>
            <Field label={tt('Minimum (low-stock alert)')}><NumberInput value={adj.minimum} onChange={(v) => setAdj({ ...adj, minimum: v ?? 0 })} min={0} /></Field>
            <Field label={tt('Note')}><Input value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
