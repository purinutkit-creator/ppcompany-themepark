import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query, one, tx } from './pool';
import { migrate } from './migrate';
import { DEFAULT_ROLES, PERMISSIONS } from '../lib/permissions';
import { hashSecret, newDeviceToken } from '../lib/tokens';

type T = { th: string; en: string; zh: string };
const t = (th: string, en: string, zh: string): T => ({ th, en, zh });

/** Base data required by every installation (idempotent). */
export async function seedBase() {
  await query(
    `INSERT INTO languages (code, name, native_name, flag, enabled, is_default, sort) VALUES
       ('th','Thai','ไทย','🇹🇭',true,true,0), ('en','English','English','🇬🇧',true,false,1), ('zh','Chinese','中文','🇨🇳',true,false,2)
     ON CONFLICT (code) DO NOTHING`,
  );
  for (const [code, name, grp, sensitive] of PERMISSIONS) {
    await query(`INSERT INTO permissions (code, name, grp, is_sensitive) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, grp=EXCLUDED.grp, is_sensitive=EXCLUDED.is_sensitive`, [code, name, grp, sensitive]);
  }
  for (const r of DEFAULT_ROLES) {
    const role = await one<any>(
      `INSERT INTO roles (code, name, level, is_system) VALUES ($1,$2,$3,true) ON CONFLICT (code) DO UPDATE SET is_system=true RETURNING id, (xmax = 0) AS inserted`,
      [r.code, r.name, r.level],
    );
    // Owner always has every permission (including ones added by upgrades).
    if (role.inserted || r.code === 'OWNER') {
      await query(`INSERT INTO role_permissions (role_id, permission_code) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [role.id, r.permissions]);
    }
  }
  await query(
    `INSERT INTO fonts (family, source, weights, scripts) VALUES
       ('Prompt','GOOGLE','{300,400,500,600,700}','{latin,thai}'), ('Kanit','GOOGLE','{300,400,500,600,700}','{latin,thai}'),
       ('Sarabun','GOOGLE','{400,500,600,700}','{latin,thai}'), ('IBM Plex Sans Thai','GOOGLE','{400,500,600,700}','{latin,thai}'),
       ('Noto Sans Thai','GOOGLE','{400,500,600,700}','{latin,thai}'), ('Noto Sans SC','GOOGLE','{400,500,700}','{latin,chinese}'),
       ('Mitr','GOOGLE','{400,500,600}','{latin,thai}'), ('Inter','GOOGLE','{400,500,600,700}','{latin}')
     ON CONFLICT (family, source) DO NOTHING`,
  );
}

export async function seedDemo(opts: { adminPassword: string }) {
  const output: Record<string, unknown> = {};
  await tx(async (c) => {
    const q = (sql: string, p: unknown[] = []) => one<any>(sql, p, c);
    const branch = await q(
      `INSERT INTO branches (code, name, address, phone, tax_id) VALUES ('BKK01', $1, '123 Sukhumvit Rd, Bangkok 10110', '02-123-4567', '0105555555555') RETURNING id`,
      [t('สาขาสุขุมวิท', 'Sukhumvit Branch', '素坤逸分店')],
    );
    const B = branch.id;
    const roles = Object.fromEntries((await query<any>(`SELECT id, code FROM roles`, [], c)).map((r) => [r.code, r.id]));
    const users = [
      ['Owner Admin', 'Boss', 'OWN001', 'admin', opts.adminPassword, '1234', 'OWNER', null],
      ['Malee Manager', 'Malee', 'MGR001', 'manager', 'manager1234', '2222', 'MANAGER', B],
      ['Somchai Cashier', 'Chai', 'CSH001', 'cashier', 'cashier1234', '1111', 'CASHIER', B],
      ['Nok Kitchen', 'Nok', 'KIT001', 'kitchen', 'kitchen1234', '3333', 'KITCHEN', B],
    ] as const;
    for (const [name, nick, code, username, pw, pin, role, branchId] of users) {
      await q(
        `INSERT INTO users (name, nickname, employee_code, username, password_hash, pin_hash, role_id, branch_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [name, nick, code, username, await hashSecret(pw), await hashSecret(pin), roles[role], branchId],
      );
    }

    // Stations & printers
    const st = async (code: string, name: T, color: string, sort: number, def = false) =>
      (await q(`INSERT INTO kitchen_stations (branch_id, code, name, color, sort, is_default) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [B, code, name, color, sort, def])).id as string;
    const HOT = await st('HOT', t('ครัวร้อน', 'Hot Kitchen', '热厨房'), '#ef4444', 0);
    const MAIN = await st('MAIN', t('ครัวหลัก', 'Main Kitchen', '主厨房'), '#f97316', 1, true);
    const BEV = await st('BEV', t('เครื่องดื่ม', 'Beverage', '饮品'), '#3b82f6', 2);
    const DES = await st('DES', t('ของหวาน', 'Dessert Station', '甜品站'), '#ec4899', 3);

    const agentId = crypto.randomUUID();
    const agentTok = newDeviceToken(agentId);
    await q(`INSERT INTO print_agents (id, branch_id, name, token_hash) VALUES ($1,$2,'Counter PC Agent',$3)`, [agentId, B, agentTok.hash]);
    output.printAgentToken = agentTok.token;
    const pr = async (name: string, type: string, host: string, station: string | null, def: boolean) =>
      (await q(
        `INSERT INTO printers (branch_id, name, type, connection, executor, host, port, agent_id, station_id, paper_width, is_default) VALUES ($1,$2,$3,'LAN','AGENT',$4,9100,$5,$6,80,$7) RETURNING id`,
        [B, name, type, host, agentId, station, def],
      )).id as string;
    const receiptPrinter = await pr('Front Counter Receipt', 'RECEIPT', '192.168.1.100', null, true);
    await pr('Hot Kitchen Printer', 'KITCHEN', '192.168.1.101', HOT, false);
    await pr('Main Kitchen Printer', 'KITCHEN', '192.168.1.102', MAIN, true);
    await pr('Beverage Printer', 'BEVERAGE', '192.168.1.103', BEV, false);
    await pr('Dessert Printer', 'DESSERT', '192.168.1.104', DES, false);

    // Kiosks
    const kioskTokens: Record<string, string> = {};
    for (const [code, lang] of [['KIOSK-01', 'th'], ['KIOSK-02', 'en'], ['KIOSK-03', 'zh']] as const) {
      const id = crypto.randomUUID();
      const tok = newDeviceToken(id);
      await q(
        `INSERT INTO kiosks (id, branch_id, code, name, token_hash, default_language, receipt_printer_id, idle_timeout) VALUES ($1,$2,$3,$4,$5,$6,$7,90)`,
        [id, B, code, `Kiosk ${code.slice(-2)}`, tok.hash, lang, receiptPrinter],
      );
      kioskTokens[code] = tok.token;
    }
    output.kioskTokens = kioskTokens;

    // Schedules
    const sched = async (name: string, s: string, e: string) => (await q(`INSERT INTO menu_schedules (name, start_time, end_time) VALUES ($1,$2,$3) RETURNING id`, [name, s, e])).id as string;
    const BREAKFAST = await sched('Breakfast', '06:00', '11:00');
    await sched('Lunch', '11:00', '16:00');
    await sched('Dinner', '16:00', '23:00');

    // Categories
    const cat = async (kind: string, name: T, icon: string, sort: number, station: string | null) =>
      (await q(`INSERT INTO categories (kind, name, icon, image_url, sort, station_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [kind, name, icon, `/menu/cat-${icon}.svg`, sort, station])).id as string;
    await cat('RECOMMENDED', t('แนะนำ', 'Recommended', '推荐'), 'star', 0, null);
    await cat('PROMOTION', t('โปรโมชั่น', 'Promotion', '优惠'), 'tag', 10, null);
    const C_SET = await cat('STANDARD', t('ชุดสุดคุ้ม', 'Set Menu', '套餐'), 'set', 20, HOT);
    const C_BURGER = await cat('STANDARD', t('เบอร์เกอร์', 'Burger', '汉堡'), 'burger', 30, HOT);
    const C_CHICKEN = await cat('STANDARD', t('ไก่ทอด', 'Chicken', '炸鸡'), 'chicken', 40, HOT);
    const C_RICE = await cat('STANDARD', t('ข้าว', 'Rice', '米饭'), 'rice', 50, MAIN);
    const C_NOODLE = await cat('STANDARD', t('ก๋วยเตี๋ยว', 'Noodles', '面条'), 'noodles', 60, MAIN);
    const C_DRINK = await cat('STANDARD', t('เครื่องดื่ม', 'Drinks', '饮品'), 'drink', 70, BEV);
    const C_DESSERT = await cat('STANDARD', t('ของหวาน', 'Dessert', '甜品'), 'dessert', 80, DES);
    const C_OTHER = await cat('STANDARD', t('อื่นๆ', 'Other', '其他'), 'other', 90, HOT);

    // Modifier groups
    const grp = async (name: T, selection: 'SINGLE' | 'MULTIPLE', kind: string, required: boolean, min: number, max: number, mods: [T, number, boolean?][]) => {
      const g = await q(`INSERT INTO modifier_groups (name, selection, kind, required, min_select, max_select) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [name, selection, kind, required, min, max]);
      let i = 0;
      for (const [n, price, def] of mods) await q(`INSERT INTO modifiers (group_id, name, price_delta, is_default, sort) VALUES ($1,$2,$3,$4,$5)`, [g.id, n, price, !!def, i++]);
      return g.id as string;
    };
    const G_SIZE = await grp(t('ขนาด', 'Size', '尺寸'), 'SINGLE', 'OPTION', true, 1, 1, [[t('เล็ก', 'Small', '小杯'), 0], [t('กลาง', 'Medium', '中杯'), 10, true], [t('ใหญ่', 'Large', '大杯'), 20]]);
    const G_SWEET = await grp(t('ระดับความหวาน', 'Sweetness', '甜度'), 'SINGLE', 'OPTION', true, 1, 1, [
      [t('ไม่หวาน 0%', '0% sugar', '无糖 0%'), 0], [t('หวานน้อย 25%', '25% sugar', '微糖 25%'), 0], [t('หวาน 50%', '50% sugar', '半糖 50%'), 0],
      [t('หวาน 75%', '75% sugar', '少糖 75%'), 0], [t('หวานปกติ 100%', '100% sugar', '全糖 100%'), 0, true],
    ]);
    const G_ICE = await grp(t('น้ำแข็ง', 'Ice', '冰量'), 'SINGLE', 'OPTION', false, 0, 1, [[t('น้ำแข็งปกติ', 'Regular ice', '正常冰'), 0, true], [t('น้ำแข็งน้อย', 'Less ice', '少冰'), 0], [t('ไม่ใส่น้ำแข็ง', 'No ice', '去冰'), 0]]);
    const G_TOP = await grp(t('ท็อปปิ้ง', 'Toppings', '配料'), 'MULTIPLE', 'ADD', false, 0, 3, [[t('ชีส', 'Cheese', '芝士'), 20], [t('ไข่ดาว', 'Egg', '鸡蛋'), 15], [t('เบคอน', 'Bacon', '培根'), 25]]);
    const G_REMOVE = await grp(t('ไม่ใส่', 'Remove ingredients', '去掉配料'), 'MULTIPLE', 'REMOVE', false, 0, 4, [[t('หัวหอม', 'Onion', '洋葱'), 0], [t('แตงกวาดอง', 'Pickles', '酸黄瓜'), 0], [t('มะเขือเทศ', 'Tomato', '番茄'), 0], [t('ซอส', 'Sauce', '酱汁'), 0]]);
    const G_EXTRA = await grp(t('เพิ่มพิเศษ', 'Extra', '加量'), 'MULTIPLE', 'EXTRA', false, 0, 3, [[t('ชีสเพิ่ม', 'Extra cheese', '加芝士'), 20], [t('ซอสเพิ่ม', 'Extra sauce', '加酱'), 5], [t('เนื้อเพิ่ม', 'Extra patty', '加肉饼'), 45]]);
    const G_SPICE = await grp(t('ระดับความเผ็ด', 'Spice level', '辣度'), 'SINGLE', 'OPTION', true, 1, 1, [[t('ไม่เผ็ด', 'Not spicy', '不辣'), 0], [t('เผ็ดน้อย', 'Mild', '微辣'), 0], [t('เผ็ดกลาง', 'Medium', '中辣'), 0, true], [t('เผ็ดมาก', 'Hot', '特辣'), 0]]);
    const G_RICE_ADD = await grp(t('เพิ่ม', 'Add-ons', '加料'), 'MULTIPLE', 'ADD', false, 0, 2, [[t('ไข่ดาว', 'Fried egg', '煎蛋'), 15], [t('ข้าวเพิ่ม', 'Extra rice', '加饭'), 10]]);
    const G_SET_DRINK = await grp(t('เลือกเครื่องดื่ม', 'Choose your drink', '选择饮品'), 'SINGLE', 'OPTION', true, 1, 1, [[t('โคล่า', 'Cola', '可乐'), 0, true], [t('ชามะนาว', 'Lemon iced tea', '柠檬茶'), 0], [t('น้ำเปล่า', 'Water', '矿泉水'), 0], [t('ชาไทย', 'Thai milk tea', '泰式奶茶'), 10]]);
    const G_SET_SIDE = await grp(t('ขนาดเฟรนช์ฟรายส์', 'Fries size', '薯条大小'), 'SINGLE', 'OPTION', true, 1, 1, [[t('ปกติ', 'Regular', '常规'), 0, true], [t('ใหญ่', 'Large', '大份'), 15]]);
    const G_FLAVOR = await grp(t('รสชาติ', 'Flavor', '口味'), 'SINGLE', 'OPTION', true, 1, 1, [[t('สูตรต้นตำรับ', 'Original', '原味'), 0, true], [t('สูตรเผ็ด', 'Spicy', '辣味'), 0]]);
    const G_SAUCE = await grp(t('ซอสจิ้ม', 'Dipping sauce', '蘸酱'), 'MULTIPLE', 'ADD', false, 0, 2, [[t('บาร์บีคิว', 'BBQ', '烧烤酱'), 0], [t('ซอสพริก', 'Sweet chili', '甜辣酱'), 0], [t('ฮันนี่มัสตาร์ด', 'Honey mustard', '蜂蜜芥末'), 5]]);

    const products: Record<string, string> = {};
    let sort = 0;
    const prod = async (key: string, cat: string, price: number, cost: number, name: T, short: T, desc: T, groups: string[], o: { rec?: boolean; img: string; stock?: number; station?: string; schedule?: string } ) => {
      const p = await q(
        `INSERT INTO products (sku, category_id, image_url, price, cost, is_recommended, track_stock, sort, station_id, schedule_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [key.toUpperCase(), cat, `/menu/${o.img}.svg`, price, cost, !!o.rec, o.stock != null, sort++, o.station ?? null, o.schedule ?? null],
      );
      for (const lang of ['th', 'en', 'zh'] as const) {
        await q(`INSERT INTO product_translations (product_id, lang, name, short_description, description) VALUES ($1,$2,$3,$4,$5)`, [p.id, lang, name[lang], short[lang], desc[lang]]);
      }
      let i = 0;
      for (const g of groups) await q(`INSERT INTO product_modifier_groups (product_id, group_id, sort) VALUES ($1,$2,$3)`, [p.id, g, i++]);
      if (o.stock != null) await q(`INSERT INTO stocks (product_id, branch_id, current, minimum) VALUES ($1,$2,$3,5)`, [p.id, B, o.stock]);
      products[key] = p.id;
      return p.id as string;
    };
    const BURGER_GROUPS = [G_TOP, G_REMOVE, G_EXTRA];
    await prod('set-burger', C_SET, 199, 85, t('ชุดชีสเบอร์เกอร์', 'Cheese Burger Set', '芝士汉堡套餐'), t('เบอร์เกอร์ + เฟรนช์ฟรายส์ + เครื่องดื่ม', 'Burger + fries + drink', '汉堡+薯条+饮品'),
      t('ชีสเบอร์เกอร์เนื้อแท้ เสิร์ฟพร้อมเฟรนช์ฟรายส์และเครื่องดื่มที่คุณเลือก', 'Our signature cheese burger with golden fries and a drink of your choice.', '招牌芝士汉堡配金黄薯条和自选饮品。'),
      [G_SET_DRINK, G_SET_SIDE, G_REMOVE], { rec: true, img: 'set-burger' });
    await prod('set-chicken', C_SET, 179, 75, t('ชุดไก่ทอด', 'Fried Chicken Set', '炸鸡套餐'), t('ไก่ทอด 2 ชิ้น + เฟรนช์ฟรายส์ + เครื่องดื่ม', '2 pcs chicken + fries + drink', '2块炸鸡+薯条+饮品'),
      t('ไก่ทอดกรอบนอกนุ่มใน 2 ชิ้น พร้อมเฟรนช์ฟรายส์และเครื่องดื่ม', 'Two pieces of crispy fried chicken with fries and a drink.', '两块香脆炸鸡配薯条和饮品。'),
      [G_FLAVOR, G_SET_DRINK, G_SET_SIDE], { img: 'set-chicken' });
    await prod('cheese-burger', C_BURGER, 129, 48, t('ชีสเบอร์เกอร์', 'Classic Cheese Burger', '经典芝士汉堡'), t('เนื้อวัวย่าง ชีสเชดดาร์', 'Grilled beef, cheddar', '烤牛肉，切达芝士'),
      t('เนื้อวัวย่างถ่าน ชีสเชดดาร์ละลาย ผักสด และซอสสูตรพิเศษ ในขนมปังบริยอช', 'Flame-grilled beef patty, melted cheddar, fresh lettuce, tomato and our house sauce in a brioche bun.', '炭烤牛肉饼、融化切达芝士、新鲜生菜番茄及招牌酱，配布里欧面包。'),
      BURGER_GROUPS, { rec: true, img: 'burger' });
    await prod('double-burger', C_BURGER, 169, 70, t('ดับเบิ้ลบีฟเบอร์เกอร์', 'Double Beef Burger', '双层牛肉汉堡'), t('เนื้อ 2 ชั้น จุใจ', 'Two beef patties', '双层牛肉饼'),
      t('เนื้อวัว 2 ชั้น ชีส 2 แผ่น สำหรับคนหิวจริง', 'Two beef patties, double cheese — for the truly hungry.', '双层牛肉饼和双份芝士，满足大胃口。'), BURGER_GROUPS, { img: 'burger-double' });
    await prod('spicy-chicken-burger', C_BURGER, 139, 50, t('เบอร์เกอร์ไก่สไปซี่', 'Spicy Chicken Burger', '香辣鸡腿堡'), t('ไก่กรอบ ซอสเผ็ด', 'Crispy chicken, spicy mayo', '脆鸡，辣蛋黄酱'),
      t('สะโพกไก่ทอดกรอบ ราดซอสมายองเนสเผ็ด', 'Crispy fried chicken thigh with spicy mayo and slaw.', '香脆鸡腿肉配辣味蛋黄酱和卷心菜沙拉。'), BURGER_GROUPS, { img: 'burger-chicken' });
    await prod('egg-muffin', C_BURGER, 69, 22, t('มัฟฟินไข่ (เช้า)', 'Breakfast Egg Muffin', '早餐鸡蛋松饼'), t('เฉพาะ 06:00–11:00', 'Served 06:00–11:00', '仅限06:00–11:00'),
      t('มัฟฟินอบใหม่ ไข่ ชีส และแฮม — เมนูอาหารเช้า', 'Toasted muffin with egg, cheese and ham — breakfast only.', '烤松饼配鸡蛋、芝士和火腿——早餐限定。'), [G_TOP], { img: 'muffin', schedule: BREAKFAST });
    await prod('fried-chicken', C_CHICKEN, 99, 38, t('ไก่ทอด 2 ชิ้น', 'Fried Chicken (2 pcs)', '炸鸡（2块）'), t('กรอบนอก นุ่มใน', 'Crispy & juicy', '外酥里嫩'),
      t('ไก่หมักสูตรลับ ทอดกรอบสีทอง', 'Marinated in our secret spice blend and fried golden.', '秘制香料腌制，炸至金黄。'), [G_FLAVOR, G_SAUCE], { rec: true, img: 'chicken' });
    await prod('wings', C_CHICKEN, 129, 50, t('ปีกไก่ทอด 6 ชิ้น', 'Chicken Wings (6 pcs)', '鸡翅（6只）'), t('ปีกไก่ซอสเผ็ดหวาน', 'Sticky sweet-chili glaze', '甜辣酱鸡翅'),
      t('ปีกไก่ทอดคลุกซอส เคลือบงา', 'Fried wings tossed in sauce with sesame.', '炸鸡翅裹酱撒芝麻。'), [G_FLAVOR, G_SAUCE], { img: 'wings', stock: 30 });
    await prod('nuggets', C_CHICKEN, 89, 30, t('นักเก็ตไก่ 9 ชิ้น', 'Chicken Nuggets (9 pcs)', '鸡块（9块）'), t('พร้อมซอสจิ้ม', 'With dipping sauce', '配蘸酱'),
      t('นักเก็ตไก่เนื้อแน่น ทอดใหม่ทุกออเดอร์', 'Tender chicken nuggets, freshly fried for every order.', '鲜嫩鸡块，每单现炸。'), [G_SAUCE], { img: 'nuggets' });
    await prod('basil-pork-rice', C_RICE, 79, 28, t('ข้าวกะเพราหมูสับ', 'Basil Pork Rice', '打抛猪肉饭'), t('ผัดกะเพราร้อนๆ', 'Thai holy basil stir-fry', '泰式罗勒炒猪肉'),
      t('หมูสับผัดกะเพราพริกสด เสิร์ฟพร้อมข้าวสวย', 'Minced pork stir-fried with holy basil and chili, served with jasmine rice.', '罗勒辣椒炒猪肉末，配茉莉香米饭。'), [G_SPICE, G_RICE_ADD], { rec: true, img: 'rice-basil' });
    await prod('teriyaki-rice', C_RICE, 99, 36, t('ข้าวไก่เทอริยากิ', 'Chicken Teriyaki Rice', '照烧鸡肉饭'), t('ไก่ย่างซอสเทอริยากิ', 'Grilled chicken, teriyaki glaze', '照烧烤鸡'),
      t('สะโพกไก่ย่างราดซอสเทอริยากิ งาคั่ว', 'Grilled chicken thigh glazed with teriyaki and toasted sesame.', '照烧酱烤鸡腿配烤芝麻。'), [G_RICE_ADD], { img: 'rice-teriyaki' });
    await prod('green-curry-rice', C_RICE, 89, 32, t('ข้าวแกงเขียวหวานไก่', 'Green Curry Chicken Rice', '绿咖喱鸡饭'), t('แกงเขียวหวานเข้มข้น', 'Rich coconut green curry', '浓郁椰汁绿咖喱'),
      t('แกงเขียวหวานไก่ มะเขือ ใบโหระพา', 'Chicken green curry with Thai eggplant and sweet basil.', '泰式绿咖喱鸡配茄子和罗勒。'), [G_SPICE, G_RICE_ADD], { img: 'rice-curry' });
    await prod('tomyum-noodles', C_NOODLE, 89, 30, t('ก๋วยเตี๋ยวต้มยำ', 'Tom Yum Noodles', '冬阴功面'), t('น้ำซุปต้มยำรสจัด', 'Spicy & sour broth', '酸辣汤底'),
      t('เส้นเล็กน้ำต้มยำ หมูสับ ลูกชิ้น ถั่วลิสง', 'Rice noodles in tom yum broth with minced pork, meatballs and peanuts.', '冬阴功汤米粉配猪肉末、肉丸和花生。'), [G_SPICE], { img: 'noodle-tomyum' });
    await prod('pad-thai', C_NOODLE, 85, 28, t('ผัดไทยกุ้ง', 'Pad Thai with Shrimp', '鲜虾泰式炒河粉'), t('ผัดไทยสูตรต้นตำรับ', 'Classic Thai stir-fried noodles', '经典泰式炒粉'),
      t('เส้นจันท์ผัดซอสมะขาม กุ้ง ไข่ ถั่วงอก', 'Rice noodles wok-fried in tamarind sauce with shrimp, egg and bean sprouts.', '罗望子酱炒米粉配虾、鸡蛋和豆芽。'), [G_SPICE], { rec: true, img: 'noodle-padthai' });
    await prod('beef-noodle', C_NOODLE, 95, 38, t('ก๋วยเตี๋ยวเนื้อตุ๋น', 'Braised Beef Noodle Soup', '红烧牛肉面'), t('เนื้อตุ๋นเปื่อยนุ่ม', 'Slow-braised beef', '慢炖牛肉'),
      t('เนื้อตุ๋น 6 ชั่วโมงในน้ำซุปเครื่องเทศ', 'Beef slow-braised for 6 hours in a spiced broth.', '香料汤底慢炖6小时的牛肉。'), [], { img: 'noodle-beef' });
    await prod('cola', C_DRINK, 35, 8, t('โคล่า', 'Cola', '可乐'), t('ซ่าสดชื่น', 'Fizzy & refreshing', '清爽气泡'), t('โคล่าเย็นเจี๊ยบ', 'Ice-cold cola.', '冰爽可乐。'), [G_SIZE, G_ICE], { img: 'cola' });
    await prod('thai-tea', C_DRINK, 45, 12, t('ชาไทย', 'Thai Milk Tea', '泰式奶茶'), t('ชาไทยหอมมัน', 'Creamy & aromatic', '香浓丝滑'),
      t('ชาไทยชงสด นมข้นหวาน', 'Freshly brewed Thai tea with condensed milk.', '现泡泰式茶配炼乳。'), [G_SIZE, G_SWEET, G_ICE], { rec: true, img: 'thai-tea' });
    await prod('americano', C_DRINK, 55, 14, t('อเมริกาโน่เย็น', 'Iced Americano', '冰美式'), t('กาแฟคั่วเข้ม', 'Dark roast espresso', '深烘浓缩咖啡'),
      t('เอสเพรสโซ่ช็อตคู่ เติมน้ำเย็น', 'Double espresso over ice and water.', '双份浓缩咖啡加冰水。'), [G_SIZE, G_SWEET, G_ICE], { img: 'coffee' });
    await prod('lemon-tea', C_DRINK, 39, 9, t('ชามะนาว', 'Lemon Iced Tea', '柠檬冰茶'), t('เปรี้ยวหวานชื่นใจ', 'Sweet & tangy', '酸甜清爽'),
      t('ชาดำเย็นผสมมะนาวสด', 'Iced black tea with fresh lime.', '冰红茶加鲜青柠。'), [G_SIZE, G_SWEET, G_ICE], { img: 'lemon-tea' });
    await prod('water', C_DRINK, 15, 4, t('น้ำดื่ม', 'Mineral Water', '矿泉水'), t('600 มล.', '600 ml', '600毫升'), t('น้ำแร่ธรรมชาติ', 'Natural mineral water.', '天然矿泉水。'), [], { img: 'water' });
    await prod('sundae', C_DESSERT, 39, 10, t('ซันเดย์วานิลลา', 'Vanilla Sundae', '香草圣代'), t('ราดซอสช็อกโกแลต', 'With chocolate fudge', '淋巧克力酱'),
      t('ไอศกรีมวานิลลาราดซอสช็อกโกแลตและถั่ว', 'Soft-serve vanilla with chocolate fudge and nuts.', '香草软冰淇淋淋巧克力酱和坚果。'), [], { img: 'sundae' });
    await prod('mango-sticky-rice', C_DESSERT, 79, 30, t('ข้าวเหนียวมะม่วง', 'Mango Sticky Rice', '芒果糯米饭'), t('มะม่วงน้ำดอกไม้', 'Sweet Nam Dok Mai mango', '香甜芒果'),
      t('ข้าวเหนียวมูนกะทิกับมะม่วงสุก', 'Coconut sticky rice with ripe mango.', '椰浆糯米配熟芒果。'), [], { rec: true, img: 'mango', stock: 20 });
    await prod('choco-pie', C_DESSERT, 35, 9, t('พายช็อกโกแลต', 'Chocolate Pie', '巧克力派'), t('อบร้อนๆ', 'Served warm', '温热供应'),
      t('พายกรอบไส้ช็อกโกแลตเยิ้ม', 'Crispy pie with molten chocolate filling.', '酥脆派皮包裹流心巧克力。'), [], { img: 'pie', stock: 15 });
    await prod('fries', C_OTHER, 49, 12, t('เฟรนช์ฟรายส์', 'French Fries', '薯条'), t('ทอดกรอบสีทอง', 'Golden & crispy', '金黄香脆'),
      t('มันฝรั่งทอดกรอบ โรยเกลือ', 'Crispy fries with sea salt.', '海盐脆薯条。'), [G_SET_SIDE], { img: 'fries' });
    await prod('onion-rings', C_OTHER, 59, 15, t('หอมทอด', 'Onion Rings', '洋葱圈'), t('กรอบอร่อย', 'Crunchy batter', '香脆外衣'),
      t('หอมใหญ่ชุบแป้งทอด', 'Battered onion rings.', '裹粉炸洋葱圈。'), [G_SAUCE], { img: 'onion-rings' });

    // Upsell recommendations
    const rec = async (from: string, to: string, msg: T, special: number | null, s: number) =>
      q(`INSERT INTO product_recommendations (product_id, recommended_product_id, message, special_price, sort) VALUES ($1,$2,$3,$4,$5)`, [products[from], products[to], msg, special, s]);
    for (const b of ['cheese-burger', 'double-burger', 'spicy-chicken-burger']) {
      await rec(b, 'fries', t('เพิ่มเฟรนช์ฟรายส์ไหม?', 'Add French fries?', '加一份薯条吗？'), null, 0);
      await rec(b, 'cola', t('เพิ่มเครื่องดื่มเพียง +฿25', 'Add a drink for only +฿25', '加饮品仅需 +฿25'), 25, 1);
    }
    await rec('fried-chicken', 'cola', t('เพิ่มโคล่าเย็นๆ เพียง +฿25', 'Add an ice-cold cola for +฿25', '加冰可乐仅 +฿25'), 25, 0);
    await rec('basil-pork-rice', 'thai-tea', t('เพิ่มชาไทยไหม?', 'Add a Thai milk tea?', '来杯泰式奶茶？'), 39, 0);
    await rec('pad-thai', 'thai-tea', t('เพิ่มชาไทยไหม?', 'Add a Thai milk tea?', '来杯泰式奶茶？'), 39, 0);

    // Promotions
    await q(
      `INSERT INTO promotions (name, description, badge, type, combo_price, product_ids, priority) VALUES ($1,$2,$3,'COMBO',189,$4,10)`,
      [t('คอมโบเบอร์เกอร์', 'Burger Combo', '汉堡组合'), t('ชีสเบอร์เกอร์ + เฟรนช์ฟรายส์ + โคล่า เพียง ฿189', 'Cheese burger + fries + cola for ฿189', '芝士汉堡+薯条+可乐仅 ฿189'), t('คอมโบ', 'COMBO', '组合'),
       [products['cheese-burger'], products['fries'], products['cola']]],
    );
    await q(
      `INSERT INTO promotions (name, description, badge, type, buy_qty, get_qty, value, scope, product_ids, priority) VALUES ($1,$2,$3,'BUY_X_GET_Y',1,1,100,'PRODUCT',$4,5)`,
      [t('ซันเดย์ 1 แถม 1', 'Sundae Buy 1 Get 1', '圣代买一送一'), t('ซื้อซันเดย์ 1 ถ้วย ฟรีอีก 1 ถ้วย', 'Buy one sundae, get one free', '买一杯圣代送一杯'), t('1 แถม 1', 'BUY 1 GET 1', '买一送一'), [products['sundae']]],
    );
    await q(
      `INSERT INTO promotions (name, description, badge, type, value, scope, category_ids, start_time, end_time, priority) VALUES ($1,$2,$3,'PERCENT',20,'CATEGORY',$4,'14:00','17:00',1)`,
      [t('แฮปปี้อาวร์เครื่องดื่ม -20%', 'Happy Hour Drinks -20%', '欢乐时光饮品8折'), t('เครื่องดื่มลด 20% เวลา 14:00–17:00', '20% off drinks 2–5 pm', '14:00–17:00饮品8折'), t('-20%', '-20%', '-20%'), [C_DRINK]],
    );
    await q(
      `INSERT INTO promotions (code, name, description, type, value_type, value, max_discount, scope, requires_code) VALUES ('WELCOME10',$1,$2,'PROMO_CODE','PERCENT',10,50,'ORDER',true)`,
      [t('โค้ด WELCOME10 ลด 10%', 'WELCOME10 — 10% off', 'WELCOME10 九折'), t('ลด 10% สูงสุด ฿50', '10% off, up to ฿50', '九折，最高优惠 ฿50')],
    );
    output.branchCode = 'BKK01';
    output.branchId = B;
  });
  return output;
}

async function main() {
  const reset = process.argv.includes('--reset');
  await migrate((m) => console.log(m));
  if (reset) {
    console.log('Resetting all data...');
    await query(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations' LOOP
        EXECUTE format('TRUNCATE TABLE %I CASCADE', r.tablename);
      END LOOP; END $$;`);
  }
  await seedBase();
  const hasData = await one(`SELECT 1 FROM branches LIMIT 1`);
  if (hasData) {
    console.log('Base data ensured. Demo data already present (use --reset to recreate).');
    return;
  }
  if (process.env.SEED_DEMO === 'false') {
    console.log('Base data seeded (demo disabled). Create the first branch/admin via SQL or enable demo.');
    return;
  }
  const out = await seedDemo({ adminPassword: process.env.SEED_ADMIN_PASSWORD || 'admin1234' });
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, '..', '..', '.seed-output.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log('\nDemo data created. Device tokens (shown once, also written to', file, '):');
  console.log(JSON.stringify(out, null, 2));
  console.log('\nLogins: admin / admin1234 (or PIN OWN001/1234), manager MGR001/2222, cashier CSH001/1111, kitchen KIT001/3333');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main()
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
