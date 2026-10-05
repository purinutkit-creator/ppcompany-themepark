import { ShoppingBag, Utensils } from 'lucide-react';
import type { OrderType } from '@kiosk/shared';
import { useK } from './context';
import { KButton, KioskHeader } from './components';

export function OrderTypeScreen({ types, onPick, onHome }: { types: OrderType[]; onPick: (t: OrderType) => void; onHome: () => void }) {
  const { t } = useK();
  const cards: { id: OrderType; icon: any; title: string; sub: string; tone: string }[] = [
    { id: 'DINE_IN', icon: Utensils, title: t('dineIn'), sub: t('dineInSub'), tone: 'from-primary to-[color-mix(in_srgb,var(--brand-primary)_70%,black)]' },
    { id: 'TAKE_AWAY', icon: ShoppingBag, title: t('takeAway'), sub: t('takeAwaySub'), tone: 'from-secondary to-[color-mix(in_srgb,var(--brand-secondary)_70%,black)]' },
  ];
  return (
    <div className="flex h-full flex-col">
      <KioskHeader onHome={onHome} />
      <div className="flex flex-1 flex-col items-center justify-center gap-12 p-10">
        <h2 className="anim-up text-center text-[clamp(2.2rem,5vmin,4rem)] font-extrabold">{t('whereEat')}</h2>
        <div className="grid w-full max-w-5xl gap-8 md:grid-cols-2">
          {cards
            .filter((c) => types.includes(c.id))
            .map((c, i) => (
              <button
                key={c.id}
                onClick={() => onPick(c.id)}
                style={{ animationDelay: `${i * 80}ms` }}
                className={`press anim-pop flex aspect-[4/3] flex-col items-center justify-center gap-6 rounded-[calc(var(--brand-radius)*1.6)] bg-gradient-to-br ${c.tone} p-10 text-white shadow-2xl`}
              >
                <div className="rounded-full bg-white/15 p-8">
                  <c.icon className="h-24 w-24" strokeWidth={1.6} />
                </div>
                <div className="text-[clamp(2rem,4.5vmin,3.4rem)] font-extrabold">{c.title}</div>
                <div className="text-xl text-white/85">{c.sub}</div>
              </button>
            ))}
        </div>
        <KButton variant="ghost" size="md" onClick={onHome}>
          {t('back')}
        </KButton>
      </div>
    </div>
  );
}
