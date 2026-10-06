// Domain enums and DTOs shared by server, web clients and the print agent.

export const LANGS = ['th', 'en', 'zh'] as const;
export type Lang = (typeof LANGS)[number];
export type I18nText = Partial<Record<Lang, string>>;

export const ORDER_STATUSES = [
  'CREATED',
  'WAITING_PAYMENT',
  'WAITING_CASH_PAYMENT',
  'WAITING_CARD',
  'WAITING_VERIFICATION',
  'PAID',
  'CONFIRMED',
  'NEW',
  'PREPARING',
  'READY',
  'COMPLETED',
  'CANCELLED',
  'REFUNDED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Statuses in which an order still "owns" its customer queue number. */
export const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  'CREATED',
  'WAITING_PAYMENT',
  'WAITING_CASH_PAYMENT',
  'WAITING_CARD',
  'WAITING_VERIFICATION',
  'PAID',
  'CONFIRMED',
  'NEW',
  'PREPARING',
  'READY',
];
export const UNPAID_ORDER_STATUSES: OrderStatus[] = [
  'CREATED',
  'WAITING_PAYMENT',
  'WAITING_CASH_PAYMENT',
  'WAITING_CARD',
  'WAITING_VERIFICATION',
];

export type PaymentStatusOfOrder = 'UNPAID' | 'PENDING' | 'PAID' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'VOID';

