import { useEffect, useState } from 'react';
import { Hand } from 'lucide-react';
import { tr } from '@kiosk/shared';
import { KIOSK_STRINGS } from '../lib/i18n';
import { useK } from './context';
import { LangSwitch, Logo } from './components';

const FLOATERS = ['burger', 'fries', 'cola', 'chicken', 'sundae', 'noodle-padthai'];

export function WelcomeScreen({ onStart }: { onStart: () => void }) {
  const { data, lang, online, t } = useK();
  const theme = data.boot?.settings?.theme ?? {};
  const welcome = data.boot?.settings?.kiosk?.welcome ?? {};
  const [i, setI] = useState(0);
  const cycle = [KIOSK_STRINGS.touchToOrder.th, KIOSK_STRINGS.touchToOrder.en, KIOSK_STRINGS.touchToOrder.zh];
  useEffect(() => {
    const id = setInterval(() => setI((x) => (x + 1) % 3), 2200);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-secondary text-white" onClick={onStart}>
      {theme.welcomeVideoUrl ? (
        <video className="absolute inset-0 h-full w-full object-cover opacity-70" src={theme.welcomeVideoUrl} autoPlay muted loop playsInline />
      ) : theme.welcomeImageUrl ? (
        <img className="absolute inset-0 h-full w-full object-cover opacity-70" src={theme.welcomeImageUrl} alt="" />
      ) : (
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute -top-1/4 -right-1/4 h-[80vmax] w-[80vmax] rounded-full bg-primary opacity-90" />
          <div className="absolute -bottom-1/3 -left-1/4 h-[60vmax] w-[60vmax] rounded-full bg-accent opacity-25" />
          {FLOATERS.map((f, k) => (
            <img
              key={f}
              src={`/menu/${f}.svg`}
              alt=""
              className="anim-float absolute drop-shadow-2xl"
              style={{
                width: `${12 + (k % 3) * 4}vmin`,
                left: `${[58, 74, 50, 80, 62, 86][k]}%`,
                top: `${[12, 28, 46, 52, 70, 8][k]}%`,
                animationDelay: `${k * 0.6}s`,
              }}
            />
          ))}
        </div>
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/10 to-transparent" />

      <div className="relative z-10 flex items-center justify-between p-8">
        <Logo size={72} light />
        {!online && <span className="rounded-full bg-amber-400 px-4 py-2 font-semibold text-amber-950">{t('offline')}</span>}
      </div>

      <div className="relative z-10 mt-auto p-10 pb-6">
        <h1 className="max-w-[16ch] text-[clamp(3rem,7vmin,6.5rem)] leading-[1.05] font-extrabold drop-shadow-lg">{tr(welcome.title, lang, 'Welcome')}</h1>
        <p className="mt-4 max-w-[30ch] text-[clamp(1.4rem,2.8vmin,2.4rem)] font-medium text-white/90">{tr(welcome.subtitle, lang)}</p>
        <button
          onClick={onStart}
          className="press anim-pulse-ring mt-10 inline-flex h-28 items-center gap-5 rounded-full bg-btn px-14 text-[clamp(1.8rem,3.6vmin,3rem)] font-bold text-btn-text shadow-2xl"
        >
          <Hand className="h-12 w-12" />
          <span key={i} className="anim-fade inline-block min-w-[9ch]">
            {cycle[i]}
          </span>
        </button>
      </div>

      <div className="relative z-10 flex flex-col items-center gap-3 bg-black/30 p-6 backdrop-blur" onClick={(e) => e.stopPropagation()}>
        <div className="text-base font-medium text-white/80">ภาษา · Language · 语言</div>
        <LangSwitch />
      </div>
      <button className="absolute right-0 bottom-0 z-20 h-16 w-16 opacity-0" onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('kiosk-admin-tap')); }} aria-label="admin" />
    </div>
  );
}
