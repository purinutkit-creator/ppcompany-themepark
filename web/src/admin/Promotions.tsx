import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { tr } from '@kiosk/shared';
import { money } from '../lib/format';
import { Badge, Button, Card, Empty, Field, I18nInput, Input, Loading, Modal, NumberInput, PageHeader, Select, Table, Td, Toggle, confirmDialog } from '../components/ui';
import { useCrud, useList } from './hooks';

const TYPES: Record<string, string> = { PERCENT: 'Percentage discount', FIXED: 'Fixed discount', BUY_X_GET_Y: 'Buy X Get Y', COMBO: 'Combo price', SET_MENU: 'Set menu price', COUPON: 'Coupon', PROMO_CODE: 'Promo code' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function describe(p: any) {
  switch (p.type) {
    case 'PERCENT': return `${p.value}% off ${p.scope.toLowerCase()}`;
    case 'FIXED': return `${money(p.value)} off ${p.scope === 'ORDER' ? 'order' : 'each item'}`;
    case 'BUY_X_GET_Y': return `Buy ${p.buy_qty} get ${p.get_qty} (${p.value || 100}% off)`;
    case 'COMBO': case 'SET_MENU': return `${p.product_ids.length} items for ${money(p.combo_price)}`;
    default: return `${p.code} — ${p.value_type === 'PERCENT' ? `${p.value}%` : money(p.value)} off`;
  }
}

export default function Promotions() {
  const list = useList('promotions', '/menu/promotions');
  const crud = useCrud('promotions', '/menu/promotions');
  const [edit, setEdit] = useState<any | null>(null);
  const blank = { type: 'PERCENT', value_type: 'PERCENT', value: 10, scope: 'ORDER', name: {}, description: {}, badge: {}, product_ids: [], category_ids: [], branch_ids: [], days: [], requires_code: false, priority: 0, is_active: true };
  return (
    <div>
      <PageHeader title="Promotions" sub="Percentage, fixed, buy X get Y, combo, set menu, coupons & promo codes — with date/time/branch/product/category targeting" actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit(blank)}>New promotion</Button>} />
      <Card>
        {list.isLoading ? <Loading /> : !list.data?.length ? <Empty /> : (
          <Table head={['Promotion', 'Type', 'Rule', 'Period', 'Usage', 'Status', '']}>
            {list.data.map((p: any) => (
              <tr key={p.id}>
                <Td><div className="font-medium">{tr(p.name, 'th')}</div><div className="text-xs text-slate-500">{tr(p.name, 'en')}</div></Td>
                <Td><Badge>{TYPES[p.type]}</Badge>{p.code && <Badge className="ml-1 bg-violet-100 font-mono text-violet-800">{p.code}</Badge>}</Td>
                <Td className="text-sm">{describe(p)}</Td>
                <Td className="text-xs text-slate-600">{p.start_date ?? '∞'} → {p.end_date ?? '∞'}{p.start_time && <div>{p.start_time}–{p.end_time}</div>}{p.days?.length > 0 && <div>{p.days.map((d: number) => DAYS[d]).join(' ')}</div>}</Td>
                <Td>{p.usage_count}{p.usage_limit ? ` / ${p.usage_limit}` : ''}</Td>
                <Td>{p.is_active ? <Badge className="bg-emerald-100 text-emerald-800">Active</Badge> : <Badge>Inactive</Badge>}</Td>
                <Td className="text-right whitespace-nowrap">
                  <Button size="sm" variant="outline" onClick={() => setEdit(p)}>Edit</Button>
                  <Button size="sm" variant="ghost" className="text-rose-600" onClick={async () => (await confirmDialog('Delete promotion?', undefined, true)) && crud.remove(p.id)}><Trash2 className="h-4 w-4" /></Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {edit && <PromoEditor value={edit} onClose={() => setEdit(null)} save={crud.save} />}
    </div>
  );
}

function MultiPick({ options, value, onChange, label }: { options: { id: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  return (
    <Field label={label}>
      <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto rounded-xl border p-2">
        {options.map((o) => {
          const on = value.includes(o.id);
          return (
            <button type="button" key={o.id} onClick={() => onChange(on ? value.filter((x) => x !== o.id) : [...value, o.id])} className={`rounded-full px-3 py-1 text-xs ${on ? 'bg-primary text-white' : 'bg-slate-100 text-slate-700'}`}>
              {o.label}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

function PromoEditor({ value, onClose, save }: { value: any; onClose: () => void; save: (id: string | null, b: any) => Promise<unknown> }) {
  const [p, setP] = useState<any>({ ...value });
  const products = useList('products', '/menu/products');
  const cats = useList('categories', '/menu/categories');
  const branches = useList('branches', '/devices/branches');
  const set = (k: string, v: any) => setP((x: any) => ({ ...x, [k]: v }));
  const needsCode = ['COUPON', 'PROMO_CODE'].includes(p.type) || p.requires_code;
  const submit = async () => {
    const n = (v: any) => (v === '' || v == null ? null : Number(v));
    try {
      await save(p.id ?? null, {
        code: p.code || null, name: p.name, description: p.description ?? {}, badge: p.badge ?? {}, type: p.type, value_type: p.value_type, value: Number(p.value ?? 0),
        buy_qty: n(p.buy_qty), get_qty: n(p.get_qty), combo_price: n(p.combo_price), min_order: n(p.min_order), max_discount: n(p.max_discount), scope: ['COMBO', 'SET_MENU'].includes(p.type) ? 'PRODUCT' : p.scope,
        product_ids: p.product_ids, category_ids: p.category_ids, branch_ids: p.branch_ids, start_date: p.start_date || null, end_date: p.end_date || null,
        start_time: p.start_time || null, end_time: p.end_time || null, days: p.days, usage_limit: n(p.usage_limit), requires_code: needsCode, priority: Number(p.priority ?? 0), is_active: p.is_active,
      });
      onClose();
    } catch { /* toast */ }
  };
  const productOpts = (products.data ?? []).map((x: any) => ({ id: x.id, label: x.translations?.th?.name ?? x.sku }));
  return (
    <Modal open onClose={onClose} size="xl" title={p.id ? 'Edit promotion' : 'New promotion'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={!p.name?.th || (needsCode && !p.code)}>Save</Button></>}>
      <div className="space-y-4">
        <I18nInput label="Name" value={p.name} onChange={(v) => set('name', v)} required />
        <I18nInput label="Kiosk badge (e.g. -20%, 1 แถม 1)" value={p.badge} onChange={(v) => set('badge', v)} />
        <I18nInput label="Description" value={p.description} onChange={(v) => set('description', v)} />
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="Type">
            <Select value={p.type} onChange={(e) => set('type', e.target.value)}>
              {Object.entries(TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          {['PERCENT', 'FIXED', 'COUPON', 'PROMO_CODE'].includes(p.type) && (
            <Field label="Applies to">
              <Select value={p.scope} onChange={(e) => set('scope', e.target.value)}><option value="ORDER">Whole order</option><option value="PRODUCT">Products</option><option value="CATEGORY">Categories</option></Select>
            </Field>
          )}
          {['COUPON', 'PROMO_CODE'].includes(p.type) && (
            <Field label="Value type"><Select value={p.value_type} onChange={(e) => set('value_type', e.target.value)}><option value="PERCENT">Percent</option><option value="FIXED">Fixed ฿</option></Select></Field>
          )}
          {!['COMBO', 'SET_MENU'].includes(p.type) && <Field label={p.type === 'BUY_X_GET_Y' ? '% off free items (100 = free)' : p.type === 'FIXED' || p.value_type === 'FIXED' ? 'Amount (฿)' : 'Percent (%)'}><NumberInput value={p.value} onChange={(v) => set('value', v)} /></Field>}
          {p.type === 'BUY_X_GET_Y' && (
            <>
              <Field label="Buy qty (X)"><NumberInput value={p.buy_qty} onChange={(v) => set('buy_qty', v)} /></Field>
              <Field label="Get qty (Y)"><NumberInput value={p.get_qty} onChange={(v) => set('get_qty', v)} /></Field>
            </>
          )}
          {['COMBO', 'SET_MENU'].includes(p.type) && <Field label="Bundle price (฿)"><NumberInput value={p.combo_price} onChange={(v) => set('combo_price', v)} /></Field>}
          <Field label="Min order (฿)"><NumberInput value={p.min_order} onChange={(v) => set('min_order', v)} /></Field>
          <Field label="Max discount (฿)"><NumberInput value={p.max_discount} onChange={(v) => set('max_discount', v)} /></Field>
          <Field label="Priority"><NumberInput value={p.priority} onChange={(v) => set('priority', v)} /></Field>
          {needsCode && <Field label="Code"><Input value={p.code ?? ''} onChange={(e) => set('code', e.target.value.toUpperCase())} className="font-mono" /></Field>}
          <Field label="Usage limit"><NumberInput value={p.usage_limit} onChange={(v) => set('usage_limit', v)} placeholder="unlimited" /></Field>
        </div>
        {(p.scope === 'PRODUCT' || ['BUY_X_GET_Y', 'COMBO', 'SET_MENU'].includes(p.type)) && p.scope !== 'CATEGORY' && <MultiPick label={['COMBO', 'SET_MENU'].includes(p.type) ? 'Bundle products (one of each)' : 'Products'} options={productOpts} value={p.product_ids} onChange={(v) => set('product_ids', v)} />}
        {p.scope === 'CATEGORY' && <MultiPick label="Categories" options={(cats.data ?? []).filter((c: any) => c.kind === 'STANDARD').map((c: any) => ({ id: c.id, label: tr(c.name, 'th') }))} value={p.category_ids} onChange={(v) => set('category_ids', v)} />}
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="Start date"><Input type="date" value={p.start_date ?? ''} onChange={(e) => set('start_date', e.target.value)} /></Field>
          <Field label="End date"><Input type="date" value={p.end_date ?? ''} onChange={(e) => set('end_date', e.target.value)} /></Field>
          <Field label="Start time"><Input type="time" value={p.start_time ?? ''} onChange={(e) => set('start_time', e.target.value)} /></Field>
          <Field label="End time"><Input type="time" value={p.end_time ?? ''} onChange={(e) => set('end_time', e.target.value)} /></Field>
        </div>
        <MultiPick label="Days (none = every day)" options={DAYS.map((d, i) => ({ id: String(i), label: d }))} value={p.days.map(String)} onChange={(v) => set('days', v.map(Number))} />
        <MultiPick label="Branches (none = all)" options={(branches.data ?? []).map((b: any) => ({ id: b.id, label: b.code }))} value={p.branch_ids} onChange={(v) => set('branch_ids', v)} />
        <Toggle checked={p.is_active} onChange={(v) => set('is_active', v)} label="Active" />
      </div>
    </Modal>
  );
}
