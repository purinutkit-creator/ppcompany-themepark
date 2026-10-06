import { EVENTS, rooms } from '@kiosk/shared';
import { one, query, tx, type Tx } from '../../db/pool';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { Outbox } from '../../lib/realtime';
import { getSettings } from '../../lib/settings';
import { branchToday, genTransferNo } from './common';
import { notify } from './notifications';

async function move(
  c: Tx,
  m: { productId: string; storeId: string; type: string; qty: number; refType?: string | null; refId?: string | null; transferId?: string | null; userId?: string | null; note?: string | null },
  out: Outbox,
) {
  // Upsert + lock the stock row; qty may go negative only for sales already paid (alerted below).
  await query(`INSERT INTO inventory (product_id, store_id, qty) VALUES ($1,$2,0) ON CONFLICT DO NOTHING`, [m.productId, m.storeId], c);
  const row = await one<any>(`SELECT * FROM inventory WHERE product_id=$1 AND store_id=$2 FOR UPDATE`, [m.productId, m.storeId], c);
  const after = Number(row.qty) + m.qty;
  if (after < 0 && !['SALE'].includes(m.type)) throw conflict('INSUFFICIENT_STOCK', `Only ${row.qty} in stock`);
  const ins = await one<any>(
    `INSERT INTO inventory_movements (product_id, store_id, type, qty, qty_after, ref_type, ref_id, transfer_id, user_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
    [m.productId, m.storeId, m.type, m.qty, after, m.refType ?? null, m.refId ?? null, m.transferId ?? null, m.userId ?? null, m.note ?? null],
    c,
  );
  if (!ins) return row; // already applied (idempotent sale / return)
  await query(`UPDATE inventory SET qty=$3, updated_at=now() WHERE product_id=$1 AND store_id=$2`, [m.productId, m.storeId, after], c);
  const store = await one<any>(`SELECT branch_id, name FROM stores WHERE id=$1`, [m.storeId], c);
  out.add([rooms.branchAdmin(store.branch_id)], EVENTS.INVENTORY_UPDATED, { productId: m.productId, storeId: m.storeId, qty: after });
  const s = await getSettings(c);
  if (s.notification.lowStockAlerts && Number(row.min_qty) > 0 && after <= Number(row.min_qty) && Number(row.qty) > Number(row.min_qty)) {
    const p = await one<any>(`SELECT sku, (SELECT name FROM product_translations WHERE product_id=$1 AND lang='en') AS name FROM products WHERE id=$1`, [m.productId], c);
    await notify({
      audience: 'STAFF', branchId: store.branch_id, type: 'LOW_STOCK', severity: 'WARNING', dedupeKey: `lowstock:${m.productId}:${m.storeId}:${new Date().toISOString().slice(0, 10)}`,
      title: { th: 'สินค้าใกล้หมด', en: 'Low stock', zh: '库存不足' },
      body: { th: `${p?.name ?? p?.sku} เหลือ ${after}`, en: `${p?.name ?? p?.sku}: ${after} left`, zh: `${p?.name ?? p?.sku} 剩余 ${after}` },
      data: { productId: m.productId, storeId: m.storeId, qty: after },
    }, c, out);
  }
  return { ...row, qty: after };
}

export async function deductInventory(c: Tx, a: { storeId: string; productId: string; qty: number; refId: string; userId?: string | null }, out: Outbox) {
  const p = await one<any>(`SELECT track_stock FROM products WHERE id=$1`, [a.productId], c);
  if (!p?.track_stock) return null;
  return move(c, { productId: a.productId, storeId: a.storeId, type: 'SALE', qty: -a.qty, refType: 'SALE', refId: a.refId, userId: a.userId ?? null }, out);
}

export async function returnInventory(c: Tx, a: { storeId: string; productId: string; qty: number; refId: string }, out: Outbox) {
  const p = await one<any>(`SELECT track_stock FROM products WHERE id=$1`, [a.productId], c);
  if (!p?.track_stock) return null;
  return move(c, { productId: a.productId, storeId: a.storeId, type: 'RETURN', qty: a.qty, refType: 'SALE', refId: a.refId }, out);
}

/** Stock in / out / adjustment / waste by staff. Adjustment sets an absolute count. */
export async function stockOperation(
  a: { storeId: string; productId: string; type: 'IN' | 'OUT' | 'ADJUST' | 'WASTE'; qty: number; note?: string | null; userId: string; minQty?: number | null },
) {
  const out = new Outbox();
  const r = await tx(async (c) => {
    if (!(a.qty >= 0)) throw badRequest('INVALID_QTY');
    await query(`INSERT INTO inventory (product_id, store_id, qty) VALUES ($1,$2,0) ON CONFLICT DO NOTHING`, [a.productId, a.storeId], c);
    if (a.minQty != null) await query(`UPDATE inventory SET min_qty=$3 WHERE product_id=$1 AND store_id=$2`, [a.productId, a.storeId, a.minQty], c);
    const cur = await one<any>(`SELECT qty FROM inventory WHERE product_id=$1 AND store_id=$2 FOR UPDATE`, [a.productId, a.storeId], c);
    let delta = a.type === 'IN' ? a.qty : a.type === 'ADJUST' ? a.qty - Number(cur.qty) : -a.qty;
    if (delta === 0 && a.type === 'ADJUST') return cur;
    return move(c, { productId: a.productId, storeId: a.storeId, type: a.type, qty: delta, refType: 'MANUAL', userId: a.userId, note: a.note }, out);
  });
  await out.flush();
  return r;
}

export async function transferStock(a: { fromStoreId: string; toStoreId: string; items: { productId: string; qty: number }[]; note?: string | null; userId: string }) {
  if (a.fromStoreId === a.toStoreId) throw badRequest('SAME_STORE');
  if (!a.items.length) throw badRequest('NO_ITEMS');
  const out = new Outbox();
  const r = await tx(async (c) => {
    const from = await one<any>(`SELECT branch_id FROM stores WHERE id=$1`, [a.fromStoreId], c);
    const to = await one<any>(`SELECT branch_id FROM stores WHERE id=$1`, [a.toStoreId], c);
    if (!from || !to) throw notFound('Store');
    const t = await one<any>(
      `INSERT INTO inventory_transfers (transfer_no, from_store_id, to_store_id, items, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [await genTransferNo(c, await branchToday(from.branch_id, c)), a.fromStoreId, a.toStoreId, JSON.stringify(a.items), a.note ?? null, a.userId],
      c,
    );
    for (const it of a.items) {
      if (!(it.qty > 0)) throw badRequest('INVALID_QTY');
      await move(c, { productId: it.productId, storeId: a.fromStoreId, type: 'TRANSFER_OUT', qty: -it.qty, transferId: t.id, refType: 'TRANSFER', userId: a.userId }, out);
      await move(c, { productId: it.productId, storeId: a.toStoreId, type: 'TRANSFER_IN', qty: it.qty, transferId: t.id, refType: 'TRANSFER', userId: a.userId }, out);
    }
    return t;
  });
  await out.flush();
  return r;
}
