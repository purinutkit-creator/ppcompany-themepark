import { query } from '../../db/pool';
import type { Report } from '../../routes/reports';
import { searchTransactions } from './transactions';

export interface ParkReportFilter {
  branchId: string;
  tz: string;
  from?: string;
  to?: string;
  storeId?: string;
  rideId?: string;
}

const N = (col: string) => `COALESCE(${col}->>'en', ${col}->>'th', ${col}->>'zh')`;

/** Local-date range condition on a timestamptz column. $1 = branch, $2 = tz, $3 = from, $4 = to. */
const range = (col: string) => `($3::date IS NULL OR (${col} AT TIME ZONE $2)::date >= $3::date) AND ($4::date IS NULL OR (${col} AT TIME ZONE $2)::date <= $4::date)`;
const base = (f: ParkReportFilter) => [f.branchId, f.tz, f.from ?? null, f.to ?? null];

export const PARK_REPORTS: Record<string, (f: ParkReportFilter) => Promise<Report>> = {
  'park-daily-sales': async (f) => ({
    title: 'Daily Sales (all streams)',
    columns: [
      { key: 'date', label: 'Date' }, { key: 'tickets', label: 'Tickets', type: 'money' }, { key: 'food', label: 'Food', type: 'money' },
      { key: 'retail', label: 'Retail', type: 'money' }, { key: 'topup', label: 'Wallet top-up', type: 'money' }, { key: 'membership', label: 'Membership', type: 'money' },
      { key: 'rides', label: 'Ride add-ons', type: 'money' }, { key: 'lockers', label: 'Lockers', type: 'money' }, { key: 'refunds', label: 'Refunds', type: 'money' },
      { key: 'wallet_spend', label: 'Paid by wallet / points', type: 'money' }, { key: 'revenue', label: 'Net revenue', type: 'money' },
    ],
    rows: await query(
      `WITH d AS (
         SELECT (s.paid_at AT TIME ZONE $2)::date AS date,
                SUM(si.line_total) FILTER (WHERE si.item_type='PACKAGE') AS tickets,
                SUM(si.line_total) FILTER (WHERE si.item_type='PRODUCT' AND si.points_category='FOOD') AS park_food,
                SUM(si.line_total) FILTER (WHERE si.item_type='PRODUCT' AND si.points_category<>'FOOD') AS retail,
                SUM(si.line_total) FILTER (WHERE si.item_type='TOPUP') AS topup,
                SUM(si.line_total) FILTER (WHERE si.item_type LIKE 'MEMBERSHIP%') AS membership,
                SUM(si.line_total) FILTER (WHERE si.item_type='RIDE_ADDON') AS rides,
                SUM(si.line_total) FILTER (WHERE si.item_type='LOCKER') AS lockers
           FROM sales s JOIN sale_items si ON si.sale_id=s.id WHERE s.branch_id=$1 AND s.status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED') AND ${range('s.paid_at')} GROUP BY 1),
       o AS (SELECT (paid_at AT TIME ZONE $2)::date AS date, SUM(total) AS food, SUM(total) FILTER (WHERE payment_method='WALLET') AS wallet_food
               FROM orders WHERE branch_id=$1 AND payment_status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED') AND ${range('paid_at')} GROUP BY 1),
       w AS (SELECT (p.paid_at AT TIME ZONE $2)::date AS date, SUM(p.amount) AS spend FROM sale_payments p JOIN sales s ON s.id=p.sale_id
               WHERE s.branch_id=$1 AND p.method IN ('WALLET','POINTS') AND p.status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED') AND ${range('p.paid_at')} GROUP BY 1),
       r AS (SELECT (created_at AT TIME ZONE $2)::date AS date, SUM(amount) AS refunds FROM refunds WHERE branch_id=$1 AND ${range('created_at')} GROUP BY 1),
       days AS (SELECT date FROM d UNION SELECT date FROM o UNION SELECT date FROM r)
       SELECT to_char(days.date,'YYYY-MM-DD') AS date, COALESCE(d.tickets,0) AS tickets, COALESCE(d.park_food,0)+COALESCE(o.food,0) AS food, COALESCE(d.retail,0) AS retail,
              COALESCE(d.topup,0) AS topup, COALESCE(d.membership,0) AS membership, COALESCE(d.rides,0) AS rides, COALESCE(d.lockers,0) AS lockers,
              COALESCE(r.refunds,0) AS refunds, COALESCE(w.spend,0)+COALESCE(o.wallet_food,0) AS wallet_spend,
              COALESCE(d.tickets,0)+COALESCE(d.park_food,0)+COALESCE(o.food,0)+COALESCE(d.retail,0)+COALESCE(d.topup,0)+COALESCE(d.membership,0)+COALESCE(d.rides,0)+COALESCE(d.lockers,0)
                - COALESCE(w.spend,0) - COALESCE(o.wallet_food,0) - COALESCE(r.refunds,0) AS revenue
         FROM days LEFT JOIN d ON d.date=days.date LEFT JOIN o ON o.date=days.date LEFT JOIN w ON w.date=days.date LEFT JOIN r ON r.date=days.date ORDER BY 1`,
      base(f),
    ),
  }),
  'ticket-sales': async (f) => ({
    title: 'Ticket Sales',
    columns: [{ key: 'package', label: 'Package' }, { key: 'ticket_type', label: 'Ticket type' }, { key: 'channel', label: 'Channel' }, { key: 'tickets', label: 'Tickets', type: 'number' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'used', label: 'Used / entered', type: 'number' }],
    rows: await query(
      `SELECT ${N('p.name')} AS package, ${N('tt.name')} AS ticket_type, s.channel, COUNT(*)::int AS tickets, SUM(t.price) AS amount, COUNT(*) FILTER (WHERE t.entry_count > 0)::int AS used
         FROM tickets t JOIN packages p ON p.id=t.package_id LEFT JOIN ticket_types tt ON tt.id=t.ticket_type_id JOIN sales s ON s.id=t.sale_id
        WHERE t.branch_id=$1 AND t.status IN ('ACTIVE','USED','EXPIRED') AND ${range('t.activated_at')} GROUP BY 1,2,3 ORDER BY 5 DESC`,
      base(f),
    ),
  }),
  visitors: async (f) => ({
    title: 'Visitors',
    columns: [{ key: 'date', label: 'Date' }, { key: 'entries', label: 'Entries', type: 'number' }, { key: 'visitors', label: 'Unique visitors', type: 'number' }, { key: 'exits', label: 'Exits', type: 'number' }, { key: 'members', label: 'Member visits', type: 'number' }],
    rows: await query(
      `SELECT to_char(visit_date,'YYYY-MM-DD') AS date, COUNT(*) FILTER (WHERE direction='ENTRY')::int AS entries, COUNT(DISTINCT ticket_id) FILTER (WHERE direction='ENTRY')::int AS visitors,
              COUNT(*) FILTER (WHERE direction='EXIT')::int AS exits, COUNT(DISTINCT member_id) FILTER (WHERE direction='ENTRY')::int AS members
         FROM entry_logs WHERE branch_id=$1 AND status='CONFIRMED' AND ($3::date IS NULL OR visit_date >= $3::date) AND ($4::date IS NULL OR visit_date <= $4::date) AND $2::text IS NOT NULL
        GROUP BY visit_date ORDER BY visit_date`,
      base(f),
    ),
  }),
  gates: async (f) => ({
    title: 'Gate Report',
    columns: [{ key: 'gate', label: 'Gate' }, { key: 'scans', label: 'Scans', type: 'number' }, { key: 'approved', label: 'Approved', type: 'number' }, { key: 'denied', label: 'Denied', type: 'number' }, { key: 'duplicates', label: 'Duplicate attempts', type: 'number' }, { key: 'overrides', label: 'Overrides', type: 'number' }, { key: 'avg_approval_sec', label: 'Avg approval (s)', type: 'number' }],
    rows: await query(
      `SELECT g.code AS gate, COUNT(s.id)::int AS scans, COUNT(s.id) FILTER (WHERE s.result IN ('GRANTED','APPROVED','OVERRIDE'))::int AS approved,
              COUNT(s.id) FILTER (WHERE s.result IN ('DENIED','OPERATOR_DENIED','TIMEOUT'))::int AS denied, COUNT(s.id) FILTER (WHERE s.reason_code='ALREADY_INSIDE')::int AS duplicates,
              COUNT(s.id) FILTER (WHERE s.result='OVERRIDE')::int AS overrides, ROUND(AVG(extract(epoch FROM s.decided_at - s.created_at)) FILTER (WHERE s.result='APPROVED')::numeric, 1) AS avg_approval_sec
         FROM gates g LEFT JOIN gate_scans s ON s.gate_id=g.id AND ${range('s.created_at')} WHERE g.branch_id=$1 GROUP BY g.id ORDER BY g.number`,
      base(f),
    ),
  }),
  rides: async (f) => ({
    title: 'Ride Report',
    columns: [{ key: 'ride', label: 'Ride' }, { key: 'granted', label: 'Rides', type: 'number' }, { key: 'denied', label: 'Denied', type: 'number' }, { key: 'not_included', label: 'Not included', type: 'number' }, { key: 'addon_sales', label: 'Add-on sales', type: 'number' }, { key: 'addon_amount', label: 'Add-on revenue', type: 'money' }],
    rows: await query(
      `SELECT r.code || ' ' || ${N('r.name')} AS ride,
              (SELECT COUNT(*)::int FROM ride_access_logs l WHERE l.ride_id=r.id AND l.result='GRANTED' AND ${range('l.created_at')}) AS granted,
              (SELECT COUNT(*)::int FROM ride_access_logs l WHERE l.ride_id=r.id AND l.result='DENIED' AND ${range('l.created_at')}) AS denied,
              (SELECT COUNT(*)::int FROM ride_access_logs l WHERE l.ride_id=r.id AND l.result='NOT_INCLUDED' AND ${range('l.created_at')}) AS not_included,
              (SELECT COUNT(*)::int FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.item_type='RIDE_ADDON' AND si.ref_id=r.id AND s.status='PAID' AND ${range('s.paid_at')}) AS addon_sales,
              (SELECT COALESCE(SUM(si.line_total),0) FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.item_type='RIDE_ADDON' AND si.ref_id=r.id AND s.status='PAID' AND ${range('s.paid_at')}) AS addon_amount
         FROM rides r WHERE r.branch_id=$1 ORDER BY r.sort, r.code`,
      base(f),
    ),
  }),
  queues: async (f) => ({
    title: 'Queue Report',
    columns: [{ key: 'ride', label: 'Ride' }, { key: 'joined', label: 'Joined', type: 'number' }, { key: 'boarded', label: 'Boarded', type: 'number' }, { key: 'no_show', label: 'No-show', type: 'number' }, { key: 'cancelled', label: 'Cancelled', type: 'number' }, { key: 'avg_wait_min', label: 'Avg wait (min)', type: 'number' }],
    rows: await query(
      `SELECT r.code || ' ' || ${N('r.name')} AS ride, COUNT(q.id)::int AS joined, COUNT(q.id) FILTER (WHERE q.status='BOARDED')::int AS boarded,
              COUNT(q.id) FILTER (WHERE q.status='NO_SHOW')::int AS no_show, COUNT(q.id) FILTER (WHERE q.status='CANCELLED')::int AS cancelled,
              ROUND(AVG(extract(epoch FROM q.boarded_at - q.joined_at)/60) FILTER (WHERE q.status='BOARDED')::numeric, 1) AS avg_wait_min
         FROM rides r LEFT JOIN ride_queues q ON q.ride_id=r.id AND ${range('q.joined_at')} WHERE r.branch_id=$1 AND r.queue_enabled GROUP BY r.id ORDER BY 2 DESC`,
      base(f),
    ),
  }),
  'food-sales': async (f) => ({
    title: 'Food Sales',
    columns: [{ key: 'item', label: 'Item' }, { key: 'qty', label: 'Qty', type: 'number' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'source', label: 'Source' }],
    rows: await query(
      `SELECT ${N('oi.name')} AS item, SUM(oi.qty)::int AS qty, SUM(oi.line_total) AS amount, 'Restaurant' AS source FROM order_items oi JOIN orders o ON o.id=oi.order_id
         WHERE o.branch_id=$1 AND o.payment_status IN ('PAID','PARTIALLY_REFUNDED') AND ${range('o.paid_at')} GROUP BY 1
       UNION ALL
       SELECT ${N('si.name')}, SUM(si.qty)::int, SUM(si.line_total), 'POS' FROM sale_items si JOIN sales s ON s.id=si.sale_id
         WHERE s.branch_id=$1 AND s.status IN ('PAID','PARTIALLY_REFUNDED') AND si.item_type='PRODUCT' AND si.points_category='FOOD' AND ${range('s.paid_at')} GROUP BY 1
       ORDER BY 3 DESC`,
      base(f),
    ),
  }),
  'retail-sales': async (f) => ({
    title: 'Retail Sales',
    columns: [{ key: 'store', label: 'Store' }, { key: 'sku', label: 'SKU' }, { key: 'item', label: 'Item' }, { key: 'qty', label: 'Qty', type: 'number' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'cost', label: 'Cost', type: 'money' }, { key: 'margin', label: 'Margin', type: 'money' }],
    rows: await query(
      `SELECT ${N('st.name')} AS store, si.sku, ${N('si.name')} AS item, SUM(si.qty - si.refunded_qty)::int AS qty, SUM(si.line_total) AS amount,
              SUM((si.qty - si.refunded_qty) * p.cost) AS cost, SUM(si.line_total) - SUM((si.qty - si.refunded_qty) * p.cost) AS margin
         FROM sale_items si JOIN sales s ON s.id=si.sale_id LEFT JOIN stores st ON st.id=s.store_id LEFT JOIN products p ON p.id=si.ref_id
        WHERE s.branch_id=$1 AND s.status IN ('PAID','PARTIALLY_REFUNDED') AND si.item_type='PRODUCT' AND si.points_category<>'FOOD' AND ${range('s.paid_at')}
          AND ($5::uuid IS NULL OR s.store_id=$5) GROUP BY 1,2,3 ORDER BY 5 DESC`,
      [...base(f), f.storeId ?? null],
    ),
  }),
  wallet: async (f) => ({
    title: 'Wallet Ledger Summary',
    columns: [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Type' }, { key: 'count', label: 'Count', type: 'number' }, { key: 'credit', label: 'Credit', type: 'money' }, { key: 'debit', label: 'Debit', type: 'money' }],
    rows: await query(
      `SELECT to_char((created_at AT TIME ZONE $2)::date,'YYYY-MM-DD') AS date, type, COUNT(*)::int AS count, SUM(credit) AS credit, SUM(debit) AS debit
         FROM wallet_ledger WHERE (branch_id=$1 OR branch_id IS NULL) AND ${range('created_at')} GROUP BY 1,2 ORDER BY 1,2`,
      base(f),
    ),
  }),
  topups: async (f) => ({
    title: 'Top-ups',
    columns: [{ key: 'at', label: 'Time', type: 'datetime' }, { key: 'txn_no', label: 'Txn' }, { key: 'card', label: 'Card' }, { key: 'member_no', label: 'Member' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'balance_after', label: 'Balance after', type: 'money' }, { key: 'reference', label: 'Sale' }, { key: 'staff', label: 'Staff' }],
    rows: await query(
      `SELECT w.created_at AS at, w.txn_no, c.code AS card, m.member_no, w.credit AS amount, w.balance_after, w.reference, u.name AS staff
         FROM wallet_ledger w LEFT JOIN credentials c ON c.id=w.credential_id LEFT JOIN members m ON m.id=w.member_id LEFT JOIN users u ON u.id=w.staff_id
        WHERE (w.branch_id=$1 OR w.branch_id IS NULL) AND w.type='TOPUP' AND ${range('w.created_at')} ORDER BY w.created_at DESC`,
      base(f),
    ),
  }),
  refunds: async (f) => ({
    title: 'Refunds',
    columns: [{ key: 'at', label: 'Time', type: 'datetime' }, { key: 'refund_no', label: 'Refund' }, { key: 'reference', label: 'Sale / order' }, { key: 'type', label: 'Type' }, { key: 'method', label: 'Paid back via' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'reason', label: 'Reason' }, { key: 'staff', label: 'Staff' }, { key: 'approved_by', label: 'Approved by' }],
    rows: await query(
      `SELECT r.created_at AS at, r.refund_no, COALESCE(s.sale_no, o.order_number) AS reference, r.type, COALESCE(r.refund_method, r.method) AS method, r.amount, r.reason, u.name AS staff, a.name AS approved_by
         FROM refunds r LEFT JOIN sales s ON s.id=r.sale_id LEFT JOIN orders o ON o.id=r.order_id LEFT JOIN users u ON u.id=r.created_by LEFT JOIN users a ON a.id=r.approved_by
        WHERE COALESCE(r.branch_id, s.branch_id, o.branch_id)=$1 AND ${range('r.created_at')} ORDER BY r.created_at DESC`,
      base(f),
    ),
  }),
  promotions: async (f) => ({
    title: 'Promotions',
    columns: [{ key: 'promotion', label: 'Promotion' }, { key: 'code', label: 'Code' }, { key: 'uses', label: 'Uses', type: 'number' }, { key: 'discount', label: 'Discount given', type: 'money' }, { key: 'members', label: 'Members', type: 'number' }],
    rows: await query(
      `SELECT ${N('p.name')} AS promotion, p.code, COUNT(r.id)::int AS uses, COALESCE(SUM(r.amount),0) AS discount, COUNT(DISTINCT r.member_id)::int AS members
         FROM promotions p JOIN promotion_redemptions r ON r.promotion_id=p.id JOIN sales s ON s.id=r.sale_id
        WHERE s.branch_id=$1 AND ${range('r.created_at')} GROUP BY p.id ORDER BY 4 DESC`,
      base(f),
    ),
  }),
  members: async (f) => ({
    title: 'Members',
    columns: [{ key: 'tier', label: 'Tier' }, { key: 'members', label: 'Members', type: 'number' }, { key: 'new_members', label: 'New in period', type: 'number' }, { key: 'active_memberships', label: 'Active memberships', type: 'number' }, { key: 'points', label: 'Points outstanding', type: 'number' }, { key: 'spend', label: 'Lifetime spend', type: 'money' }],
    rows: await query(
      `SELECT ${N('t.name')} AS tier, COUNT(m.id)::int AS members, COUNT(m.id) FILTER (WHERE ${range('m.created_at')})::int AS new_members,
              COUNT(DISTINCT ms.member_id)::int AS active_memberships, COALESCE(SUM(m.points),0)::int AS points, COALESCE(SUM(m.total_spend),0) AS spend
         FROM member_tiers t LEFT JOIN members m ON m.tier_id=t.id AND (m.home_branch_id=$1 OR m.home_branch_id IS NULL)
         LEFT JOIN memberships ms ON ms.member_id=m.id AND ms.status='ACTIVE' GROUP BY t.id ORDER BY t.rank`,
      base(f),
    ),
  }),
  staff: async (f) => ({
    title: 'Staff Performance',
    columns: [{ key: 'staff', label: 'Staff' }, { key: 'role', label: 'Role' }, { key: 'payments', label: 'Payments taken', type: 'number' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'refunds', label: 'Refunds', type: 'money' }, { key: 'gate_decisions', label: 'Gate decisions', type: 'number' }],
    rows: await query(
      `SELECT u.name AS staff, r.name AS role,
              (SELECT COUNT(*)::int FROM sale_payments p JOIN sales s ON s.id=p.sale_id WHERE p.cashier_id=u.id AND p.status='PAID' AND s.branch_id=$1 AND ${range('p.paid_at')}) AS payments,
              (SELECT COALESCE(SUM(p.amount),0) FROM sale_payments p JOIN sales s ON s.id=p.sale_id WHERE p.cashier_id=u.id AND p.status='PAID' AND s.branch_id=$1 AND ${range('p.paid_at')}) AS amount,
              (SELECT COALESCE(SUM(amount),0) FROM refunds x WHERE x.created_by=u.id AND ${range('x.created_at')}) AS refunds,
              (SELECT COUNT(*)::int FROM gate_scans g WHERE g.decided_by=u.id AND ${range('g.created_at')}) AS gate_decisions
         FROM users u JOIN roles r ON r.id=u.role_id WHERE (u.branch_id=$1 OR u.branch_id IS NULL) AND u.status='ACTIVE' ORDER BY 4 DESC`,
      base(f),
    ),
  }),
  shifts: async (f) => ({
    title: 'Shifts',
    columns: [{ key: 'shift_no', label: 'Shift' }, { key: 'staff', label: 'Staff' }, { key: 'terminal', label: 'Terminal' }, { key: 'opened_at', label: 'Opened', type: 'datetime' }, { key: 'closed_at', label: 'Closed', type: 'datetime' }, { key: 'opening_cash', label: 'Opening', type: 'money' }, { key: 'expected_cash', label: 'Expected', type: 'money' }, { key: 'actual_cash', label: 'Actual', type: 'money' }, { key: 'over_short', label: 'Over / short', type: 'money' }],
    rows: await query(
      `SELECT s.shift_no, u.name AS staff, s.terminal, s.opened_at, s.closed_at, s.opening_cash, s.expected_cash, s.actual_cash, s.over_short
         FROM shifts s JOIN users u ON u.id=s.user_id WHERE s.branch_id=$1 AND ${range('s.opened_at')} ORDER BY s.opened_at DESC`,
      base(f),
    ),
  }),
  stock: async (f) => ({
    title: 'Stock by Store',
    columns: [{ key: 'store', label: 'Store' }, { key: 'sku', label: 'SKU' }, { key: 'item', label: 'Item' }, { key: 'qty', label: 'On hand', type: 'number' }, { key: 'min_qty', label: 'Minimum', type: 'number' }, { key: 'low', label: 'Low stock' }, { key: 'sold', label: 'Sold in period', type: 'number' }],
    rows: await query(
      `SELECT ${N('st.name')} AS store, p.sku, COALESCE((SELECT name FROM product_translations WHERE product_id=p.id AND lang='en'), p.sku) AS item, i.qty, i.min_qty,
              CASE WHEN i.qty <= i.min_qty AND i.min_qty > 0 THEN 'LOW' ELSE '' END AS low,
              (SELECT COALESCE(-SUM(qty),0) FROM inventory_movements m WHERE m.product_id=i.product_id AND m.store_id=i.store_id AND m.type='SALE' AND ${range('m.created_at')}) AS sold
         FROM inventory i JOIN stores st ON st.id=i.store_id JOIN products p ON p.id=i.product_id WHERE st.branch_id=$1 AND ($5::uuid IS NULL OR i.store_id=$5) ORDER BY 1,3`,
      [...base(f), f.storeId ?? null],
    ),
  }),
  transactions: async (f) => ({
    title: 'Transactions',
    columns: [{ key: 'at', label: 'Time', type: 'datetime' }, { key: 'txn_no', label: 'Txn' }, { key: 'module', label: 'Module' }, { key: 'type', label: 'Type' }, { key: 'reference', label: 'Reference' }, { key: 'method', label: 'Method' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'status', label: 'Status' }, { key: 'member_no', label: 'Member' }, { key: 'credential_code', label: 'Card' }, { key: 'staff_name', label: 'Staff' }],
    rows: await searchTransactions({ branchId: f.branchId, from: f.from, to: f.to, limit: 5000 }),
  }),
  occupancy: async (f) => ({
    title: 'Occupancy by Hour',
    columns: [{ key: 'date', label: 'Date' }, { key: 'hour', label: 'Hour' }, { key: 'entries', label: 'Entries', type: 'number' }, { key: 'exits', label: 'Exits', type: 'number' }],
    rows: await query(
      `SELECT to_char(visit_date,'YYYY-MM-DD') AS date, lpad(extract(hour FROM passed_at AT TIME ZONE $2)::text,2,'0') || ':00' AS hour,
              COUNT(*) FILTER (WHERE direction='ENTRY')::int AS entries, COUNT(*) FILTER (WHERE direction='EXIT')::int AS exits
         FROM entry_logs WHERE branch_id=$1 AND status='CONFIRMED' AND ($3::date IS NULL OR visit_date >= $3::date) AND ($4::date IS NULL OR visit_date <= $4::date)
        GROUP BY 1,2 ORDER BY 1,2`,
      base(f),
    ),
  }),
};
