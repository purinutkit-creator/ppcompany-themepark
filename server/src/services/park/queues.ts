import { EVENTS, estimateWait, rooms, type I18nText } from '@kiosk/shared';
import { one, query, tx, type Db, type Tx } from '../../db/pool';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { Outbox } from '../../lib/realtime';
import { branchToday, parkSettings } from './common';
import { credentialStatusReason, effectiveStatus, resolveScan } from './credentials';
import { memberHasBenefit } from './members';
import { notify } from './notifications';

async function position(db: Db, entry: any) {
  const r = await one<any>(
    `SELECT COUNT(*)::int AS ahead FROM ride_queues WHERE ride_id=$1 AND status='WAITING' AND service_date=$2
        AND (priority > $3 OR (priority = $3 AND seq < $4))`,
    [entry.ride_id, entry.service_date, entry.priority, entry.seq],
    db,
  );
  return r.ahead as number;
}

export async function queueStatus(db: Db, entry: any) {
  const ride = await one<any>(`SELECT id, code, name, capacity, duration_minutes, status FROM rides WHERE id=$1`, [entry.ride_id], db);
  const ahead = entry.status === 'WAITING' ? await position(db, entry) : 0;
  return {
    id: entry.id, queueNo: entry.queue_no, status: entry.status, partySize: entry.party_size, priority: entry.priority,
    ahead, waitMinutes: entry.status === 'WAITING' ? estimateWait(ahead + 1, ride.capacity, Number(ride.duration_minutes)) : 0,
    joinedAt: entry.joined_at, calledAt: entry.called_at, callExpiresAt: entry.call_expires_at,
    ride: { id: ride.id, code: ride.code, name: ride.name, status: ride.status },
  };
}

