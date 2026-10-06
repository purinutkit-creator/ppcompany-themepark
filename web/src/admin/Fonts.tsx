import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Upload } from 'lucide-react';
import { staffApi, errorMessage } from '../lib/api';
import { fontForLang } from '@kiosk/shared';
import { loadFont } from '../lib/theme';
import { useT } from '../lib/lang';
import { Badge, Button, Card, Field, Input, Loading, Modal, NumberInput, PageHeader, Select, Table, Td, confirmDialog, toast } from '../components/ui';
import { useList, useSaveSetting, useSettings } from './hooks';
import { PrintPreview } from './PrintPreview';
import { sampleJob } from './samples';
import { tt } from '../lib/legacy-i18n';

const SURFACES: [string, { th: string; en: string; zh: string }][] = [
  ['web', { th: 'เว็บไซต์ / สมาชิก', en: 'Website / member portal', zh: '官网 / 会员中心' }],
  ['kiosk', { th: 'ตู้คีออส', en: 'Kiosk', zh: '自助机' }],
  ['admin', { th: 'หลังบ้าน', en: 'Admin', zh: '后台' }],
  ['counter', { th: 'เคาน์เตอร์ขายบัตร', en: 'Box office', zh: '售票处' }],
  ['pos', { th: 'POS', en: 'POS', zh: 'POS' }],
  ['cashier', { th: 'แคชเชียร์', en: 'Cashier', zh: '收银' }],
  ['gate', { th: 'จอประตู / ควบคุมประตู', en: 'Gate display & console', zh: '闸门显示/操作台' }],
  ['ride', { th: 'เครื่องเล่น', en: 'Ride screens', zh: '游乐设施屏' }],
  ['kds', { th: 'จอครัว', en: 'KDS', zh: '厨房显示' }],
  ['queue', { th: 'จอเรียกคิว', en: 'Queue display', zh: '叫号屏' }],
  ['receipt', { th: 'ใบเสร็จ', en: 'Receipt', zh: '收据' }],
  ['ticket', { th: 'ตั๋ว', en: 'Ticket', zh: '门票' }],
  ['wristband', { th: 'ริสแบนด์', en: 'Wristband', zh: '腕带' }],
  ['kitchenTicket', { th: 'ใบสั่งครัว', en: 'Kitchen ticket', zh: '厨房单' }],
];
const LANGS = [['th', 'ไทย'], ['en', 'English'], ['zh', '中文']] as const;
const SUGGESTED = ['Prompt', 'Kanit', 'Sarabun', 'IBM Plex Sans Thai', 'Noto Sans Thai', 'Noto Sans SC', 'Mitr', 'Bai Jamjuree', 'Chakra Petch', 'Athiti', 'Inter', 'Roboto', 'Poppins', 'Noto Serif Thai', 'ZCOOL XiaoWei'];
const SAMPLE = 'สวัสดีครับ ยินดีต้อนรับ · Welcome · 欢迎光临 #48271 ฿459.00';

