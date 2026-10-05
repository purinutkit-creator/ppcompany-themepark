import type { I18nText, Lang, PrintJobPayload, PrintOrder } from '../types';
import { tr } from '../i18n';

export type Align = 'left' | 'center' | 'right';
export type Block =
  | { t: 'text'; text: string; align?: Align; size?: 1 | 2 | 3; bold?: boolean; invert?: boolean }
  | { t: 'cols'; left: string; right: string; size?: 1 | 2 | 3; bold?: boolean }
  | { t: 'rule'; char?: '-' | '=' }
  | { t: 'qr'; data: string; size?: number }
  | { t: 'image'; url: string; width?: number }
  | { t: 'feed'; lines?: number };

export interface PrintDoc {
  blocks: Block[];
  cut: boolean;
  openDrawer?: boolean;
}

const L: Record<string, I18nText> = {
  order: { th: 'ออเดอร์', en: 'ORDER', zh: '订单' },
  DINE_IN: { th: 'ทานที่ร้าน', en: 'DINE IN', zh: '堂食' },
  TAKE_AWAY: { th: 'กลับบ้าน', en: 'TAKE AWAY', zh: '外带' },
  subtotal: { th: 'รวม', en: 'Subtotal', zh: '小计' },
  discount: { th: 'ส่วนลด', en: 'Discount', zh: '折扣' },
  service: { th: 'ค่าบริการ', en: 'Service charge', zh: '服务费' },
  vat: { th: 'ภาษีมูลค่าเพิ่ม', en: 'VAT', zh: '增值税' },
  total: { th: 'ยอดสุทธิ', en: 'TOTAL', zh: '总计' },
  payment: { th: 'ชำระโดย', en: 'Payment', zh: '支付方式' },
  status: { th: 'สถานะ', en: 'Status', zh: '状态' },
  received: { th: 'รับเงิน', en: 'Received', zh: '收款' },
  change: { th: 'เงินทอน', en: 'Change', zh: '找零' },
  time: { th: 'เวลา', en: 'Time', zh: '时间' },
  kiosk: { th: 'เครื่อง', en: 'Kiosk', zh: '自助机' },
  branch: { th: 'สาขา', en: 'Branch', zh: '分店' },
  taxId: { th: 'เลขประจำตัวผู้เสียภาษี', en: 'Tax ID', zh: '税号' },
  tel: { th: 'โทร', en: 'Tel', zh: '电话' },
  items: { th: 'รายการ', en: 'items', zh: '项' },
  reprint: { th: '*** พิมพ์ซ้ำ ***', en: '*** REPRINT ***', zh: '*** 重印 ***' },
  copy: { th: 'สำเนา', en: 'Copy', zh: '副本' },
  note: { th: 'หมายเหตุ', en: 'Note', zh: '备注' },
  receipt: { th: 'ใบเสร็จรับเงิน', en: 'RECEIPT', zh: '收据' },
  queue: { th: 'หมายเลขคิวของคุณ', en: 'YOUR ORDER NUMBER', zh: '您的取餐号' },
  QR: { th: 'QR / โอนเงิน', en: 'QR / Transfer', zh: '扫码/转账' },
  CASH: { th: 'เงินสด', en: 'Cash', zh: '现金' },
  CARD: { th: 'บัตร', en: 'Card', zh: '银行卡' },
  OTHER: { th: 'อื่นๆ', en: 'Other', zh: '其他' },
  PAID: { th: 'ชำระแล้ว', en: 'PAID', zh: '已支付' },
  lookup: { th: 'สแกนเพื่อตรวจสอบออเดอร์', en: 'Scan to check your order', zh: '扫码查询订单' },
};

