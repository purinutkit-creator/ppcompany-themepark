import QRCode from 'qrcode';
import { EscPos } from './escpos';
import type { Block, PrintDoc } from './document';
import { needsRaster } from './document';
import type { RasterMode } from '../types';

/* ---------- Canvas abstraction (browser canvas or @napi-rs/canvas in the print agent) ---------- */
export interface Ctx2D {
  font: string;
  fillStyle: string | unknown;
  textBaseline: string;
  textAlign: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  drawImage(img: any, x: number, y: number, w: number, h: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray | Uint8Array };
  letterSpacing?: string;
}
export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): any;
}
export interface ImageLike {
  width: number;
  height: number;
}
export interface RasterEnv {
  createCanvas(w: number, h: number): CanvasLike;
  loadImage?(url: string): Promise<ImageLike | null>;
}

export interface RenderOptions {
  paperWidth: 58 | 80;
  dotsPerLine?: number; // default 384 (58mm) / 576 (80mm)
  charsPerLine?: number; // text mode, default 32 / 48
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number; // base px in raster mode
  lineHeight?: number; // multiplier
  letterSpacing?: number; // px
  mode?: RasterMode;
  openDrawer?: boolean;
}

const FALLBACK_FONTS = '"Noto Sans Thai", "Sarabun", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", Tahoma, sans-serif';

function segmentWords(text: string): string[] {
  const Seg = (Intl as any).Segmenter;
  if (Seg) {
    const seg = new Seg('th', { granularity: 'word' });
    return Array.from(seg.segment(text), (s: any) => s.segment as string);
  }
  return Array.from(text);
}

/** Greedy word wrap using a measuring function (Thai/Chinese aware via Intl.Segmenter). */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of segmentWords(para)) {
      const candidate = line + word;
      if (measure(candidate) <= maxWidth || !line) {
        if (measure(candidate) > maxWidth && !line) {
          // Single segment wider than the line: hard-break by grapheme.
          let chunk = '';
          for (const ch of Array.from(word)) {
            if (measure(chunk + ch) > maxWidth && chunk) {
              out.push(chunk);
              chunk = '';
            }
            chunk += ch;
          }
          line = chunk;
        } else line = candidate;
      } else {
        out.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

const SIZE_MULT = { 1: 1, 2: 1.45, 3: 2.4 } as const;

interface Op {
  y: number;
  h: number;
  draw: (ctx: Ctx2D, y: number) => void | Promise<void>;
}

/** Lay out a PrintDoc on a canvas. Returns the canvas sized to content. */
export async function renderDocToCanvas(doc: PrintDoc, env: RasterEnv, opt: RenderOptions): Promise<CanvasLike> {
  const width = opt.dotsPerLine ?? (opt.paperWidth === 58 ? 384 : 576);
  const base = opt.fontSize ?? (opt.paperWidth === 58 ? 22 : 24);
  const lh = opt.lineHeight ?? 1.3;
  const family = opt.fontFamily ? `"${opt.fontFamily}", ${FALLBACK_FONTS}` : FALLBACK_FONTS;
  const weight = opt.fontWeight ?? 400;
  const pad = 4;
  const measureCanvas = env.createCanvas(width, 10);
  const mctx = measureCanvas.getContext('2d') as Ctx2D;
  const fontFor = (size: 1 | 2 | 3, bold?: boolean) =>
    `${bold ? Math.max(700, weight) : weight} ${Math.round(base * SIZE_MULT[size])}px ${family}`;
  const spacing = opt.letterSpacing ? `${opt.letterSpacing}px` : '0px';

  const ops: Op[] = [];
  let y = 0;
  for (const b of doc.blocks) {
    const size = ('size' in b && b.size) || 1;
    const font = fontFor(size as 1 | 2 | 3, 'bold' in b ? b.bold : false);
    const lineH = Math.round(base * SIZE_MULT[size as 1 | 2 | 3] * lh);
    mctx.font = font;
    if (mctx.letterSpacing !== undefined) mctx.letterSpacing = spacing;
    const measure = (s: string) => mctx.measureText(s).width;
    if (b.t === 'text') {
      const lines = wrapText(b.text, width - pad * 2, measure);
      for (const ln of lines) {
        const yy = y;
        ops.push({
          y: yy,
          h: lineH,
          draw: (ctx) => {
            ctx.font = font;
            if (ctx.letterSpacing !== undefined) ctx.letterSpacing = spacing;
            const w = ctx.measureText(ln).width;
            const x = b.align === 'center' ? (width - w) / 2 : b.align === 'right' ? width - pad - w : pad;
            if (b.invert) {
              ctx.fillStyle = '#000';
              ctx.fillRect(0, yy, width, lineH);
              ctx.fillStyle = '#fff';
            } else ctx.fillStyle = '#000';
            ctx.fillText(ln, x, yy + lineH * 0.78);
            ctx.fillStyle = '#000';
          },
        });
        y += lineH;
      }
    } else if (b.t === 'cols') {
      const rw = measure(b.right);
      const lines = wrapText(b.left, width - pad * 3 - rw, measure);
      lines.forEach((ln, i) => {
        const yy = y;
        ops.push({
          y: yy,
          h: lineH,
          draw: (ctx) => {
            ctx.font = font;
            ctx.fillStyle = '#000';
            ctx.fillText(ln, pad, yy + lineH * 0.78);
            if (i === 0) ctx.fillText(b.right, width - pad - ctx.measureText(b.right).width, yy + lineH * 0.78);
          },
        });
        y += lineH;
      });
    } else if (b.t === 'rule') {
      const yy = y;
      const h = Math.round(base * 0.8);
      ops.push({
        y: yy,
        h,
        draw: (ctx) => {
          ctx.fillStyle = '#000';
          if (b.char === '=') {
            ctx.fillRect(pad, yy + h / 2 - 3, width - pad * 2, 2);
            ctx.fillRect(pad, yy + h / 2 + 1, width - pad * 2, 2);
          } else for (let x = pad; x < width - pad; x += 10) ctx.fillRect(x, yy + h / 2, 6, 2);
        },
      });
      y += h;
    } else if (b.t === 'feed') {
      y += Math.round(base * lh) * (b.lines ?? 1);
    } else if (b.t === 'qr') {
      const qr = QRCode.create(b.data, { errorCorrectionLevel: 'M' });
      const n = qr.modules.size;
      const scale = Math.max(2, Math.min(b.size ?? 6, Math.floor((width * 0.6) / n)));
      const sz = n * scale;
      const yy = y;
      ops.push({
        y: yy,
        h: sz + 8,
        draw: (ctx) => {
          ctx.fillStyle = '#000';
          const x0 = Math.round((width - sz) / 2);
          for (let r = 0; r < n; r++)
            for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) ctx.fillRect(x0 + c * scale, yy + 4 + r * scale, scale, scale);
        },
      });
      y += sz + 8;
    } else if (b.t === 'image') {
      const img = env.loadImage ? await env.loadImage(b.url).catch(() => null) : null;
      if (img && img.width) {
        const w = Math.round(width * (b.width ?? 0.5));
        const h = Math.round((img.height / img.width) * w);
        const yy = y;
        ops.push({ y: yy, h, draw: (ctx) => ctx.drawImage(img, Math.round((width - w) / 2), yy, w, h) });
        y += h + 6;
      }
    }
  }
  const height = Math.max(1, Math.ceil(y));
  const canvas = env.createCanvas(width, height);
  const ctx = canvas.getContext('2d') as Ctx2D;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'alphabetic';
  for (const op of ops) await op.draw(ctx, op.y);
  return canvas;
}

/** Convert canvas RGBA to packed 1-bit rows using Floyd–Steinberg dithering. */
export function canvasToBits(canvas: CanvasLike): { bits: Uint8Array; widthBytes: number; height: number } {
  const { width, height } = canvas;
  const data = (canvas.getContext('2d') as Ctx2D).getImageData(0, 0, width, height).data;
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3] / 255;
    const l = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    lum[i] = l * a + 255 * (1 - a);
  }
  const widthBytes = Math.ceil(width / 8);
  const bits = new Uint8Array(widthBytes * height);
  for (let yy = 0; yy < height; yy++) {
    for (let x = 0; x < width; x++) {
      const i = yy * width + x;
      const old = lum[i];
      const black = old < 128;
      const err = old - (black ? 0 : 255);
      if (black) bits[yy * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
      if (x + 1 < width) lum[i + 1] += (err * 7) / 16;
      if (yy + 1 < height) {
        if (x > 0) lum[i + width - 1] += (err * 3) / 16;
        lum[i + width] += (err * 5) / 16;
        if (x + 1 < width) lum[i + width + 1] += err / 16;
      }
    }
  }
  return { bits, widthBytes, height };
}

