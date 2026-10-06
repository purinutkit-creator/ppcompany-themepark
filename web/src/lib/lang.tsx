import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import clsx from 'clsx';
import { PAYMENT_METHOD_LABELS, REASONS, fontForLang, reasonText, tr, type FontSpec, type I18nText, type Lang } from '@kiosk/shared';
import { ApiError, errorMessage, storage } from './api';
import { applyFont, type FontRow } from './theme';

/**
 * System-wide UI language (Thai / English / Chinese). Every screen reads its strings through `useT()`;
 * the admin can override any string per language (Admin → Languages, key `<namespace>.<key>`).
 */
export const LANGS: Lang[] = ['th', 'en', 'zh'];
export const LANG_LABEL: Record<Lang, { flag: string; label: string; short: string }> = {
  th: { flag: '🇹🇭', label: 'ไทย', short: 'TH' },
  en: { flag: '🇬🇧', label: 'English', short: 'EN' },
  zh: { flag: '🇨🇳', label: '中文', short: '中' },
};

type T3 = { th: string; en: string; zh: string };
export type Dict = Record<string, T3>;
export interface StringModule<D extends Dict> {
  ns: string;
  d: D;
}
/** All registered string modules (lets Admin → Languages list every translatable key). */
export const STRING_REGISTRY: Record<string, Dict> = {};
export function defineStrings<D extends Dict>(ns: string, d: D): StringModule<D> {
  STRING_REGISTRY[ns] = d;
  return { ns, d };
}

const isLang = (v: unknown): v is Lang => v === 'th' || v === 'en' || v === 'zh';

interface LangState {
  lang: Lang;
  overrides: Partial<Record<Lang, Record<string, string>>>;
  setLang: (l: Lang) => void;
  setOverrides: (rows: { code: string; overrides?: Record<string, string> | null }[]) => void;
}
export const useUiLang = create<LangState>((set) => ({
  lang: (() => {
    const s = storage.get('ui_lang');
    if (isLang(s)) return s;
    const nav = typeof navigator !== 'undefined' ? navigator.language.slice(0, 2) : 'th';
    return isLang(nav) ? nav : 'th';
  })(),
  overrides: {},
  setLang: (lang) => {
    storage.set('ui_lang', lang);
    set({ lang });
  },
  setOverrides: (rows) => set({ overrides: Object.fromEntries(rows.filter((r) => isLang(r.code)).map((r) => [r.code, r.overrides ?? {}])) }),
}));

const ERR_NETWORK: Record<Lang, string> = { th: 'การเชื่อมต่อขัดข้อง กรุณาลองใหม่', en: 'Connection problem — please try again', zh: '网络异常，请重试' };