const lbl = (k: string, lang: Lang) => tr(L[k], lang, k);
const money = (n: number, sym: string) =>
  `${sym}${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function formatPrintTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function buildReceiptDoc(p: PrintJobPayload): PrintDoc {
  const o = p.order as PrintOrder;
  const lang = p.language;
  const sym = p.store.currencySymbol || '฿';
  const b: Block[] = [];
  if (p.isReprint) b.push({ t: 'text', text: lbl('reprint', lang), align: 'center', bold: true });
  if (p.store.logoUrl) b.push({ t: 'image', url: p.store.logoUrl, width: 0.5 });
  b.push({ t: 'text', text: tr(p.store.name, lang), align: 'center', size: 2, bold: true });
  if (p.store.address) b.push({ t: 'text', text: p.store.address, align: 'center' });
  if (p.store.phone) b.push({ t: 'text', text: `${lbl('tel', lang)} ${p.store.phone}`, align: 'center' });
  if (p.store.taxId) b.push({ t: 'text', text: `${lbl('taxId', lang)} ${p.store.taxId}`, align: 'center' });
  if (o.branchName) b.push({ t: 'text', text: `${lbl('branch', lang)}: ${o.branchName}`, align: 'center' });
  b.push({ t: 'rule', char: '=' });
  b.push({ t: 'text', text: lbl('receipt', lang), align: 'center', bold: true });
  b.push({ t: 'text', text: lbl('queue', lang), align: 'center' });
  b.push({ t: 'text', text: `#${o.orderNumber}`, align: 'center', size: 3, bold: true });
  b.push({ t: 'text', text: lbl(o.orderType, lang), align: 'center', size: 2, bold: true, invert: true });
  b.push({ t: 'cols', left: lbl('time', lang), right: formatPrintTime(o.paidAt || o.createdAt) });
  if (o.kioskCode) b.push({ t: 'cols', left: lbl('kiosk', lang), right: o.kioskCode });
  b.push({ t: 'rule' });
  for (const it of o.items) {
    b.push({ t: 'cols', left: `${it.qty} x ${tr(it.name, lang)}`, right: money(it.total, sym), bold: true });
    b.push({ t: 'text', text: `   @ ${money(it.unitPrice, sym)}` });
    for (const m of it.modifiers) {
      const prefix = m.kind === 'REMOVE' ? '- ' : '+ ';
      const price = m.priceDelta ? ` (${m.priceDelta > 0 ? '+' : ''}${money(m.priceDelta, sym)})` : '';
      b.push({ t: 'text', text: `   ${prefix}${tr(m.name, lang)}${price}` });
    }
    if (it.specialRequest) b.push({ t: 'text', text: `   * ${it.specialRequest}` });
  }
  b.push({ t: 'rule' });
  b.push({ t: 'cols', left: lbl('subtotal', lang), right: money(o.subtotal, sym) });
  if (o.discount) b.push({ t: 'cols', left: lbl('discount', lang), right: `-${money(o.discount, sym)}` });
  if (o.serviceCharge) b.push({ t: 'cols', left: lbl('service', lang), right: money(o.serviceCharge, sym) });
  b.push({ t: 'cols', left: lbl('vat', lang), right: money(o.vat, sym) });
  b.push({ t: 'cols', left: lbl('total', lang), right: money(o.total, sym), size: 2, bold: true });
  b.push({ t: 'rule' });
  if (o.paymentMethod) b.push({ t: 'cols', left: lbl('payment', lang), right: lbl(o.paymentMethod, lang) });
  if (o.paymentStatus) b.push({ t: 'cols', left: lbl('status', lang), right: lbl(o.paymentStatus, lang) });
  if (o.receivedAmount != null && o.paymentMethod === 'CASH') {
    b.push({ t: 'cols', left: lbl('received', lang), right: money(o.receivedAmount, sym) });
    b.push({ t: 'cols', left: lbl('change', lang), right: money(o.changeAmount ?? 0, sym) });
  }
  if (p.showQr !== false) {
    b.push({ t: 'feed', lines: 1 });
    b.push({ t: 'qr', data: p.lookupUrl || `ORDER:${o.orderId}`, size: 6 });
    b.push({ t: 'text', text: lbl('lookup', lang), align: 'center' });
  }
  const footer = tr(p.receiptFooter, lang);
  if (footer) {
    b.push({ t: 'feed', lines: 1 });
    b.push({ t: 'text', text: footer, align: 'center' });
  }
  if (p.copyNo > 1) b.push({ t: 'text', text: `${lbl('copy', lang)} ${p.copyNo}`, align: 'center' });
  b.push({ t: 'feed', lines: 3 });
  return { blocks: b, cut: true };
}

