import { useState } from 'react';
import { Copy, KeyRound, Plus, RefreshCcw, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { tr } from '@kiosk/shared';
import { parkApi } from '../../lib/api';
import { money } from '../../lib/format';
import { useT } from '../../lib/lang';
import { Badge, Button, Field, I18nInput, Input, Modal, NumberInput, Select, toast } from '../../components/ui';
import { ActiveBadge, EntityPage, L, Swatch, type FieldDef } from './EntityPage';
import { enumOpts, useParkOptions } from './options';

const ENT = ['ONE_TIME', 'MULTI_USE', 'UNLIMITED', 'TIME_BASED', 'DATE_BASED'] as const;
const nm = (lang: any) => (r: any) => <div><div className="font-medium">{tr(r.name, lang, r.code)}</div><div className="font-mono text-xs text-slate-500">{r.code}</div></div>;

// ------------------------------------------------------------------ ticket types
export function TicketTypes() {
  const t = useT();
  const fields: FieldDef[] = [
    { k: 'code', label: L('รหัส', 'Code', '代码'), type: 'code' },
    { k: 'color', label: L('สี', 'Color', '颜色'), type: 'color' },
    { k: 'sort', label: L('ลำดับ', 'Sort', '排序'), type: 'number' },
    { k: 'name', label: L('ชื่อ', 'Name', '名称'), type: 'i18n' },
    { k: 'description', label: L('คำอธิบาย', 'Description', '描述'), type: 'i18n' },
    { k: 'min_age', label: L('อายุต่ำสุด', 'Min age', '最小年龄'), type: 'number', nullable: true },
    { k: 'max_age', label: L('อายุสูงสุด', 'Max age', '最大年龄'), type: 'number', nullable: true },
    { k: 'min_height', label: L('ส่วนสูงต่ำสุด (ซม.)', 'Min height (cm)', '最低身高（厘米）'), type: 'number', nullable: true },
    { k: 'max_height', label: L('ส่วนสูงสูงสุด (ซม.)', 'Max height (cm)', '最高身高（厘米）'), type: 'number', nullable: true },
    { k: 'requires_proof', label: L('ต้องแสดงหลักฐาน (บัตรนักเรียน ฯลฯ)', 'Requires proof (student ID…)', '需出示证明（学生证等）'), type: 'bool' },
    { k: 'is_active', label: L('ใช้งาน', 'Active', '启用'), type: 'bool' },
  ];
  return (
    <EntityPage
      title={L('ประเภทตั๋ว', 'Ticket types', '票种')}
      sub={L('ผู้ใหญ่ เด็ก ผู้สูงอายุ นักเรียน ทารก — ใช้กำหนดราคาในแต่ละแพ็กเกจ', 'Adult, child, senior, student, infant — priced per package', '成人、儿童、长者、学生、婴儿 — 在套餐中定价')}
      path="/admin/ticket-types" queryKey="pk-ticket-types" perm="tickets.manage" fields={fields}
      blank={{ code: '', name: {}, description: {}, color: '#0ea5e9', sort: 0, requires_proof: false, is_active: true }}
      columns={[
        { label: L('ชื่อ', 'Name', '名称'), render: nm(t.lang) },
        { label: L('อายุ', 'Age', '年龄'), render: (r) => `${r.min_age ?? '–'} – ${r.max_age ?? '–'}` },
        { label: L('ส่วนสูง', 'Height', '身高'), render: (r) => `${r.min_height ?? '–'} – ${r.max_height ?? '–'}` },
        { label: L('สี', 'Color', '颜色'), render: (r) => <Swatch c={r.color} /> },
        { label: L('สถานะ', 'Status', '状态'), render: (r) => <ActiveBadge on={r.is_active} /> },
      ]}
    />
  );
}

// ------------------------------------------------------------------ packages
export function Packages() {
  const t = useT();
  const o = useParkOptions();
  const fields: FieldDef[] = [
    { k: 'code', label: L('รหัส', 'Code', '代码'), type: 'code' },
    { k: 'kind', label: L('ชนิด', 'Kind', '类型'), type: 'select', options: enumOpts(['ADMISSION', 'ADDON', 'RIDE_PASS', 'FAST_PASS', 'LOCKER', 'FOOD_VOUCHER', 'WALLET_CREDIT', 'EVENT']) },
    { k: 'color', label: L('สี', 'Color', '颜色'), type: 'color' },
    { k: 'name', label: L('ชื่อ', 'Name', '名称'), type: 'i18n' },
    { k: 'description', label: L('คำอธิบาย', 'Description', '描述'), type: 'i18nMulti' },
    { k: 'terms', label: L('เงื่อนไข', 'Terms', '条款'), type: 'i18nMulti' },
    { k: 'image_url', label: L('รูปภาพ', 'Image', '图片'), type: 'image' },
    { k: 'base_price', label: L('ราคาพื้นฐาน', 'Base price', '基础价格'), type: 'money' },
    { k: 'days', label: L('จำนวนวัน', 'Days', '天数'), type: 'number' },
    { k: 'usage_mode', label: L('รูปแบบการใช้', 'Usage mode', '使用方式'), type: 'select', options: [{ value: 'FIXED_DATES', label: t.x(L('วันติดกัน', 'Consecutive days', '连续天数')) }, { value: 'FLEX_DAYS', label: t.x(L('เลือกวันได้ภายในช่วง', 'Flexible within window', '期限内任选')) }] },
    { k: 'flex_window_days', label: L('ช่วงเวลาที่ใช้ได้ (วัน)', 'Flex window (days)', '有效窗口（天）'), type: 'number', showIf: (f) => f.usage_mode === 'FLEX_DAYS' },
    { k: 'entries_per_day', label: L('จำนวนครั้งที่เข้าได้/วัน', 'Entries per day', '每日入园次数'), type: 'number', nullable: true },
    { k: 'time_start', label: L('เข้าได้ตั้งแต่', 'Valid from (time)', '起始时间'), type: 'time' },
    { k: 'time_end', label: L('ถึงเวลา', 'Valid until (time)', '截止时间'), type: 'time' },
    { k: 'daily_capacity', label: L('ขายได้สูงสุด/วัน', 'Daily capacity', '每日限量'), type: 'number', nullable: true },
    { k: 'guests_per_unit', label: L('จำนวนคนต่อชุด', 'Guests per unit', '每份人数'), type: 'number' },
    { k: 'min_qty', label: L('ขั้นต่ำ', 'Min qty', '最少数量'), type: 'number' },
    { k: 'max_qty', label: L('สูงสุด', 'Max qty', '最多数量'), type: 'number' },
    { k: 'sale_from', label: L('เริ่มขาย', 'Sale from', '开售日期'), type: 'date' },
    { k: 'sale_to', label: L('สิ้นสุดการขาย', 'Sale to', '停售日期'), type: 'date' },
    { k: 'refund_policy', label: L('นโยบายคืนเงิน', 'Refund policy', '退款政策'), type: 'select', options: enumOpts(['NON_REFUNDABLE', 'FULL_BEFORE_VISIT', 'PARTIAL_BEFORE_VISIT', 'ANYTIME']) },
    { k: 'refund_cutoff_hours', label: L('คืนได้ก่อน (ชม.)', 'Refund cut-off (h)', '退款截止（小时）'), type: 'number' },
    { k: 'refund_fee_pct', label: L('ค่าธรรมเนียมคืน %', 'Refund fee %', '退款手续费 %'), type: 'number' },
    { k: 'channels', label: L('ช่องทางขาย', 'Sales channels', '销售渠道'), type: 'multi', options: enumOpts(['ONLINE', 'COUNTER', 'KIOSK', 'PORTAL']) },
    { k: 'valid_days', label: L('วันที่ใช้ได้ (ว่าง = ทุกวัน)', 'Valid weekdays (none = every day)', '可用星期（空=每天）'), type: 'multi', options: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => ({ value: String(i), label: d })) },
    { k: 'branch_ids', label: L('สาขา (ว่าง = ทุกสาขา)', 'Branches (none = all)', '分店（空=全部）'), type: 'multi', options: o.branches },
    { k: 'zone_ids', label: L('โซนที่เข้าได้ (ว่าง = ทุกโซน)', 'Allowed zones (none = all)', '可进入区域（空=全部）'), type: 'multi', options: o.zones },
    { k: 'tier_ids', label: L('เฉพาะระดับสมาชิก', 'Member tiers only', '限会员等级'), type: 'multi', options: o.tiers },
    { k: 'all_rides', label: L('เล่นได้ทุกเครื่อง', 'All rides included', '包含全部设施'), type: 'bool' },
    { k: 'all_rides_type', label: L('สิทธิ์เครื่องเล่น', 'Ride entitlement', '游乐权益'), type: 'select', options: enumOpts(ENT), showIf: (f) => f.all_rides },
    { k: 'all_rides_uses', label: L('จำนวนครั้ง', 'Uses', '次数'), type: 'number', nullable: true, showIf: (f) => f.all_rides && f.all_rides_type === 'MULTI_USE' },
    { k: 'reentry', label: L('ออกแล้วเข้าใหม่ได้', 'Re-entry allowed', '允许再次入园'), type: 'bool' },
    { k: 'transferable', label: L('โอนให้ผู้อื่นได้', 'Transferable', '可转让'), type: 'bool' },
    { k: 'member_only', label: L('เฉพาะสมาชิก', 'Members only', '仅限会员'), type: 'bool' },
    { k: 'points_eligible', label: L('ได้รับคะแนน', 'Earns points', '可获积分'), type: 'bool' },
    { k: 'requires_visit_date', label: L('ต้องเลือกวันเข้าชม', 'Requires visit date', '需选择游玩日期'), type: 'bool' },
    { k: 'sort', label: L('ลำดับ', 'Sort', '排序'), type: 'number' },
    { k: 'is_active', label: L('ใช้งาน', 'Active', '启用'), type: 'bool' },
  ];
  return (
    <EntityPage
      title={L('แพ็กเกจบัตร', 'Packages', '门票套餐')}
      sub={L('ราคาแยกตามประเภทตั๋ว สิทธิ์เครื่องเล่น สิทธิประโยชน์ บันเดิล — ไม่ต้องแก้โค้ด', 'Prices per ticket type, ride entitlements, benefits and bundles — no code changes', '按票种定价、游乐权益、福利和组合 — 无需改代码')}
      path="/admin/packages" queryKey="pk-packages" perm="tickets.manage" fields={fields} size="full"
      blank={{ code: '', kind: 'ADMISSION', name: {}, description: {}, terms: {}, color: '#6366f1', base_price: 0, days: 1, usage_mode: 'FIXED_DATES', flex_window_days: 1, guests_per_unit: 1, min_qty: 1, max_qty: 20, channels: ['ONLINE', 'COUNTER', 'KIOSK'], valid_days: [], branch_ids: [], zone_ids: [], tier_ids: [], blackout_dates: [], bundle: {}, all_rides: false, all_rides_type: 'UNLIMITED', reentry: true, transferable: false, member_only: false, points_eligible: true, requires_visit_date: true, refund_policy: 'NON_REFUNDABLE', refund_cutoff_hours: 24, refund_fee_pct: 0, sort: 0, is_active: true, prices: [], rides: [], benefits: [] }}
      fromRow={(r) => ({ ...r, valid_days: (r.valid_days ?? []).map(String), base_price: Number(r.base_price), refund_fee_pct: Number(r.refund_fee_pct), prices: (r.prices ?? []).map((p: any) => ({ ...p, price: Number(p.price), member_price: p.member_price == null ? null : Number(p.member_price), weekend_price: p.weekend_price == null ? null : Number(p.weekend_price) })), blackout_dates: (r.blackout_dates ?? []).map((d: string) => String(d).slice(0, 10)) })}
      toBody={(f) => {
        const { id, created_at, updated_at, sold, ...b } = f;
        return { ...b, valid_days: (b.valid_days ?? []).map(Number), time_start: b.time_start || null, time_end: b.time_end || null, sale_from: b.sale_from || null, sale_to: b.sale_to || null, image_url: b.image_url || null, all_rides_uses: b.all_rides_uses ?? null };
      }}
      extra={(f, set) => <PackageExtras f={f} set={set} />}
      columns={[
        { label: L('แพ็กเกจ', 'Package', '套餐'), render: (r) => <div className="flex items-center gap-2"><Swatch c={r.color} />{nm(t.lang)(r)}</div> },
        { label: L('ชนิด', 'Kind', '类型'), render: (r) => <Badge>{r.kind}</Badge> },
        { label: L('ราคา', 'Prices', '价格'), render: (r) => <div className="text-xs">{(r.prices ?? []).map((p: any) => `${tr(o.ticketTypeRows.find((x) => x.id === p.ticket_type_id)?.name, t.lang, '•')} ${money(p.price)}`).join(' · ') || money(r.base_price)}</div> },
        { label: L('วัน', 'Days', '天数'), render: (r) => r.days },
        { label: L('ขายแล้ว', 'Sold', '已售'), render: (r) => r.sold },
        { label: L('สถานะ', 'Status', '状态'), render: (r) => <ActiveBadge on={r.is_active} /> },
      ]}
    />
  );
}

