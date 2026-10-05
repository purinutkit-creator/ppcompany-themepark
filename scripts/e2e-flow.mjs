// End-to-end smoke test of the core workflow in a real browser.
// Usage: BASE=http://localhost:4000 KIOSK_TOKEN=... node scripts/e2e-flow.mjs [screenshotDir]
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:4000';
const OUT = process.argv[2] || 'e2e-shots';
fs.mkdirSync(OUT, { recursive: true });
const seed = JSON.parse(fs.readFileSync('server/.seed-output.json', 'utf8'));
const KIOSK_TOKEN = process.env.KIOSK_TOKEN || seed.kioskTokens['KIOSK-01'];
const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({ executablePath: exe, args: ['--ignore-certificate-errors'] });
const shot = (p, n) => p.screenshot({ path: `${OUT}/${n}.png` });
const log = (...a) => console.log('•', ...a);
const errors = [];

async function ctx(viewport) {
  const c = await browser.newContext({ viewport });
  c.on('page', (p) => p.on('pageerror', (e) => errors.push(`${p.url()}: ${e.message}`)));
  return c;
}
async function staffLogin(page, code, pin, next) {
  await page.goto(`${BASE}/login?next=${encodeURIComponent(next)}`);
  await page.getByPlaceholder('CSH001').fill(code);
  for (const d of pin) await page.getByRole('button', { name: d, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).last().click();
  await page.waitForURL(`**${next}*`);
}

// ---------------------------------------------------------------- kiosk
const kc = await ctx({ width: 1366, height: 1024 });
const kiosk = await kc.newPage();
kiosk.on('pageerror', (e) => errors.push(`kiosk: ${e.message}`));
await kiosk.goto(`${BASE}/kiosk?token=${encodeURIComponent(KIOSK_TOKEN)}`);
await kiosk.getByRole('button', { name: 'Pair this device' }).click();
await kiosk.getByText('Touch to Order').first().waitFor({ timeout: 15000 }).catch(() => {});
await kiosk.waitForTimeout(1500);
await shot(kiosk, '01-kiosk-welcome');
log('welcome');
await kiosk.getByRole('button', { name: /English/ }).first().click();
await kiosk.locator('button.anim-pulse-ring').click();
await kiosk.getByText('Where will you eat today?').waitFor();
await shot(kiosk, '02-kiosk-order-type');
await kiosk.getByRole('button', { name: /Take Away/ }).click();
await kiosk.getByRole('heading', { name: 'Recommended' }).waitFor();
await kiosk.waitForTimeout(600);
await shot(kiosk, '03-kiosk-menu');
log('menu');
// Burger -> customize -> upsell
await kiosk.getByRole('button', { name: /Burger/ }).first().click();
await kiosk.getByRole('button', { name: /Classic Cheese Burger/ }).click();
await kiosk.getByText('Remove ingredients').waitFor();
await kiosk.getByRole('button', { name: /− Onion/ }).click();
await kiosk.getByRole('button', { name: /Extra cheese/ }).click();
await kiosk.waitForTimeout(300);
await shot(kiosk, '04-kiosk-customize');
await kiosk.getByRole('button', { name: /Add to cart/ }).click();
await kiosk.getByText('Make it better?').waitFor();
await shot(kiosk, '05-kiosk-upsell');
await kiosk.getByRole('button', { name: /\+ Add/ }).last().click(); // cola special price -> needs size => opens modal
await kiosk.getByRole('button', { name: /Add to cart/ }).click().catch(() => {});
log('upsell added');
// Thai tea required sweetness (defaults ok)
await kiosk.getByRole('button', { name: /Drinks/ }).first().click();
await kiosk.getByRole('button', { name: /Thai Milk Tea/ }).click();
await kiosk.getByRole('button', { name: /Add to cart/ }).click();
await kiosk.getByRole('button', { name: /View cart/ }).click();
await kiosk.getByText('Your order').waitFor();
await kiosk.waitForTimeout(400);
await shot(kiosk, '06-kiosk-cart');
log('cart');
await kiosk.getByRole('button', { name: 'Checkout' }).click();
await kiosk.getByText('Choose payment method').waitFor();
await shot(kiosk, '07-kiosk-payment-methods');
await kiosk.getByRole('button', { name: /QR \/ Bank Transfer/ }).click();
await kiosk.getByText('Scan the QR code to pay').waitFor();
await kiosk.waitForTimeout(500);
await shot(kiosk, '08-kiosk-qr');
const orderNo = (await kiosk.getByText(/Order reference #\d{5}/).textContent()).match(/\d{5}/)[0];
log('order', orderNo);

// ---------------------------------------------------------------- cashier (opened before verification to receive the realtime popup)
const cc = await ctx({ width: 1440, height: 900 });
const cashier = await cc.newPage();
await staffLogin(cashier, 'CSH001', '1111', '/cashier');
await cashier.getByText('Waiting Payment').first().waitFor();
await cashier.waitForTimeout(1500);

await kiosk.getByRole('button', { name: /I have paid — verify/ }).click();
await kiosk.getByText('Verifying your payment').waitFor();
await shot(kiosk, '09-kiosk-waiting-verification');
log('verification requested');

await cashier.getByText('มีรายการรอตรวจสอบการชำระเงิน').waitFor({ timeout: 10000 });
await shot(cashier, '10-cashier-realtime-popup');
log('cashier popup received in realtime');
await cashier.getByRole('button', { name: 'Open verification' }).click();
await cashier.getByRole('button', { name: /APPROVE/ }).waitFor();
await cashier.waitForTimeout(500);
await shot(cashier, '11-cashier-slip-verification');
await cashier.getByRole('button', { name: /APPROVE/ }).click();
log('approved');

await kiosk.getByText('PAYMENT SUCCESSFUL').waitFor({ timeout: 10000 });
await kiosk.waitForTimeout(900);
await shot(kiosk, '12-kiosk-payment-success');
log('kiosk switched to success without refresh');

// ---------------------------------------------------------------- KDS
const dc = await ctx({ width: 1600, height: 900 });
const kds = await dc.newPage();
await staffLogin(kds, 'KIT001', '3333', '/kds');
await kds.getByText(`#${orderNo}`).first().waitFor();
await kds.waitForTimeout(600);
await shot(kds, '13-kds-new');

// ---------------------------------------------------------------- Queue display
const qc = await ctx({ width: 1600, height: 900 });
const queue = await qc.newPage();
await queue.goto(`${BASE}/queue/BKK01`);
await queue.getByText(orderNo).first().waitFor();

const clickAll = async (name) => {
  for (let i = 0; i < 10 && (await kds.getByRole('button', { name, exact: true }).count()) > 0; i++) {
    await kds.getByRole('button', { name, exact: true }).first().click();
    await kds.waitForTimeout(700);
  }
};
await clickAll('START');
await shot(kds, '13b-kds-preparing');
await clickAll('DONE');
await kds.waitForTimeout(800);
await shot(kds, '14-kds-ready');
await queue.waitForTimeout(1200);
await shot(queue, '15-queue-display-ready');
log('queue display shows ready');

// ---------------------------------------------------------------- Admin
const ac = await ctx({ width: 1440, height: 1000 });
const admin = await ac.newPage();
await admin.goto(`${BASE}/login?next=/admin`);
await admin.getByRole('button', { name: /Username \+ password/ }).click();
await admin.getByLabel('Username').fill('admin');
await admin.getByLabel('Password').fill('admin1234');
await admin.getByRole('button', { name: 'Sign in' }).last().click();
await admin.getByRole('heading', { name: 'Dashboard' }).waitFor();
await admin.waitForTimeout(1500);
await shot(admin, '16-admin-dashboard');
await admin.goto(`${BASE}/admin/orders`);
await admin.getByText(`#${orderNo}`).click();
await admin.getByText('Timeline').waitFor();
await admin.waitForTimeout(800);
await shot(admin, '17-admin-order-timeline');
for (const [path, name] of [['/admin/products', '18-admin-products'], ['/admin/printers', '19-admin-printers'], ['/admin/fonts', '20-admin-fonts'], ['/admin/theme', '21-admin-theme'], ['/admin/reports', '22-admin-reports'], ['/admin/roles', '23-admin-roles'], ['/admin/audit', '24-admin-audit']]) {
  await admin.goto(`${BASE}${path}`);
  await admin.waitForTimeout(1800);
  await shot(admin, name);
}
log('admin pages');

await browser.close();
if (errors.length) {
  console.log('PAGE ERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('E2E OK');
