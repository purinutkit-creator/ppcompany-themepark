export const money = (n: number | string | null | undefined, sym = '฿') =>
  `${sym}${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const money0 = (n: number | string | null | undefined, sym = '฿') => {
  const v = Number(n || 0);
  return `${sym}${v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
};
export const time = (d: string | Date | null | undefined, withSec = false) =>
  d ? new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(withSec ? { second: '2-digit' } : {}) }) : '—';
export const dateTime = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
export const dateOnly = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function elapsed(from: string | Date | null | undefined, now = Date.now()): string {
  if (!from) return '—';
  const s = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s % 60).padStart(2, '0')}`;
}
export const minutesSince = (from: string | Date | null | undefined) => (from ? (Date.now() - new Date(from).getTime()) / 60000 : 0);

export const STATUS_COLORS: Record<string, string> = {
  CREATED: 'bg-slate-100 text-slate-700',
  WAITING_PAYMENT: 'bg-amber-100 text-amber-800',
  WAITING_CASH_PAYMENT: 'bg-amber-100 text-amber-800',
  WAITING_CARD: 'bg-amber-100 text-amber-800',
  WAITING_VERIFICATION: 'bg-orange-100 text-orange-800',
  PAID: 'bg-emerald-100 text-emerald-800',
  CONFIRMED: 'bg-emerald-100 text-emerald-800',
  NEW: 'bg-sky-100 text-sky-800',
  PREPARING: 'bg-indigo-100 text-indigo-800',
  READY: 'bg-green-100 text-green-800',
  COMPLETED: 'bg-slate-200 text-slate-700',
  CANCELLED: 'bg-rose-100 text-rose-700',
  REFUNDED: 'bg-fuchsia-100 text-fuchsia-800',
  QUEUED: 'bg-slate-100 text-slate-700',
  PRINTING: 'bg-sky-100 text-sky-800',
  PRINTED: 'bg-emerald-100 text-emerald-800',
  FAILED: 'bg-rose-100 text-rose-700',
  RETRYING: 'bg-amber-100 text-amber-800',
  CONNECTED: 'bg-emerald-100 text-emerald-800',
  ONLINE: 'bg-emerald-100 text-emerald-800',
  OFFLINE: 'bg-slate-200 text-slate-600',
  ERROR: 'bg-rose-100 text-rose-700',
  UNKNOWN: 'bg-slate-100 text-slate-600',
  APPROVED: 'bg-emerald-100 text-emerald-800',
  REJECTED: 'bg-rose-100 text-rose-700',
  PENDING: 'bg-amber-100 text-amber-800',
  UNPAID: 'bg-slate-100 text-slate-700',
  VOID: 'bg-rose-100 text-rose-700',
  PARTIALLY_REFUNDED: 'bg-fuchsia-100 text-fuchsia-800',
  AVAILABLE: 'bg-emerald-100 text-emerald-800',
  SOLD_OUT: 'bg-rose-100 text-rose-700',
  UNAVAILABLE: 'bg-amber-100 text-amber-800',
  HIDDEN: 'bg-slate-200 text-slate-600',
};
export const prettyStatus = (s: string | null | undefined) => (s ?? '').replace(/_/g, ' ');
