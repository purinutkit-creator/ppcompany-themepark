import { useState } from 'react';
import QRCode from 'qrcode';
import { KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { staffApi, errorMessage } from '../lib/api';
import { dateTime } from '../lib/format';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Loading, Modal, NumberInput, PageHeader, Select, StatusBadge, Table, Td, Toggle, confirmDialog, toast } from '../components/ui';
import { useCrud, useList } from './hooks';

const blank = { code: '', name: '', default_language: 'th', receipt_printer_id: '', idle_timeout: 60, payment_methods: ['QR', 'CASH', 'CARD'], order_types: ['DINE_IN', 'TAKE_AWAY'], theme: {}, is_active: true };

export default function Kiosks() {
  const list = useList('kiosks', '/devices/kiosks', { refetchInterval: 20000 });
  const crud = useCrud('kiosks', '/devices/kiosks');
  const [edit, setEdit] = useState<any | null>(null);
  const [token, setToken] = useState<{ code: string; token: string; qr?: string } | null>(null);
  const showToken = async (code: string, t: string) => {
    const url = `${location.origin}/kiosk?token=${encodeURIComponent(t)}`;
    setToken({ code, token: t, qr: await QRCode.toDataURL(url, { width: 220, margin: 1 }) });
  };
  return (
    <div>
      <PageHeader title="Kiosks" sub="KIOSK-01, KIOSK-02 … each with its own branch, language, printer, theme, idle timeout and payment methods" actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ ...blank, code: `KIOSK-${String((list.data?.length ?? 0) + 1).padStart(2, '0')}` })}>New kiosk</Button>} />
      <Card>
        {list.isLoading ? <Loading /> : !list.data?.length ? <Empty /> : (
          <Table head={['Kiosk', 'Status', 'Last seen', 'Version', 'Language', 'Idle', 'Payments', 'Receipt printer', 'Orders today', '']}>
            {list.data.map((k: any) => (
              <tr key={k.id}>
                <Td><div className="font-bold">{k.code}</div><div className="text-xs text-slate-500">{k.name}{!k.is_active && ' · disabled'}</div></Td>
                <Td><StatusBadge status={k.status} /></Td>
                <Td className="text-xs">{dateTime(k.last_seen_at)}<div className="text-slate-400">{k.ip}</div></Td>
                <Td>{k.app_version ?? '—'}</Td>
                <Td>{k.default_language.toUpperCase()}</Td>
                <Td>{k.idle_timeout}s</Td>
                <Td>{k.payment_methods.map((m: string) => <Badge key={m} className="mr-0.5">{m}</Badge>)}</Td>
                <Td>{k.receipt_printer_name ?? 'Default'}</Td>
                <Td>{k.orders_today}</Td>
                <Td className="text-right whitespace-nowrap">
                  <Button size="sm" variant="outline" onClick={() => setEdit({ ...k, receipt_printer_id: k.receipt_printer_id ?? '' })}>Edit</Button>
                  <Button size="sm" variant="ghost" title="New pairing token" onClick={async () => { if (!(await confirmDialog('Issue a new token?', 'The current kiosk device will be logged out and must be paired again.'))) return; try { const r = await staffApi<any>(`/devices/kiosks/${k.id}/token`, { method: 'POST' }); await showToken(k.code, r.token); } catch (e) { toast.error(errorMessage(e)); } }}><KeyRound className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" title="Reload kiosk" onClick={() => staffApi(`/devices/kiosks/${k.id}/reload`, { method: 'POST' }).then(() => toast.success('Reload sent'))}><RefreshCw className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" className="text-rose-600" onClick={async () => (await confirmDialog('Delete kiosk?', undefined, true)) && crud.remove(k.id)}><Trash2 className="h-4 w-4" /></Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {edit && <KioskEditor value={edit} onClose={() => setEdit(null)} onSaved={async (r: any) => { setEdit(null); if (r?.token) await showToken(edit.code, r.token); }} save={crud.save} />}
      <Modal open={!!token} onClose={() => setToken(null)} title={`Pair ${token?.code}`} size="md">
        <p className="text-sm text-slate-600">Open <b>/kiosk</b> on the kiosk device and paste this token, or scan the QR code with the device. The token is shown only once.</p>
        {token?.qr && <img src={token.qr} alt="pairing QR" className="mx-auto my-4" />}
        <Input readOnly value={token?.token ?? ''} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
      </Modal>
    </div>
  );
}

function KioskEditor({ value, onClose, onSaved, save }: { value: any; onClose: () => void; onSaved: (r: unknown) => void; save: (id: string | null, b: any) => Promise<unknown> }) {
  const [k, setK] = useState<any>(value);
  const printers = useList('printers', '/print/printers');
  const set = (key: string, v: any) => setK((x: any) => ({ ...x, [key]: v }));
  const toggleIn = (key: string, v: string) => set(key, k[key].includes(v) ? k[key].filter((x: string) => x !== v) : [...k[key], v]);
  const submit = async () => {
    try {
      const r = await save(k.id ?? null, { code: k.code, name: k.name, default_language: k.default_language, receipt_printer_id: k.receipt_printer_id || null, theme: k.theme ?? {}, idle_timeout: Number(k.idle_timeout), payment_methods: k.payment_methods, order_types: k.order_types, is_active: k.is_active });
      onSaved(r);
    } catch { /* toast */ }
  };
  return (
    <Modal open onClose={onClose} title={k.id ? `Edit ${k.code}` : 'New kiosk'} size="md" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={!k.code || !k.name || !k.order_types.length}>Save</Button></>}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Code"><Input value={k.code} onChange={(e) => set('code', e.target.value.toUpperCase())} /></Field>
        <Field label="Name"><Input value={k.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Default language"><Select value={k.default_language} onChange={(e) => set('default_language', e.target.value)}><option value="th">ไทย</option><option value="en">English</option><option value="zh">中文</option></Select></Field>
        <Field label="Idle timeout"><Select value={k.idle_timeout} onChange={(e) => set('idle_timeout', Number(e.target.value))}>{[30, 60, 90, 120, 180, 300].map((s) => <option key={s} value={s}>{s} seconds</option>)}</Select></Field>
        <Field label="Receipt printer" className="md:col-span-2">
          <Select value={k.receipt_printer_id} onChange={(e) => set('receipt_printer_id', e.target.value)}>
            <option value="">Branch default receipt printer</option>
            {printers.data?.filter((p: any) => p.type === 'RECEIPT').map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Payment methods"><div className="flex flex-wrap gap-3">{['QR', 'CASH', 'CARD', 'OTHER'].map((m) => <Checkbox key={m} checked={k.payment_methods.includes(m)} onChange={() => toggleIn('payment_methods', m)} label={m} />)}</div></Field>
        <Field label="Order types"><div className="flex gap-3">{['DINE_IN', 'TAKE_AWAY'].map((m) => <Checkbox key={m} checked={k.order_types.includes(m)} onChange={() => toggleIn('order_types', m)} label={m.replace('_', ' ')} />)}</div></Field>
        <Field label="Theme override — primary color" hint="Leave empty to use the global theme">
          <Input type="color" value={k.theme?.primary ?? '#E4572E'} onChange={(e) => set('theme', { ...k.theme, primary: e.target.value, buttonColor: e.target.value })} className="h-10 p-1" />
        </Field>
        <div className="flex items-end gap-3 pb-2">
          <Toggle checked={k.is_active} onChange={(v) => set('is_active', v)} label="Active" />
          {k.theme?.primary && <Button size="sm" variant="ghost" onClick={() => set('theme', {})}>Reset theme</Button>}
        </div>
      </div>
      {!k.id && <p className="mt-3 text-xs text-slate-500">A pairing token is generated after saving.</p>}
    </Modal>
  );
}
