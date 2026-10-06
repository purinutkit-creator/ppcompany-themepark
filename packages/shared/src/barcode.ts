/**
 * Code 128 encoder (sets B and C with automatic switching) — used for printed tickets / wristbands / cards
 * (thermal raster, ZPL, ESC/POS text mode fallback) and for on-screen SVG barcodes. No dependencies so the
 * same code runs in the browser, the server and the print agent.
 */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232',
  '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122',
  '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311',
  '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113',
  '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422',
  '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111',
  '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121',
  '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232', '2331112',
];
const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;
const STOP = 106;

function digitRun(s: string, i: number): number {
  let n = 0;
  while (i + n < s.length && s.charCodeAt(i + n) >= 48 && s.charCodeAt(i + n) <= 57) n++;
  return n;
}

/** Encode text to Code 128 symbol values (including start, checksum and stop). */
export function code128Values(text: string): number[] {
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) throw new Error('Code128: only printable ASCII is supported');
  }
  const out: number[] = [];
  let i = 0;
  let set: 'B' | 'C';
  const startRun = digitRun(text, 0);
  if (startRun >= 4 && startRun % 2 === 0) {
    set = 'C';
    out.push(START_C);
  } else {
    set = 'B';
    out.push(START_B);
  }
  while (i < text.length) {
    const run = digitRun(text, i);
    if (set === 'B' && run >= 4) {
      // Odd runs: emit one digit in B first so the C part is even.
      if (run % 2 === 1) {
        out.push(text.charCodeAt(i) - 32);
        i++;
      }
      out.push(CODE_C);
      set = 'C';
      continue;
    }
    if (set === 'C') {
      if (run >= 2) {
        out.push(Number(text.slice(i, i + 2)));
        i += 2;
        continue;
      }
      out.push(CODE_B);
      set = 'B';
      continue;
    }
    out.push(text.charCodeAt(i) - 32);
    i++;
  }
  let sum = out[0];
  for (let k = 1; k < out.length; k++) sum += out[k] * k;
  out.push(sum % 103, STOP);
  return out;
}

/** Bar/space module widths, starting with a bar. Includes the stop pattern's final bar. */
export function code128Modules(text: string): number[] {
  return code128Values(text).flatMap((v) => PATTERNS[v].split('').map(Number));
}

/** Total width in modules, without quiet zones. */
export function code128Width(text: string): number {
  return code128Modules(text).reduce((s, n) => s + n, 0);
}

/** Render as an SVG string (for screens / A4 printing). */
export function code128Svg(text: string, opts: { height?: number; module?: number; quiet?: number; color?: string } = {}): string {
  const mods = code128Modules(text);
  const m = opts.module ?? 2;
  const quiet = (opts.quiet ?? 10) * m;
  const h = opts.height ?? 60;
  let x = quiet;
  const rects: string[] = [];
  mods.forEach((w, idx) => {
    if (idx % 2 === 0) rects.push(`<rect x="${x}" y="0" width="${w * m}" height="${h}"/>`);
    x += w * m;
  });
  const width = x + quiet;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${h}" width="${width}" height="${h}" shape-rendering="crispEdges"><rect width="${width}" height="${h}" fill="#fff"/><g fill="${opts.color ?? '#000'}">${rects.join('')}</g></svg>`;
}
