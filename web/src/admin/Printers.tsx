import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bluetooth, Eye, KeyRound, Plus, Printer as PrinterIcon, RefreshCw, Search, Star, Trash2, Usb, Wifi, Zap, ZapOff, MonitorSmartphone } from 'lucide-react';
import { tr } from '@kiosk/shared';
import { staffApi, errorMessage } from '../lib/api';
import { deviceId } from '../lib/device';
import { dateTime } from '../lib/format';
import { Badge, Button, Card, Empty, Field, Input, Loading, Modal, NumberInput, PageHeader, Select, StatusBadge, Table, Tabs, Td, Toggle, confirmDialog, promptDialog, toast } from '../components/ui';
import { WebBluetoothTransport, WebSerialTransport, WebUsbTransport } from '../printing/transports';
import { useStaffRt } from '../components/StaffShell';
import { useCrud, useList, useSettings } from './hooks';
import { PrintPreview } from './PrintPreview';
import { sampleJob } from './samples';

const blank = { name: '', type: 'KITCHEN', connection: 'LAN', executor: 'AGENT', host: '', port: 9100, device_path: '', device_id: '', agent_id: '', host_device_id: '', station_id: '', paper_width: 80, dots_per_line: null, chars_per_line: null, raster_mode: 'AUTO', cut: true, open_drawer: false, is_default: false, auto_reconnect: true, is_enabled: true };

export default function Printers() {
  const [tab, setTab] = useState<'printers' | 'queue' | 'agents'>('printers');
  return (
    <div>
      <PageHeader title="Printers" sub="Receipt / kitchen / beverage / dessert printers · USB · Bluetooth · BLE · LAN · Wi-Fi · ESC/POS 58 & 80 mm" />
      <Tabs className="mb-4 w-fit" tabs={[{ id: 'printers', label: 'Printers' }, { id: 'queue', label: 'Print queue' }, { id: 'agents', label: 'Print agents' }]} value={tab} onChange={setTab} />
      {tab === 'printers' && <PrinterList />}
      {tab === 'queue' && <PrintQueue />}
      {tab === 'agents' && <Agents />}
    </div>
  );
}

