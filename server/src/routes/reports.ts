import type { FastifyInstance, FastifyReply } from 'fastify';
import ExcelJS from 'exceljs';
import { one, query } from '../db/pool';
import { audit } from '../lib/audit';
import { branchOf, requireStaff } from '../lib/auth';
import { badRequest, forbidden } from '../lib/errors';
import { parse, uuid, z } from '../lib/validate';

type Col = { key: string; label: string; type?: 'money' | 'number' | 'text' | 'datetime' | 'percent' };
interface Report {
  title: string;
  columns: Col[];
  rows: any[];
}

const filterSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hourFrom: z.coerce.number().int().min(0).max(23).optional(),
  hourTo: z.coerce.number().int().min(0).max(23).optional(),
  kioskId: uuid.optional(),
  method: z.enum(['QR', 'CASH', 'CARD', 'OTHER']).optional(),
  categoryId: uuid.optional(),
  productId: uuid.optional(),
  format: z.enum(['json', 'csv', 'xlsx']).default('json'),
});
type Filters = z.infer<typeof filterSchema> & { branchId: string; tz: string };

const PAID = `('PAID','PARTIALLY_REFUNDED','REFUNDED')`;

/** Shared WHERE for paid orders in the local-date range; returns SQL + params ($1 = branch, $2 = tz). */
function orderWhere(f: Filters, dateCol = 'o.paid_at') {
  const params: unknown[] = [f.branchId, f.tz];
  // $2 (time zone) is always referenced so Postgres can type it even without date filters.
  const w = ['o.branch_id = $1', '$2::text IS NOT NULL'];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    w.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (f.from) add(`(${dateCol} AT TIME ZONE $2)::date >= ?::date`, f.from);
  if (f.to) add(`(${dateCol} AT TIME ZONE $2)::date <= ?::date`, f.to);
  if (f.hourFrom != null) add(`extract(hour from ${dateCol} AT TIME ZONE $2) >= ?`, f.hourFrom);
  if (f.hourTo != null) add(`extract(hour from ${dateCol} AT TIME ZONE $2) <= ?`, f.hourTo);
  if (f.kioskId) add('o.kiosk_id = ?', f.kioskId);
  if (f.method) add('o.payment_method = ?', f.method);
  if (f.categoryId) add('EXISTS (SELECT 1 FROM order_items x WHERE x.order_id=o.id AND x.category_id = ?)', f.categoryId);
  if (f.productId) add('EXISTS (SELECT 1 FROM order_items x WHERE x.order_id=o.id AND x.product_id = ?)', f.productId);
  return { where: w.join(' AND '), params };
}

const nameExpr = (col: string) => `COALESCE(${col}->>'th', ${col}->>'en', ${col}->>'zh')`;

