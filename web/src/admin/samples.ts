import type { PrintJobPayload } from '@kiosk/shared';

/** Sample order used for receipt / kitchen ticket previews in admin. */
export function sampleJob(kind: 'RECEIPT' | 'KITCHEN_TICKET', store: any, font?: any, footer?: any): PrintJobPayload {
  return {
    documentType: kind,
    language: 'th',
    copyNo: 1,
    isReprint: false,
    showQr: true,
    lookupUrl: `${location.origin}/o/sample`,
    receiptFooter: footer,
    stationName: kind === 'KITCHEN_TICKET' ? { th: 'ครัวร้อน', en: 'Hot Kitchen', zh: '热厨房' } : null,
    font,
    store: { name: store?.name ?? { th: 'ครัวฮับ' }, address: store?.address, phone: store?.phone, taxId: store?.taxId, currencySymbol: store?.currencySymbol ?? '฿', logoUrl: null },
    order: {
      orderId: '00000000-0000-0000-0000-000000000000',
      orderNumber: '48271',
      orderType: 'DINE_IN',
      createdAt: new Date().toISOString(),
      paidAt: new Date().toISOString(),
      kioskCode: 'KIOSK-01',
      branchName: 'สาขาสุขุมวิท',
      language: 'th',
      items: [
        { name: { th: 'ชีสเบอร์เกอร์', en: 'Cheese Burger', zh: '芝士汉堡' }, qty: 2, unitPrice: 149, total: 298, modifiers: [{ name: { th: 'หัวหอม', en: 'Onion', zh: '洋葱' }, kind: 'REMOVE', priceDelta: 0 }, { name: { th: 'ชีสเพิ่ม', en: 'Extra cheese', zh: '加芝士' }, kind: 'EXTRA', priceDelta: 20 }], specialRequest: 'ไม่ใส่ผัก' },
        { name: { th: 'โคล่า', en: 'Cola', zh: '可乐' }, qty: 1, unitPrice: 55, total: 55, modifiers: [{ name: { th: 'ใหญ่', en: 'Large', zh: '大杯' }, kind: 'OPTION', priceDelta: 20 }, { name: { th: 'ไม่ใส่น้ำแข็ง', en: 'No ice', zh: '去冰' }, kind: 'OPTION', priceDelta: 0 }] },
      ],
      subtotal: 353,
      discount: 0,
      serviceCharge: 0,
      vat: 23.09,
      total: 353,
      paymentMethod: 'QR',
      paymentStatus: 'PAID',
    },
  };
}
