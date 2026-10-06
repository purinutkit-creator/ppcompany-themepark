import crypto from 'node:crypto';
import {
  buildCardDoc,
  buildParkReceiptDoc,
  buildQueueSlipDoc,
  buildShiftReportDoc,
  buildTicketDoc,
  buildWristbandDoc,
  fontForLang,
  tr,
  type FontSpec,
  type I18nText,
  type Lang,
  type ParkPrintSale,
  type PrintDoc,
  type PrintJobPayload,
  type ShiftReport,
  type StoreInfo,
} from '@kiosk/shared';
import { config } from '../../config';
import { one, query, type Db, type Tx } from '../../db/pool';
import { conflict } from '../../lib/errors';
import type { Outbox } from '../../lib/realtime';
import { getSettings, type Settings } from '../../lib/settings';
import { notifyJob, storeInfo } from '../printing';
import { payloadsFor } from './credentials';
import { branchInfo, pickLang } from './common';

export function parkStoreInfo(s: Settings, logo = true): StoreInfo {
  const base = storeInfo(s);
  return { ...base, name: s.park.name ?? base.name, logoUrl: logo ? s.park.logoUrl || base.logoUrl || null : null };
}

/** Resolve a printer: explicit → store printer → branch default of the type → any receipt printer. */
export async function resolveParkPrinter(db: Db, branchId: string, o: { printerId?: string | null; storeId?: string | null; type?: string }) {
  if (o.printerId) {
    const p = await one<any>(`SELECT id FROM printers WHERE id=$1 AND is_enabled`, [o.printerId], db);
    if (p) return p.id as string;
  }
  if (o.storeId && (!o.type || o.type === 'RECEIPT')) {
    const p = await one<any>(`SELECT p.id FROM stores s JOIN printers p ON p.id=s.receipt_printer_id WHERE s.id=$1 AND p.is_enabled`, [o.storeId], db);
    if (p) return p.id as string;
  }
  const type = o.type ?? 'RECEIPT';
  const p = await one<any>(
    `SELECT id FROM printers WHERE branch_id=$1 AND type=$2 AND is_enabled ORDER BY is_default DESC, created_at LIMIT 1`,
    [branchId, type],
    db,
  );
  if (p) return p.id as string;
  if (type !== 'RECEIPT') return resolveParkPrinter(db, branchId, { type: 'RECEIPT' });
  return null;
}

export async function queueDoc(
  c: Db,
  j: { branchId: string; printerId: string; doc: PrintDoc; title: string; dedupe: string; saleId?: string | null; font?: FontSpec | null; language: Lang; reprint?: boolean; requestedBy?: string | null },
  out?: Outbox,
) {
  const s = await getSettings(c);
  const payload: PrintJobPayload = { documentType: 'DOC', doc: j.doc, store: parkStoreInfo(s), language: j.language, copyNo: 1, isReprint: !!j.reprint, font: j.font ?? null, title: j.title };
  const row = await one<any>(
    `INSERT INTO print_jobs (branch_id, sale_id, printer_id, document_type, payload, dedupe_key, requested_by, max_attempts)
     VALUES ($1,$2,$3,'DOC',$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id, printer_id, document_type, status, order_id`,
    [j.branchId, j.saleId ?? null, j.printerId, JSON.stringify(payload), j.dedupe, j.requestedBy ?? null, s.printing.retryMaxAttempts],
    c,
  );
  if (row && out) notifyJob(out, j.branchId, row);
  return row;
}

/** Data for a park receipt (thermal / A4 / customer screen all use this). */
export async function saleReceiptData(db: Db, saleId: string): Promise<ParkPrintSale & { language: Lang; branchId: string }> {
  const s = await one<any>(
    `SELECT s.*, b.name AS branch_name, b.code AS branch_code, b.timezone, st.name AS store_name, u.name AS cashier_name, m.member_no, m.points AS member_points,
            bk.booking_no, w.balance AS wallet_balance
       FROM sales s JOIN branches b ON b.id=s.branch_id LEFT JOIN stores st ON st.id=s.store_id LEFT JOIN users u ON u.id=s.created_by
       LEFT JOIN members m ON m.id=s.member_id LEFT JOIN bookings bk ON bk.sale_id=s.id LEFT JOIN wallet_accounts w ON w.account_id=s.account_id
      WHERE s.id=$1`,
    [saleId],
    db,
  );
  const items = await query<any>(`SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY sort`, [saleId], db);
  const pays = await query<any>(`SELECT * FROM sale_payments WHERE sale_id=$1 AND status IN ('PAID','REFUNDED','PARTIALLY_REFUNDED') ORDER BY created_at`, [saleId], db);
  const lang = pickLang(s.language);
  return {
    language: lang,
    branchId: s.branch_id,
    saleNo: s.sale_no,
    bookingNo: s.booking_no,
    branchName: (s.branch_name as I18nText)?.[lang] ?? s.branch_code,
    storeName: s.store_name,
    createdAt: new Date(s.created_at).toISOString(),
    paidAt: s.paid_at ? new Date(s.paid_at).toISOString() : null,
    timeZone: s.timezone,
    cashier: s.cashier_name,
    customer: s.customer_name,
    memberNo: s.member_no,
    items: items.map((i) => ({
      name: i.name,
      qty: i.qty,
      unitPrice: Number(i.unit_price),
      total: Number(i.line_total),
      note: i.meta?.lockerCode ? `Locker ${i.meta.lockerCode}` : i.meta?.visitDate ? `${i.meta.visitDate}` : null,
    })),
    subtotal: Number(s.subtotal),
    discount: Number(s.discount),
    vat: Number(s.vat),
    total: Number(s.total),
    promotions: ((s.applied_promotions ?? []) as any[]).map((a) => ({ name: a.name, amount: Number(a.amount) })),
    payments: pays.map((p) => ({ method: p.method, amount: Number(p.amount), received: p.received_amount == null ? null : Number(p.received_amount), change: p.change_amount == null ? null : Number(p.change_amount), reference: p.reference ?? p.approval_code ?? null })),
    walletBalance: s.account_id ? Number(s.wallet_balance ?? 0) : null,
    pointsEarned: s.points_earned || null,
    pointsBalance: s.member_id ? Number(s.member_points) : null,
    lookupUrl: `${config.publicUrl}/r/${s.id}`,
  };
}

