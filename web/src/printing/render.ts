import { buildDoc, renderDocToCanvas, renderEscPos, type PrintDoc, type PrintJobPayload, type RasterEnv } from '@kiosk/shared';
import type { PrinterConfig } from './transports';

/** Raster environment backed by the browser canvas (fonts are whatever the page has loaded). */
export const browserEnv: RasterEnv = {
  createCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c as any;
  },
  loadImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  },
};

export async function ensureFontLoaded(family?: string | null) {
  if (!family || !document.fonts) return;
  try {
    await Promise.all([document.fonts.load(`400 24px "${family}"`, 'ทดสอบ Test 测试'), document.fonts.load(`700 24px "${family}"`, 'ทดสอบ Test 测试')]);
  } catch {
    /* fallback fonts are used */
  }
}

export async function renderJob(payload: PrintJobPayload, printer: PrinterConfig): Promise<Uint8Array> {
  const doc = buildDoc(payload, printer.name);
  await ensureFontLoaded(payload.font?.family);
  return renderEscPos(doc, browserEnv, {
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

/** Render a document to a visible canvas (receipt / ticket preview in admin). */
export async function previewCanvas(doc: PrintDoc, paperWidth: 58 | 80, font?: { family?: string; weight?: number; size?: number; lineHeight?: number; letterSpacing?: number }) {
  await ensureFontLoaded(font?.family);
  return renderDocToCanvas(doc, browserEnv, {
    paperWidth,
    fontFamily: font?.family,
    fontWeight: font?.weight,
    fontSize: font?.size,
    lineHeight: font?.lineHeight,
    letterSpacing: font?.letterSpacing,
  }) as unknown as Promise<HTMLCanvasElement>;
}
