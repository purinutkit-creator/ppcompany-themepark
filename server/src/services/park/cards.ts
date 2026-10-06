import { EVENTS, rooms } from '@kiosk/shared';
import { one, query, tx, type Tx } from '../../db/pool';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { Outbox } from '../../lib/realtime';
import { createAccount, parkSettings, round2 } from './common';
import { credentialProfile, effectiveStatus, issueCredential, resolveScan, rotateCredential } from './credentials';
import { announceWallet, refundableBalance, walletPost } from './wallet';

export type CardType = 'MEMBER_CARD' | 'TEMP_CARD' | 'TEMP_WRISTBAND' | 'PRINTED_WRISTBAND' | 'RFID';

/** Issue a new physical card / wristband (optionally bound to a member). */
export async function issueCard(a: { branchId: string; type: CardType; memberId?: string | null; label?: string | null; activate?: boolean; staffId: string; rfidUid?: string | null; heightCm?: number | null }) {
  const out = new Outbox();
  const id = await tx(async (c) => {
    let accountId: string | null = null;
    let expires: string | null = null;
    if (a.memberId) {
      const m = await one<any>(`SELECT id, account_id, first_name, last_name FROM members WHERE id=$1`, [a.memberId], c);
      if (!m) throw notFound('Member');
      accountId = m.account_id;
      const ms = await one<any>(`SELECT end_date FROM memberships WHERE member_id=$1 AND status='ACTIVE' ORDER BY end_date DESC NULLS FIRST LIMIT 1`, [a.memberId], c);
      if (ms?.end_date) expires = `${String(ms.end_date).slice(0, 10)}T23:59:59+07:00`;
    } else if (a.activate) {
      accountId = (await createAccount(c, { branchId: a.branchId, kind: 'GUEST', name: a.label ?? null })).id;
    }
    const cred = await issueCredential(c, {
      type: a.type, branchId: a.branchId, accountId, memberId: a.memberId ?? null, status: a.activate || a.memberId ? 'ACTIVE' : 'NEW',
      label: a.label ?? null, expiresAt: expires, issuedBy: a.staffId, heightCm: a.heightCm ?? null,
      expiryPolicy: a.type === 'MEMBER_CARD' ? 'NONE' : 'END_OF_DAY',
    });
    if (a.rfidUid) await query(`UPDATE credentials SET rfid_uid=$2 WHERE id=$1`, [cred.id, a.rfidUid.toUpperCase()], c);
    if (a.memberId && a.type === 'MEMBER_CARD') await query(`INSERT INTO membership_cards (member_id, credential_id, card_type) VALUES ($1,$2,'PHYSICAL')`, [a.memberId, cred.id], c);
    if (accountId) out.add(rooms.account(accountId), EVENTS.CREDENTIAL_UPDATED, { credentialId: cred.id, reason: 'ISSUED' });
    return cred.id as string;
  });
  await out.flush();
  return credentialProfile((await import('../../db/pool')).pool, id);
}

