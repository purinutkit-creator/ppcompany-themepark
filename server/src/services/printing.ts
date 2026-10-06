import crypto from 'node:crypto';
import { EVENTS, fontForLang, rooms, type Lang, type PrintJobPayload, type StoreInfo } from '@kiosk/shared';
import { one, query, tx, type Db, type Tx } from '../db/pool';
import { conflict, notFound } from '../lib/errors';
import { Outbox, publish } from '../lib/realtime';
import { getSettings, type Settings } from '../lib/settings';
import { config } from '../config';
import { addOrderEvent, buildPrintOrder } from './orders';

const KITCHEN_TYPES = ['KITCHEN', 'BEVERAGE', 'DESSERT', 'OTHER'];

export function storeInfo(s: Settings): StoreInfo {
  return {
    name: s.store.name,
    logoUrl: s.receipt.showLogo ? s.store.logoUrl || s.theme.logoUrl || null : null,
    address: s.store.address,
    phone: s.store.phone,
    taxId: s.store.taxId,
    currencySymbol: s.store.currencySymbol,
  };
}

function receiptLang(s: Settings, orderLang: Lang): Lang {
  return s.receipt.language === 'ORDER' ? orderLang : (s.receipt.language as Lang);
}

export function notifyJob(out: Outbox, branchId: string, job: { id: string; printer_id: string | null; document_type: string; status: string; order_id?: string | null }) {
  out.add([rooms.branchPrinters(branchId), rooms.branchAdmin(branchId)], EVENTS.PRINT_JOB_CREATED, {
    jobId: job.id,
    printerId: job.printer_id,
    documentType: job.document_type,
    status: job.status,
    orderId: job.order_id ?? null,
  });
}

async function insertJob(
  c: Tx,
  j: { branchId: string; orderId: string | null; orderNumber: string | null; printerId: string | null; stationId?: string | null; type: string; copyNo: number; reprint: boolean; payload: PrintJobPayload; dedupe: string; requestedBy?: string | null; maxAttempts: number },
) {
  return one<any>(
    `INSERT INTO print_jobs (branch_id, order_id, order_number, printer_id, station_id, document_type, copy_no, is_reprint, payload, dedupe_key, requested_by, max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id, printer_id, document_type, status, order_id`,
    [j.branchId, j.orderId, j.orderNumber, j.printerId, j.stationId ?? null, j.type, j.copyNo, j.reprint, JSON.stringify(j.payload), j.dedupe, j.requestedBy ?? null, j.maxAttempts],
    c,
  );
}

async function resolveReceiptPrinter(c: Db, branchId: string, kioskId: string | null): Promise<string | null> {
  if (kioskId) {
    const k = await one<any>(
      `SELECT p.id FROM kiosks k JOIN printers p ON p.id = k.receipt_printer_id WHERE k.id=$1 AND p.is_enabled`,
      [kioskId],
      c,
    );
    if (k) return k.id;
  }
  const p = await one<any>(
    `SELECT id FROM printers WHERE branch_id=$1 AND type='RECEIPT' AND is_enabled ORDER BY is_default DESC, created_at LIMIT 1`,
    [branchId],
    c,
  );
  return p?.id ?? null;
}

/**
 * Create receipt + kitchen tickets for a paid order. Routing: item printer → station printer →
 * default kitchen printer. Items for different stations/printers produce separate tickets, all
 * carrying the same customer order number. Deduped per (order, document, printer, station, copy).
 */
