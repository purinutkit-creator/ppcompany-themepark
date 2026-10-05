// Renders web/public/icon.svg to PNG app icons (run: node scripts/render-icons.mjs)
import { chromium } from 'playwright';
import fs from 'node:fs';
const exe = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ executablePath: exe });
const svg = fs.readFileSync('web/public/icon.svg', 'utf8');
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `web/public/icon-${size}.png`, omitBackground: true });
  await page.close();
}
await browser.close();
