import { EVENTS, pointsFor, rooms } from '@kiosk/shared';
import { one, query, type Db, type Tx } from '../../db/pool';
import { badRequest, conflict, notFound } from '../../lib/errors';
import type { Outbox } from '../../lib/realtime';
import { getSettings } from '../../lib/settings';

export interface PointsPostInput {
  memberId: string;
  type: 'EARN' | 'REDEEM' | 'ADJUST' | 'EXPIRE' | 'REVERSE' | 'PAYMENT';
  points: number;
  reference?: string | null;
  refType?: string | null;
  refId?: string | null;
  branchId?: string | null;
  staffId?: string | null;
  idempotencyKey?: string | null;
  note?: string | null;
  /** Clamp a negative movement at the current balance instead of failing (used by reversals). */
  clamp?: boolean;
}

/** Points ledger with balance before/after; members.points is only changed here. */
export async function pointsPost(c: Tx, i: PointsPostInput) {
  if (!Number.isInteger(i.points) || i.points === 0) throw badRequest('INVALID_POINTS');
  if (i.idempotencyKey) {
    const dup = await one<any>(`SELECT * FROM points_ledger WHERE idempotency_key=$1`, [i.idempotencyKey], c);
    if (dup) return { entry: dup, replay: true };
  }
  const m = await one<any>(`SELECT id, points FROM members WHERE id=$1 FOR UPDATE`, [i.memberId], c);
  if (!m) throw notFound('Member');
  let pts = i.points;
  if (m.points + pts < 0) {
    if (!i.clamp) throw conflict('INSUFFICIENT_POINTS', `Only ${m.points} points available`);
    pts = -m.points;
    if (pts === 0) return { entry: null, replay: false };
  }
  const entry = await one<any>(
    `INSERT INTO points_ledger (member_id, type, points, balance_before, balance_after, reference, ref_type, ref_id, branch_id, staff_id, idempotency_key, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [m.id, i.type, pts, m.points, m.points + pts, i.reference ?? null, i.refType ?? null, i.refId ?? null, i.branchId ?? null, i.staffId ?? null, i.idempotencyKey ?? null, i.note ?? null],
    c,
  );
  await query(`UPDATE members SET points = points + $2 WHERE id=$1`, [m.id, pts], c);
  return { entry, replay: false };
}

/** Points for a set of amounts by category using the configured rules and the member's tier multiplier. */
export async function computeEarn(db: Db, memberId: string, amounts: Record<string, number>): Promise<number> {
  const s = await getSettings(db);
  if (!s.points.enabled) return 0;
  const mult = await pointMultiplier(db, memberId);
  let total = 0;
  for (const [cat, amount] of Object.entries(amounts)) {
    const rule = s.points.rules[cat];
    if (!rule?.enabled) continue;
    total += pointsFor(amount, rule.bahtPerPoint, mult);
  }
  return total;
}

export async function pointMultiplier(db: Db, memberId: string): Promise<number> {
  const r = await one<any>(
    `SELECT COALESCE(
        (SELECT b.value FROM memberships ms JOIN membership_benefits b ON b.product_id = ms.product_id AND b.type='POINT_MULTIPLIER'
          WHERE ms.member_id=$1 AND ms.status='ACTIVE' ORDER BY b.value DESC LIMIT 1),
        (SELECT mp.point_multiplier FROM memberships ms JOIN membership_products mp ON mp.id = ms.product_id
          WHERE ms.member_id=$1 AND ms.status='ACTIVE' ORDER BY mp.point_multiplier DESC LIMIT 1),
        1) AS m`,
    [memberId],
    db,
  );
  return Number(r?.m ?? 1) || 1;
}

export async function announcePoints(out: Outbox, db: Db, memberId: string) {
  const m = await one<any>(`SELECT account_id, points FROM members WHERE id=$1`, [memberId], db);
  if (m) out.add(rooms.account(m.account_id), EVENTS.POINTS_UPDATED, { memberId, points: m.points });
}
