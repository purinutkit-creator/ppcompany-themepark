import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Upload } from 'lucide-react';
import { staffApi, errorMessage } from '../lib/api';
import { loadFont } from '../lib/theme';
import { Badge, Button, Card, Field, Input, Loading, Modal, NumberInput, PageHeader, Select, Table, Td, confirmDialog, toast } from '../components/ui';
import { useList, useSaveSetting, useSettings } from './hooks';
import { PrintPreview } from './PrintPreview';
import { sampleJob } from './samples';

const SURFACES: [string, string][] = [['kiosk', 'Kiosk'], ['admin', 'Admin'], ['cashier', 'Cashier'], ['kds', 'KDS'], ['queue', 'Queue Display'], ['receipt', 'Receipt'], ['kitchenTicket', 'Kitchen Ticket']];
const SUGGESTED = ['Prompt', 'Kanit', 'Sarabun', 'IBM Plex Sans Thai', 'Noto Sans Thai', 'Noto Sans SC', 'Mitr', 'Bai Jamjuree', 'Chakra Petch', 'Athiti', 'Inter', 'Roboto', 'Poppins', 'Noto Serif Thai', 'ZCOOL XiaoWei'];
const SAMPLE = 'สวัสดีครับ ยินดีต้อนรับ · Welcome · 欢迎光临 #48271 ฿459.00';

export default function Fonts() {
  const fonts = useList('fonts', '/settings/fonts');
  const s = useSettings();
  const save = useSaveSetting();
  const [cfg, setCfg] = useState<any>(null);
  const [addGoogle, setAddGoogle] = useState(false);
  const [upload, setUpload] = useState(false);
  const [previewSurface, setPreviewSurface] = useState<'receipt' | 'kitchenTicket'>('receipt');
  useEffect(() => setCfg(s.data?.settings.fonts), [s.data]);
  useEffect(() => {
    if (!cfg || !fonts.data) return;
    for (const v of Object.values(cfg) as any[]) loadFont(v.family, fonts.data as any);
  }, [cfg, fonts.data]);
  if (!cfg || fonts.isLoading) return <Loading />;
  const set = (surface: string, k: string, v: any) => setCfg({ ...cfg, [surface]: { ...cfg[surface], [k]: v } });
  const families = [...new Set([...(fonts.data ?? []).map((f: any) => f.family), ...Object.values(cfg).map((x: any) => x.family)])];

  return (
    <div>
      <PageHeader title="Fonts" sub="Google Fonts or uploaded .ttf .otf .woff .woff2 — set per surface, preview, then Apply to System" actions={<Button onClick={() => save.mutate({ key: 'fonts', value: cfg })} loading={save.isPending}>Apply to System</Button>} />
      <Card title="Font per surface" padded={false}>
        <Table head={['Surface', 'Font family', 'Weight', 'Size', 'Letter spacing', 'Line height', 'Preview']}>
          {SURFACES.map(([k, label]) => (
            <tr key={k}>
              <Td className="font-medium whitespace-nowrap">{label}</Td>
              <Td><Select value={cfg[k].family} onChange={(e) => set(k, 'family', e.target.value)} className="w-56">{families.map((f) => <option key={f}>{f}</option>)}</Select></Td>
              <Td><Select value={cfg[k].weight} onChange={(e) => set(k, 'weight', Number(e.target.value))} className="w-28">{[300, 400, 500, 600, 700, 800].map((w) => <option key={w} value={w}>{w}</option>)}</Select></Td>
              <Td><div className="w-20"><NumberInput value={cfg[k].size} onChange={(v) => set(k, 'size', v ?? 16)} /></div></Td>
              <Td><div className="w-20"><NumberInput value={cfg[k].letterSpacing} onChange={(v) => set(k, 'letterSpacing', v ?? 0)} step="0.1" /></div></Td>
              <Td><div className="w-20"><NumberInput value={cfg[k].lineHeight} onChange={(v) => set(k, 'lineHeight', v ?? 1.4)} step="0.05" /></div></Td>
              <Td><div className="max-w-xs truncate" style={{ fontFamily: `"${cfg[k].family}", 'Noto Sans SC'`, fontWeight: cfg[k].weight, fontSize: Math.min(cfg[k].size, 26), letterSpacing: cfg[k].letterSpacing, lineHeight: cfg[k].lineHeight }}>{SAMPLE}</div></Td>
            </tr>
          ))}
        </Table>
      </Card>
      <div className="mt-5 grid gap-5 2xl:grid-cols-[1fr_400px]">
        <Card title="Font library" actions={<><Button size="sm" variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => setAddGoogle(true)}>Google Font</Button><Button size="sm" variant="outline" icon={<Upload className="h-4 w-4" />} onClick={() => setUpload(true)}>Upload font</Button></>}>
          <div className="space-y-2">
            {fonts.data?.map((f: any) => (
              <div key={f.id} className="flex items-center gap-4 rounded-xl border px-4 py-3">
                <div className="w-44 shrink-0">
                  <div className="font-semibold">{f.family}</div>
                  <div className="mt-0.5 flex gap-1"><Badge className={f.source === 'UPLOAD' ? 'bg-violet-100 text-violet-800' : 'bg-sky-100 text-sky-800'}>{f.source}</Badge>{f.format && <Badge>{f.format}</Badge>}</div>
                </div>
                <div className="flex-1 truncate text-xl" style={{ fontFamily: `"${f.family}"` }}>{SAMPLE}</div>
                <Button size="sm" variant="ghost" className="text-rose-600" onClick={async () => { if (await confirmDialog('Remove font?', 'Surfaces using it fall back to system fonts.', true)) { await staffApi(`/settings/fonts/${f.id}`, { method: 'DELETE' }); void fonts.refetch(); } }}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Print preview" actions={<Select value={previewSurface} onChange={(e) => setPreviewSurface(e.target.value as any)} className="w-40"><option value="receipt">Receipt</option><option value="kitchenTicket">Kitchen ticket</option></Select>}>
          <PrintPreview payload={sampleJob(previewSurface === 'receipt' ? 'RECEIPT' : 'KITCHEN_TICKET', s.data?.settings.store, cfg[previewSurface], s.data?.settings.receipt.footer)} paperWidth={80} scale={0.55} />
        </Card>
      </div>
      {addGoogle && <GoogleFontDialog onClose={() => setAddGoogle(false)} onDone={() => fonts.refetch()} />}
      {upload && <UploadFontDialog onClose={() => setUpload(false)} onDone={() => fonts.refetch()} />}
    </div>
  );
}

function GoogleFontDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [family, setFamily] = useState('');
  const [weights, setWeights] = useState('400,500,700');
  useEffect(() => {
    if (family.length > 2) loadFont(family, [], [400]);
  }, [family]);
  return (
    <Modal open onClose={onClose} title="Add Google Font" size="md" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!family} onClick={async () => {
      try {
        await staffApi('/settings/fonts/google', { body: { family, weights: weights.split(',').map((w) => Number(w.trim())).filter(Boolean) } });
        toast.success('Font added');
        onDone();
        onClose();
      } catch (e) { toast.error(errorMessage(e)); }
    }}>Add</Button></>}>
      <div className="space-y-3">
        <Field label="Family name (exactly as on fonts.google.com)"><Input value={family} onChange={(e) => setFamily(e.target.value)} placeholder="e.g. Bai Jamjuree" /></Field>
        <div className="flex flex-wrap gap-1.5">{SUGGESTED.map((f) => <button key={f} onClick={() => setFamily(f)} className="rounded-full bg-slate-100 px-3 py-1 text-xs hover:bg-slate-200">{f}</button>)}</div>
        <Field label="Weights"><Input value={weights} onChange={(e) => setWeights(e.target.value)} /></Field>
        {family && <div className="rounded-xl bg-slate-50 p-4 text-2xl" style={{ fontFamily: `"${family}"` }}>{SAMPLE}</div>}
      </div>
    </Modal>
  );
}

function UploadFontDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [family, setFamily] = useState('');
  const [weight, setWeight] = useState(400);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title="Upload font" size="md" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!file || !family} onClick={async () => {
      setBusy(true);
      try {
        const fd = new FormData();
        fd.append('family', family);
        fd.append('weight', String(weight));
        fd.append('file', file!);
        await staffApi('/settings/fonts/upload', { method: 'POST', body: fd, timeoutMs: 120000 });
        toast.success('Font uploaded');
        onDone();
        onClose();
      } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
    }}>Upload</Button></>}>
      <div className="space-y-3">
        <input ref={ref} type="file" accept=".ttf,.otf,.woff,.woff2" hidden onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !family) setFamily(f.name.replace(/\.[^.]+$/, '').replace(/[-_](Regular|Bold|Medium|Light)$/i, '')); }} />
        <Button variant="outline" icon={<Upload className="h-4 w-4" />} onClick={() => ref.current?.click()}>{file ? file.name : 'Choose .ttf / .otf / .woff / .woff2'}</Button>
        <Field label="Family name"><Input value={family} onChange={(e) => setFamily(e.target.value)} /></Field>
        <Field label="Weight"><Select value={weight} onChange={(e) => setWeight(Number(e.target.value))}>{[300, 400, 500, 600, 700, 800].map((w) => <option key={w}>{w}</option>)}</Select></Field>
        <p className="text-xs text-slate-500">Make sure the font includes Thai and/or Chinese glyphs if you use it for those languages. Print Agents download uploaded fonts automatically for receipt rendering.</p>
      </div>
    </Modal>
  );
}
