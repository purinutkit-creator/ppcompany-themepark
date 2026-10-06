import { EVENTS, rooms } from '@kiosk/shared';
import { one, query, tx, type Tx } from '../../db/pool';
import { conflict, notFound } from '../../lib/errors';
import { Outbox } from '../../lib/realtime';
import { parkSettings } from './common';
import { credentialStatusReason, effectiveStatus, resolveScan, touchCredential } from './credentials';
import { lockerController } from './hardware';

/** Called by the sale engine when a LOCKER line is paid: assign a locker and start the rental. */
export async function startLockerSessionTx(c: Tx, a: { sale: any; item: any; credentialId: string | null }, out: Outbox) {
  const meta = a.item.meta ?? {};
  const existing = await one<any>(`SELECT * FROM locker_sessions WHERE sale_item_id=$1`, [a.item.id], c);
  if (existing) return existing;
  let locker: any = null;
  if (meta.lockerId) locker = await one<any>(`SELECT * FROM lockers WHERE id=$1 AND status='AVAILABLE' AND is_active FOR UPDATE SKIP LOCKED`, [meta.lockerId], c);
  if (!locker) {
    locker = await one<any>(
      `SELECT * FROM lockers WHERE branch_id=$1 AND status='AVAILABLE' AND is_active AND ($2::text IS NULL OR size=$2) ORDER BY bank, code LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [a.sale.branch_id, meta.size ?? null],
      c,
    );
  }
  if (!locker) throw conflict('NO_LOCKER_AVAILABLE', 'No locker available');
  const cred = a.credentialId ? await one<any>(`SELECT * FROM credentials WHERE id=$1`, [a.credentialId], c) : null;
  const expire = meta.minutes
    ? (await one<any>(`SELECT now() + ($1 || ' minutes')::interval AS e`, [String(meta.minutes)], c)).e
    : (await one<any>(`SELECT ((now() AT TIME ZONE b.timezone)::date + 1)::timestamp AT TIME ZONE b.timezone AS e FROM branches b WHERE b.id=$1`, [a.sale.branch_id], c)).e;
  const s = await one<any>(
    `INSERT INTO locker_sessions (locker_id, credential_id, account_id, member_id, sale_id, sale_item_id, rate_id, expire_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [locker.id, cred?.id ?? null, cred?.account_id ?? a.sale.account_id, cred?.member_id ?? a.sale.member_id, a.sale.id, a.item.id, a.item.ref_id, expire, a.sale.created_by],
    c,
  );
  await query(`UPDATE lockers SET status='OCCUPIED' WHERE id=$1`, [locker.id], c);
  await query(`UPDATE sale_items SET meta = meta || jsonb_build_object('lockerId', $2::text, 'lockerCode', $3::text) WHERE id=$1`, [a.item.id, locker.id, locker.code], c);
  out.add([rooms.locker(a.sale.branch_id), rooms.branchAdmin(a.sale.branch_id)], EVENTS.LOCKER_UPDATED, { lockerId: locker.id, code: locker.code, status: 'OCCUPIED', sessionId: s.id });
  if (s.account_id) out.add(rooms.account(s.account_id), EVENTS.LOCKER_UPDATED, { lockerId: locker.id, code: locker.code, status: 'OCCUPIED', expireAt: s.expire_at });
  return s;
}

export async function endLockerSessionTx(c: Tx, sessionId: string, status: 'ENDED' | 'EXPIRED' | 'FORCE_OPENED', out: Outbox) {
  const s = await one<any>(`UPDATE locker_sessions SET status=$2, ended_at=now() WHERE id=$1 AND status='ACTIVE' RETURNING *`, [sessionId, status], c);
  if (!s) return null;
  const l = await one<any>(`UPDATE lockers SET status = CASE WHEN status='OCCUPIED' THEN 'AVAILABLE' ELSE status END WHERE id=$1 RETURNING *`, [s.locker_id], c);
  out.add([rooms.locker(l.branch_id), rooms.branchAdmin(l.branch_id)], EVENTS.LOCKER_UPDATED, { lockerId: l.id, code: l.code, status: l.status });
  if (s.account_id) out.add(rooms.account(s.account_id), EVENTS.LOCKER_UPDATED, { lockerId: l.id, code: l.code, status: 'RELEASED' });
  return s;
}

/** Customer scans the same wristband at the locker bank → open their locker. */
export async function openLockerByScan(branchId: string, raw: string, ctx: { deviceId?: string | null; release?: boolean }) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const res = await resolveScan(raw, c);
    if (!res.ok) return { ok: false, reason: res.reason };
    const cred = res.credential;
    const st = await effectiveStatus(c, cred);
    const reason = credentialStatusReason(st);
    if (reason) return { ok: false, reason };
    const s = await one<any>(
      `SELECT s.*, l.code, l.driver, l.controller_config, l.branch_id, l.bank FROM locker_sessions s JOIN lockers l ON l.id=s.locker_id
        WHERE s.status='ACTIVE' AND l.branch_id=$2 AND (s.credential_id=$1 OR (s.credential_id IS NULL AND s.account_id=$3)) ORDER BY s.start_at DESC LIMIT 1 FOR UPDATE OF s`,
      [cred.id, branchId, cred.account_id],
      c,
    );
    if (!s) {
      return { ok: false, reason: 'LOCKER_NOT_FOUND' };
    }
    const settings = await parkSettings(branchId, c);
    if (new Date(s.expire_at) < new Date() && settings.locker.overtimePolicy === 'REQUIRE_EXTENSION') {
      await query(`INSERT INTO locker_access_logs (locker_id, session_id, credential_id, action, reason) VALUES ($1,$2,$3,'DENIED','EXPIRED')`, [s.locker_id, s.id, cred.id], c);
      return { ok: false, reason: 'LOCKER_EXPIRED', locker: { id: s.locker_id, code: s.code }, expireAt: s.expire_at };
    }
    await query(`UPDATE locker_sessions SET open_count=open_count+1, last_opened_at=now() WHERE id=$1`, [s.id], c);
    await query(`INSERT INTO locker_access_logs (locker_id, session_id, credential_id, action) VALUES ($1,$2,$3,$4)`, [s.locker_id, s.id, cred.id, ctx.release ? 'RELEASE' : 'OPEN'], c);
    await touchCredential(c, cred.id, null);
    if (ctx.release) await endLockerSessionTx(c, s.id, 'ENDED', out);
    return { ok: true, locker: { id: s.locker_id, code: s.code, bank: s.bank, driver: s.driver, controller_config: s.controller_config, branch_id: s.branch_id }, expireAt: s.expire_at, released: !!ctx.release };
  });
  await out.flush();
  if (r.ok && r.locker) {
    const cmd = await lockerController(r.locker.driver).open({ id: r.locker.id, code: r.locker.code, driver: r.locker.driver, controller_config: r.locker.controller_config, branch_id: r.locker.branch_id });
    if (!cmd.ok) return { ...r, ok: false, reason: 'LOCKER_CONTROLLER_ERROR', error: cmd.error };
  }
  return r;
}

