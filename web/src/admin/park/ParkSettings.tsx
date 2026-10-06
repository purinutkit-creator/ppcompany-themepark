import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { useT } from '../../lib/lang';
import { Button, Card, Field, I18nInput, Input, Loading, NumberInput, PageHeader, Select, Tabs, Toggle } from '../../components/ui';
import { useSaveSetting, useSettings } from '../hooks';

type T3 = { th: string; en: string; zh: string };
const l = (th: string, en: string, zh: string): T3 => ({ th, en, zh });

const SECTIONS: { key: string; label: T3 }[] = [
  { key: 'park', label: l('สวนสนุก & ความจุ', 'Park & capacity', '乐园与容量') },
  { key: 'gate', label: l('ประตูทางเข้า', 'Entrance gates', '入口闸门') },
  { key: 'ride', label: l('เครื่องเล่น', 'Rides', '游乐设施') },
  { key: 'rideQueue', label: l('คิวเสมือน', 'Virtual queue', '虚拟排队') },
  { key: 'booking', label: l('การจองออนไลน์', 'Online booking', '在线预订') },
  { key: 'parkPayment', label: l('การชำระเงิน', 'Payments', '支付') },
  { key: 'wallet', label: l('กระเป๋าเงิน / เติมเงิน', 'Wallet & top-up', '钱包与充值') },
  { key: 'member', label: l('สมาชิก & ความปลอดภัย', 'Members & security', '会员与安全') },
  { key: 'points', label: l('คะแนนสะสม', 'Points', '积分') },
  { key: 'parkReceipt', label: l('ใบเสร็จ / ตั๋ว / ริสแบนด์', 'Receipts, tickets, wristbands', '收据/门票/腕带') },
  { key: 'locker', label: l('ล็อกเกอร์', 'Lockers', '储物柜') },
  { key: 'shift', label: l('กะ & เงินสด', 'Shifts & cash', '班次与现金') },
  { key: 'offline', label: l('โหมดออฟไลน์', 'Offline mode', '离线模式') },
  { key: 'notification', label: l('การแจ้งเตือน', 'Alerts', '提醒') },
  { key: 'ui', label: l('ภาษาเริ่มต้น', 'Default languages', '默认语言') },
];

