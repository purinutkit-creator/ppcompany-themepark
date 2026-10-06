import crypto from 'node:crypto';
import {
  barcodePayload,
  dynamicPayload,
  parseCredentialPayload,
  staticPayload,
  type CredentialType,
  type CustomerSnapshot,
} from '@kiosk/shared';
import { config } from '../../config';
import { one, query, type Db, type Tx } from '../../db/pool';
import { badRequest, conflict } from '../../lib/errors';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf: Buffer, len: number): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
      if (out.length >= len) return out;
    }
  }
  return out;
}
const hmac = (msg: string) => crypto.createHmac('sha256', config.credentialSecret).update(msg).digest();

/** 8 base32 chars (40 bits) — unguessable but short enough for Code128 on 58 mm paper. */
export const signCode = (code: string, version: number) => base32(hmac(`${code}:${version}`), 8);
export const signDynamic = (code: string, version: number, exp: number) => base32(hmac(`D:${code}:${version}:${exp}`), 10);

export function payloadsFor(c: { code: string; token_version: number }) {
  const sig = signCode(c.code, c.token_version);
  return { code: c.code, qr: staticPayload(c.code, sig), barcode: barcodePayload(c.code, sig) };
}

/** Short-lived QR for the digital member card / app tickets (screenshots stop working after `ttlSec`). */
export function dynamicFor(c: { code: string; token_version: number }, ttlSec: number, now = Date.now()) {
  // Align to 15 s windows so repeated fetches inside a window return the same code (no flicker).
  const exp = Math.floor(now / 15000) * 15 + ttlSec;
  const p = dynamicPayload(c.code, exp, signDynamic(c.code, c.token_version, exp));
  return { qr: p, barcode: p, expiresAt: new Date(exp * 1000).toISOString() };
}

const PREFIX: Partial<Record<CredentialType, { prefix: string; seq: string }>> = {
  MEMBER_CARD: { prefix: 'CARD', seq: 'card_no_seq' },
  DIGITAL_CARD: { prefix: 'DC', seq: 'card_no_seq' },
  TEMP_CARD: { prefix: 'TC', seq: 'card_no_seq' },
  TEMP_WRISTBAND: { prefix: 'WB', seq: 'wristband_no_seq' },
  PRINTED_WRISTBAND: { prefix: 'WB', seq: 'wristband_no_seq' },
  RFID: { prefix: 'RF', seq: 'wristband_no_seq' },
};

export interface IssueInput {
  type: CredentialType;
  code?: string;
  branchId?: string | null;
  accountId?: string | null;
  memberId?: string | null;
  bookingId?: string | null;
  batchId?: string | null;
  status?: 'NEW' | 'ACTIVE';
  label?: string | null;
  expiryPolicy?: 'NONE' | 'END_OF_VISIT' | 'END_OF_DAY' | 'PACKAGE_EXPIRY' | 'FIXED';
  expiresAt?: Date | string | null;
  issuedBy?: string | null;
  heightCm?: number | null;
}

export async function issueCredential(db: Db, i: IssueInput) {
  let code = i.code;
  if (!code) {
    const p = PREFIX[i.type];
    if (!p) throw badRequest('CODE_REQUIRED');
    const n = await one<{ n: number }>(`SELECT nextval('${p.seq}')::bigint AS n`, [], db);
    code = `${p.prefix}-${String(n!.n).padStart(8, '0')}`;
  }
  const status = i.status ?? 'ACTIVE';
  return one<any>(
    `INSERT INTO credentials (code, type, status, branch_id, account_id, member_id, booking_id, batch_id, label, expiry_policy, expires_at,
        issued_by, issued_at, activated_at, height_cm)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), CASE WHEN $3='ACTIVE' THEN now() END, $13) RETURNING *`,
    [code.toUpperCase(), i.type, status, i.branchId ?? null, i.accountId ?? null, i.memberId ?? null, i.bookingId ?? null, i.batchId ?? null,
     i.label ?? null, i.expiryPolicy ?? 'NONE', i.expiresAt ?? null, i.issuedBy ?? null, i.heightCm ?? null],
    db,
  );
}

