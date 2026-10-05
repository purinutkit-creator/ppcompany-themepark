import type { FastifyInstance, FastifyRequest } from 'fastify';
import { EVENTS, rooms } from '@kiosk/shared';
import { one, query } from '../db/pool';
import { audit } from '../lib/audit';
import { branchOf, requireStaff } from '../lib/auth';
import { forbidden, notFound } from '../lib/errors';
import { publish } from '../lib/realtime';
import { i18n, parse, uuid, z } from '../lib/validate';
import { doneKitchenOrder, listKitchen, recallKitchenOrder, startKitchenOrder } from '../services/kitchen';
import { completeOrder } from '../services/orders';
import { queueBoard } from './public';

async function checkBranch(req: FastifyRequest, kitchenOrderId: string) {
  const ko = await one<any>(`SELECT branch_id FROM kitchen_orders WHERE id=$1`, [kitchenOrderId]);
  if (!ko) throw notFound('Kitchen order');
  if (req.staff!.branchId && ko.branch_id !== req.staff!.branchId) throw forbidden('OTHER_BRANCH');
}

const stationSchema = z.object({
  code: z.string().min(1).max(30),
  name: i18n,
  color: z.string().max(20).default('#f97316'),
  sort: z.number().int().default(0),
  is_default: z.boolean().default(false),
  is_active: z.boolean().default(true),
});

export default async function kitchenRoutes(app: FastifyInstance) {
  app.get('/orders', { preHandler: requireStaff('kitchen.view') }, async (req) => {
    const q = parse(z.object({ stationId: uuid.optional() }), req.query);
    return listKitchen(branchOf(req), q.stationId);
  });

  const actor = (req: FastifyRequest) => ({ type: 'STAFF' as const, id: req.staff!.id, name: req.staff!.name });
  app.post('/orders/:id/start', { preHandler: requireStaff('kitchen.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await checkBranch(req, id);
    return startKitchenOrder(id, actor(req));
  });
  app.post('/orders/:id/done', { preHandler: requireStaff('kitchen.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await checkBranch(req, id);
    return doneKitchenOrder(id, actor(req));
  });
  app.post('/orders/:id/recall', { preHandler: requireStaff('kitchen.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await checkBranch(req, id);
    return recallKitchenOrder(id, actor(req));
  });
  /** Bump: customer collected — completes the whole order. */
  app.post('/orders/:id/pickup', { preHandler: requireStaff('kitchen.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await checkBranch(req, id);
    const ko = await one<any>(`SELECT order_id FROM kitchen_orders WHERE id=$1`, [id]);
    await completeOrder(ko.order_id, actor(req));
    return { ok: true };
  });

  app.get('/queue', { preHandler: requireStaff('kitchen.view') }, async (req) => queueBoard(branchOf(req)));

  // ---- stations
  app.get('/stations', { preHandler: requireStaff() }, async (req) =>
    query(`SELECT s.*, (SELECT json_agg(json_build_object('id', p.id, 'name', p.name)) FROM printers p WHERE p.station_id=s.id) AS printers
             FROM kitchen_stations s WHERE branch_id=$1 ORDER BY sort, code`, [branchOf(req)]),
  );
  app.post('/stations', { preHandler: requireStaff('kitchen.stations') }, async (req) => {
    const b = parse(stationSchema, req.body);
    const branchId = branchOf(req);
    if (b.is_default) await query(`UPDATE kitchen_stations SET is_default=false WHERE branch_id=$1`, [branchId]);
    const row = await one(
      `INSERT INTO kitchen_stations (branch_id, code, name, color, sort, is_default, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [branchId, b.code, b.name, b.color, b.sort, b.is_default, b.is_active],
    );
    await audit(req, { action: 'STATION_CREATE', entity: 'kitchen_station', entityId: (row as any).id, newValue: row });
    return row;
  });
  app.put('/stations/:id', { preHandler: requireStaff('kitchen.stations') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(stationSchema, req.body);
    const old = await one<any>(`SELECT * FROM kitchen_stations WHERE id=$1`, [id]);
    if (!old) throw notFound('Station');
    if (b.is_default) await query(`UPDATE kitchen_stations SET is_default=false WHERE branch_id=$1 AND id<>$2`, [old.branch_id, id]);
    const row = await one(
      `UPDATE kitchen_stations SET code=$2, name=$3, color=$4, sort=$5, is_default=$6, is_active=$7 WHERE id=$1 RETURNING *`,
      [id, b.code, b.name, b.color, b.sort, b.is_default, b.is_active],
    );
    await audit(req, { action: 'STATION_UPDATE', entity: 'kitchen_station', entityId: id, oldValue: old, newValue: row });
    await publish(rooms.branchKitchen(old.branch_id), EVENTS.KITCHEN_UPDATED, {});
    return row;
  });
  app.delete('/stations/:id', { preHandler: requireStaff('kitchen.stations') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const old = await one<any>(`DELETE FROM kitchen_stations WHERE id=$1 RETURNING *`, [id]);
    await audit(req, { action: 'STATION_DELETE', entity: 'kitchen_station', entityId: id, oldValue: old });
    return { ok: true };
  });
}
