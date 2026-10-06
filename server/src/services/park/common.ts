import crypto from 'node:crypto';
import { localNow, type I18nText, type Lang } from '@kiosk/shared';
import { one, query, type Db } from '../../db/pool';
import { notFound } from '../../lib/errors';
import { deepMerge, getSettings, type Settings } from '../../lib/settings';

export type ParkActor = { type: 'STAFF' | 'DEVICE' | 'MEMBER' | 'GUEST' | 'SYSTEM' | 'PROVIDER' | 'KIOSK'; id?: string | null; name?: string | null };

export interface BranchInfo {
  id: string;
  code: string;
  name: I18nText;
  timezone: string;
  config: Record<string, any>;
}

const branchCache = new Map<string, { at: number; v: BranchInfo }>();
export async function branchInfo(branchId: string, db?: Db): Promise<BranchInfo> {
  const c = branchCache.get(branchId);
  if (c && Date.now() - c.at < 10_000 && !db) return c.v;
  const b = await one<any>(`SELECT id, code, name, timezone, config FROM branches WHERE id=$1`, [branchId], db);
  if (!b) throw notFound('Branch');
  const v: BranchInfo = { id: b.id, code: b.code, name: b.name, timezone: b.timezone || 'Asia/Bangkok', config: b.config ?? {} };
  if (!db) branchCache.set(branchId, { at: Date.now(), v });
  return v;
}
export const invalidateBranchCache = () => branchCache.clear();

/** Local wall-clock date (YYYY-MM-DD) of the branch. */
export async function branchToday(branchId: string, db?: Db, now = new Date()): Promise<string> {
  const b = await branchInfo(branchId, db);
  return localNow(now, b.timezone).date;
}

/** Global park settings with per-branch overrides (branches.config.park / .gate / …). */
export async function parkSettings(branchId: string | null, db?: Db): Promise<Settings> {
  const s = await getSettings(db);
  if (!branchId) return s;
  const b = await branchInfo(branchId, db).catch(() => null);
  if (!b?.config || !Object.keys(b.config).length) return s;
  const out: any = { ...s };
  for (const [k, v] of Object.entries(b.config)) if (k in out) out[k] = deepMerge(out[k], v);
  return out as Settings;
}

/** Atomic per-day counter (sale numbers, tickets…). */
export async function nextCounter(db: Db, scope: string, day: string): Promise<number> {
  const r = await one<{ value: number }>(
    `INSERT INTO daily_counters (scope, day, value) VALUES ($1,$2,1)
     ON CONFLICT (scope, day) DO UPDATE SET value = daily_counters.value + 1 RETURNING value`,
    [scope, day],
    db,
  );
  return Number(r!.value);
}

const compact = (d: string) => d.replace(/-/g, '');
const yymmdd = (d: string) => compact(d).slice(2);

export async function genSaleNo(db: Db, day: string) {
  return `S-${yymmdd(day)}-${String(await nextCounter(db, 'sale', day)).padStart(6, '0')}`;
}
export async function genTicketNo(db: Db, day: string) {
  return `TK-${compact(day)}-${String(await nextCounter(db, 'ticket', day)).padStart(6, '0')}`;
}
export async function genPaymentNo(db: Db, day: string) {
  return `P-${yymmdd(day)}-${String(await nextCounter(db, 'payment', day)).padStart(6, '0')}`;
}
export async function genWalletTxnNo(db: Db, day: string) {
  return `WT-${yymmdd(day)}-${String(await nextCounter(db, 'wallet', day)).padStart(7, '0')}`;
}
export async function genRefundNo(db: Db, day: string) {
  return `RF-${yymmdd(day)}-${String(await nextCounter(db, 'refund', day)).padStart(5, '0')}`;
}
export async function genShiftNo(db: Db, day: string) {
  return `SH-${yymmdd(day)}-${String(await nextCounter(db, 'shift', day)).padStart(4, '0')}`;
}
export async function genRedemptionNo(db: Db, day: string) {
  return `RD-${yymmdd(day)}-${String(await nextCounter(db, 'redeem', day)).padStart(5, '0')}`;
}
export async function genTransferNo(db: Db, day: string) {
  return `TR-${yymmdd(day)}-${String(await nextCounter(db, 'transfer', day)).padStart(4, '0')}`;
}
/** Booking numbers look random (BK-261006-82931) so they cannot be enumerated; unique index guards races. */
export async function genBookingNo(db: Db, day: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const no = `BK-${yymmdd(day)}-${String(crypto.randomInt(10000, 100000))}`;
    const taken = await one(`SELECT 1 FROM bookings WHERE booking_no=$1`, [no], db);
    if (!taken) return no;
  }
  return `BK-${yymmdd(day)}-${crypto.randomInt(100000, 1000000)}`;
}

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function personName(m: { first_name?: string | null; last_name?: string | null } | null | undefined) {
  if (!m) return null;
  return `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim() || null;
}

export function pickLang(v: unknown, fallback: Lang = 'th'): Lang {
  return v === 'th' || v === 'en' || v === 'zh' ? v : fallback;
}

/** Ensure a customer account (+ wallet) exists. */
export async function createAccount(db: Db, a: { branchId?: string | null; kind: 'MEMBER' | 'GUEST'; name?: string | null; phone?: string | null; email?: string | null }) {
  const acc = await one<any>(
    `INSERT INTO customer_accounts (branch_id, kind, display_name, phone, email) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [a.branchId ?? null, a.kind, a.name ?? null, a.phone ?? null, a.email ?? null],
    db,
  );
  await query(`INSERT INTO wallet_accounts (account_id) VALUES ($1) ON CONFLICT DO NOTHING`, [acc.id], db);
  return acc;
}