/** Field labels (any key not listed falls back to a readable version of the key). */
const LABELS: Record<string, T3> = {
  name: l('ชื่อ', 'Name', '名称'), tagline: l('คำโปรย', 'Tagline', '标语'), logoUrl: l('โลโก้ (URL)', 'Logo URL', '标志 URL'), openTime: l('เวลาเปิด', 'Opening time', '开园时间'), closeTime: l('เวลาปิด', 'Closing time', '闭园时间'),
  maxCapacity: l('ความจุสูงสุดในสวน (คน)', 'Max guests inside', '园内最大人数'), dailyTicketCapacity: l('จำนวนบัตรสูงสุดต่อวัน', 'Daily ticket capacity', '每日门票上限'), warnPcts: l('แจ้งเตือนที่ % (คั่นด้วย ,)', 'Warning levels % (comma separated)', '提醒百分比（逗号分隔）'),
  stopOnlineSalesWhenFull: l('หยุดขายออนไลน์เมื่อเต็ม', 'Stop online sales when full', '满员时停止在线销售'), blockEntryWhenFull: l('ห้ามเข้าเมื่อเต็ม', 'Block entry when full', '满员时禁止入园'), busyPct: l('หนาแน่น %', 'Busy at %', '拥挤 %'), crowdedPct: l('แออัด %', 'Crowded at %', '非常拥挤 %'),
  defaultMode: l('โหมดเริ่มต้น', 'Default mode', '默认模式'), grantedDisplaySec: l('แสดงผลผ่าน (วินาที)', 'Granted display (s)', '通过显示（秒）'), deniedDisplaySec: l('แสดงผลไม่ผ่าน (วินาที)', 'Denied display (s)', '拒绝显示（秒）'),
  approvalTimeoutSec: l('รออนุมัติสูงสุด (วินาที)', 'Approval timeout (s)', '审批超时（秒）'), passageTimeoutSec: l('รอเดินผ่านสูงสุด (วินาที)', 'Passage timeout (s)', '通行超时（秒）'), requirePassageConfirm: l('ต้องยืนยันการเดินผ่าน', 'Require passage confirmation', '需确认通行'),
  antiPassback: l('ป้องกันการใช้ซ้ำ (Anti-passback)', 'Anti-passback', '防回传'), allowMemberCardEntry: l('ใช้บัตรสมาชิกเข้าได้', 'Member card entry', '会员卡入园'), exitRequiresInside: l('ออกได้เฉพาะผู้ที่อยู่ในสวน', 'Exit requires being inside', '仅园内可出园'),
  groupBookingEntry: l('เข้าแบบกลุ่มด้วย QR การจอง', 'Group entry with booking QR', '预订码团体入园'), duplicateIgnoreSec: l('ไม่นับสแกนซ้ำภายใน (วินาที)', 'Ignore repeat scan within (s)', '重复扫描忽略（秒）'), simulatorAutoPassage: l('ตัวจำลอง: เดินผ่านอัตโนมัติ', 'Simulator auto passage', '模拟器自动通行'),
  requireParkEntry: l('ต้องเข้าสวนก่อนเล่น', 'Require park entry', '需先入园'), allowAddonPurchase: l('ขายสิทธิ์ที่จุดสแกน', 'Sell rides at scanners', '扫描点可购买'), pendingPaymentMinutes: l('รอชำระสูงสุด (นาที)', 'Pending payment (min)', '待支付（分钟）'), scanResultDisplaySec: l('แสดงผลสแกน (วินาที)', 'Scan result display (s)', '结果显示（秒）'),
  callWindowMinutes: l('เวลาให้มาหลังเรียก (นาที)', 'Call window (min)', '叫号等待（分钟）'), maxActivePerGuest: l('คิวพร้อมกันสูงสุด/คน', 'Max active queues per guest', '每人最多排队数'), notifyWhenAhead: l('แจ้งเตือนเมื่อเหลือ (คิว)', 'Notify when N ahead', '前面剩N位时提醒'), autoExpire: l('หมดอายุอัตโนมัติ', 'Auto expire', '自动过期'),
  holdMinutes: l('กันที่ระหว่างรอชำระ (นาที)', 'Hold unpaid (min)', '未付款保留（分钟）'), payAtParkEnabled: l('จองแล้วจ่ายที่สวน', 'Pay at park', '到园付款'), guestCheckout: l('จองแบบไม่เป็นสมาชิก', 'Guest checkout', '非会员预订'), maxGuests: l('จำนวนคนสูงสุดต่อการจอง', 'Max guests per booking', '每单最多人数'),
  advanceDays: l('จองล่วงหน้าได้ (วัน)', 'Book up to (days ahead)', '可提前预订（天）'), sameDayCutoff: l('ปิดขายวันเดียวกันเวลา', 'Same-day cut-off', '当天截止时间'), autoNoShow: l('ตั้ง No-show อัตโนมัติ', 'Auto no-show', '自动标记未到'), memberCardEntry: l('ใช้บัตรสมาชิกเข้าได้', 'Member card entry', '会员卡入园'),
  methods: l('วิธีชำระที่เปิดใช้ (หน้าร้าน)', 'Enabled methods (on site)', '启用的支付方式（现场）'), online: l('วิธีชำระออนไลน์', 'Online methods', '在线支付方式'), allowSlipUpload: l('ให้แนบสลิป', 'Allow slip upload', '允许上传凭证'), qrCountdownSec: l('อายุ QR (วินาที)', 'QR lifetime (s)', '二维码有效期（秒）'),
  enabled: l('เปิดใช้งาน', 'Enabled', '启用'), quickAmounts: l('ปุ่มเติมเงินด่วน (คั่นด้วย ,)', 'Quick top-up amounts', '快捷充值金额'), minTopup: l('เติมขั้นต่ำ', 'Min top-up', '最低充值'), maxTopup: l('เติมสูงสุด', 'Max top-up', '最高充值'), maxBalance: l('ยอดสูงสุดในบัตร', 'Max balance', '最高余额'),
  refundPolicy: l('นโยบายเงินคงเหลือ', 'Remaining balance policy', '余额政策'), refundFeePct: l('ค่าธรรมเนียมคืน %', 'Refund fee %', '退款手续费 %'), topupMethods: l('วิธีเติมเงิน', 'Top-up methods', '充值方式'),
  allowDigitalCard: l('บัตรสมาชิกดิจิทัล', 'Digital member card', '数字会员卡'), digitalQrTtlSec: l('QR ดิจิทัลเปลี่ยนทุก (วินาที)', 'Digital QR rotates every (s)', '数字二维码刷新（秒）'), defaultValidity: l('อายุสมาชิกเริ่มต้น', 'Default validity', '默认有效期'), unit: l('หน่วย', 'Unit', '单位'), value: l('ค่า', 'Value', '数值'),
  expiryReminderDays: l('แจ้งเตือนก่อนหมดอายุ (วัน)', 'Expiry reminders (days)', '到期提醒（天）'), passwordMinLength: l('รหัสผ่านอย่างน้อย', 'Min password length', '密码最短长度'), otp: l('OTP', 'OTP', '验证码'), channel: l('ช่องทาง', 'Channel', '渠道'), ttlSec: l('อายุ (วินาที)', 'Lifetime (s)', '有效期（秒）'),
  requireOnRegister: l('ต้องยืนยันตอนสมัคร', 'Required on registration', '注册时必须验证'), loginRateLimitPerMin: l('จำกัดการเข้าระบบ/นาที', 'Login attempts per minute', '每分钟登录次数'), discountPriority: l('ลำดับส่วนลดสมาชิก', 'Member discount priority', '会员折扣优先级'), discountStackable: l('ส่วนลดสมาชิกใช้ร่วมกับโปรได้', 'Member discount stackable', '会员折扣可叠加'),
  rules: l('อัตราคะแนนตามหมวด (บาทต่อ 1 คะแนน)', 'Earning per category (baht per point)', '各类别积分（每积分金额）'), bahtPerPoint: l('บาทต่อ 1 คะแนน', 'Baht per point', '每积分金额'), redeemValue: l('มูลค่า 1 คะแนน (บาท)', 'Value of 1 point', '每积分价值'), allowAsPayment: l('ใช้คะแนนจ่ายได้', 'Points as payment', '积分可支付'), expiryMonths: l('คะแนนหมดอายุ (เดือน, 0 = ไม่หมด)', 'Points expiry (months, 0 = never)', '积分有效期（月，0=永久）'),
  customerCopy: l('พิมพ์ใบเสร็จลูกค้า', 'Print customer copy', '打印客户联'), staffCopy: l('พิมพ์ใบเสร็จพนักงาน', 'Print staff copy', '打印员工联'), printTickets: l('พิมพ์ตั๋ว', 'Print tickets', '打印门票'), showQr: l('แสดง QR บนใบเสร็จ', 'QR on receipt', '收据显示二维码'), footer: l('ข้อความท้ายใบเสร็จ', 'Receipt footer', '收据页脚'),
  ticketTerms: l('เงื่อนไขบนตั๋ว', 'Ticket terms', '门票条款'), wristband: l('ริสแบนด์', 'Wristband layout', '腕带布局'), showLogo: l('โลโก้', 'Logo', '标志'), showBarcode: l('บาร์โค้ด', 'Barcode', '条码'), showTicketType: l('ประเภทตั๋ว', 'Ticket type', '票种'), showPackage: l('แพ็กเกจ', 'Package', '套餐'), showDate: l('วันที่', 'Date', '日期'), showName: l('ชื่อ', 'Name', '姓名'),
  overtimePolicy: l('เกินเวลา', 'Overtime policy', '超时政策'), openPulseMs: l('สัญญาณเปิด (ms)', 'Open pulse (ms)', '开锁脉冲（毫秒）'), endOfDayRelease: l('คืนตู้อัตโนมัติสิ้นวัน', 'Release at end of day', '每日结束自动释放'),
  requireForCash: l('ต้องเปิดกะก่อนรับเงินสด', 'Shift required for cash', '收现金需开班'), blindClose: l('ปิดกะแบบไม่แสดงยอด', 'Blind close', '盲交班'), overShortAlert: l('แจ้งเตือนเงินขาด/เกินเกิน', 'Over / short alert above', '长短款提醒阈值'),
  allow: l('อนุญาตเมื่อออฟไลน์', 'Allowed while offline', '离线时允许'), maxQueueAgeHours: l('เก็บคิวออฟไลน์สูงสุด (ชม.)', 'Max offline queue age (h)', '离线队列最长（小时）'),
  capacityAlerts: l('แจ้งเตือนความจุ', 'Capacity alerts', '容量提醒'), queueTooLongMinutes: l('คิวยาวเกิน (นาที)', 'Queue too long (min)', '排队过长（分钟）'), lowStockAlerts: l('แจ้งเตือนสต็อกต่ำ', 'Low stock alerts', '低库存提醒'), deviceOfflineMinutes: l('อุปกรณ์ออฟไลน์เกิน (นาที)', 'Device offline after (min)', '设备离线（分钟）'),
  staffDefaultLanguage: l('ภาษาเริ่มต้นพนักงาน', 'Staff default language', '员工默认语言'), customerDefaultLanguage: l('ภาษาเริ่มต้นลูกค้า', 'Customer default language', '客户默认语言'),
};
const ENUMS: Record<string, string[]> = {
  defaultMode: ['AUTO', 'MANUAL'], refundPolicy: ['NON_REFUNDABLE', 'REFUNDABLE', 'PARTIAL', 'REFUND_AT_COUNTER', 'TRANSFER_TO_MEMBER', 'KEEP_FOR_NEXT_VISIT'], unit: ['DAY', 'MONTH', 'YEAR', 'LIFETIME'],
  channel: ['CONSOLE', 'SMS', 'EMAIL'], overtimePolicy: ['ALLOW_OPEN', 'REQUIRE_EXTENSION'], staffDefaultLanguage: ['th', 'en', 'zh'], customerDefaultLanguage: ['th', 'en', 'zh'],
};
const isI18n = (v: any) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => ['th', 'en', 'zh'].includes(k));
const human = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