export async function forceOpenLocker(lockerId: string, staffId: string, release: boolean) {
  const out = new Outbox();
  const l = await tx(async (c) => {
    const l = await one<any>(`SELECT * FROM lockers WHERE id=$1 FOR UPDATE`, [lockerId], c);
    if (!l) throw notFound('Locker');
    const s = await one<any>(`SELECT * FROM locker_sessions WHERE locker_id=$1 AND status='ACTIVE'`, [lockerId], c);
    await query(`INSERT INTO locker_access_logs (locker_id, session_id, action, staff_id) VALUES ($1,$2,'FORCE_OPEN',$3)`, [lockerId, s?.id ?? null, staffId], c);
    if (s && release) await endLockerSessionTx(c, s.id, 'FORCE_OPENED', out);
    return l;
  });
  await out.flush();
  return lockerController(l.driver).open(l);
}

/** Background: expired rentals at end of day are released (configurable). */
export async function lockerMaintenance() {
  const rows = await query<any>(
    `SELECT s.id FROM locker_sessions s JOIN lockers l ON l.id=s.locker_id JOIN branches b ON b.id=l.branch_id
      WHERE s.status='ACTIVE' AND s.expire_at < now() - interval '30 minutes' LIMIT 200`,
  );
  for (const r of rows) {
    const out = new Outbox();
    await tx((c) => endLockerSessionTx(c, r.id, 'EXPIRED', out));
    await out.flush();
  }
  return rows.length;
}
