import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { parkApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useT } from '../../lib/lang';
import { Badge, Button, Card, Checkbox, Empty, Field, I18nInput, Input, Loading, MediaInput, Modal, NumberInput, PageHeader, Select, Table, Td, Toggle, confirmDialog, toast } from '../../components/ui';

export type T3 = { th: string; en: string; zh: string };
export type Opt = { value: string; label: string };
export interface FieldDef {
  k: string;
  label: T3;
  type: 'text' | 'code' | 'i18n' | 'i18nMulti' | 'number' | 'money' | 'bool' | 'color' | 'select' | 'multi' | 'date' | 'time' | 'datetime' | 'image' | 'json';
  options?: Opt[];
  hint?: T3;
  full?: boolean;
  /** Empty input → null (instead of '' / 0). */
  nullable?: boolean;
  showIf?: (f: any) => boolean;
}
export interface Column {
  label: T3;
  render: (row: any) => ReactNode;
  className?: string;
}

const L = (th: string, en: string, zh: string): T3 => ({ th, en, zh });
export { L };

/** One form field rendered from its definition. */
export function FieldInput({ d, value, onChange }: { d: FieldDef; value: any; onChange: (v: any) => void }) {
  const t = useT();
  const label = t.x(d.label);
  switch (d.type) {
    case 'i18n':
    case 'i18nMulti':
      return <I18nInput label={label} value={value ?? {}} onChange={onChange} multiline={d.type === 'i18nMulti'} />;
    case 'bool':
      return <div className="pt-6"><Toggle checked={!!value} onChange={onChange} label={label} /></div>;
    case 'number':
    case 'money':
      return <Field label={label} hint={d.hint ? t.x(d.hint) : undefined}><NumberInput value={value ?? null} onChange={(v) => onChange(v == null && !d.nullable ? 0 : v)} step={d.type === 'money' ? '0.01' : undefined} /></Field>;
    case 'color':
      return <Field label={label}><div className="flex gap-2"><input type="color" value={value || '#64748b'} onChange={(e) => onChange(e.target.value)} className="h-10 w-12 rounded-lg border" /><Input value={value ?? ''} onChange={(e) => onChange(e.target.value)} /></div></Field>;
    case 'select':
      return (
        <Field label={label} hint={d.hint ? t.x(d.hint) : undefined}>
          <Select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' && d.nullable ? null : e.target.value)}>
            {d.nullable && <option value="">—</option>}
            {(d.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </Field>
      );
    case 'multi': {
      const v: string[] = value ?? [];
      return (
        <Field label={label} hint={d.hint ? t.x(d.hint) : undefined}>
          <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto rounded-xl border p-2">
            {(d.options ?? []).map((o) => {
              const on = v.includes(o.value);
              return <button type="button" key={o.value} onClick={() => onChange(on ? v.filter((x) => x !== o.value) : [...v, o.value])} className={`rounded-full px-3 py-1 text-xs ${on ? 'bg-primary text-white' : 'bg-slate-100 text-slate-700'}`}>{o.label}</button>;
            })}
          </div>
        </Field>
      );
    }
    case 'date':
    case 'time':
    case 'datetime':
      return <Field label={label}><Input type={d.type === 'datetime' ? 'datetime-local' : d.type} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} /></Field>;
    case 'image':
      return <MediaInput label={label} value={value ?? ''} onChange={(v) => onChange(v || null)} />;
    case 'json':
      return <JsonField label={label} value={value} onChange={onChange} hint={d.hint ? t.x(d.hint) : undefined} />;
    case 'code':
      return <Field label={label} hint={d.hint ? t.x(d.hint) : undefined}><Input value={value ?? ''} onChange={(e) => onChange(e.target.value.toUpperCase())} className="font-mono" /></Field>;
    default:
      return <Field label={label} hint={d.hint ? t.x(d.hint) : undefined}><Input value={value ?? ''} onChange={(e) => onChange(e.target.value === '' && d.nullable ? null : e.target.value)} /></Field>;
  }
}

function JsonField({ label, value, onChange, hint }: { label: string; value: any; onChange: (v: any) => void; hint?: string }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [err, setErr] = useState<string | null>(null);
  return (
    <Field label={label} hint={hint} error={err}>
      <textarea value={text} rows={4} className="w-full rounded-xl border border-slate-300 p-2 font-mono text-xs" onChange={(e) => {
        setText(e.target.value);
        try {
          onChange(JSON.parse(e.target.value || '{}'));
          setErr(null);
        } catch {
          setErr('JSON');
        }
      }} />
    </Field>
  );
}

export function EntityForm({ fields, value, onChange }: { fields: FieldDef[]; value: any; onChange: (v: any) => void }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {fields.filter((d) => !d.showIf || d.showIf(value)).map((d) => (
        <div key={d.k} className={d.full || d.type === 'i18n' || d.type === 'i18nMulti' || d.type === 'multi' || d.type === 'json' ? 'md:col-span-2 xl:col-span-3' : ''}>
          <FieldInput d={d} value={value[d.k]} onChange={(v) => onChange({ ...value, [d.k]: v })} />
        </div>
      ))}
    </div>
  );
}

