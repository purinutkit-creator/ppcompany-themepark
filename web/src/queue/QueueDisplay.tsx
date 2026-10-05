import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Volume2 } from 'lucide-react';
import { EVENTS, tr, type Lang } from '@kiosk/shared';
import { publicApi } from '../lib/api';
import { useOnReconnect, useRealtime, useSocketEvent } from '../lib/socket';
import { chime, speak, spellNumber, unlockAudio } from '../lib/sound';
import { applyFont, applyTheme } from '../lib/theme';
import { KIOSK_STRINGS } from '../lib/i18n';
import { Loading, ErrorBox } from '../components/ui';

export default function QueueDisplay() {
  const { branchCode } = useParams();
  if (!branchCode) return <BranchPicker />;
  return <Board code={branchCode} />;
}

function BranchPicker() {
  const q = useQuery({ queryKey: ['public-branches'], queryFn: () => publicApi<any[]>('/branches') });
  return (
    <div className="flex h-full items-center justify-center bg-slate-900 p-6 text-white">
      <div className="w-full max-w-md">
        <h1 className="mb-4 text-2xl font-bold">Queue display — choose branch</h1>
        {q.data?.map((b) => (
          <Link key={b.id} to={`/queue/${b.code}`} className="mb-2 block rounded-xl bg-white/10 px-5 py-4 text-lg hover:bg-white/20">
            {b.code} — {tr(b.name, 'th')}
          </Link>
        ))}
      </div>
    </div>
  );
}