/** JOIN QUEUE: virtual queue number (A124) with people ahead and estimated wait. */
export async function joinQueue(rideId: string, a: { raw?: string | null; credentialId?: string | null; partySize?: number }) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const ride = await one<any>(`SELECT * FROM rides WHERE id=$1 FOR UPDATE`, [rideId], c);
    if (!ride) throw notFound('Ride');
    if (!ride.queue_enabled) throw conflict('QUEUE_DISABLED', 'This ride has no virtual queue');
    if (ride.status !== 'OPEN') throw conflict('RIDE_CLOSED', `Ride is ${ride.status}`);
    let cred: any;
    if (a.credentialId) cred = await one<any>(`SELECT * FROM credentials WHERE id=$1`, [a.credentialId], c);
    else {
      const res = await resolveScan(a.raw ?? '', c);
      if (!res.ok) throw conflict(res.reason!, 'Card / QR not valid');
      cred = res.credential;
    }
    if (!cred) throw notFound('Credential');
    const reason = credentialStatusReason(await effectiveStatus(c, cred));
    if (reason) throw conflict(reason, 'Card not active');
    const s = await parkSettings(ride.branch_id, c);
    const existing = await one<any>(`SELECT * FROM ride_queues WHERE ride_id=$1 AND credential_id=$2 AND status IN ('WAITING','CALLED')`, [rideId, cred.id], c);
    if (existing) return queueStatus(c, existing);
    const active = await one<any>(`SELECT COUNT(*)::int AS n FROM ride_queues WHERE credential_id=$1 AND status IN ('WAITING','CALLED')`, [cred.id], c);
    if (active.n >= s.rideQueue.maxActivePerGuest) throw conflict('QUEUE_LIMIT', `You can hold at most ${s.rideQueue.maxActivePerGuest} queue numbers`);
    const today = await branchToday(ride.branch_id, c);
    const seq = (await one<any>(`SELECT COALESCE(MAX(seq), 100) + 1 AS n FROM ride_queues WHERE ride_id=$1 AND service_date=$2`, [rideId, today], c)).n;
    // Priority queue for members with the benefit, or a fast pass on the card.
    let priority = 0;
    if (cred.member_id && (await memberHasBenefit(c, cred.member_id, 'PRIORITY_QUEUE'))) priority = 1;
    const fp = await one(`SELECT 1 FROM ride_entitlements WHERE is_fast_pass AND status='ACTIVE' AND (ride_id IS NULL OR ride_id=$1) AND (credential_id=$2 OR account_id=$3) AND (valid_until IS NULL OR valid_until > now())`, [rideId, cred.id, cred.account_id], c);
    if (fp) priority = 2;
    const e = await one<any>(
      `INSERT INTO ride_queues (branch_id, ride_id, service_date, seq, queue_no, credential_id, account_id, member_id, party_size, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [ride.branch_id, rideId, today, seq, `${ride.queue_prefix}${seq}`, cred.id, cred.account_id, cred.member_id, Math.min(20, Math.max(1, a.partySize ?? 1)), priority],
      c,
    );
    out.add([rooms.ride(rideId), rooms.branchRides(ride.branch_id), rooms.branchAdmin(ride.branch_id)], EVENTS.RIDE_QUEUE_UPDATED, { rideId });
    if (cred.account_id) out.add(rooms.account(cred.account_id), EVENTS.RIDE_QUEUE_UPDATED, { rideId, entryId: e.id });
    return queueStatus(c, e);
  });
  await out.flush();
  return r;
}

export async function leaveQueue(entryId: string, accountId: string | null) {
  const out = new Outbox();
  await tx(async (c) => {
    const e = await one<any>(`SELECT * FROM ride_queues WHERE id=$1 FOR UPDATE`, [entryId], c);
    if (!e) throw notFound('Queue entry');
    if (accountId && e.account_id !== accountId) throw notFound('Queue entry');
    if (!['WAITING', 'CALLED'].includes(e.status)) return;
    await query(`UPDATE ride_queues SET status='CANCELLED', ended_at=now() WHERE id=$1`, [entryId], c);
    out.add([rooms.ride(e.ride_id), rooms.branchRides(e.branch_id)], EVENTS.RIDE_QUEUE_UPDATED, { rideId: e.ride_id });
    if (e.account_id) out.add(rooms.account(e.account_id), EVENTS.RIDE_QUEUE_UPDATED, { rideId: e.ride_id, entryId });
  });
  await out.flush();
  return { ok: true };
}

/**
 * Call the next batch (default = ride capacity). Called guests get a realtime notification:
 * "ถึงคิวของคุณแล้ว กรุณาไปที่ <ride> ภายใน 10 นาที"; guests a few places away get a heads-up.
 */
export async function callNext(rideId: string, count?: number | null) {
  const out = new Outbox();
  const called = await tx(async (c) => {
    const ride = await one<any>(`SELECT * FROM rides WHERE id=$1 FOR UPDATE`, [rideId], c);
    if (!ride) throw notFound('Ride');
    const s = await parkSettings(ride.branch_id, c);
    const n = Math.max(1, Math.min(100, count ?? ride.capacity));
    const rows = await query<any>(
      `UPDATE ride_queues SET status='CALLED', called_at=now(), call_expires_at=now() + ($3 || ' minutes')::interval
        WHERE id IN (SELECT id FROM ride_queues WHERE ride_id=$1 AND status='WAITING' AND service_date=$2 ORDER BY priority DESC, seq LIMIT $4 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [rideId, await branchToday(ride.branch_id, c), String(s.rideQueue.callWindowMinutes), n],
      c,
    );
    const rideName: I18nText = ride.name;
    for (const e of rows) {
      if (!e.account_id) continue;
      await notify({
        audience: 'ACCOUNT', accountId: e.account_id, type: 'QUEUE_CALLED', severity: 'INFO', dedupeKey: `qcall:${e.id}`,
        title: { th: `ถึงคิวของคุณแล้ว (${e.queue_no})`, en: `It's your turn (${e.queue_no})`, zh: `轮到您了（${e.queue_no}）` },
        body: {
          th: `กรุณาไปที่ ${rideName.th ?? ride.code} ภายใน ${s.rideQueue.callWindowMinutes} นาที`,
          en: `Please go to ${rideName.en ?? ride.code} within ${s.rideQueue.callWindowMinutes} minutes`,
          zh: `请在 ${s.rideQueue.callWindowMinutes} 分钟内前往 ${rideName.zh ?? ride.code}`,
        },
        data: { rideId, entryId: e.id, queueNo: e.queue_no },
      }, c, out);
      out.add(rooms.account(e.account_id), EVENTS.QUEUE_CALLED, { rideId, entryId: e.id, queueNo: e.queue_no, rideName, expiresAt: e.call_expires_at });
    }
    // Heads-up for the next few in line.
    if (s.rideQueue.notifyWhenAhead > 0) {
      const next = await query<any>(`SELECT * FROM ride_queues WHERE ride_id=$1 AND status='WAITING' ORDER BY priority DESC, seq LIMIT $2`, [rideId, s.rideQueue.notifyWhenAhead], c);
      for (const e of next) {
        if (!e.account_id) continue;
        await notify({
          audience: 'ACCOUNT', accountId: e.account_id, type: 'QUEUE_SOON', severity: 'INFO', dedupeKey: `qsoon:${e.id}`,
          title: { th: `ใกล้ถึงคิวแล้ว (${e.queue_no})`, en: `Almost your turn (${e.queue_no})`, zh: `快轮到您了（${e.queue_no}）` },
          body: { th: `${rideName.th ?? ride.code}: เตรียมตัวได้เลย`, en: `${rideName.en ?? ride.code}: get ready`, zh: `${rideName.zh ?? ride.code}：请做好准备` },
          data: { rideId, entryId: e.id },
        }, c, out);
      }
    }
    out.add([rooms.ride(rideId), rooms.branchRides(ride.branch_id), rooms.branchAdmin(ride.branch_id)], EVENTS.RIDE_QUEUE_UPDATED, { rideId, called: rows.map((r) => r.queue_no) });
    return rows;
  });
  await out.flush();
  return called;
}

