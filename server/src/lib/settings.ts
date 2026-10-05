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
    managerPinActions: ['REFUND', 'VOID', 'MANUAL_PAYMENT_APPROVAL', 'CANCEL_PAID_ORDER'],
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
  fonts: {
    kiosk: { family: 'Prompt', weight: 400, size: 18, letterSpacing: 0, lineHeight: 1.4 },
    admin: { family: 'IBM Plex Sans Thai', weight: 400, size: 14, letterSpacing: 0, lineHeight: 1.5 },
    cashier: { family: 'IBM Plex Sans Thai', weight: 400, size: 15, letterSpacing: 0, lineHeight: 1.45 },
    kds: { family: 'Kanit', weight: 400, size: 18, letterSpacing: 0, lineHeight: 1.3 },
    queue: { family: 'Kanit', weight: 600, size: 24, letterSpacing: 0, lineHeight: 1.2 },
    receipt: { family: 'Sarabun', weight: 400, size: 24, letterSpacing: 0, lineHeight: 1.3 },
    kitchenTicket: { family: 'Sarabun', weight: 600, size: 26, letterSpacing: 0, lineHeight: 1.25 },
  },
  printing: { retryMaxAttempts: 5, retryBaseSec: 5, staleClaimSec: 90 },
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
