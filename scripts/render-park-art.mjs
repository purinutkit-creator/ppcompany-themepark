// Generates the language-neutral demo artwork referenced by the park seed (web/public/park/*.svg).
// Usage: node scripts/render-park-art.mjs
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('web/public/park');
fs.mkdirSync(OUT, { recursive: true });

// 24x24 stroke icons (scaled up), kept simple so they read well at card size.
const ICON = {
  ticket: 'M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z M10 6v12',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  wheel: 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0 M12 4v16 M4 12h16 M6.3 6.3l11.4 11.4 M17.7 6.3L6.3 17.7 M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  car: 'M5 16h14l-1.5-5h-11z M7 16v2 M17 16v2 M7.5 11l1.5-4h6l1.5 4 M8 19m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0 M16 19m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
  vr: 'M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-4l-2-2h-2l-2 2H5a2 2 0 0 1-2-2z M8 12m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0 M16 12m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
  coaster: 'M2 18c4-10 8-10 10-4s6 6 10-6 M4 18v3 M9 12v9 M15 16v5 M20 9v12',
  ghost: 'M6 20V10a6 6 0 0 1 12 0v10l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5z M10 10h.01 M14 10h.01',
  jump: 'M4 17h16 M6 17l2 3 M18 17l-2 3 M12 3m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0 M12 5v5 M9 8l3 2 3-2 M10 14l2-4 2 4',
  slide: 'M4 20V6h4v14 M8 8l12 12 M4 10h4 M4 14h4',
  gift: 'M4 11h16v9H4z M3 7h18v4H3z M12 7v13 M12 7c-2-3-5-3-5-1s3 1 5 1c2 0 5 1 5-1s-3-2-5 1',
  bag: 'M5 8h14l-1 12H6z M9 8a3 3 0 0 1 6 0',
  lock: 'M6 11h12v9H6z M8 11V8a4 4 0 0 1 8 0v3 M12 15v2',
  camera: 'M4 8h4l2-3h4l2 3h4v11H4z M12 13m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  shirt: 'M8 4l-4 3 2 4 2-1v10h8V10l2 1 2-4-4-3c-1 2-3 2-4 2s-3 0-4-2',
  balloon: 'M12 3a5 6 0 0 1 5 6c0 4-3 7-5 7s-5-3-5-7a5 6 0 0 1 5-6 M12 16v5 M11 16h2',
  cap: 'M4 15a8 8 0 0 1 16 0z M12 7V5 M4 15h18',
  key: 'M8 14m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0 M11 11l8-8 M16 6l2 2 M14 8l2 2',
  plush: 'M12 13m-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0 M7 7m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0 M17 7m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0 M10 12h.01 M14 12h.01 M10.5 15.5c1 .7 2 .7 3 0',
  wallet: 'M4 7h15a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4z M4 7l11-3v3 M16 13h.01',
  bolt: 'M13 2L5 14h6l-1 8 8-12h-6z',
  cake: 'M5 12h14v8H5z M4 20h16 M12 12V8 M12 5v.01 M5 15c2 1 3-1 4.7 0s3 1 4.6 0 3-1 4.7 0',
  school: 'M2 9l10-5 10 5-10 5z M6 11v5c3 2 9 2 12 0v-5 M22 9v6',
  moon: 'M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z',
  calendar: 'M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4 M8 14h2 M14 14h2',
};

const ART = {
  'pkg-day-basic': ['ticket', '#0ea5e9'], 'pkg-day-unlimited': ['star', '#6366f1'], 'pkg-half-evening': ['moon', '#f97316'], 'pkg-admission-only': ['ticket', '#64748b'],
  'pkg-family': ['plush', '#ec4899'], 'pkg-two-day': ['calendar', '#14b8a6'], 'pkg-flex-2in7': ['calendar', '#0d9488'], 'pkg-vip': ['star', '#7c3aed'], 'pkg-school': ['school', '#84cc16'],
  'pkg-birthday': ['cake', '#f43f5e'], 'pkg-vr-3rides': ['vr', '#8b5cf6'], 'pkg-fastpass-3': ['bolt', '#eab308'],
  r01: ['wheel', '#f59e0b'], r02: ['car', '#ef4444'], r03: ['slide', '#22c55e'], r04: ['vr', '#8b5cf6'], r05: ['car', '#0ea5e9'], r06: ['ghost', '#475569'], r07: ['coaster', '#e11d48'], r08: ['jump', '#14b8a6'],
  'reward-locker': ['lock', '#0891b2'], 'reward-ride': ['vr', '#8b5cf6'], 'reward-ticket': ['ticket', '#0ea5e9'], 'reward-wallet_credit': ['wallet', '#16a34a'],
  balloon: ['balloon', '#ec4899'], cap: ['cap', '#2563eb'], keychain: ['key', '#f59e0b'], photo: ['camera', '#334155'], plush: ['plush', '#f97316'], tshirt: ['shirt', '#0ea5e9'],
};

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, v + amt));
  return `#${[c(n >> 16), c((n >> 8) & 255), c(n & 255)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

for (const [name, [icon, color]] of Object.entries(ART)) {
  const dark = shade(color, -60);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300" width="480" height="300">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${dark}"/></linearGradient></defs>
  <rect width="480" height="300" fill="url(#g)"/>
  <circle cx="420" cy="40" r="90" fill="#fff" opacity=".10"/><circle cx="40" cy="280" r="110" fill="#fff" opacity=".08"/>
  <circle cx="90" cy="60" r="6" fill="#fff" opacity=".5"/><circle cx="380" cy="230" r="8" fill="#fff" opacity=".35"/><circle cx="330" cy="70" r="4" fill="#fff" opacity=".6"/>
  <circle cx="240" cy="150" r="88" fill="#fff" opacity=".16"/>
  <g transform="translate(168 78) scale(6)" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON[icon]}"/></g>
</svg>
`;
  fs.writeFileSync(path.join(OUT, `${name}.svg`), svg);
}
console.log(`wrote ${Object.keys(ART).length} images to ${OUT}`);
