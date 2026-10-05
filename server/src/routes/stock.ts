import type { FastifyInstance } from 'fastify';
import { query, tx } from '../db/pool';
import { audit } from '../lib/audit';
import { branchOf, requireStaff } from '../lib/auth';
import { Outbox } from '../lib/realtime';
import { parse, uuid, z } from '../lib/validate';
import { adjustStock } from '../services/stock';

export default async function stockRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requireStaff('stock.view') }, async (req) => {
    const branchId = branchOf(req);
    return query(
      `SELECT p.id AS product_id, p.sku, p.status, p.track_stock, p.image_url, p.category_id,
              (SELECT name FROM product_translations t WHERE t.product_id=p.id AND t.lang='th') AS name_th,
              (SELECT name FROM product_translations t WHERE t.product_id=p.id AND t.lang='en') AS name_en,
              COALESCE(s.current,0) AS current, COALESCE(s.reserved,0) AS reserved, COALESCE(s.current - s.reserved, 0) AS available,
              COALESCE(s.minimum,0) AS minimum, s.updated_at
         FROM products p LEFT JOIN stocks s ON s.product_id=p.id AND s.branch_id=$1
        WHERE p.deleted_at IS NULL ORDER BY p.track_stock DESC, p.sort, p.sku`,
      [branchId],
    );
  });

  app.post('/:productId/adjust', { preHandler: requireStaff('stock.manage') }, async (req) => {
    const { productId } = parse(z.object({ productId: uuid }), req.params);
    const b = parse(
      z.object({ type: z.enum(['ADJUST', 'RESTOCK', 'WASTE']), qty: z.coerce.number().min(0).max(1_000_000), minimum: z.coerce.number().min(0).optional(), note: z.string().max(300).optional() }),
      req.body,
    );
    const branchId = branchOf(req);
    const out = new Outbox();
    const r = await tx((c) => adjustStock(c, { productId, branchId, type: b.type, qty: b.qty, minimum: b.minimum, userId: req.staff!.id, note: b.note }, out));
    await out.flush();
    await audit(req, { action: 'STOCK_CHANGE', entity: 'product', entityId: productId, branchId, oldValue: r.before, newValue: { ...r.after, type: b.type, qty: b.qty, note: b.note } });
    return r.after;
  });

  app.get('/movements', { preHandler: requireStaff('stock.view') }, async (req) => {
    const q = parse(z.object({ productId: uuid.optional(), limit: z.coerce.number().int().max(500).default(100) }), req.query);
    return query(
      `SELECT m.*, u.name AS user_name, o.order_number,
              (SELECT name FROM product_translations t WHERE t.product_id=m.product_id AND t.lang='th') AS product_name
         FROM stock_movements m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN orders o ON o.id=m.order_id
        WHERE m.branch_id=$1 AND ($2::uuid IS NULL OR m.product_id=$2) ORDER BY m.created_at DESC LIMIT $3`,
      [branchOf(req), q.productId ?? null, q.limit],
    );
  });
}