function Value({ k, v, onChange, depth }: { k: string; v: any; onChange: (v: any) => void; depth: number }) {
  const t = useT();
  const label = LABELS[k] ? t.x(LABELS[k]) : human(k);
  if (typeof v === 'boolean') return <Toggle checked={v} onChange={onChange} label={label} />;
  if (typeof v === 'number') return <Field label={label}><NumberInput value={v} onChange={(x) => onChange(x ?? 0)} /></Field>;
  if (typeof v === 'string') {
    if (ENUMS[k]) return <Field label={label}><Select value={v} onChange={(e) => onChange(e.target.value)}>{ENUMS[k].map((o) => <option key={o} value={o}>{o}</option>)}</Select></Field>;
    return <Field label={label}><Input type={/^\d{2}:\d{2}$/.test(v) ? 'time' : 'text'} value={v} onChange={(e) => onChange(e.target.value)} /></Field>;
  }
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === 'number')) return <Field label={label}><Input value={v.join(', ')} onChange={(e) => onChange(e.target.value.split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)))} /></Field>;
    return <Field label={label} hint="JSON"><Input value={JSON.stringify(v)} onChange={(e) => { try { onChange(JSON.parse(e.target.value)); } catch { /* keep typing */ } }} className="font-mono text-xs" /></Field>;
  }
  if (isI18n(v)) return <I18nInput label={label} value={v} onChange={onChange} multiline={k === 'ticketTerms'} />;
  if (v && typeof v === 'object') {
    return (
      <div className={depth === 0 ? '' : 'rounded-xl border bg-slate-50/60 p-3'}>
        {depth > 0 && <div className="mb-2 text-sm font-semibold text-slate-700">{label}</div>}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Object.entries(v).map(([ck, cv]) => (
            <div key={ck} className={cv && typeof cv === 'object' && !Array.isArray(cv) ? 'md:col-span-2 xl:col-span-3' : ''}>
              <Value k={ck} v={cv} depth={depth + 1} onChange={(nv) => onChange({ ...v, [ck]: nv })} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  return null;
}

export default function ParkSettings() {
  const t = useT();
  const s = useSettings();
  const save = useSaveSetting();
  const [sec, setSec] = useState('park');
  const [draft, setDraft] = useState<any>(null);
  useEffect(() => {
    if (s.data) setDraft(s.data.settings[sec]);
  }, [s.data, sec]);
  if (!s.data || !draft) return <Loading />;
  return (
    <div>
      <PageHeader title={t.x(l('ตั้งค่าสวนสนุก', 'Park settings', '乐园设置'))} sub={t.x(l('มีผลทันทีกับทุกอุปกรณ์แบบเรียลไทม์', 'Applied to every device in real time', '实时应用到所有设备'))}
        actions={<Button icon={<Save className="h-4 w-4" />} loading={save.isPending} onClick={() => save.mutate({ key: sec, value: draft })}>{t('save')}</Button>} />
      <Tabs value={sec} onChange={setSec} tabs={SECTIONS.map((x) => ({ id: x.key, label: t.x(x.label) }))} className="mb-4 flex-wrap" />
      <Card>
        <Value k={sec} v={draft} depth={0} onChange={setDraft} />
      </Card>
    </div>
  );
}
