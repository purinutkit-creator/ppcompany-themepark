import { EVENTS, rooms } from '@kiosk/shared';
import { one, query, type Tx } from '../db/pool';
import { conflict } from '../lib/errors';
import type { Outbox } from '../lib/realtime';

interface Need {
  productId: string;
  qty: number;
}

function sumByProduct(items: Need[]): Need[] {
  const m = new Map<string, number>();
  for (const i of items) m.set(i.productId, (m.get(i.productId) ?? 0) + i.qty);
  return [...m].map(([productId, qty]) => ({ productId, qty }));
}

async function emitStock(c: Tx, branchId: string, productId: string, out: Outbox) {
  const s = await one<any>(`SELECT current, reserved, minimum FROM stocks WHERE product_id=$1 AND branch_id=$2`, [productId, branchId], c);
  if (!s) return;
  const data = { productId, current: s.current, reserved: s.reserved, available: s.current - s.reserved, minimum: s.minimum, low: s.current - s.reserved <= s.minimum };
  out.add([rooms.branchKiosks(branchId), rooms.branchAdmin(branchId), rooms.branchCashier(branchId)], EVENTS.STOCK_UPDATED, data);
}

async function trackedProducts(c: Tx, ids: string[]): Promise<Set<string>> {
  const rows = await query<{ id: string }>(`SELECT id FROM products WHERE id = ANY($1) AND track_stock`, [ids], c);
  return new Set(rows.map((r) => r.id));
}

/** Reserve stock for a new order (locks stock rows; fails if unavailable). */
export async function reserveStock(c: Tx, branchId: string, orderId: string, items: Need[], out: Outbox) {
  const needs = sumByProduct(items);
  const tracked = await trackedProducts(c, needs.map((n) => n.productId));
  for (const n of needs.filter((x) => tracked.has(x.productId)).sort((a, b) => a.productId.localeCompare(b.productId))) {
    const s = await one<any>(`SELECT current, reserved FROM stocks WHERE product_id=$1 AND branch_id=$2 FOR UPDATE`, [n.productId, branchId], c);
    const available = s ? s.current - s.reserved : 0;
    if (available < n.qty) throw conflict('OUT_OF_STOCK', 'Product is sold out', { productId: n.productId, available });
    const r = await one<any>(
      `UPDATE stocks SET reserved = reserved + $3, updated_at = now() WHERE product_id=$1 AND branch_id=$2 RETURNING current, reserved`,
      [n.productId, branchId, n.qty],
      c,
    );
    await query(
      `INSERT INTO stock_movements (product_id, branch_id, type, qty, current_after, reserved_after, order_id) VALUES ($1,$2,'RESERVE',$3,$4,$5,$6)`,
      [n.productId, branchId, n.qty, r.current, r.reserved, orderId],
      c,
    );
    await emitStock(c, branchId, n.productId, out);
  }
}