/**
 * Generic catalogue page: table + editor modal. `path` is the park API collection (e.g. `/admin/zones`);
 * PUT/DELETE go to `${path}/:id`. `toBody` maps the form to the API body; `extra` renders sub-editors.
 */
export function EntityPage(p: {
  title: T3;
  sub?: T3;
  path: string;
  listPath?: string;
  queryKey: string;
  fields: FieldDef[];
  columns: Column[];
  blank: Record<string, any>;
  perm: string;
  toBody?: (f: any) => any;
  fromRow?: (row: any) => any;
  extra?: (f: any, set: (v: any) => void) => ReactNode;
  rows?: (data: any) => any[];
  rowActions?: (row: any) => ReactNode;
  headerActions?: ReactNode;
  deletable?: boolean;
  /** List-only page (no create / edit form). */
  readOnly?: boolean;
  size?: 'md' | 'lg' | 'xl' | 'full';
}) {
  const t = useT();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: [p.queryKey], queryFn: () => parkApi(p.listPath ?? p.path) });
  const [edit, setEdit] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const rows: any[] = q.data ? (p.rows ? p.rows(q.data) : q.data) : [];
  const editable = can(p.perm) && !p.readOnly;
  const save = async () => {
    setBusy(true);
    try {
      const body = p.toBody ? p.toBody(edit) : edit;
      if (edit.id) await parkApi(`${p.path}/${edit.id}`, { method: 'PUT', body });
      else await parkApi(p.path, { method: 'POST', body });
      toast.success(t('saved'));
      setEdit(null);
      void qc.invalidateQueries({ queryKey: [p.queryKey] });
    } catch (e) {
      toast.error(t.err(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <PageHeader title={t.x(p.title)} sub={p.sub ? t.x(p.sub) : undefined} actions={<>{p.headerActions}{editable && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ ...p.blank })}>{t('new')}</Button>}</>} />
      <Card padded={false}>
        {q.isLoading ? <Loading /> : !rows.length ? <Empty /> : (
          <Table head={[...p.columns.map((c) => t.x(c.label)), '']}>
            {rows.map((r) => (
              <tr key={r.id} className={r.is_active === false ? 'opacity-50' : ''}>
                {p.columns.map((c, i) => <Td key={i} className={c.className}>{c.render(r)}</Td>)}
                <Td className="text-right whitespace-nowrap">
                  {p.rowActions?.(r)}
                  {editable && <Button size="sm" variant="outline" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEdit(p.fromRow ? p.fromRow(r) : { ...r })}>{t('edit')}</Button>}
                  {editable && p.deletable !== false && (
                    <Button size="sm" variant="ghost" className="text-rose-600" onClick={async () => {
                      if (!(await confirmDialog(t('delete'), undefined, true))) return;
                      try {
                        await parkApi(`${p.path}/${r.id}`, { method: 'DELETE' });
                        void qc.invalidateQueries({ queryKey: [p.queryKey] });
                      } catch (e) { toast.error(t.err(e)); }
                    }}><Trash2 className="h-4 w-4" /></Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {edit && (
        <Modal open onClose={() => setEdit(null)} size={p.size ?? 'xl'} title={`${edit.id ? t('edit') : t('new')} · ${t.x(p.title)}`} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>{t('cancel')}</Button><Button loading={busy} onClick={save}>{t('save')}</Button></>}>
          <div className="space-y-5">
            <EntityForm fields={p.fields} value={edit} onChange={setEdit} />
            {p.extra?.(edit, setEdit)}
          </div>
        </Modal>
      )}
    </div>
  );
}

export const ActiveBadge = ({ on }: { on: boolean }) => {
  const t = useT();
  return on ? <Badge className="bg-emerald-100 text-emerald-800">{t('active')}</Badge> : <Badge>{t('inactive')}</Badge>;
};
export const Swatch = ({ c }: { c: string | null | undefined }) => <span className="inline-block h-4 w-4 rounded-full border align-middle" style={{ background: c ?? '#ccc' }} />;
export { Checkbox };
