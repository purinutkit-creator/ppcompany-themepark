import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { EVENTS, rooms, type I18nText, type ParkMemberCtx } from '@kiosk/shared';
import { one, query, tx, type Db, type Tx } from '../../db/pool';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors';
import { Outbox, publish } from '../../lib/realtime';
import { getSettings } from '../../lib/settings';
import { hashSecret, verifySecret, sha256 } from '../../lib/tokens';
import { config } from '../../config';
import { createAccount } from './common';
import { issueCredential } from './credentials';
import { notify } from './notifications';

export const normalizePhone = (p: string) => {
  const d = String(p ?? '').replace(/[^\d+]/g, '');
  if (d.startsWith('+66')) return '0' + d.slice(3);
  if (d.startsWith('66') && d.length === 11) return '0' + d.slice(2);
  return d;
};
export const normalizeEmail = (e: string | null | undefined) => (e ? String(e).trim().toLowerCase() : null);

export interface RegisterInput {
  phone: string;
  firstName: string;
  lastName?: string | null;
  email?: string | null;
  password?: string | null;
  birthday?: string | null;
  gender?: 'MALE' | 'FEMALE' | 'OTHER' | 'UNSPECIFIED' | null;
  address?: string | null;
  emergencyContact?: string | null;
  language?: string;
  branchId?: string | null;
  createdVia: 'ONLINE' | 'COUNTER' | 'KIOSK' | 'IMPORT';
  staffId?: string | null;
}

