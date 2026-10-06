import type { I18nText, Lang, StoreInfo } from '../types';
import { tr } from '../i18n';
import type { ParkPrintSale, ParkPrintTicket, WristbandTemplate } from '../park/types';
import { PAYMENT_METHOD_LABELS } from '../park/i18n';
import type { Block, PrintDoc } from './document';
import { formatPrintTime } from './document';

const t = (th: string, en: string, zh: string): I18nText => ({ th, en, zh });
const L: Record<string, I18nText> = {
  receipt: t('ใบเสร็จรับเงิน', 'RECEIPT', '收据'),
  taxInvoice: t('ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ', 'RECEIPT / ABBREVIATED TAX INVOICE', '收据/简易税务发票'),
  customerCopy: t('สำหรับลูกค้า', 'CUSTOMER COPY', '顾客联'),
  staffCopy: t('สำหรับพนักงาน', 'STAFF COPY', '员工联'),
  reprint: t('*** พิมพ์ซ้ำ ***', '*** REPRINT ***', '*** 重印 ***'),
  no: t('เลขที่', 'No.', '单号'),
  booking: t('การจอง', 'Booking', '预订'),
  date: t('วันที่', 'Date', '日期'),
  cashier: t('พนักงาน', 'Cashier', '收银员'),
  customer: t('ลูกค้า', 'Customer', '顾客'),
  member: t('สมาชิก', 'Member', '会员'),
  subtotal: t('รวม', 'Subtotal', '小计'),
  discount: t('ส่วนลด', 'Discount', '折扣'),
  vat: t('ภาษีมูลค่าเพิ่ม (รวมแล้ว)', 'VAT (included)', '增值税（已含）'),
  total: t('ยอดสุทธิ', 'TOTAL', '总计'),
  received: t('รับเงิน', 'Received', '收款'),
  change: t('เงินทอน', 'Change', '找零'),
  wallet: t('ยอดเงินคงเหลือในบัตร', 'Wallet balance', '卡内余额'),
  points: t('แต้มที่ได้รับ', 'Points earned', '获得积分'),
  pointsBal: t('แต้มสะสม', 'Points balance', '积分余额'),
  thanks: t('ขอบคุณที่ใช้บริการ', 'Thank you!', '谢谢惠顾'),
  taxId: t('เลขประจำตัวผู้เสียภาษี', 'Tax ID', '税号'),
  tel: t('โทร', 'Tel', '电话'),
  admission: t('บัตรเข้าชม', 'ADMISSION TICKET', '入场券'),
  visit: t('วันที่เข้าชม', 'Visit date', '游玩日期'),
  validTo: t('ใช้ได้ถึง', 'Valid until', '有效期至'),
  guest: t('ผู้เข้าชม', 'Guest', '游客'),
  type: t('ประเภท', 'Type', '类型'),
  ticket: t('ตั๋ว', 'Ticket', '门票'),
  showAtGate: t('แสดง QR / บาร์โค้ดนี้ที่ประตูทางเข้า', 'Show this QR / barcode at the entrance', '请在入口出示此二维码/条码'),
  lookup: t('สแกนเพื่อดูรายละเอียด', 'Scan for details', '扫码查看详情'),
  shift: t('รายงานปิดกะ', 'SHIFT REPORT', '交班报告'),
  opening: t('เงินทอนตั้งต้น', 'Opening cash', '备用金'),
  cashSales: t('ขายเงินสด', 'Cash sales', '现金销售'),
  cashTopup: t('เติมเงินด้วยเงินสด', 'Cash top-up', '现金充值'),
  cashRefund: t('คืนเงินสด', 'Cash refunds', '现金退款'),
  cashOut: t('นำเงินออก', 'Cash out', '取出现金'),
  cashIn: t('นำเงินเข้า', 'Cash in', '存入现金'),
  expected: t('เงินสดที่ควรมี', 'Expected cash', '应有现金'),
  actual: t('เงินสดนับได้', 'Actual cash', '实际现金'),
  overShort: t('เกิน / ขาด', 'Over / Short', '长短款'),
  opened: t('เปิดกะ', 'Opened', '开班'),
  closed: t('ปิดกะ', 'Closed', '交班'),
  byMethod: t('ยอดขายตามช่องทางชำระ', 'Sales by payment method', '按支付方式'),
  queue: t('บัตรคิว', 'QUEUE TICKET', '排队号'),
  ahead: t('คิวก่อนหน้า', 'Ahead of you', '前面人数'),
  wait: t('รอประมาณ', 'Estimated wait', '预计等待'),
  minutes: t('นาที', 'min', '分钟'),
  card: t('บัตรสมาชิก', 'MEMBER CARD', '会员卡'),
  topup: t('สลิปเติมเงิน', 'TOP-UP SLIP', '充值凭条'),
};
const lbl = (k: string, lang: Lang) => tr(L[k], lang, k);
const money = (n: number, sym: string) => `${n < 0 ? '-' : ''}${sym}${Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function header(store: StoreInfo, lang: Lang, branchName?: string | null): Block[] {
  const b: Block[] = [];
  if (store.logoUrl) b.push({ t: 'image', url: store.logoUrl, width: 0.45 });
  b.push({ t: 'text', text: tr(store.name, lang), align: 'center', size: 2, bold: true });
  if (branchName) b.push({ t: 'text', text: branchName, align: 'center' });
  if (store.address) b.push({ t: 'text', text: store.address, align: 'center' });
  if (store.phone) b.push({ t: 'text', text: `${lbl('tel', lang)} ${store.phone}`, align: 'center' });
  if (store.taxId) b.push({ t: 'text', text: `${lbl('taxId', lang)} ${store.taxId}`, align: 'center' });
  return b;
}

export interface ParkReceiptOptions {
  copy?: 'CUSTOMER' | 'STAFF' | null;
  reprint?: boolean;
  footer?: I18nText | null;
  showQr?: boolean;
  openDrawer?: boolean;
}

/** Receipt for any park sale (tickets, membership, top-up, retail, locker, ride add-on). */
export function buildParkReceiptDoc(s: ParkPrintSale, store: StoreInfo, lang: Lang, o: ParkReceiptOptions = {}): PrintDoc {
  const sym = store.currencySymbol || '฿';
  const b: Block[] = [];
  if (o.reprint) b.push({ t: 'text', text: lbl('reprint', lang), align: 'center', bold: true });
  b.push(...header(store, lang, s.branchName));
  if (s.storeName) b.push({ t: 'text', text: tr(s.storeName, lang), align: 'center', bold: true });
  b.push({ t: 'rule', char: '=' });
  b.push({ t: 'text', text: lbl('taxInvoice', lang), align: 'center', bold: true });
  if (o.copy) b.push({ t: 'text', text: lbl(o.copy === 'CUSTOMER' ? 'customerCopy' : 'staffCopy', lang), align: 'center', bold: true, invert: true });
  b.push({ t: 'cols', left: lbl('no', lang), right: s.saleNo });
  if (s.bookingNo) b.push({ t: 'cols', left: lbl('booking', lang), right: s.bookingNo });
  b.push({ t: 'cols', left: lbl('date', lang), right: formatPrintTime(s.paidAt || s.createdAt, s.timeZone) });
  if (s.cashier) b.push({ t: 'cols', left: lbl('cashier', lang), right: s.cashier });
  if (s.customer) b.push({ t: 'cols', left: lbl('customer', lang), right: s.customer });
  if (s.memberNo) b.push({ t: 'cols', left: lbl('member', lang), right: s.memberNo });
  b.push({ t: 'rule' });
  for (const it of s.items) {
    b.push({ t: 'cols', left: `${it.qty} x ${tr(it.name, lang)}`, right: money(it.total, sym), bold: true });
    if (it.qty > 1) b.push({ t: 'text', text: `   @ ${money(it.unitPrice, sym)}` });
    if (it.note) b.push({ t: 'text', text: `   ${it.note}` });
  }
  b.push({ t: 'rule' });
  b.push({ t: 'cols', left: lbl('subtotal', lang), right: money(s.subtotal, sym) });
  for (const p of s.promotions) b.push({ t: 'cols', left: `  ${tr(p.name, lang)}`, right: `-${money(p.amount, sym)}` });
  if (s.discount && !s.promotions.length) b.push({ t: 'cols', left: lbl('discount', lang), right: `-${money(s.discount, sym)}` });
  b.push({ t: 'cols', left: lbl('total', lang), right: money(s.total, sym), size: 2, bold: true });
  b.push({ t: 'cols', left: lbl('vat', lang), right: money(s.vat, sym) });
  b.push({ t: 'rule' });
  for (const p of s.payments) {
    b.push({ t: 'cols', left: tr(PAYMENT_METHOD_LABELS[p.method], lang, p.method), right: money(p.amount, sym) });
    if (p.method === 'CASH' && p.received != null) {
      b.push({ t: 'cols', left: `  ${lbl('received', lang)}`, right: money(p.received, sym) });
      b.push({ t: 'cols', left: `  ${lbl('change', lang)}`, right: money(p.change ?? 0, sym) });
    }
    if (p.reference) b.push({ t: 'text', text: `  Ref: ${p.reference}` });
  }
  if (s.walletBalance != null) b.push({ t: 'cols', left: lbl('wallet', lang), right: money(s.walletBalance, sym), bold: true });
  if (s.pointsEarned) b.push({ t: 'cols', left: lbl('points', lang), right: `+${s.pointsEarned}` });
  if (s.pointsBalance != null) b.push({ t: 'cols', left: lbl('pointsBal', lang), right: String(s.pointsBalance) });
  if (o.showQr !== false && s.lookupUrl) {
    b.push({ t: 'feed', lines: 1 });
    b.push({ t: 'qr', data: s.lookupUrl, size: 5 });
    b.push({ t: 'text', text: lbl('lookup', lang), align: 'center' });
  }
  b.push({ t: 'feed', lines: 1 });
  b.push({ t: 'text', text: tr(o.footer ?? L.thanks, lang), align: 'center' });
  b.push({ t: 'feed', lines: 3 });
  return { blocks: b, cut: true, openDrawer: !!o.openDrawer };
}

/** Admission ticket (paper / thermal): QR + Code128 barcode + terms. */
export function buildTicketDoc(tk: ParkPrintTicket, store: StoreInfo, lang: Lang, o: { reprint?: boolean; timeZone?: string | null } = {}): PrintDoc {
  const sym = store.currencySymbol || '฿';
  const b: Block[] = [];
  if (o.reprint) b.push({ t: 'text', text: lbl('reprint', lang), align: 'center', bold: true });
  b.push(...header(store, lang));
  b.push({ t: 'rule', char: '=' });
  b.push({ t: 'text', text: lbl('admission', lang), align: 'center', size: 2, bold: true, invert: true });
  b.push({ t: 'text', text: tr(tk.packageName, lang), align: 'center', size: 2, bold: true });
  if (tk.ticketType) b.push({ t: 'text', text: tr(tk.ticketType, lang), align: 'center', bold: true });
  b.push({ t: 'cols', left: lbl('visit', lang), right: tk.visitDate });
  if (tk.validTo && tk.validTo !== tk.visitDate) b.push({ t: 'cols', left: lbl('validTo', lang), right: tk.validTo });
  if (tk.guestName) b.push({ t: 'cols', left: lbl('guest', lang), right: tk.guestName });
  if (tk.bookingNo) b.push({ t: 'cols', left: lbl('booking', lang), right: tk.bookingNo });
  b.push({ t: 'cols', left: lbl('ticket', lang), right: tk.ticketNo, bold: true });
  if (tk.price != null) b.push({ t: 'cols', left: '', right: money(tk.price, sym) });
  b.push({ t: 'feed', lines: 1 });
  b.push({ t: 'qr', data: tk.qr, size: 7 });
  b.push({ t: 'barcode', data: tk.barcode, height: 70 });
  b.push({ t: 'text', text: lbl('showAtGate', lang), align: 'center', bold: true });
  const terms = tr(tk.terms ?? null, lang);
  if (terms) {
    b.push({ t: 'rule' });
    b.push({ t: 'text', text: terms });
  }
  b.push({ t: 'feed', lines: 3 });
  return { blocks: b, cut: true };
}

/** Wristband print (narrow label / wristband printer, rendered vertically). */
export function buildWristbandDoc(
  w: { code: string; qr: string; barcode: string; ticketType?: I18nText | null; packageName?: I18nText | null; visitDate?: string | null; name?: string | null },
  tpl: WristbandTemplate,
  store: StoreInfo,
  lang: Lang,
): PrintDoc {
  const b: Block[] = [];
  if (tpl.showLogo && store.logoUrl) b.push({ t: 'image', url: store.logoUrl, width: 0.6 });
  b.push({ t: 'text', text: tr(tpl.headline ?? store.name, lang), align: 'center', bold: true });
  if (tpl.showTicketType && w.ticketType) b.push({ t: 'text', text: tr(w.ticketType, lang).toUpperCase(), align: 'center', size: 2, bold: true });
  if (tpl.showPackage && w.packageName) b.push({ t: 'text', text: tr(w.packageName, lang).toUpperCase(), align: 'center', bold: true });
  if (tpl.showName && w.name) b.push({ t: 'text', text: w.name, align: 'center' });
  b.push({ t: 'text', text: w.code, align: 'center', bold: true });
  if (tpl.showBarcode) b.push({ t: 'barcode', data: w.barcode, height: 60, hri: false });
  if (tpl.showQr) b.push({ t: 'qr', data: w.qr, size: 5 });
  if (tpl.showDate && w.visitDate) b.push({ t: 'text', text: w.visitDate, align: 'center', bold: true });
  b.push({ t: 'feed', lines: 2 });
  return { blocks: b, cut: true };
}

/** Physical / temporary card label (card printers or a receipt printer for temp cards). */
export function buildCardDoc(c: { code: string; qr: string; barcode: string; name?: string | null; tier?: I18nText | null; expires?: string | null }, store: StoreInfo, lang: Lang): PrintDoc {
  const b: Block[] = [...header(store, lang)];
  b.push({ t: 'rule', char: '=' });
  b.push({ t: 'text', text: lbl('card', lang), align: 'center', size: 2, bold: true, invert: true });
  if (c.tier) b.push({ t: 'text', text: tr(c.tier, lang), align: 'center', bold: true });
  if (c.name) b.push({ t: 'text', text: c.name, align: 'center', size: 2 });
  b.push({ t: 'qr', data: c.qr, size: 7 });
  b.push({ t: 'barcode', data: c.barcode, height: 70 });
  if (c.expires) b.push({ t: 'cols', left: lbl('validTo', lang), right: c.expires });
  b.push({ t: 'feed', lines: 3 });
  return { blocks: b, cut: true };
}

export interface ShiftReport {
  shiftNo: string;
  staff: string;
  terminal: string;
  openedAt: string;
  closedAt?: string | null;
  timeZone?: string | null;
  opening: number;
  cashSales: number;
  cashTopup: number;
  cashRefund: number;
  cashOut: number;
  cashIn: number;
  expected: number;
  actual?: number | null;
  overShort?: number | null;
  byMethod: { method: string; amount: number; count: number }[];
}

export function buildShiftReportDoc(r: ShiftReport, store: StoreInfo, lang: Lang): PrintDoc {
  const sym = store.currencySymbol || '฿';
  const b: Block[] = [...header(store, lang)];
  b.push({ t: 'rule', char: '=' });
  b.push({ t: 'text', text: lbl('shift', lang), align: 'center', size: 2, bold: true });
  b.push({ t: 'cols', left: lbl('no', lang), right: r.shiftNo });
  b.push({ t: 'cols', left: lbl('cashier', lang), right: r.staff });
  b.push({ t: 'cols', left: 'Terminal', right: r.terminal });
  b.push({ t: 'cols', left: lbl('opened', lang), right: formatPrintTime(r.openedAt, r.timeZone) });
  if (r.closedAt) b.push({ t: 'cols', left: lbl('closed', lang), right: formatPrintTime(r.closedAt, r.timeZone) });
  b.push({ t: 'rule' });
  b.push({ t: 'cols', left: lbl('opening', lang), right: money(r.opening, sym) });
  b.push({ t: 'cols', left: `+ ${lbl('cashSales', lang)}`, right: money(r.cashSales, sym) });
  b.push({ t: 'cols', left: `+ ${lbl('cashTopup', lang)}`, right: money(r.cashTopup, sym) });
  b.push({ t: 'cols', left: `+ ${lbl('cashIn', lang)}`, right: money(r.cashIn, sym) });
  b.push({ t: 'cols', left: `- ${lbl('cashRefund', lang)}`, right: money(r.cashRefund, sym) });
  b.push({ t: 'cols', left: `- ${lbl('cashOut', lang)}`, right: money(r.cashOut, sym) });
  b.push({ t: 'cols', left: lbl('expected', lang), right: money(r.expected, sym), bold: true });
  if (r.actual != null) {
    b.push({ t: 'cols', left: lbl('actual', lang), right: money(r.actual, sym), bold: true });
    b.push({ t: 'cols', left: lbl('overShort', lang), right: money(r.overShort ?? 0, sym), size: 2, bold: true });
  }
  b.push({ t: 'rule' });
  b.push({ t: 'text', text: lbl('byMethod', lang), bold: true });
  for (const m of r.byMethod) b.push({ t: 'cols', left: `${tr(PAYMENT_METHOD_LABELS[m.method], lang, m.method)} (${m.count})`, right: money(m.amount, sym) });
  b.push({ t: 'feed', lines: 3 });
  return { blocks: b, cut: true };
}

export function buildQueueSlipDoc(q: { rideName: I18nText; queueNo: string; ahead: number; waitMinutes: number; at: string; timeZone?: string | null }, store: StoreInfo, lang: Lang): PrintDoc {
  return {
    cut: true,
    blocks: [
      { t: 'text', text: tr(store.name, lang), align: 'center', bold: true },
      { t: 'text', text: lbl('queue', lang), align: 'center', bold: true, invert: true },
      { t: 'text', text: tr(q.rideName, lang), align: 'center', size: 2, bold: true },
      { t: 'text', text: q.queueNo, align: 'center', size: 3, bold: true },
      { t: 'cols', left: lbl('ahead', lang), right: String(q.ahead) },
      { t: 'cols', left: lbl('wait', lang), right: `${q.waitMinutes} ${lbl('minutes', lang)}` },
      { t: 'text', text: formatPrintTime(q.at, q.timeZone), align: 'center' },
      { t: 'feed', lines: 3 },
    ],
  };
}
