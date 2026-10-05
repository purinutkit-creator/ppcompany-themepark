import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { EVENTS } from '@kiosk/shared';
import { staffApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useRealtime, useSocketEvent } from '../lib/socket';
import { applyFont, applyTheme } from '../lib/theme';
import { useBrowserPrintExecutor } from '../printing/executor';
import { Loading, Empty, Button } from './ui';

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
export function StaffShell({ children, perms, surface }: { children: ReactNode; perms: string[]; surface: 'admin' | 'cashier' | 'kds' }) {
  const { user, loading, token, branchId, logout } = useAuth();
  const loc = useLocation();
  const qc = useQueryClient();
  const client = useQuery({ queryKey: ['client-settings'], queryFn: () => staffApi<any>('/settings/client'), enabled: !!user });
  const { socket, connected } = useRealtime(user && token ? { token, branchId } : null);
  const printer = useBrowserPrintExecutor(socket, !!user && surface !== 'kds');

  useEffect(() => {
    if (!client.data) return;
    applyTheme(client.data.settings.theme);
    applyFont(client.data.settings.fonts?.[surface], client.data.fonts);
  }, [client.data, surface]);
  useSocketEvent(socket, EVENTS.SETTINGS_UPDATED, () => void qc.invalidateQueries({ queryKey: ['client-settings'] }));

  if (loading) return <Loading />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (perms.length && !perms.some((p) => user.permissions.includes(p))) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty title="No permission" sub={`Your role (${user.role}) cannot open this screen.`} action={<Button onClick={() => logout()}>Sign in as another user</Button>} />
      </div>
    );
  }
  if (!branchId) return <Empty title="No branch selected" />;
  return <Ctx.Provider value={{ socket, connected, client: client.data, printer }}>{children}</Ctx.Provider>;
}
