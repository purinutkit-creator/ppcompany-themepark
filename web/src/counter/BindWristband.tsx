import { useState } from 'react';
import { Link2, Plus } from 'lucide-react';
import { parkApi } from '../lib/api';
import { defineStrings, useT } from '../lib/lang';
import { Button, Input, toast } from '../components/ui';

const BW = defineStrings('bind', {
  scanBand: { th: 'สแกนริสแบนด์ / บัตร', en: 'Scan wristband / card', zh: '扫描腕带 / 卡' },
  bind: { th: 'ผูก', en: 'Bind', zh: '绑定' },
  issueNew: { th: 'ออกริสแบนด์ใหม่ + พิมพ์', en: 'Issue & print wristband', zh: '新发并打印腕带' },
  bound: { th: 'ผูกแล้ว: {code}', en: 'Bound: {code}', zh: '已绑定：{code}' },
  height: { th: 'ส่วนสูง (ซม.)', en: 'Height (cm)', zh: '身高（厘米）' },
});

/** Wristband ↔ Ticket ↔ Member binding at the counter (scan a pre-printed band or issue + print a new one). */
export function BindWristband({ ticketId, onDone, existing }: { ticketId: string; onDone?: () => void; existing?: { code: string }[] | null }) {
  const t = useT(BW);
  const [code, setCode] = useState('');
  const [height, setHeight] = useState('');
  const [busy, setBusy] = useState(false);
  const [bound, setBound] = useState<string[]>(existing?.map((x) => x.code) ?? []);
  const bind = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await parkApi(`/tickets/${ticketId}/bind`, { body: { ...body, heightCm: height ? Number(height) : null } });
      setBound((b) => [...b, r.link.wristband]);
      setCode('');
      toast.success(t('bound', { code: r.link.wristband }));
      onDone?.();
    } catch (e) { toast.error(t.err(e)); } finally { setBusy(false); }
  };
  return (
    <div className="mt-2 space-y-1.5">
      {bound.length > 0 && <div className="flex flex-wrap gap-1">{bound.map((c) => <span key={c} className="rounded-full bg-emerald-100 px-2 py-0.5 font-mono text-[11px] text-emerald-800"><Link2 className="mr-0.5 inline h-3 w-3" />{c}</span>)}</div>}
      <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (code.trim()) void bind({ code: code.trim() }); }}>
        <Input data-scan="1" value={code} onChange={(e) => setCode(e.target.value)} placeholder={t('scanBand')} className="h-9 font-mono text-xs" />
        <Input value={height} onChange={(e) => setHeight(e.target.value.replace(/\D/g, ''))} placeholder={t('height')} className="h-9 w-24 text-xs" />
        <Button size="sm" type="submit" loading={busy} disabled={!code.trim()}>{t('bind')}</Button>
      </form>
      <Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} loading={busy} onClick={() => bind({ generate: true, type: 'TEMP_WRISTBAND', print: true })}>{t('issueNew')}</Button>
    </div>
  );
}