function Board({ code }: { code: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['queue', code], queryFn: () => publicApi<any>(`/queue/${code}`), refetchInterval: 15000 });
  const { socket, connected } = useRealtime({ display: 'queue', branchCode: code });
  const [audioOn, setAudioOn] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [langIdx, setLangIdx] = useState(0);
  const calls = useRef<{ number: string }[]>([]);
  const speaking = useRef(false);
  const s = q.data?.settings;
  const qs = s?.queue;

  useEffect(() => {
    if (!s) return;
    applyTheme(s.theme);
    applyFont(s.fonts?.queue, q.data.fonts);
  }, [s, q.data]);
  useEffect(() => {
    const id = setInterval(() => setLangIdx((i) => i + 1), 4000);
    return () => clearInterval(id);
  }, []);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['queue', code] });
  const runQueue = async () => {
    if (speaking.current) return;
    speaking.current = true;
    try {
      while (calls.current.length) {
        const { number } = calls.current.shift()!;
        setHighlight(number);
        if (qs?.sound !== false) chime('ding');
        await new Promise((r) => setTimeout(r, 700));
        if (qs?.voice !== false && audioOn) {
          for (let rep = 0; rep < (qs?.repeat ?? 1); rep++) {
            for (const l of (qs?.voiceLanguages ?? ['th', 'en', 'zh']) as Lang[]) {
              const tpl: string = qs?.templates?.[l] ?? '{number}';
              await speak(tpl.replace('{number}', spellNumber(number, l)), l);
            }
          }
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    } finally {
      speaking.current = false;
      setTimeout(() => setHighlight(null), 6000);
    }
  };
  const announce = (number: string) => {
    calls.current.push({ number });
    void runQueue();
  };
  useSocketEvent(socket, EVENTS.QUEUE_UPDATED, refresh);
  useSocketEvent(socket, EVENTS.ORDER_READY, (d) => {
    refresh();
    if (d?.orderNumber) announce(d.orderNumber);
  });
  useSocketEvent(socket, EVENTS.QUEUE_CALL, (d) => d?.orderNumber && announce(d.orderNumber));
  useSocketEvent(socket, EVENTS.SETTINGS_UPDATED, refresh);
  useOnReconnect(socket, refresh);

  if (q.isLoading) return <Loading />;
  if (q.error) return <div className="p-6"><ErrorBox error={q.error} onRetry={() => q.refetch()} /></div>;
  const board = q.data.board;
  const colors = qs?.colors ?? {};
  const langs: Lang[] = qs?.showLanguages?.length ? qs.showLanguages : ['th', 'en', 'zh'];
  const L = langs[langIdx % langs.length];
  const size = qs?.numberSize ?? 88;
  const anim = qs?.animation ?? 'PULSE';

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden"
      style={{ background: qs?.backgroundUrl ? `center/cover url(${qs.backgroundUrl})` : colors.background ?? '#111827', color: colors.text ?? '#fff' }}
      onClick={() => {
        unlockAudio();
        setAudioOn(true);
      }}
    >
      <header className="flex items-center justify-between bg-black/30 px-10 py-5">
        <div className="flex items-center gap-4">
          {(qs?.logoUrl || s.theme?.logoUrl) ? <img src={qs?.logoUrl || s.theme.logoUrl} className="h-14" alt="" /> : <img src="/icon.svg" className="h-14" alt="" />}
          <div className="text-3xl font-bold">{tr(s.store?.name, L)}</div>
        </div>
        <div className="flex items-center gap-4 text-2xl tabular-nums">
          <span className={clsx('h-3 w-3 rounded-full', connected ? 'bg-emerald-400' : 'animate-pulse bg-rose-500')} />
          <Clock />
        </div>
      </header>
      <div className={clsx('grid min-h-0 flex-1 gap-6 p-8', qs?.layout === 'STACKED' ? 'grid-rows-2' : 'grid-cols-[1fr_1.25fr]')}>
        <Column title={langs.map((l) => KIOSK_STRINGS.preparing[l]).join(' · ')} color={colors.preparing ?? '#f59e0b'} numbers={board.preparing.map((x: any) => x.number)} size={size * 0.7} total={board.totals.preparing} />
        <Column title={langs.map((l) => KIOSK_STRINGS.ready[l]).join(' · ')} color={colors.ready ?? '#22c55e'} numbers={board.ready.map((x: any) => x.number)} size={size} highlight={highlight} anim={anim} total={board.totals.ready} />
      </div>
      {highlight && (
        <div className="anim-pop pointer-events-none absolute inset-x-0 bottom-10 mx-auto w-fit rounded-3xl px-16 py-6 text-center shadow-2xl" style={{ background: colors.ready ?? '#22c55e' }}>
          <div className="text-3xl font-semibold">{KIOSK_STRINGS.nowServing[L]}</div>
          <div className="font-black tracking-widest" style={{ fontSize: size * 1.3 }}>{highlight}</div>
        </div>
      )}
      {!audioOn && (
        <div className="absolute right-6 bottom-6 flex animate-pulse items-center gap-2 rounded-full bg-white/15 px-5 py-3 text-lg">
          <Volume2 className="h-6 w-6" /> {KIOSK_STRINGS.enableSound.th} · {KIOSK_STRINGS.enableSound.en}
        </div>
      )}
    </div>
  );
}

function Column({ title, numbers, color, size, highlight, anim, total }: { title: string; numbers: string[]; color: string; size: number; highlight?: string | null; anim?: string; total: number }) {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-3xl bg-black/25">
      <div className="flex items-center justify-between px-8 py-5 text-[2.4rem] font-extrabold" style={{ background: color }}>
        <span>{title}</span>
        {total > numbers.length && <span className="text-2xl opacity-80">+{total - numbers.length}</span>}
      </div>
      <div className="grid flex-1 auto-rows-min content-start gap-5 p-6" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(size * 3.6)}px, 1fr))` }}>
        {numbers.map((n) => (
          <div
            key={n}
            className={clsx('anim-pop rounded-2xl bg-white/10 py-3 text-center font-black tracking-wider tabular-nums', highlight === n && anim !== 'NONE' && 'anim-ready', highlight === n && 'ring-8')}
            style={{ fontSize: size, lineHeight: 1.1, ...(highlight === n ? { boxShadow: `0 0 0 8px ${color}` } : {}) }}
          >
            {n}
          </div>
        ))}
      </div>
    </section>
  );
}

function Clock() {
  const [t, setT] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span>{t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>;
}