export async function createOrderPrintJobs(c: Tx, order: any, out: Outbox, s?: Settings) {
  const settings = s ?? (await getSettings(c));
  const created: any[] = [];
  const maxAttempts = settings.printing.retryMaxAttempts;
  const lookupUrl = `${config.publicUrl}/o/${order.id}`;
  const printOrder = await buildPrintOrder(order.id, c);

  if (settings.receipt.enabled && settings.receipt.copies > 0) {
    const printerId = await resolveReceiptPrinter(c, order.branch_id, order.kiosk_id);
    if (printerId) {
      for (let copy = 1; copy <= Math.min(10, settings.receipt.copies); copy++) {
        const payload: PrintJobPayload = {
          documentType: 'RECEIPT',
          order: printOrder,
          store: storeInfo(settings),
          language: receiptLang(settings, order.language),
          copyNo: copy,
          isReprint: false,
          receiptFooter: settings.receipt.footer,
          showQr: settings.receipt.showQr,
          lookupUrl,
          font: fontForLang(settings.fonts.receipt, receiptLang(settings, order.language)),
        };
        const j = await insertJob(c, {
          branchId: order.branch_id, orderId: order.id, orderNumber: order.order_number, printerId, type: 'RECEIPT', copyNo: copy,
          reprint: false, payload, dedupe: `order:${order.id}:RECEIPT:${copy}`, maxAttempts,
        });
        if (j) created.push(j);
      }
    } else await addOrderEvent(c, order.id, 'PRINT_SKIPPED', { document: 'RECEIPT', reason: 'No receipt printer configured' }, { type: 'SYSTEM' });
  }

  if (settings.kitchen.printEnabled && settings.kitchen.copies > 0) {
    const items = await query<any>(`SELECT id, station_id, printer_id FROM order_items WHERE order_id=$1`, [order.id], c);
    const printers = await query<any>(
      `SELECT id, type, station_id, is_default FROM printers WHERE branch_id=$1 AND is_enabled AND type = ANY($2) ORDER BY is_default DESC, created_at`,
      [order.branch_id, KITCHEN_TYPES],
      c,
    );
    const fallback = printers.find((p) => p.type === 'KITCHEN' && p.is_default) ?? printers.find((p) => p.type === 'KITCHEN') ?? printers[0];
    const groups = new Map<string, { printerId: string; stationId: string; itemIds: string[] }>();
    for (const it of items) {
      const printerId = it.printer_id ?? printers.find((p) => p.station_id === it.station_id)?.id ?? fallback?.id;
      if (!printerId) continue;
      const key = `${printerId}:${it.station_id}`;
      const g = groups.get(key) ?? { printerId, stationId: it.station_id as string, itemIds: [] as string[] };
      g.itemIds.push(it.id);
      groups.set(key, g);
    }
    if (!groups.size && items.length) {
      await addOrderEvent(c, order.id, 'PRINT_SKIPPED', { document: 'KITCHEN_TICKET', reason: 'No kitchen printer configured' }, { type: 'SYSTEM' });
    }
    for (const g of groups.values()) {
      const station = await one<any>(`SELECT name FROM kitchen_stations WHERE id=$1`, [g.stationId], c);
      const ticketOrder = await buildPrintOrder(order.id, c, null, g.itemIds);
      for (let copy = 1; copy <= Math.min(10, settings.kitchen.copies); copy++) {
        const payload: PrintJobPayload = {
          documentType: 'KITCHEN_TICKET',
          order: ticketOrder,
          stationName: station?.name ?? null,
          store: storeInfo(settings),
          language: settings.kitchen.ticketLanguage as Lang,
          copyNo: copy,
          isReprint: false,
          font: fontForLang(settings.fonts.kitchenTicket, settings.kitchen.ticketLanguage as Lang),
        };
        const j = await insertJob(c, {
          branchId: order.branch_id, orderId: order.id, orderNumber: order.order_number, printerId: g.printerId, stationId: g.stationId,
          type: 'KITCHEN_TICKET', copyNo: copy, reprint: false, payload, dedupe: `order:${order.id}:KITCHEN:${g.printerId}:${g.stationId}:${copy}`, maxAttempts,
        });
        if (j) created.push(j);
      }
    }
  }
  for (const j of created) notifyJob(out, order.branch_id, j);
  if (created.length) await addOrderEvent(c, order.id, 'PRINT_QUEUED', { jobs: created.length }, { type: 'SYSTEM' });
  return created;
}

/** Explicit reprint (new job, audited by caller). */
export async function reprint(orderId: string, kind: 'RECEIPT' | 'KITCHEN_TICKET', userId: string, printerId?: string | null) {
  const out = new Outbox();
  const res = await tx(async (c) => {
    const order = await one<any>(`SELECT * FROM orders WHERE id=$1`, [orderId], c);
    if (!order) throw notFound('Order');
    if (order.payment_status !== 'PAID' && order.payment_status !== 'PARTIALLY_REFUNDED') throw conflict('ORDER_NOT_PAID', 'Only paid orders can be reprinted');
    const settings = await getSettings(c);
    const jobs: any[] = [];
    if (kind === 'RECEIPT') {
      const pid = printerId ?? (await resolveReceiptPrinter(c, order.branch_id, order.kiosk_id));
      if (!pid) throw conflict('NO_PRINTER', 'No receipt printer configured');
      const payload: PrintJobPayload = {
        documentType: 'RECEIPT', order: await buildPrintOrder(orderId, c), store: storeInfo(settings),
        language: receiptLang(settings, order.language), copyNo: 1, isReprint: true, receiptFooter: settings.receipt.footer,
        showQr: settings.receipt.showQr, lookupUrl: `${config.publicUrl}/o/${order.id}`, font: fontForLang(settings.fonts.receipt, receiptLang(settings, order.language)),
      };
      jobs.push(await insertJob(c, { branchId: order.branch_id, orderId, orderNumber: order.order_number, printerId: pid, type: 'RECEIPT', copyNo: 1, reprint: true, payload, dedupe: `reprint:${crypto.randomUUID()}`, requestedBy: userId, maxAttempts: settings.printing.retryMaxAttempts }));
    } else {
      const original = await query<any>(
        `SELECT DISTINCT ON (printer_id, station_id) printer_id, station_id, payload FROM print_jobs WHERE order_id=$1 AND document_type='KITCHEN_TICKET' AND NOT is_reprint`,
        [orderId],
        c,
      );
      if (!original.length) throw conflict('NO_PRINTER', 'No kitchen tickets to reprint');
      for (const o of original) {
        const payload = { ...o.payload, isReprint: true };
        jobs.push(await insertJob(c, { branchId: order.branch_id, orderId, orderNumber: order.order_number, printerId: printerId ?? o.printer_id, stationId: o.station_id, type: 'KITCHEN_TICKET', copyNo: 1, reprint: true, payload, dedupe: `reprint:${crypto.randomUUID()}`, requestedBy: userId, maxAttempts: settings.printing.retryMaxAttempts }));
      }
    }
    for (const j of jobs) notifyJob(out, order.branch_id, j);
    await addOrderEvent(c, orderId, 'REPRINT', { kind, jobs: jobs.length }, { type: 'STAFF', id: userId });
    return jobs;
  });
  await out.flush();
  return res;
}

