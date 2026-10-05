import type { FastifyInstance } from 'fastify';
import { one, query } from '../db/pool';
import { notFound } from '../lib/errors';
import { getSettings } from '../lib/settings';
import { parse, z, uuid } from '../lib/validate';

export async function queueBoard(branchId: string) {
  const s = await getSettings();
  const rows = await query<any>(
    `SELECT q.number, q.status, q.order_id, q.call_count, q.last_called_at, o.ready_at, o.paid_at, o.order_type
       FROM queue_numbers q JOIN orders o ON o.id=q.order_id
      WHERE q.branch_id=$1 AND q.active AND q.status IN ('PREPARING','READY')
      ORDER BY CASE WHEN q.status='READY' THEN o.ready_at END DESC NULLS LAST, o.paid_at ASC`,
    [branchId],
  );
  return {
    preparing: rows.filter((r) => r.status === 'PREPARING').slice(0, s.queue.preparingCount),
    ready: rows.filter((r) => r.status === 'READY').slice(0, s.queue.readyCount),
    totals: { preparing: rows.filter((r) => r.status === 'PREPARING').length, ready: rows.filter((r) => r.status === 'READY').length },
  };
}

export default async function publicRoutes(app: FastifyInstance) {
  app.get('/branches', async () => query(`SELECT id, code, name FROM branches WHERE is_active ORDER BY code`));

  /** Customer queue display (TV). Exposes only queue numbers — no customer data. */
  app.get('/queue/:branchCode', async (req) => {
    const { branchCode } = parse(z.object({ branchCode: z.string().max(40) }), req.params);
    const b = await one<any>(`SELECT id, code, name, timezone FROM branches WHERE code=$1 AND is_active`, [branchCode]);
    if (!b) throw notFound('Branch');
    const s = await getSettings();
    const fonts = await query(`SELECT id, family, source, file_url, format, weights FROM fonts`);
    return { branch: b, board: await queueBoard(b.id), settings: { queue: s.queue, store: s.store, theme: s.theme, fonts: s.fonts }, fonts };
  });

  /** Receipt QR lookup: order status for the customer. */
  app.get('/orders/:id', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const o = await one<any>(
      `SELECT o.id, o.order_number, o.order_type, o.status, o.payment_status, o.total, o.created_at, o.paid_at, o.ready_at, o.completed_at,
              b.name AS branch_name,
              (SELECT json_agg(json_build_object('name', name, 'qty', qty, 'total', line_total) ORDER BY sort) FROM order_items WHERE order_id=o.id) AS items
         FROM orders o JOIN branches b ON b.id=o.branch_id WHERE o.id=$1`,
      [id],
    );
    if (!o) throw notFound('Order');
    return o;
  });
}
