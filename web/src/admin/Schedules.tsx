import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Card, Empty, Field, Input, Loading, Modal, PageHeader, Table, Td, Toggle, confirmDialog } from '../components/ui';
import { useCrud, useList } from './hooks';
import { tt } from '../lib/legacy-i18n';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function Schedules() {
  const list = useList('schedules', '/menu/schedules');
  const crud = useCrud('schedules', '/menu/schedules');
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <div>
      <PageHeader title={tt('Menu schedules')} sub={tt('e.g. Breakfast 06:00–11:00 · Lunch 11:00–16:00 · Dinner 16:00–23:00. Assign to products or categories; outside the window they are disabled on the kiosk automatically.')} actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ name: '', start_time: '06:00', end_time: '11:00', days: [0, 1, 2, 3, 4, 5, 6], is_active: true })}>{tt('New schedule')}</Button>} />
      <Card>
        {list.isLoading ? <Loading /> : !list.data?.length ? <Empty /> : (
          <Table head={['Name', 'Time', 'Days', 'Status', '']}>
            {list.data.map((s: any) => (
              <tr key={s.id}>
                <Td className="font-medium">{s.name}</Td>
                <Td>{s.start_time} – {s.end_time}</Td>
                <Td>{s.days.length === 7 ? 'Every day' : s.days.map((d: number) => DAYS[d]).join(' ')}</Td>
                <Td>{s.is_active ? <Badge className="bg-emerald-100 text-emerald-800">{tt('Active')}</Badge> : <Badge>{tt('Inactive')}</Badge>}</Td>
                <Td className="text-right">
                  <Button size="sm" variant="outline" onClick={() => setEdit(s)}>{tt('Edit')}</Button>
                  <Button size="sm" variant="ghost" className="text-rose-600" onClick={async () => (await confirmDialog(tt('Delete schedule?'), 'Products using it become available all day.', true)) && crud.remove(s.id)}><Trash2 className="h-4 w-4" /></Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? tt('Edit schedule') : tt('New schedule')} size="sm" footer={<><Button variant="ghost" onClick={() => setEdit(null)}>{tt('Cancel')}</Button><Button disabled={!edit.name} onClick={async () => { try { await crud.save(edit.id, { name: edit.name, start_time: edit.start_time, end_time: edit.end_time, days: edit.days, is_active: edit.is_active }); setEdit(null); } catch { /* */ } }}>{tt('Save')}</Button></>}>
          <div className="space-y-3">
            <Field label={tt('Name')}><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={tt('Start')}><Input type="time" value={edit.start_time} onChange={(e) => setEdit({ ...edit, start_time: e.target.value })} /></Field>
              <Field label={tt('End')}><Input type="time" value={edit.end_time} onChange={(e) => setEdit({ ...edit, end_time: e.target.value })} /></Field>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((d, i) => (
                <button key={d} onClick={() => setEdit({ ...edit, days: edit.days.includes(i) ? edit.days.filter((x: number) => x !== i) : [...edit.days, i].sort() })} className={`rounded-full px-3 py-1 text-sm ${edit.days.includes(i) ? 'bg-primary text-white' : 'bg-slate-100'}`}>{d}</button>
              ))}
            </div>
            <Toggle checked={edit.is_active} onChange={(v) => setEdit({ ...edit, is_active: v })} label={tt('Active')} />
          </div>
        </Modal>
      )}
    </div>
  );
}