// ------------------------------------------------------------------ common strings
export const COMMON = defineStrings('common', {
  language: { th: 'ภาษา', en: 'Language', zh: '语言' },
  save: { th: 'บันทึก', en: 'Save', zh: '保存' },
  cancel: { th: 'ยกเลิก', en: 'Cancel', zh: '取消' },
  close: { th: 'ปิด', en: 'Close', zh: '关闭' },
  confirm: { th: 'ยืนยัน', en: 'Confirm', zh: '确认' },
  back: { th: 'ย้อนกลับ', en: 'Back', zh: '返回' },
  next: { th: 'ถัดไป', en: 'Next', zh: '下一步' },
  done: { th: 'เสร็จสิ้น', en: 'Done', zh: '完成' },
  edit: { th: 'แก้ไข', en: 'Edit', zh: '编辑' },
  delete: { th: 'ลบ', en: 'Delete', zh: '删除' },
  add: { th: 'เพิ่ม', en: 'Add', zh: '添加' },
  create: { th: 'สร้าง', en: 'Create', zh: '创建' },
  new: { th: 'สร้างใหม่', en: 'New', zh: '新建' },
  search: { th: 'ค้นหา', en: 'Search', zh: '搜索' },
  refresh: { th: 'รีเฟรช', en: 'Refresh', zh: '刷新' },
  print: { th: 'พิมพ์', en: 'Print', zh: '打印' },
  reprint: { th: 'พิมพ์ซ้ำ', en: 'Reprint', zh: '重新打印' },
  export: { th: 'ส่งออก', en: 'Export', zh: '导出' },
  loading: { th: 'กำลังโหลด…', en: 'Loading…', zh: '加载中…' },
  noData: { th: 'ยังไม่มีข้อมูล', en: 'Nothing here yet', zh: '暂无数据' },
  yes: { th: 'ใช่', en: 'Yes', zh: '是' },
  no: { th: 'ไม่', en: 'No', zh: '否' },
  all: { th: 'ทั้งหมด', en: 'All', zh: '全部' },
  active: { th: 'ใช้งาน', en: 'Active', zh: '启用' },
  inactive: { th: 'ปิดใช้งาน', en: 'Inactive', zh: '停用' },
  status: { th: 'สถานะ', en: 'Status', zh: '状态' },
  name: { th: 'ชื่อ', en: 'Name', zh: '名称' },
  code: { th: 'รหัส', en: 'Code', zh: '代码' },
  type: { th: 'ประเภท', en: 'Type', zh: '类型' },
  date: { th: 'วันที่', en: 'Date', zh: '日期' },
  time: { th: 'เวลา', en: 'Time', zh: '时间' },
  from: { th: 'จาก', en: 'From', zh: '从' },
  to: { th: 'ถึง', en: 'To', zh: '至' },
  qty: { th: 'จำนวน', en: 'Qty', zh: '数量' },
  price: { th: 'ราคา', en: 'Price', zh: '价格' },
  amount: { th: 'จำนวนเงิน', en: 'Amount', zh: '金额' },
  total: { th: 'ยอดรวม', en: 'Total', zh: '合计' },
  subtotal: { th: 'รวม', en: 'Subtotal', zh: '小计' },
  discount: { th: 'ส่วนลด', en: 'Discount', zh: '折扣' },
  vatIncluded: { th: 'รวม VAT แล้ว', en: 'VAT included', zh: '含增值税' },
  balance: { th: 'ยอดคงเหลือ', en: 'Balance', zh: '余额' },
  points: { th: 'คะแนน', en: 'Points', zh: '积分' },
  phone: { th: 'เบอร์โทร', en: 'Phone', zh: '电话' },
  email: { th: 'อีเมล', en: 'Email', zh: '邮箱' },
  note: { th: 'หมายเหตุ', en: 'Note', zh: '备注' },
  reason: { th: 'เหตุผล', en: 'Reason', zh: '原因' },
  details: { th: 'รายละเอียด', en: 'Details', zh: '详情' },
  actions: { th: 'การทำงาน', en: 'Actions', zh: '操作' },
  online: { th: 'ออนไลน์', en: 'Online', zh: '在线' },
  offline: { th: 'ออฟไลน์', en: 'Offline', zh: '离线' },
  logout: { th: 'ออกจากระบบ', en: 'Log out', zh: '退出登录' },
  login: { th: 'เข้าสู่ระบบ', en: 'Sign in', zh: '登录' },
  scan: { th: 'สแกน', en: 'Scan', zh: '扫描' },
  scanHint: { th: 'สแกน QR / บาร์โค้ด / ริสแบนด์ หรือพิมพ์รหัส', en: 'Scan QR / barcode / wristband or type the code', zh: '扫描二维码 / 条码 / 腕带或输入代码' },
  camera: { th: 'กล้อง', en: 'Camera', zh: '摄像头' },
  cameraOff: { th: 'ปิดกล้อง', en: 'Stop camera', zh: '关闭摄像头' },
  cameraError: { th: 'ไม่สามารถเปิดกล้องได้', en: 'Camera unavailable', zh: '无法打开摄像头' },
  paymentMethod: { th: 'วิธีชำระเงิน', en: 'Payment method', zh: '支付方式' },
  pay: { th: 'ชำระเงิน', en: 'Pay', zh: '付款' },
  paid: { th: 'ชำระแล้ว', en: 'Paid', zh: '已付款' },
  change: { th: 'เงินทอน', en: 'Change', zh: '找零' },
  received: { th: 'รับเงิน', en: 'Received', zh: '实收' },
  outstanding: { th: 'ค้างชำระ', en: 'Outstanding', zh: '待付' },
  member: { th: 'สมาชิก', en: 'Member', zh: '会员' },
  guest: { th: 'ผู้มาเยือน', en: 'Guest', zh: '访客' },
  ticket: { th: 'ตั๋ว', en: 'Ticket', zh: '门票' },
  tickets: { th: 'ตั๋ว', en: 'Tickets', zh: '门票' },
  booking: { th: 'การจอง', en: 'Booking', zh: '预订' },
  wallet: { th: 'กระเป๋าเงิน', en: 'Wallet', zh: '钱包' },
  card: { th: 'บัตร', en: 'Card', zh: '卡' },
  ride: { th: 'เครื่องเล่น', en: 'Ride', zh: '游乐设施' },
  rides: { th: 'เครื่องเล่น', en: 'Rides', zh: '游乐设施' },
  gate: { th: 'ประตู', en: 'Gate', zh: '闸门' },
  queue: { th: 'คิว', en: 'Queue', zh: '排队' },
  locker: { th: 'ล็อกเกอร์', en: 'Locker', zh: '储物柜' },
  minutes: { th: 'นาที', en: 'min', zh: '分钟' },
  today: { th: 'วันนี้', en: 'Today', zh: '今天' },
  managerPin: { th: 'ต้องใช้ PIN ผู้จัดการ', en: 'Manager PIN required', zh: '需要经理PIN' },
  saved: { th: 'บันทึกแล้ว', en: 'Saved', zh: '已保存' },
  error: { th: 'เกิดข้อผิดพลาด', en: 'Something went wrong', zh: '出错了' },
  copied: { th: 'คัดลอกแล้ว', en: 'Copied', zh: '已复制' },
  open: { th: 'เปิด', en: 'Open', zh: '打开' },
  branch: { th: 'สาขา', en: 'Branch', zh: '分店' },
  staff: { th: 'พนักงาน', en: 'Staff', zh: '员工' },
});
type CommonKey = keyof typeof COMMON.d;

