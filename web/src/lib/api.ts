import { deviceId } from './device';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
  get isNetwork() {
    return this.status === 0;
  }
}

export const storage = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

type Mode = 'staff' | 'kiosk' | 'public' | 'device' | 'park' | 'member' | 'parkdevice';
export interface ReqOpts {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  raw?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function request<T>(mode: Mode, path: string, o: ReqOpts = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Device-Id': deviceId(), ...(o.headers ?? {}) };
  if (mode === 'staff') {
    const t = storage.get('staff_token');
    if (t) headers.Authorization = `Bearer ${t}`;
    const b = storage.get('staff_branch');
    if (b) headers['X-Branch-Id'] = b;
  }
  if (mode === 'kiosk' || mode === 'device') {
    const t = storage.get('kiosk_token');
    if (t) headers['X-Kiosk-Token'] = t;
  }
  if (mode === 'device' && !headers['X-Kiosk-Token']) {
    const t = storage.get('staff_token');
    if (t) headers.Authorization = `Bearer ${t}`;
    const b = storage.get('staff_branch');
    if (b) headers['X-Branch-Id'] = b;
  }
  if (mode === 'park' || mode === 'parkdevice') {
    // Staff screens act as the signed-in staff. Device screens (gate / ride / locker) act as the paired
    // device when a device token exists (the server gives a device token precedence), staff otherwise.
    const d = mode === 'parkdevice' ? storage.get('park_device_token') : null;
    if (d) headers['X-Device-Token'] = d;
    const t = !d ? storage.get('staff_token') : null;
    if (t) headers.Authorization = `Bearer ${t}`;
    const b = storage.get('staff_branch');
    if (b && t) headers['X-Branch-Id'] = b;
  }
  if (mode === 'member') {
    const t = storage.get('member_token');
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  if (o.idempotencyKey) headers['Idempotency-Key'] = o.idempotencyKey;
  let body: BodyInit | undefined;
  if (o.body instanceof FormData) body = o.body;
  else if (o.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(o.body);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 20000);
  o.signal?.addEventListener('abort', () => ctrl.abort());
  let res: Response;
  try {
    res = await fetch(path, { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), headers, body, signal: ctrl.signal });
  } catch (e) {
    throw new ApiError(0, 'NETWORK', 'Network error — please check the connection');
  } finally {
    clearTimeout(timer);
  }
  if (o.raw) {
    if (!res.ok) throw new ApiError(res.status, 'HTTP_' + res.status, res.statusText);
    return res as unknown as T;
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = data?.error ?? {};
    if (res.status === 401 && (mode === 'staff' || mode === 'park')) window.dispatchEvent(new CustomEvent('staff-unauthorized'));
    if (res.status === 401 && mode === 'member') window.dispatchEvent(new CustomEvent('member-unauthorized'));
    throw new ApiError(res.status, err.code ?? 'HTTP_' + res.status, err.message ?? res.statusText, err.details);
  }
  return data as T;
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

export const staffApi = <T = any>(path: string, o?: ReqOpts) => request<T>('staff', `/api${path}`, o);
export const kioskApi = <T = any>(path: string, o?: ReqOpts) => request<T>('kiosk', `/api/kiosk${path}`, o);
/** Print executor endpoints: authenticates as the kiosk if paired, otherwise as the logged-in staff device. */
export const deviceApi = <T = any>(path: string, o?: ReqOpts) => request<T>('device', `/api${path}`, o);
export const publicApi = <T = any>(path: string, o?: ReqOpts) => request<T>('public', `/api/public${path}`, o);
/** Park staff screens (staff token; a paired device token is sent too when present). */
export const parkApi = <T = any>(path: string, o?: ReqOpts) => request<T>('park', `/api/park${path}`, o);
/** Park device screens (gate display, ride scanner, locker station): device token first, staff as fallback. */
export const parkDeviceApi = <T = any>(path: string, o?: ReqOpts) => request<T>('parkdevice', `/api/park${path}`, o);
export const parkPublicApi = <T = any>(path: string, o?: ReqOpts) => request<T>('public', `/api/park/public${path}`, o);
/** Park endpoints from the paired self-service kiosk (X-Kiosk-Token). */
export const parkKioskApi = <T = any>(path: string, o?: ReqOpts) => request<T>('kiosk', `/api/park${path}`, o);
export const memberApi = <T = any>(path: string, o?: ReqOpts) => request<T>('member', `/api/park/member${path}`, o);
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'VALIDATION_ERROR' && Array.isArray(e.details)) return `${e.message}: ${e.details.map((d: any) => `${d.path} ${d.message}`).join('; ')}`;
    return e.message || e.code;
  }
  return (e as Error)?.message ?? String(e);
}

/** Download a binary export (CSV/XLSX) with staff auth. */
export async function downloadStaff(path: string, filename: string) {
  const res = await request<Response>('park', `/api${path}`, { raw: true });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function uploadFile(file: File, kind: 'image' | 'video' | 'font' = 'image'): Promise<{ url: string }> {
  const fd = new FormData();
  fd.append('file', file);
  return staffApi(`/settings/uploads?kind=${kind}`, { method: 'POST', body: fd, timeoutMs: 120000 });
}