/** Text-mode ESC/POS (printer built-in font, ASCII only). */
export function renderEscPosText(doc: PrintDoc, opt: RenderOptions): Uint8Array {
  const cols = opt.charsPerLine ?? (opt.paperWidth === 58 ? 32 : 48);
  const p = new EscPos().init();
  for (const b of doc.blocks) {
    if (b.t === 'text') {
      const s = b.size ?? 1;
      p.align(b.align ?? 'left').bold(!!b.bold).invert(!!b.invert).size(s, s).line(b.text);
      p.size(1, 1).invert(false).bold(false);
    } else if (b.t === 'cols') {
      const s = b.size ?? 1;
      const width = Math.floor(cols / s);
      const room = Math.max(1, width - b.right.length - 1);
      const left = b.left.length > room ? b.left.slice(0, room) : b.left;
      p.align('left').bold(!!b.bold).size(s, s).line(left + ' '.repeat(Math.max(1, width - left.length - b.right.length)) + b.right);
      p.size(1, 1).bold(false);
    } else if (b.t === 'rule') p.align('left').line((b.char ?? '-').repeat(cols));
    else if (b.t === 'feed') p.feed(b.lines ?? 1);
    else if (b.t === 'qr') p.align('center').qr(b.data, b.size ?? 6).feed(1);
  }
  if (doc.cut) p.cut();
  if (opt.openDrawer || doc.openDrawer) p.openDrawer();
  return p.bytes();
}

/** Render a document to ESC/POS bytes. AUTO uses raster when non-ASCII text is present. */
export async function renderEscPos(doc: PrintDoc, env: RasterEnv | null, opt: RenderOptions): Promise<Uint8Array> {
  const mode = opt.mode ?? 'AUTO';
  const raster = mode === 'RASTER' || (mode === 'AUTO' && needsRaster(doc));
  if (!raster || !env) return renderEscPosText(doc, opt);
  const canvas = await renderDocToCanvas(doc, env, opt);
  const { bits, widthBytes, height } = canvasToBits(canvas);
  const p = new EscPos().init().align('left').raster(bits, widthBytes, height);
  if (doc.cut) p.feed(1).cut();
  if (opt.openDrawer || doc.openDrawer) p.openDrawer();
  return p.bytes();
}

export function blockText(b: Block): string {
  return b.t === 'text' ? b.text : b.t === 'cols' ? `${b.left} ${b.right}` : '';
}
