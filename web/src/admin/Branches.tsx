import { useState } from 'react';
import { Plus } from 'lucide-react';
import { tr } from '@kiosk/shared';
import { Badge, Button, Card, Empty, Field, I18nInput, Input, Loading, Modal, PageHeader, Table, Td, Toggle } from '../components/ui';
import { useCrud, useList } from './hooks';

export default function Branches() {
  const list = useList('branches', '/devices/branches');
  const crud = useCrud('branches', '/devices/branches');
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <div>
      <PageHeader title="Branches" sub="Multi-branch ready: kiosks, stations, printers, stock and staff are scoped per branch" actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ code: '', name: {}, address: '', phone: '', tax_id: '', timezone: 'Asia/Bangkok', is_active: true })}>New branch</Button>} />
      <Card>
        {list.isLoading ? <Loading /> : !list.data?.length ? <Empty /> : (
          <Table head={['Code', 'Name', 'Address', 'Phone', 'Tax ID', 'Time zone', 'Status', '']}>
            {list.data.map((b: any) => (
              <tr key={b.id}>
                <Td className="font-bold">{b.code}</Td>
                <Td>{tr(b.name, 'th')}<div className="text-xs text-slate-500">{b.name?.en}</div></Td>
                <Td className="max-w-64 text-xs">{b.address}</Td>
                <Td>{b.phone}</Td>
                <Td>{b.tax_id}</Td>
                <Td>{b.timezone}</Td>
                <Td>{b.is_active ? <Badge className="bg-emerald-100 text-emerald-800">Active</Badge> : <Badge>Inactive</Badge>}</Td>
                <Td><Button size="sm" variant="outline" onClick={() => setEdit(b)}>Edit</Button></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? 'Edit branch' : 'New branch'} size="lg" footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button disabled={!edit.code || !edit.name?.th} onClick={async () => { try { await crud.save(edit.id, { code: edit.code, name: edit.name, address: edit.address, phone: edit.phone, tax_id: edit.tax_id, timezone: edit.timezone, is_active: edit.is_active }); setEdit(null); } catch { /* */ } }}>Save</Button></>}>
          <div className="space-y-4">
            <I18nInput label="Name" value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} required />
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Code"><Input value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} /></Field>
              <Field label="Phone"><Input value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
              <Field label="Tax ID"><Input value={edit.tax_id ?? ''} onChange={(e) => setEdit({ ...edit, tax_id: e.target.value })} /></Field>
              <Field label="Address" className="md:col-span-2"><Input value={edit.address ?? ''} onChange={(e) => setEdit({ ...edit, address: e.target.value })} /></Field>
              <Field label="Time zone"><Input value={edit.timezone} onChange={(e) => setEdit({ ...edit, timezone: e.target.value })} /></Field>
            </div>
            <Toggle checked={edit.is_active} onChange={(v) => setEdit({ ...edit, is_active: v })} label="Active" />
            {!edit.id && <p className="text-xs text-slate-500">A default “Main Kitchen” station is created automatically.</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}
