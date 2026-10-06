import { loadLevel } from '@kiosk/shared';
import { one, query, type Db } from '../../db/pool';
import { branchInfo, branchToday, parkSettings } from './common';
import { occupancy } from './gates';
import { rideBoard } from './rides';

/**
 * Main dashboard: visitors, inside, sales by stream (tickets, food, retail, top-up), total revenue and
 * charts. Food comes from both the restaurant module (orders) and park POS food lines.
 */
export async function parkDashboard(db: Db, branchId: string, date?: string | null) {
  const b = await branchInfo(branchId, db);
  const day = date ?? (await branchToday(branchId, db));
  const tz = b.timezone;
  const range = `(created_at AT TIME ZONE '${tz.replace(/'/g, '')}')::date = $2::date`;
  const occ = await occupancy(db, branchId);
  const sales = await one<any>(
    `SELECT
        COALESCE(SUM(si.line_total) FILTER (WHERE si.item_type='PACKAGE'),0) AS tickets,
        COALESCE(SUM(si.line_total) FILTER (WHERE si.item_type='PRODUCT' AND si.points_category='FOOD'),0) AS park_food,
        COALESCE(SUM(si.line_total) FILTER (WHERE si.item_type='PRODUCT' AND si.points_category<>'FOOD'),0) AS retail,
        COALESCE(SUM(si.line_total) FILTER (WHERE si.item_type='TOPUP'),0) AS topup,
        COALESCE(SUM(si.line_total) FILTER (WHERE si.item_type LIKE 'MEMBERSHIP%'),0) AS membership,
        COALESCE(SUM(si.line_total) FILTER (WHERE si.item_type='RIDE_ADDON'),0) AS rides,
        COALESCE(SUM(si.line_total) FILTER (WHERE si.item_type='LOCKER'),0) AS lockers
       FROM sales s JOIN sale_items si ON si.sale_id=s.id
      WHERE s.branch_id=$1 AND s.status IN ('PAID','PARTIALLY_REFUNDED') AND (s.paid_at AT TIME ZONE '${tz.replace(/'/g, '')}')::date = $2::date`,
    [branchId, day],
    db,
  );
  const food = await one<any>(
    `SELECT COALESCE(SUM(total - refunded_amount),0) AS v, COUNT(*)::int AS n FROM orders WHERE branch_id=$1 AND payment_status IN ('PAID','PARTIALLY_REFUNDED')
        AND (paid_at AT TIME ZONE '${tz.replace(/'/g, '')}')::date = $2::date`,
    [branchId, day],
    db,
  );
  const refunds = await one<any>(`SELECT COALESCE(SUM(amount),0) AS v FROM refunds WHERE branch_id=$1 AND ${range} AND sale_id IS NOT NULL`, [branchId, day], db);
  const foodSales = Number(food.v) + Number(sales.park_food);
  // Wallet spending is not revenue twice: top-ups are counted, wallet payments are not (they are paid from top-ups).
  const walletPaid = await one<any>(
    `SELECT COALESCE(SUM(p.amount),0) AS v FROM sale_payments p JOIN sales s ON s.id=p.sale_id WHERE s.branch_id=$1 AND p.method IN ('WALLET','POINTS') AND p.status='PAID'
        AND (p.paid_at AT TIME ZONE '${tz.replace(/'/g, '')}')::date = $2::date`,
    [branchId, day],
    db,
  );
  const walletOrders = await one<any>(
    `SELECT COALESCE(SUM(total),0) AS v FROM orders WHERE branch_id=$1 AND payment_method='WALLET' AND payment_status='PAID' AND (paid_at AT TIME ZONE '${tz.replace(/'/g, '')}')::date = $2::date`,
    [branchId, day],
    db,
  );
  const gross =
    Number(sales.tickets) + foodSales + Number(sales.retail) + Number(sales.topup) + Number(sales.membership) + Number(sales.rides) + Number(sales.lockers);
  const totalRevenue = Math.round((gross - Number(walletPaid.v) - Number(walletOrders.v) - Number(refunds.v)) * 100) / 100;

  const hours = await query<any>(
    `WITH h AS (SELECT generate_series(0,23) AS h)
     SELECT h.h,
        (SELECT COUNT(*)::int FROM entry_logs e WHERE e.branch_id=$1 AND e.visit_date=$2::date AND e.direction='ENTRY' AND e.status='CONFIRMED'
           AND extract(hour FROM e.passed_at AT TIME ZONE '${tz.replace(/'/g, '')}')=h.h) AS visitors,
        (SELECT COALESCE(SUM(p.amount),0) FROM sale_payments p JOIN sales s ON s.id=p.sale_id WHERE s.branch_id=$1 AND p.status='PAID' AND p.method NOT IN ('WALLET','POINTS')
           AND (p.paid_at AT TIME ZONE '${tz.replace(/'/g, '')}')::date=$2::date AND extract(hour FROM p.paid_at AT TIME ZONE '${tz.replace(/'/g, '')}')=h.h)
        + (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.branch_id=$1 AND o.payment_status='PAID' AND o.payment_method <> 'WALLET'
           AND (o.paid_at AT TIME ZONE '${tz.replace(/'/g, '')}')::date=$2::date AND extract(hour FROM o.paid_at AT TIME ZONE '${tz.replace(/'/g, '')}')=h.h) AS revenue
       FROM h ORDER BY h.h`,
    [branchId, day],
    db,
  );
  const ticketTypes = await query<any>(
    `SELECT COALESCE(tt.name, p.name) AS name, COALESCE(tt.color, p.color) AS color, COUNT(*)::int AS qty, COALESCE(SUM(t.price),0) AS amount
       FROM tickets t JOIN packages p ON p.id=t.package_id LEFT JOIN ticket_types tt ON tt.id=t.ticket_type_id
      WHERE t.branch_id=$1 AND t.status IN ('ACTIVE','USED') AND (t.activated_at AT TIME ZONE '${tz.replace(/'/g, '')}')::date=$2::date
      GROUP BY 1,2 ORDER BY 3 DESC`,
    [branchId, day],
    db,
  );
  const byStore = await query<any>(
    `SELECT COALESCE(st.name, jsonb_build_object('en', s.channel, 'th', s.channel, 'zh', s.channel)) AS name, SUM(s.total)::numeric AS amount, COUNT(*)::int AS count
       FROM sales s LEFT JOIN stores st ON st.id=s.store_id
      WHERE s.branch_id=$1 AND s.status IN ('PAID','PARTIALLY_REFUNDED') AND (s.paid_at AT TIME ZONE '${tz.replace(/'/g, '')}')::date=$2::date GROUP BY 1
     UNION ALL
     SELECT COALESCE(st.name, '{"th":"ร้านอาหาร","en":"Restaurant","zh":"餐厅"}'::jsonb), SUM(o.total)::numeric, COUNT(*)::int FROM orders o LEFT JOIN stores st ON st.id=o.store_id
      WHERE o.branch_id=$1 AND o.payment_status IN ('PAID','PARTIALLY_REFUNDED') AND (o.paid_at AT TIME ZONE '${tz.replace(/'/g, '')}')::date=$2::date GROUP BY 1
     ORDER BY 2 DESC`,
    [branchId, day],
    db,
  );
  const rideUsage = await query<any>(
    `SELECT r.name, r.code, COUNT(l.id)::int AS rides FROM rides r LEFT JOIN ride_access_logs l ON l.ride_id=r.id AND l.result='GRANTED'
        AND (l.created_at AT TIME ZONE '${tz.replace(/'/g, '')}')::date=$2::date
      WHERE r.branch_id=$1 AND r.is_active GROUP BY r.id ORDER BY 3 DESC LIMIT 20`,
    [branchId, day],
    db,
  );
  const gateTraffic = await query<any>(
    `SELECT g.code, g.number, COUNT(s.id) FILTER (WHERE s.result IN ('GRANTED','APPROVED','OVERRIDE'))::int AS approved,
            COUNT(s.id) FILTER (WHERE s.result IN ('DENIED','OPERATOR_DENIED','TIMEOUT'))::int AS denied,
            COUNT(s.id) FILTER (WHERE s.reason_code='ALREADY_INSIDE')::int AS duplicate
       FROM gates g LEFT JOIN gate_scans s ON s.gate_id=g.id AND (s.created_at AT TIME ZONE '${tz.replace(/'/g, '')}')::date=$2::date
      WHERE g.branch_id=$1 GROUP BY g.id ORDER BY g.number`,
    [branchId, day],
    db,
  );
  const rides = await rideBoard(db, branchId);
  return {
    date: day,
    occupancy: occ,
    kpis: {
      todayVisitors: occ.visitorsToday,
      currentInside: occ.inside,
      ticketSales: Number(sales.tickets),
      foodSales,
      retailSales: Number(sales.retail),
      walletTopup: Number(sales.topup),
      membershipSales: Number(sales.membership),
      rideAddons: Number(sales.rides),
      lockerSales: Number(sales.lockers),
      refunds: Number(refunds.v),
      totalRevenue,
      foodOrders: food.n,
    },
    charts: {
      hours: hours.map((h) => ({ hour: h.h, visitors: h.visitors, revenue: Number(h.revenue) })),
      ticketTypes: ticketTypes.map((x) => ({ ...x, amount: Number(x.amount) })),
      byStore: byStore.map((x) => ({ ...x, amount: Number(x.amount) })),
      rideUsage,
      queueTimes: rides.filter((r) => r.queue_enabled).map((r) => ({ name: r.name, code: r.code, wait: r.wait_minutes, waiting: r.queue_waiting })),
      gateTraffic,
    },
  };
}

