import { EVENTS, rooms, type I18nText } from '@kiosk/shared';
import { one, query, type Db } from '../../db/pool';
import { Outbox, publish } from '../../lib/realtime';

export interface NotifyInput {
  audience: 'STAFF' | 'ACCOUNT';
  branchId?: string | null;
  accountId?: string | null;
  type: string;
  severity?: 'INFO' | 'WARNING' | 'CRITICAL';
  title: I18nText;
  body?: I18nText;
  data?: Record<string, unknown>;
  /** Same key → stored once (prevents alert storms, e.g. "Gate 06 offline"). */
  dedupeKey?: string | null;
}

/**
 * Persist a notification and push it in real time — staff notifications go to the branch admin / counter /
 * gate rooms, customer notifications to the account room (portal, kiosk). Pass an Outbox to publish only
 * after the surrounding transaction commits.
 */
export async function notify(n: NotifyInput, db?: Db, out?: Outbox) {
  const row = await one<any>(
    `INSERT INTO notifications (branch_id, audience, account_id, type, severity, title, body, data, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    [n.branchId ?? null, n.audience, n.accountId ?? null, n.type, n.severity ?? 'INFO', n.title, n.body ?? {}, n.data ?? {}, n.dedupeKey ?? null],
    db,
  );
  if (!row) return null;
  const targets =
    n.audience === 'ACCOUNT'
      ? [rooms.account(n.accountId!)]
      : n.branchId
        ? [rooms.branchAdmin(n.branchId), rooms.branchCounter(n.branchId), rooms.branchGates(n.branchId), rooms.branchRides(n.branchId)]
        : [rooms.global];
  if (out) out.add(targets, EVENTS.NOTIFICATION, row);
  else await publish(targets, EVENTS.NOTIFICATION, row);
  return row;
}

export async function listStaffNotifications(branchId: string, opts: { unread?: boolean; limit?: number }) {
  return query<any>(
    `SELECT n.*, u.name AS read_by_name FROM notifications n LEFT JOIN users u ON u.id=n.read_by
      WHERE n.audience='STAFF' AND (n.branch_id=$1 OR n.branch_id IS NULL) AND ($2::boolean IS NOT TRUE OR n.read_at IS NULL)
      ORDER BY n.created_at DESC LIMIT $3`,
    [branchId, opts.unread ?? false, opts.limit ?? 100],
  );
}