const REPORTS: Record<string, (f: Filters) => Promise<Report>> = {
  'daily-sales': async (f) => {
    const { where, params } = orderWhere(f);
    return {
      title: 'Daily Sales',
      columns: [
        { key: 'date', label: 'Date' }, { key: 'orders', label: 'Orders', type: 'number' }, { key: 'gross', label: 'Gross', type: 'money' },
        { key: 'discount', label: 'Discount', type: 'money' }, { key: 'service_charge', label: 'Service', type: 'money' }, { key: 'vat', label: 'VAT', type: 'money' },
        { key: 'net', label: 'Net Sales', type: 'money' }, { key: 'refunded', label: 'Refunded', type: 'money' }, { key: 'aov', label: 'AOV', type: 'money' },
      ],
      rows: await query(
        `SELECT to_char((o.paid_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS date, COUNT(*)::int AS orders, SUM(o.subtotal) AS gross, SUM(o.discount) AS discount,
                SUM(o.service_charge) AS service_charge, SUM(o.vat) AS vat, SUM(o.total) AS net, SUM(o.refunded_amount) AS refunded, ROUND(AVG(o.total), 2) AS aov
           FROM orders o WHERE ${where} AND o.payment_status IN ${PAID} GROUP BY 1 ORDER BY 1`,
        params,
      ),
    };
  },
  'hourly-sales': async (f) => {
    const { where, params } = orderWhere(f);
    return {
      title: 'Hourly Sales',
      columns: [{ key: 'hour', label: 'Hour' }, { key: 'orders', label: 'Orders', type: 'number' }, { key: 'net', label: 'Sales', type: 'money' }, { key: 'aov', label: 'AOV', type: 'money' }],
      rows: await query(
        `SELECT lpad(extract(hour from o.paid_at AT TIME ZONE $2)::text, 2, '0') || ':00' AS hour, COUNT(*)::int AS orders, SUM(o.total) AS net, ROUND(AVG(o.total),2) AS aov
           FROM orders o WHERE ${where} AND o.payment_status IN ${PAID} GROUP BY 1 ORDER BY 1`,
        params,
      ),
    };
  },
  'product-sales': async (f) => {
    const { where, params } = orderWhere(f);
    return {
      title: 'Product Sales',
      columns: [
        { key: 'sku', label: 'SKU' }, { key: 'name', label: 'Product' }, { key: 'qty', label: 'Qty', type: 'number' }, { key: 'sales', label: 'Sales', type: 'money' },
        { key: 'discount', label: 'Discount', type: 'money' }, { key: 'cost', label: 'Cost', type: 'money' }, { key: 'profit', label: 'Gross Profit', type: 'money' },
      ],
      rows: await query(
        `SELECT oi.sku, ${nameExpr('oi.name')} AS name, SUM(oi.qty)::int AS qty, SUM(oi.line_total) AS sales, SUM(oi.discount) AS discount,
                SUM(oi.cost * oi.qty) AS cost, SUM(oi.line_total - oi.discount - oi.cost * oi.qty) AS profit
           FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE ${where} AND o.payment_status IN ${PAID}
          GROUP BY oi.product_id, oi.sku, 2 ORDER BY qty DESC`,
        params,
      ),
    };
  },
  'category-sales': async (f) => {
    const { where, params } = orderWhere(f);
    return {
      title: 'Category Sales',
      columns: [{ key: 'name', label: 'Category' }, { key: 'qty', label: 'Qty', type: 'number' }, { key: 'sales', label: 'Sales', type: 'money' }, { key: 'share', label: 'Share %', type: 'percent' }],
      rows: await query(
        `SELECT ${nameExpr('c.name')} AS name, SUM(oi.qty)::int AS qty, SUM(oi.line_total - oi.discount) AS sales,
                ROUND(100.0 * SUM(oi.line_total - oi.discount) / NULLIF(SUM(SUM(oi.line_total - oi.discount)) OVER (), 0), 1) AS share
           FROM order_items oi JOIN orders o ON o.id=oi.order_id LEFT JOIN categories c ON c.id=oi.category_id
          WHERE ${where} AND o.payment_status IN ${PAID} GROUP BY c.id, 1 ORDER BY sales DESC`,
        params,
      ),
    };
  },
  payments: async (f) => {
    const { where, params } = orderWhere(f);
    return {
      title: 'Payment Report',
      columns: [{ key: 'method', label: 'Method' }, { key: 'provider', label: 'Provider' }, { key: 'count', label: 'Transactions', type: 'number' }, { key: 'amount', label: 'Amount', type: 'money' }],
      rows: await query(
        `SELECT p.method, p.provider, COUNT(*)::int AS count, SUM(p.amount) AS amount FROM payments p JOIN orders o ON o.id=p.order_id
          WHERE ${where} AND p.status='PAID' GROUP BY 1,2 ORDER BY amount DESC`,
        params,
      ),
    };
  },
  cash: (f) => paymentList({ ...f, method: 'CASH' }, 'Cash Report'),
  transfer: (f) => paymentList({ ...f, method: 'QR' }, 'Transfer / QR Report'),
  card: (f) => paymentList({ ...f, method: 'CARD' }, 'Card Report'),
  orders: async (f) => {
    const { where, params } = orderWhere(f, 'o.created_at');
    return {
      title: 'Order Report',
      columns: [
        { key: 'order_number', label: 'Order #' }, { key: 'created_at', label: 'Created', type: 'datetime' }, { key: 'order_type', label: 'Type' },
        { key: 'kiosk', label: 'Kiosk' }, { key: 'status', label: 'Status' }, { key: 'payment_method', label: 'Payment' }, { key: 'payment_status', label: 'Payment Status' },
        { key: 'items', label: 'Items', type: 'number' }, { key: 'total', label: 'Total', type: 'money' },
      ],
      rows: await query(
        `SELECT o.order_number, o.created_at, o.order_type, COALESCE(k.code, o.source) AS kiosk, o.status, o.payment_method, o.payment_status,
                (SELECT SUM(qty)::int FROM order_items WHERE order_id=o.id) AS items, o.total
           FROM orders o LEFT JOIN kiosks k ON k.id=o.kiosk_id WHERE ${where} ORDER BY o.created_at DESC LIMIT 5000`,
        params,
      ),
    };
  },
  cancelled: async (f) => {
    const { where, params } = orderWhere(f, 'o.created_at');
    return {
      title: 'Cancelled Orders',
      columns: [
        { key: 'order_number', label: 'Order #' }, { key: 'created_at', label: 'Created', type: 'datetime' }, { key: 'cancelled_at', label: 'Cancelled', type: 'datetime' },
        { key: 'reason', label: 'Reason' }, { key: 'was_paid', label: 'Was Paid' }, { key: 'total', label: 'Total', type: 'money' },
      ],
      rows: await query(
        `SELECT o.order_number, o.created_at, o.cancelled_at, o.cancel_reason AS reason, CASE WHEN o.payment_status='VOID' THEN 'YES' ELSE 'NO' END AS was_paid, o.total
           FROM orders o WHERE ${where} AND o.status='CANCELLED' ORDER BY o.cancelled_at DESC`,
        params,
      ),
    };
  },
  refunds: async (f) => {
    const { where, params } = orderWhere(f, 'r.created_at');
    return {
      title: 'Refund Report',
      columns: [
        { key: 'order_number', label: 'Order #' }, { key: 'created_at', label: 'Refunded At', type: 'datetime' }, { key: 'amount', label: 'Amount', type: 'money' },
        { key: 'method', label: 'Method' }, { key: 'reason', label: 'Reason' }, { key: 'staff', label: 'By' }, { key: 'approver', label: 'Approved By' },
      ],
      rows: await query(
        `SELECT o.order_number, r.created_at, r.amount, r.method, r.reason, u.name AS staff, a.name AS approver
           FROM refunds r JOIN orders o ON o.id=r.order_id LEFT JOIN users u ON u.id=r.created_by LEFT JOIN users a ON a.id=r.approved_by
          WHERE ${where} ORDER BY r.created_at DESC`,
        params,
      ),
    };
  },
  promotions: async (f) => {
    const { where, params } = orderWhere(f);
    return {
      title: 'Promotion Report',
      columns: [{ key: 'name', label: 'Promotion' }, { key: 'type', label: 'Type' }, { key: 'code', label: 'Code' }, { key: 'orders', label: 'Orders', type: 'number' }, { key: 'discount', label: 'Discount Given', type: 'money' }],
      rows: await query(
        `SELECT ${nameExpr("p->'name'")} AS name, p->>'type' AS type, p->>'code' AS code, COUNT(*)::int AS orders, SUM((p->>'amount')::numeric) AS discount
           FROM orders o, jsonb_array_elements(o.applied_promotions) p WHERE ${where} AND o.payment_status IN ${PAID}
          GROUP BY p->>'promotionId', 1, 2, 3 ORDER BY discount DESC`,
        params,
      ),
    };
  },
  'kiosk-performance': async (f) => {
    const { where, params } = orderWhere(f, 'o.created_at');
    return {
      title: 'Kiosk Performance',
      columns: [
        { key: 'kiosk', label: 'Kiosk' }, { key: 'orders', label: 'Orders', type: 'number' }, { key: 'paid', label: 'Paid', type: 'number' }, { key: 'cancelled', label: 'Cancelled', type: 'number' },
        { key: 'conversion', label: 'Paid %', type: 'percent' }, { key: 'sales', label: 'Sales', type: 'money' }, { key: 'aov', label: 'AOV', type: 'money' },
      ],
      rows: await query(
        `SELECT COALESCE(k.code, 'POS / Counter') AS kiosk, COUNT(*)::int AS orders, COUNT(*) FILTER (WHERE o.payment_status IN ${PAID})::int AS paid,
                COUNT(*) FILTER (WHERE o.status='CANCELLED')::int AS cancelled,
                ROUND(100.0 * COUNT(*) FILTER (WHERE o.payment_status IN ${PAID}) / NULLIF(COUNT(*),0), 1) AS conversion,
                COALESCE(SUM(o.total) FILTER (WHERE o.payment_status IN ${PAID}),0) AS sales,
                ROUND(AVG(o.total) FILTER (WHERE o.payment_status IN ${PAID}), 2) AS aov
           FROM orders o LEFT JOIN kiosks k ON k.id=o.kiosk_id WHERE ${where} GROUP BY 1 ORDER BY sales DESC`,
        params,
      ),
    };
  },
  'kitchen-time': async (f) => {
    const { where, params } = orderWhere(f);
    return {
      title: 'Kitchen Preparation Time',
      columns: [
        { key: 'station', label: 'Station' }, { key: 'tickets', label: 'Tickets', type: 'number' }, { key: 'avg_wait_start', label: 'Avg wait to start (min)', type: 'number' },
        { key: 'avg_prep', label: 'Avg prep (min)', type: 'number' }, { key: 'avg_total', label: 'Avg paid→ready (min)', type: 'number' }, { key: 'max_total', label: 'Max paid→ready (min)', type: 'number' },
      ],
      rows: await query(
        `SELECT ${nameExpr('ks.name')} AS station, COUNT(*)::int AS tickets,
                ROUND(AVG(extract(epoch from ko.started_at - o.paid_at))/60, 1) AS avg_wait_start,
                ROUND(AVG(extract(epoch from ko.ready_at - ko.started_at))/60, 1) AS avg_prep,
                ROUND(AVG(extract(epoch from ko.ready_at - o.paid_at))/60, 1) AS avg_total,
                ROUND(MAX(extract(epoch from ko.ready_at - o.paid_at))/60, 1) AS max_total
           FROM kitchen_orders ko JOIN orders o ON o.id=ko.order_id JOIN kitchen_stations ks ON ks.id=ko.station_id
          WHERE ${where} AND ko.ready_at IS NOT NULL GROUP BY ks.id, 1 ORDER BY 1`,
        params,
      ),
    };
  },
  aov: async (f) => {
    const { where, params } = orderWhere(f);
    return {
      title: 'Average Order Value',
      columns: [{ key: 'date', label: 'Date' }, { key: 'orders', label: 'Orders', type: 'number' }, { key: 'aov', label: 'AOV', type: 'money' }, { key: 'items_per_order', label: 'Items / Order', type: 'number' }],
      rows: await query(
        `SELECT to_char((o.paid_at AT TIME ZONE $2)::date,'YYYY-MM-DD') AS date, COUNT(*)::int AS orders, ROUND(AVG(o.total),2) AS aov,
                ROUND(AVG((SELECT SUM(qty) FROM order_items WHERE order_id=o.id)), 2) AS items_per_order
           FROM orders o WHERE ${where} AND o.payment_status IN ${PAID} GROUP BY 1 ORDER BY 1`,
        params,
      ),
    };
  },
};

