import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { tr } from '@kiosk/shared';
import { staffApi, errorMessage } from '../lib/api';
import { Badge, Button, Card, Empty, Field, I18nInput, Input, Loading, MediaInput, Modal, PageHeader, Select, Toggle, confirmDialog, toast } from '../components/ui';
import { useCrud, useList } from './hooks';

export default function Categories() {
  const list = useList('categories', '/menu/categories');
  const crud = useCrud('categories', '/menu/categories');
  const [rows, setRows] = useState<any[]>([]);
  const [edit, setEdit] = useState<any | null>(null);
  useEffect(() => setRows(list.data ?? []), [list.data]);
  const move = async (i: number, d: number) => {
    const a = [...rows];
    const j = i + d;
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    setRows(a);
    try {
      await staffApi('/menu/categories/reorder', { body: { ids: a.map((x) => x.id) } });
      crud.invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <div>
      <PageHeader title="Categories" sub="Order here = order on the kiosk. Recommended / Promotion are automatic smart categories." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ kind: 'STANDARD', name: {}, is_active: true, sort: rows.length * 10 })}>New category</Button>} />
      <Card padded={false}>
        {list.isLoading ? <Loading /> : rows.length === 0 ? <Empty /> : rows.map((c, i) => (
          <div key={c.id} className="flex items-center gap-4 border-b px-5 py-3 last:border-0">
            <div className="flex flex-col">
              <button onClick={() => move(i, -1)} disabled={i === 0} className="disabled:opacity-20"><ArrowUp className="h-4 w-4" /></button>
              <button onClick={() => move(i, 1)} disabled={i === rows.length - 1} className="disabled:opacity-20"><ArrowDown className="h-4 w-4" /></button>
            </div>
            {c.image_url ? <img src={c.image_url} className="h-12 w-12 object-contain" alt="" /> : <div className="h-12 w-12 rounded-lg bg-slate-100" />}
            <div className="flex-1">
              <div className="font-medium">{tr(c.name, 'th')} <span className="text-sm text-slate-500">· {c.name?.en} · {c.name?.zh}</span></div>
              <div className="mt-0.5 flex gap-1">
                {c.kind !== 'STANDARD' && <Badge className="bg-violet-100 text-violet-800">{c.kind}</Badge>}
                {!c.is_active && <Badge className="bg-slate-200">Inactive</Badge>}
                {c.schedule_id && <Badge>Scheduled</Badge>}
                <Badge>{c.product_count} products</Badge>
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={() => setEdit(c)}>Edit</Button>
            <Button size="sm" variant="ghost" className="text-rose-600" onClick={async () => (await confirmDialog('Delete category?', 'Only empty categories can be deleted.', true)) && crud.remove(c.id)}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
      </Card>
      {edit && <CategoryEditor value={edit} onClose={() => setEdit(null)} save={crud.save} />}
    </div>
  );
}

function CategoryEditor({ value, onClose, save }: { value: any; onClose: () => void; save: (id: string | null, b: any) => Promise<unknown> }) {
  const [c, setC] = useState<any>(value);
  const stations = useList('stations', '/kitchen/stations');
  const printers = useList('printers', '/print/printers');
  const schedules = useList('schedules', '/menu/schedules');
  const set = (k: string, v: any) => setC((x: any) => ({ ...x, [k]: v }));
  const submit = async () => {
    try {
      await save(c.id ?? null, { kind: c.kind, name: c.name, image_url: c.image_url || null, icon: c.icon || null, sort: Number(c.sort ?? 0), station_id: c.station_id || null, printer_id: c.printer_id || null, schedule_id: c.schedule_id || null, is_active: !!c.is_active });
      onClose();
    } catch { /* toast */ }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={c.id ? 'Edit category' : 'New category'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={!c.name?.th}>Save</Button></>}>
      <div className="space-y-4">
        <I18nInput label="Name" value={c.name} onChange={(v) => set('name', v)} required />
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Type">
            <Select value={c.kind} onChange={(e) => set('kind', e.target.value)}>
              <option value="STANDARD">Standard</option><option value="RECOMMENDED">Recommended (auto)</option><option value="PROMOTION">Promotion (auto)</option>
            </Select>
          </Field>
          <Field label="Icon key" hint="burger, chicken, rice, noodles, drink, dessert…"><Input value={c.icon ?? ''} onChange={(e) => set('icon', e.target.value)} /></Field>
          <div className="flex items-end pb-2"><Toggle checked={!!c.is_active} onChange={(v) => set('is_active', v)} label="Available on kiosk" /></div>
          <Field label="Kitchen station">
            <Select value={c.station_id ?? ''} onChange={(e) => set('station_id', e.target.value)}>
              <option value="">Default station</option>
              {stations.data?.map((s: any) => <option key={s.id} value={s.id}>{tr(s.name, 'th')}</option>)}
            </Select>
          </Field>
          <Field label="Printer override">
            <Select value={c.printer_id ?? ''} onChange={(e) => set('printer_id', e.target.value)}>
              <option value="">(station routing)</option>
              {printers.data?.filter((p: any) => p.type !== 'RECEIPT').map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Availability schedule">
            <Select value={c.schedule_id ?? ''} onChange={(e) => set('schedule_id', e.target.value)}>
              <option value="">All day</option>
              {schedules.data?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        </div>
        <MediaInput label="Image / icon" value={c.image_url} onChange={(v) => set('image_url', v)} />
      </div>
    </Modal>
  );
}