/** Display names for the statuses used across the system. */
export const STATUS_TEXT: Record<string, T3> = {
  ACTIVE: { th: 'ใช้งานได้', en: 'Active', zh: '有效' },
  NEW: { th: 'ใหม่', en: 'New', zh: '新' },
  PAID: { th: 'ชำระแล้ว', en: 'Paid', zh: '已付款' },
  UNPAID: { th: 'ยังไม่ชำระ', en: 'Unpaid', zh: '未付款' },
  OPEN: { th: 'เปิด', en: 'Open', zh: '开放' },
  CLOSED: { th: 'ปิด', en: 'Closed', zh: '关闭' },
  PENDING: { th: 'รอดำเนินการ', en: 'Pending', zh: '待处理' },
  PENDING_PAYMENT: { th: 'รอชำระเงิน', en: 'Pending payment', zh: '待付款' },
  WAITING_VERIFICATION: { th: 'รอตรวจสอบ', en: 'Waiting verification', zh: '待核对' },
  WAITING_CASH: { th: 'รอรับเงินสด', en: 'Waiting for cash', zh: '等待现金' },
  WAITING_CARD: { th: 'รอรูดบัตร', en: 'Waiting for card', zh: '等待刷卡' },
  PROCESSING: { th: 'กำลังทำรายการ', en: 'Processing', zh: '处理中' },
  CONFIRMED: { th: 'ยืนยันแล้ว', en: 'Confirmed', zh: '已确认' },
  RESERVED: { th: 'จองแล้ว (ชำระที่สวน)', en: 'Reserved (pay at park)', zh: '已预留（到园付款）' },
  CHECKED_IN: { th: 'เช็คอินแล้ว', en: 'Checked in', zh: '已入园' },
  COMPLETED: { th: 'เสร็จสิ้น', en: 'Completed', zh: '已完成' },
  CANCELLED: { th: 'ยกเลิก', en: 'Cancelled', zh: '已取消' },
  REFUNDED: { th: 'คืนเงินแล้ว', en: 'Refunded', zh: '已退款' },
  PARTIALLY_REFUNDED: { th: 'คืนเงินบางส่วน', en: 'Partially refunded', zh: '部分退款' },
  EXPIRED: { th: 'หมดอายุ', en: 'Expired', zh: '已过期' },
  USED: { th: 'ใช้แล้ว', en: 'Used', zh: '已使用' },
  NO_SHOW: { th: 'ไม่มาตามนัด', en: 'No show', zh: '未到场' },
  SUSPENDED: { th: 'ระงับชั่วคราว', en: 'Suspended', zh: '暂停' },
  LOST: { th: 'แจ้งหาย', en: 'Lost', zh: '挂失' },
  BLOCKED: { th: 'ถูกบล็อก', en: 'Blocked', zh: '已冻结' },
  REPLACED: { th: 'ออกบัตรใหม่แล้ว', en: 'Replaced', zh: '已补卡' },
  VOID: { th: 'ยกเลิกรายการ', en: 'Void', zh: '作废' },
  FAILED: { th: 'ไม่สำเร็จ', en: 'Failed', zh: '失败' },
  APPROVED: { th: 'อนุมัติ', en: 'Approved', zh: '已批准' },
  REJECTED: { th: 'ปฏิเสธ', en: 'Rejected', zh: '已拒绝' },
  GRANTED: { th: 'อนุญาต', en: 'Granted', zh: '允许' },
  DENIED: { th: 'ปฏิเสธ', en: 'Denied', zh: '拒绝' },
  INSIDE: { th: 'อยู่ในสวน', en: 'Inside', zh: '园内' },
  OUTSIDE: { th: 'อยู่นอกสวน', en: 'Outside', zh: '园外' },
  ENTERING: { th: 'กำลังเข้า', en: 'Entering', zh: '正在入园' },
  MAINTENANCE: { th: 'ปิดซ่อมบำรุง', en: 'Maintenance', zh: '维护中' },
  TEMPORARILY_CLOSED: { th: 'ปิดชั่วคราว', en: 'Temporarily closed', zh: '暂停开放' },
  WAITING: { th: 'รอคิว', en: 'Waiting', zh: '等待中' },
  CALLED: { th: 'เรียกแล้ว', en: 'Called', zh: '已叫号' },
  BOARDED: { th: 'ขึ้นเครื่องเล่นแล้ว', en: 'Boarded', zh: '已乘坐' },
  AVAILABLE: { th: 'ว่าง', en: 'Available', zh: '空闲' },
  OCCUPIED: { th: 'ใช้งานอยู่', en: 'Occupied', zh: '使用中' },
  OUT_OF_SERVICE: { th: 'งดให้บริการ', en: 'Out of service', zh: '停用' },
  IDLE: { th: 'พร้อมสแกน', en: 'Ready', zh: '就绪' },
  EMERGENCY: { th: 'ฉุกเฉิน', en: 'Emergency', zh: '紧急' },
  ERROR: { th: 'ขัดข้อง', en: 'Error', zh: '故障' },
  OFFLINE: { th: 'ออฟไลน์', en: 'Offline', zh: '离线' },
  ONLINE: { th: 'ออนไลน์', en: 'Online', zh: '在线' },
  // wallet / points ledger
  TOPUP: { th: 'เติมเงิน', en: 'Top-up', zh: '充值' },
  PAYMENT: { th: 'ชำระเงิน', en: 'Payment', zh: '付款' },
  REFUND: { th: 'คืนเงิน', en: 'Refund', zh: '退款' },
  ADJUSTMENT: { th: 'ปรับยอด', en: 'Adjustment', zh: '调整' },
  ADJUST: { th: 'ปรับคะแนน', en: 'Adjustment', zh: '调整' },
  TRANSFER_IN: { th: 'โอนเข้า', en: 'Transfer in', zh: '转入' },
  TRANSFER_OUT: { th: 'โอนออก', en: 'Transfer out', zh: '转出' },
  BONUS: { th: 'โบนัส', en: 'Bonus', zh: '赠送' },
  REVERSAL: { th: 'กลับรายการ', en: 'Reversal', zh: '冲正' },
  REVERSE: { th: 'กลับรายการ', en: 'Reversal', zh: '冲正' },
  CASHOUT: { th: 'ถอนเงินคืน', en: 'Cash out', zh: '提现' },
  EARN: { th: 'ได้รับคะแนน', en: 'Earned', zh: '获得积分' },
  REDEEM: { th: 'แลกคะแนน', en: 'Redeemed', zh: '兑换' },
  EXHAUSTED: { th: 'ใช้สิทธิ์ครบแล้ว', en: 'Used up', zh: '已用完' },
  NEW_SLIP_REQUESTED: { th: 'ขอสลิปใหม่', en: 'New slip requested', zh: '需重新上传凭证' },
  WAITING_APPROVAL: { th: 'รออนุมัติ', en: 'Waiting approval', zh: '等待批准' },
  PREPARING: { th: 'กำลังเตรียม', en: 'Preparing', zh: '制作中' },
  READY: { th: 'พร้อมรับ', en: 'Ready', zh: '可取餐' },
};

