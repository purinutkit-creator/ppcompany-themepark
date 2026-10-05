import { useEffect, useState } from 'react';
import { staffApi, errorMessage } from '../lib/api';
import { KIOSK_STRINGS, type KioskKey } from '../lib/i18n';
import { Badge, Button, Card, Input, Loading, NumberInput, PageHeader, Toggle, toast } from '../components/ui';
import { useList } from './hooks';

export default function Languages() {
  const list = useList('languages', '/settings/languages');
  const [rows, setRows] = useState<any[]>([]);
  const [filter, setFilter] = useState('');
  useEffect(() => setRows(list.data ?? []), [list.data]);
  if (list.isLoading) return <Loading />;
  const update = (code: string, patch: any) => setRows((r) => r.map((x) => (x.code === code ? { ...x, ...patch } : x)));
  const saveAll = async () => {
    try {
      // Default first so the "only one default" rule never conflicts.
      for (const l of [...rows].sort((a, b) => Number(b.is_default) - Number(a.is_default))) {
        await staffApi(`/settings/languages/${l.code}`, { method: 'PUT', body: { enabled: l.enabled, is_default: l.is_default, sort: l.sort, name: l.name, native_name: l.native_name, flag: l.flag, overrides: l.overrides ?? {} } });
      }
      toast.success('Languages saved', 'Kiosks refresh texts immediately');
      void list.refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const keys = (Object.keys(KIOSK_STRINGS) as KioskKey[]).filter((k) => !filter || k.toLowerCase().includes(filter.toLowerCase()) || Object.values(KIOSK_STRINGS[k]).some((v) => v.toLowerCase().includes(filter.toLowerCase())));
  return (
    <div>
      <PageHeader title="Languages" sub="ไทย · English · 中文 — enable/disable, default language and customer-facing text overrides. Kiosk default language is set per kiosk." actions={<Button onClick={saveAll}>Save</Button>} />
      <div className="grid gap-4 md:grid-cols-3">
        {rows.map((l) => (
          <Card key={l.code} title={<span className="text-lg">{l.flag} {l.native_name} <span className="text-sm text-slate-500">({l.code})</span></span>} actions={l.is_default && <Badge className="bg-primary text-white">Default</Badge>}>
            <div className="space-y-3">
              <Toggle checked={l.enabled} disabled={l.is_default} onChange={(v) => update(l.code, { enabled: v })} label="Enabled on kiosks" />
              <Toggle checked={l.is_default} onChange={(v) => v && setRows((r) => r.map((x) => ({ ...x, is_default: x.code === l.code, enabled: x.code === l.code ? true : x.enabled })))} label="System default" />
              <div className="flex items-center gap-2 text-sm">Order <div className="w-20"><NumberInput value={l.sort} onChange={(v) => update(l.code, { sort: v ?? 0 })} /></div></div>
              <div className="text-xs text-slate-500">{Object.keys(l.overrides ?? {}).length} text overrides</div>
            </div>
          </Card>
        ))}
      </div>
      <Card className="mt-5" title="Customer-facing text" actions={<Input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-60" />} padded={false}>
        <div className="scroll-thin max-h-[60vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500 uppercase"><tr><th className="px-3 py-2 text-left">Key</th>{rows.map((l) => <th key={l.code} className="px-3 py-2 text-left">{l.flag} {l.code}</th>)}</tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k} className="border-b">
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{k}</td>
                  {rows.map((l) => (
                    <td key={l.code} className="px-2 py-1.5">
                      <Input lang={l.code} placeholder={(KIOSK_STRINGS[k] as any)[l.code]} value={l.overrides?.[k] ?? ''} onChange={(e) => {
                        const o = { ...(l.overrides ?? {}) };
                        if (e.target.value) o[k] = e.target.value; else delete o[k];
                        update(l.code, { overrides: o });
                      }} className="text-xs" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="mt-3 text-xs text-slate-500">Product, category, modifier and promotion names are translated in their own editors (3 languages each).</p>
    </div>
  );
}
