import crypto from 'node:crypto';
import { one, query, tx } from './pool';
import { hashSecret, newDeviceToken } from '../lib/tokens';
import { createAccount } from '../services/park/common';
import { issueCredential } from '../services/park/credentials';
import { registerMemberTx, applyMembership } from '../services/park/members';
import { walletPost } from '../services/park/wallet';

type T = { th: string; en: string; zh: string };
const t = (th: string, en: string, zh: string): T => ({ th, en, zh });

/**
 * Theme-park demo data on top of the restaurant demo: 10 entrance gates, zones, rides with scan points,
 * ticket types and packages, membership tiers / products with benefits, promotions, rewards, lockers,
 * retail store + inventory, park staff, paired devices and two demo members with wallets.
 */
export async function seedParkDemo(branchId: string) {
  const output: Record<string, any> = {};
  const B = branchId;
  const ids: Record<string, string> = {};
  await tx(async (c) => {
    const q = (sql: string, p: unknown[] = []) => one<any>(sql, p, c);
    await q(`UPDATE branches SET name=$2 WHERE id=$1`, [B, t('แฮปปี้แลนด์ สุขุมวิท', 'HappyLand Sukhumvit', '欢乐乐园 素坤逸')]);

    // ---------------- park staff
    const roles = Object.fromEntries((await query<any>(`SELECT id, code FROM roles`, [], c)).map((r) => [r.code, r.id]));
    for (const [name, nick, code, pin, role] of [
      ['Supot Supervisor', 'Pot', 'SUP001', '8888', 'SUPERVISOR'],
      ['Ticket Cashier Ann', 'Ann', 'TKT001', '6666', 'TICKET_CASHIER'],
      ['POS Cashier Beam', 'Beam', 'POS001', '7777', 'POS_CASHIER'],
      ['Gate Operator Game', 'Game', 'GATE001', '4444', 'GATE_OPERATOR'],
      ['Ride Operator Mint', 'Mint', 'RIDE001', '5555', 'RIDE_OPERATOR'],
    ] as const) {
      await q(`INSERT INTO users (name, nickname, employee_code, pin_hash, role_id, branch_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (employee_code) DO NOTHING`, [name, nick, code, await hashSecret(pin), roles[role], B]);
    }

    // ---------------- zones (map positions in % of the park map)
    const zone = async (code: string, name: T, color: string, capacity: number, map: object, sort: number) =>
      (ids[`zone:${code}`] = (await q(`INSERT INTO zones (branch_id, code, name, color, capacity, map, sort) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [B, code, name, color, capacity, map, sort])).id);
    await zone('ENTRANCE', t('ลานทางเข้า', 'Entrance Plaza', '入口广场'), '#0ea5e9', 600, { x: 2, y: 70, w: 30, h: 26 }, 0);
    await zone('KIDS', t('คิดส์คิงดอม', 'Kids Kingdom', '儿童王国'), '#f59e0b', 500, { x: 2, y: 4, w: 30, h: 62 }, 1);
    await zone('ADVENTURE', t('แอดเวนเจอร์โซน', 'Adventure Zone', '冒险区'), '#ef4444', 500, { x: 35, y: 4, w: 36, h: 52 }, 2);
    await zone('VR', t('วีอาร์อารีน่า', 'VR Arena', 'VR竞技场'), '#8b5cf6', 120, { x: 74, y: 4, w: 24, h: 40 }, 3);
    await zone('FOOD', t('ศูนย์อาหาร', 'Food Court', '美食广场'), '#22c55e', 400, { x: 35, y: 60, w: 63, h: 36 }, 4);

    // ---------------- devices (tokens shown once)
    const deviceTokens: Record<string, string> = {};
    const device = async (code: string, name: string, type: string, zoneCode: string | null, config: object = {}) => {
      const id = crypto.randomUUID();
      const tok = newDeviceToken(id);
      await q(`INSERT INTO devices (id, branch_id, code, name, type, zone_id, token_hash, config, location) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
        id, B, code, name, type, zoneCode ? ids[`zone:${zoneCode}`] : null, tok.hash, config, zoneCode,
      ]);
      deviceTokens[code] = tok.token;
      return id;
    };

    // ---------------- gates 01–10
    for (let n = 1; n <= 10; n++) {
      const code = `GATE-${String(n).padStart(2, '0')}`;
      const direction = n === 10 ? 'EXIT' : n === 9 ? 'BOTH' : 'ENTRY';
      const mode = n === 3 || n === 4 ? 'MANUAL' : 'AUTO';
      const g = await q(
        `INSERT INTO gates (branch_id, code, number, name, direction, zone_id, mode, controller_kind, driver) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'SIMULATOR') RETURNING id`,
        [B, code, n, t(`ประตู ${String(n).padStart(2, '0')}`, `Gate ${String(n).padStart(2, '0')}`, `${String(n).padStart(2, '0')}号闸机`), direction, ids['zone:ENTRANCE'], mode, n % 3 === 0 ? 'FLAP_BARRIER' : n % 3 === 1 ? 'TURNSTILE' : 'SWING_GATE'],
      );
      ids[code] = g.id;
      const disp = await device(`${code}-DISPLAY`, `${code} Scanner & Display`, 'GATE_DISPLAY', 'ENTRANCE');
      await q(`INSERT INTO gate_devices (gate_id, device_id, role) VALUES ($1,$2,'DISPLAY'), ($1,$2,'SCANNER')`, [g.id, disp]);
    }

    // ---------------- ticket types
    const tt = async (code: string, name: T, minAge: number | null, maxAge: number | null, maxH: number | null, color: string, sort: number, desc: T) =>
      (ids[`tt:${code}`] = (await q(`INSERT INTO ticket_types (code, name, description, min_age, max_age, max_height, color, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [code, name, desc, minAge, maxAge, maxH, color, sort])).id);
    await tt('ADULT', t('ผู้ใหญ่', 'Adult', '成人'), 13, 59, null, '#2563eb', 0, t('อายุ 13–59 ปี', 'Age 13–59', '13–59岁'));
    await tt('CHILD', t('เด็ก', 'Child', '儿童'), 3, 12, 140, '#f59e0b', 1, t('อายุ 3–12 ปี หรือสูงไม่เกิน 140 ซม.', 'Age 3–12 or under 140 cm', '3–12岁或身高140cm以下'));
    await tt('SENIOR', t('ผู้สูงอายุ', 'Senior', '长者'), 60, null, null, '#10b981', 2, t('อายุ 60 ปีขึ้นไป', 'Age 60+', '60岁以上'));
    await tt('STUDENT', t('นักเรียน/นักศึกษา', 'Student', '学生'), 13, 25, null, '#8b5cf6', 3, t('แสดงบัตรนักเรียนที่ทางเข้า', 'Show student ID at entry', '入园时出示学生证'));
    await tt('INFANT', t('เด็กเล็ก', 'Infant', '婴幼儿'), 0, 2, 90, '#ec4899', 4, t('อายุต่ำกว่า 3 ปี เข้าฟรี', 'Under 3 — free', '3岁以下免费'));

    // ---------------- rides + scan points (each with a paired scanner device)
    const ride = async (code: string, name: T, zoneCode: string, o: { minH?: number; minAge?: number; cap: number; dur: number; addon?: number; member?: number; queue?: boolean; prefix?: string; type?: string; uses?: number; x: number; y: number; desc: T }) => {
      const r = await q(
        `INSERT INTO rides (branch_id, code, name, description, zone_id, min_height, min_age, capacity, duration_minutes, addon_price, member_price, queue_enabled, queue_prefix, addon_type, addon_uses, map, sort, image_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
        [B, code, name, o.desc, ids[`zone:${zoneCode}`], o.minH ?? null, o.minAge ?? null, o.cap, o.dur, o.addon ?? null, o.member ?? null, !!o.queue, o.prefix ?? 'A', o.type ?? 'ONE_TIME', o.uses ?? 1,
         { x: o.x, y: o.y }, Number(code.slice(1)), `/park/${code.toLowerCase()}.svg`],
      );
      ids[`ride:${code}`] = r.id;
      const n = Number(code.slice(1));
      const spCode = `SCAN-RIDE-${String(n).padStart(3, '0')}`;
      const dev = await device(spCode, `${name.en} scanner`, 'RIDE_SCANNER', zoneCode);
      const sp = await q(`INSERT INTO ride_scan_points (branch_id, code, name, ride_id, zone_id, device_id, mode) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [B, spCode, `${name.en} entrance`, r.id, ids[`zone:${zoneCode}`], dev, o.queue ? 'BOTH' : 'ENTRY']);
      ids[`sp:${code}`] = sp.id;
      return r.id;
    };
    await ride('R01', t('ม้าหมุน', 'Carousel', '旋转木马'), 'KIDS', { cap: 24, dur: 4, addon: 60, member: 50, x: 12, y: 18, desc: t('ม้าหมุนคลาสสิกสำหรับทุกวัย', 'Classic carousel for all ages', '适合全家的经典旋转木马') });
    await ride('R02', t('รถบั๊ม', 'Bumper Car', '碰碰车'), 'ADVENTURE', { minH: 110, cap: 16, dur: 5, addon: 80, member: 70, x: 42, y: 20, desc: t('ขับรถชนกันอย่างสนุกสนาน', 'Bump and laugh', '碰撞欢乐') });
    await ride('R03', t('เพลย์กราวด์', 'Playground', '游乐场'), 'KIDS', { cap: 60, dur: 30, addon: 100, x: 20, y: 45, desc: t('เครื่องเล่นปีนป่ายในร่ม', 'Indoor climbing playground', '室内攀爬乐园') });
    await ride('R04', t('วีอาร์ แอดเวนเจอร์', 'VR Adventure', 'VR探险'), 'VR', { minAge: 8, cap: 6, dur: 6, addon: 120, member: 100, queue: true, prefix: 'V', x: 84, y: 18, desc: t('ผจญภัยโลกเสมือนจริง', 'Virtual reality adventure', '虚拟现实探险') });
    await ride('R05', t('โกคาร์ท', 'Go Kart', '卡丁车'), 'ADVENTURE', { minH: 120, minAge: 8, cap: 8, dur: 8, addon: 180, member: 160, queue: true, prefix: 'G', x: 60, y: 14, desc: t('ซิ่งโกคาร์ทไฟฟ้า', 'Electric go-kart racing', '电动卡丁车竞速') });
    await ride('R06', t('บ้านผีสิง', 'Haunted House', '鬼屋'), 'ADVENTURE', { minAge: 10, cap: 10, dur: 7, addon: 80, x: 50, y: 42, desc: t('ท้าความกล้า', 'Dare to enter', '挑战胆量') });
    await ride('R07', t('รถไฟเหาะ', 'Roller Coaster', '过山车'), 'ADVENTURE', { minH: 120, cap: 20, dur: 3, addon: 150, member: 130, queue: true, prefix: 'A', x: 64, y: 38, desc: t('ความเร็วสุดมันส์', 'High-speed thrills', '极速刺激') });
    await ride('R08', t('แทรมโพลีน', 'Trampoline Park', '蹦床公园'), 'KIDS', { cap: 30, dur: 20, addon: 90, type: 'TIME_BASED', x: 10, y: 58, desc: t('กระโดดได้ 60 นาที', 'Bounce for 60 minutes', '畅跳60分钟') });
    await q(`UPDATE rides SET addon_valid_minutes=60 WHERE id=$1`, [ids['ride:R08']]);

    // ---------------- membership tiers & products
    const tier = async (code: string, name: T, rank: number, color: string) =>
      (ids[`tier:${code}`] = (await q(`INSERT INTO member_tiers (code, name, rank, color) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [code, name, rank, color])).id);
    ids['tier:BASIC'] = (await q(`SELECT id FROM member_tiers WHERE code='BASIC'`)).id;
    await tier('STANDARD', t('สแตนดาร์ด', 'Standard', '标准'), 10, '#0ea5e9');
    await tier('GOLD', t('โกลด์', 'Gold', '黄金'), 20, '#d4a017');
    await tier('PLATINUM', t('แพลทินัม', 'Platinum', '铂金'), 30, '#6b7280');
    await tier('VIP', t('วีไอพี', 'VIP', '贵宾'), 40, '#7c3aed');
    const mp = async (code: string, tierCode: string, name: T, price: number, mult: number, benefits: [string, number, T][], design: object, sort: number) => {
      const r = await q(
        `INSERT INTO membership_products (code, tier_id, name, description, price, renewal_price, point_multiplier, card_design, early_renewal_discount_pct, grace_days, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,10,15,$9) RETURNING id`,
        [code, ids[`tier:${tierCode}`], name, t(`บัตรสมาชิก ${name.th} อายุ 1 ปี`, `${name.en} membership — 1 year`, `${name.zh}会员 — 1年`), price, Math.round(price * 0.9), mult, design, sort],
      );
      let i = 0;
      for (const [type, value, n] of benefits) await q(`INSERT INTO membership_benefits (product_id, type, value, name, sort) VALUES ($1,$2,$3,$4,$5)`, [r.id, type, value, n, i++]);
      ids[`mp:${code}`] = r.id;
    };
    await mp('MS-STANDARD', 'STANDARD', t('สแตนดาร์ด', 'Standard', '标准'), 299, 1, [
      ['TICKET_DISCOUNT', 5, t('ลดค่าบัตรเข้า 5%', 'Tickets -5%', '门票9.5折')], ['POINT_MULTIPLIER', 1, t('แต้ม x1', 'Points x1', '积分x1')],
    ], { background: 'linear-gradient(135deg,#0ea5e9,#2563eb)', foreground: '#ffffff' }, 0);
    await mp('MS-GOLD', 'GOLD', t('โกลด์', 'Gold', '黄金'), 599, 1.5, [
      ['TICKET_DISCOUNT', 10, t('ลดค่าบัตรเข้า 10%', 'Tickets -10%', '门票9折')], ['FOOD_DISCOUNT', 5, t('ลดอาหาร 5%', 'Food -5%', '餐饮9.5折')],
      ['RETAIL_DISCOUNT', 5, t('ลดสินค้า 5%', 'Retail -5%', '商品9.5折')], ['BIRTHDAY_REWARD', 1, t('เข้าฟรีเดือนเกิด', 'Free ticket in birthday month', '生日月免费入园')],
      ['POINT_MULTIPLIER', 1.5, t('แต้ม x1.5', 'Points x1.5', '积分x1.5')],
    ], { background: 'linear-gradient(135deg,#f6d365,#d4a017)', foreground: '#3b2f00' }, 1);
    await mp('MS-PLATINUM', 'PLATINUM', t('แพลทินัม', 'Platinum', '铂金'), 1299, 2, [
      ['TICKET_DISCOUNT', 15, t('ลดค่าบัตรเข้า 15%', 'Tickets -15%', '门票85折')], ['FOOD_DISCOUNT', 10, t('ลดอาหาร 10%', 'Food -10%', '餐饮9折')],
      ['RETAIL_DISCOUNT', 10, t('ลดสินค้า 10%', 'Retail -10%', '商品9折')], ['PRIORITY_QUEUE', 1, t('คิวพิเศษ', 'Priority queue', '优先排队')],
      ['FREE_LOCKER', 1, t('ล็อกเกอร์ฟรี', 'Free locker', '免费储物柜')], ['POINT_MULTIPLIER', 2, t('แต้ม x2', 'Points x2', '积分x2')],
    ], { background: 'linear-gradient(135deg,#e5e7eb,#6b7280)', foreground: '#111827' }, 2);
    await mp('MS-VIP', 'VIP', t('วีไอพี', 'VIP', '贵宾'), 2999, 2, [
      ['TICKET_DISCOUNT', 20, t('ลดค่าบัตรเข้า 20%', 'Tickets -20%', '门票8折')], ['FOOD_DISCOUNT', 15, t('ลดอาหาร 15%', 'Food -15%', '餐饮85折')],
      ['RETAIL_DISCOUNT', 10, t('ลดสินค้า 10%', 'Retail -10%', '商品9折')], ['FAST_PASS', 1, t('Fast Pass', 'Fast Pass', '快速通道')],
      ['PRIORITY_QUEUE', 1, t('คิวพิเศษ', 'Priority queue', '优先排队')], ['LOUNGE', 1, t('VIP Lounge', 'VIP Lounge', '贵宾休息室')], ['POINT_MULTIPLIER', 2, t('แต้ม x2', 'Points x2', '积分x2')],
    ], { background: 'linear-gradient(135deg,#7c3aed,#1e1b4b)', foreground: '#ffffff' }, 3);

    // ---------------- packages
    const pkg = async (code: string, o: { kind?: string; name: T; desc: T; color: string; prices: [string | null, number, number | null, number | null][]; allRides?: boolean; rides?: [string, string, number | null][]; days?: number; flex?: number; mode?: string; time?: [string, string]; bundle?: object; minQty?: number; channels?: string[]; benefits?: [string, number, number, object][]; reentry?: boolean; sort: number; refund?: string; requiresDate?: boolean }) => {
      const r = await q(
        `INSERT INTO packages (code, kind, name, description, color, all_rides, days, usage_mode, flex_window_days, time_start, time_end, bundle, min_qty, channels, reentry, sort, refund_policy, requires_visit_date, image_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
        [code, o.kind ?? 'ADMISSION', o.name, o.desc, o.color, !!o.allRides, o.days ?? 1, o.mode ?? 'FIXED_DATES', o.flex ?? 1, o.time?.[0] ?? null, o.time?.[1] ?? null, o.bundle ?? {}, o.minQty ?? 1,
         o.channels ?? ['ONLINE', 'COUNTER', 'KIOSK'], o.reentry ?? true, o.sort, o.refund ?? 'FULL_BEFORE_VISIT', o.requiresDate ?? true, `/park/pkg-${code.toLowerCase()}.svg`],
      );
      for (const [ttCode, price, member, weekend] of o.prices) await q(`INSERT INTO package_prices (package_id, ticket_type_id, price, member_price, weekend_price) VALUES ($1,$2,$3,$4,$5)`, [r.id, ttCode ? ids[`tt:${ttCode}`] : null, price, member, weekend]);
      for (const [rideCode, type, uses] of o.rides ?? []) await q(`INSERT INTO package_rides (package_id, ride_id, entitlement_type, uses) VALUES ($1,$2,$3,$4)`, [r.id, ids[`ride:${rideCode}`], type, uses]);
      for (const [type, value, qty, config] of o.benefits ?? []) await q(`INSERT INTO package_benefits (package_id, type, value, qty, config) VALUES ($1,$2,$3,$4,$5)`, [r.id, type, value, qty, config]);
      ids[`pkg:${code}`] = r.id;
    };
    const BASIC_RIDES: [string, string, number | null][] = [['R01', 'UNLIMITED', null], ['R02', 'UNLIMITED', null], ['R03', 'UNLIMITED', null], ['R08', 'UNLIMITED', null]];
    await pkg('DAY-BASIC', { name: t('บัตรวันเดียว เบสิก', 'Basic Day Pass', '基础一日票'), desc: t('เล่นได้ ม้าหมุน รถบั๊ม เพลย์กราวด์ แทรมโพลีน ไม่จำกัด', 'Unlimited Carousel, Bumper Car, Playground & Trampoline', '旋转木马、碰碰车、游乐场、蹦床无限次'), color: '#0ea5e9',
      prices: [['ADULT', 450, 405, 490], ['CHILD', 350, 315, 390], ['SENIOR', 250, null, null], ['STUDENT', 380, null, 420], ['INFANT', 0, null, null]], rides: BASIC_RIDES, sort: 0 });
    await pkg('DAY-UNLIMITED', { name: t('บัตรวันเดียว เล่นทุกเครื่อง', 'Unlimited Day Pass', '全通一日票'), desc: t('เล่นได้ทุกเครื่องเล่นไม่จำกัดรอบ', 'All rides, unlimited', '全部设施无限次'), color: '#6366f1',
      prices: [['ADULT', 890, 800, 950], ['CHILD', 690, 620, 750], ['SENIOR', 490, null, null], ['STUDENT', 750, null, null]], allRides: true, sort: 1 });
    await pkg('HALF-EVENING', { name: t('บัตรหลัง 16:00 น.', 'Evening Pass (after 4 pm)', '傍晚票（16:00后）'), desc: t('เข้าได้ 16:00–20:00 เล่นเครื่องเล่นเบสิก', 'Entry 4–8 pm, basic rides', '16:00–20:00入园，基础设施'), color: '#f97316',
      prices: [['ADULT', 290, null, null], ['CHILD', 220, null, null]], rides: BASIC_RIDES, time: ['16:00', '20:00'], sort: 2 });
    await pkg('ADMISSION-ONLY', { name: t('บัตรเข้าชมอย่างเดียว', 'Admission Only', '仅入园'), desc: t('เข้าพื้นที่ ซื้อเครื่องเล่นแยกได้ที่จุดสแกน', 'Park entry; buy rides at the scanners', '入园，可在设施处单独购买'), color: '#64748b',
      prices: [['ADULT', 200, null, null], ['CHILD', 150, null, null], ['SENIOR', 100, null, null]], sort: 3 });
    await pkg('FAMILY', { name: t('แพ็กเกจครอบครัว (2 ผู้ใหญ่ + 2 เด็ก)', 'Family Package (2 adults + 2 kids)', '家庭套票（2大2小）'), desc: t('เล่นทุกเครื่อง 4 ท่าน คุ้มกว่า', 'All rides for 4 — best value', '4人全通，更划算'), color: '#ec4899',
      prices: [[null, 2390, 2190, 2590]], allRides: true, bundle: { ADULT: 2, CHILD: 2 }, sort: 4 });
    await pkg('TWO-DAY', { name: t('บัตร 2 วัน (วันติดกัน)', '2-Day Pass (consecutive)', '两日票（连续）'), desc: t('ใช้ได้ 2 วันติดกัน เล่นทุกเครื่อง', '2 consecutive days, all rides', '连续2天，全部设施'), color: '#14b8a6',
      prices: [['ADULT', 1490, 1350, null], ['CHILD', 1190, 1090, null]], allRides: true, days: 2, sort: 5 });
    await pkg('FLEX-2IN7', { name: t('บัตร 2 วัน ภายใน 7 วัน', 'Any 2 days within 7 days', '7天内任选2天'), desc: t('เลือกมาวันไหนก็ได้ 2 วันภายใน 7 วัน', 'Visit any 2 days in a 7-day window', '7天内任意2天入园'), color: '#0d9488',
      prices: [['ADULT', 1590, null, null], ['CHILD', 1290, null, null]], allRides: true, days: 2, flex: 7, mode: 'FLEX_DAYS', sort: 6 });
    await pkg('VIP', { name: t('วีไอพี เอ็กซ์พีเรียนซ์', 'VIP Experience', 'VIP体验'), desc: t('เล่นทุกเครื่อง + Fast Pass 3 ครั้ง + เครดิตในบัตร ฿200', 'All rides + 3 Fast Passes + ฿200 card credit', '全通 + 3次快速通道 + ฿200卡内余额'), color: '#7c3aed',
      prices: [['ADULT', 1990, null, null], ['CHILD', 1690, null, null]], allRides: true, benefits: [['FAST_PASS', 0, 3, {}], ['WALLET_CREDIT', 200, 1, {}]], sort: 7 });
    await pkg('SCHOOL', { name: t('กรุ๊ปโรงเรียน (20 ท่านขึ้นไป)', 'School Group (20+)', '学校团体（20人起）'), desc: t('ราคาพิเศษสำหรับคณะนักเรียน', 'Special price for school trips', '学校团体特价'), color: '#84cc16',
      prices: [['STUDENT', 250, null, null], ['ADULT', 300, null, null]], rides: BASIC_RIDES, minQty: 20, channels: ['COUNTER'], sort: 8 });
    await pkg('BIRTHDAY', { name: t('แพ็กเกจวันเกิด', 'Birthday Package', '生日套餐'), desc: t('เด็กวันเกิด + ผู้ปกครอง เล่นทุกเครื่อง พร้อมเครดิตอาหาร', 'Birthday child + parent, all rides, food credit', '寿星+家长全通，含餐饮额度'), color: '#f43f5e',
      prices: [[null, 1290, null, null]], allRides: true, bundle: { CHILD: 1, ADULT: 1 }, benefits: [['WALLET_CREDIT', 150, 1, {}]], sort: 9 });
    await pkg('VR-3RIDES', { kind: 'RIDE_PASS', name: t('วีอาร์ 3 รอบ', 'VR Adventure x3', 'VR探险3次'), desc: t('เล่น VR Adventure ได้ 3 รอบในวันที่ซื้อ', '3 VR Adventure rides on the day', '当天3次VR探险'), color: '#8b5cf6',
      prices: [[null, 300, 270, null]], rides: [['R04', 'MULTI_USE', 3]], requiresDate: true, sort: 20 });
    await pkg('FASTPASS-3', { kind: 'FAST_PASS', name: t('Fast Pass 3 ครั้ง', 'Fast Pass x3', '快速通道3次'), desc: t('ลัดคิวได้ 3 ครั้งทุกเครื่องเล่น', 'Skip the line 3 times on any ride', '任意设施优先3次'), color: '#facc15',
      prices: [[null, 250, null, null]], benefits: [['FAST_PASS', 0, 3, {}]], sort: 21 });

    // ---------------- promotions (rule engine)
    const promo = async (o: { code?: string; name: T; desc: T; type: string; vt?: string; value: number; buy?: number; get?: number; min?: number; minQty?: number; maxUnits?: number; scope?: string; channels?: string[]; itemTypes?: string[]; ttCodes?: string[]; tiers?: string[]; advance?: number; birthday?: boolean; membersOnly?: boolean; stackable?: boolean; priority: number; requiresCode?: boolean; perMember?: number; start?: string; end?: string }) =>
      (await q(
        `INSERT INTO promotions (code, name, description, badge, type, value_type, value, buy_qty, get_qty, min_order, min_qty, max_units, scope, applies_to, channels, item_types, ticket_type_ids, tier_ids, advance_days, birthday_only, members_only, stackable, priority, requires_code, usage_per_member, start_time, end_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PARK',$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING id`,
        [o.code ?? null, o.name, o.desc, o.name, o.type, o.vt ?? 'PERCENT', o.value, o.buy ?? null, o.get ?? null, o.min ?? null, o.minQty ?? null, o.maxUnits ?? null, o.scope ?? 'PRODUCT', o.channels ?? [], o.itemTypes ?? [],
         (o.ttCodes ?? []).map((x) => ids[`tt:${x}`]), (o.tiers ?? []).map((x) => ids[`tier:${x}`]), o.advance ?? null, !!o.birthday, !!o.membersOnly, o.stackable ?? true, o.priority, !!o.requiresCode, o.perMember ?? null, o.start ?? null, o.end ?? null],
      )).id;
    ids['promo:BIRTHDAY'] = await promo({ name: t('เด็กวันเกิดเข้าฟรี', 'Birthday child enters free', '寿星儿童免费'), desc: t('สมาชิกเด็กในเดือนเกิดเข้าฟรี 1 ท่าน', 'One free child ticket in the member’s birthday month', '会员生日月1名儿童免费'), type: 'PERCENT', value: 100, maxUnits: 1, itemTypes: ['PACKAGE'], ttCodes: ['CHILD'], birthday: true, membersOnly: true, priority: 40, perMember: 1 });
    await promo({ name: t('มา 4 จ่าย 3', 'Come 4, pay 3', '4人同行3人付费'), desc: t('ซื้อบัตร 4 ใบ ฟรีใบที่ถูกที่สุด', 'Buy 4 tickets, the cheapest is free', '买4张免最便宜1张'), type: 'BUY_X_GET_Y', value: 100, buy: 3, get: 1, itemTypes: ['PACKAGE'], stackable: false, priority: 30 });
    await promo({ name: t('ซื้อ 3 ใบลด 10%', 'Buy 3 tickets, 10% off', '买3张9折'), desc: t('ซื้อบัตรตั้งแต่ 3 ใบลด 10%', '10% off when buying 3+ tickets', '购买3张以上9折'), type: 'PERCENT', value: 10, minQty: 3, itemTypes: ['PACKAGE'], stackable: false, priority: 20 });
    await promo({ name: t('จองล่วงหน้า 7 วัน ลด 10%', 'Early bird: book 7 days ahead, 10% off', '提前7天预订9折'), desc: t('จองออนไลน์ล่วงหน้าอย่างน้อย 7 วัน', 'Online bookings at least 7 days ahead', '提前至少7天在线预订'), type: 'PERCENT', value: 10, itemTypes: ['PACKAGE'], channels: ['ONLINE', 'PORTAL'], advance: 7, stackable: false, priority: 25 });
    await promo({ name: t('ซื้อออนไลน์ลด ฿100', 'Online ฿100 off', '在线购买立减฿100'), desc: t('ยอดตั้งแต่ ฿800', 'On orders from ฿800', '满฿800可用'), type: 'FIXED', vt: 'FIXED', value: 100, min: 800, scope: 'ORDER', itemTypes: ['PACKAGE'], channels: ['ONLINE', 'PORTAL'], priority: 5 });
    await promo({ name: t('แฮปปี้อาวร์ ของที่ระลึก -20%', 'Souvenir happy hour -20%', '纪念品欢乐时光8折'), desc: t('15:00–17:00 ทุกวัน', 'Daily 3–5 pm', '每天15:00–17:00'), type: 'PERCENT', value: 20, itemTypes: ['PRODUCT'], channels: ['POS'], priority: 5, start: '15:00', end: '17:00' });
    await promo({ code: 'PARK100', name: t('โค้ด PARK100 ลด ฿100', 'Code PARK100 — ฿100 off', '优惠码PARK100立减฿100'), desc: t('ใช้กับบัตรเข้าชม', 'Tickets only', '仅限门票'), type: 'PROMO_CODE', vt: 'FIXED', value: 100, scope: 'ORDER', itemTypes: ['PACKAGE'], requiresCode: true, priority: 8 });
    const freeLocker = await promo({ name: t('คูปองล็อกเกอร์ฟรี', 'Free locker voucher', '免费储物柜券'), desc: t('ใช้ได้ 1 ครั้ง', 'One rental', '使用1次'), type: 'COUPON', value: 100, maxUnits: 1, itemTypes: ['LOCKER'], requiresCode: true, priority: 50 });
    const freeTicket = await promo({ name: t('คูปองบัตรเข้าชมฟรี', 'Free ticket voucher', '免费门票券'), desc: t('บัตรวันเดียว เบสิก 1 ใบ', 'One Basic Day Pass', '基础一日票1张'), type: 'COUPON', value: 100, maxUnits: 1, itemTypes: ['PACKAGE'], requiresCode: true, priority: 50 });
    await q(`UPDATE promotions SET package_ids=$2 WHERE id=$1`, [freeTicket, [ids['pkg:DAY-BASIC']]]);

    // ---------------- rewards
    const reward = async (code: string, name: T, type: string, pts: number, ref: string | null, value: number, sort: number) =>
      q(`INSERT INTO rewards (code, name, description, reward_type, points_required, ref_id, value, sort, image_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [code, name, name, type, pts, ref, value, sort, `/park/reward-${type.toLowerCase()}.svg`]);
    await reward('RW-LOCKER', t('ล็อกเกอร์ฟรี 1 ครั้ง', 'Free locker rental', '免费储物柜1次'), 'LOCKER', 50, freeLocker, 0, 0);
    await reward('RW-VR', t('เล่น VR Adventure ฟรี 1 รอบ', 'Free VR Adventure ride', '免费VR探险1次'), 'RIDE', 120, ids['ride:R04'], 0, 1);
    await reward('RW-CREDIT50', t('เครดิตในบัตร ฿50', '฿50 card credit', '卡内余额฿50'), 'WALLET_CREDIT', 60, null, 50, 2);
    await reward('RW-TICKET', t('บัตรเข้าชมฟรี 1 ใบ', 'Free Basic Day Pass', '免费基础一日票'), 'TICKET', 400, freeTicket, 0, 3);

    // ---------------- lockers
    for (let i = 101; i <= 120; i++) await q(`INSERT INTO lockers (branch_id, zone_id, bank, code, size) VALUES ($1,$2,'A',$3,'M')`, [B, ids['zone:ENTRANCE'], `L-${i}`]);
    for (let i = 201; i <= 210; i++) await q(`INSERT INTO lockers (branch_id, zone_id, bank, code, size) VALUES ($1,$2,'B',$3,'L')`, [B, ids['zone:ENTRANCE'], `L-${i}`]);
    await q(`INSERT INTO locker_rates (branch_id, label, minutes, price, member_price, sort) VALUES ($1,$2,60,40,30,0), ($1,$3,180,80,60,1), ($1,$4,NULL,150,120,2)`, [
      B, t('1 ชั่วโมง', '1 Hour', '1小时'), t('3 ชั่วโมง', '3 Hours', '3小时'), t('ทั้งวัน', 'All Day', '全天'),
    ]);
    await device('LOCKER-A', 'Locker bank A controller', 'LOCKER_CONTROLLER', 'ENTRANCE');

    // ---------------- stores, retail catalogue & inventory
    const store = async (code: string, name: T, type: string, zoneCode: string, cats: string[] = []) =>
      (ids[`store:${code}`] = (await q(`INSERT INTO stores (branch_id, code, name, type, zone_id, category_ids, receipt_printer_id) VALUES ($1,$2,$3,$4,$5,$6,(SELECT id FROM printers WHERE branch_id=$1 AND type='RECEIPT' AND is_default LIMIT 1)) RETURNING id`, [B, code, name, type, ids[`zone:${zoneCode}`], cats])).id);
    const cat = async (name: T, icon: string, sort: number) => (await q(`INSERT INTO categories (kind, name, icon, sort, channel) VALUES ('STANDARD',$1,$2,$3,'RETAIL') RETURNING id`, [name, icon, sort])).id as string;
    const C_SOUV = await cat(t('ของที่ระลึก', 'Souvenirs', '纪念品'), 'gift', 200);
    const C_TOY = await cat(t('ของเล่น', 'Toys', '玩具'), 'toy', 210);
    const C_PHOTO = await cat(t('ภาพถ่าย', 'Photos', '照片'), 'camera', 220);
    await store('TICKETING', t('เคาน์เตอร์จำหน่ายบัตร', 'Ticket Counter', '售票处'), 'TICKETING', 'ENTRANCE');
    await store('SOUVENIR', t('ร้านของที่ระลึก', 'Souvenir Shop', '纪念品店'), 'RETAIL', 'ENTRANCE', [C_SOUV, C_TOY, C_PHOTO]);
    await store('FOODCOURT', t('ศูนย์อาหาร', 'Food Court', '美食广场'), 'RESTAURANT', 'FOOD');
    await store('LOCKERS', t('จุดเช่าล็อกเกอร์', 'Locker Service', '储物柜服务'), 'LOCKER', 'ENTRANCE');
    await store('WAREHOUSE', t('คลังสินค้า', 'Warehouse', '仓库'), 'WAREHOUSE', 'ENTRANCE');
    await q(`UPDATE orders SET store_id=$1 WHERE store_id IS NULL`, [ids['store:FOODCOURT']]);
    const product = async (sku: string, catId: string, name: T, price: number, cost: number, type: string, barcode: string, stock: number) => {
      const p = await q(`INSERT INTO products (sku, barcode, category_id, price, cost, track_stock, product_type, image_url) VALUES ($1,$2,$3,$4,$5,true,$6,$7) RETURNING id`, [sku, barcode, catId, price, cost, type, `/park/${sku.toLowerCase()}.svg`]);
      for (const lang of ['th', 'en', 'zh'] as const) await q(`INSERT INTO product_translations (product_id, lang, name) VALUES ($1,$2,$3)`, [p.id, lang, name[lang]]);
      await q(`INSERT INTO inventory (product_id, store_id, qty, min_qty) VALUES ($1,$2,$3,5), ($1,$4,$5,10)`, [p.id, ids['store:SOUVENIR'], stock, ids['store:WAREHOUSE'], stock * 4]);
      ids[`prod:${sku}`] = p.id;
    };
    await product('TSHIRT', C_SOUV, t('เสื้อยืดแฮปปี้แลนด์', 'HappyLand T-shirt', '欢乐乐园T恤'), 350, 140, 'MERCHANDISE', '8850001000011', 40);
    await product('PLUSH', C_TOY, t('ตุ๊กตามาสคอต', 'Mascot Plush', '吉祥物玩偶'), 290, 110, 'SOUVENIR', '8850001000028', 30);
    await product('KEYCHAIN', C_SOUV, t('พวงกุญแจ', 'Keychain', '钥匙扣'), 99, 30, 'SOUVENIR', '8850001000035', 100);
    await product('CAP', C_SOUV, t('หมวกแก๊ป', 'Cap', '鸭舌帽'), 250, 90, 'MERCHANDISE', '8850001000042', 25);
    await product('BALLOON', C_TOY, t('ลูกโป่ง', 'Balloon', '气球'), 60, 15, 'SOUVENIR', '8850001000059', 80);
    await product('PHOTO', C_PHOTO, t('ภาพถ่ายเครื่องเล่น', 'Ride Photo Print', '游乐照片'), 150, 20, 'PHOTO', '8850001000066', 500);

    // ---------------- printers for tickets & wristbands (via the print agent)
    const agent = await q(`SELECT id FROM print_agents WHERE branch_id=$1 LIMIT 1`, [B]);
    await q(`INSERT INTO printers (branch_id, name, type, connection, executor, host, port, agent_id, paper_width, is_default) VALUES ($1,'Ticket Printer','TICKET','LAN','AGENT','192.168.1.110',9100,$2,80,true)`, [B, agent?.id ?? null]);
    await q(`INSERT INTO printers (branch_id, name, type, connection, executor, driver, host, port, agent_id, paper_width, dots_per_line, raster_mode, is_default) VALUES ($1,'Wristband Printer','WRISTBAND','LAN','AGENT','ZPL','192.168.1.111',9100,$2,58,200,'RASTER',true)`, [B, agent?.id ?? null]);

    await device('COUNTER-01', 'Ticket counter 01', 'COUNTER', 'ENTRANCE');
    await device('POS-SOUVENIR', 'Souvenir shop POS', 'POS', 'ENTRANCE');
    await device('EDGE-01', 'Gate edge controller (GPIO)', 'EDGE_AGENT', 'ENTRANCE', { pins: { 'GATE-01': 17, 'GATE-02': 27 } });
    output.parkDeviceTokens = deviceTokens;

    // ---------------- wristband stock (pre-printed, activated at the counter)
    const batch = await q(`INSERT INTO wristband_batches (branch_id, type, qty, note) VALUES ($1,'PRINTED_WRISTBAND',30,'Demo stock') RETURNING id`, [B]);
    for (let i = 0; i < 30; i++) await issueCredential(c, { type: 'PRINTED_WRISTBAND', branchId: B, batchId: batch.id, status: 'NEW' });
  });

  // ---------------- demo members with wallets (committed above → services can run)
  const today = (await one<any>(`SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date::text AS d`)).d;
  const members: Record<string, any> = {};
  await tx(async (c) => {
    const m1 = await registerMemberTx(c, { phone: '0811111111', firstName: 'Somchai', lastName: 'Jaidee', email: 'somchai@example.com', password: 'member1234', birthday: '1988-05-12', gender: 'MALE', branchId: B, createdVia: 'COUNTER' });
    await applyMembership(c, { memberId: m1.member.id, productId: ids['mp:MS-GOLD'], kind: 'COMP', saleId: null, price: 0, today });
    const card = await issueCredential(c, { type: 'MEMBER_CARD', branchId: B, accountId: m1.account.id, memberId: m1.member.id, label: 'Somchai Jaidee' });
    await query(`INSERT INTO membership_cards (member_id, credential_id, card_type) VALUES ($1,$2,'PHYSICAL')`, [m1.member.id, card.id], c);
    await walletPost(c, { accountId: m1.account.id, type: 'TOPUP', amount: 1250, branchId: B, memberId: m1.member.id, reference: 'DEMO', note: 'Demo opening balance' });
    await query(`UPDATE members SET points=320 WHERE id=$1`, [m1.member.id], c);
    await query(`INSERT INTO points_ledger (member_id, type, points, balance_before, balance_after, reference) VALUES ($1,'ADJUST',320,0,320,'DEMO')`, [m1.member.id], c);
    members.gold = { memberNo: m1.member.member_no, card: card.code };
    const m2 = await registerMemberTx(c, { phone: '0822222222', firstName: 'Malee', lastName: 'Rakdee', email: 'malee@example.com', password: 'member1234', birthday: `2016-${today.slice(5, 7)}-15`, branchId: B, createdVia: 'ONLINE' });
    await walletPost(c, { accountId: m2.account.id, type: 'TOPUP', amount: 300, branchId: B, memberId: m2.member.id, reference: 'DEMO' });
    members.basic = { memberNo: m2.member.member_no };
    // A guest wristband with balance for POS / ride demos.
    const acc = await createAccount(c, { branchId: B, kind: 'GUEST', name: 'Walk-in guest' });
    const wb = await issueCredential(c, { type: 'TEMP_WRISTBAND', branchId: B, accountId: acc.id, label: 'Walk-in guest' });
    await walletPost(c, { accountId: acc.id, type: 'TOPUP', amount: 500, branchId: B, credentialId: wb.id, reference: 'DEMO' });
    members.guestWristband = wb.code;
  });
  output.parkMembers = members;
  output.parkIds = { gates: Object.fromEntries(Object.entries(ids).filter(([k]) => k.startsWith('GATE-'))), scanPoints: Object.fromEntries(Object.entries(ids).filter(([k]) => k.startsWith('sp:'))) };
  return output;
}
