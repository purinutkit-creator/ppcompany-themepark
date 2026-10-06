import crypto from 'node:crypto';
import { EVENTS, rooms } from '@kiosk/shared';
import { one, query, tx } from '../../db/pool';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { Outbox } from '../../lib/realtime';
import { branchInfo, genRedemptionNo } from './common';
import { dayBounds } from './entitlements';
import { announcePoints, pointsPost } from './points';
import { announceWallet, walletPost } from './wallet';

export async function listRewards(memberId: string | null) {
  const m = memberId ? await one<any>(`SELECT tier_id, points FROM members WHERE id=$1`, [memberId]) : null;
  const rows = await query<any>(
    `SELECT r.*, (SELECT COUNT(*)::int FROM reward_redemptions x WHERE x.reward_id=r.id AND x.member_id=$1 AND x.status <> 'CANCELLED') AS redeemed_by_me
       FROM rewards r WHERE r.is_active AND (r.start_at IS NULL OR r.start_at <= now()) AND (r.end_at IS NULL OR r.end_at >= now()) ORDER BY r.sort, r.points_required`,
    [memberId],
  );
  return rows.map((r) => {
    const tierOk = !r.tier_ids?.length || (m?.tier_id && r.tier_ids.includes(m.tier_id));
    const stockOk = r.stock == null || r.stock > 0;
    const limitOk = r.per_member_limit == null || r.redeemed_by_me < r.per_member_limit;
    return { ...r, eligible: !!m && tierOk && stockOk && limitOk && m.points >= r.points_required, reason: !m ? 'LOGIN' : !tierOk ? 'TIER' : !stockOk ? 'OUT_OF_STOCK' : !limitOk ? 'LIMIT' : m.points < r.points_required ? 'POINTS' : null };
  });
}

/** Redeem points → reward voucher (coupon), ride entitlement, or wallet credit. Idempotent. */
export async function redeemReward(memberId: string, rewardId: string, idempotencyKey: string, branchId: string | null) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const dup = await one<any>(`SELECT * FROM reward_redemptions WHERE idempotency_key=$1`, [idempotencyKey], c);
    if (dup) return dup;
    const reward = await one<any>(`SELECT * FROM rewards WHERE id=$1 FOR UPDATE`, [rewardId], c);
    if (!reward || !reward.is_active) throw notFound('Reward');
    if ((reward.start_at && new Date(reward.start_at) > new Date()) || (reward.end_at && new Date(reward.end_at) < new Date())) throw conflict('REWARD_NOT_AVAILABLE');
    const m = await one<any>(`SELECT * FROM members WHERE id=$1`, [memberId], c);
    if (!m || m.status !== 'ACTIVE') throw notFound('Member');
    if (reward.tier_ids?.length && !reward.tier_ids.includes(m.tier_id)) throw forbidden('TIER_REQUIRED', 'Your tier cannot redeem this reward');
    if (reward.stock != null && reward.stock <= 0) throw conflict('OUT_OF_STOCK', 'Reward is out of stock');
    if (reward.per_member_limit != null) {
      const n = await one<any>(`SELECT COUNT(*)::int AS n FROM reward_redemptions WHERE reward_id=$1 AND member_id=$2 AND status <> 'CANCELLED'`, [rewardId, memberId], c);
      if (n.n >= reward.per_member_limit) throw conflict('LIMIT_REACHED', 'Redemption limit reached');
    }
    const bId = branchId ?? m.home_branch_id ?? (await one<any>(`SELECT id FROM branches WHERE is_active ORDER BY created_at LIMIT 1`, [], c)).id;
    const b = await branchInfo(bId, c);
    const today = (await one<any>(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [b.timezone], c)).d;
    await pointsPost(c, { memberId, type: 'REDEEM', points: -reward.points_required, reference: reward.code, refType: 'REWARD', refId: reward.id, branchId: bId, idempotencyKey: `reward:${idempotencyKey}` });
    if (reward.stock != null) await query(`UPDATE rewards SET stock = stock - 1 WHERE id=$1`, [rewardId], c);
    const expires = (await one<any>(`SELECT now() + ($1 || ' days')::interval AS e`, [String(reward.valid_days)], c)).e;
    let couponId: string | null = null;
    let entitlementId: string | null = null;
    let voucher: string | null = null;
    if (reward.reward_type === 'RIDE') {
      const { end } = await dayBounds(c, today, (await one<any>(`SELECT ($1::date + $2::int)::text AS d`, [today, reward.valid_days], c)).d, b.timezone);
      const e = await one<any>(
        `INSERT INTO ride_entitlements (account_id, member_id, branch_id, ride_id, type, uses_total, uses_left, valid_from, valid_until, source)
         VALUES ($1,$2,$3,$4,'ONE_TIME',1,1,now(),$5,'REWARD') RETURNING id`,
        [m.account_id, memberId, bId, reward.ref_id, end],
        c,
      );
      entitlementId = e.id;
    } else if (reward.reward_type === 'WALLET_CREDIT') {
      await walletPost(c, { accountId: m.account_id, type: 'BONUS', amount: Number(reward.value), bonus: true, branchId: bId, memberId, reference: reward.code, refType: 'REWARD', refId: reward.id, idempotencyKey: `reward-credit:${idempotencyKey}` });
      await announceWallet(out, c, m.account_id, bId, { reason: 'REWARD' });
    } else {
      if (!reward.ref_id) throw conflict('REWARD_MISCONFIGURED', 'Reward has no promotion attached');
      voucher = `RW${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const cp = await one<any>(
        `INSERT INTO coupons (code, promotion_id, member_id, max_uses, valid_from, valid_to, source) VALUES ($1,$2,$3,1,$4,$5::date,'REWARD') RETURNING id`,
        [voucher, reward.ref_id, memberId, today, expires],
        c,
      );
      couponId = cp.id;
    }
    const red = await one<any>(
      `INSERT INTO reward_redemptions (redemption_no, reward_id, member_id, points, coupon_id, entitlement_id, voucher_code, expires_at, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [await genRedemptionNo(c, today), rewardId, memberId, reward.points_required, couponId, entitlementId, voucher, expires, idempotencyKey],
      c,
    );
    await announcePoints(out, c, memberId);
    out.add(rooms.account(m.account_id), EVENTS.MEMBER_UPDATED, { memberId, reason: 'REWARD_REDEEMED' });
    return red;
  });
  await out.flush();
  return r;
}

export async function memberRedemptions(memberId: string) {
  return query<any>(
    `SELECT x.*, r.name AS reward_name, r.reward_type, r.image_url, c.status AS coupon_status, c.used_count
       FROM reward_redemptions x JOIN rewards r ON r.id=x.reward_id LEFT JOIN coupons c ON c.id=x.coupon_id WHERE x.member_id=$1 ORDER BY x.created_at DESC LIMIT 100`,
    [memberId],
  );
}