export async function testPrint(printerId: string, userId: string | null) {
  const out = new Outbox();
  const job = await tx(async (c) => {
    const p = await one<any>(`SELECT * FROM printers WHERE id=$1`, [printerId], c);
    if (!p) throw notFound('Printer');
    const settings = await getSettings(c);
    const payload: PrintJobPayload = {
      documentType: 'TEST', store: storeInfo(settings), language: 'th', copyNo: 1, isReprint: false,
      font: p.type === 'RECEIPT' ? settings.fonts.receipt : settings.fonts.kitchenTicket, message: `Printer: ${p.name}`,
    };
    const j = await insertJob(c, { branchId: p.branch_id, orderId: null, orderNumber: null, printerId, type: 'TEST', copyNo: 1, reprint: false, payload, dedupe: `test:${crypto.randomUUID()}`, requestedBy: userId, maxAttempts: 1 });
    notifyJob(out, p.branch_id, j);
    return j;
  });
  await out.flush();
  return job;
}

/** Atomically claim a job for printing. Returns null if another executor already took it. */
export async function claimJob(jobId: string, executor: string) {
  return one<any>(
    `UPDATE print_jobs SET status='PRINTING', attempts=attempts+1, claimed_by=$2, claimed_at=now()
      WHERE id=$1 AND status IN ('QUEUED','RETRYING') AND (next_retry_at IS NULL OR next_retry_at <= now())
      RETURNING *`,
    [jobId, executor],
  );
}

const PRINTER_LABEL: Record<string, string> = { RECEIPT: 'Receipt Printer', KITCHEN: 'Kitchen Printer', BEVERAGE: 'Beverage Printer', DESSERT: 'Dessert Printer', OTHER: 'Printer' };

export async function reportJob(jobId: string, executor: string, result: { ok: boolean; error?: string }) {
  const out = new Outbox();
  const settings = await getSettings();
  const res = await tx(async (c) => {
    const job = await one<any>(`SELECT * FROM print_jobs WHERE id=$1 FOR UPDATE`, [jobId], c);
    if (!job) throw notFound('Print job');
    if (job.status !== 'PRINTING' || job.claimed_by !== executor) throw conflict('JOB_NOT_CLAIMED', 'Job is not claimed by this executor');
    const printer = job.printer_id ? await one<any>(`SELECT * FROM printers WHERE id=$1`, [job.printer_id], c) : null;
    if (result.ok) {
      await query(`UPDATE print_jobs SET status='PRINTED', printed_at=now(), last_error=NULL WHERE id=$1`, [jobId], c);
      if (printer) await query(`UPDATE printers SET status='CONNECTED', last_error=NULL, last_seen_at=now() WHERE id=$1`, [printer.id], c);
      if (job.order_id) await addOrderEvent(c, job.order_id, 'PRINTED', { document: job.document_type, printer: printer?.name, copy: job.copy_no, reprint: job.is_reprint }, { type: 'SYSTEM' });
    } else {
      const retry = job.attempts < job.max_attempts;
      const delay = settings.printing.retryBaseSec * 2 ** Math.max(0, job.attempts - 1);
      await query(
        `UPDATE print_jobs SET status=$2, last_error=$3, next_retry_at = CASE WHEN $2='RETRYING' THEN now() + ($4 || ' seconds')::interval END WHERE id=$1`,
        [jobId, retry ? 'RETRYING' : 'FAILED', result.error?.slice(0, 500) ?? 'Unknown error', String(delay)],
        c,
      );
      if (printer) await query(`UPDATE printers SET status='ERROR', last_error=$2, last_seen_at=now() WHERE id=$1`, [printer.id, result.error?.slice(0, 500) ?? null], c);
      if (job.order_id) await addOrderEvent(c, job.order_id, retry ? 'PRINT_RETRYING' : 'PRINT_FAILED', { document: job.document_type, printer: printer?.name, error: result.error, attempt: job.attempts }, { type: 'SYSTEM' });
      out.add([rooms.branchCashier(job.branch_id), rooms.branchAdmin(job.branch_id), rooms.branchKitchen(job.branch_id)], EVENTS.PRINTER_ERROR, {
        printerId: printer?.id ?? null,
        printerName: printer?.name ?? null,
        printerType: printer?.type ?? null,
        message: `${PRINTER_LABEL[printer?.type ?? 'OTHER']} Offline`,
        error: result.error,
        jobId,
        orderNumber: job.order_number,
        willRetry: retry,
      });
    }
    out.add([rooms.branchAdmin(job.branch_id), rooms.branchCashier(job.branch_id)], EVENTS.PRINT_JOB_UPDATED, { jobId, status: result.ok ? 'PRINTED' : 'FAILED', orderId: job.order_id });
    if (printer) out.add([rooms.branchAdmin(job.branch_id), rooms.branchPrinters(job.branch_id)], EVENTS.PRINTER_STATUS, { printerId: printer.id, status: result.ok ? 'CONNECTED' : 'ERROR', error: result.error ?? null });
    return { ok: true };
  });
  await out.flush();
  return res;
}

