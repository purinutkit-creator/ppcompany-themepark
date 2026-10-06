import { query, one, type Db } from '../db/pool';

/** Defaults for every settings key. Stored values are deep-merged on top. */
export const DEFAULT_SETTINGS = {
  store: {
    name: { th: 'ครัวฮับ', en: 'Krua Hub', zh: '厨房汇' },
    logoUrl: '',
    address: '123 ถนนสุขุมวิท กรุงเทพฯ 10110',
    phone: '02-123-4567',
    taxId: '0105555555555',
    currency: 'THB',
    currencySymbol: '฿',
  },
  tax: { vatRate: 7, vatMode: 'INCLUDED', serviceChargeRate: 0, serviceChargeOrderTypes: ['DINE_IN'] },
  order: {
    expiryMinutes: 20,
    reserveStockOnCreate: true,
    orderTypes: { DINE_IN: true, TAKE_AWAY: true },
    autoCompleteReadyMinutes: 0,
  },
  kiosk: {
    idleTimeoutSec: 60,
    idleWarningSec: 10,
    resetAfterOrderSec: 10,
    upsellEnabled: true,
    allowSlipUpload: true,
    allowPromoCode: true,
    welcome: {
      title: { th: 'ยินดีต้อนรับ', en: 'Welcome', zh: '欢迎光临' },
      subtitle: { th: 'อร่อยเร็ว สั่งง่าย ด้วยตัวคุณเอง', en: 'Fresh, fast and made your way', zh: '新鲜快捷，随心点餐' },
    },
  },
  payment: {
    methods: { QR: true, CASH: true, CARD: true, OTHER: false },
    qr: {
      mode: 'PROMPTPAY_DYNAMIC',
      promptpayId: '0812345678',
      accountName: 'Krua Hub Co., Ltd.',
      bankName: 'PromptPay',
      countdownSec: 300,
      gatewayProvider: 'sandbox',
    },
    cash: { quickAmounts: [100, 500, 1000] },
    card: { provider: 'sandbox', timeoutSec: 120 },
    other: { label: { th: 'ช่องทางอื่น', en: 'Other payment', zh: '其他支付' } },
  },
  receipt: {
    enabled: true,
    copies: 1,
    language: 'ORDER',
    showLogo: true,
    showQr: true,
    footer: { th: 'ขอบคุณที่ใช้บริการ', en: 'Thank you for your order!', zh: '谢谢惠顾' },
  },
  kitchen: { printEnabled: true, copies: 1, ticketLanguage: 'th', warnMinutes: 8, lateMinutes: 15 },
  queue: {
    preparingCount: 10,
    readyCount: 6,
    sound: true,
    voice: true,
    voiceLanguages: ['th', 'en', 'zh'],
    repeat: 1,
    templates: {
      th: 'หมายเลข {number} กรุณารับอาหารที่เคาน์เตอร์',
      en: 'Order number {number}, please collect your order at the counter',
      zh: '{number}号，请到柜台取餐',
    },
    layout: 'SPLIT',
    animation: 'PULSE',
    logoUrl: '',
    backgroundUrl: '',
    colors: { background: '#111827', preparing: '#f59e0b', ready: '#22c55e', text: '#ffffff' },
    numberSize: 88,
    showLanguages: ['th', 'en', 'zh'],
  },
  security: {
    managerPinActions: ['REFUND', 'VOID', 'MANUAL_PAYMENT_APPROVAL', 'CANCEL_PAID_ORDER', 'MANUAL_GATE_OPEN', 'TICKET_OVERRIDE', 'WALLET_ADJUSTMENT', 'WALLET_REFUND', 'POINTS_ADJUSTMENT', 'LOCKER_FORCE_OPEN', 'BOOKING_CANCEL'],
    maxLoginAttempts: 5,
    lockMinutes: 5,
  },
  theme: {
    primary: '#E4572E',
    secondary: '#2D3142',
    accent: '#FFC145',
    background: '#FFF8F0',
    surface: '#FFFFFF',
    buttonColor: '#E4572E',
    buttonText: '#FFFFFF',
    text: '#1F2333',
    radius: 20,
    logoUrl: '',
    welcomeImageUrl: '',
    welcomeVideoUrl: '',
    cardStyle: 'ELEVATED',
  },
  // Per surface; `byLang` overrides the family for a UI language (e.g. Noto Sans SC for 中文).
  fonts: {
    web: { family: 'Prompt', weight: 400, size: 16, letterSpacing: 0, lineHeight: 1.5, byLang: { zh: 'Noto Sans SC' } as Record<string, string> },
    kiosk: { family: 'Prompt', weight: 400, size: 18, letterSpacing: 0, lineHeight: 1.4, byLang: { zh: 'Noto Sans SC' } as Record<string, string> },
    admin: { family: 'IBM Plex Sans Thai', weight: 400, size: 14, letterSpacing: 0, lineHeight: 1.5, byLang: { en: 'Inter', zh: 'Noto Sans SC' } as Record<string, string> },
    counter: { family: 'IBM Plex Sans Thai', weight: 400, size: 15, letterSpacing: 0, lineHeight: 1.45, byLang: { zh: 'Noto Sans SC' } as Record<string, string> },
    pos: { family: 'IBM Plex Sans Thai', weight: 400, size: 15, letterSpacing: 0, lineHeight: 1.45, byLang: { zh: 'Noto Sans SC' } as Record<string, string> },
    cashier: { family: 'IBM Plex Sans Thai', weight: 400, size: 15, letterSpacing: 0, lineHeight: 1.45, byLang: { zh: 'Noto Sans SC' } as Record<string, string> },
    gate: { family: 'Kanit', weight: 600, size: 22, letterSpacing: 0, lineHeight: 1.25, byLang: { zh: 'Noto Sans SC' } as Record<string, string> },
    ride: { family: 'Kanit', weight: 500, size: 20, letterSpacing: 0, lineHeight: 1.3, byLang: { zh: 'Noto Sans SC' } as Record<string, string> },
    kds: { family: 'Kanit', weight: 400, size: 18, letterSpacing: 0, lineHeight: 1.3, byLang: { zh: 'Noto Sans SC' } as Record<string, string> },
    queue: { family: 'Kanit', weight: 600, size: 24, letterSpacing: 0, lineHeight: 1.2, byLang: { zh: 'Noto Sans SC' } as Record<string, string> },
    receipt: { family: 'Sarabun', weight: 400, size: 24, letterSpacing: 0, lineHeight: 1.3, byLang: { zh: 'Noto Sans SC' } as Record<string, string> },
    ticket: { family: 'Kanit', weight: 500, size: 24, letterSpacing: 0, lineHeight: 1.3, byLang: { zh: 'Noto Sans SC' } as Record<string, string> },
    wristband: { family: 'Kanit', weight: 600, size: 22, letterSpacing: 0, lineHeight: 1.2, byLang: { zh: 'Noto Sans SC' } as Record<string, string> },
    kitchenTicket: { family: 'Sarabun', weight: 600, size: 26, letterSpacing: 0, lineHeight: 1.25, byLang: { zh: 'Noto Sans SC' } as Record<string, string> },
  },
  printing: { retryMaxAttempts: 5, retryBaseSec: 5, staleClaimSec: 90 },

  // ================================================================ theme park
  park: {
    name: { th: 'แฮปปี้แลนด์', en: 'HappyLand Park', zh: '欢乐乐园' },
    tagline: { th: 'สวนสนุกและเพลย์กราวด์ในร่มสำหรับทั้งครอบครัว', en: 'Indoor playground & theme park for the whole family', zh: '全家人的室内游乐园' },
    logoUrl: '',
    openTime: '10:00',
    closeTime: '20:00',
    maxCapacity: 2000,
    dailyTicketCapacity: 2000,
    warnPcts: [80, 90, 100],
    stopOnlineSalesWhenFull: true,
    blockEntryWhenFull: true,
    // Zone / map colour thresholds (percent of zone capacity).
    busyPct: 70,
    crowdedPct: 90,
  },
  gate: {
    defaultMode: 'AUTO' as 'AUTO' | 'MANUAL',
    grantedDisplaySec: 3,
    deniedDisplaySec: 4,
    approvalTimeoutSec: 60,
    passageTimeoutSec: 15,
    requirePassageConfirm: true,
    antiPassback: true,
    allowMemberCardEntry: true,
    exitRequiresInside: false,
    groupBookingEntry: true,
    duplicateIgnoreSec: 3,
    simulatorAutoPassage: true,
  },
  ride: {
    requireParkEntry: true,
    allowAddonPurchase: true,
    pendingPaymentMinutes: 10,
    scanResultDisplaySec: 4,
    peakHours: [] as { days: number[]; start: string; end: string }[],
  },
  rideQueue: {
    callWindowMinutes: 10,
    maxActivePerGuest: 2,
    notifyWhenAhead: 3,
    autoExpire: true,
  },
  wallet: {
    enabled: true,
    quickAmounts: [100, 300, 500, 1000],
    minTopup: 20,
    maxTopup: 20000,
    maxBalance: 50000,
    refundPolicy: 'REFUND_AT_COUNTER' as 'NON_REFUNDABLE' | 'REFUNDABLE' | 'PARTIAL' | 'REFUND_AT_COUNTER' | 'TRANSFER_TO_MEMBER' | 'KEEP_FOR_NEXT_VISIT',
    refundFeePct: 0,
    topupMethods: { CASH: true, PROMPTPAY: true, CARD: true, EWALLET: true },
  },
  member: {
    enabled: true,
    allowDigitalCard: true,
    digitalQrTtlSec: 60,
    defaultValidity: { unit: 'YEAR', value: 1 },
    expiryReminderDays: [30, 7, 1],
    passwordMinLength: 8,
    otp: { enabled: true, channel: 'CONSOLE' as 'CONSOLE' | 'SMS' | 'EMAIL', ttlSec: 300, requireOnRegister: false },
    loginRateLimitPerMin: 10,
    discountPriority: 50,
    discountStackable: true,
  },
  points: {
    enabled: true,
    // "N baht = 1 point" per category; disabled categories earn nothing.
    rules: {
      TICKET: { enabled: true, bahtPerPoint: 100 },
      PACKAGE: { enabled: true, bahtPerPoint: 100 },
      FOOD: { enabled: true, bahtPerPoint: 50 },
      RETAIL: { enabled: true, bahtPerPoint: 50 },
      TOPUP: { enabled: false, bahtPerPoint: 100 },
      MEMBERSHIP: { enabled: true, bahtPerPoint: 100 },
      LOCKER: { enabled: false, bahtPerPoint: 100 },
      RIDE: { enabled: true, bahtPerPoint: 100 },
    } as Record<string, { enabled: boolean; bahtPerPoint: number }>,
    redeemValue: 1,
    allowAsPayment: true,
    expiryMonths: 0,
  },
  booking: {
    holdMinutes: 30,
    payAtParkEnabled: true,
    guestCheckout: true,
    maxGuests: 30,
    advanceDays: 90,
    sameDayCutoff: '18:00',
    autoNoShow: true,
    memberCardEntry: true,
  },
  parkPayment: {
    methods: { CASH: true, PROMPTPAY: true, CARD: true, EWALLET: true, BANK_TRANSFER: true, MOBILE_BANKING: true, WALLET: true, POINTS: true } as Record<string, boolean>,
    online: { PROMPTPAY: true, CARD: true, MOBILE_BANKING: true, BANK_TRANSFER: true } as Record<string, boolean>,
    allowSlipUpload: true,
    qrCountdownSec: 600,
  },
  offline: {
    // Actions a device may queue while offline (synced when back online). Everything else is refused offline.
    allow: { POS_CASH_SALE: true, RIDE_SCAN: false, GATE_SCAN: false, TOPUP: false, REFUND: false, WALLET_ADJUSTMENT: false, MANUAL_GATE_OVERRIDE: false } as Record<string, boolean>,
    maxQueueAgeHours: 24,
  },
  shift: { requireForCash: true, blindClose: false, overShortAlert: 100 },
  parkReceipt: {
    customerCopy: true,
    staffCopy: true,
    printTickets: true,
    showQr: true,
    footer: { th: 'ขอบคุณที่มาเที่ยวกับเรา', en: 'Thank you for visiting!', zh: '感谢您的光临' },
    ticketTerms: {
      th: 'ตั๋วใช้ได้เฉพาะวันที่ระบุ ไม่สามารถแลกคืนเป็นเงินสดได้ กรุณาเก็บไว้ตลอดการเข้าชม',
      en: 'Valid only on the date shown. Non-refundable unless stated. Keep this ticket during your visit.',
      zh: '仅限指定日期使用，除另有说明外不退款。游玩期间请妥善保管。',
    },
    wristband: { showLogo: true, showQr: true, showBarcode: true, showTicketType: true, showPackage: true, showDate: true, showName: false },
  },
  locker: { overtimePolicy: 'ALLOW_OPEN' as 'ALLOW_OPEN' | 'REQUIRE_EXTENSION', openPulseMs: 800, endOfDayRelease: true },
  notification: { capacityAlerts: true, queueTooLongMinutes: 45, lowStockAlerts: true, deviceOfflineMinutes: 2 },
  ui: { staffDefaultLanguage: 'th', customerDefaultLanguage: 'th' },
};

