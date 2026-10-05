import { createContext, useContext } from 'react';
import type { Lang, MenuProduct } from '@kiosk/shared';
import type { TFn } from '../lib/i18n';
import type { useKioskData } from './useKioskData';

export interface KioskContextValue {
  t: TFn;
  lang: Lang;
  setLang: (l: Lang) => void;
  money: (n: number | string | null | undefined) => string;
  data: ReturnType<typeof useKioskData>;
  enabledLangs: Lang[];
  online: boolean;
  openProduct: (p: MenuProduct, opts?: { lineKey?: string; upsellSourceProductId?: string | null }) => void;
  touch: () => void;
}
export const KioskContext = createContext<KioskContextValue | null>(null);
export function useK() {
  const c = useContext(KioskContext);
  if (!c) throw new Error('KioskContext missing');
  return c;
}
