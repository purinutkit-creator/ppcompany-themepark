import { useEffect, useState } from 'react';
import { RefreshCw, Usb, Bluetooth, Unplug } from 'lucide-react';
import { tr } from '@kiosk/shared';
import { outbox, type OutboxOrder } from '../lib/offline';
import { deviceId, APP_VERSION } from '../lib/device';
import { Badge, Button, Field, Input, Modal, StatusBadge } from '../components/ui';
import { WebBluetoothTransport, WebUsbTransport } from '../printing/transports';
import type { Bootstrap } from './useKioskData';

/**
 * Hidden maintenance panel (5 taps on the bottom-right corner of the welcome screen).
 * Protected by a manager PIN check before anything can be changed.
 */
export function KioskMaintenance({ boot, printer, connected, onClose, onUnpair, onSync }: { boot: Bootstrap; printer: any; connected: boolean; onClose: () => void; onUnpair: () => void; onSync: () => Promise<void> }) {
  const [authed, setAuthed] = useState(false);
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [items, setItems] = useState<OutboxOrder[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = async () => setItems(await outbox.list());
  useEffect(() => {
    void load();
  }, []);

  const auth = async () => {
    setErr(null);
    try {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeCode: code.toUpperCase(), pin }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message ?? 'Login failed');
      if ((j.user?.roleLevel ?? 0) < 70 && !j.user?.permissions?.includes('kiosks.manage')) throw new Error('Manager or kiosk-admin permission required');
      setAuthed(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Kiosk maintenance — ${boot.kiosk.code}`} size="lg">
      {!authed ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Enter a manager employee code and PIN.</p>
          <Field label="Employee code">
            <Input value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          </Field>
          <Field label="PIN">
            <Input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && auth()} />
          </Field>
          {err && <div className="text-sm text-rose-600">{err}</div>}
          <Button onClick={auth}>Unlock</Button>
        </div>
      ) : (
        <div className="space-y-5 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <Info k="Kiosk" v={`${boot.kiosk.code} — ${boot.kiosk.name}`} />
            <Info k="Branch" v={`${boot.branch.code} — ${tr(boot.branch.name, 'en')}`} />
            <Info k="Realtime" v={connected ? 'Connected' : 'Disconnected'} />
            <Info k="App version" v={APP_VERSION} />
            <Info k="Device ID" v={deviceId()} />
            <Info k="Idle timeout" v={`${boot.kiosk.idleTimeout}s`} />
          </div>
          <div>
            <div className="mb-2 font-semibold">Printers attached to this device</div>
            {printer.printers.length === 0 && <div className="text-slate-500">No printers are bound to this device. In Admin → Printers set “Host device ID” to {deviceId()}.</div>}
            {printer.printers.map((p: any) => (
              <div key={p.id} className="mb-2 flex items-center justify-between rounded-xl border p-3">
                <div>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-slate-500">
                    {p.connection} · {p.executor} · {p.device_id ?? '—'}
                  </div>
                  {p.lastError && <div className="text-xs text-rose-600">{p.lastError}</div>}
                </div>
                <StatusBadge status={p.live ?? 'UNKNOWN'} />
              </div>
            ))}
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="outline" icon={<Usb className="h-4 w-4" />} onClick={async () => { try { const d = await WebUsbTransport.request(); setMsg(`USB permission granted: ${WebUsbTransport.key(d)}`); void printer.reload(); } catch (e) { setMsg((e as Error).message); } }}>
                Grant USB printer
              </Button>
              <Button size="sm" variant="outline" icon={<Bluetooth className="h-4 w-4" />} onClick={async () => { try { const d = await WebBluetoothTransport.request(); setMsg(`Bluetooth device: ${d.name} (${d.id})`); } catch (e) { setMsg((e as Error).message); } }}>
                Grant Bluetooth printer
              </Button>
              <Button size="sm" variant="outline" icon={<RefreshCw className="h-4 w-4" />} onClick={() => printer.processNow()}>
                Process print queue
              </Button>
            </div>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between font-semibold">
              Offline order queue
              <Button size="sm" variant="outline" icon={<RefreshCw className="h-4 w-4" />} onClick={async () => { await onSync(); await load(); }}>
                Sync now
              </Button>
            </div>
            {items.length === 0 && <div className="text-slate-500">No offline orders.</div>}
            {items.map((o) => (
              <div key={o.clientOrderId} className="mb-1 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                <span className="font-mono">{o.offlineRef}</span>
                <span className="text-xs text-slate-500">{new Date(o.createdAt).toLocaleString()}</span>
                <span>{o.orderNumber ? `#${o.orderNumber}` : ''}</span>
                <Badge className={o.status === 'SYNCED' ? 'bg-emerald-100 text-emerald-700' : o.status === 'FAILED' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-800'}>{o.status}</Badge>
              </div>
            ))}
          </div>
          {msg && <div className="rounded-lg bg-slate-100 px-3 py-2">{msg}</div>}
          <div className="flex gap-2 border-t pt-4">
            <Button variant="outline" icon={<RefreshCw className="h-4 w-4" />} onClick={() => location.reload()}>
              Reload app
            </Button>
            <Button variant="danger" icon={<Unplug className="h-4 w-4" />} onClick={onUnpair}>
              Unpair kiosk
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2">
      <div className="text-xs text-slate-500">{k}</div>
      <div className="font-medium break-all">{v}</div>
    </div>
  );
}
