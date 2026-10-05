import { EVENTS, rooms } from '@kiosk/shared';
import { one, query, tx, type Tx } from '../db/pool';
import { conflict, notFound } from '../lib/errors';
import { Outbox } from '../lib/realtime';
import { getSettings } from '../lib/settings';
import { addOrderEvent, broadcastOrder, emitQueue, type Actor } from './orders';

/** Split a confirmed order into one kitchen order per station (idempotent). */
export async function sendToKitchen(c: Tx, order: any, out: Outbox) {
  const stations = await query<any>(`SELECT DISTINCT station_id FROM order_items WHERE order_id=$1 AND station_id IS NOT NULL`, [order.id], c);
  for (const s of stations) {
    await query(
      `INSERT INTO kitchen_orders (order_id, branch_id, station_id) VALUES ($1,$2,$3) ON CONFLICT (order_id, station_id) DO NOTHING`,
      [order.id, order.branch_id, s.station_id],
      c,
    );
  }
  await query(`UPDATE orders SET status='NEW' WHERE id=$1 AND status='CONFIRMED'`, [order.id], c);
  await query(`UPDATE queue_numbers SET status='PREPARING' WHERE order_id=$1 AND active`, [order.id], c);
  await addOrderEvent(c, order.id, 'KITCHEN_RECEIVED', { stations: stations.length }, { type: 'SYSTEM' });
  out.add(rooms.branchKitchen(order.branch_id), EVENTS.KITCHEN_NEW, { orderId: order.id, orderNumber: order.order_number });
  emitQueue(out, order.branch_id);
}

export async function listKitchen(branchId: string, stationId?: string | null) {
  const s = await getSettings();
  const rows = await query<any>(
    `SELECT ko.id, ko.order_id, ko.station_id, ko.status, ko.created_at, ko.started_at, ko.ready_at,
            ks.name AS station_name, ks.code AS station_code, ks.color AS station_color,
            o.order_number, o.order_type, o.note, o.paid_at, o.created_at AS order_created_at, k.code AS kiosk_code,
            COALESCE((SELECT json_agg(json_build_object('id', oi.id, 'name', oi.name, 'qty', oi.qty, 'special_request', oi.special_request,
                'modifiers', COALESCE((SELECT json_agg(json_build_object('name', m.name, 'kind', m.kind)) FROM order_item_modifiers m WHERE m.order_item_id=oi.id), '[]'))
                ORDER BY oi.sort)
               FROM order_items oi WHERE oi.order_id=ko.order_id AND oi.station_id=ko.station_id), '[]') AS items
       FROM kitchen_orders ko
       JOIN orders o ON o.id=ko.order_id
       JOIN kitchen_stations ks ON ks.id=ko.station_id
       LEFT JOIN kiosks k ON k.id=o.kiosk_id
      WHERE ko.branch_id=$1 AND ($2::uuid IS NULL OR ko.station_id=$2)
        AND (ko.status IN ('NEW','PREPARING') OR (ko.status='READY' AND ko.ready_at > now() - interval '30 minutes'))
      ORDER BY CASE ko.status WHEN 'READY' THEN 1 ELSE 0 END, COALESCE(o.paid_at, o.created_at)`,
    [branchId, stationId ?? null],
  );
  return { orders: rows, warnMinutes: s.kitchen.warnMinutes, lateMinutes: s.kitchen.lateMinutes };
}

/** Recompute order/queue status from its station tickets after a kitchen action. */
async function syncOrderFromKitchen(c: Tx, orderId: string, out: Outbox, actor: Actor) {
  const o = await one<any>(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId], c);
  if (!o || ['COMPLETED', 'CANCELLED', 'REFUNDED'].includes(o.status)) return;
  const ks = await query<any>(`SELECT status FROM kitchen_orders WHERE order_id=$1 AND status <> 'CANCELLED'`, [orderId], c);
  const allReady = ks.length > 0 && ks.every((k) => k.status === 'READY' || k.status === 'DONE');
  const anyStarted = ks.some((k) => k.status !== 'NEW');
  const next = allReady ? 'READY' : anyStarted ? 'PREPARING' : 'NEW';
  if (next === o.status) return;
  await query(
    `UPDATE orders SET status=$2, preparing_at = CASE WHEN $2='PREPARING' AND preparing_at IS NULL THEN now() ELSE preparing_at END,
       ready_at = CASE WHEN $2='READY' THEN now() ELSE NULL END, version=version+1 WHERE id=$1`,
    [orderId, next],
    c,
  );
  await query(`UPDATE queue_numbers SET status=$2 WHERE order_id=$1 AND active`, [orderId, next === 'READY' ? 'READY' : 'PREPARING'], c);
  await addOrderEvent(c, orderId, next, {}, actor);
  await broadcastOrder(out, orderId, c, next === 'READY' ? EVENTS.ORDER_READY : EVENTS.ORDER_UPDATED);
  if (next === 'READY') emitQueue(out, o.branch_id, { event: EVENTS.ORDER_READY, data: { orderId, orderNumber: o.order_number, language: o.language } });
  else emitQueue(out, o.branch_id);
}

async function transition(kitchenOrderId: string, from: string[], to: 'PREPARING' | 'READY' | 'NEW', actor: Actor) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    const ko = await one<any>(`SELECT * FROM kitchen_orders WHERE id=$1 FOR UPDATE`, [kitchenOrderId], c);
    if (!ko) throw notFound('Kitchen order');
    if (ko.status === to) return ko;
    if (!from.includes(ko.status)) throw conflict('INVALID_STATUS', `Cannot move from ${ko.status} to ${to}`);
    await query(
      `UPDATE kitchen_orders SET status=$2,
         started_at = CASE WHEN $2='PREPARING' AND started_at IS NULL THEN now() ELSE started_at END,
         started_by = CASE WHEN $2='PREPARING' THEN $3::uuid ELSE started_by END,
         ready_at = CASE WHEN $2='READY' THEN now() ELSE NULL END WHERE id=$1`,
      [kitchenOrderId, to, actor.type === 'STAFF' ? actor.id : null],
      c,
    );
    const evt = to === 'PREPARING' ? EVENTS.KITCHEN_PREPARING : EVENTS.KITCHEN_UPDATED;
    out.add(rooms.branchKitchen(ko.branch_id), evt, { kitchenOrderId, orderId: ko.order_id, status: to });
    await syncOrderFromKitchen(c, ko.order_id, out, actor);
    return { ...ko, status: to };
  });
  await out.flush();
  return r;
}

export const startKitchenOrder = (id: string, actor: Actor) => transition(id, ['NEW'], 'PREPARING', actor);
export const doneKitchenOrder = (id: string, actor: Actor) => transition(id, ['NEW', 'PREPARING'], 'READY', actor);
export const recallKitchenOrder = (id: string, actor: Actor) => transition(id, ['READY'], 'PREPARING', actor);
