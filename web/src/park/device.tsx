import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { Cpu } from 'lucide-react';
import { ApiError, errorMessage, staffApi, storage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { LangSwitcher, defineStrings, useSurfaceFont, useT, useUiLang } from '../lib/lang';
import { useRealtime } from '../lib/socket';
import { applyTheme } from '../lib/theme';
import { Button, Field, Input, Loading } from '../components/ui';

const D = defineStrings('device', {
  pairTitle: { th: 'ตั้งค่าอุปกรณ์', en: 'Device setup', zh: '设备设置' },
  pairSub: { th: 'วางโทเคนอุปกรณ์จาก แอดมิน → อุปกรณ์ หรือเข้าสู่ระบบพนักงาน', en: 'Paste the device token from Admin → Devices, or sign in as staff', zh: '粘贴 管理后台 → 设备 中的设备令牌，或以员工身份登录' },
  token: { th: 'โทเคนอุปกรณ์', en: 'Device token', zh: '设备令牌' },
  pair: { th: 'จับคู่อุปกรณ์', en: 'Pair device', zh: '配对设备' },
  staffLogin: { th: 'เข้าสู่ระบบพนักงานแทน', en: 'Use a staff sign-in instead', zh: '改用员工登录' },
  unpair: { th: 'ยกเลิกการจับคู่', en: 'Unpair', zh: '取消配对' },
});

export interface ParkDeviceCtx {
  /** Paired device assignment (gates / scan points / lockers) or null when running under a staff login. */
  assignment: any | null;
  settings: any;
  socket: Socket | null;
  connected: boolean;
  mode: 'device' | 'staff';
  unpair: () => void;
}
const Ctx = createContext<ParkDeviceCtx | null>(null);
export const useParkDevice = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('DeviceShell missing');
  return c;
};

async function fetchDeviceMe(token: string) {
  const res = await fetch('/api/park/device/me', { headers: { 'X-Device-Token': token } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, j?.error?.code ?? 'ERR', j?.error?.message ?? 'Pairing failed');
  return j;
}

/**
 * Gate display / ride scanner / locker station: runs as a paired device (device token, survives reboots)
 * or under a staff login with the right permission. Applies theme, per-language font and string overrides.
 */
export function DeviceShell({ children, surface, staffPerms }: { children: ReactNode; surface: string; staffPerms: string[] }) {
  const { user, token: staffToken, branchId } = useAuth();
  const [devToken, setDevToken] = useState<string | null>(new URLSearchParams(location.search).get('device') || storage.get('park_device_token'));
  const me = useQuery({ queryKey: ['park-device-me', devToken], queryFn: () => fetchDeviceMe(devToken!), enabled: !!devToken, retry: false, refetchInterval: 5 * 60_000 });
  const staffClient = useQuery({ queryKey: ['client-settings'], queryFn: () => staffApi<any>('/settings/client'), enabled: !devToken && !!user });
  const setOverrides = useUiLang((s) => s.setOverrides);
  useEffect(() => {
    if (devToken && me.data) storage.set('park_device_token', devToken);
  }, [devToken, me.data]);
  const settings = me.data?.settings ?? staffClient.data?.settings;
  const fonts = me.data?.fonts ?? staffClient.data?.fonts;
  useEffect(() => {
    if (!settings) return;
    applyTheme(settings.theme);
    setOverrides(me.data?.languages ?? staffClient.data?.languages ?? []);
  }, [settings, me.data, staffClient.data, setOverrides]);
  useSurfaceFont(settings?.fonts, fonts, surface);
  const mode: 'device' | 'staff' = devToken && me.data ? 'device' : 'staff';
  const { socket, connected } = useRealtime(mode === 'device' ? { deviceToken: devToken! } : user && staffToken ? { token: staffToken, branchId } : null);
  const unpair = () => {
    storage.set('park_device_token', null);
    setDevToken(null);
  };
  if (devToken && me.isLoading) return <Loading />;
  if (devToken && me.isError) return <Pairing error={errorMessage(me.error)} onPaired={setDevToken} onUnpair={unpair} />;
  if (!devToken) {
    if (!user) return <Pairing onPaired={setDevToken} onUnpair={unpair} />;
    if (staffPerms.length && !staffPerms.some((p) => user.permissions.includes(p))) return <Pairing error={`${user.role}: no permission`} onPaired={setDevToken} onUnpair={unpair} />;
    if (!staffClient.data) return <Loading />;
  }
  return (
    <Ctx.Provider value={{ assignment: mode === 'device' ? me.data : null, settings, socket, connected, mode, unpair }}>
      {children}
    </Ctx.Provider>
  );
}

function Pairing({ onPaired, error, onUnpair }: { onPaired: (t: string) => void; error?: string | null; onUnpair: () => void }) {
  const t = useT(D);
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(error ?? null);
  return (
    <div className="flex min-h-full items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-lg rounded-3xl bg-white p-8 shadow-xl">
        <div className="mb-4 flex justify-end"><LangSwitcher compact /></div>
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-2xl bg-primary/10 p-3 text-primary"><Cpu className="h-8 w-8" /></div>
          <div>
            <h1 className="text-2xl font-bold">{t('pairTitle')}</h1>
            <p className="text-sm text-slate-500">{t('pairSub')}</p>
          </div>
        </div>
        <Field label={t('token')}><Input value={v} onChange={(e) => setV(e.target.value)} className="font-mono" placeholder="xxxxxxxx-….secret" /></Field>
        {err && <div className="mt-3 rounded-xl bg-rose-50 px-4 py-2 text-sm text-rose-700">{err}</div>}
        <Button className="mt-5 w-full" size="lg" loading={busy} disabled={!v.trim()} onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await fetchDeviceMe(v.trim());
            onUnpair();
            onPaired(v.trim());
          } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
        }}>{t('pair')}</Button>
        <Link to={`/login?next=${encodeURIComponent(location.pathname)}`} className="mt-4 block text-center text-sm text-primary">{t('staffLogin')}</Link>
      </div>
    </div>
  );
}