function PackageExtras({ f, set }: { f: any; set: (v: any) => void }) {
  const t = useT();
  const o = useParkOptions();
  const prices: any[] = f.prices ?? [];
  const rides: any[] = f.rides ?? [];
  const benefits: any[] = f.benefits ?? [];
  const upd = (k: string, v: any) => set({ ...f, [k]: v });
  const [bundleCode, setBundleCode] = useState('');
  return (
    <div className="space-y-5">
      <section className="rounded-2xl border p-3">
        <div className="mb-2 flex items-center justify-between font-semibold">{t.x(L('ราคาตามประเภทตั๋ว', 'Prices per ticket type', '按票种定价'))}<Button size="sm" variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => upd('prices', [...prices, { ticket_type_id: null, price: 0, member_price: null, weekend_price: null, tier_prices: {} }])}>{t('add')}</Button></div>
        <div className="space-y-2">
          {prices.map((p, i) => (
            <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_120px_120px_120px_auto]">
              <Field label={t.x(L('ประเภทตั๋ว', 'Ticket type', '票种'))}><Select value={p.ticket_type_id ?? ''} onChange={(e) => upd('prices', prices.map((x, j) => (j === i ? { ...x, ticket_type_id: e.target.value || null } : x)))}><option value="">{t.x(L('ราคาเดียว (ไม่แยกประเภท)', 'Single price', '统一价格'))}</option>{o.ticketTypes.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</Select></Field>
              <Field label={t('price')}><NumberInput value={p.price} onChange={(v) => upd('prices', prices.map((x, j) => (j === i ? { ...x, price: v ?? 0 } : x)))} /></Field>
              <Field label={t.x(L('ราคาสมาชิก', 'Member', '会员价'))}><NumberInput value={p.member_price} onChange={(v) => upd('prices', prices.map((x, j) => (j === i ? { ...x, member_price: v } : x)))} /></Field>
              <Field label={t.x(L('เสาร์-อาทิตย์', 'Weekend', '周末价'))}><NumberInput value={p.weekend_price} onChange={(v) => upd('prices', prices.map((x, j) => (j === i ? { ...x, weekend_price: v } : x)))} /></Field>
              <Button variant="ghost" className="text-rose-600" onClick={() => upd('prices', prices.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
        </div>
      </section>
      {!f.all_rides && (
        <section className="rounded-2xl border p-3">
          <div className="mb-2 flex items-center justify-between font-semibold">{t.x(L('เครื่องเล่นที่รวม', 'Included rides', '包含的设施'))}<Button size="sm" variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => upd('rides', [...rides, { ride_id: o.rides[0]?.value, entitlement_type: 'UNLIMITED', uses: null }])}>{t('add')}</Button></div>
          {rides.map((r, i) => (
            <div key={i} className="mb-2 grid items-end gap-2 sm:grid-cols-[1fr_180px_100px_auto]">
              <Select value={r.ride_id} onChange={(e) => upd('rides', rides.map((x, j) => (j === i ? { ...x, ride_id: e.target.value } : x)))}>{o.rides.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</Select>
              <Select value={r.entitlement_type} onChange={(e) => upd('rides', rides.map((x, j) => (j === i ? { ...x, entitlement_type: e.target.value } : x)))}>{ENT.map((x) => <option key={x}>{x}</option>)}</Select>
              <NumberInput value={r.uses} placeholder="uses" onChange={(v) => upd('rides', rides.map((x, j) => (j === i ? { ...x, uses: v } : x)))} />
              <Button variant="ghost" className="text-rose-600" onClick={() => upd('rides', rides.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
        </section>
      )}
      <section className="rounded-2xl border p-3">
        <div className="mb-2 flex items-center justify-between font-semibold">{t.x(L('สิทธิประโยชน์ในแพ็กเกจ', 'Package benefits', '套餐福利'))}<Button size="sm" variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => upd('benefits', [...benefits, { type: 'FOOD_VOUCHER', value: 0, qty: 1, name: {}, config: {} }])}>{t('add')}</Button></div>
        {benefits.map((b, i) => (
          <div key={i} className="mb-3 space-y-2 rounded-xl bg-slate-50 p-2">
            <div className="grid items-end gap-2 sm:grid-cols-[200px_120px_100px_auto]">
              <Select value={b.type} onChange={(e) => upd('benefits', benefits.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>{['FOOD_VOUCHER', 'LOCKER', 'FAST_PASS', 'WALLET_CREDIT', 'PHOTO', 'COUPON', 'CUSTOM'].map((x) => <option key={x}>{x}</option>)}</Select>
              <NumberInput value={b.value} placeholder={t('amount')} onChange={(v) => upd('benefits', benefits.map((x, j) => (j === i ? { ...x, value: v ?? 0 } : x)))} />
              <NumberInput value={b.qty} placeholder={t('qty')} onChange={(v) => upd('benefits', benefits.map((x, j) => (j === i ? { ...x, qty: v ?? 1 } : x)))} />
              <Button variant="ghost" className="text-rose-600" onClick={() => upd('benefits', benefits.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
            </div>
            <I18nInput value={b.name} onChange={(v) => upd('benefits', benefits.map((x, j) => (j === i ? { ...x, name: v } : x)))} />
          </div>
        ))}
      </section>
      <section className="rounded-2xl border p-3">
        <div className="mb-2 font-semibold">{t.x(L('บันเดิล (เช่น ครอบครัว = ผู้ใหญ่ 2 + เด็ก 2)', 'Bundle (e.g. family = 2 adults + 2 children)', '组合（如家庭=2成人+2儿童）'))}</div>
        <div className="flex flex-wrap items-center gap-2">
          {Object.entries(f.bundle ?? {}).map(([code, n]) => (
            <span key={code} className="flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-sm">{code} × <input type="number" min={1} value={n as number} className="w-12 bg-transparent" onChange={(e) => upd('bundle', { ...f.bundle, [code]: Number(e.target.value) || 1 })} /><button onClick={() => { const b = { ...f.bundle }; delete b[code]; upd('bundle', b); }}>✕</button></span>
          ))}
          <Select value={bundleCode} onChange={(e) => setBundleCode(e.target.value)} className="w-48"><option value="">—</option>{o.ticketTypeRows.map((x) => <option key={x.id} value={x.code}>{tr(x.name, t.lang, x.code)}</option>)}</Select>
          <Button size="sm" variant="outline" disabled={!bundleCode} onClick={() => { upd('bundle', { ...(f.bundle ?? {}), [bundleCode]: 1 }); setBundleCode(''); }}>{t('add')}</Button>
        </div>
      </section>
      <section className="rounded-2xl border p-3">
        <div className="mb-2 font-semibold">{t.x(L('วันงดจำหน่าย', 'Blackout dates', '不可用日期'))}</div>
        <div className="flex flex-wrap items-center gap-2">
          {(f.blackout_dates ?? []).map((d: string) => <span key={d} className="rounded-full bg-rose-50 px-3 py-1 text-sm text-rose-800">{d} <button onClick={() => upd('blackout_dates', f.blackout_dates.filter((x: string) => x !== d))}>✕</button></span>)}
          <Input type="date" className="w-44" onChange={(e) => e.target.value && upd('blackout_dates', [...new Set([...(f.blackout_dates ?? []), e.target.value])])} />
        </div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ rides + scan points
export function Rides() {
  const t = useT();
  const o = useParkOptions();
  const fields: FieldDef[] = [
    { k: 'code', label: L('รหัส', 'Code', '代码'), type: 'code' },
    { k: 'zone_id', label: L('โซน', 'Zone', '区域'), type: 'select', options: o.zones, nullable: true },
    { k: 'status', label: L('สถานะ', 'Status', '状态'), type: 'select', options: enumOpts(['OPEN', 'CLOSED', 'MAINTENANCE', 'TEMPORARILY_CLOSED'], (v) => t.status(v)) },
    { k: 'name', label: L('ชื่อ', 'Name', '名称'), type: 'i18n' },
    { k: 'description', label: L('คำอธิบาย', 'Description', '描述'), type: 'i18nMulti' },
    { k: 'image_url', label: L('รูปภาพ', 'Image', '图片'), type: 'image' },
    { k: 'capacity', label: L('ความจุต่อรอบ', 'Capacity per cycle', '每轮容量'), type: 'number' },
    { k: 'duration_minutes', label: L('เวลาต่อรอบ (นาที)', 'Cycle minutes', '每轮分钟'), type: 'number' },
    { k: 'min_height', label: L('ส่วนสูงต่ำสุด', 'Min height', '最低身高'), type: 'number', nullable: true },
    { k: 'max_height', label: L('ส่วนสูงสูงสุด', 'Max height', '最高身高'), type: 'number', nullable: true },
    { k: 'min_age', label: L('อายุต่ำสุด', 'Min age', '最小年龄'), type: 'number', nullable: true },
    { k: 'max_age', label: L('อายุสูงสุด', 'Max age', '最大年龄'), type: 'number', nullable: true },
    { k: 'ticket_required', label: L('ต้องเข้าสวนก่อน', 'Park entry required', '需先入园'), type: 'bool' },
    { k: 'addon_enabled', label: L('ขายสิทธิ์ที่จุดสแกน', 'Sell at scanner', '扫描点可购买'), type: 'bool' },
    { k: 'addon_price', label: L('ราคา', 'Price', '价格'), type: 'money', nullable: true },
    { k: 'member_price', label: L('ราคาสมาชิก', 'Member price', '会员价'), type: 'money', nullable: true },
    { k: 'peak_price', label: L('ราคาช่วงพีค', 'Peak price', '高峰价'), type: 'money', nullable: true },
    { k: 'addon_type', label: L('สิทธิ์ที่ได้', 'Entitlement sold', '售出权益'), type: 'select', options: enumOpts(ENT) },
    { k: 'addon_uses', label: L('จำนวนครั้ง', 'Uses', '次数'), type: 'number' },
    { k: 'addon_valid_minutes', label: L('ใช้ได้ (นาที)', 'Valid minutes', '有效分钟'), type: 'number', nullable: true },
    { k: 'point_cost', label: L('แลกด้วยคะแนน', 'Point cost', '积分兑换'), type: 'number', nullable: true },
    { k: 'queue_enabled', label: L('คิวเสมือน', 'Virtual queue', '虚拟排队'), type: 'bool' },
    { k: 'queue_prefix', label: L('อักษรนำหน้าคิว', 'Queue prefix', '排队号前缀'), type: 'code' },
    { k: 'operator_id', label: L('ผู้ควบคุม', 'Operator', '操作员'), type: 'select', options: o.staff, nullable: true },
    { k: 'sort', label: L('ลำดับ', 'Sort', '排序'), type: 'number' },
    { k: 'is_active', label: L('ใช้งาน', 'Active', '启用'), type: 'bool' },
  ];
  return (
    <EntityPage
      title={L('เครื่องเล่น', 'Rides', '游乐设施')}
      sub={L('เพิ่มเครื่องเล่นใหม่ ราคา คิว จุดสแกน และตำแหน่งบนแผนที่', 'Add rides, pricing, queue, scan point and map position', '新增设施、定价、排队、扫描点和地图位置')}
      path="/rides" listPath="/rides/admin" queryKey="pk-rides" perm="rides.manage" fields={fields} size="full"
      blank={{ code: '', name: {}, description: {}, capacity: 10, duration_minutes: 5, status: 'OPEN', ticket_required: true, addon_enabled: true, addon_type: 'ONE_TIME', addon_uses: 1, tier_prices: {}, queue_enabled: false, queue_prefix: 'A', map: { x: 50, y: 50 }, sort: 0, is_active: true }}
      fromRow={(r) => ({ ...r, duration_minutes: Number(r.duration_minutes), addon_price: r.addon_price == null ? null : Number(r.addon_price), member_price: r.member_price == null ? null : Number(r.member_price), peak_price: r.peak_price == null ? null : Number(r.peak_price) })}
      toBody={(f) => {
        const { id, branch_id, created_at, updated_at, entry_paused, zone_name, scan_points, packages, ...b } = f;
        return { ...b, map: { x: Number(f.map?.x ?? 50), y: Number(f.map?.y ?? 50) }, image_url: b.image_url || null };
      }}
      extra={(f, set) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.x(L('ตำแหน่งบนแผนที่ X %', 'Map X %', '地图 X %'))}><NumberInput value={f.map?.x ?? 50} onChange={(v) => set({ ...f, map: { ...(f.map ?? {}), x: v ?? 0 } })} /></Field>
          <Field label={t.x(L('ตำแหน่งบนแผนที่ Y %', 'Map Y %', '地图 Y %'))}><NumberInput value={f.map?.y ?? 50} onChange={(v) => set({ ...f, map: { ...(f.map ?? {}), y: v ?? 0 } })} /></Field>
          {!f.id && (
            <div className="rounded-xl bg-slate-50 p-3 sm:col-span-2">
              <div className="mb-2 text-sm font-semibold">{t.x(L('สร้างจุดสแกนพร้อมกัน (ไม่บังคับ)', 'Create a scan point too (optional)', '同时创建扫描点（可选）'))}</div>
              <div className="grid gap-2 sm:grid-cols-3">
                <Input placeholder="SCAN-RIDE-xxx" value={f.scan_point?.code ?? ''} onChange={(e) => set({ ...f, scan_point: e.target.value ? { ...(f.scan_point ?? { name: '', payment_enabled: true }), code: e.target.value.toUpperCase() } : null })} />
                <Input placeholder={t('name')} value={f.scan_point?.name ?? ''} onChange={(e) => f.scan_point && set({ ...f, scan_point: { ...f.scan_point, name: e.target.value } })} />
                <Select value={f.scan_point?.device_id ?? ''} onChange={(e) => f.scan_point && set({ ...f, scan_point: { ...f.scan_point, device_id: e.target.value || null } })}><option value="">—</option>{o.devices.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}</Select>
              </div>
            </div>
          )}
        </div>
      )}
      columns={[
        { label: L('เครื่องเล่น', 'Ride', '设施'), render: nm(t.lang) },
        { label: L('สถานะ', 'Status', '状态'), render: (r) => <Badge>{t.status(r.status)}</Badge> },
        { label: L('ราคา', 'Price', '价格'), render: (r) => (r.addon_price != null ? money(r.addon_price) : '—') },
        { label: L('ความจุ', 'Capacity', '容量'), render: (r) => `${r.capacity} / ${Number(r.duration_minutes)}′` },
        { label: L('ข้อจำกัด', 'Limits', '限制'), render: (r) => <span className="text-xs">{r.min_height ? `≥${r.min_height}cm ` : ''}{r.min_age ? `≥${r.min_age}y` : ''}</span> },
        { label: L('คิว', 'Queue', '排队'), render: (r) => (r.queue_enabled ? <Badge className="bg-violet-100 text-violet-800">{r.queue_prefix}</Badge> : '—') },
      ]}
    />
  );
}

export function ScanPoints() {
  const t = useT();
  const o = useParkOptions();
  const fields: FieldDef[] = [
    { k: 'code', label: L('รหัส', 'Code', '代码'), type: 'code' },
    { k: 'name', label: L('ชื่อ', 'Name', '名称'), type: 'text' },
    { k: 'ride_id', label: L('เครื่องเล่น', 'Ride', '设施'), type: 'select', options: o.rides },
    { k: 'device_id', label: L('อุปกรณ์สแกน', 'Scanner device', '扫描设备'), type: 'select', options: o.devices, nullable: true },
    { k: 'zone_id', label: L('โซน', 'Zone', '区域'), type: 'select', options: o.zones, nullable: true },
    { k: 'location', label: L('ตำแหน่ง', 'Location', '位置'), type: 'text', nullable: true },
    { k: 'mode', label: L('โหมด', 'Mode', '模式'), type: 'select', options: enumOpts(['ENTRY', 'QUEUE', 'BOTH']) },
    { k: 'status', label: L('สถานะ', 'Status', '状态'), type: 'select', options: enumOpts(['ACTIVE', 'INACTIVE']) },
    { k: 'payment_enabled', label: L('ขายสิทธิ์ที่จุดนี้', 'Sell rides here', '此处可售'), type: 'bool' },
    { k: 'payment_methods', label: L('วิธีชำระ', 'Payment methods', '支付方式'), type: 'multi', options: enumOpts(['WALLET', 'PROMPTPAY', 'CARD', 'CASH'], (m) => t.method(m)) },
  ];
  return (
    <EntityPage
      title={L('จุดสแกนเครื่องเล่น', 'Ride scan points', '设施扫描点')}
      path="/rides/scan-points" listPath="/rides/scan-points/list/all" queryKey="pk-scan-points" perm="rides.manage" fields={fields}
      blank={{ code: '', name: '', mode: 'ENTRY', status: 'ACTIVE', payment_enabled: true, payment_methods: ['WALLET', 'PROMPTPAY', 'CARD', 'CASH'] }}
      toBody={(f) => ({ code: f.code, name: f.name, ride_id: f.ride_id, zone_id: f.zone_id ?? null, device_id: f.device_id ?? null, location: f.location ?? null, mode: f.mode, payment_enabled: f.payment_enabled, payment_methods: f.payment_methods, operator_id: f.operator_id ?? null, status: f.status })}
      rowActions={(r) => <a href={`/ride/${r.id}`} target="_blank" rel="noreferrer" className="mr-2 text-xs text-primary">{t('open')}</a>}
      columns={[
        { label: L('จุดสแกน', 'Scan point', '扫描点'), render: (r) => <div><div className="font-medium">{r.name}</div><div className="font-mono text-xs text-slate-500">{r.code}</div></div> },
        { label: L('เครื่องเล่น', 'Ride', '设施'), render: (r) => tr(r.ride_name, t.lang, r.ride_code) },
        { label: L('อุปกรณ์', 'Device', '设备'), render: (r) => r.device_code ?? '—' },
        { label: L('ชำระ', 'Payment', '支付'), render: (r) => (r.payment_enabled ? (r.payment_methods ?? []).map((m: string) => t.method(m)).join(', ') : '—') },
        { label: L('สถานะ', 'Status', '状态'), render: (r) => <Badge>{r.status}</Badge> },
      ]}
    />
  );
}

// ------------------------------------------------------------------ zones / stores
export function Zones() {
  const t = useT();
  const fields: FieldDef[] = [
    { k: 'code', label: L('รหัส', 'Code', '代码'), type: 'code' },
    { k: 'color', label: L('สี', 'Color', '颜色'), type: 'color' },
    { k: 'capacity', label: L('ความจุ', 'Capacity', '容量'), type: 'number' },
    { k: 'name', label: L('ชื่อ', 'Name', '名称'), type: 'i18n' },
    { k: 'sort', label: L('ลำดับ', 'Sort', '排序'), type: 'number' },
    { k: 'is_active', label: L('ใช้งาน', 'Active', '启用'), type: 'bool' },
  ];
  return (
    <EntityPage
      title={L('โซน', 'Zones', '区域')} sub={L('โซนในสวน ความจุ และพื้นที่บนแผนที่สด', 'Park zones, capacity and live-map area', '园区区域、容量和实时地图位置')}
      path="/admin/zones" queryKey="pk-zones" perm="zones.manage" fields={fields}
      blank={{ code: '', name: {}, color: '#22c55e', capacity: 0, map: { x: 10, y: 10, w: 20, h: 20 }, sort: 0, is_active: true }}
      toBody={(f) => ({ code: f.code, name: f.name, color: f.color, capacity: f.capacity, map: { x: Number(f.map?.x ?? 0), y: Number(f.map?.y ?? 0), w: Number(f.map?.w ?? 10), h: Number(f.map?.h ?? 10) }, sort: f.sort, is_active: f.is_active })}
      extra={(f, set) => (
        <div className="grid grid-cols-4 gap-2">
          {(['x', 'y', 'w', 'h'] as const).map((k) => <Field key={k} label={`${t.x(L('แผนที่', 'Map', '地图'))} ${k.toUpperCase()} %`}><NumberInput value={f.map?.[k] ?? 0} onChange={(v) => set({ ...f, map: { ...(f.map ?? {}), [k]: v ?? 0 } })} /></Field>)}
        </div>
      )}
      columns={[
        { label: L('โซน', 'Zone', '区域'), render: (r) => <div className="flex items-center gap-2"><Swatch c={r.color} />{nm(t.lang)(r)}</div> },
        { label: L('ความจุ', 'Capacity', '容量'), render: (r) => r.capacity },
        { label: L('สถานะ', 'Status', '状态'), render: (r) => <ActiveBadge on={r.is_active} /> },
      ]}
    />
  );
}

export function Stores() {
  const t = useT();
  const o = useParkOptions();
  const fields: FieldDef[] = [
    { k: 'code', label: L('รหัส', 'Code', '代码'), type: 'code' },
    { k: 'type', label: L('ประเภท', 'Type', '类型'), type: 'select', options: enumOpts(['RESTAURANT', 'RETAIL', 'LOCKER', 'SERVICE', 'TICKETING', 'WAREHOUSE']) },
    { k: 'zone_id', label: L('โซน', 'Zone', '区域'), type: 'select', options: o.zones, nullable: true },
    { k: 'name', label: L('ชื่อ', 'Name', '名称'), type: 'i18n' },
    { k: 'receipt_printer_id', label: L('เครื่องพิมพ์ใบเสร็จ', 'Receipt printer', '收据打印机'), type: 'select', options: o.printers, nullable: true },
    { k: 'category_ids', label: L('หมวดสินค้าที่ขาย (ว่าง = ทั้งหมด)', 'Categories sold (none = all)', '销售品类（空=全部）'), type: 'multi', options: o.categories },
    { k: 'is_active', label: L('ใช้งาน', 'Active', '启用'), type: 'bool' },
  ];
  return (
    <EntityPage
      title={L('ร้านค้า / จุดขาย / คลัง', 'Stores & warehouses', '门店 / 仓库')}
      path="/admin/stores" queryKey="pk-stores" perm="inventory.manage" fields={fields}
      blank={{ code: '', name: {}, type: 'RETAIL', category_ids: [], is_active: true }}
      toBody={(f) => ({ code: f.code, name: f.name, type: f.type, zone_id: f.zone_id ?? null, receipt_printer_id: f.receipt_printer_id ?? null, category_ids: f.category_ids ?? [], is_active: f.is_active })}
      columns={[
        { label: L('ร้าน', 'Store', '门店'), render: nm(t.lang) },
        { label: L('ประเภท', 'Type', '类型'), render: (r) => <Badge>{r.type}</Badge> },
        { label: L('สถานะ', 'Status', '状态'), render: (r) => <ActiveBadge on={r.is_active} /> },
      ]}
    />
  );
}

// ------------------------------------------------------------------ membership
export function Tiers() {
  const t = useT();
  const fields: FieldDef[] = [
    { k: 'code', label: L('รหัส', 'Code', '代码'), type: 'code' },
    { k: 'rank', label: L('ลำดับขั้น', 'Rank', '等级'), type: 'number' },
    { k: 'color', label: L('สี', 'Color', '颜色'), type: 'color' },
    { k: 'name', label: L('ชื่อ', 'Name', '名称'), type: 'i18n' },
    { k: 'is_default', label: L('ระดับเริ่มต้น', 'Default tier', '默认等级'), type: 'bool' },
    { k: 'is_active', label: L('ใช้งาน', 'Active', '启用'), type: 'bool' },
  ];
  return (
    <EntityPage
      title={L('ระดับสมาชิก', 'Member tiers', '会员等级')} path="/admin/tiers" queryKey="pk-tiers" perm="membership.manage" fields={fields}
      blank={{ code: '', name: {}, rank: 0, color: '#64748b', is_default: false, is_active: true }}
      toBody={(f) => ({ code: f.code, name: f.name, rank: f.rank, color: f.color, is_default: f.is_default, is_active: f.is_active })}
      columns={[
        { label: L('ระดับ', 'Tier', '等级'), render: (r) => <div className="flex items-center gap-2"><Swatch c={r.color} />{nm(t.lang)(r)}</div> },
        { label: L('ลำดับขั้น', 'Rank', '等级'), render: (r) => r.rank },
        { label: L('เริ่มต้น', 'Default', '默认'), render: (r) => (r.is_default ? '✓' : '') },
        { label: L('สถานะ', 'Status', '状态'), render: (r) => <ActiveBadge on={r.is_active} /> },
      ]}
    />
  );
}

const BENEFITS = ['TICKET_DISCOUNT', 'FOOD_DISCOUNT', 'RETAIL_DISCOUNT', 'LOCKER_DISCOUNT', 'RIDE_DISCOUNT', 'FREE_RIDE', 'FREE_LOCKER', 'BIRTHDAY_REWARD', 'PRIORITY_QUEUE', 'FAST_PASS', 'FREE_ADMISSION', 'GUEST_DISCOUNT', 'POINT_MULTIPLIER', 'PARKING', 'SPECIAL_EVENT', 'LOUNGE', 'CUSTOM'];
export function MembershipProducts() {
  const t = useT();
  const o = useParkOptions();
  const fields: FieldDef[] = [
    { k: 'code', label: L('รหัส', 'Code', '代码'), type: 'code' },
    { k: 'tier_id', label: L('ระดับสมาชิกที่ได้', 'Tier granted', '授予等级'), type: 'select', options: o.tiers },
    { k: 'sort', label: L('ลำดับ', 'Sort', '排序'), type: 'number' },
    { k: 'name', label: L('ชื่อ', 'Name', '名称'), type: 'i18n' },
    { k: 'description', label: L('คำอธิบาย', 'Description', '描述'), type: 'i18nMulti' },
    { k: 'image_url', label: L('รูปบัตร', 'Card image', '卡面图片'), type: 'image' },
    { k: 'price', label: L('ราคา', 'Price', '价格'), type: 'money' },
    { k: 'registration_fee', label: L('ค่าสมัคร', 'Registration fee', '注册费'), type: 'money' },
    { k: 'renewal_price', label: L('ราคาต่ออายุ', 'Renewal price', '续费价格'), type: 'money', nullable: true },
    { k: 'validity_unit', label: L('หน่วยอายุ', 'Validity unit', '有效期单位'), type: 'select', options: enumOpts(['DAY', 'MONTH', 'YEAR', 'LIFETIME']) },
    { k: 'validity_value', label: L('อายุ', 'Validity', '有效期'), type: 'number' },
    { k: 'grace_days', label: L('ผ่อนผัน (วัน)', 'Grace days', '宽限天数'), type: 'number' },
    { k: 'early_renewal_days', label: L('ต่ออายุล่วงหน้าได้ (วัน)', 'Early renewal window (days)', '提前续费（天）'), type: 'number' },
    { k: 'early_renewal_discount_pct', label: L('ส่วนลดต่ออายุก่อน %', 'Early renewal discount %', '提前续费折扣 %'), type: 'number' },
    { k: 'upgrade_mode', label: L('การอัปเกรด', 'Upgrade pricing', '升级计价'), type: 'select', options: enumOpts(['FULL', 'DIFFERENCE', 'PRORATED']) },
    { k: 'upgrade_price', label: L('ราคาอัปเกรด', 'Upgrade price', '升级价格'), type: 'money', nullable: true },
    { k: 'point_multiplier', label: L('ตัวคูณคะแนน', 'Point multiplier', '积分倍数'), type: 'number' },
    { k: 'visit_limit', label: L('จำกัดจำนวนครั้ง', 'Visit limit', '入园次数上限'), type: 'number', nullable: true },
    { k: 'channels', label: L('ช่องทางขาย', 'Channels', '销售渠道'), type: 'multi', options: enumOpts(['ONLINE', 'COUNTER', 'KIOSK']) },
    { k: 'is_active', label: L('ใช้งาน', 'Active', '启用'), type: 'bool' },
  ];
  return (
    <EntityPage
      title={L('แพ็กเกจสมาชิก', 'Membership products', '会员产品')} sub={L('ราคา อายุ การต่ออายุ/อัปเกรด และสิทธิประโยชน์', 'Price, validity, renewal / upgrade and benefits', '价格、有效期、续费/升级及权益')}
      path="/admin/membership-products" queryKey="pk-membership-products" perm="membership.manage" fields={fields} size="full"
      blank={{ code: '', name: {}, description: {}, card_design: {}, registration_fee: 0, price: 0, validity_unit: 'YEAR', validity_value: 1, early_renewal_days: 30, early_renewal_discount_pct: 0, grace_days: 0, upgrade_mode: 'DIFFERENCE', point_multiplier: 1, channels: ['ONLINE', 'COUNTER', 'KIOSK'], sort: 0, is_active: true, benefits: [] }}
      fromRow={(r) => ({ ...r, price: Number(r.price), registration_fee: Number(r.registration_fee), renewal_price: r.renewal_price == null ? null : Number(r.renewal_price), upgrade_price: r.upgrade_price == null ? null : Number(r.upgrade_price), point_multiplier: Number(r.point_multiplier), early_renewal_discount_pct: Number(r.early_renewal_discount_pct), benefits: (r.benefits ?? []).map((b: any) => ({ type: b.type, value: Number(b.value), name: b.name ?? {}, config: b.config ?? {} })) })}
      toBody={(f) => {
        const { id, created_at, updated_at, tier_code, tier_name, tier_color, active_members, ...b } = f;
        return { ...b, image_url: b.image_url || null };
      }}
      extra={(f, set) => (
        <section className="rounded-2xl border p-3">
          <div className="mb-2 flex items-center justify-between font-semibold">{t.x(L('สิทธิประโยชน์', 'Benefits', '权益'))}<Button size="sm" variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => set({ ...f, benefits: [...(f.benefits ?? []), { type: 'TICKET_DISCOUNT', value: 10, name: {}, config: {} }] })}>{t('add')}</Button></div>
          {(f.benefits ?? []).map((b: any, i: number) => (
            <div key={i} className="mb-2 space-y-2 rounded-xl bg-slate-50 p-2">
              <div className="grid items-end gap-2 sm:grid-cols-[220px_140px_auto]">
                <Select value={b.type} onChange={(e) => set({ ...f, benefits: f.benefits.map((x: any, j: number) => (j === i ? { ...x, type: e.target.value } : x)) })}>{BENEFITS.map((x) => <option key={x}>{x}</option>)}</Select>
                <NumberInput value={b.value} onChange={(v) => set({ ...f, benefits: f.benefits.map((x: any, j: number) => (j === i ? { ...x, value: v ?? 0 } : x)) })} />
                <Button variant="ghost" className="text-rose-600" onClick={() => set({ ...f, benefits: f.benefits.filter((_: any, j: number) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
              </div>
              <I18nInput value={b.name} onChange={(v) => set({ ...f, benefits: f.benefits.map((x: any, j: number) => (j === i ? { ...x, name: v } : x)) })} />
            </div>
          ))}
        </section>
      )}
      columns={[
        { label: L('แพ็กเกจ', 'Product', '产品'), render: nm(t.lang) },
        { label: L('ระดับ', 'Tier', '等级'), render: (r) => <span className="flex items-center gap-1"><Swatch c={r.tier_color} />{tr(r.tier_name, t.lang)}</span> },
        { label: L('ราคา', 'Price', '价格'), render: (r) => money(r.price) },
        { label: L('อายุ', 'Validity', '有效期'), render: (r) => `${r.validity_value} ${r.validity_unit}` },
        { label: L('สมาชิก', 'Members', '会员数'), render: (r) => r.active_members },
        { label: L('สถานะ', 'Status', '状态'), render: (r) => <ActiveBadge on={r.is_active} /> },
      ]}
    />
  );
}

export function Rewards() {
  const t = useT();
  const o = useParkOptions();
  const fields: FieldDef[] = [
    { k: 'code', label: L('รหัส', 'Code', '代码'), type: 'code' },
    { k: 'reward_type', label: L('ประเภท', 'Type', '类型'), type: 'select', options: enumOpts(['COUPON', 'TICKET', 'RIDE', 'FOOD', 'DRINK', 'SOUVENIR', 'LOCKER', 'UPGRADE', 'WALLET_CREDIT']) },
    { k: 'points_required', label: L('คะแนนที่ใช้', 'Points required', '所需积分'), type: 'number' },
    { k: 'name', label: L('ชื่อ', 'Name', '名称'), type: 'i18n' },
    { k: 'description', label: L('คำอธิบาย', 'Description', '描述'), type: 'i18n' },
    { k: 'image_url', label: L('รูปภาพ', 'Image', '图片'), type: 'image' },
    { k: 'value', label: L('มูลค่า', 'Value', '价值'), type: 'money' },
    { k: 'ref_id', label: L('อ้างอิง (โปรโมชั่น / เครื่องเล่น / แพ็กเกจ)', 'Reference (promotion / ride / package)', '关联（促销/设施/套餐）'), type: 'select', nullable: true, options: [...o.promotions, ...o.rides, ...o.packages] },
    { k: 'stock', label: L('จำนวนคงเหลือ', 'Stock', '库存'), type: 'number', nullable: true },
    { k: 'per_member_limit', label: L('จำกัดต่อคน', 'Per member limit', '每人限兑'), type: 'number', nullable: true },
    { k: 'valid_days', label: L('ใช้ได้ (วัน)', 'Valid days', '有效天数'), type: 'number' },
    { k: 'start_at', label: L('เริ่ม', 'Start', '开始'), type: 'datetime' },
    { k: 'end_at', label: L('สิ้นสุด', 'End', '结束'), type: 'datetime' },
    { k: 'tier_ids', label: L('เฉพาะระดับสมาชิก', 'Tiers only', '限等级'), type: 'multi', options: o.tiers },
    { k: 'sort', label: L('ลำดับ', 'Sort', '排序'), type: 'number' },
    { k: 'is_active', label: L('ใช้งาน', 'Active', '启用'), type: 'bool' },
  ];
  return (
    <EntityPage
      title={L('ของรางวัล (แลกคะแนน)', 'Rewards (points)', '积分兑换')} path="/admin/rewards" queryKey="pk-rewards" perm="rewards.manage" fields={fields}
      blank={{ code: '', name: {}, description: {}, reward_type: 'COUPON', points_required: 100, value: 0, valid_days: 30, tier_ids: [], sort: 0, is_active: true }}
      fromRow={(r) => ({ ...r, value: Number(r.value), start_at: r.start_at ? String(r.start_at).slice(0, 16) : null, end_at: r.end_at ? String(r.end_at).slice(0, 16) : null })}
      toBody={(f) => {
        const { id, created_at, updated_at, ...b } = f;
        return { ...b, image_url: b.image_url || null, ref_id: b.ref_id || null };
      }}
      columns={[
        { label: L('รางวัล', 'Reward', '奖励'), render: nm(t.lang) },
        { label: L('ประเภท', 'Type', '类型'), render: (r) => <Badge>{r.reward_type}</Badge> },
        { label: L('คะแนน', 'Points', '积分'), render: (r) => r.points_required },
        { label: L('คงเหลือ', 'Stock', '库存'), render: (r) => r.stock ?? '∞' },
        { label: L('สถานะ', 'Status', '状态'), render: (r) => <ActiveBadge on={r.is_active} /> },
      ]}
    />
  );
}

// ------------------------------------------------------------------ gates
export function GatesConfig() {
  const t = useT();
  const o = useParkOptions();
  const fields: FieldDef[] = [
    { k: 'code', label: L('รหัส', 'Code', '代码'), type: 'code' },
    { k: 'number', label: L('หมายเลข', 'Number', '编号'), type: 'number' },
    { k: 'direction', label: L('ทิศทาง', 'Direction', '方向'), type: 'select', options: enumOpts(['ENTRY', 'EXIT', 'BOTH']) },
    { k: 'name', label: L('ชื่อ', 'Name', '名称'), type: 'i18n' },
    { k: 'mode', label: L('โหมด', 'Mode', '模式'), type: 'select', options: [{ value: 'AUTO', label: 'AUTO' }, { value: 'MANUAL', label: 'MANUAL (operator approval)' }] },
    { k: 'zone_id', label: L('โซน', 'Zone', '区域'), type: 'select', options: o.zones, nullable: true },
    { k: 'open_seconds', label: L('เปิดค้าง (วินาที)', 'Open seconds', '开启秒数'), type: 'number' },
    { k: 'controller_kind', label: L('ชนิดประตู', 'Gate hardware', '闸门类型'), type: 'select', options: enumOpts(['TURNSTILE', 'FLAP_BARRIER', 'SWING_GATE', 'RELAY', 'GPIO', 'NETWORK']) },
    { k: 'driver', label: L('ไดรเวอร์', 'Driver', '驱动'), type: 'select', options: enumOpts(['SIMULATOR', 'HTTP', 'RELAY_HTTP', 'EDGE_AGENT']) },
    { k: 'operator_id', label: L('ผู้ดูแล', 'Operator', '操作员'), type: 'select', options: o.staff, nullable: true },
    { k: 'controller_config', label: L('ค่าคอนโทรลเลอร์ (JSON)', 'Controller config (JSON)', '控制器配置（JSON）'), type: 'json', hint: L('HTTP: {"url","secret"} · RELAY_HTTP: {"openUrl","closeUrl"} · EDGE_AGENT: {"deviceId","pin","pulseMs"}', 'HTTP: {"url","secret"} · RELAY_HTTP: {"openUrl","closeUrl"} · EDGE_AGENT: {"deviceId","pin","pulseMs"}', 'HTTP: {"url","secret"} · RELAY_HTTP: {"openUrl","closeUrl"} · EDGE_AGENT: {"deviceId","pin","pulseMs"}') },
    { k: 'is_active', label: L('ใช้งาน', 'Active', '启用'), type: 'bool' },
  ];
  return (
    <EntityPage
      title={L('ตั้งค่าประตู', 'Gate setup', '闸门设置')} sub={L('ประตู ฮาร์ดแวร์ ไดรเวอร์ และอุปกรณ์ (สแกนเนอร์ / จอ / คอนโทรลเลอร์)', 'Gates, hardware drivers and bound devices (scanner / display / controller)', '闸门、硬件驱动及绑定设备（扫描/显示/控制器）')}
      path="/gates" queryKey="pk-gates-config" perm="gates.manage" fields={fields} rows={(d) => d.gates}
      blank={{ code: '', number: 1, name: {}, direction: 'ENTRY', mode: 'AUTO', controller_kind: 'TURNSTILE', driver: 'SIMULATOR', controller_config: {}, open_seconds: 6, is_active: true, devices: [] }}
      fromRow={(r) => ({ ...r, devices: (r.devices ?? []).map((d: any) => ({ deviceId: d.id, role: d.role })) })}
      toBody={(f) => ({ code: f.code, number: f.number, name: f.name ?? {}, direction: f.direction, zone_id: f.zone_id ?? null, mode: f.mode, controller_kind: f.controller_kind, driver: f.driver, controller_config: f.controller_config ?? {}, open_seconds: f.open_seconds, operator_id: f.operator_id ?? null, is_active: f.is_active, devices: f.devices ?? [] })}
      extra={(f, set) => (
        <section className="rounded-2xl border p-3">
          <div className="mb-2 flex items-center justify-between font-semibold">{t.x(L('อุปกรณ์ที่ผูก', 'Bound devices', '绑定设备'))}<Button size="sm" variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => set({ ...f, devices: [...(f.devices ?? []), { deviceId: o.devices[0]?.value, role: 'DISPLAY' }] })}>{t('add')}</Button></div>
          {(f.devices ?? []).map((d: any, i: number) => (
            <div key={i} className="mb-2 grid gap-2 sm:grid-cols-[1fr_160px_auto]">
              <Select value={d.deviceId} onChange={(e) => set({ ...f, devices: f.devices.map((x: any, j: number) => (j === i ? { ...x, deviceId: e.target.value } : x)) })}>{o.devices.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</Select>
              <Select value={d.role} onChange={(e) => set({ ...f, devices: f.devices.map((x: any, j: number) => (j === i ? { ...x, role: e.target.value } : x)) })}>{['SCANNER', 'DISPLAY', 'CONTROLLER'].map((x) => <option key={x}>{x}</option>)}</Select>
              <Button variant="ghost" className="text-rose-600" onClick={() => set({ ...f, devices: f.devices.filter((_: any, j: number) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
        </section>
      )}
      rowActions={(r) => <a href={`/gate/${r.id}`} target="_blank" rel="noreferrer" className="mr-2 text-xs text-primary">{t('open')}</a>}
      columns={[
        { label: L('ประตู', 'Gate', '闸门'), render: (r) => <div className="flex items-center gap-2"><span className="rounded-lg bg-slate-900 px-2 py-0.5 font-bold text-white">{r.number}</span>{tr(r.name, t.lang, r.code)}</div> },
        { label: L('ทิศทาง / โหมด', 'Direction / mode', '方向/模式'), render: (r) => `${r.direction} · ${r.mode}` },
        { label: L('ไดรเวอร์', 'Driver', '驱动'), render: (r) => `${r.controller_kind} · ${r.driver}` },
        { label: L('อุปกรณ์', 'Devices', '设备'), render: (r) => <span className="text-xs">{(r.devices ?? []).map((d: any) => `${d.code}:${d.role}`).join(', ')}</span> },
        { label: L('สถานะ', 'State', '状态'), render: (r) => <Badge>{t.status(r.state)}</Badge> },
      ]}
    />
  );
}

// ------------------------------------------------------------------ lockers + rates
export function LockersConfig() {
  const t = useT();
  const o = useParkOptions();
  const qc = useQueryClient();
  const [bulk, setBulk] = useState(false);
  const fields: FieldDef[] = [
    { k: 'code', label: L('รหัส', 'Code', '代码'), type: 'code' },
    { k: 'bank', label: L('ตู้ (ชุด)', 'Bank', '柜组'), type: 'text' },
    { k: 'size', label: L('ขนาด', 'Size', '尺寸'), type: 'select', options: enumOpts(['S', 'M', 'L', 'XL']) },
    { k: 'zone_id', label: L('โซน', 'Zone', '区域'), type: 'select', options: o.zones, nullable: true },
    { k: 'status', label: L('สถานะ', 'Status', '状态'), type: 'select', options: enumOpts(['AVAILABLE', 'OCCUPIED', 'OUT_OF_SERVICE'], (v) => t.status(v)) },
    { k: 'driver', label: L('ไดรเวอร์', 'Driver', '驱动'), type: 'select', options: enumOpts(['SIMULATOR', 'HTTP', 'EDGE_AGENT']) },
    { k: 'device_id', label: L('อุปกรณ์ควบคุม', 'Controller device', '控制设备'), type: 'select', options: o.devices, nullable: true },
    { k: 'controller_config', label: L('ค่าคอนโทรลเลอร์ (JSON)', 'Controller config (JSON)', '控制器配置（JSON）'), type: 'json' },
    { k: 'is_active', label: L('ใช้งาน', 'Active', '启用'), type: 'bool' },
  ];
  return (
    <div className="space-y-8">
      <EntityPage
        title={L('ล็อกเกอร์', 'Lockers', '储物柜')} path="/lockers" queryKey="pk-lockers-config" perm="lockers.manage" fields={fields} rows={(d) => d.lockers} size="lg" deletable={false}
        blank={{ code: '', bank: 'A', size: 'M', status: 'AVAILABLE', driver: 'SIMULATOR', controller_config: {}, is_active: true }}
        toBody={(f) => ({ code: f.code, bank: f.bank, size: f.size, zone_id: f.zone_id ?? null, status: f.status, driver: f.driver, controller_config: f.controller_config ?? {}, device_id: f.device_id ?? null, is_active: f.is_active })}
        headerActions={<Button variant="outline" onClick={() => setBulk(true)}>{t.x(L('สร้างหลายตู้', 'Bulk create', '批量创建'))}</Button>}
        columns={[
          { label: L('ตู้', 'Locker', '柜'), render: (r) => <b>{r.code}</b> },
          { label: L('ชุด / ขนาด', 'Bank / size', '柜组/尺寸'), render: (r) => `${r.bank} · ${r.size}` },
          { label: L('สถานะ', 'Status', '状态'), render: (r) => <Badge>{t.status(r.status)}</Badge> },
          { label: L('ผู้เช่า', 'Renter', '租用人'), render: (r) => r.credential_code ?? r.member_no ?? '—' },
          { label: L('ไดรเวอร์', 'Driver', '驱动'), render: (r) => r.driver },
        ]}
      />
      <EntityPage
        title={L('อัตราค่าเช่า', 'Locker rates', '租用费率')} path="/lockers/rates" listPath="/lockers" queryKey="pk-lockers-config" perm="lockers.manage" rows={(d) => d.rates} deletable={false} size="lg"
        fields={[
          { k: 'label', label: L('ชื่อ', 'Label', '名称'), type: 'i18n' },
          { k: 'size', label: L('ขนาด (ว่าง = ทุกขนาด)', 'Size (none = any)', '尺寸（空=全部）'), type: 'select', options: enumOpts(['S', 'M', 'L', 'XL']), nullable: true },
          { k: 'minutes', label: L('นาที (ว่าง = ทั้งวัน)', 'Minutes (none = all day)', '分钟（空=全天）'), type: 'number', nullable: true },
          { k: 'price', label: L('ราคา', 'Price', '价格'), type: 'money' },
          { k: 'member_price', label: L('ราคาสมาชิก', 'Member price', '会员价'), type: 'money', nullable: true },
          { k: 'sort', label: L('ลำดับ', 'Sort', '排序'), type: 'number' },
          { k: 'is_active', label: L('ใช้งาน', 'Active', '启用'), type: 'bool' },
        ]}
        blank={{ label: {}, price: 0, sort: 0, is_active: true }}
        fromRow={(r) => ({ ...r, price: Number(r.price), member_price: r.member_price == null ? null : Number(r.member_price) })}
        toBody={(f) => ({ label: f.label, size: f.size ?? null, minutes: f.minutes ?? null, price: f.price, member_price: f.member_price ?? null, sort: f.sort ?? 0, is_active: f.is_active })}
        columns={[
          { label: L('อัตรา', 'Rate', '费率'), render: (r) => tr(r.label, t.lang) },
          { label: L('ขนาด', 'Size', '尺寸'), render: (r) => r.size ?? '—' },
          { label: L('เวลา', 'Duration', '时长'), render: (r) => (r.minutes ? `${r.minutes}′` : '—') },
          { label: L('ราคา', 'Price', '价格'), render: (r) => money(r.price) },
          { label: L('สถานะ', 'Status', '状态'), render: (r) => <ActiveBadge on={r.is_active} /> },
        ]}
      />
      {bulk && <BulkLockers onClose={() => setBulk(false)} onDone={() => { setBulk(false); void qc.invalidateQueries({ queryKey: ['pk-lockers-config'] }); }} />}
    </div>
  );
}

function BulkLockers({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [f, setF] = useState({ bank: 'C', prefix: 'L', from: 301, to: 310, size: 'M' });
  return (
    <Modal open onClose={onClose} title={t.x(L('สร้างหลายตู้', 'Bulk create lockers', '批量创建储物柜'))} size="md" footer={<Button onClick={async () => {
      try {
        await parkApi('/lockers/bulk', { body: f });
        onDone();
      } catch (e) { toast.error(t.err(e)); }
    }}>{t('create')}</Button>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Bank"><Input value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })} /></Field>
        <Field label="Prefix"><Input value={f.prefix} onChange={(e) => setF({ ...f, prefix: e.target.value })} /></Field>
        <Field label="From"><NumberInput value={f.from} onChange={(v) => setF({ ...f, from: v ?? 1 })} /></Field>
        <Field label="To"><NumberInput value={f.to} onChange={(v) => setF({ ...f, to: v ?? 1 })} /></Field>
        <Field label="Size"><Select value={f.size} onChange={(e) => setF({ ...f, size: e.target.value })}>{['S', 'M', 'L', 'XL'].map((s) => <option key={s}>{s}</option>)}</Select></Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ devices
export function Devices() {
  const t = useT();
  const o = useParkOptions();
  const [token, setToken] = useState<{ code: string; token: string } | null>(null);
  const qc = useQueryClient();
  const TYPES = ['GATE_SCANNER', 'GATE_CONTROLLER', 'GATE_DISPLAY', 'POS', 'COUNTER', 'KIOSK', 'RIDE_SCANNER', 'KITCHEN_DISPLAY', 'QUEUE_DISPLAY', 'LOCKER_CONTROLLER', 'EDGE_AGENT', 'OTHER'];
  const fields: FieldDef[] = [
    { k: 'code', label: L('รหัส', 'Code', '代码'), type: 'code' },
    { k: 'name', label: L('ชื่อ', 'Name', '名称'), type: 'text' },
    { k: 'type', label: L('ประเภท', 'Type', '类型'), type: 'select', options: enumOpts(TYPES) },
    { k: 'location', label: L('ตำแหน่ง', 'Location', '位置'), type: 'text', nullable: true },
    { k: 'zone_id', label: L('โซน', 'Zone', '区域'), type: 'select', options: o.zones, nullable: true },
    { k: 'config', label: L('ค่าตั้ง (JSON)', 'Config (JSON)', '配置（JSON）'), type: 'json', hint: L('เช่น {"printerId": "..."}', 'e.g. {"printerId": "..."}', '例如 {"printerId": "..."}') },
    { k: 'is_active', label: L('ใช้งาน', 'Active', '启用'), type: 'bool' },
  ];
  const pairUrl = (tok: string, type: string) => `${location.origin}${type.startsWith('GATE') ? '/gate' : type === 'RIDE_SCANNER' ? '/ride' : type === 'LOCKER_CONTROLLER' ? '/locker' : '/'}?device=${encodeURIComponent(tok)}`;
  return (
    <>
      <EntityPage
        title={L('อุปกรณ์', 'Devices', '设备')} sub={L('ทุกอุปกรณ์ในสวน: สถานะออนไลน์ โทเคนจับคู่ และการผูกกับประตู/เครื่องเล่น', 'Every device in the park: online status, pairing tokens, gate / ride bindings', '园区所有设备：在线状态、配对令牌及闸门/设施绑定')}
        path="/admin/devices" queryKey="pk-devices" perm="devices.manage" fields={fields}
        blank={{ code: '', name: '', type: 'GATE_DISPLAY', config: {}, is_active: true }}
        toBody={(f) => ({ code: f.code, name: f.name, type: f.type, location: f.location ?? null, zone_id: f.zone_id ?? null, config: f.config ?? {}, is_active: f.is_active })}
        rowActions={(r) => (
          <>
            <Button size="sm" variant="ghost" title="token" icon={<KeyRound className="h-3.5 w-3.5" />} onClick={async () => {
              try {
                const res = await parkApi(`/admin/devices/${r.id}/token`, { method: 'POST' });
                setToken({ code: r.code, token: res.token });
                void qc.invalidateQueries({ queryKey: ['pk-devices'] });
              } catch (e) { toast.error(t.err(e)); }
            }}>{t.x(L('โทเคนใหม่', 'New token', '新令牌'))}</Button>
            <Button size="sm" variant="ghost" icon={<RefreshCcw className="h-3.5 w-3.5" />} onClick={() => parkApi(`/admin/devices/${r.id}/reload`, { method: 'POST' }).then(() => toast.success(t('done'))).catch((e) => toast.error(t.err(e)))} />
          </>
        )}
        columns={[
          { label: L('อุปกรณ์', 'Device', '设备'), render: (r) => <div><div className="font-medium">{r.name}</div><div className="font-mono text-xs text-slate-500">{r.code}</div></div> },
          { label: L('ประเภท', 'Type', '类型'), render: (r) => <Badge>{r.type}</Badge> },
          { label: L('สถานะ', 'Status', '状态'), render: (r) => <Badge className={r.status === 'ONLINE' ? 'bg-emerald-100 text-emerald-800' : r.status === 'ERROR' ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-600'}>{t.status(r.status)}</Badge> },
          { label: L('ผูกกับ', 'Bound to', '绑定'), render: (r) => <span className="text-xs">{[r.gates, r.scan_points].filter(Boolean).join(' · ') || '—'}</span> },
          { label: L('ล่าสุด', 'Last seen', '最后在线'), render: (r) => <span className="text-xs">{r.last_seen_at ? new Date(r.last_seen_at).toLocaleString() : '—'}{r.ip ? ` · ${r.ip}` : ''}</span> },
        ]}
      />
      {token && (
        <Modal open onClose={() => setToken(null)} title={`${token.code} · token`} size="md">
          <p className="mb-2 text-sm text-slate-600">{t.x(L('แสดงครั้งเดียว — คัดลอกไปใส่ที่หน้าจับคู่ของอุปกรณ์ หรือเปิดลิงก์บนอุปกรณ์', 'Shown once — paste it on the device pairing screen or open the link on the device', '仅显示一次 — 粘贴到设备配对页或在设备上打开链接'))}</p>
          <div className="flex gap-2"><Input readOnly value={token.token} className="font-mono text-xs" /><Button variant="outline" icon={<Copy className="h-4 w-4" />} onClick={() => navigator.clipboard?.writeText(token.token).then(() => toast.success(t('copied')))} /></div>
          <div className="mt-2 text-xs break-all text-slate-500">{pairUrl(token.token, 'GATE')}</div>
        </Modal>
      )}
    </>
  );
}

// ------------------------------------------------------------------ coupons
export function Coupons() {
  const t = useT();
  const o = useParkOptions();
  const qc = useQueryClient();
  const [gen, setGen] = useState({ promotionId: '', qty: 10, prefix: 'CP', maxUses: 1, validFrom: '', validTo: '', code: '' });
  const [codes, setCodes] = useState<string[] | null>(null);
  return (
    <EntityPage
      title={L('คูปอง', 'Coupons', '优惠券')} sub={L('สร้างโค้ดคูปองจากโปรโมชั่น (ทีละใบหรือเป็นชุด)', 'Generate coupon codes from a promotion (single or batch)', '根据促销生成优惠码（单张或批量）')}
      path="/admin/coupons" queryKey="pk-coupons" perm="promotions.manage" fields={[]} blank={{}} readOnly
      headerActions={
        <div className="flex flex-wrap items-end gap-2">
          <Select value={gen.promotionId} onChange={(e) => setGen({ ...gen, promotionId: e.target.value })} className="w-56"><option value="">{t.x(L('เลือกโปรโมชั่น', 'Choose promotion', '选择促销'))}</option>{o.promotions.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>
          <div className="w-20"><NumberInput value={gen.qty} onChange={(v) => setGen({ ...gen, qty: v ?? 1 })} /></div>
          <Input className="w-24" value={gen.prefix} onChange={(e) => setGen({ ...gen, prefix: e.target.value.toUpperCase() })} placeholder="prefix" />
          <Input className="w-36" type="date" value={gen.validTo} onChange={(e) => setGen({ ...gen, validTo: e.target.value })} />
          <Button disabled={!gen.promotionId} onClick={async () => {
            try {
              const r = await parkApi('/admin/coupons', { body: { promotionId: gen.promotionId, qty: gen.qty, prefix: gen.prefix, maxUses: gen.maxUses, validTo: gen.validTo || null } });
              setCodes(r.codes);
              void qc.invalidateQueries({ queryKey: ['pk-coupons'] });
            } catch (e) { toast.error(t.err(e)); }
          }}>{t('create')}</Button>
          {codes && <Modal open onClose={() => setCodes(null)} title={`${codes.length} codes`}><textarea readOnly className="h-64 w-full rounded-xl border p-2 font-mono text-xs" value={codes.join('\n')} /></Modal>}
        </div>
      }
      rowActions={(r) => r.status === 'ACTIVE' && <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => parkApi(`/admin/coupons/${r.id}/void`, { method: 'POST' }).then(() => qc.invalidateQueries({ queryKey: ['pk-coupons'] }))}>VOID</Button>}
      columns={[
        { label: L('โค้ด', 'Code', '代码'), render: (r) => <span className="font-mono font-semibold">{r.code}</span> },
        { label: L('โปรโมชั่น', 'Promotion', '促销'), render: (r) => tr(r.promotion_name, t.lang) },
        { label: L('สมาชิก', 'Member', '会员'), render: (r) => r.member_no ?? '—' },
        { label: L('ใช้แล้ว', 'Used', '已用'), render: (r) => `${r.used_count}/${r.max_uses}` },
        { label: L('หมดอายุ', 'Valid to', '有效期'), render: (r) => (r.valid_to ? String(r.valid_to).slice(0, 10) : '∞') },
        { label: L('สถานะ', 'Status', '状态'), render: (r) => <Badge>{t.status(r.status)}</Badge> },
      ]}
    />
  );
}