export type ScanFailure =
  | 'INVALID_CODE'
  | 'FORGED_CODE'
  | 'QR_EXPIRED'
  | 'QR_ROTATED'
  | 'NO_TICKET';

export interface ScanResolution {
  ok: boolean;
  reason?: ScanFailure;
  credential?: any;
  /** The scanned code even when invalid (for logs). */
  code: string | null;
  kind: 'STATIC' | 'DYNAMIC' | 'RFID' | 'UNKNOWN';
}

/**
 * Resolve a scanned QR / barcode / RFID UID to a credential row. Always server-side: the payload only
 * identifies the credential; status, tickets and balances come from the database.
 */
export async function resolveScan(raw: string, db?: Db, opts: { allowStaticDigital?: boolean } = {}): Promise<ScanResolution> {
  const p = parseCredentialPayload(raw);
  if (p.kind === 'UNKNOWN') return { ok: false, reason: 'INVALID_CODE', code: null, kind: p.kind };
  if (p.kind === 'RFID') {
    const c = await one<any>(`SELECT * FROM credentials WHERE rfid_uid=$1`, [p.raw], db);
    return c ? { ok: true, credential: c, code: c.code, kind: p.kind } : { ok: false, reason: 'NO_TICKET', code: p.raw, kind: p.kind };
  }
  const c = await one<any>(`SELECT * FROM credentials WHERE code=$1`, [p.code], db);
  if (!c) return { ok: false, reason: 'NO_TICKET', code: p.code, kind: p.kind };
  if (p.kind === 'DYNAMIC') {
    const expected = signDynamic(c.code, c.token_version, p.exp!);
    if (!safeEq(expected, p.sig!)) return { ok: false, reason: 'FORGED_CODE', credential: c, code: c.code, kind: p.kind };
    if (p.exp! * 1000 < Date.now()) return { ok: false, reason: 'QR_EXPIRED', credential: c, code: c.code, kind: p.kind };
    return { ok: true, credential: c, code: c.code, kind: p.kind };
  }
  if (!safeEq(signCode(c.code, c.token_version), p.sig!)) {
    for (let v = c.token_version - 1; v >= Math.max(1, c.token_version - 5); v--) {
      if (safeEq(signCode(c.code, v), p.sig!)) return { ok: false, reason: 'QR_ROTATED', credential: c, code: c.code, kind: p.kind };
    }
    return { ok: false, reason: 'FORGED_CODE', credential: c, code: c.code, kind: p.kind };
  }
  // Digital cards must be shown as the rotating QR from the app (anti screenshot sharing).
  if (c.type === 'DIGITAL_CARD' && !opts.allowStaticDigital) return { ok: false, reason: 'QR_EXPIRED', credential: c, code: c.code, kind: p.kind };
  return { ok: true, credential: c, code: c.code, kind: p.kind };
}