export type Settings = typeof DEFAULT_SETTINGS;
export type SettingsKey = keyof Settings;
export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingsKey[];

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : (over as T));
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out as T;
}

let cache: { at: number; value: Settings } | null = null;
const TTL = 5000;

export function invalidateSettings() {
  cache = null;
}

export async function getSettings(db?: Db): Promise<Settings> {
  if (cache && Date.now() - cache.at < TTL && !db) return cache.value;
  const rows = await query<{ key: string; value: unknown }>(`SELECT key, value FROM settings WHERE scope='global'`, [], db);
  let s = structuredClone(DEFAULT_SETTINGS) as Settings;
  for (const r of rows) if (r.key in s) (s as any)[r.key] = deepMerge((s as any)[r.key], r.value);
  if (!db) cache = { at: Date.now(), value: s };
  return s;
}

export async function getSetting<K extends SettingsKey>(key: K, db?: Db): Promise<Settings[K]> {
  return (await getSettings(db))[key];
}

export async function saveSetting(key: SettingsKey, value: unknown, userId: string | null, db?: Db) {
  const old = await one<{ value: unknown }>(`SELECT value FROM settings WHERE scope='global' AND key=$1`, [key], db);
  await query(
    `INSERT INTO settings (scope, key, value, updated_by, updated_at) VALUES ('global', $1, $2, $3, now())
     ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), userId],
    db,
  );
  invalidateSettings();
  return old?.value ?? null;
}
