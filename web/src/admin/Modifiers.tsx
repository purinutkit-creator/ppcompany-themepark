import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { tr } from '@kiosk/shared';
import { money } from '../lib/format';
import { Badge, Button, Card, Empty, Field, I18nInput, Loading, Modal, NumberInput, PageHeader, Select, Toggle, confirmDialog } from '../components/ui';
import { useCrud, useList } from './hooks';
import { tt } from '../lib/legacy-i18n';

export default function Modifiers() {
  const list = useList('modifier-groups', '/menu/modifier-groups');
  const crud = useCrud('modifier-groups', '/menu/modifier-groups');
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <div>
      <PageHeader title={tt('Modifiers')} sub={tt('Option groups: size, sweetness, toppings, add / remove / extra ingredients')} actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ name: {}, selection: 'SINGLE', kind: 'OPTION', required: false, min_select: 0, max_select: 1, sort: 0, modifiers: [] })}>{tt('New group')}</Button>} />
      {list.isLoading ? <Loading /> : !list.data?.length ? <Empty /> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.data.map((g: any) => (
            <Card key={g.id} title={<span>{tr(g.name, 'th')} <span className="text-sm font-normal text-slate-500">/ {g.name?.en}</span></span>} actions={<><Button size="sm" variant="outline" onClick={() => setEdit(g)}>{tt('Edit')}</Button><Button size="sm" variant="ghost" className="text-rose-600" onClick={async () => (await confirmDialog(tt('Delete group?'), `Used by ${g.product_count} product(s).`, true)) && crud.remove(g.id)}><Trash2 className="h-4 w-4" /></Button></>}>
              <div className="mb-3 flex flex-wrap gap-1">
                <Badge className={g.required ? 'bg-rose-100 text-rose-700' : ''}>{g.required ? tt('Required') : 'Optional'}</Badge>
                <Badge>{g.selection === 'SINGLE' ? 'Single choice' : `Multiple (min ${g.min_select}, max ${g.max_select || '∞'})`}</Badge>
                <Badge>{g.kind}</Badge>
                <Badge>{g.product_count} products</Badge>
              </div>
              {g.modifiers.map((m: any) => (
                <div key={m.id} className="flex justify-between py-0.5 text-sm">
                  <span className={m.is_active ? '' : 'text-slate-400 line-through'}>{m.is_default && '● '}{tr(m.name, 'th')}</span>
                  <span>{Number(m.price_delta) ? `+${money(m.price_delta)}` : '—'}</span>
                </div>
              ))}
            </Card>
          ))}
        </div>
      )}
      {edit && <GroupEditor value={edit} onClose={() => setEdit(null)} save={crud.save} />}
    </div>
  );
}

function GroupEditor({ value, onClose, save }: { value: any; onClose: () => void; save: (id: string | null, b: any) => Promise<unknown> }) {
  const [g, setG] = useState<any>({ ...value, modifiers: value.modifiers.map((m: any) => ({ ...m, price_delta: Number(m.price_delta) })) });
  const set = (k: string, v: any) => setG((x: any) => ({ ...x, [k]: v }));
  const setM = (i: number, k: string, v: any) => set('modifiers', g.modifiers.map((m: any, j: number) => (j === i ? { ...m, [k]: v } : g.selection === 'SINGLE' && k === 'is_default' && v ? { ...m, is_default: false } : m)));
  const submit = async () => {
    try {
      await save(g.id ?? null, {
        name: g.name, selection: g.selection, kind: g.kind, required: g.required, min_select: Number(g.min_select), max_select: Number(g.max_select), sort: Number(g.sort ?? 0),
        modifiers: g.modifiers.map((m: any, i: number) => ({ id: m.id, name: m.name, price_delta: Number(m.price_delta ?? 0), is_default: !!m.is_default, is_active: m.is_active !== false, sort: i })),
      });
      onClose();
    } catch { /* toast */ }
  };
  return (
    <Modal open onClose={onClose} size="xl" title={g.id ? 'Edit modifier group' : 'New modifier group'} footer={<><Button variant="ghost" onClick={onClose}>{tt('Cancel')}</Button><Button onClick={submit} disabled={!g.name?.th || !g.modifiers.length}>{tt('Save')}</Button></>}>
      <div className="space-y-4">
        <I18nInput label={tt('Group name')} value={g.name} onChange={(v) => set('name', v)} required />
        <div className="grid gap-4 md:grid-cols-5">
          <Field label={tt('Selection')}>
            <Select value={g.selection} onChange={(e) => set('selection', e.target.value)}><option value="SINGLE">{tt('Single choice')}</option><option value="MULTIPLE">{tt('Multiple choice')}</option></Select>
          </Field>
          <Field label={tt('Kind')}>
            <Select value={g.kind} onChange={(e) => set('kind', e.target.value)}><option value="OPTION">{tt('Option')}</option><option value="ADD">{tt('Add ingredient')}</option><option value="REMOVE">{tt('Remove ingredient')}</option><option value="EXTRA">{tt('Extra ingredient')}</option></Select>
          </Field>
          <Field label={tt('Min selection')}><NumberInput value={g.min_select} onChange={(v) => set('min_select', v ?? 0)} min={0} /></Field>
          <Field label={tt('Max selection (0 = ∞)')}><NumberInput value={g.selection === 'SINGLE' ? 1 : g.max_select} onChange={(v) => set('max_select', v ?? 0)} min={0} disabled={g.selection === 'SINGLE'} /></Field>
          <div className="flex items-end pb-2"><Toggle checked={g.required} onChange={(v) => set('required', v)} label={tt('Required')} /></div>
        </div>
        <div className="text-sm font-semibold">{tt('Options')}</div>
        {g.modifiers.map((m: any, i: number) => (
          <div key={m.id ?? i} className="rounded-xl border p-3">
            <I18nInput value={m.name} onChange={(v) => setM(i, 'name', v)} />
            <div className="mt-2 flex flex-wrap items-center gap-4">
              <div className="w-40"><NumberInput value={m.price_delta} onChange={(v) => setM(i, 'price_delta', v ?? 0)} step="0.01" placeholder={tt('+ price')} /></div>
              <Toggle checked={!!m.is_default} onChange={(v) => setM(i, 'is_default', v)} label={tt('Default')} />
              <Toggle checked={m.is_active !== false} onChange={(v) => setM(i, 'is_active', v)} label={tt('Active')} />
              <Button size="sm" variant="ghost" className="ml-auto text-rose-600" onClick={() => set('modifiers', g.modifiers.filter((_: any, j: number) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
            </div>
          </div>
        ))}
        <Button size="sm" variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => set('modifiers', [...g.modifiers, { name: {}, price_delta: 0, is_default: false, is_active: true }])}>{tt('Add option')}</Button>
      </div>
    </Modal>
  );
}
