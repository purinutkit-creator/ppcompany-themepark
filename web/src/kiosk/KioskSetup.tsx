import { useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { ApiError, errorMessage, storage } from '../lib/api';
import { deviceId } from '../lib/device';
import { Button, Field, Input } from '../components/ui';

/** First-run pairing: paste the kiosk token generated in Admin → Kiosks (or open ?token=…). */
export function KioskSetup({ onPaired, initialError }: { onPaired: (token: string) => void; initialError?: string | null }) {
  const fromUrl = new URLSearchParams(location.search).get('token') ?? '';
  const [token, setToken] = useState(fromUrl);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(initialError ?? null);

  const pair = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/kiosk/pair', { method: 'POST', headers: { 'X-Kiosk-Token': token.trim(), 'X-Device-Id': deviceId() } });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new ApiError(res.status, j?.error?.code ?? 'ERR', j?.error?.message ?? 'Pairing failed');
      }
      storage.set('kiosk_token', token.trim());
      history.replaceState(null, '', '/kiosk');
      onPaired(token.trim());
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-lg rounded-3xl bg-white p-8 shadow-xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-2xl bg-primary/10 p-3 text-primary">
            <MonitorSmartphone className="h-8 w-8" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Kiosk setup</h1>
            <p className="text-sm text-slate-500">ตั้งค่าเครื่อง Kiosk — Pair this screen with a kiosk created in Admin → Kiosks</p>
          </div>
        </div>
        <Field label="Kiosk token" hint="Shown once when the kiosk is created or when you click “New token”.">
          <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="xxxxxxxx-xxxx-….secret" className="font-mono" />
        </Field>
        {err && <div className="mt-3 rounded-xl bg-rose-50 px-4 py-2 text-sm text-rose-700">{err}</div>}
        <Button className="mt-6 w-full" size="lg" loading={busy} disabled={!token.trim()} onClick={pair}>
          Pair this device
        </Button>
        <div className="mt-4 text-center text-xs text-slate-400">Device ID: {deviceId()}</div>
      </div>
    </div>
  );
}