export function buildKitchenDoc(p: PrintJobPayload): PrintDoc {
  const o = p.order as PrintOrder;
  const lang = p.language;
  const b: Block[] = [];
  if (p.isReprint) b.push({ t: 'text', text: lbl('reprint', lang), align: 'center', bold: true });
  if (p.stationName) b.push({ t: 'text', text: tr(p.stationName, lang), align: 'center', size: 2, bold: true, invert: true });
  b.push({ t: 'text', text: `${lbl('order', 'en')} #${o.orderNumber}`, align: 'center', size: 3, bold: true });
  b.push({ t: 'text', text: lbl(o.orderType, lang), align: 'center', size: 2, bold: true });
  b.push({ t: 'cols', left: lbl('time', lang), right: formatPrintTime(o.paidAt || o.createdAt) });
  if (o.kioskCode) b.push({ t: 'cols', left: lbl('kiosk', lang), right: o.kioskCode });
  const count = o.items.reduce((s, i) => s + i.qty, 0);
  b.push({ t: 'cols', left: lbl('items', lang), right: String(count) });
  b.push({ t: 'rule', char: '=' });
  for (const it of o.items) {
    b.push({ t: 'text', text: `${it.qty}x ${tr(it.name, lang)}`, size: 2, bold: true });
    for (const m of it.modifiers) {
      const prefix = m.kind === 'REMOVE' ? '  - NO ' : m.kind === 'EXTRA' ? '  + EXTRA ' : '  * ';
      b.push({ t: 'text', text: `${prefix}${tr(m.name, lang)}`, size: 1, bold: true });
    }
    if (it.specialRequest) b.push({ t: 'text', text: `  >> ${it.specialRequest}`, bold: true, invert: true });
    b.push({ t: 'rule' });
  }
  if (o.note) b.push({ t: 'text', text: `${lbl('note', lang)}: ${o.note}`, bold: true });
  b.push({ t: 'feed', lines: 3 });
  return { blocks: b, cut: true };
}

export function buildTestDoc(p: PrintJobPayload, printerName: string): PrintDoc {
  return {
    cut: true,
    blocks: [
      { t: 'text', text: 'TEST PRINT', align: 'center', size: 3, bold: true },
      { t: 'text', text: printerName, align: 'center', size: 2 },
      { t: 'rule', char: '=' },
      { t: 'text', text: 'English: The quick brown fox 0123456789' },
      { t: 'text', text: 'ไทย: ทดสอบการพิมพ์ภาษาไทย สระ ุ ู ิ ี ่ ้ ๊ ๋' },
      { t: 'text', text: '中文: 测试打印 中文字体 可取餐' },
      { t: 'cols', left: 'Left column', right: '฿1,234.00' },
      { t: 'text', text: 'Bold large', size: 2, bold: true },
      { t: 'text', text: 'INVERTED', align: 'center', invert: true, bold: true },
      { t: 'qr', data: 'TEST-PRINT', size: 5 },
      { t: 'text', text: p.message || formatPrintTime(new Date().toISOString()), align: 'center' },
      { t: 'feed', lines: 3 },
    ],
  };
}

export function buildDoc(p: PrintJobPayload, printerName = 'Printer'): PrintDoc {
  if (p.documentType === 'RECEIPT') return buildReceiptDoc(p);
  if (p.documentType === 'KITCHEN_TICKET') return buildKitchenDoc(p);
  return buildTestDoc(p, printerName);
}

/** True when a document contains characters outside printable ASCII (Thai, Chinese, ฿ ...). */
export function needsRaster(doc: PrintDoc): boolean {
  const re = /[^\x20-\x7e]/;
  return doc.blocks.some((b) =>
    b.t === 'text' ? re.test(b.text) : b.t === 'cols' ? re.test(b.left + b.right) : b.t === 'image',
  );
}