export type TFn<K extends string> = ((key: K | CommonKey, vars?: Record<string, string | number | null | undefined>) => string) & {
  lang: Lang;
  /** Translate a database I18nText value (names, descriptions). */
  tr: (v: I18nText | Record<string, string | undefined> | null | undefined, fallback?: string) => string;
  /** Translate an ad-hoc phrase. */
  x: (v: T3) => string;
  reason: (code: string | null | undefined) => string;
  method: (m: string | null | undefined) => string;
  status: (s: string | null | undefined) => string;
  /** Error text in the UI language: known park reason codes are translated, others use the server message. */
  err: (e: unknown) => string;
};

function makeT<D extends Dict>(lang: Lang, ov: LangState['overrides'], mod?: StringModule<D>): TFn<Extract<keyof D, string>> {
  const fill = (s: string, vars?: Record<string, string | number | null | undefined>) => {
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v ?? ''));
    return s;
  };
  const f = ((key: string, vars?: Record<string, string | number | null | undefined>) => {
    const inMod = mod && key in mod.d;
    const ns = inMod ? mod!.ns : 'common';
    const entry = (inMod ? mod!.d[key] : (COMMON.d as Dict)[key]) as T3 | undefined;
    const s = ov[lang]?.[`${ns}.${key}`] || entry?.[lang] || entry?.en || key;
    return fill(s, vars);
  }) as TFn<Extract<keyof D, string>>;
  f.lang = lang;
  f.tr = (v, fallback = '') => tr(v as I18nText, lang, fallback);
  f.x = (v) => v[lang] || v.en;
  f.reason = (code) => reasonText(code, lang);
  f.method = (m) => (m ? tr(PAYMENT_METHOD_LABELS[m], lang, m) : '');
  f.status = (s) => (s ? STATUS_TEXT[s]?.[lang] ?? s.replace(/_/g, ' ') : '');
  f.err = (e) => {
    if (e instanceof ApiError) {
      if (REASONS[e.code]) return reasonText(e.code, lang);
      if (e.isNetwork) return ERR_NETWORK[lang];
    }
    return errorMessage(e);
  };
  return f;
}