/** Pre-printed wristband / card stock: N codes in status NEW (activated when bound at the counter). */
export async function generateBatch(a: { branchId: string; type: CardType; qty: number; note?: string | null; staffId: string }) {
  if (a.qty < 1 || a.qty > 2000) throw badRequest('INVALID_QTY', '1–2000 per batch');
  return tx(async (c) => {
    const b = await one<any>(`INSERT INTO wristband_batches (branch_id, type, qty, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [a.branchId, a.type, a.qty, a.note ?? null, a.staffId], c);
    const codes: string[] = [];
    for (let i = 0; i < a.qty; i++) {
      const cred = await issueCredential(c, { type: a.type, branchId: a.branchId, batchId: b.id, status: 'NEW', issuedBy: a.staffId });
      codes.push(cred.code);
    }
    return { batch: b, codes };
  });
}

export async function findCredential(raw: string) {
  const r = await resolveScan(raw, undefined, { allowStaticDigital: true });
  if (r.ok) return r.credential;
  // Staff may type a card code directly (no signature) — lookup only, never used for payment / access.
  const code = raw.trim().toUpperCase();
  const c = await one<any>(`SELECT * FROM credentials WHERE code=$1 OR rfid_uid=$1`, [code]);
  if (c) return c;
  if (r.reason && r.reason !== 'NO_TICKET' && r.reason !== 'INVALID_CODE') throw conflict(r.reason, 'Code not valid');
  throw notFound('Card');
}

const ALLOWED: Record<string, string[]> = {
  ACTIVATE: ['NEW', 'SUSPENDED'],
  SUSPEND: ['ACTIVE'],
  UNSUSPEND: ['SUSPENDED'],
  BLOCK: ['NEW', 'ACTIVE', 'SUSPENDED'],
  UNBLOCK: ['BLOCKED'],
  LOST: ['NEW', 'ACTIVE', 'SUSPENDED'],
  CLOSE: ['NEW', 'ACTIVE', 'SUSPENDED', 'BLOCKED', 'EXPIRED', 'LOST'],
  DEACTIVATE: ['ACTIVE'],
};
const TARGET: Record<string, string> = { ACTIVATE: 'ACTIVE', SUSPEND: 'SUSPENDED', UNSUSPEND: 'ACTIVE', BLOCK: 'BLOCKED', UNBLOCK: 'ACTIVE', LOST: 'LOST', CLOSE: 'CLOSED', DEACTIVATE: 'SUSPENDED' };

/** Card status changes (all take effect immediately on every scanner because scans are validated server-side). */
export async function changeCardStatus(credentialId: string, action: keyof typeof TARGET, reason: string | null) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const cred = await one<any>(`SELECT * FROM credentials WHERE id=$1 FOR UPDATE`, [credentialId], c);
    if (!cred) throw notFound('Card');
    if (!ALLOWED[action]?.includes(cred.status)) throw conflict('INVALID_CARD_STATUS', `Cannot ${action} a ${cred.status} card`);
    let accountId = cred.account_id;
    if (action === 'ACTIVATE' && !accountId) {
      accountId = (await createAccount(c, { branchId: cred.branch_id, kind: 'GUEST', name: cred.label })).id;
    }
    const row = await one<any>(
      `UPDATE credentials SET status=$2, status_reason=$3, account_id=$4, activated_at = CASE WHEN $2='ACTIVE' THEN COALESCE(activated_at, now()) ELSE activated_at END WHERE id=$1 RETURNING *`,
      [credentialId, TARGET[action], reason, accountId],
      c,
    );
    // Lost / blocked cards cannot keep their locker or queue spots.
    if (['LOST', 'BLOCKED', 'CLOSED'].includes(TARGET[action])) await query(`UPDATE ride_queues SET status='CANCELLED', ended_at=now() WHERE credential_id=$1 AND status IN ('WAITING','CALLED')`, [credentialId], c);
    if (accountId) out.add(rooms.account(accountId), EVENTS.CREDENTIAL_UPDATED, { credentialId, status: row.status });
    return row;
  });
  await out.flush();
  return r;
}

/**
 * REPORT LOST / REPLACE: disable the old card and move everything to a new one — member link, wallet
 * (same account → same balance), tickets, ride rights, booking, locker, queue. Old transactions stay on
 * the old credential id, so history remains complete.
 */
export async function replaceCard(a: { oldCredentialId: string; newPayload?: string | null; generate?: boolean; reason: 'LOST' | 'DAMAGED' | 'STOLEN' | 'UPGRADE' | 'OTHER'; note?: string | null; staffId: string; approvedBy?: string | null }) {
  const out = new Outbox();
  const res = await tx(async (c) => {
    const old = await one<any>(`SELECT * FROM credentials WHERE id=$1 FOR UPDATE`, [a.oldCredentialId], c);
    if (!old) throw notFound('Card');
    if (['REPLACED', 'CLOSED'].includes(old.status)) throw conflict('ALREADY_REPLACED', 'Card was already replaced / closed');
    if (['QR_TICKET', 'BOOKING'].includes(old.type)) throw badRequest('NOT_A_CARD');
    let neu: any;
    if (a.newPayload) {
      const r = await resolveScan(a.newPayload, c, { allowStaticDigital: true });
      if (!r.ok) throw conflict(r.reason!, 'New card code not valid');
      neu = await one<any>(`SELECT * FROM credentials WHERE id=$1 FOR UPDATE`, [r.credential.id], c);
      if (neu.id === old.id) throw badRequest('SAME_CARD');
      if ((await effectiveStatus(c, neu)) !== 'NEW') throw conflict('CARD_NOT_NEW', 'The new card must be unused stock');
    } else {
      if (!a.generate) throw badRequest('NEW_CARD_REQUIRED');
      neu = await issueCredential(c, { type: old.type === 'DIGITAL_CARD' ? 'MEMBER_CARD' : old.type, branchId: old.branch_id, status: 'NEW', issuedBy: a.staffId });
    }
    await query(
      `UPDATE credentials SET status='ACTIVE', account_id=$2, member_id=$3, booking_id=$4, expires_at=$5, expiry_policy=$6, label=$7, height_cm=$8,
          activated_at=now(), issued_by=$9, issued_at=now() WHERE id=$1`,
      [neu.id, old.account_id, old.member_id, old.booking_id, old.expires_at, old.expiry_policy, old.label, old.height_cm, a.staffId],
      c,
    );
    await query(`UPDATE credentials SET status=$2, status_reason=$3, replaced_by=$4 WHERE id=$1`, [old.id, a.reason === 'LOST' || a.reason === 'STOLEN' ? 'LOST' : 'REPLACED', a.reason, neu.id], c);
    const links = await query<any>(`UPDATE credential_links SET unlinked_at=now() WHERE credential_id=$1 AND unlinked_at IS NULL RETURNING ticket_id`, [old.id], c);
    for (const l of links) await query(`INSERT INTO credential_links (credential_id, ticket_id, created_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [neu.id, l.ticket_id, a.staffId], c);
    const ents = await query<any>(`UPDATE ride_entitlements SET credential_id=$2 WHERE credential_id=$1 AND status='ACTIVE' RETURNING id`, [old.id, neu.id], c);
    const lockers = await query<any>(`UPDATE locker_sessions SET credential_id=$2 WHERE credential_id=$1 AND status='ACTIVE' RETURNING id`, [old.id, neu.id], c);
    const queues = await query<any>(`UPDATE ride_queues SET credential_id=$2 WHERE credential_id=$1 AND status IN ('WAITING','CALLED') RETURNING id`, [old.id, neu.id], c);
    await query(`UPDATE membership_cards SET credential_id=$2 WHERE credential_id=$1`, [old.id, neu.id], c);
    const wallet = old.account_id ? await one<any>(`SELECT balance FROM wallet_accounts WHERE account_id=$1`, [old.account_id], c) : null;
    const transferred = { tickets: links.length, entitlements: ents.length, lockers: lockers.length, queues: queues.length, walletBalance: wallet ? Number(wallet.balance) : 0, member: !!old.member_id, booking: !!old.booking_id };
    await query(
      `INSERT INTO card_replacements (old_credential_id, new_credential_id, reason, transferred, note, staff_id, approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [old.id, neu.id, a.reason, transferred, a.note ?? null, a.staffId, a.approvedBy ?? null],
      c,
    );
    if (old.account_id) out.add(rooms.account(old.account_id), EVENTS.CREDENTIAL_UPDATED, { credentialId: neu.id, replaced: old.id });
    return { newCredentialId: neu.id, transferred };
  });
  await out.flush();
  return { ...res, profile: await credentialProfile((await import('../../db/pool')).pool, res.newCredentialId) };
}

/** Bind an existing card / wristband to a member. Any guest balance moves to the member wallet. */
export async function bindMember(credentialId: string, memberId: string, staffId: string) {
  const out = new Outbox();
  await tx(async (c) => {
    const cred = await one<any>(`SELECT * FROM credentials WHERE id=$1 FOR UPDATE`, [credentialId], c);
    if (!cred) throw notFound('Card');
    if (cred.member_id && cred.member_id !== memberId) throw conflict('CARD_HAS_MEMBER', 'Unbind the current member first');
    const m = await one<any>(`SELECT * FROM members WHERE id=$1`, [memberId], c);
    if (!m) throw notFound('Member');
    if (cred.account_id && cred.account_id !== m.account_id) await mergeGuestWallet(c, cred.account_id, m.account_id, cred, staffId, out);
    await query(`UPDATE credentials SET member_id=$2, account_id=$3, status = CASE WHEN status='NEW' THEN 'ACTIVE' ELSE status END, activated_at=COALESCE(activated_at,now()) WHERE id=$1`, [credentialId, memberId, m.account_id], c);
    if (cred.type === 'MEMBER_CARD') await query(`INSERT INTO membership_cards (member_id, credential_id, card_type) VALUES ($1,$2,'PHYSICAL') ON CONFLICT (credential_id) DO UPDATE SET member_id=EXCLUDED.member_id`, [memberId, credentialId], c);
    // Tickets bound to this wristband now count for the member (visit history, points).
    await query(`UPDATE tickets SET member_id=$2 WHERE member_id IS NULL AND id IN (SELECT ticket_id FROM credential_links WHERE credential_id=$1 AND unlinked_at IS NULL)`, [credentialId, memberId], c);
    out.add(rooms.account(m.account_id), EVENTS.CREDENTIAL_UPDATED, { credentialId, reason: 'BOUND_MEMBER' });
  });
  await out.flush();
  return credentialProfile((await import('../../db/pool')).pool, credentialId);
}

async function mergeGuestWallet(c: Tx, fromAccount: string, toAccount: string, cred: any, staffId: string, out: Outbox) {
  const w = await one<any>(`SELECT * FROM wallet_accounts WHERE account_id=$1 FOR UPDATE`, [fromAccount], c);
  if (!w || Number(w.balance) <= 0) return;
  const amount = Number(w.balance);
  const bonus = Number(w.bonus_balance);
  await walletPost(c, { accountId: fromAccount, type: 'TRANSFER_OUT', amount: -amount, credentialId: cred.id, branchId: cred.branch_id, staffId, reference: `→ member`, idempotencyKey: `merge:${cred.id}:${w.version}` });
  if (amount - bonus > 0) await walletPost(c, { accountId: toAccount, type: 'TRANSFER_IN', amount: round2(amount - bonus), credentialId: cred.id, branchId: cred.branch_id, staffId, reference: cred.code, idempotencyKey: `merge-in:${cred.id}:${w.version}` });
  if (bonus > 0) await walletPost(c, { accountId: toAccount, type: 'TRANSFER_IN', amount: bonus, bonus: true, credentialId: cred.id, branchId: cred.branch_id, staffId, reference: cred.code, idempotencyKey: `merge-bonus:${cred.id}:${w.version}` });
  await announceWallet(out, c, fromAccount, cred.branch_id);
  await announceWallet(out, c, toAccount, cred.branch_id);
}

export async function unbindMember(credentialId: string) {
  return tx(async (c) => {
    const cred = await one<any>(`SELECT * FROM credentials WHERE id=$1 FOR UPDATE`, [credentialId], c);
    if (!cred?.member_id) throw conflict('NOT_BOUND');
    if (cred.type === 'DIGITAL_CARD') throw badRequest('DIGITAL_CARD_IS_PERMANENT');
    const acc = await createAccount(c, { branchId: cred.branch_id, kind: 'GUEST', name: cred.label });
    await query(`UPDATE credentials SET member_id=NULL, account_id=$2 WHERE id=$1`, [credentialId, acc.id], c);
    await query(`DELETE FROM membership_cards WHERE credential_id=$1`, [credentialId], c);
    return { ok: true };
  });
}

/** Re-issue the QR / barcode signature (old printouts & screenshots stop working). */
export async function rotateCode(credentialId: string) {
  return tx((c) => rotateCredential(c, credentialId));
}

/** Manual wallet adjustment (+/-) with reason — permission + manager PIN checked by the route. */
export async function adjustWallet(a: { accountId: string; amount: number; reason: string; bonus?: boolean; staffId: string; branchId: string; credentialId?: string | null; idempotencyKey?: string | null }) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const s = await parkSettings(a.branchId, c);
    const led = await walletPost(c, { accountId: a.accountId, type: 'ADJUSTMENT', amount: a.amount, bonus: a.bonus, branchId: a.branchId, credentialId: a.credentialId ?? null, staffId: a.staffId, reference: 'ADJUSTMENT', note: a.reason, idempotencyKey: a.idempotencyKey ?? null, maxBalance: s.wallet.maxBalance });
    await announceWallet(out, c, a.accountId, a.branchId, { reason: 'ADJUSTMENT' });
    return led.entry;
  });
  await out.flush();
  return r;
}

/**
 * Remaining balance on exit (policy): REFUNDABLE / REFUND_AT_COUNTER → cash out the refundable part
 * (minus fee); TRANSFER_TO_MEMBER → move to a member wallet; NON_REFUNDABLE / KEEP → refused.
 */
export async function cashOutWallet(a: { accountId: string; mode: 'CASH' | 'TRANSFER_TO_MEMBER'; toMemberId?: string | null; amount?: number | null; staffId: string; branchId: string; approvedBy?: string | null; credentialId?: string | null }) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const s = await parkSettings(a.branchId, c);
    const w = await one<any>(`SELECT * FROM wallet_accounts WHERE account_id=$1 FOR UPDATE`, [a.accountId], c);
    if (!w) throw notFound('Wallet');
    if (a.mode === 'TRANSFER_TO_MEMBER') {
      const m = await one<any>(`SELECT account_id FROM members WHERE id=$1`, [a.toMemberId], c);
      if (!m) throw notFound('Member');
      if (m.account_id === a.accountId) throw badRequest('SAME_WALLET');
      const cred = { id: a.credentialId ?? null, branch_id: a.branchId, code: 'TRANSFER' };
      await mergeGuestWallet(c, a.accountId, m.account_id, cred, a.staffId, out);
      return { transferred: Number(w.balance) };
    }
    if (['NON_REFUNDABLE', 'KEEP_FOR_NEXT_VISIT', 'TRANSFER_TO_MEMBER'].includes(s.wallet.refundPolicy)) throw conflict('WALLET_NOT_REFUNDABLE', `Policy: ${s.wallet.refundPolicy}`);
    const refundable = refundableBalance(w);
    const amount = round2(Math.min(a.amount ?? refundable, refundable));
    if (!(amount > 0)) throw conflict('NOTHING_REFUNDABLE', 'No refundable balance');
    const fee = s.wallet.refundPolicy === 'PARTIAL' || s.wallet.refundFeePct > 0 ? round2((amount * s.wallet.refundFeePct) / 100) : 0;
    const shift = await one<any>(`SELECT id FROM shifts WHERE user_id=$1 AND status='OPEN'`, [a.staffId], c);
    if (!shift && s.shift.requireForCash) throw conflict('SHIFT_REQUIRED', 'Open a shift to pay out cash');
    const led = await walletPost(c, { accountId: a.accountId, type: 'CASHOUT', amount: -amount, branchId: a.branchId, credentialId: a.credentialId ?? null, staffId: a.staffId, reference: 'CASH OUT', note: fee ? `fee ${fee}` : null });
    const today = (await one<any>(`SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM branches WHERE id=$1`, [a.branchId], c)).d;
    const { genRefundNo } = await import('./common');
    const rf = await one<any>(
      `INSERT INTO refunds (refund_no, branch_id, amount, reason, method, refund_method, type, created_by, approved_by, wallet_ledger_id, shift_id)
       VALUES ($1,$2,$3,'WALLET_CASH_OUT','WALLET','CASH','WALLET',$4,$5,$6,$7) RETURNING *`,
      [await genRefundNo(c, today), a.branchId, round2(amount - fee), a.staffId, a.approvedBy ?? null, led.entry.id, shift?.id ?? null],
      c,
    );
    if (shift) await query(`INSERT INTO cash_movements (shift_id, type, amount, ref_type, ref_id, user_id) VALUES ($1,'CASH_REFUND',$2,'WALLET_CASHOUT',$3,$4)`, [shift.id, -(amount - fee), rf.id, a.staffId], c);
    await announceWallet(out, c, a.accountId, a.branchId, { reason: 'CASHOUT' });
    return { paidOut: round2(amount - fee), fee, ledger: led.entry };
  });
  await out.flush();
  return r;
}

export async function listCards(branchId: string, f: { q?: string; type?: string; status?: string; limit?: number }) {
  const params: unknown[] = [branchId];
  const where = ['(c.branch_id=$1 OR c.branch_id IS NULL)', `c.type NOT IN ('QR_TICKET','BOOKING')`];
  if (f.type) {
    params.push(f.type);
    where.push(`c.type=$${params.length}`);
  }
  if (f.status) {
    params.push(f.status);
    where.push(`c.status=$${params.length}`);
  }
  if (f.q) {
    params.push(`%${f.q.trim().replace(/[%_\\]/g, '')}%`);
    const i = params.length;
    where.push(`(c.code ILIKE $${i} OR c.label ILIKE $${i} OR m.member_no ILIKE $${i} OR m.phone ILIKE $${i} OR m.email ILIKE $${i} OR (m.first_name || ' ' || m.last_name) ILIKE $${i})`);
  }
  params.push(f.limit ?? 100);
  return query<any>(
    `SELECT c.id, c.code, c.type, c.status, c.label, c.expires_at, c.issued_at, c.last_seen_at, c.print_count, m.member_no, m.first_name, m.last_name, w.balance
       FROM credentials c LEFT JOIN members m ON m.id=c.member_id LEFT JOIN wallet_accounts w ON w.account_id=c.account_id
      WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC LIMIT $${params.length}`,
    params,
  );
}