/**
 * Receipts for a completed sale: one CUSTOMER copy and one STAFF copy (configurable), plus admission
 * tickets for counter / kiosk sales. Skipped when the sale has no printer (online / portal sales).
 */
export async function printSaleDocuments(c: Tx, sale: any, out: Outbox, o: { reprint?: boolean; requestedBy?: string | null; only?: 'RECEIPT' | 'TICKETS' } = {}) {
  if (['ONLINE', 'PORTAL'].includes(sale.channel) && !o.reprint) return [];
  const s = await getSettings(c);
  const printerId = await resolveParkPrinter(c, sale.branch_id, { printerId: sale.printer_id, storeId: sale.store_id });
  if (!printerId) return [];
  const data = await saleReceiptData(c, sale.id);
  const lang = data.language;
  const font = fontForLang(s.fonts.receipt, lang);
  const jobs: any[] = [];
  const nonce = o.reprint ? `:${crypto.randomUUID()}` : '';
  const store = parkStoreInfo(s);
  const hasCash = data.payments.some((p) => p.method === 'CASH');
  if (o.only !== 'TICKETS') {
    const copies: ('CUSTOMER' | 'STAFF')[] = [];
    if (s.parkReceipt.customerCopy) copies.push('CUSTOMER');
    if (s.parkReceipt.staffCopy && ['COUNTER', 'POS', 'RIDE', 'LOCKER'].includes(sale.channel)) copies.push('STAFF');
    for (const copy of copies) {
      const doc = buildParkReceiptDoc(data, store, lang, { copy, reprint: o.reprint, footer: s.parkReceipt.footer, showQr: s.parkReceipt.showQr, openDrawer: hasCash && copy === 'CUSTOMER' && !o.reprint });
      jobs.push(await queueDoc(c, { branchId: sale.branch_id, printerId, doc, title: `Receipt ${sale.sale_no} (${copy.toLowerCase()} copy)`, dedupe: `sale:${sale.id}:receipt:${copy}${nonce}`, saleId: sale.id, font, language: lang, reprint: o.reprint, requestedBy: o.requestedBy }, out));
    }
  }
  if (o.only !== 'RECEIPT' && s.parkReceipt.printTickets && ['COUNTER', 'KIOSK'].includes(sale.channel)) {
    const tPrinter = (await resolveParkPrinter(c, sale.branch_id, { type: 'TICKET' })) ?? printerId;
    const tickets = await ticketPrintData(c, sale.id);
    const tFont = fontForLang(s.fonts.ticket, lang);
    for (const t of tickets) {
      const doc = buildTicketDoc({ ...t, terms: s.parkReceipt.ticketTerms }, store, lang, { reprint: o.reprint, timeZone: data.timeZone });
      jobs.push(await queueDoc(c, { branchId: sale.branch_id, printerId: tPrinter, doc, title: `Ticket ${t.ticketNo}`, dedupe: `ticket:${t.ticketNo}${nonce}`, saleId: sale.id, font: tFont, language: lang, reprint: o.reprint, requestedBy: o.requestedBy }, out));
    }
  }
  return jobs.filter(Boolean);
}

export async function ticketPrintData(db: Db, saleId: string) {
  const rows = await query<any>(
    `SELECT t.*, p.name AS package_name, tt.name AS ticket_type_name, c.code AS credential_code, c.token_version, bk.booking_no
       FROM tickets t JOIN packages p ON p.id=t.package_id LEFT JOIN ticket_types tt ON tt.id=t.ticket_type_id
       LEFT JOIN credentials c ON c.id=t.credential_id LEFT JOIN bookings bk ON bk.id=t.booking_id
      WHERE t.sale_id=$1 AND t.status IN ('ACTIVE','PAID','UNPAID') ORDER BY t.ticket_no`,
    [saleId],
    db,
  );
  return rows.map((t) => {
    const pl = payloadsFor({ code: t.credential_code ?? t.ticket_no, token_version: t.token_version ?? 1 });
    return {
      ticketNo: t.ticket_no, bookingNo: t.booking_no, packageName: t.package_name, ticketType: t.ticket_type_name, guestName: t.guest_name,
      visitDate: String(t.valid_from).slice(0, 10), validTo: String(t.valid_to).slice(0, 10), qr: pl.qr, barcode: pl.barcode, price: Number(t.price),
    };
  });
}

