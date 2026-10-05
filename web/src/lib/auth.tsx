import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { staffApi, storage } from './api';

export interface StaffUser {
  id: string;
  name: string;
  employeeCode: string;
  role: string;
  roleLevel: number;
  branchId: string | null;
  permissions: string[];
}
export interface Branch {
  id: string;
  code: string;
  name: Record<string, string>;
  timezone: string;
}
interface AuthCtx {
  user: StaffUser | null;
  branches: Branch[];
  branchId: string | null;
  branch: Branch | null;
  loading: boolean;
  token: string | null;
  login: (body: Record<string, string>) => Promise<void>;
  logout: () => Promise<void>;
  setBranch: (id: string) => void;
  can: (perm: string) => boolean;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<StaffUser | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState<string | null>(storage.get('staff_branch'));
  const [token, setToken] = useState<string | null>(storage.get('staff_token'));
  const [loading, setLoading] = useState(!!storage.get('staff_token'));

  const loadMe = useCallback(async () => {
    try {
      const me = await staffApi<{ user: StaffUser; branches: Branch[] }>('/auth/me');
      setUser(me.user);
      setBranches(me.branches);
      const b = me.user.branchId ?? (me.branches.find((x) => x.id === storage.get('staff_branch'))?.id ?? me.branches[0]?.id ?? null);
      storage.set('staff_branch', b);
      setBranchId(b);
    } catch {
      storage.set('staff_token', null);
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token) void loadMe();
    const h = () => {
      storage.set('staff_token', null);
      setToken(null);
      setUser(null);
    };
    window.addEventListener('staff-unauthorized', h);
    return () => window.removeEventListener('staff-unauthorized', h);
  }, [token, loadMe]);

  const login = useCallback(async (body: Record<string, string>) => {
    const r = await staffApi<{ token: string; user: StaffUser }>('/auth/login', { body });
    storage.set('staff_token', r.token);
    setLoading(true);
    setToken(r.token);
  }, []);

  const logout = useCallback(async () => {
    await staffApi('/auth/logout', { method: 'POST' }).catch(() => {});
    storage.set('staff_token', null);
    setToken(null);
    setUser(null);
  }, []);

  const setBranch = useCallback((id: string) => {
    storage.set('staff_branch', id);
    setBranchId(id);
    window.location.reload();
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({
      user,
      branches,
      branchId,
      branch: branches.find((b) => b.id === branchId) ?? null,
      loading,
      token,
      login,
      logout,
      setBranch,
      can: (p) => !!user?.permissions.includes(p),
    }),
    [user, branches, branchId, loading, token, login, logout, setBranch],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}
