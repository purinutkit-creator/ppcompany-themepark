import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2, ExternalLink } from 'lucide-react';
import { tr } from '@kiosk/shared';
import { Badge, Button, Card, Empty, Field, I18nInput, Input, Loading, Modal, NumberInput, PageHeader, Toggle, confirmDialog } from '../components/ui';
import { useCrud, useList, useSettings, useSaveSetting } from './hooks';

export default function Kitchen() {
  const list = useList('stations', '/kitchen/stations');
  const crud = useCrud('stations', '/kitchen/stations');
  const settings = useSettings();
  const saveSetting = useSaveSetting();
  const [edit, setEdit] = useState<any | null>(null);
  const k = settings.data?.settings.kitchen;
  const [kv, setKv] = useState<any>(null);
  const kitchen = kv ?? k;
  return (
    <div>
      <PageHeader title="Kitchen" sub="Kitchen stations route items to their own KDS view and printer (Burger → Hot Kitchen, Drinks → Beverage…)" actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ code: '', name: {}, color: '#f97316', sort: 0, is_default: false, is_active: true })}>New station</Button>} />
      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <Card padded={false}>
          {list.isLoading ? <Loading /> : !list.data?.length ? <Empty /> : list.data.map((s: any) => (
            <div key={s.id} className="flex items-center gap-4 border-b px-5 py-3 last:border-0">
              <span className="h-8 w-8 rounded-lg" style={{ background: s.color }} />
              <div className="flex-1">
                <div className="font-medium">{tr(s.name, 'th')} <span className="text-sm text-slate-500">· {s.name?.en} · {s.code}</span></div>
                <div className="mt-0.5 flex gap-1">
                  {s.is_default && <Badge className="bg-amber-100 text-amber-800">Default</Badge>}
                  {!s.is_active && <Badge>Inactive</Badge>}
                  {(s.printers ?? []).map((p: any) => <Badge key={p.id}>🖨 {p.name}</Badge>)}
                </div>
              </div>
              <Link to={`/kds/${s.id}`} target="_blank" className="flex items-center gap-1 text-sm text-primary">Station KDS <ExternalLink className="h-3.5 w-3.5" /></Link>
              <Button size="sm" variant="outline" onClick={() => setEdit(s)}>Edit</Button>
              <Button size="sm" variant="ghost" className="text-rose-600" onClick={async () => (await confirmDialog('Delete station?', 'Only stations without order history can be deleted.', true)) && crud.remove(s.id)}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
        </Card>
        {kitchen && (
          <Card title="Kitchen printing & KDS">
            <div className="space-y-3">
              <Toggle checked={kitchen.printEnabled} onChange={(v) => setKv({ ...kitchen, printEnabled: v })} label="Print kitchen tickets" />
              <Field label="Ticket copies"><NumberInput value={kitchen.copies} onChange={(v) => setKv({ ...kitchen, copies: v ?? 1 })} min={0} max={10} /></Field>
              <Field label="Ticket language"><select className="w-full rounded-xl border px-3 py-2 text-sm" value={kitchen.ticketLanguage} onChange={(e) => setKv({ ...kitchen, ticketLanguage: e.target.value })}><option value="th">ไทย</option><option value="en">English</option><option value="zh">中文</option></select></Field>
              <Field label="KDS warning after (minutes)"><NumberInput value={kitchen.warnMinutes} onChange={(v) => setKv({ ...kitchen, warnMinutes: v ?? 8 })} /></Field>
              <Field label="KDS late after (minutes)"><NumberInput value={kitchen.lateMinutes} onChange={(v) => setKv({ ...kitchen, lateMinutes: v ?? 15 })} /></Field>
              <Button onClick={() => saveSetting.mutate({ key: 'kitchen', value: kitchen })} loading={saveSetting.isPending}>Save</Button>
            </div>
          </Card>
        )}
      </div>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? 'Edit station' : 'New station'} size="md" footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button disabled={!edit.code || !edit.name?.th} onClick={async () => { try { await crud.save(edit.id, { code: edit.code, name: edit.name, color: edit.color, sort: Number(edit.sort ?? 0), is_default: edit.is_default, is_active: edit.is_active }); setEdit(null); } catch { /* */ } }}>Save</Button></>}>
          <div className="space-y-4">
            <I18nInput label="Name" value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} required />
            <div className="grid grid-cols-3 gap-3">
              <Field label="Code"><Input value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} /></Field>
              <Field label="Color"><Input type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} className="h-10 p-1" /></Field>
              <Field label="Sort"><NumberInput value={edit.sort} onChange={(v) => setEdit({ ...edit, sort: v ?? 0 })} /></Field>
            </div>
            <div className="flex gap-5">
              <Toggle checked={edit.is_default} onChange={(v) => setEdit({ ...edit, is_default: v })} label="Default station" />
              <Toggle checked={edit.is_active} onChange={(v) => setEdit({ ...edit, is_active: v })} label="Active" />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
