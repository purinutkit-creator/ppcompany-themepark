// Fake ESC/POS network printer for testing: listens on :9101, saves each job and decodes
// GS v 0 raster data to PNG so you can see exactly what would come out of the printer.
// Usage: node scripts/fake-printer.mjs [outDir] [port]
import net from 'node:net';
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

const OUT = process.argv[2] || 'fake-printer-out';
const PORT = Number(process.argv[3] || 9101);
fs.mkdirSync(OUT, { recursive: true });
let n = 0;

function decode(buf) {
  const bands = [];
  for (let i = 0; i < buf.length - 8; i++) {
    if (buf[i] === 0x1d && buf[i + 1] === 0x76 && buf[i + 2] === 0x30) {
      const wb = buf[i + 4] | (buf[i + 5] << 8);
      const h = buf[i + 6] | (buf[i + 7] << 8);
      bands.push({ wb, h, data: buf.subarray(i + 8, i + 8 + wb * h) });
      i += 7 + wb * h;
    }
  }
  if (!bands.length) return null;
  const w = bands[0].wb * 8;
  const total = bands.reduce((s, b) => s + b.h, 0);
  const c = createCanvas(w, total);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, total);
  let y0 = 0;
  for (const b of bands) {
    for (let y = 0; y < b.h; y++)
      for (let x = 0; x < w; x++) {
        const on = (b.data[y * b.wb + (x >> 3)] >> (7 - (x & 7))) & 1;
        const k = ((y0 + y) * w + x) * 4;
        img.data[k] = img.data[k + 1] = img.data[k + 2] = on ? 0 : 255;
        img.data[k + 3] = 255;
      }
    y0 += b.h;
  }
  ctx.putImageData(img, 0, 0);
  return c.toBuffer('image/png');
}

net
  .createServer((sock) => {
    const chunks = [];
    sock.on('data', (d) => chunks.push(d));
    sock.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return; // health probe
      const id = String(++n).padStart(3, '0');
      fs.writeFileSync(`${OUT}/job-${id}.bin`, buf);
      const png = decode(buf);
      if (png) fs.writeFileSync(`${OUT}/job-${id}.png`, png);
      console.log(`job ${id}: ${buf.length} bytes${png ? ' (raster → png)' : ' (text mode)'}`);
    });
  })
  .listen(PORT, () => console.log(`fake printer listening on :${PORT}`));