export const ORDER_TYPES = ['DINE_IN', 'TAKE_AWAY'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const PAYMENT_METHODS = ['QR', 'CASH', 'CARD', 'OTHER', 'WALLET'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export type PaymentStatus =
  | 'PENDING'
  | 'WAITING_VERIFICATION'
  | 'WAITING_CASH'
  | 'WAITING_CARD'
  | 'PROCESSING'
  | 'APPROVED'
  | 'PAID'
  | 'DECLINED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REFUNDED';

export type QrMode = 'PROMPTPAY_STATIC' | 'PROMPTPAY_DYNAMIC' | 'GATEWAY';

export type VerificationStatus = 'WAITING_VERIFICATION' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export type KitchenStatus = 'NEW' | 'PREPARING' | 'READY' | 'DONE' | 'CANCELLED';
export type QueueStatus = 'RESERVED' | 'PREPARING' | 'READY' | 'COMPLETED' | 'CANCELLED';

export const PRINT_JOB_STATUSES = ['QUEUED', 'PRINTING', 'PRINTED', 'FAILED', 'RETRYING', 'CANCELLED'] as const;
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];
export type PrintDocumentType = 'RECEIPT' | 'KITCHEN_TICKET' | 'TEST' | 'DOC';

export const PRINTER_TYPES = ['RECEIPT', 'KITCHEN', 'BEVERAGE', 'DESSERT', 'OTHER', 'TICKET', 'WRISTBAND', 'LABEL'] as const;
export type PrinterType = (typeof PRINTER_TYPES)[number];
export const PRINTER_CONNECTIONS = ['USB', 'BLUETOOTH', 'BLE', 'LAN', 'ETHERNET', 'WIFI'] as const;
export type PrinterConnection = (typeof PRINTER_CONNECTIONS)[number];
/** Which runtime physically talks to the printer. */
export const PRINTER_EXECUTORS = ['AGENT', 'BROWSER', 'ANDROID', 'DESKTOP'] as const;
export type PrinterExecutor = (typeof PRINTER_EXECUTORS)[number];
export type PrinterStatus = 'CONNECTED' | 'OFFLINE' | 'ERROR' | 'UNKNOWN';
export type RasterMode = 'AUTO' | 'TEXT' | 'RASTER';

export const PRODUCT_STATUSES = ['AVAILABLE', 'SOLD_OUT', 'UNAVAILABLE', 'HIDDEN'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const PROMOTION_TYPES = ['PERCENT', 'FIXED', 'BUY_X_GET_Y', 'COMBO', 'SET_MENU', 'COUPON', 'PROMO_CODE'] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];

export type ModifierKind = 'OPTION' | 'ADD' | 'REMOVE' | 'EXTRA';

export interface MenuSchedule {
  id: string;
  name: string;
  start_time: string; // HH:MM
  end_time: string; // HH:MM
  days: number[]; // 0 = Sunday
  is_active: boolean;
}

export interface MenuModifier {
  id: string;
  group_id: string;
  name: I18nText;
  price_delta: number;
  is_default: boolean;
  is_active: boolean;
  sort: number;
}

export interface MenuModifierGroup {
  id: string;
  name: I18nText;
  selection: 'SINGLE' | 'MULTIPLE';
  required: boolean;
  min_select: number;
  max_select: number;
  kind: ModifierKind;
  sort: number;
  modifiers: MenuModifier[];
}

export interface MenuProduct {
  id: string;
  sku: string;
  category_id: string;
  image_url: string | null;
  price: number;
  status: ProductStatus;
  is_recommended: boolean;
  schedule_id: string | null;
  track_stock: boolean;
  available_stock: number | null;
  vat_rate: number | null;
  station_id: string | null;
  sort: number;
  name: I18nText;
  description: I18nText;
  short_description: I18nText;
  modifier_groups: MenuModifierGroup[];
  recommendations: { product_id: string; message: I18nText; special_price: number | null }[];
}

export interface MenuCategory {
  id: string;
  kind: 'STANDARD' | 'RECOMMENDED' | 'PROMOTION';
  name: I18nText;
  image_url: string | null;
  icon: string | null;
  sort: number;
  schedule_id: string | null;
  is_active: boolean;
}

export interface Promotion {
  id: string;
  code: string | null;
  name: I18nText;
  description: I18nText;
  badge: I18nText;
  type: PromotionType;
  value_type: 'PERCENT' | 'FIXED';
  value: number;
  buy_qty: number | null;
  get_qty: number | null;
  combo_price: number | null;
  min_order: number | null;
  max_discount: number | null;
  scope: 'ORDER' | 'PRODUCT' | 'CATEGORY';
  product_ids: string[];
  category_ids: string[];
  branch_ids: string[];
  start_date: string | null;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  days: number[];
  usage_limit: number | null;
  usage_count: number;
  requires_code: boolean;
  priority: number;
  is_active: boolean;
}

export interface TaxSettings {
  vatRate: number;
  vatMode: 'INCLUDED' | 'EXCLUDED';
  serviceChargeRate: number;
  serviceChargeOrderTypes: OrderType[];
}

export interface CartLineInput {
  key: string;
  productId: string;
  categoryId: string;
  qty: number;
  basePrice: number;
  modifierTotal: number;
  vatRate: number | null;
}

export interface PricedLine extends CartLineInput {
  unitPrice: number;
  lineTotal: number;
  discount: number;
}

export interface AppliedPromotion {
  promotionId: string;
  name: I18nText;
  type: PromotionType;
  amount: number;
  code?: string;
}

export interface PricingResult {
  lines: PricedLine[];
  subtotal: number;
  discount: number;
  serviceCharge: number;
  vat: number;
  total: number;
  appliedPromotions: AppliedPromotion[];
  invalidCode?: string;
}

/** Display payload used for receipts / kitchen tickets (also stored on print_jobs.payload). */
export interface PrintOrderItem {
  name: I18nText;
  qty: number;
  unitPrice: number;
  total: number;
  modifiers: { name: I18nText; kind: ModifierKind; priceDelta: number; groupName?: I18nText }[];
  specialRequest?: string | null;
}

export interface PrintOrder {
  orderId: string;
  orderNumber: string;
  orderType: OrderType;
  createdAt: string;
  paidAt?: string | null;
  kioskCode?: string | null;
  branchName?: string | null;
  /** IANA zone of the branch, so receipts show local time regardless of the printing machine. */
  timeZone?: string | null;
  language: Lang;
  items: PrintOrderItem[];
  subtotal: number;
  discount: number;
  serviceCharge: number;
  vat: number;
  total: number;
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  receivedAmount?: number | null;
  changeAmount?: number | null;
  note?: string | null;
}

export interface StoreInfo {
  name: I18nText;
  logoUrl?: string | null;
  address?: string | null;
  phone?: string | null;
  taxId?: string | null;
  currencySymbol: string;
}

export interface FontSpec {
  family: string;
  weight: number;
  size: number;
  letterSpacing: number;
  lineHeight: number;
  /** Font family per language (falls back to `family`). */
  byLang?: Partial<Record<Lang, string>>;
}

/** Resolve the font for a surface in a given language. */
export function fontForLang(spec: FontSpec | null | undefined, lang: Lang): FontSpec | null {
  if (!spec) return null;
  const fam = spec.byLang?.[lang];
  return fam ? { ...spec, family: fam } : spec;
}

export interface PrintJobPayload {
  documentType: PrintDocumentType;
  order?: PrintOrder;
  stationName?: I18nText | null;
  store: StoreInfo;
  language: Lang;
  copyNo: number;
  isReprint: boolean;
  receiptFooter?: I18nText;
  showQr?: boolean;
  lookupUrl?: string | null;
  font?: FontSpec | null;
  message?: string;
  /** Pre-built document (documentType 'DOC'): park receipts, tickets, wristbands, shift reports. */
  doc?: import('./print/document').PrintDoc;
  /** Short label for print queues (e.g. "Receipt S-261006-000123 (customer copy)"). */
  title?: string;
}
