import type { Lang } from '@kiosk/shared';
import { LANG_META } from './i18n';

let ctx: AudioContext | null = null;
export function unlockAudio() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    // Some browsers only enable speech after a user gesture utterance.
    if ('speechSynthesis' in window) window.speechSynthesis.getVoices();
  } catch {
    /* ignore */
  }
}

/** Short two-tone chime generated with WebAudio (no asset needed). */
export function chime(kind: 'ding' | 'alert' | 'success' = 'ding') {
  try {
    ctx ??= new AudioContext();
    const notes = kind === 'alert' ? [880, 660, 880] : kind === 'success' ? [523, 659, 784] : [988, 784];
    notes.forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t0 = ctx!.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
      o.connect(g).connect(ctx!.destination);
      o.start(t0);
      o.stop(t0 + 0.55);
    });
  } catch {
    /* ignore */
  }
}

/** Speak text in a language; resolves when finished (or immediately if unsupported). */
export function speak(text: string, lang: Lang): Promise<void> {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = LANG_META[lang].speech;
    const voice = window.speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(u.lang.slice(0, 2).toLowerCase()));
    if (voice) u.voice = voice;
    u.rate = 0.92;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
    setTimeout(resolve, 12000);
  });
}

/** Spell digits so TTS reads "4 8 2 7 1" rather than "forty-eight thousand…". */
export function spellNumber(n: string, lang: Lang) {
  const sep = lang === 'zh' ? '' : ' ';
  return n.split('').join(sep);
}