export async function rideQueueList(db: Db, rideId: string) {
  const ride = await one<any>(`SELECT id, capacity, duration_minutes FROM rides WHERE id=$1`, [rideId], db);
  if (!ride) throw notFound('Ride');
  const rows = await query<any>(
    `SELECT q.*, c.code AS credential_code, m.first_name, m.member_no FROM ride_queues q LEFT JOIN credentials c ON c.id=q.credential_id LEFT JOIN members m ON m.id=q.member_id
      WHERE q.ride_id=$1 AND (q.status IN ('WAITING','CALLED') OR q.ended_at > now() - interval '30 minutes') ORDER BY CASE q.status WHEN 'CALLED' THEN 0 WHEN 'WAITING' THEN 1 ELSE 2 END, q.priority DESC, q.seq`,
    [rideId],
    db,
  );
  let ahead = 0;
  return rows.map((r) => {
    const w = r.status === 'WAITING' ? estimateWait(++ahead, ride.capacity, Number(ride.duration_minutes)) : 0;
    return { ...r, position: r.status === 'WAITING' ? ahead : null, wait_minutes: w };
  });
}

export async function accountQueues(db: Db, accountId: string) {
  const rows = await query<any>(`SELECT * FROM ride_queues WHERE account_id=$1 AND status IN ('WAITING','CALLED') ORDER BY joined_at`, [accountId], db);
  return Promise.all(rows.map((r) => queueStatus(db, r)));
}

/** Background: called numbers that never showed up expire; old waiting entries close at day end. */
export async function queueMaintenance() {
  const expired = await query<any>(`UPDATE ride_queues SET status='NO_SHOW', ended_at=now() WHERE status='CALLED' AND call_expires_at < now() RETURNING ride_id, branch_id, account_id, id`);
  await query(
    `UPDATE ride_queues q SET status='EXPIRED', ended_at=now() FROM branches b WHERE b.id=q.branch_id AND q.status IN ('WAITING','CALLED') AND q.service_date < (now() AT TIME ZONE b.timezone)::date`,
  );
  const out = new Outbox();
  for (const e of expired) {
    out.add([rooms.ride(e.ride_id), rooms.branchRides(e.branch_id)], EVENTS.RIDE_QUEUE_UPDATED, { rideId: e.ride_id });
    if (e.account_id) out.add(rooms.account(e.account_id), EVENTS.RIDE_QUEUE_UPDATED, { rideId: e.ride_id, entryId: e.id, status: 'NO_SHOW' });
  }
  await out.flush();
  // Queue-too-long alerts.
  const rides = await query<any>(
    `SELECT r.id, r.branch_id, r.code, r.name, r.capacity, r.duration_minutes, COUNT(q.id)::int AS waiting FROM rides r JOIN ride_queues q ON q.ride_id=r.id AND q.status='WAITING'
      GROUP BY r.id`,
  );
  for (const r of rides) {
    const s = await parkSettings(r.branch_id);
    const wait = estimateWait(r.waiting, r.capacity, Number(r.duration_minutes));
    if (wait >= s.notification.queueTooLongMinutes) {
      await notify({
        audience: 'STAFF', branchId: r.branch_id, type: 'QUEUE_TOO_LONG', severity: 'WARNING', dedupeKey: `qlong:${r.id}:${new Date().toISOString().slice(0, 13)}`,
        title: { th: `คิว ${r.name.th ?? r.code} ยาว ${wait} นาที`, en: `${r.name.en ?? r.code} queue is ${wait} min`, zh: `${r.name.zh ?? r.code} 排队 ${wait} 分钟` },
        body: { th: `${r.waiting} คนรอคิว`, en: `${r.waiting} guests waiting`, zh: `${r.waiting} 人排队` },
        data: { rideId: r.id, wait },
      });
    }
  }
}

export function assertPartySize(n: number) {
  if (!Number.isInteger(n) || n < 1 || n > 20) throw badRequest('INVALID_PARTY_SIZE');
}

export type { Tx };
