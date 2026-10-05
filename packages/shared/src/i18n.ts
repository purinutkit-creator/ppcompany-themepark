import type { I18nText, Lang } from './types';

/** Resolve a translated text, falling back to English, Thai, then any value. */
export function tr(text: I18nText | null | undefined, lang: Lang, fallback = ''): string {
  if (!text) return fallback;
  return text[lang] || text.en || text.th || text.zh || fallback;
}

export function isLang(v: unknown): v is Lang {
  return v === 'th' || v === 'en' || v === 'zh';
}
