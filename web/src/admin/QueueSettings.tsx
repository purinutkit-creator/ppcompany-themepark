import { useEffect, useState } from 'react';
import { ExternalLink, Volume2 } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { speak, spellNumber, chime } from '../lib/sound';
import { Button, Card, Checkbox, Field, Input, Loading, MediaInput, NumberInput, PageHeader, Select, Toggle } from '../components/ui';
import { useSettings, useSaveSetting } from './hooks';

export default function QueueSettings() {
  const s = useSettings();
  const save = useSaveSetting();
  const { branch } = useAuth();
  const [q, setQ] = useState<any>(null);
  useEffect(() => setQ(s.data?.settings.queue), [s.data]);
  if (!q) return <Loading />;
  const set = (k: string, v: any) => setQ({ ...q, [k]: v });
  const langs = ['th', 'en', 'zh'];
  const toggleArr = (k: string, l: string) => set(k, q[k].includes(l) ? q[k].filter((x: string) => x !== l) : [...q[k], l]);
  const test = async () => {
    chime('ding');
    for (let r = 0; r < q.repeat; r++) for (const l of q.voiceLanguages) await speak(q.templates[l].replace('{number}', spellNumber('48271', l)), l);
  };
  return (
    <div>
      <PageHeader title="Queue display" sub="TV / monitor showing PREPARING and READY numbers with voice announcements" actions={<><a href={`/queue/${branch?.code}`} target="_blank" rel="noreferrer"><Button variant="outline" icon={<ExternalLink className="h-4 w-4" />}>Open display</Button></a><Button onClick={() => save.mutate({ key: 'queue', value: q })} loading={save.isPending}>Save & apply</Button></>} />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Layout">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Numbers shown — Preparing"><NumberInput value={q.preparingCount} onChange={(v) => set('preparingCount', v ?? 10)} min={1} max={50} /></Field>
            <Field label="Numbers shown — Ready"><NumberInput value={q.readyCount} onChange={(v) => set('readyCount', v ?? 6)} min={1} max={50} /></Field>
            <Field label="Layout"><Select value={q.layout} onChange={(e) => set('layout', e.target.value)}><option value="SPLIT">Side by side</option><option value="STACKED">Stacked</option></Select></Field>
            <Field label="Ready animation"><Select value={q.animation} onChange={(e) => set('animation', e.target.value)}><option value="PULSE">Pulse</option><option value="NONE">None</option></Select></Field>
            <Field label="Number font size (px)"><NumberInput value={q.numberSize} onChange={(v) => set('numberSize', v ?? 88)} /></Field>
            <Field label="Header languages"><div className="flex gap-3">{langs.map((l) => <Checkbox key={l} checked={q.showLanguages.includes(l)} onChange={() => toggleArr('showLanguages', l)} label={l.toUpperCase()} />)}</div></Field>
            <Field label="Background color"><Input type="color" className="h-10 p-1" value={q.colors.background} onChange={(e) => set('colors', { ...q.colors, background: e.target.value })} /></Field>
            <Field label="Text color"><Input type="color" className="h-10 p-1" value={q.colors.text} onChange={(e) => set('colors', { ...q.colors, text: e.target.value })} /></Field>
            <Field label="Preparing color"><Input type="color" className="h-10 p-1" value={q.colors.preparing} onChange={(e) => set('colors', { ...q.colors, preparing: e.target.value })} /></Field>
            <Field label="Ready color"><Input type="color" className="h-10 p-1" value={q.colors.ready} onChange={(e) => set('colors', { ...q.colors, ready: e.target.value })} /></Field>
          </div>
          <div className="mt-4 space-y-4">
            <MediaInput label="Logo" value={q.logoUrl} onChange={(v) => set('logoUrl', v)} />
            <MediaInput label="Background image" value={q.backgroundUrl} onChange={(v) => set('backgroundUrl', v)} />
            <p className="text-xs text-slate-500">Font: Admin → Fonts → “Queue Display”.</p>
          </div>
        </Card>
        <Card title="Sound & voice">
          <div className="space-y-4">
            <div className="flex gap-5">
              <Toggle checked={q.sound} onChange={(v) => set('sound', v)} label="Chime" />
              <Toggle checked={q.voice} onChange={(v) => set('voice', v)} label="Voice announcement" />
            </div>
            <Field label="Announce each number"><Select value={q.repeat} onChange={(e) => set('repeat', Number(e.target.value))}><option value={1}>1 time</option><option value={2}>2 times</option><option value={3}>3 times</option></Select></Field>
            <Field label="Voice languages"><div className="flex gap-3">{langs.map((l) => <Checkbox key={l} checked={q.voiceLanguages.includes(l)} onChange={() => toggleArr('voiceLanguages', l)} label={l.toUpperCase()} />)}</div></Field>
            {langs.map((l) => (
              <Field key={l} label={`Template (${l.toUpperCase()}) — use {number}`}><Input value={q.templates[l]} onChange={(e) => set('templates', { ...q.templates, [l]: e.target.value })} /></Field>
            ))}
            <Button variant="outline" icon={<Volume2 className="h-4 w-4" />} onClick={test}>Test announcement</Button>
            <p className="text-xs text-slate-500">Cashiers / kitchen can press “Call again” on a ready order to repeat the announcement.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
