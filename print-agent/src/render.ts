import fs from 'node:fs';
import path from 'node:path';
import { GlobalFonts, createCanvas, loadImage } from '@napi-rs/canvas';
import { buildDoc, renderEscPos, type PrintJobPayload, type RasterEnv } from '@kiosk/shared';
import type { AgentPrinter } from './transports';

/** Raster environment backed by @napi-rs/canvas (Skia) — renders Thai / Chinese / custom fonts. */
export function nodeEnv(baseUrl: string): RasterEnv {
  return {
    createCanvas: (w, h) => createCanvas(w, h) as any,
    async loadImage(url) {
      try {
        const abs = new URL(url, baseUrl).toString();
        const res = await fetch(abs);
        if (!res.ok) return null;
        return (await loadImage(Buffer.from(await res.arrayBuffer()))) as any;
      } catch {
        return null;
      }
    },
  };
}

const registered = new Set<string>();

/** Download and register fonts from the server font library (uploads + Google Fonts). */
export async function syncFonts(fonts: { family: string; source: string; file_url: string | null; format: string | null }[], baseUrl: string, cacheDir: string, log: (m: string) => void) {
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const f of fonts) {
    if (registered.has(f.family)) continue;
    try {
      const files: string[] = [];
      if (f.source === 'UPLOAD' && f.file_url) {
        const ext = f.format ?? 'ttf';
        const dest = path.join(cacheDir, `${f.family.replace(/[^\w-]+/g, '_')}.${ext}`);
        if (!fs.existsSync(dest)) {
          const res = await fetch(new URL(f.file_url, baseUrl));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
        }
        files.push(dest);
      } else if (f.source === 'GOOGLE') {
        // A plain user agent makes Google Fonts return TrueType URLs, which Skia loads directly.
        const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(f.family).replace(/%20/g, '+')}:wght@400;700`, { headers: { 'User-Agent': 'Mozilla/4.0' } })).text();
        const urls = [...css.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]);
        for (const [i, u] of urls.slice(0, 6).entries()) {
          const dest = path.join(cacheDir, `${f.family.replace(/[^\w-]+/g, '_')}-${i}${path.extname(new URL(u).pathname) || '.ttf'}`);
          if (!fs.existsSync(dest)) fs.writeFileSync(dest, Buffer.from(await (await fetch(u)).arrayBuffer()));
          files.push(dest);
        }
      }
      for (const file of files) GlobalFonts.registerFromPath(file, f.family);
      if (files.length) {
        registered.add(f.family);
        log(`font registered: ${f.family} (${files.length} file${files.length > 1 ? 's' : ''})`);
      }
    } catch (e) {
      log(`font ${f.family} unavailable (${(e as Error).message}); system fallback fonts will be used`);
    }
  }
}

export async function renderJob(payload: PrintJobPayload, printer: AgentPrinter, baseUrl: string): Promise<Uint8Array> {
  const doc = buildDoc(payload, printer.name);
  return renderEscPos(doc, nodeEnv(baseUrl), {
    paperWidth: printer.paper_width,
    dotsPerLine: printer.dots_per_line ?? undefined,
    charsPerLine: printer.chars_per_line ?? undefined,
    fontFamily: payload.font?.family,
    fontWeight: payload.font?.weight,
    fontSize: payload.font?.size,
    lineHeight: payload.font?.lineHeight,
    letterSpacing: payload.font?.letterSpacing,
    mode: printer.raster_mode,
    openDrawer: printer.open_drawer && payload.documentType === 'RECEIPT',
  });
}
