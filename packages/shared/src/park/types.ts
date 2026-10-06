import type { I18nText, Lang } from '../types';

export const CREDENTIAL_TYPES = ['MEMBER_CARD', 'DIGITAL_CARD', 'TEMP_CARD', 'TEMP_WRISTBAND', 'PRINTED_WRISTBAND', 'QR_TICKET', 'BOOKING', 'RFID'] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];
export const CREDENTIAL_STATUSES = ['NEW', 'ACTIVE', 'SUSPENDED', 'LOST', 'BLOCKED', 'EXPIRED', 'REPLACED', 'CLOSED'] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export const TICKET_STATUSES = ['UNPAID', 'PAID', 'ACTIVE', 'USED', 'EXPIRED', 'CANCELLED', 'REFUNDED'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type Presence = 'OUTSIDE' | 'ENTERING' | 'INSIDE';

export const BOOKING_STATUSES = ['PENDING_PAYMENT', 'RESERVED', 'WAITING_VERIFICATION', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'EXPIRED', 'NO_SHOW'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const GATE_STATES = ['IDLE', 'SCANNING', 'VALIDATING', 'WAITING_APPROVAL', 'APPROVED', 'OPENING', 'OPEN', 'CLOSING', 'DENIED', 'ERROR', 'OFFLINE', 'EMERGENCY'] as const;
export type GateState = (typeof GATE_STATES)[number];
export type GateMode = 'AUTO' | 'MANUAL';
export type GateDirection = 'ENTRY' | 'EXIT' | 'BOTH';

/** Allowed gate state transitions. The server refuses anything else (e.g. OPEN while already OPEN). */
export const GATE_TRANSITIONS: Record<GateState, GateState[]> = {
  IDLE: ['SCANNING', 'VALIDATING', 'APPROVED', 'OFFLINE', 'ERROR', 'EMERGENCY'],
  SCANNING: ['VALIDATING', 'IDLE', 'ERROR', 'EMERGENCY', 'OFFLINE'],
  VALIDATING: ['DENIED', 'WAITING_APPROVAL', 'APPROVED', 'IDLE', 'ERROR', 'EMERGENCY'],
  WAITING_APPROVAL: ['APPROVED', 'DENIED', 'IDLE', 'ERROR', 'EMERGENCY', 'OFFLINE'],
  APPROVED: ['OPENING', 'IDLE', 'ERROR', 'EMERGENCY'],
  OPENING: ['OPEN', 'CLOSING', 'ERROR', 'EMERGENCY'],
  OPEN: ['CLOSING', 'ERROR', 'EMERGENCY'],
  CLOSING: ['IDLE', 'ERROR', 'EMERGENCY'],
  DENIED: ['IDLE', 'VALIDATING', 'SCANNING', 'APPROVED', 'ERROR', 'EMERGENCY', 'OFFLINE'],
  ERROR: ['IDLE', 'OFFLINE', 'EMERGENCY'],
  OFFLINE: ['IDLE', 'ERROR', 'EMERGENCY'],
  EMERGENCY: ['IDLE'],
};
export const canTransition = (from: GateState, to: GateState) => from === to || GATE_TRANSITIONS[from]?.includes(to);
/** States in which a gate accepts a new scan. */
export const GATE_SCANNABLE: GateState[] = ['IDLE', 'DENIED', 'SCANNING'];

export const RIDE_STATUSES = ['OPEN', 'CLOSED', 'MAINTENANCE', 'TEMPORARILY_CLOSED'] as const;
export type RideStatus = (typeof RIDE_STATUSES)[number];
export const ENTITLEMENT_TYPES = ['ONE_TIME', 'MULTI_USE', 'UNLIMITED', 'TIME_BASED', 'DATE_BASED'] as const;
export type EntitlementType = (typeof ENTITLEMENT_TYPES)[number];

export const SALE_ITEM_TYPES = ['PACKAGE', 'MEMBERSHIP', 'MEMBERSHIP_RENEWAL', 'MEMBERSHIP_UPGRADE', 'TOPUP', 'PRODUCT', 'LOCKER', 'RIDE_ADDON', 'SERVICE'] as const;
export type SaleItemType = (typeof SALE_ITEM_TYPES)[number];
export const PARK_PAYMENT_METHODS = ['CASH', 'PROMPTPAY', 'CARD', 'EWALLET', 'BANK_TRANSFER', 'MOBILE_BANKING', 'WALLET', 'POINTS', 'VOUCHER', 'COMP'] as const;
export type ParkPaymentMethod = (typeof PARK_PAYMENT_METHODS)[number];
export const SALE_CHANNELS = ['ONLINE', 'PORTAL', 'COUNTER', 'KIOSK', 'POS', 'RIDE', 'LOCKER', 'SYSTEM'] as const;
export type SaleChannel = (typeof SALE_CHANNELS)[number];

export interface CheckResult {
  key: string;
  ok: boolean;
  /** Optional detail (e.g. first entry gate/time, uses left). */
  detail?: string | null;
}

/** Snapshot of the customer shown on operator / gate / ride / POS screens after a scan. */
export interface CustomerSnapshot {
  credentialId?: string | null;
  credentialCode?: string | null;
  credentialType?: CredentialType | null;
  credentialStatus?: CredentialStatus | null;
  name?: string | null;
  memberNo?: string | null;
  tier?: { code: string; name: I18nText; color: string } | null;
  ticketNo?: string | null;
  ticketType?: I18nText | null;
  packageName?: I18nText | null;
  visitDate?: string | null;
  ticketStatus?: string | null;
  bookingNo?: string | null;
  walletBalance?: number | null;
  points?: number | null;
  guestIndex?: number | null;
  guestCount?: number | null;
}

export interface GateScanResult {
  scanId: string;
  gateId: string;
  result: 'GRANTED' | 'DENIED' | 'PENDING' | 'APPROVED' | 'OPERATOR_DENIED' | 'TIMEOUT' | 'OVERRIDE' | 'ERROR';
  reasonCode: string | null;
  checks: CheckResult[];
  customer: CustomerSnapshot;
  duplicate?: { firstGate: string | null; firstAt: string | null } | null;
  state: GateState;
}

export interface ParkPrintSale {
  saleNo: string;
  bookingNo?: string | null;
  branchName?: string | null;
  storeName?: I18nText | null;
  createdAt: string;
  paidAt?: string | null;
  timeZone?: string | null;
  cashier?: string | null;
  customer?: string | null;
  memberNo?: string | null;
  items: { name: I18nText; qty: number; unitPrice: number; total: number; note?: string | null }[];
  subtotal: number;
  discount: number;
  vat: number;
  total: number;
  promotions: { name: I18nText; amount: number }[];
  payments: { method: string; amount: number; received?: number | null; change?: number | null; reference?: string | null }[];
  walletBalance?: number | null;
  pointsEarned?: number | null;
  pointsBalance?: number | null;
  lookupUrl?: string | null;
}

export interface ParkPrintTicket {
  ticketNo: string;
  bookingNo?: string | null;
  packageName: I18nText;
  ticketType?: I18nText | null;
  guestName?: string | null;
  visitDate: string;
  validTo?: string | null;
  qr: string;
  barcode: string;
  terms?: I18nText | null;
  price?: number | null;
}

export interface WristbandTemplate {
  showLogo: boolean;
  showQr: boolean;
  showBarcode: boolean;
  showTicketType: boolean;
  showPackage: boolean;
  showDate: boolean;
  showName: boolean;
  headline?: I18nText;
}

export type { I18nText, Lang };
