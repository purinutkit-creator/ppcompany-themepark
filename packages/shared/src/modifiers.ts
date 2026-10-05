import type { MenuModifierGroup } from './types';

export interface ModifierValidationError {
  groupId: string;
  code: 'REQUIRED' | 'MIN' | 'MAX' | 'SINGLE' | 'INVALID';
  min?: number;
  max?: number;
}

/** Validate a modifier selection against the product's groups (required/min/max/single). */
export function validateModifierSelection(groups: MenuModifierGroup[], selected: string[]): ModifierValidationError[] {
  const errors: ModifierValidationError[] = [];
  const all = new Map<string, string>();
  for (const g of groups) for (const m of g.modifiers) if (m.is_active) all.set(m.id, g.id);
  for (const id of selected) if (!all.has(id)) errors.push({ groupId: '', code: 'INVALID' });
  for (const g of groups) {
    const count = selected.filter((id) => all.get(id) === g.id).length;
    const min = Math.max(g.required ? Math.max(1, g.min_select) : g.min_select, 0);
    const max = g.selection === 'SINGLE' ? 1 : g.max_select > 0 ? g.max_select : Infinity;
    if (g.required && count === 0) errors.push({ groupId: g.id, code: 'REQUIRED', min });
    else if (count > 0 && count < min) errors.push({ groupId: g.id, code: 'MIN', min });
    if (count > max) errors.push({ groupId: g.id, code: g.selection === 'SINGLE' ? 'SINGLE' : 'MAX', max });
  }
  return errors;
}

export function defaultModifierSelection(groups: MenuModifierGroup[]): string[] {
  const out: string[] = [];
  for (const g of groups) {
    const defs = g.modifiers.filter((m) => m.is_active && m.is_default);
    if (g.selection === 'SINGLE') {
      if (defs[0]) out.push(defs[0].id);
    } else out.push(...defs.map((m) => m.id));
  }
  return out;
}