function PrinterList() {
  const list = useList('printers', '/print/printers');
  const crud = useCrud('printers', '/print/printers');
  const { printer: local } = useStaffRt();
  const settings = useSettings();
  const [edit, setEdit] = useState<any | null>(null);
  const [preview, setPreview] = useState<any | null>(null);
  const [search, setSearch] = useState(false);
  const patch = async (p: any, body: any, msg: string) => {
    try {
      await staffApi(`/print/printers/${p.id}`, { method: 'PATCH', body });
      toast.success(msg);
      crud.invalidate();
      void local.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const test = async (p: any) => {
    try {
      await staffApi(`/print/printers/${p.id}/test`, { method: 'POST' });
      toast.success('Test print queued', p.executor === 'AGENT' ? 'Sent to the print agent' : 'Sent to the bound device');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <>
      <div className="mb-4 flex gap-2">
        <Button icon={<Search className="h-4 w-4" />} variant="outline" onClick={() => setSearch(true)}>Search printers</Button>
        <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ ...blank })}>Add printer</Button>
      </div>
      {list.isLoading ? <Loading /> : !list.data?.length ? <Empty title="No printers yet" /> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.data.map((p: any) => {
            const isLocal = p.executor !== 'AGENT' && p.host_device_id === deviceId();
            return (
              <Card key={p.id} title={<span className="flex items-center gap-2"><PrinterIcon className="h-4 w-4" /> {p.name} {p.is_default && <Star className="h-4 w-4 fill-amber-400 text-amber-400" />}</span>} actions={<StatusBadge status={p.is_enabled ? p.status : 'OFFLINE'} />}>
                <div className="mb-3 flex flex-wrap gap-1">
                  <Badge className="bg-slate-800 text-white">{p.type}</Badge>
                  <Badge>{p.connection}</Badge>
                  <Badge>{p.executor}</Badge>
                  <Badge>{p.paper_width}mm</Badge>
                  <Badge>{p.raster_mode}</Badge>
                  {p.station_name && <Badge className="bg-orange-100 text-orange-800">{tr(p.station_name, 'th')}</Badge>}
                  {isLocal && <Badge className="bg-sky-100 text-sky-800">This device</Badge>}
                </div>
                <div className="space-y-0.5 text-xs text-slate-600">
                  {p.host && <div>Address: {p.host}:{p.port}</div>}
                  {p.device_path && <div>Device: {p.device_path}</div>}
                  {p.device_id && <div>Device ID: {p.device_id}</div>}
                  {p.agent_name && <div>Agent: {p.agent_name} ({p.agent_status})</div>}
                  {p.host_device_id && <div>Host device: {p.host_device_id}</div>}
                  <div>Pending {p.pending_jobs} · failed (24h) {p.failed_jobs} · last seen {dateTime(p.last_seen_at)}</div>
                  {p.last_error && <div className="text-rose-600">{p.last_error}</div>}
                </div>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  <Button size="sm" onClick={() => test(p)}>Test print</Button>
                  <Button size="sm" variant="outline" icon={<Eye className="h-3.5 w-3.5" />} onClick={() => setPreview(p)}>Preview</Button>
                  {p.is_enabled ? (
                    <Button size="sm" variant="outline" icon={<ZapOff className="h-3.5 w-3.5" />} onClick={() => patch(p, { is_enabled: false }, 'Disconnected')}>Disconnect</Button>
                  ) : (
                    <Button size="sm" variant="outline" icon={<Zap className="h-3.5 w-3.5" />} onClick={() => patch(p, { is_enabled: true }, 'Connected')}>Connect</Button>
                  )}
                  {!p.is_default && <Button size="sm" variant="outline" onClick={() => patch(p, { is_default: true }, 'Default printer set')}>Set default</Button>}
                  <Button size="sm" variant="outline" onClick={async () => { const n = await promptDialog('Rename printer', p.name); if (n) await patch(p, { name: n }, 'Renamed'); }}>Rename</Button>
                  {p.executor !== 'AGENT' && !isLocal && <Button size="sm" variant="outline" icon={<MonitorSmartphone className="h-3.5 w-3.5" />} onClick={() => patch(p, { host_device_id: deviceId() }, 'Bound to this device')}>Use this device</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setEdit(p)}>Edit</Button>
                  <Button size="sm" variant="ghost" className="text-rose-600" onClick={async () => (await confirmDialog('Delete printer?', 'Routing falls back to the default printer.', true)) && crud.remove(p.id)}><Trash2 className="h-4 w-4" /></Button>
                </div>
                <div className="mt-3"><Toggle checked={p.auto_reconnect} onChange={(v) => patch(p, { auto_reconnect: v }, v ? 'Auto reconnect on' : 'Auto reconnect off')} label="Auto reconnect" /></div>
              </Card>
            );
          })}
        </div>
      )}
      {edit && <PrinterEditor value={edit} onClose={() => setEdit(null)} save={async (id, b) => { const r = await crud.save(id, b); void local.reload(); return r; }} />}
      {search && <PrinterSearch onClose={() => setSearch(false)} onPick={(p) => { setSearch(false); setEdit({ ...blank, ...p }); }} />}
      {preview && (
        <Modal open onClose={() => setPreview(null)} title={`Preview — ${preview.name}`} size="lg">
          <div className="flex flex-wrap justify-center gap-6">
            <div><div className="mb-2 text-center text-sm font-semibold">Receipt</div><PrintPreview payload={sampleJob('RECEIPT', settings.data?.settings.store, settings.data?.settings.fonts.receipt, settings.data?.settings.receipt.footer)} paperWidth={preview.paper_width} /></div>
            <div><div className="mb-2 text-center text-sm font-semibold">Kitchen ticket</div><PrintPreview payload={sampleJob('KITCHEN_TICKET', settings.data?.settings.store, settings.data?.settings.fonts.kitchenTicket)} paperWidth={preview.paper_width} /></div>
          </div>
        </Modal>
      )}
    </>
  );
}