/** Strings for the current UI language. Pass a module from `defineStrings` for screen-specific keys. */
export function useT<D extends Dict = Record<never, T3>>(mod?: StringModule<D>): TFn<Extract<keyof D, string>> {
  const lang = useUiLang((s) => s.lang);
  const ov = useUiLang((s) => s.overrides);
  return useMemo(() => makeT(lang, ov, mod), [lang, ov, mod]);
}

/** Apply the font of a surface for the current language (admin sets a family per language) and `<html lang>`. */
export function useSurfaceFont(fontsSettings: Record<string, FontSpec> | null | undefined, fontRows: FontRow[] | null | undefined, surface: string) {
  const lang = useUiLang((s) => s.lang);
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
    const spec = fontsSettings?.[surface] ?? fontsSettings?.web;
    if (spec) applyFont(fontForLang(spec, lang), fontRows ?? []);
  }, [fontsSettings, fontRows, surface, lang]);
}

export function LangSwitcher({ className, dark, compact }: { className?: string; dark?: boolean; compact?: boolean }) {
  const lang = useUiLang((s) => s.lang);
  const setLang = useUiLang((s) => s.setLang);
  return (
    <div className={clsx('inline-flex items-center gap-0.5 rounded-xl p-0.5', dark ? 'bg-white/10' : 'bg-slate-100', className)} role="group" aria-label="Language">
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          className={clsx(
            'rounded-lg px-2.5 py-1 text-xs font-semibold transition',
            lang === l ? (dark ? 'bg-white text-slate-900' : 'bg-white text-slate-900 shadow-sm') : dark ? 'text-white/70 hover:text-white' : 'text-slate-500 hover:text-slate-800',
          )}
        >
          {compact ? LANG_LABEL[l].short : `${LANG_LABEL[l].flag} ${LANG_LABEL[l].label}`}
        </button>
      ))}
    </div>
  );
}