/** Consolidated owner view across all branches. */
export async function consolidatedDashboard(db: Db) {
  const branches = await query<any>(`SELECT id, code, name FROM branches WHERE is_active ORDER BY code`, [], db);
  const out: { branch: any; kpis: Awaited<ReturnType<typeof parkDashboard>>['kpis']; occupancy: any }[] = [];
  for (const b of branches) {
    const d = await parkDashboard(db, b.id);
    out.push({ branch: b, kpis: d.kpis, occupancy: d.occupancy });
  }
  const sum = (k: keyof (typeof out)[number]['kpis']) => out.reduce((s, x) => s + Number(x.kpis[k] ?? 0), 0);
  return {
    branches: out,
    totals: {
      todayVisitors: sum('todayVisitors'), currentInside: sum('currentInside'), ticketSales: sum('ticketSales'), foodSales: sum('foodSales'),
      retailSales: sum('retailSales'), walletTopup: sum('walletTopup'), totalRevenue: Math.round(sum('totalRevenue') * 100) / 100,
    },
  };
}

/** Live park map: zones (guests, capacity, level) + rides (status, queue, wait). */
export async function liveMap(db: Db, branchId: string) {
  const s = await parkSettings(branchId, db);
  const zones = await query<any>(
    `SELECT z.*, (SELECT COUNT(DISTINCT c.account_id)::int FROM credentials c JOIN credential_links l ON l.credential_id=c.id AND l.unlinked_at IS NULL
                   JOIN tickets t ON t.id=l.ticket_id AND t.presence='INSIDE'
                  WHERE c.last_zone_id=z.id AND c.last_seen_at > now() - interval '90 minutes') +
                 (SELECT COUNT(*)::int FROM tickets t JOIN credentials c ON c.id=t.credential_id
                  WHERE t.presence='INSIDE' AND c.last_zone_id=z.id AND c.last_seen_at > now() - interval '90 minutes') AS guests
       FROM zones z WHERE z.branch_id=$1 AND z.is_active ORDER BY z.sort`,
    [branchId],
    db,
  );
  const occ = await occupancy(db, branchId);
  const rides = await rideBoard(db, branchId);
  // Guests not seen in any zone yet are attributed to the entrance zone (sort 0) so totals add up.
  const seen = zones.reduce((s0, z) => s0 + z.guests, 0);
  if (zones.length && occ.inside > seen) zones[0].guests += occ.inside - seen;
  return {
    occupancy: occ,
    zones: zones.map((z) => ({ ...z, level: loadLevel(z.guests, z.capacity, s.park.busyPct, s.park.crowdedPct) })),
    rides: rides.map((r) => ({ ...r, level: r.status !== 'OPEN' ? 'CLOSED' : r.wait_minutes >= 30 ? 'CROWDED' : r.wait_minutes >= 15 ? 'BUSY' : 'NORMAL' })),
  };
}
