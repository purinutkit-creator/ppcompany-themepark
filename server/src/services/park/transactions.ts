import { query } from '../../db/pool';

/**
 * Transaction Center: one searchable stream over every money / value movement in the system —
 * park sale payments (tickets, packages, membership, top-up, retail, locker, ride add-on), restaurant
 * order payments, wallet ledger entries and refunds.
 */
export interface TxnFilter {
  branchId: string;
  q?: string;
  type?: string;
  method?: string;
  staffId?: string;
  storeId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function searchTransactions(f: TxnFilter) {
  const params: unknown[] = [f.branchId, f.from ?? null, f.to ?? null, f.limit ?? 200, f.offset ?? 0];
  const q = f.q?.trim() ? `%${f.q.trim().replace(/[%_\\]/g, '')}%` : null;
  params.push(q, f.type ?? null, f.method ?? null, f.staffId ?? null, f.storeId ?? null);
  return query<any>(
    `WITH tz AS (SELECT timezone FROM branches WHERE id=$1),
     t AS (
       SELECT p.id, p.payment_no AS txn_no, COALESCE(p.paid_at, p.created_at) AS at, 'PARK' AS module,
              CASE s.kind WHEN 'BOOKING' THEN 'TICKET' ELSE s.kind END AS type, s.sale_no AS reference, p.method, p.amount, p.status,
              m.member_no, c.code AS credential_code, u.name AS staff_name, p.cashier_id AS staff_id, s.store_id, st.name AS store_name, s.id AS sale_id, NULL::uuid AS order_id,
              s.customer_name, (SELECT string_agg(ticket_no, ',') FROM tickets WHERE sale_id=s.id) AS tickets, bk.booking_no
         FROM sale_payments p JOIN sales s ON s.id=p.sale_id LEFT JOIN members m ON m.id=s.member_id LEFT JOIN credentials c ON c.id=s.credential_id
         LEFT JOIN users u ON u.id=p.cashier_id LEFT JOIN stores st ON st.id=s.store_id LEFT JOIN bookings bk ON bk.sale_id=s.id
        WHERE s.branch_id=$1
       UNION ALL
       SELECT p.id, o.order_number, COALESCE(p.paid_at, p.created_at), 'RESTAURANT', 'FOOD', o.order_number, p.method, p.amount, p.status,
              m.member_no, c.code, u.name, p.confirmed_by, o.store_id, st.name, NULL, o.id, NULL, NULL, NULL
         FROM payments p JOIN orders o ON o.id=p.order_id LEFT JOIN members m ON m.id=o.member_id LEFT JOIN credentials c ON c.id=o.credential_id
         LEFT JOIN users u ON u.id=p.confirmed_by LEFT JOIN stores st ON st.id=o.store_id
        WHERE o.branch_id=$1 AND p.status IN ('PAID','REFUNDED')
       UNION ALL
       SELECT w.id, w.txn_no, w.created_at, 'WALLET', 'WALLET_' || w.type, COALESCE(w.reference, w.txn_no), 'WALLET', (w.credit - w.debit), 'POSTED',
              m.member_no, c.code, u.name, w.staff_id, w.store_id, st.name, CASE WHEN w.ref_type='SALE' THEN w.ref_id END, CASE WHEN w.ref_type='ORDER' THEN w.ref_id END, NULL, NULL, NULL
         FROM wallet_ledger w LEFT JOIN members m ON m.id=w.member_id LEFT JOIN credentials c ON c.id=w.credential_id LEFT JOIN users u ON u.id=w.staff_id LEFT JOIN stores st ON st.id=w.store_id
        WHERE w.branch_id=$1 OR w.branch_id IS NULL
       UNION ALL
       SELECT r.id, COALESCE(r.refund_no, r.id::text), r.created_at, CASE WHEN r.order_id IS NOT NULL THEN 'RESTAURANT' ELSE 'PARK' END, 'REFUND',
              COALESCE(s.sale_no, o.order_number), COALESCE(r.refund_method, r.method), -r.amount, 'REFUNDED',
              m.member_no, NULL, u.name, r.created_by, COALESCE(s.store_id, o.store_id), NULL, r.sale_id, r.order_id, s.customer_name, NULL, NULL
         FROM refunds r LEFT JOIN sales s ON s.id=r.sale_id LEFT JOIN orders o ON o.id=r.order_id LEFT JOIN members m ON m.id=COALESCE(s.member_id, o.member_id)
         LEFT JOIN users u ON u.id=r.created_by
        WHERE COALESCE(r.branch_id, s.branch_id, o.branch_id) = $1
     )
     SELECT t.* FROM t, tz
      WHERE ($2::date IS NULL OR (t.at AT TIME ZONE tz.timezone)::date >= $2::date)
        AND ($3::date IS NULL OR (t.at AT TIME ZONE tz.timezone)::date <= $3::date)
        AND ($6::text IS NULL OR t.txn_no ILIKE $6 OR t.reference ILIKE $6 OR t.member_no ILIKE $6 OR t.credential_code ILIKE $6 OR t.tickets ILIKE $6
             OR t.booking_no ILIKE $6 OR t.customer_name ILIKE $6 OR t.staff_name ILIKE $6 OR t.id::text = replace($6,'%',''))
        AND ($7::text IS NULL OR t.type = $7 OR (t.type LIKE 'WALLET_%' AND $7 = 'WALLET'))
        AND ($8::text IS NULL OR t.method = $8)
        AND ($9::uuid IS NULL OR t.staff_id = $9)
        AND ($10::uuid IS NULL OR t.store_id = $10)
      ORDER BY t.at DESC LIMIT $4 OFFSET $5`,
    params,
  );
}