function PrinterSearch({ onClose, onPick }: { onClose: () => void; onPick: (p: any) => void }) {
  const agents = useList('agents', '/print/agents');
  const [agentId, setAgentId] = useState('');
  const [subnet, setSubnet] = useState('');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<any[]>([]);
  const scan = async () => {
    setBusy(true);
    try {
      const r = await staffApi<any>(`/print/agents/${agentId}/scan`, { body: { kind: 'all', subnet: subnet || undefined }, timeoutMs: 40000 });
      setFound(r.printers ?? []);
      if (!r.printers?.length) toast.info('No printers found on the agent network / ports');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const local = async (kind: 'usb' | 'ble' | 'serial') => {
    try {
      if (kind === 'usb') {
        const d = await WebUsbTransport.request();
        onPick({ name: d.productName || 'USB printer', connection: 'USB', executor: 'BROWSER', device_id: WebUsbTransport.key(d), host_device_id: deviceId() });
      } else if (kind === 'ble') {
        const d = await WebBluetoothTransport.request();
        onPick({ name: d.name || 'Bluetooth printer', connection: 'BLE', executor: 'BROWSER', device_id: d.id, host_device_id: deviceId() });
      } else {
        const port = await WebSerialTransport.request();
        onPick({ name: 'Serial / Bluetooth SPP printer', connection: 'BLUETOOTH', executor: 'BROWSER', device_id: WebSerialTransport.key(port), host_device_id: deviceId() });
      }
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Modal open onClose={onClose} title="Search printers" size="lg">
      <div className="space-y-5">
        <div>
          <div className="mb-2 font-semibold">Printers attached to this device (browser)</div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" icon={<Usb className="h-4 w-4" />} onClick={() => local('usb')}>USB (WebUSB)</Button>
            <Button variant="outline" icon={<Bluetooth className="h-4 w-4" />} onClick={() => local('ble')}>Bluetooth BLE</Button>
            <Button variant="outline" icon={<Bluetooth className="h-4 w-4" />} onClick={() => local('serial')}>Bluetooth SPP / Serial</Button>
          </div>
          <p className="mt-1 text-xs text-slate-500">Chrome / Edge on desktop & Android. For Android kiosk apps or desktop shells choose executor ANDROID / DESKTOP in the printer form.</p>
        </div>
        <div className="border-t pt-4">
          <div className="mb-2 font-semibold">Network, USB & serial printers via a Print Agent</div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Agent" className="w-64">
              <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                <option value="">Select agent…</option>
                {agents.data?.map((a: any) => <option key={a.id} value={a.id}>{a.name} ({a.status})</option>)}
              </Select>
            </Field>
            <Field label="Subnet (optional)" className="w-48"><Input value={subnet} onChange={(e) => setSubnet(e.target.value)} placeholder="192.168.1" /></Field>
            <Button icon={<Wifi className="h-4 w-4" />} loading={busy} disabled={!agentId} onClick={scan}>Scan</Button>
          </div>
          {found.length > 0 && (
            <Table className="mt-3" head={['Printer', 'Connection', 'Address', '']}>
              {found.map((f, i) => (
                <tr key={i}>
                  <Td>{f.name}</Td>
                  <Td>{f.connection}</Td>
                  <Td className="font-mono text-xs">{f.host ? `${f.host}:${f.port}` : f.devicePath}</Td>
                  <Td><Button size="sm" onClick={() => onPick({ name: f.name, connection: f.connection, executor: 'AGENT', host: f.host ?? '', port: f.port ?? 9100, device_path: f.devicePath ?? '', agent_id: agentId })}>Add</Button></Td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      </div>
    </Modal>
  );
}

function PrinterEditor({ value, onClose, save }: { value: any; onClose: () => void; save: (id: string | null, b: any) => Promise<unknown> }) {
  const [p, setP] = useState<any>({ ...blank, ...value });
  const agents = useList('agents', '/print/agents');
  const stations = useList('stations', '/kitchen/stations');
  const set = (k: string, v: any) => setP((x: any) => ({ ...x, [k]: v }));
  const submit = async () => {
    const n = (v: any) => (v === '' || v == null ? null : Number(v));
    const s = (v: any) => (v === '' ? null : v ?? null);
    try {
      await save(p.id ?? null, {
        name: p.name, type: p.type, connection: p.connection, executor: p.executor, driver: 'ESCPOS', host: s(p.host), port: n(p.port), device_path: s(p.device_path), device_id: s(p.device_id),
        agent_id: s(p.agent_id), host_device_id: s(p.host_device_id), station_id: s(p.station_id), paper_width: Number(p.paper_width), dots_per_line: n(p.dots_per_line), chars_per_line: n(p.chars_per_line),
        raster_mode: p.raster_mode, cut: p.cut, open_drawer: p.open_drawer, is_default: p.is_default, auto_reconnect: p.auto_reconnect, is_enabled: p.is_enabled,
      });
      onClose();
    } catch { /* toast */ }
  };
  const net = ['LAN', 'ETHERNET', 'WIFI'].includes(p.connection);
  return (
    <Modal open onClose={onClose} size="lg" title={p.id ? `Edit printer — ${p.name}` : 'Add printer'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={!p.name}>Save</Button></>}>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Name" className="md:col-span-2"><Input value={p.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Printer type">
          <Select value={p.type} onChange={(e) => set('type', e.target.value)}>
            <option value="RECEIPT">Receipt</option><option value="KITCHEN">Kitchen</option><option value="BEVERAGE">Beverage</option><option value="DESSERT">Dessert</option><option value="OTHER">Other</option>
          </Select>
        </Field>
        <Field label="Connection">
          <Select value={p.connection} onChange={(e) => set('connection', e.target.value)}>
            <option value="LAN">LAN</option><option value="ETHERNET">Ethernet</option><option value="WIFI">Wi-Fi / Network</option><option value="USB">USB</option><option value="BLUETOOTH">Bluetooth (classic / SPP)</option><option value="BLE">Bluetooth BLE</option>
          </Select>
        </Field>
        <Field label="Driven by" hint="Agent = local print service; Browser = WebUSB/BLE/Serial on a device">
          <Select value={p.executor} onChange={(e) => set('executor', e.target.value)}>
            <option value="AGENT">Print Agent / Desktop bridge service</option><option value="BROWSER">Browser on a device</option><option value="ANDROID">Android native bridge</option><option value="DESKTOP">Desktop app bridge</option>
          </Select>
        </Field>
        <Field label="Kitchen station (routing)">
          <Select value={p.station_id ?? ''} onChange={(e) => set('station_id', e.target.value)}>
            <option value="">—</option>
            {stations.data?.map((s: any) => <option key={s.id} value={s.id}>{tr(s.name, 'th')}</option>)}
          </Select>
        </Field>
        {p.executor === 'AGENT' ? (
          <>
            <Field label="Agent"><Select value={p.agent_id ?? ''} onChange={(e) => set('agent_id', e.target.value)}><option value="">Any agent of branch</option>{agents.data?.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
            {net ? (
              <>
                <Field label="IP / host"><Input value={p.host ?? ''} onChange={(e) => set('host', e.target.value)} placeholder="192.168.1.100" /></Field>
                <Field label="Port"><NumberInput value={p.port} onChange={(v) => set('port', v)} /></Field>
              </>
            ) : (
              <Field label="Device path" className="md:col-span-2" hint="/dev/usb/lp0 · /dev/rfcomm0 · COM3 · \\\\localhost\\PrinterShare"><Input value={p.device_path ?? ''} onChange={(e) => set('device_path', e.target.value)} /></Field>
            )}
          </>
        ) : (
          <>
            <Field label="Device ID (USB vid:pid / BLE id)"><Input value={p.device_id ?? ''} onChange={(e) => set('device_id', e.target.value)} /></Field>
            <Field label="Host device ID" hint={`This device: ${deviceId()}`}><Input value={p.host_device_id ?? ''} onChange={(e) => set('host_device_id', e.target.value)} /></Field>
          </>
        )}
        <Field label="Paper width"><Select value={p.paper_width} onChange={(e) => set('paper_width', Number(e.target.value))}><option value={80}>80 mm</option><option value={58}>58 mm</option></Select></Field>
        <Field label="Text rendering" hint="AUTO rasterises Thai / Chinese as bitmap">
          <Select value={p.raster_mode} onChange={(e) => set('raster_mode', e.target.value)}><option value="AUTO">Auto</option><option value="RASTER">Always bitmap</option><option value="TEXT">Printer font (ASCII)</option></Select>
        </Field>
        <Field label="Dots per line (optional)"><NumberInput value={p.dots_per_line} onChange={(v) => set('dots_per_line', v)} placeholder={p.paper_width === 58 ? '384' : '576'} /></Field>
        <Field label="Chars per line (text mode)"><NumberInput value={p.chars_per_line} onChange={(v) => set('chars_per_line', v)} placeholder={p.paper_width === 58 ? '32' : '48'} /></Field>
        <div className="space-y-2 md:col-span-3">
          <div className="flex flex-wrap gap-5">
            <Toggle checked={p.cut} onChange={(v) => set('cut', v)} label="Auto cut" />
            <Toggle checked={p.open_drawer} onChange={(v) => set('open_drawer', v)} label="Open cash drawer (receipts)" />
            <Toggle checked={p.is_default} onChange={(v) => set('is_default', v)} label="Default for type" />
            <Toggle checked={p.auto_reconnect} onChange={(v) => set('auto_reconnect', v)} label="Auto reconnect" />
            <Toggle checked={p.is_enabled} onChange={(v) => set('is_enabled', v)} label="Enabled" />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function PrintQueue() {
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['print-jobs', status], queryFn: () => staffApi<any[]>(`/print/jobs?limit=200${status ? `&status=${status}` : ''}`), refetchInterval: 10000 });
  const act = async (id: string, a: 'retry' | 'cancel') => {
    try {
      await staffApi(`/print/jobs/${id}/${a}`, { method: 'POST' });
      toast.success(a === 'retry' ? 'Retry queued' : 'Cancelled');
      void q.refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Card>
      <div className="mb-3 flex items-center gap-3">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-56">
          <option value="">All statuses</option>
          {['QUEUED', 'PRINTING', 'PRINTED', 'FAILED', 'RETRYING', 'CANCELLED'].map((s) => <option key={s}>{s}</option>)}
        </Select>
        <Button variant="ghost" icon={<RefreshCw className="h-4 w-4" />} onClick={() => q.refetch()}>Refresh</Button>
      </div>
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty title="Print queue is empty" /> : (
        <Table head={['Job ID', 'Created', 'Order', 'Document', 'Printer', 'Attempts', 'Status', 'Error', '']}>
          {q.data.map((j) => (
            <tr key={j.id}>
              <Td className="font-mono text-xs">{j.id.slice(0, 8)}</Td>
              <Td className="text-xs">{dateTime(j.created_at)}</Td>
              <Td>{j.order_number ? `#${j.order_number}` : '—'}</Td>
              <Td>{j.document_type}{j.copy_no > 1 && ` (copy ${j.copy_no})`}{j.is_reprint && <Badge className="ml-1 bg-amber-100 text-amber-800">reprint</Badge>}</Td>
              <Td>{j.printer_name ?? '—'}</Td>
              <Td>{j.attempts}/{j.max_attempts}</Td>
              <Td><StatusBadge status={j.status} /></Td>
              <Td className="max-w-64 truncate text-xs text-rose-600">{j.last_error}</Td>
              <Td className="whitespace-nowrap">
                {['FAILED', 'RETRYING', 'CANCELLED'].includes(j.status) && <Button size="sm" variant="outline" onClick={() => act(j.id, 'retry')}>Retry</Button>}
                {['QUEUED', 'RETRYING', 'FAILED'].includes(j.status) && <Button size="sm" variant="ghost" onClick={() => act(j.id, 'cancel')}>Cancel</Button>}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function Agents() {
  const list = useList('agents', '/print/agents');
  const [token, setToken] = useState<{ name: string; token: string } | null>(null);
  const create = async () => {
    const name = await promptDialog('New print agent', 'e.g. Counter PC');
    if (!name) return;
    try {
      const r = await staffApi<any>('/print/agents', { body: { name } });
      setToken({ name, token: r.token });
      void list.refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Card title="Print agents" actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={create}>New agent</Button>}>
      <p className="mb-3 text-sm text-slate-500">The Print Agent is a small local service (Windows / macOS / Linux / Raspberry Pi) that drives LAN, USB and serial/Bluetooth printers and renders Thai/Chinese as bitmaps. See <code>print-agent/README.md</code>.</p>
      {list.isLoading ? <Loading /> : !list.data?.length ? <Empty title="No agents" /> : (
        <Table head={['Name', 'Status', 'Host', 'Version', 'Last seen', '']}>
          {list.data.map((a: any) => (
            <tr key={a.id}>
              <Td className="font-medium">{a.name}</Td>
              <Td><StatusBadge status={a.status} /></Td>
              <Td>{a.hostname ?? '—'}</Td>
              <Td>{a.version ?? '—'}</Td>
              <Td>{dateTime(a.last_seen_at)}</Td>
              <Td className="text-right whitespace-nowrap">
                <Button size="sm" variant="outline" icon={<KeyRound className="h-3.5 w-3.5" />} onClick={async () => { if (!(await confirmDialog('Rotate token?', 'The running agent must be updated with the new token.'))) return; const r = await staffApi<any>(`/print/agents/${a.id}/rotate`, { method: 'POST' }); setToken({ name: a.name, token: r.token }); }}>New token</Button>
                <Button size="sm" variant="ghost" className="text-rose-600" onClick={async () => { if (await confirmDialog('Delete agent?', undefined, true)) { await staffApi(`/print/agents/${a.id}`, { method: 'DELETE' }); void list.refetch(); } }}><Trash2 className="h-4 w-4" /></Button>
              </Td>
            </tr>
          ))}
        </Table>
      )}
      <Modal open={!!token} onClose={() => setToken(null)} title={`Agent token — ${token?.name}`} size="md">
        <p className="mb-2 text-sm text-slate-600">Copy it now — it is shown only once. Start the agent with:</p>
        <pre className="overflow-x-auto rounded-xl bg-slate-900 p-4 text-xs text-emerald-300">{`SERVER_URL=${location.origin} AGENT_TOKEN=${token?.token} npm start --workspace print-agent`}</pre>
        <Input readOnly value={token?.token ?? ''} className="mt-3 font-mono text-xs" onFocus={(e) => e.target.select()} />
      </Modal>
    </Card>
  );
}
