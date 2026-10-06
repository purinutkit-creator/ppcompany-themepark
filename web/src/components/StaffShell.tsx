import { createContext, Fragment, useContext, useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { EVENTS } from '@kiosk/shared';
import { staffApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useRealtime, useSocketEvent } from '../lib/socket';
import { applyTheme } from '../lib/theme';
import { useSurfaceFont, useT, useUiLang } from '../lib/lang';
import { useBrowserPrintExecutor } from '../printing/executor';
import { Loading, Empty, Button } from './ui';

export type StaffSurface = 'admin' | 'cashier' | 'kds' | 'counter' | 'pos' | 'gate' | 'ride';
interface StaffRt {
  socket: Socket | null;
  connected: boolean;
  client: any;
  printer: ReturnType<typeof useBrowserPrintExecutor>;
}
const Ctx = createContext<StaffRt | null>(null);
export const useStaffRt = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('StaffShell missing');
  return c;
};

/** Auth gate + theme/font for a staff surface + realtime socket + device print executor. */
export function StaffShell({ children, perms, surface }: { children: ReactNode; perms: string[]; surface: StaffSurface }) {
  const { user, loading, token, branchId, logout } = useAuth();
  const loc = useLocation();
  const qc = useQueryClient();
  const client = useQuery({ queryKey: ['client-settings'], queryFn: () => staffApi<any>('/settings/client'), enabled: !!user });
  const { socket, connected } = useRealtime(user && token ? { token, branchId } : null);
  const printer = useBrowserPrintExecutor(socket, !!user && surface !== 'kds');

  const setOverrides = useUiLang((s) => s.setOverrides);
  const lang = useUiLang((s) => s.lang);
  const t = useT();
  useEffect(() => {
    if (!client.data) return;
    applyTheme(client.data.settings.theme);
    setOverrides(client.data.languages ?? []);
  }, [client.data, setOverrides]);
  useSurfaceFont(client.data?.settings.fonts, client.data?.fonts, surface);
  useSocketEvent(socket, EVENTS.SETTINGS_UPDATED, () => void qc.invalidateQueries({ queryKey: ['client-settings'] }));

  if (loading) return <Loading />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (perms.length && !perms.some((p) => user.permissions.includes(p))) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty title={t.x({ th: 'ไม่มีสิทธิ์ใช้งาน', en: 'No permission', zh: '没有权限' })} sub={`${user.role}`} action={<Button onClick={() => logout()}>{t.x({ th: 'เข้าสู่ระบบด้วยผู้ใช้อื่น', en: 'Sign in as another user', zh: '使用其他用户登录' })}</Button>} />
      </div>
    );
  }
  if (!branchId) return <Empty title={t.x({ th: 'ยังไม่ได้เลือกสาขา', en: 'No branch selected', zh: '未选择分店' })} />;
  // Re-mount on a language switch so screens that translate with plain `tt()` calls pick up the new language.
  return <Ctx.Provider value={{ socket, connected, client: client.data, printer }}><Fragment key={lang}>{children}</Fragment></Ctx.Provider>;
}
