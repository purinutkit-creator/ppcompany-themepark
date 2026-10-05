import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Search, Trash2 } from 'lucide-react';
import { tr } from '@kiosk/shared';
import { staffApi, errorMessage } from '../lib/api';
import { money } from '../lib/format';
import { Badge, Button, Card, Empty, Field, I18nInput, Input, Loading, MediaInput, Modal, NumberInput, PageHeader, Select, Table, Td, Toggle, confirmDialog, toast } from '../components/ui';
import { useCrud, useList } from './hooks';

const blank = () => ({
  sku: '', barcode: '', category_id: '', image_url: '', price: 0, cost: 0, vat_rate: null as number | null, station_id: null, printer_id: null, schedule_id: null,
  status: 'AVAILABLE', is_recommended: false, track_stock: false, sort: 0,
  translations: { th: { name: '', short_description: '', description: '' }, en: { name: '', short_description: '', description: '' }, zh: { name: '', short_description: '', description: '' } } as Record<string, any>,
  modifier_group_ids: [] as string[],
  recommendations: [] as { recommended_product_id: string; message: Record<string, string>; special_price: number | null }[],
});

export default function Products() {
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const list = useList('products', `/menu/products${cat ? `?categoryId=${cat}` : ''}`);
  const cats = useList('categories', '/menu/categories');
  const [edit, setEdit] = useState<any | null>(null);
  const crud = useCrud('products', '/menu/products');
  const rows = useMemo(() => (list.data ?? []).filter((p: any) => !q || p.sku.toLowerCase().includes(q.toLowerCase()) || Object.values(p.translations ?? {}).some((t: any) => t?.name?.toLowerCase().includes(q.toLowerCase()))), [list.data, q]);
  const setStatus = async (p: any, status: string) => {
    try {
      await staffApi(`/menu/products/${p.id}/status`, { method: 'PATCH', body: { status } });
      crud.invalidate();
      toast.success(`${p.sku} → ${status}`, 'Kiosks updated in real time');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <div>
      <PageHeader title="Products" sub="สินค้า — names & descriptions in ไทย / English / 中文" actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit(blank())}>New product</Button>} />
      <Card>
        <div className="mb-4 flex flex-wrap gap-3">
          <div className="relative w-72">
            <Search className="absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
            <Input className="pl-9" placeholder="Search name or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select value={cat} onChange={(e) => setCat(e.target.value)} className="w-60">
            <option value="">All categories</option>
            {cats.data?.filter((c: any) => c.kind === 'STANDARD').map((c: any) => <option key={c.id} value={c.id}>{tr(c.name, 'th')}</option>)}
          </Select>
        </div>
        {list.isLoading ? <Loading /> : rows.length === 0 ? <Empty title="No products" /> : (
          <Table head={['', 'Product', 'SKU', 'Category', 'Price', 'Cost', 'Stock', 'Status', '']}>
            {rows.map((p: any) => (
              <tr key={p.id} className="hover:bg-slate-50">
                <Td><img src={p.image_url || '/icon.svg'} className="h-11 w-11 rounded-lg bg-slate-50 object-contain" alt="" /></Td>
                <Td>
                  <div className="font-medium">{p.translations?.th?.name}</div>
                  <div className="text-xs text-slate-500">{p.translations?.en?.name} · {p.translations?.zh?.name}</div>
                  <div className="mt-0.5 flex gap-1">{p.is_recommended && <Badge className="bg-amber-100 text-amber-800">★ Recommended</Badge>}{p.schedule_id && <Badge>Scheduled</Badge>}</div>
                </Td>
                <Td className="font-mono text-xs">{p.sku}</Td>
                <Td>{tr(cats.data?.find((c: any) => c.id === p.category_id)?.name, 'th')}</Td>
                <Td className="font-semibold">{money(p.price)}</Td>
                <Td className="text-slate-500">{money(p.cost)}</Td>
                <Td>{p.track_stock ? `${Number(p.stock_current ?? 0) - Number(p.stock_reserved ?? 0)} avail.` : '—'}</Td>
                <Td>
                  <Select value={p.status} onChange={(e) => setStatus(p, e.target.value)} className="w-40 text-xs">
                    <option value="AVAILABLE">Available</option><option value="SOLD_OUT">Sold out</option><option value="UNAVAILABLE">Temporarily unavailable</option><option value="HIDDEN">Hidden</option>
                  </Select>
                </Td>
                <Td className="text-right whitespace-nowrap">
                  <Button size="sm" variant="outline" onClick={() => setEdit({ ...blank(), ...p, translations: { ...blank().translations, ...p.translations } })}>Edit</Button>
                  <Button size="sm" variant="ghost" className="text-rose-600" onClick={async () => (await confirmDialog('Delete product?', `${p.translations?.th?.name} will be removed from the menu. Past orders keep their history.`, true)) && crud.remove(p.id)}><Trash2 className="h-4 w-4" /></Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {edit && <ProductEditor value={edit} onClose={() => setEdit(null)} onSaved={() => setEdit(null)} save={crud.save} />}
    </div>
  );
}

function ProductEditor({ value, onClose, onSaved, save }: { value: any; onClose: () => void; onSaved: () => void; save: (id: string | null, b: any) => Promise<unknown> }) {
  const [p, setP] = useState<any>(value);
  const [busy, setBusy] = useState(false);
  const cats = useList('categories', '/menu/categories');
  const stations = useList('stations', '/kitchen/stations');
  const printers = useList('printers', '/print/printers');
  const schedules = useList('schedules', '/menu/schedules');
  const groups = useList('modifier-groups', '/menu/modifier-groups');
  const products = useList('products', '/menu/products');
  const set = (k: string, v: any) => setP((x: any) => ({ ...x, [k]: v }));
  const tr3 = (field: string) => Object.fromEntries(['th', 'en', 'zh'].map((l) => [l, p.translations?.[l]?.[field] ?? '']));
  const setTr3 = (field: string, v: Record<string, string>) => setP((x: any) => ({ ...x, translations: Object.fromEntries(['th', 'en', 'zh'].map((l) => [l, { ...(x.translations?.[l] ?? {}), [field]: v[l] ?? '' }])) }));
  const moveGroup = (i: number, d: number) => {
    const a = [...p.modifier_group_ids];
    const j = i + d;
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    set('modifier_group_ids', a);
  };
  const submit = async () => {
    setBusy(true);
    try {
      const body = {
        sku: p.sku, barcode: p.barcode || null, category_id: p.category_id, image_url: p.image_url || null, price: Number(p.price), cost: Number(p.cost ?? 0),
        vat_rate: p.vat_rate === '' || p.vat_rate == null ? null : Number(p.vat_rate), station_id: p.station_id || null, printer_id: p.printer_id || null, schedule_id: p.schedule_id || null,
        status: p.status, is_recommended: !!p.is_recommended, track_stock: !!p.track_stock, sort: Number(p.sort ?? 0),
        translations: p.translations, modifier_group_ids: p.modifier_group_ids, recommendations: p.recommendations.map((r: any) => ({ ...r, special_price: r.special_price === '' || r.special_price == null ? null : Number(r.special_price) })),
      };
      await save(p.id ?? null, body);
      onSaved();
    } catch {
      /* toast shown */
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} size="xl" title={p.id ? `Edit product — ${p.sku}` : 'New product'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={submit} disabled={!p.sku || !p.category_id || !p.translations?.th?.name}>Save</Button></>}>
      <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="SKU *"><Input value={p.sku} onChange={(e) => set('sku', e.target.value.toUpperCase())} /></Field>
          <Field label="Barcode"><Input value={p.barcode ?? ''} onChange={(e) => set('barcode', e.target.value)} /></Field>
          <Field label="Category *">
            <Select value={p.category_id} onChange={(e) => set('category_id', e.target.value)}>
              <option value="">—</option>
              {cats.data?.filter((c: any) => c.kind === 'STANDARD').map((c: any) => <option key={c.id} value={c.id}>{tr(c.name, 'th')}</option>)}
            </Select>
          </Field>
          <Field label="Status">
            <Select value={p.status} onChange={(e) => set('status', e.target.value)}>
              <option value="AVAILABLE">Available</option><option value="SOLD_OUT">Sold out</option><option value="UNAVAILABLE">Temporarily unavailable</option><option value="HIDDEN">Hidden</option>
            </Select>
          </Field>
        </div>
        <I18nInput label="Name *" value={tr3('name')} onChange={(v) => setTr3('name', v)} required />
        <I18nInput label="Short description" value={tr3('short_description')} onChange={(v) => setTr3('short_description', v)} />
        <I18nInput label="Description" value={tr3('description')} onChange={(v) => setTr3('description', v)} multiline />
        <MediaInput label="Image (URL or upload)" value={p.image_url} onChange={(v) => set('image_url', v)} />
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="Price (฿) *"><NumberInput value={p.price} onChange={(v) => set('price', v ?? 0)} step="0.01" /></Field>
          <Field label="Cost (฿)"><NumberInput value={p.cost} onChange={(v) => set('cost', v ?? 0)} step="0.01" /></Field>
          <Field label="VAT % (blank = system)"><NumberInput value={p.vat_rate} onChange={(v) => set('vat_rate', v)} step="0.01" /></Field>
          <Field label="Sort order"><NumberInput value={p.sort} onChange={(v) => set('sort', v ?? 0)} /></Field>
          <Field label="Kitchen station" hint="Blank = category's station">
            <Select value={p.station_id ?? ''} onChange={(e) => set('station_id', e.target.value || null)}>
              <option value="">(from category)</option>
              {stations.data?.map((s: any) => <option key={s.id} value={s.id}>{tr(s.name, 'th')}</option>)}
            </Select>
          </Field>
          <Field label="Printer override">
            <Select value={p.printer_id ?? ''} onChange={(e) => set('printer_id', e.target.value || null)}>
              <option value="">(station routing)</option>
              {printers.data?.filter((x: any) => x.type !== 'RECEIPT').map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </Field>
          <Field label="Selling schedule">
            <Select value={p.schedule_id ?? ''} onChange={(e) => set('schedule_id', e.target.value || null)}>
              <option value="">All day</option>
              {schedules.data?.map((s: any) => <option key={s.id} value={s.id}>{s.name} ({s.start_time}–{s.end_time})</option>)}
            </Select>
          </Field>
          <div className="flex flex-col justify-end gap-2 pb-1">
            <Toggle checked={!!p.is_recommended} onChange={(v) => set('is_recommended', v)} label="Recommended" />
            <Toggle checked={!!p.track_stock} onChange={(v) => set('track_stock', v)} label="Track stock" />
          </div>
        </div>

        <div>
          <div className="mb-2 text-sm font-semibold">Modifier groups (customization)</div>
          <div className="space-y-1.5">
            {p.modifier_group_ids.map((gid: string, i: number) => {
              const g = groups.data?.find((x: any) => x.id === gid);
              return (
                <div key={gid} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  <span className="flex-1">{tr(g?.name, 'th')} <span className="text-xs text-slate-500">{g?.selection} · {g?.required ? 'required' : 'optional'}</span></span>
                  <button onClick={() => moveGroup(i, -1)}><ArrowUp className="h-4 w-4" /></button>
                  <button onClick={() => moveGroup(i, 1)}><ArrowDown className="h-4 w-4" /></button>
                  <button onClick={() => set('modifier_group_ids', p.modifier_group_ids.filter((x: string) => x !== gid))} className="text-rose-600"><Trash2 className="h-4 w-4" /></button>
                </div>
              );
            })}
          </div>
          <Select className="mt-2" value="" onChange={(e) => e.target.value && set('modifier_group_ids', [...p.modifier_group_ids, e.target.value])}>
            <option value="">+ Add modifier group…</option>
            {groups.data?.filter((g: any) => !p.modifier_group_ids.includes(g.id)).map((g: any) => <option key={g.id} value={g.id}>{tr(g.name, 'th')} / {tr(g.name, 'en')}</option>)}
          </Select>
        </div>

        <div>
          <div className="mb-2 text-sm font-semibold">Upsell recommendations</div>
          {p.recommendations.map((r: any, i: number) => (
            <div key={i} className="mb-2 rounded-xl border p-3">
              <div className="grid gap-3 md:grid-cols-[1fr_160px_auto]">
                <Select value={r.recommended_product_id} onChange={(e) => set('recommendations', p.recommendations.map((x: any, j: number) => (j === i ? { ...x, recommended_product_id: e.target.value } : x)))}>
                  {products.data?.filter((x: any) => x.id !== p.id).map((x: any) => <option key={x.id} value={x.id}>{x.translations?.th?.name ?? x.sku}</option>)}
                </Select>
                <NumberInput placeholder="Special price" value={r.special_price} onChange={(v) => set('recommendations', p.recommendations.map((x: any, j: number) => (j === i ? { ...x, special_price: v } : x)))} />
                <Button variant="ghost" className="text-rose-600" onClick={() => set('recommendations', p.recommendations.filter((_: any, j: number) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
              </div>
              <div className="mt-2"><I18nInput value={r.message} onChange={(v) => set('recommendations', p.recommendations.map((x: any, j: number) => (j === i ? { ...x, message: v } : x)))} /></div>
            </div>
          ))}
          <Button size="sm" variant="outline" icon={<Plus className="h-4 w-4" />} disabled={!products.data?.length} onClick={() => set('recommendations', [...p.recommendations, { recommended_product_id: products.data!.find((x: any) => x.id !== p.id)?.id, message: { th: 'เพิ่มไหม?', en: 'Add this?', zh: '加一份吗？' }, special_price: null }])}>
            Add recommendation
          </Button>
        </div>
      </div>
    </Modal>
  );
}