/** Manual retry of a failed/cancelled job — reuses the same job row, never touches the order. */
export async function retryJob(jobId: string) {
  const out = new Outbox();
  const j = await tx(async (c) => {
    const s = await getSettings(c);
    const job = await one<any>(
      `UPDATE print_jobs SET status='QUEUED', next_retry_at=NULL, claimed_by=NULL, max_attempts = attempts + $2
        WHERE id=$1 AND status IN ('FAILED','CANCELLED','RETRYING') RETURNING id, printer_id, document_type, status, order_id, branch_id`,
      [jobId, s.printing.retryMaxAttempts],
      c,
    );
    if (!job) throw conflict('JOB_NOT_RETRYABLE', 'Only failed, cancelled or retrying jobs can be retried');
    notifyJob(out, job.branch_id, job);
    return job;
  });
  await out.flush();
  return j;
}

export async function cancelJob(jobId: string) {
  const j = await one<any>(`UPDATE print_jobs SET status='CANCELLED' WHERE id=$1 AND status IN ('QUEUED','RETRYING','FAILED') RETURNING id, branch_id`, [jobId]);
  if (!j) throw conflict('JOB_NOT_CANCELLABLE');
  await publish([rooms.branchAdmin(j.branch_id)], EVENTS.PRINT_JOB_UPDATED, { jobId, status: 'CANCELLED' });
  return j;
}

/** Background: re-announce due retries and fail stale claims (unknown outcome → manual retry, no silent double print). */
export async function printMaintenance() {
  const s = await getSettings();
  const due = await query<any>(
    `SELECT id, printer_id, document_type, status, order_id, branch_id FROM print_jobs WHERE status='RETRYING' AND next_retry_at <= now() LIMIT 200`,
  );
  const out = new Outbox();
  for (const j of due) notifyJob(out, j.branch_id, j);
  const stale = await query<any>(
    `UPDATE print_jobs SET status='FAILED', last_error='Executor did not report a result in time (printer may or may not have printed). Retry manually.'
      WHERE status='PRINTING' AND claimed_at < now() - ($1 || ' seconds')::interval RETURNING id, branch_id, order_number, printer_id`,
    [String(s.printing.staleClaimSec)],
  );
  for (const j of stale) {
    out.add([rooms.branchAdmin(j.branch_id), rooms.branchCashier(j.branch_id)], EVENTS.PRINTER_ERROR, {
      printerId: j.printer_id, jobId: j.id, orderNumber: j.order_number, message: 'Printer did not respond', willRetry: false,
    });
  }
  await out.flush();
}

/** Jobs waiting for a given executor's printers. */
export async function pendingJobsFor(printerIds: string[]) {
  if (!printerIds.length) return [];
  return query<any>(
    `SELECT j.*, p.name AS printer_name FROM print_jobs j JOIN printers p ON p.id=j.printer_id
      WHERE j.printer_id = ANY($1) AND j.status IN ('QUEUED','RETRYING') AND (j.next_retry_at IS NULL OR j.next_retry_at <= now())
      ORDER BY j.created_at LIMIT 50`,
    [printerIds],
  );
}