function safeEq(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Maps credential status to the customer-facing reason code. */
export function credentialStatusReason(status: string): string | null {
  switch (status) {
    case 'ACTIVE':
      return null;
    case 'NEW':
      return 'NOT_ACTIVATED';
    case 'LOST':
      return 'CARD_LOST';
    case 'BLOCKED':
      return 'CARD_BLOCKED';
    case 'SUSPENDED':
      return 'CARD_SUSPENDED';
    case 'EXPIRED':
      return 'CARD_EXPIRED';
    case 'REPLACED':
      return 'CARD_REPLACED';
    default:
      return 'CARD_CLOSED';
  }
}

/** Lazily expire credentials whose expiry passed (checked at every scan). */
export async function effectiveStatus(db: Db, c: any): Promise<string> {
  if (c.status === 'ACTIVE' && c.expires_at && new Date(c.expires_at) < new Date()) {
    await query(`UPDATE credentials SET status='EXPIRED', status_reason='AUTO_EXPIRED' WHERE id=$1 AND status='ACTIVE'`, [c.id], db);
    c.status = 'EXPIRED';
  }
  return c.status;
}

export async function isBlacklisted(db: Db, c: any, branchId: string): Promise<boolean> {
  const r = await one(
    `SELECT 1 FROM blacklist_entries b
      WHERE (b.branch_id IS NULL OR b.branch_id=$4) AND (b.until IS NULL OR b.until > now())
        AND (b.credential_id=$1 OR (b.member_id IS NOT NULL AND b.member_id=$2)
             OR (b.phone IS NOT NULL AND b.phone = (SELECT phone FROM members WHERE id=$2)) OR (b.phone IS NOT NULL AND b.phone = $3))
      LIMIT 1`,
    [c.id, c.member_id, (await one<any>(`SELECT phone FROM customer_accounts WHERE id=$1`, [c.account_id], db))?.phone ?? null, branchId],
    db,
  );
  return !!r;
}

/** Tickets usable through a credential: explicit links, its booking, its own QR ticket, and (members) account tickets. */
export async function ticketsForCredential(db: Db, c: any, opts: { includeAccount?: boolean } = {}) {
  return query<any>(
    `SELECT DISTINCT ON (t.id) t.*, p.name AS package_name, p.code AS package_code, p.all_rides, p.kind AS package_kind,
            tt.name AS ticket_type_name, tt.code AS ticket_type_code, tt.min_age AS tt_min_age, tt.max_age AS tt_max_age,
            tt.min_height AS tt_min_height, tt.max_height AS tt_max_height, b.booking_no, b.status AS booking_status
       FROM tickets t
       JOIN packages p ON p.id = t.package_id
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
       LEFT JOIN bookings b ON b.id = t.booking_id
      WHERE t.id IN (SELECT ticket_id FROM credential_links WHERE credential_id=$1 AND unlinked_at IS NULL)
         OR ($2::uuid IS NOT NULL AND t.booking_id = $2)
         OR t.credential_id = $1
         OR ($3 AND $4::uuid IS NOT NULL AND t.account_id = $4
             AND NOT EXISTS (SELECT 1 FROM credential_links l JOIN credentials oc ON oc.id = l.credential_id
                              WHERE l.ticket_id = t.id AND l.unlinked_at IS NULL AND oc.type IN ('TEMP_WRISTBAND','PRINTED_WRISTBAND','TEMP_CARD')))
      ORDER BY t.id`,
    [c.id, c.type === 'BOOKING' ? c.booking_id : null, !!opts.includeAccount && ['MEMBER_CARD', 'DIGITAL_CARD'].includes(c.type), c.account_id],
    db,
  );
}

/** Everything a staff screen shows after scanning a card (CARD PROFILE). */
export async function credentialProfile(db: Db, credentialId: string) {
  const c = await one<any>(`SELECT * FROM credentials WHERE id=$1`, [credentialId], db);
  if (!c) return null;
  const [account, member, wallet] = await Promise.all([
    c.account_id ? one<any>(`SELECT * FROM customer_accounts WHERE id=$1`, [c.account_id], db) : null,
    c.member_id
      ? one<any>(
          `SELECT m.id, m.member_no, m.first_name, m.last_name, m.phone, m.email, m.birthday, m.points, m.total_spend, m.visit_count, m.status,
                  m.join_date, t.code AS tier_code, t.name AS tier_name, t.color AS tier_color,
                  (SELECT json_build_object('id', ms.id, 'product_id', ms.product_id, 'start_date', ms.start_date, 'end_date', ms.end_date, 'status', ms.status,
                     'product_name', mp.name)
                     FROM memberships ms JOIN membership_products mp ON mp.id = ms.product_id
                    WHERE ms.member_id = m.id AND ms.status='ACTIVE' ORDER BY ms.end_date DESC NULLS FIRST LIMIT 1) AS membership
             FROM members m LEFT JOIN member_tiers t ON t.id = m.tier_id WHERE m.id=$1`,
          [c.member_id],
          db,
        )
      : null,
    c.account_id ? one<any>(`SELECT id, balance, bonus_balance, status FROM wallet_accounts WHERE account_id=$1`, [c.account_id], db) : null,
  ]);
  const tickets = await ticketsForCredential(db, c, { includeAccount: true });
  const entitlements = await query<any>(
    `SELECT e.*, r.name AS ride_name, r.code AS ride_code FROM ride_entitlements e LEFT JOIN rides r ON r.id = e.ride_id
      WHERE e.status IN ('ACTIVE','EXHAUSTED') AND (e.credential_id = $1 OR e.ticket_id = ANY($2) OR (e.ticket_id IS NULL AND e.credential_id IS NULL AND e.account_id = $3))
      ORDER BY e.created_at DESC LIMIT 100`,
    [c.id, tickets.map((t) => t.id), c.account_id],
    db,
  );
  const lockers = await query<any>(
    `SELECT s.*, l.code AS locker_code, l.bank FROM locker_sessions s JOIN lockers l ON l.id = s.locker_id WHERE s.status='ACTIVE' AND (s.credential_id=$1 OR s.account_id=$2)`,
    [c.id, c.account_id],
    db,
  );
  const queues = await query<any>(
    `SELECT q.*, r.name AS ride_name FROM ride_queues q JOIN rides r ON r.id=q.ride_id WHERE q.status IN ('WAITING','CALLED') AND (q.credential_id=$1 OR q.account_id=$2)`,
    [c.id, c.account_id],
    db,
  );
  const linked = c.account_id
    ? await query<any>(`SELECT id, code, type, status, label FROM credentials WHERE account_id=$1 AND id<>$2 ORDER BY created_at DESC LIMIT 20`, [c.account_id, c.id], db)
    : [];
  return { credential: { ...c, ...payloadsFor(c) }, account, member, wallet, tickets, entitlements, lockers, queues, linkedCredentials: linked };
}

export function snapshotFrom(p: Awaited<ReturnType<typeof credentialProfile>>, ticket?: any): CustomerSnapshot {
  if (!p) return {};
  const c = p.credential;
  const m = p.member;
  return {
    credentialId: c.id,
    credentialCode: c.code,
    credentialType: c.type,
    credentialStatus: c.status,
    name: m ? `${m.first_name} ${m.last_name}`.trim() : ticket?.guest_name ?? p.account?.display_name ?? c.label ?? null,
    memberNo: m?.member_no ?? null,
    tier: m?.tier_code ? { code: m.tier_code, name: m.tier_name, color: m.tier_color } : null,
    ticketNo: ticket?.ticket_no ?? null,
    ticketType: ticket?.ticket_type_name ?? null,
    packageName: ticket?.package_name ?? null,
    visitDate: ticket?.visit_date ?? null,
    ticketStatus: ticket?.status ?? null,
    bookingNo: ticket?.booking_no ?? null,
    walletBalance: p.wallet ? Number(p.wallet.balance) : null,
    points: m ? Number(m.points) : null,
  };
}

/** Rotate a credential's signature: every printed / screenshotted code of it stops working. */
export async function rotateCredential(c: Tx, credentialId: string) {
  const r = await one<any>(`UPDATE credentials SET token_version = token_version + 1 WHERE id=$1 RETURNING *`, [credentialId], c);
  if (!r) throw conflict('NOT_FOUND');
  return r;
}

export async function touchCredential(db: Db, credentialId: string, zoneId: string | null) {
  await query(`UPDATE credentials SET last_seen_at=now(), last_zone_id=COALESCE($2, last_zone_id) WHERE id=$1`, [credentialId, zoneId], db).catch(() => {});
}