/** Print a wristband / card for a credential (template from Settings → Receipt & ticket). */
export async function printCredential(c: Db, credentialId: string, o: { printerId?: string | null; kind: 'WRISTBAND' | 'CARD'; language?: Lang; requestedBy?: string | null }, out?: Outbox) {
  const s = await getSettings(c);
  const cred = await one<any>(`SELECT * FROM credentials WHERE id=$1`, [credentialId], c);
  if (!cred) throw conflict('NOT_FOUND');
  const ticket = await one<any>(
    `SELECT t.visit_date::text AS visit_date, p.name AS package_name, tt.name AS ticket_type_name, t.guest_name FROM credential_links l JOIN tickets t ON t.id=l.ticket_id
       JOIN packages p ON p.id=t.package_id LEFT JOIN ticket_types tt ON tt.id=t.ticket_type_id WHERE l.credential_id=$1 AND l.unlinked_at IS NULL ORDER BY t.visit_date DESC LIMIT 1`,
    [credentialId],
    c,
  );
  const member = cred.member_id ? await one<any>(`SELECT m.first_name, m.last_name, t.name AS tier_name FROM members m LEFT JOIN member_tiers t ON t.id=m.tier_id WHERE m.id=$1`, [cred.member_id], c) : null;
  const lang = o.language ?? (s.ui.staffDefaultLanguage as Lang);
  const pl = payloadsFor(cred);
  const store = parkStoreInfo(s);
  const type = o.kind === 'WRISTBAND' ? 'WRISTBAND' : 'RECEIPT';
  const printerId = await resolveParkPrinter(c, cred.branch_id ?? (await one<any>(`SELECT id FROM branches ORDER BY created_at LIMIT 1`, [], c)).id, { printerId: o.printerId, type });
  if (!printerId) throw conflict('NO_PRINTER', 'No printer configured');
  const doc =
    o.kind === 'WRISTBAND'
      ? buildWristbandDoc({ code: cred.code, qr: pl.qr, barcode: pl.barcode, ticketType: ticket?.ticket_type_name, packageName: ticket?.package_name, visitDate: ticket?.visit_date, name: ticket?.guest_name ?? cred.label }, s.parkReceipt.wristband as any, store, lang)
      : buildCardDoc({ code: cred.code, qr: pl.qr, barcode: pl.barcode, name: member ? `${member.first_name} ${member.last_name}` : cred.label, tier: member?.tier_name ?? null, expires: cred.expires_at ? String(cred.expires_at).slice(0, 10) : null }, store, lang);
  await query(`UPDATE credentials SET print_count=print_count+1 WHERE id=$1`, [credentialId], c);
  const font = fontForLang(o.kind === 'WRISTBAND' ? s.fonts.wristband : s.fonts.ticket, lang);
  const bId = cred.branch_id ?? (await one<any>(`SELECT branch_id FROM printers WHERE id=$1`, [printerId], c)).branch_id;
  return queueDoc(c, { branchId: bId, printerId, doc, title: `${o.kind === 'WRISTBAND' ? 'Wristband' : 'Card'} ${cred.code}`, dedupe: `cred:${cred.id}:${crypto.randomUUID()}`, font, language: lang, requestedBy: o.requestedBy }, out);
}

export async function printShiftReport(c: Db, report: ShiftReport, branchId: string, printerId: string | null, language: Lang, out?: Outbox) {
  const s = await getSettings(c);
  const pid = await resolveParkPrinter(c, branchId, { printerId });
  if (!pid) return null;
  const doc = buildShiftReportDoc(report, parkStoreInfo(s, false), language);
  return queueDoc(c, { branchId, printerId: pid, doc, title: `Shift ${report.shiftNo}`, dedupe: `shift:${report.shiftNo}:${crypto.randomUUID()}`, font: fontForLang(s.fonts.receipt, language), language }, out);
}

export async function printQueueSlip(c: Db, q: { rideName: I18nText; queueNo: string; ahead: number; waitMinutes: number }, branchId: string, printerId: string | null, language: Lang, out?: Outbox) {
  const s = await getSettings(c);
  const pid = await resolveParkPrinter(c, branchId, { printerId });
  if (!pid) return null;
  const b = await branchInfo(branchId, c);
  const doc = buildQueueSlipDoc({ ...q, at: new Date().toISOString(), timeZone: b.timezone }, parkStoreInfo(s, false), language);
  return queueDoc(c, { branchId, printerId: pid, doc, title: `Queue ${q.queueNo}`, dedupe: `queue:${q.queueNo}:${crypto.randomUUID()}`, font: fontForLang(s.fonts.receipt, language), language }, out);
}

export const docTitle = (t: I18nText, lang: Lang) => tr(t, lang);