async function paymentList(f: Filters, title: string): Promise<Report> {
  const { where, params } = orderWhere(f, 'p.paid_at');
  return {
    title,
    columns: [
      { key: 'paid_at', label: 'Paid At', type: 'datetime' }, { key: 'order_number', label: 'Order #' }, { key: 'provider', label: 'Provider' },
      { key: 'amount', label: 'Amount', type: 'money' }, { key: 'received_amount', label: 'Received', type: 'money' }, { key: 'change_amount', label: 'Change', type: 'money' },
      { key: 'reference', label: 'Reference' }, { key: 'card', label: 'Card' }, { key: 'confirmed_by', label: 'Confirmed By' },
    ],
    rows: await query(
      `SELECT p.paid_at, o.order_number, p.provider, p.amount, p.received_amount, p.change_amount, COALESCE(p.reference, p.approval_code) AS reference,
              CASE WHEN p.card_last4 IS NOT NULL THEN COALESCE(p.card_brand,'') || ' ****' || p.card_last4 END AS card, u.name AS confirmed_by
         FROM payments p JOIN orders o ON o.id=p.order_id LEFT JOIN users u ON u.id=p.confirmed_by
        WHERE ${where.replace('o.payment_method', 'p.method')} AND p.status='PAID' ORDER BY p.paid_at DESC`,
      params,
    ),
  };
}

