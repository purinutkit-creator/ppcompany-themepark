import type { FontSpec } from '@kiosk/shared';

export interface ThemeSettings {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  surface: string;
  buttonColor: string;
  buttonText: string;
  text: string;
  radius: number;
  logoUrl?: string;
  welcomeImageUrl?: string;
  welcomeVideoUrl?: string;
  cardStyle?: 'ELEVATED' | 'FLAT' | 'OUTLINE';
}
export interface FontRow {
  id: string;
  family: string;
  source: 'GOOGLE' | 'UPLOAD' | 'SYSTEM';
  file_url: string | null;
  format: string | null;
  weights: number[];
}

/** Apply brand colors to CSS variables on a target element (document root by default). */
export function applyTheme(t: Partial<ThemeSettings> | null | undefined, el: HTMLElement = document.documentElement) {
  if (!t) return;
  const map: Record<string, string | undefined> = {
    '--brand-primary': t.primary,
    '--brand-secondary': t.secondary,
    '--brand-accent': t.accent,
    '--brand-bg': t.background,
    '--brand-surface': t.surface,
    '--brand-button': t.buttonColor,
    '--brand-button-text': t.buttonText,
    '--brand-text': t.text,
    '--brand-radius': t.radius != null ? `${t.radius}px` : undefined,
  };
  for (const [k, v] of Object.entries(map)) if (v) el.style.setProperty(k, v);
}

const loaded = new Set<string>();
/** Load a font family from Google Fonts or an uploaded file (idempotent). */
export function loadFont(family: string, fonts: FontRow[] = [], weights: number[] = [300, 400, 500, 600, 700]) {
  if (!family || loaded.has(family)) return;
  loaded.add(family);
  const row = fonts.find((f) => f.family === family);
  if (row?.source === 'UPLOAD' && row.file_url) {
    const style = document.createElement('style');
    const fmt = row.format === 'ttf' ? 'truetype' : row.format === 'otf' ? 'opentype' : row.format ?? 'woff2';
    style.textContent = `@font-face { font-family: "${family}"; src: url("${row.file_url}") format("${fmt}"); font-display: swap; font-weight: 100 900; }`;
    document.head.appendChild(style);
    return;
  }
  if (row?.source === 'SYSTEM') return;
  const w = (row?.weights?.length ? row.weights : weights).slice().sort((a, b) => a - b).join(';');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${w}&display=swap`;
  document.head.appendChild(link);
}

/** Apply a surface's font spec (Kiosk / Admin / Cashier / KDS / Queue). */
export function applyFont(spec: FontSpec | null | undefined, fonts: FontRow[] = [], el: HTMLElement = document.documentElement) {
  if (!spec) return;
  loadFont(spec.family, fonts);
  el.style.setProperty('--font-app', `"${spec.family}", 'Noto Sans SC', system-ui, sans-serif`);
  el.style.setProperty('--font-size-app', `${spec.size}px`);
  el.style.setProperty('--font-weight-app', String(spec.weight));
  el.style.setProperty('--letter-spacing-app', `${spec.letterSpacing}px`);
  el.style.setProperty('--line-height-app', String(spec.lineHeight));
}
