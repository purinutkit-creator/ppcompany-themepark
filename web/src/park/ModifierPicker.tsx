import { useState } from 'react';
import clsx from 'clsx';
import { money } from '../lib/format';
import { useT } from '../lib/lang';
import { Button, Modal } from '../components/ui';

/** Modifier selection for a menu product (single / multiple groups with min / max), used by mobile + POS ordering. */
export function ModifierPicker({ p, onClose, onAdd }: { p: any; onClose: () => void; onAdd: (ids: string[]) => void }) {
  const t = useT();
  const [sel, setSel] = useState<string[]>(() => p.modifier_groups.flatMap((g: any) => g.modifiers.filter((m: any) => m.is_default).map((m: any) => m.id)));
  const ok = p.modifier_groups.every((g: any) => {
    const n = g.modifiers.filter((m: any) => sel.includes(m.id)).length;
    return n >= (g.required ? Math.max(1, g.min_select) : g.min_select) && n <= g.max_select;
  });
  return (
    <Modal open onClose={onClose} title={t.tr(p.name)} size="md" footer={<Button disabled={!ok} onClick={() => onAdd(sel)}>{t('add')}</Button>}>
      <div className="space-y-4">
        {p.modifier_groups.map((g: any) => (
          <div key={g.id}>
            <div className="mb-1 font-semibold">{t.tr(g.name)} {g.required && <span className="text-xs text-rose-600">*</span>}</div>
            <div className="flex flex-wrap gap-1.5">
              {g.modifiers.map((m: any) => {
                const on = sel.includes(m.id);
                return (
                  <button key={m.id} onClick={() => setSel((s) => {
                    if (on) return s.filter((x) => x !== m.id);
                    const inG = g.modifiers.map((x: any) => x.id);
                    return g.selection === 'SINGLE' ? [...s.filter((x) => !inG.includes(x)), m.id] : [...s, m.id];
                  })} className={clsx('rounded-full px-3 py-1.5 text-sm', on ? 'bg-primary text-white' : 'bg-slate-100')}>
                    {t.tr(m.name)}{Number(m.price_delta) ? ` +${money(m.price_delta)}` : ''}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