function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

async function sendReport(reply: FastifyReply, r: Report, format: 'json' | 'csv' | 'xlsx', name: string) {
  if (format === 'json') return r;
  const filename = `${name}-${new Date().toISOString().slice(0, 10)}`;
  if (format === 'csv') {
    const lines = [r.columns.map((c) => csvCell(c.label)).join(','), ...r.rows.map((row) => r.columns.map((c) => csvCell(row[c.key])).join(','))];
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return '﻿' + lines.join('\r\n');
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(r.title.slice(0, 30));
  ws.columns = r.columns.map((c) => ({ header: c.label, key: c.key, width: Math.max(12, c.label.length + 4), style: c.type === 'money' ? { numFmt: '#,##0.00' } : {} }));
  ws.getRow(1).font = { bold: true };
  for (const row of r.rows) ws.addRow(Object.fromEntries(r.columns.map((c) => [c.key, c.type === 'money' || c.type === 'number' || c.type === 'percent' ? (row[c.key] == null ? null : Number(row[c.key])) : row[c.key] instanceof Date ? row[c.key] : row[c.key]])));
  const buf = await wb.xlsx.writeBuffer();
  reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
  return Buffer.from(buf as ArrayBuffer);
}

export default async function reportRoutes(app: FastifyInstance) {
  app.get('/dashboard', { preHandler: requireStaff('dashboard.view') }, async (req) => {
    const branchId = branchOf(req);
    const b = await one<any>(`SELECT timezone FROM branches WHERE id=$1`, [branchId]);
    const tz = b?.timezone ?? 'Asia/Bangkok';
    const today = `(o.paid_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`;
    const [summary, best, categories, hourly, statuses, kiosks, printers, pending, agents] = await Promise.all([
      one<any>(
        `SELECT COALESCE(SUM(o.total),0) AS sales, COUNT(*)::int AS orders, COALESCE(ROUND(AVG(o.total),2),0) AS aov, COUNT(*)::int AS customers,
                COALESCE(SUM(o.total) FILTER (WHERE o.payment_method='CASH'),0) AS cash, COALESCE(SUM(o.total) FILTER (WHERE o.payment_method='QR'),0) AS transfer,
                COALESCE(SUM(o.total) FILTER (WHERE o.payment_method='CARD'),0) AS card, COALESCE(SUM(o.total) FILTER (WHERE o.payment_method='OTHER'),0) AS other,
                COALESCE(SUM(o.refunded_amount),0) AS refunded
           FROM orders o WHERE o.branch_id=$1 AND o.payment_status IN ${PAID} AND ${today}`,
        [branchId, tz],
      ),
      query(
        `SELECT ${nameExpr('oi.name')} AS name, oi.name AS name_i18n, SUM(oi.qty)::int AS qty, SUM(oi.line_total) AS sales
           FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.branch_id=$1 AND o.payment_status IN ${PAID} AND ${today}
          GROUP BY oi.product_id, oi.name ORDER BY qty DESC LIMIT 8`,
        [branchId, tz],
      ),
      query(
        `SELECT ${nameExpr('c.name')} AS name, SUM(oi.line_total - oi.discount) AS sales, SUM(oi.qty)::int AS qty
           FROM order_items oi JOIN orders o ON o.id=oi.order_id LEFT JOIN categories c ON c.id=oi.category_id
          WHERE o.branch_id=$1 AND o.payment_status IN ${PAID} AND ${today} GROUP BY c.id, 1 ORDER BY sales DESC`,
        [branchId, tz],
      ),
      query(
        `SELECT extract(hour from o.paid_at AT TIME ZONE $2)::int AS hour, COUNT(*)::int AS orders, SUM(o.total) AS sales
           FROM orders o WHERE o.branch_id=$1 AND o.payment_status IN ${PAID} AND ${today} GROUP BY 1 ORDER BY 1`,
        [branchId, tz],
      ),
      query(
        `SELECT status, COUNT(*)::int AS n FROM orders o WHERE branch_id=$1 AND (o.created_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date GROUP BY status`,
        [branchId, tz],
      ),
      query(
        `SELECT id, code, name, app_version, last_seen_at, CASE WHEN last_seen_at > now() - interval '90 seconds' THEN 'ONLINE' ELSE 'OFFLINE' END AS status
           FROM kiosks WHERE branch_id=$1 AND is_active ORDER BY code`,
        [branchId],
      ),
      query(`SELECT id, name, type, connection, status, last_error, last_seen_at, is_enabled FROM printers WHERE branch_id=$1 ORDER BY type, name`, [branchId]),
      one<any>(`SELECT COUNT(*)::int AS n FROM payment_verifications v JOIN orders o ON o.id=v.order_id WHERE o.branch_id=$1 AND v.status='WAITING_VERIFICATION'`, [branchId]),
      query(`SELECT id, name, status, last_seen_at, version FROM print_agents WHERE branch_id=$1`, [branchId]),
    ]);
    return { summary, bestSellers: best, categories, hourly, statuses, kiosks, printers, agents, pendingVerifications: pending?.n ?? 0, timezone: tz };
  });

  app.get('/:type', { preHandler: requireStaff('reports.view') }, async (req, reply) => {
    const { type } = parse(z.object({ type: z.string() }), req.params);
    const gen = REPORTS[type];
    if (!gen) throw badRequest('UNKNOWN_REPORT', `Available: ${Object.keys(REPORTS).join(', ')}`);
    const f = parse(filterSchema, req.query);
    if (f.format !== 'json' && !req.staff!.permissions.has('reports.export')) throw forbidden('PERMISSION_DENIED', 'Missing permission: reports.export');
    const branchId = branchOf(req);
    const b = await one<any>(`SELECT timezone FROM branches WHERE id=$1`, [branchId]);
    const report = await gen({ ...f, branchId, tz: b?.timezone ?? 'Asia/Bangkok' });
    if (f.format !== 'json') await audit(req, { action: 'REPORT_EXPORT', entity: 'report', entityId: type, newValue: { ...f } });
    return sendReport(reply, report, f.format, type);
  });

  app.get('/', { preHandler: requireStaff('reports.view') }, async () => Object.keys(REPORTS));
}