/** Release reservations of an order that will not be paid (cancel / expiry). Idempotent. */
export async function releaseStock(c: Tx, branchId: string, orderId: string, out: Outbox) {
  const reserved = await query<any>(
    `SELECT product_id, qty FROM stock_movements m WHERE order_id=$1 AND type='RESERVE'
       AND NOT EXISTS (SELECT 1 FROM stock_movements x WHERE x.order_id=m.order_id AND x.product_id=m.product_id AND x.type IN ('RELEASE','COMMIT'))`,
    [orderId],
    c,
  );
  for (const r of reserved) {
    const ins = await one(
      `INSERT INTO stock_movements (product_id, branch_id, type, qty, order_id) VALUES ($1,$2,'RELEASE',$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
      [r.product_id, branchId, r.qty, orderId],
      c,
    );
    if (!ins) continue;
    await query(`UPDATE stocks SET reserved = GREATEST(reserved - $3, 0), updated_at=now() WHERE product_id=$1 AND branch_id=$2`, [r.product_id, branchId, r.qty], c);
    await emitStock(c, branchId, r.product_id, out);
  }
}

/** Commit stock when payment is confirmed. Uses the reservation if one exists. Idempotent. */
export async function commitStock(c: Tx, branchId: string, orderId: string, out: Outbox) {
  const items = await query<any>(
    `SELECT oi.product_id, SUM(oi.qty)::int AS qty FROM order_items oi JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id=$1 AND p.track_stock GROUP BY oi.product_id ORDER BY oi.product_id`,
    [orderId],
    c,
  );
  for (const it of items) {
    const ins = await one(
      `INSERT INTO stock_movements (product_id, branch_id, type, qty, order_id) VALUES ($1,$2,'COMMIT',$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
      [it.product_id, branchId, it.qty, orderId],
      c,
    );
    if (!ins) continue;
    const hadReserve = await one(
      `SELECT 1 FROM stock_movements WHERE order_id=$1 AND product_id=$2 AND type='RESERVE'
         AND NOT EXISTS (SELECT 1 FROM stock_movements WHERE order_id=$1 AND product_id=$2 AND type='RELEASE')`,
      [orderId, it.product_id],
      c,
    );
    await query(
      `INSERT INTO stocks (product_id, branch_id, current, reserved) VALUES ($1,$2,0,0) ON CONFLICT DO NOTHING`,
      [it.product_id, branchId],
      c,
    );
    const r = await one<any>(
      `UPDATE stocks SET current = current - $3, reserved = GREATEST(reserved - $4, 0), updated_at=now()
        WHERE product_id=$1 AND branch_id=$2 RETURNING current, reserved`,
      [it.product_id, branchId, it.qty, hadReserve ? it.qty : 0],
      c,
    );
    await query(`UPDATE stock_movements SET current_after=$2, reserved_after=$3 WHERE id=$1`, [(ins as any).id, r.current, r.reserved], c);
    await emitStock(c, branchId, it.product_id, out);
  }
}

/** Return committed stock (cancel of a paid order before cooking). Idempotent. */
export async function returnStock(c: Tx, branchId: string, orderId: string, out: Outbox) {
  const committed = await query<any>(`SELECT product_id, qty FROM stock_movements WHERE order_id=$1 AND type='COMMIT'`, [orderId], c);
  for (const r of committed) {
    const ins = await one(
      `INSERT INTO stock_movements (product_id, branch_id, type, qty, order_id) VALUES ($1,$2,'RETURN',$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
      [r.product_id, branchId, r.qty, orderId],
      c,
    );
    if (!ins) continue;
    await query(`UPDATE stocks SET current = current + $3, updated_at=now() WHERE product_id=$1 AND branch_id=$2`, [r.product_id, branchId, r.qty], c);
    await emitStock(c, branchId, r.product_id, out);
  }
}

export async function adjustStock(
  c: Tx,
  p: { productId: string; branchId: string; type: 'ADJUST' | 'RESTOCK' | 'WASTE'; qty: number; minimum?: number; userId: string; note?: string },
  out: Outbox,
) {
  await query(`INSERT INTO stocks (product_id, branch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [p.productId, p.branchId], c);
  const before = await one<any>(`SELECT current, reserved, minimum FROM stocks WHERE product_id=$1 AND branch_id=$2 FOR UPDATE`, [p.productId, p.branchId], c);
  const next = p.type === 'ADJUST' ? p.qty : p.type === 'RESTOCK' ? before.current + p.qty : before.current - p.qty;
  const r = await one<any>(
    `UPDATE stocks SET current=$3, minimum=COALESCE($4, minimum), updated_at=now() WHERE product_id=$1 AND branch_id=$2 RETURNING current, reserved, minimum`,
    [p.productId, p.branchId, next, p.minimum ?? null],
    c,
  );
  await query(
    `INSERT INTO stock_movements (product_id, branch_id, type, qty, current_after, reserved_after, user_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [p.productId, p.branchId, p.type, p.type === 'ADJUST' ? next - before.current : p.qty, r.current, r.reserved, p.userId, p.note ?? null],
    c,
  );
  await emitStock(c, p.branchId, p.productId, out);
  return { before, after: r };
}