/** Create a member: customer account + wallet + member row + digital member card credential. */
export async function registerMemberTx(c: Tx, i: RegisterInput) {
  const s = await getSettings(c);
  const phone = normalizePhone(i.phone);
  if (!/^\+?\d{9,15}$/.test(phone)) throw badRequest('INVALID_PHONE', 'Invalid phone number');
  const email = normalizeEmail(i.email);
  if (i.password != null && i.password.length < s.member.passwordMinLength) throw badRequest('WEAK_PASSWORD', `Password must be at least ${s.member.passwordMinLength} characters`);
  const dupPhone = await one(`SELECT 1 FROM members WHERE phone=$1`, [phone], c);
  if (dupPhone) throw conflict('PHONE_TAKEN', 'This phone number is already registered');
  if (email && (await one(`SELECT 1 FROM members WHERE lower(email)=$1`, [email], c))) throw conflict('EMAIL_TAKEN', 'This email is already registered');
  const name = `${i.firstName} ${i.lastName ?? ''}`.trim();
  const acc = await createAccount(c, { branchId: i.branchId ?? null, kind: 'MEMBER', name, phone, email });
  const tier = await one<any>(`SELECT id FROM member_tiers WHERE is_default AND is_active LIMIT 1`, [], c);
  const no = await one<{ n: number }>(`SELECT nextval('member_no_seq')::bigint AS n`, [], c);
  const m = await one<any>(
    `INSERT INTO members (member_no, account_id, first_name, last_name, phone, email, password_hash, birthday, gender, address, emergency_contact,
        tier_id, home_branch_id, created_via, language)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [`MB${String(no!.n).padStart(6, '0')}`, acc.id, i.firstName.trim(), (i.lastName ?? '').trim(), phone, email, i.password ? await hashSecret(i.password) : null,
     i.birthday || null, i.gender ?? null, i.address ?? null, i.emergencyContact ?? null, tier?.id ?? null, i.branchId ?? null, i.createdVia, i.language ?? 'th'],
    c,
  );
  const card = await issueCredential(c, { type: 'DIGITAL_CARD', branchId: i.branchId ?? null, accountId: acc.id, memberId: m.id, issuedBy: i.staffId ?? null, label: name });
  await query(`INSERT INTO membership_cards (member_id, credential_id, card_type) VALUES ($1,$2,'DIGITAL')`, [m.id, card.id], c);
  return { member: m, account: acc, digitalCard: card };
}

export async function getMemberFull(db: Db, memberId: string) {
  const m = await one<any>(
    `SELECT m.*, t.code AS tier_code, t.name AS tier_name, t.color AS tier_color, t.rank AS tier_rank,
            w.balance AS wallet_balance, w.bonus_balance AS wallet_bonus, w.status AS wallet_status
       FROM members m LEFT JOIN member_tiers t ON t.id=m.tier_id LEFT JOIN wallet_accounts w ON w.account_id=m.account_id
      WHERE m.id=$1`,
    [memberId],
    db,
  );
  if (!m) throw notFound('Member');
  delete m.password_hash;
  const membership = await one<any>(
    `SELECT ms.*, mp.name AS product_name, mp.code AS product_code, mp.card_design, mp.renewal_price, mp.price, mp.early_renewal_days,
            mp.early_renewal_discount_pct, mp.grace_days, mp.validity_unit, mp.validity_value, mp.image_url
       FROM memberships ms JOIN membership_products mp ON mp.id=ms.product_id
      WHERE ms.member_id=$1 AND ms.status='ACTIVE' ORDER BY ms.end_date DESC NULLS FIRST LIMIT 1`,
    [memberId],
    db,
  );
  const benefits = membership
    ? await query<any>(`SELECT type, value, name, config FROM membership_benefits WHERE product_id=$1 ORDER BY sort`, [membership.product_id], db)
    : [];
  const cards = await query<any>(
    `SELECT id, code, type, status, token_version, label, issued_at, expires_at FROM credentials WHERE member_id=$1 ORDER BY created_at DESC`,
    [memberId],
    db,
  );
  let daysRemaining: number | null = null;
  if (membership?.end_date) daysRemaining = Math.ceil((Date.parse(`${membership.end_date}T23:59:59+07:00`) - Date.now()) / 86_400_000);
  return { member: m, membership: membership ? { ...membership, days_remaining: daysRemaining } : null, benefits, cards };
}

/** Pricing context: tier, birthday, discounts per category and per-promotion usage. */
export async function memberPricingCtx(db: Db, memberId: string | null | undefined): Promise<ParkMemberCtx | null> {
  if (!memberId) return null;
  const m = await one<any>(
    `SELECT m.id, m.tier_id, m.birthday::text AS birthday, m.status, t.name AS tier_name FROM members m LEFT JOIN member_tiers t ON t.id=m.tier_id WHERE m.id=$1`,
    [memberId],
    db,
  );
  if (!m || m.status !== 'ACTIVE') return null;
  const benefits = await query<any>(
    `SELECT b.type, b.value FROM memberships ms JOIN membership_benefits b ON b.product_id=ms.product_id
      WHERE ms.member_id=$1 AND ms.status='ACTIVE'`,
    [memberId],
    db,
  );
  const discounts: Record<string, number> = {};
  const map: Record<string, string> = { TICKET_DISCOUNT: 'TICKET', FOOD_DISCOUNT: 'FOOD', RETAIL_DISCOUNT: 'RETAIL', LOCKER_DISCOUNT: 'LOCKER', RIDE_DISCOUNT: 'RIDE' };
  for (const b of benefits) if (map[b.type]) discounts[map[b.type]] = Math.max(discounts[map[b.type]] ?? 0, Number(b.value));
  const usage = await query<any>(`SELECT promotion_id, COUNT(*)::int AS n FROM promotion_redemptions WHERE member_id=$1 GROUP BY promotion_id`, [memberId], db);
  const name: I18nText = m.tier_name ?? { th: 'ส่วนลดสมาชิก', en: 'Member discount', zh: '会员折扣' };
  return {
    memberId,
    tierId: m.tier_id,
    birthday: m.birthday,
    usage: Object.fromEntries(usage.map((u) => [u.promotion_id, u.n])),
    discounts,
    tierName: { th: `ส่วนลดสมาชิก ${name.th ?? ''}`.trim(), en: `${name.en ?? ''} member discount`.trim(), zh: `${name.zh ?? ''}会员折扣` },
  };
}

export async function memberHasBenefit(db: Db, memberId: string, type: string): Promise<any | null> {
  return one<any>(
    `SELECT b.* FROM memberships ms JOIN membership_benefits b ON b.product_id=ms.product_id WHERE ms.member_id=$1 AND ms.status='ACTIVE' AND b.type=$2 LIMIT 1`,
    [memberId, type],
    db,
  );
}

function addValidity(start: string, unit: string, value: number): string | null {
  if (unit === 'LIFETIME') return null;
  const d = new Date(`${start}T00:00:00Z`);
  if (unit === 'DAY') d.setUTCDate(d.getUTCDate() + value);
  else if (unit === 'MONTH') d.setUTCMonth(d.getUTCMonth() + value);
  else d.setUTCFullYear(d.getUTCFullYear() + value);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Price for renewing / upgrading (used by the sale engine). */
export async function membershipQuote(db: Db, memberId: string, kind: 'NEW' | 'RENEWAL' | 'UPGRADE', productId: string, today: string) {
  const p = await one<any>(`SELECT * FROM membership_products WHERE id=$1 AND is_active`, [productId], db);
  if (!p) throw notFound('Membership product');
  const cur = await one<any>(
    `SELECT ms.*, mp.price AS cur_price, t.rank AS cur_rank FROM memberships ms JOIN membership_products mp ON mp.id=ms.product_id JOIN member_tiers t ON t.id=ms.tier_id
      WHERE ms.member_id=$1 AND ms.status='ACTIVE' ORDER BY ms.end_date DESC NULLS FIRST LIMIT 1`,
    [memberId],
    db,
  );
  if (kind === 'NEW') {
    if (cur && cur.product_id === productId) throw conflict('ALREADY_MEMBER', 'Membership already active — use renewal');
    return { product: p, base: Number(p.price) + Number(p.registration_fee), price: Number(p.price) + Number(p.registration_fee), note: null as string | null };
  }
  if (kind === 'RENEWAL') {
    if (!cur || cur.product_id !== productId) {
      // Renewing an expired membership (within grace) is allowed; otherwise buy NEW.
      const last = await one<any>(`SELECT * FROM memberships WHERE member_id=$1 AND product_id=$2 ORDER BY end_date DESC NULLS FIRST LIMIT 1`, [memberId, productId], db);
      if (!last) throw conflict('NOT_RENEWABLE', 'No membership of this type to renew');
    }
    const base = Number(p.renewal_price ?? p.price);
    let price = base;
    let note: string | null = null;
    if (cur?.end_date && Number(p.early_renewal_discount_pct) > 0) {
      const daysLeft = Math.ceil((Date.parse(`${cur.end_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
      if (daysLeft >= 0 && daysLeft <= Number(p.early_renewal_days)) {
        price = Math.round(base * (100 - Number(p.early_renewal_discount_pct))) / 100;
        note = `EARLY_RENEWAL_${p.early_renewal_discount_pct}%`;
      }
    }
    return { product: p, base, price, note };
  }
  // UPGRADE
  if (!cur) throw conflict('NO_ACTIVE_MEMBERSHIP', 'No active membership to upgrade');
  const tier = await one<any>(`SELECT rank FROM member_tiers WHERE id=$1`, [p.tier_id], db);
  if (Number(tier.rank) <= Number(cur.cur_rank)) throw conflict('NOT_AN_UPGRADE', 'Choose a higher tier');
  let price = Number(p.upgrade_price ?? p.price);
  let note: string | null = null;
  if (p.upgrade_price == null) {
    if (p.upgrade_mode === 'DIFFERENCE') price = Math.max(0, Number(p.price) - Number(cur.cur_price));
    else if (p.upgrade_mode === 'PRORATED' && cur.end_date) {
      const total = Math.max(1, (Date.parse(`${cur.end_date}T00:00:00Z`) - Date.parse(`${cur.start_date}T00:00:00Z`)) / 86_400_000);
      const left = Math.max(0, (Date.parse(`${cur.end_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
      price = Math.round(Math.max(0, Number(p.price) - Number(cur.cur_price)) * (left / total) * 100) / 100;
      note = `PRORATED_${Math.round(left)}_DAYS`;
    }
  }
  return { product: p, base: Number(p.price), price, note };
}

/** Fulfil a paid membership line (NEW / RENEWAL / UPGRADE). */
export async function applyMembership(c: Tx, a: { memberId: string; productId: string; kind: 'NEW' | 'RENEWAL' | 'UPGRADE' | 'COMP'; saleId: string | null; price: number; today: string }) {
  const p = await one<any>(`SELECT * FROM membership_products WHERE id=$1`, [a.productId], c);
  if (!p) throw notFound('Membership product');
  const cur = await one<any>(`SELECT * FROM memberships WHERE member_id=$1 AND status='ACTIVE' ORDER BY end_date DESC NULLS FIRST LIMIT 1 FOR UPDATE`, [a.memberId], c);
  let row: any;
  if (a.kind === 'RENEWAL' && cur && cur.product_id === a.productId) {
    const from = cur.end_date && cur.end_date >= a.today ? nextDay(cur.end_date) : a.today;
    const end = addValidity(from, p.validity_unit, p.validity_value);
    row = await one<any>(`UPDATE memberships SET end_date=$2, reminded_days='{}', sale_id=COALESCE($3, sale_id) WHERE id=$1 RETURNING *`, [cur.id, end, a.saleId], c);
  } else {
    let start = a.today;
    let end = addValidity(start, p.validity_unit, p.validity_value);
    if (cur) {
      if (a.kind === 'UPGRADE' && p.upgrade_mode !== 'FULL' && cur.end_date) end = cur.end_date;
      await query(`UPDATE memberships SET status=$2 WHERE id=$1`, [cur.id, a.kind === 'UPGRADE' ? 'UPGRADED' : 'EXPIRED'], c);
    }
    row = await one<any>(
      `INSERT INTO memberships (member_id, product_id, tier_id, kind, status, start_date, end_date, sale_id, price) VALUES ($1,$2,$3,$4,'ACTIVE',$5,$6,$7,$8) RETURNING *`,
      [a.memberId, a.productId, p.tier_id, a.kind === 'RENEWAL' ? 'NEW' : a.kind, start, end, a.saleId, a.price],
      c,
    );
  }
  await query(`UPDATE members SET tier_id=$2 WHERE id=$1`, [a.memberId, p.tier_id], c);
  // Membership card validity follows the membership.
  await query(`UPDATE credentials SET expires_at = CASE WHEN $2::date IS NULL THEN NULL ELSE ($2::date + 1)::timestamptz END WHERE member_id=$1 AND type='MEMBER_CARD' AND status='ACTIVE'`, [a.memberId, row.end_date], c);
  return row;
}

const nextDay = (d: string) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
};

// ------------------------------------------------------------------ login / sessions / OTP
export function memberToken(app: FastifyInstance, m: { id: string; token_version: number }, sid: string) {
  return app.jwt.sign({ sub: m.id, tv: m.token_version, typ: 'member', sid }, { expiresIn: config.memberJwtTtl });
}

export async function memberLogin(app: FastifyInstance, login: string, password: string, meta: { ip: string; ua: string }) {
  const s = await getSettings();
  const isEmail = login.includes('@');
  const m = await one<any>(isEmail ? `SELECT * FROM members WHERE lower(email)=$1` : `SELECT * FROM members WHERE phone=$1`, [isEmail ? normalizeEmail(login) : normalizePhone(login)]);
  if (!m || !m.password_hash) throw unauthorized('Invalid phone / email or password');
  if (m.locked_until && new Date(m.locked_until) > new Date()) throw forbidden('ACCOUNT_LOCKED', 'Too many attempts, try again later');
  if (m.status !== 'ACTIVE') throw forbidden('ACCOUNT_DISABLED', 'Account is not active');
  if (!(await verifySecret(password, m.password_hash))) {
    const n = m.failed_attempts + 1;
    await query(`UPDATE members SET failed_attempts=$2, locked_until = CASE WHEN $2 >= $3 THEN now() + ($4 || ' minutes')::interval END WHERE id=$1`, [
      m.id, n, s.security.maxLoginAttempts, String(s.security.lockMinutes),
    ]);
    throw unauthorized('Invalid phone / email or password');
  }
  // Suspicious login: a new IP / device that this member has never used in the last 60 days.
  const known = await one(`SELECT 1 FROM member_sessions WHERE member_id=$1 AND (ip=$2 OR user_agent=$3) AND created_at > now() - interval '60 days' LIMIT 1`, [m.id, meta.ip, meta.ua.slice(0, 300)]);
  const hasHistory = await one(`SELECT 1 FROM member_sessions WHERE member_id=$1 LIMIT 1`, [m.id]);
  const suspicious = !!hasHistory && !known;
  const sess = await one<any>(`INSERT INTO member_sessions (member_id, ip, user_agent, suspicious) VALUES ($1,$2,$3,$4) RETURNING id`, [m.id, meta.ip, meta.ua.slice(0, 300), suspicious]);
  await query(`UPDATE members SET failed_attempts=0, locked_until=NULL, last_login_at=now(), last_login_ip=$2 WHERE id=$1`, [m.id, meta.ip]);
  if (suspicious) {
    await notify({
      audience: 'ACCOUNT', accountId: m.account_id, type: 'SUSPICIOUS_LOGIN', severity: 'WARNING',
      title: { th: 'มีการเข้าสู่ระบบจากอุปกรณ์ใหม่', en: 'New sign-in to your account', zh: '您的账户有新设备登录' },
      body: { th: `IP ${meta.ip} — หากไม่ใช่คุณ กรุณาออกจากระบบทุกอุปกรณ์และเปลี่ยนรหัสผ่าน`, en: `IP ${meta.ip} — if this wasn't you, sign out of all devices and change your password`, zh: `IP ${meta.ip} — 如非本人操作，请退出所有设备并修改密码` },
      data: { ip: meta.ip },
    });
    await query(`INSERT INTO security_events (branch_id, type, severity, data) VALUES ($1,'SUSPICIOUS_LOGIN','INFO',$2)`, [m.home_branch_id, { memberId: m.id, ip: meta.ip, ua: meta.ua.slice(0, 200) }]);
  }
  return { token: memberToken(app, m, sess.id), memberId: m.id, suspicious };
}

export async function logoutAll(memberId: string) {
  await query(`UPDATE members SET token_version = token_version + 1 WHERE id=$1`, [memberId]);
  await query(`UPDATE member_sessions SET revoked_at=now() WHERE member_id=$1 AND revoked_at IS NULL`, [memberId]);
}

/** OTP delivery adapter. CONSOLE logs the code (development); SMS / EMAIL plug in a provider here. */
export interface OtpSender {
  send(target: string, code: string, purpose: string): Promise<void>;
}
const senders: Record<string, OtpSender> = {
  CONSOLE: { send: async (target, code, purpose) => console.log(`[OTP] ${purpose} for ${target}: ${code}`) },
};
export function registerOtpSender(channel: string, s: OtpSender) {
  senders[channel] = s;
}

export async function requestOtp(target: string, purpose: 'REGISTER' | 'LOGIN' | 'RESET_PASSWORD' | 'VERIFY') {
  const s = await getSettings();
  if (!s.member.otp.enabled) throw badRequest('OTP_DISABLED');
  const recent = await one<any>(`SELECT COUNT(*)::int AS n FROM member_otps WHERE target=$1 AND created_at > now() - interval '10 minutes'`, [target]);
  if (recent.n >= 5) throw conflict('OTP_RATE_LIMITED', 'Too many OTP requests, try again later');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await query(`INSERT INTO member_otps (target, purpose, code_hash, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' seconds')::interval)`, [
    target, purpose, sha256(`${target}:${code}`), String(s.member.otp.ttlSec),
  ]);
  const sender = senders[s.member.otp.channel] ?? senders.CONSOLE;
  await sender.send(target, code, purpose);
  // Development convenience only: never returned in production.
  return { sent: true, ttlSec: s.member.otp.ttlSec, devCode: config.env !== 'production' && s.member.otp.channel === 'CONSOLE' ? code : undefined };
}

export async function verifyOtp(target: string, purpose: string, code: string): Promise<boolean> {
  const row = await one<any>(
    `SELECT * FROM member_otps WHERE target=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
    [target, purpose],
  );
  if (!row) return false;
  if (row.attempts >= 5) return false;
  if (row.code_hash !== sha256(`${target}:${code}`)) {
    await query(`UPDATE member_otps SET attempts=attempts+1 WHERE id=$1`, [row.id]);
    return false;
  }
  await query(`UPDATE member_otps SET consumed_at=now() WHERE id=$1`, [row.id]);
  return true;
}

export async function resetPassword(login: string, code: string, newPassword: string) {
  const s = await getSettings();
  if (newPassword.length < s.member.passwordMinLength) throw badRequest('WEAK_PASSWORD');
  const isEmail = login.includes('@');
  const target = isEmail ? normalizeEmail(login)! : normalizePhone(login);
  if (!(await verifyOtp(target, 'RESET_PASSWORD', code))) throw badRequest('OTP_INVALID', 'Invalid or expired code');
  const m = await one<any>(isEmail ? `SELECT id FROM members WHERE lower(email)=$1` : `SELECT id FROM members WHERE phone=$1`, [target]);
  if (!m) throw notFound('Member');
  await query(`UPDATE members SET password_hash=$2, failed_attempts=0, locked_until=NULL WHERE id=$1`, [m.id, await hashSecret(newPassword)]);
  await logoutAll(m.id);
  return { ok: true };
}

// ------------------------------------------------------------------ background: membership expiry & reminders
export async function membershipMaintenance(): Promise<void> {
  const s = await getSettings();
  const today = new Date().toISOString().slice(0, 10);
  const expired = await query<any>(
    `UPDATE memberships ms SET status='EXPIRED'
       FROM membership_products mp
      WHERE mp.id=ms.product_id AND ms.status='ACTIVE' AND ms.end_date IS NOT NULL AND ms.end_date + mp.grace_days < $1::date
      RETURNING ms.member_id`,
    [today],
  );
  for (const e of expired) {
    await tx(async (c) => {
      const still = await one(`SELECT 1 FROM memberships WHERE member_id=$1 AND status='ACTIVE'`, [e.member_id], c);
      if (!still) await query(`UPDATE members SET tier_id=(SELECT id FROM member_tiers WHERE is_default LIMIT 1) WHERE id=$1`, [e.member_id], c);
    });
    const m = await one<any>(`SELECT account_id FROM members WHERE id=$1`, [e.member_id]);
    if (m) await publish(rooms.account(m.account_id), EVENTS.MEMBER_UPDATED, { memberId: e.member_id, reason: 'EXPIRED' });
  }
  for (const days of s.member.expiryReminderDays) {
    const due = await query<any>(
      `SELECT ms.id, ms.end_date::text AS end_date, m.account_id, m.id AS member_id FROM memberships ms JOIN members m ON m.id=ms.member_id
        WHERE ms.status='ACTIVE' AND ms.end_date = ($1::date + $2::int) AND NOT ($2 = ANY(ms.reminded_days))`,
      [today, days],
    );
    for (const d of due) {
      await notify({
        audience: 'ACCOUNT', accountId: d.account_id, type: 'MEMBERSHIP_EXPIRING', severity: 'INFO', dedupeKey: `ms:${d.id}:${days}`,
        title: { th: 'สมาชิกใกล้หมดอายุ', en: 'Membership expiring soon', zh: '会员即将到期' },
        body: { th: `บัตรสมาชิกของคุณจะหมดอายุวันที่ ${d.end_date} ต่ออายุได้ที่เว็บไซต์`, en: `Your membership expires on ${d.end_date}. Renew online anytime.`, zh: `您的会员将于 ${d.end_date} 到期，可在线续费。` },
        data: { membershipId: d.id, days },
      });
      await query(`UPDATE memberships SET reminded_days = array_append(reminded_days, $2) WHERE id=$1`, [d.id, days]);
    }
  }
}

export async function memberOutboxUpdate(out: Outbox, db: Db, memberId: string) {
  const m = await one<any>(`SELECT account_id FROM members WHERE id=$1`, [memberId], db);
  if (m) out.add(rooms.account(m.account_id), EVENTS.MEMBER_UPDATED, { memberId });
}