export default function Fonts() {
  const t = useT();
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
    for (const v of Object.values(cfg) as any[]) {
      loadFont(v.family, fonts.data as any);
      for (const f of Object.values(v.byLang ?? {}) as string[]) if (f) loadFont(f, fonts.data as any);
    }
  }, [cfg, fonts.data]);
  if (!cfg || fonts.isLoading) return <Loading />;
  const set = (surface: string, k: string, v: any) => setCfg({ ...cfg, [surface]: { ...(cfg[surface] ?? { family: 'Prompt', weight: 400, size: 16, letterSpacing: 0, lineHeight: 1.4 }), [k]: v } });
  const setLang = (surface: string, lang: string, fam: string) => set(surface, 'byLang', { ...(cfg[surface]?.byLang ?? {}), [lang]: fam || undefined });
  const famOf = (k: string, lang: string) => cfg[k]?.byLang?.[lang] || cfg[k]?.family;
  const families = [...new Set([...(fonts.data ?? []).map((f: any) => f.family), ...Object.values(cfg).flatMap((x: any) => [x.family, ...Object.values(x.byLang ?? {})]).filter(Boolean)])] as string[];

  return (
    <div>
      <PageHeader title={t.x({ th: 'ฟอนต์', en: 'Fonts', zh: '字体' })} sub={t.x({ th: 'Google Fonts หรืออัปโหลด .ttf .otf .woff .woff2 — ตั้งได้ทุกส่วนและแยกตามภาษา แล้วกด "ใช้กับทั้งระบบ" (รวมใบเสร็จ)', en: 'Google Fonts or uploaded .ttf .otf .woff .woff2 — per surface and per language, then Apply to System (receipts included)', zh: 'Google 字体或上传 .ttf .otf .woff .woff2 — 按界面和语言设置，然后应用到全系统（含收据）' })} actions={<Button onClick={() => save.mutate({ key: 'fonts', value: cfg })} loading={save.isPending}>{t.x({ th: 'ใช้กับทั้งระบบ', en: 'Apply to System', zh: '应用到全系统' })}</Button>} />
      <Card title={t.x({ th: 'ฟอนต์แต่ละส่วนและแต่ละภาษา', en: 'Font per surface and language', zh: '各界面及各语言字体' })} padded={false}>
        <Table head={[t.x({ th: 'ส่วน', en: 'Surface', zh: '界面' }), t.x({ th: 'ฟอนต์หลัก', en: 'Default family', zh: '默认字体' }), ...LANGS.map(([, n]) => n), t.x({ th: 'น้ำหนัก', en: 'Weight', zh: '字重' }), t.x({ th: 'ขนาด', en: 'Size', zh: '字号' }), t.x({ th: 'ระยะตัวอักษร', en: 'Letter spacing', zh: '字距' }), t.x({ th: 'ระยะบรรทัด', en: 'Line height', zh: '行高' }), t.x({ th: 'ตัวอย่าง', en: 'Preview', zh: '预览' })]}>
          {SURFACES.map(([k, label]) => {
            const c = cfg[k] ?? { family: 'Prompt', weight: 400, size: 16, letterSpacing: 0, lineHeight: 1.4 };
            return (
              <tr key={k}>
                <Td className="font-medium whitespace-nowrap">{t.x(label)}</Td>
                <Td><Select value={c.family} onChange={(e) => set(k, 'family', e.target.value)} className="w-44">{families.map((f) => <option key={f}>{f}</option>)}</Select></Td>
                {LANGS.map(([lang]) => (
                  <Td key={lang}><Select value={c.byLang?.[lang] ?? ''} onChange={(e) => setLang(k, lang, e.target.value)} className="w-40"><option value="">— {t.x({ th: 'ใช้ฟอนต์หลัก', en: 'use default', zh: '使用默认' })}</option>{families.map((f) => <option key={f}>{f}</option>)}</Select></Td>
                ))}
                <Td><Select value={c.weight} onChange={(e) => set(k, 'weight', Number(e.target.value))} className="w-24">{[300, 400, 500, 600, 700, 800].map((w) => <option key={w} value={w}>{w}</option>)}</Select></Td>
                <Td><div className="w-20"><NumberInput value={c.size} onChange={(v) => set(k, 'size', v ?? 16)} /></div></Td>
                <Td><div className="w-20"><NumberInput value={c.letterSpacing} onChange={(v) => set(k, 'letterSpacing', v ?? 0)} step="0.1" /></div></Td>
                <Td><div className="w-20"><NumberInput value={c.lineHeight} onChange={(v) => set(k, 'lineHeight', v ?? 1.4)} step="0.05" /></div></Td>
                <Td>
                  <div className="max-w-xs space-y-0.5" style={{ fontWeight: c.weight, fontSize: Math.min(c.size, 20), letterSpacing: c.letterSpacing, lineHeight: c.lineHeight }}>
                    <div className="truncate" style={{ fontFamily: `"${famOf(k, 'th')}"` }}>สวัสดี ยินดีต้อนรับ ฿459</div>
                    <div className="truncate" style={{ fontFamily: `"${famOf(k, 'en')}"` }}>Welcome #48271</div>
                    <div className="truncate" style={{ fontFamily: `"${famOf(k, 'zh')}", 'Noto Sans SC'` }}>欢迎光临 游乐园</div>
                  </div>
                </Td>
              </tr>
            );
          })}
        </Table>
      </Card>
      <div className="mt-5 grid gap-5 2xl:grid-cols-[1fr_400px]">
        <Card title={tt('Font library')} actions={<><Button size="sm" variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => setAddGoogle(true)}>{tt('Google Font')}</Button><Button size="sm" variant="outline" icon={<Upload className="h-4 w-4" />} onClick={() => setUpload(true)}>{tt('Upload font')}</Button></>}>
          <div className="space-y-2">
            {fonts.data?.map((f: any) => (
              <div key={f.id} className="flex items-center gap-4 rounded-xl border px-4 py-3">
                <div className="w-44 shrink-0">
                  <div className="font-semibold">{f.family}</div>
                  <div className="mt-0.5 flex gap-1"><Badge className={f.source === 'UPLOAD' ? 'bg-violet-100 text-violet-800' : 'bg-sky-100 text-sky-800'}>{f.source}</Badge>{f.format && <Badge>{f.format}</Badge>}</div>
                </div>
                <div className="flex-1 truncate text-xl" style={{ fontFamily: `"${f.family}"` }}>{SAMPLE}</div>
                <Button size="sm" variant="ghost" className="text-rose-600" onClick={async () => { if (await confirmDialog(tt('Remove font?'), 'Surfaces using it fall back to system fonts.', true)) { await staffApi(`/settings/fonts/${f.id}`, { method: 'DELETE' }); void fonts.refetch(); } }}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
          </div>
        </Card>
        <Card title={tt('Print preview')} actions={<Select value={previewSurface} onChange={(e) => setPreviewSurface(e.target.value as any)} className="w-40"><option value="receipt">{tt('Receipt')}</option><option value="kitchenTicket">{tt('Kitchen ticket')}</option></Select>}>
          <PrintPreview payload={sampleJob(previewSurface === 'receipt' ? 'RECEIPT' : 'KITCHEN_TICKET', s.data?.settings.store, fontForLang(cfg[previewSurface], t.lang) ?? cfg[previewSurface], s.data?.settings.receipt.footer)} paperWidth={80} scale={0.55} />
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
    <Modal open onClose={onClose} title={tt('Add Google Font')} size="md" footer={<><Button variant="ghost" onClick={onClose}>{tt('Cancel')}</Button><Button disabled={!family} onClick={async () => {
      try {
        await staffApi('/settings/fonts/google', { body: { family, weights: weights.split(',').map((w) => Number(w.trim())).filter(Boolean) } });
        toast.success(tt('Font added'));
        onDone();
        onClose();
      } catch (e) { toast.error(errorMessage(e)); }
    }}>{tt('Add')}</Button></>}>
      <div className="space-y-3">
        <Field label={tt('Family name (exactly as on fonts.google.com)')}><Input value={family} onChange={(e) => setFamily(e.target.value)} placeholder="e.g. Bai Jamjuree" /></Field>
        <div className="flex flex-wrap gap-1.5">{SUGGESTED.map((f) => <button key={f} onClick={() => setFamily(f)} className="rounded-full bg-slate-100 px-3 py-1 text-xs hover:bg-slate-200">{f}</button>)}</div>
        <Field label={tt('Weights')}><Input value={weights} onChange={(e) => setWeights(e.target.value)} /></Field>
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
    <Modal open onClose={onClose} title={tt('Upload font')} size="md" footer={<><Button variant="ghost" onClick={onClose}>{tt('Cancel')}</Button><Button loading={busy} disabled={!file || !family} onClick={async () => {
      setBusy(true);
      try {
        const fd = new FormData();
        fd.append('family', family);
        fd.append('weight', String(weight));
        fd.append('file', file!);
        await staffApi('/settings/fonts/upload', { method: 'POST', body: fd, timeoutMs: 120000 });
        toast.success(tt('Font uploaded'));
        onDone();
        onClose();
      } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
    }}>{tt('Upload')}</Button></>}>
      <div className="space-y-3">
        <input ref={ref} type="file" accept=".ttf,.otf,.woff,.woff2" hidden onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !family) setFamily(f.name.replace(/\.[^.]+$/, '').replace(/[-_](Regular|Bold|Medium|Light)$/i, '')); }} />
        <Button variant="outline" icon={<Upload className="h-4 w-4" />} onClick={() => ref.current?.click()}>{file ? file.name : 'Choose .ttf / .otf / .woff / .woff2'}</Button>
        <Field label={tt('Family name')}><Input value={family} onChange={(e) => setFamily(e.target.value)} /></Field>
        <Field label={tt('Weight')}><Select value={weight} onChange={(e) => setWeight(Number(e.target.value))}>{[300, 400, 500, 600, 700, 800].map((w) => <option key={w}>{w}</option>)}</Select></Field>
        <p className="text-xs text-slate-500">{tt('Make sure the font includes Thai and/or Chinese glyphs if you use it for those languages. Print Agents download uploaded fonts automatically for receipt rendering.')}</p>
      </div>
    </Modal>
  );
}
