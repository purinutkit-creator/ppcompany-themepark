import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Bell, BellOff, ChefHat, Expand, LogOut, RotateCcw, ShoppingBag, Utensils } from 'lucide-react';
import { EVENTS, tr } from '@kiosk/shared';
import { staffApi, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useOnReconnect, useSocketEvent } from '../lib/socket';
import { chime, unlockAudio } from '../lib/sound';
import { elapsed, minutesSince, time } from '../lib/format';
import { StaffShell, useStaffRt } from '../components/StaffShell';
import { ConnectionDot, Modal, toast } from '../components/ui';
import { OrderDetail } from '../components/OrderDetail';
import { tt } from '../lib/legacy-i18n';
import { useUiLang } from '../lib/lang';

const K = {
  NEW: { th: 'ใหม่', en: 'NEW', zh: '新订单' },
  PREPARING: { th: 'กำลังทำ', en: 'PREPARING', zh: '制作中' },
  READY: { th: 'พร้อมเสิร์ฟ', en: 'READY', zh: '可取餐' },
  START: { th: 'เริ่มทำ', en: 'START', zh: '开始' },
  DONE: { th: 'เสร็จ', en: 'DONE', zh: '完成' },
  RECALL: { th: 'เรียกคืน', en: 'RECALL', zh: '撤回' },
  PICKED: { th: 'รับแล้ว', en: 'PICKED UP', zh: '已取餐' },
  DINE_IN: { th: 'ทานที่ร้าน', en: 'DINE IN', zh: '堂食' },
  TAKE_AWAY: { th: 'กลับบ้าน', en: 'TAKE AWAY', zh: '外带' },
  NO: { th: 'ไม่ใส่', en: 'NO', zh: '不要' },
  EXTRA: { th: 'เพิ่ม', en: 'EXTRA', zh: '加' },
} as const;

export default function KdsApp() {
  return (
    <StaffShell perms={['kitchen.view']} surface="kds">
      <Kds />
    </StaffShell>
  );
}

function Kds() {
  const { stationId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { socket, connected } = useStaffRt();
  const { user, logout, can } = useAuth();
  const [sound, setSound] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [detail, setDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const lang = useUiLang((s) => s.lang);
  const setLang = useUiLang((s) => s.setLang);
  const kl = (key: keyof typeof K) => K[key][lang];
  const stations = useQuery({ queryKey: ['stations'], queryFn: () => staffApi<any[]>('/kitchen/stations') });
  const q = useQuery({ queryKey: ['kds', stationId ?? 'all'], queryFn: () => staffApi<any>(`/kitchen/orders${stationId ? `?stationId=${stationId}` : ''}`), refetchInterval: 20000 });
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['kds'] });
  useSocketEvent(socket, EVENTS.KITCHEN_NEW, () => {
    if (sound) chime('ding');
    refresh();
  });
  useSocketEvent(socket, [EVENTS.KITCHEN_PREPARING, EVENTS.KITCHEN_UPDATED, EVENTS.ORDER_READY, EVENTS.QUEUE_UPDATED, EVENTS.ORDER_CANCELLED], refresh);
  useSocketEvent(socket, EVENTS.PRINTER_ERROR, (d) => toast.error(d.message, d.orderNumber ? `${tt('Order #')}${d.orderNumber}` : undefined));
  useOnReconnect(socket, refresh);

  const orders: any[] = q.data?.orders ?? [];
  const warn = q.data?.warnMinutes ?? 8;
  const late = q.data?.lateMinutes ?? 15;
  const cols = useMemo(
    () => ({
      NEW: orders.filter((o) => o.status === 'NEW'),
      PREPARING: orders.filter((o) => o.status === 'PREPARING'),
      READY: orders.filter((o) => o.status === 'READY'),
    }),
    [orders],
  );
  const act = async (id: string, action: 'start' | 'done' | 'recall' | 'pickup') => {
    setBusy(id + action);
    try {
      await staffApi(`/kitchen/orders/${id}/${action}`, { method: 'POST' });
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const stationName = stations.data?.find((s) => s.id === stationId);

  return (
    <div className="flex h-full flex-col bg-slate-950 text-white" onPointerDown={unlockAudio}>
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-white/10 px-4">
        <ChefHat className="h-7 w-7 text-amber-400" />
        <div className="text-xl font-bold">KDS {stationName ? `· ${tr(stationName.name, lang)}` : `· ${tt('All stations')}`}</div>
        <div className="ml-4 flex gap-1 overflow-x-auto">
          <StationBtn active={!stationId} onClick={() => nav('/kds')} label={tt('All')} />
          {stations.data?.filter((s) => s.is_active).map((s) => (
            <StationBtn key={s.id} active={stationId === s.id} onClick={() => nav(`/kds/${s.id}`)} label={tr(s.name, lang)} color={s.color} />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex rounded-lg bg-white/10 p-0.5 text-xs">
            {(['th', 'en', 'zh'] as const).map((l) => (
              <button key={l} onClick={() => setLang(l)} className={clsx('rounded-md px-2 py-1', lang === l && 'bg-white text-slate-900')}>{l.toUpperCase()}</button>
            ))}
          </div>
          <span className="text-2xl font-bold tabular-nums">{new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
          <ConnectionDot connected={connected} />
          <button onClick={() => setSound((s) => !s)} className="rounded-lg bg-white/10 p-2">{sound ? <Bell className="h-5 w-5" /> : <BellOff className="h-5 w-5" />}</button>
          <button onClick={() => document.documentElement.requestFullscreen?.()} className="rounded-lg bg-white/10 p-2"><Expand className="h-5 w-5" /></button>
          <span className="text-sm text-white/60">{user?.name}</span>
          <button onClick={() => logout()} className="rounded-lg bg-white/10 p-2"><LogOut className="h-5 w-5" /></button>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-3 gap-3 p-3">
        {(['NEW', 'PREPARING', 'READY'] as const).map((col) => (
          <section key={col} className="flex min-h-0 flex-col rounded-2xl bg-white/5">
            <div className={clsx('flex items-center justify-between rounded-t-2xl px-4 py-2 text-lg font-bold', col === 'NEW' ? 'bg-sky-600' : col === 'PREPARING' ? 'bg-amber-600' : 'bg-emerald-600')}>
              <span>{kl(col)}</span>
              <span className="rounded-full bg-black/25 px-3">{cols[col].length}</span>
            </div>
            <div className="scroll-thin flex-1 space-y-3 overflow-y-auto p-3">
              {cols[col].length === 0 && <div className="py-10 text-center text-white/30">—</div>}
              {cols[col].map((o) => {
                const mins = minutesSince(o.paid_at ?? o.order_created_at);
                const tone = col === 'READY' ? 'border-emerald-500' : mins >= late ? 'border-rose-500 bg-rose-950/40' : mins >= warn ? 'border-amber-400' : 'border-white/15';
                return (
                  <article key={o.id} className={clsx('anim-pop rounded-2xl border-2 bg-slate-900 p-4', tone)}>
                    <div className="flex items-start justify-between">
                      <button onClick={() => setDetail(o.order_id)} className="text-left">
                        <div className="text-4xl font-black tracking-wider">#{o.order_number}</div>
                        <div className="mt-1 flex items-center gap-2 text-sm text-white/70">
                          {o.order_type === 'DINE_IN' ? <Utensils className="h-4 w-4" /> : <ShoppingBag className="h-4 w-4" />}
                          <b className={o.order_type === 'TAKE_AWAY' ? 'text-amber-300' : ''}>{kl(o.order_type === 'DINE_IN' ? 'DINE_IN' : 'TAKE_AWAY')}</b>
                          · {o.kiosk_code ?? 'POS'} · {time(o.paid_at)}
                        </div>
                      </button>
                      <div className="text-right">
                        <div className={clsx('text-2xl font-bold tabular-nums', mins >= late ? 'text-rose-400' : mins >= warn ? 'text-amber-300' : 'text-white')}>{elapsed(o.paid_at ?? o.order_created_at, now)}</div>
                        {!stationId && <span className="rounded px-2 text-xs" style={{ background: o.station_color }}>{tr(o.station_name, lang)}</span>}
                      </div>
                    </div>
                    <ul className="mt-3 space-y-2">
                      {o.items.map((i: any) => (
                        <li key={i.id}>
                          <div className="text-xl font-bold">
                            <span className="mr-2 inline-block min-w-10 rounded bg-white px-2 text-center text-slate-900">{i.qty}</span>
                            {tr(i.name, lang)}
                          </div>
                          {i.modifiers.map((m: any, k: number) => (
                            <div key={k} className={clsx('ml-12 text-base', m.kind === 'REMOVE' ? 'font-semibold text-rose-300' : m.kind === 'EXTRA' ? 'font-semibold text-amber-300' : 'text-white/75')}>
                              {m.kind === 'REMOVE' ? `✕ ${kl('NO')} ` : m.kind === 'EXTRA' ? `＋ ${kl('EXTRA')} ` : '• '}
                              {tr(m.name, lang)}
                            </div>
                          ))}
                          {i.special_request && <div className="mt-1 ml-12 rounded bg-amber-400 px-2 py-0.5 text-sm font-bold text-slate-900">⚠ {i.special_request}</div>}
                        </li>
                      ))}
                    </ul>
                    {o.note && <div className="mt-2 rounded bg-white/10 px-2 py-1 text-sm">📝 {o.note}</div>}
                    {can('kitchen.manage') && (
                      <div className="mt-4 flex gap-2">
                        {col === 'NEW' && <KdsBtn tone="bg-sky-500" busy={busy === o.id + 'start'} onClick={() => act(o.id, 'start')}>{kl('START')}</KdsBtn>}
                        {col !== 'READY' && <KdsBtn tone="bg-emerald-500" busy={busy === o.id + 'done'} onClick={() => act(o.id, 'done')}>{kl('DONE')}</KdsBtn>}
                        {col === 'READY' && (
                          <>
                            <KdsBtn tone="bg-white/15" busy={busy === o.id + 'recall'} onClick={() => act(o.id, 'recall')}><RotateCcw className="mr-1 inline h-5 w-5" /> {kl('RECALL')}</KdsBtn>
                            <KdsBtn tone="bg-emerald-600" busy={busy === o.id + 'pickup'} onClick={() => act(o.id, 'pickup')}>{kl('PICKED')}</KdsBtn>
                          </>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <Modal open={!!detail} onClose={() => setDetail(null)} title={tt('Order detail')} size="xl">
        {detail && <div className="text-slate-900"><OrderDetail id={detail} /></div>}
      </Modal>
    </div>
  );
}

function StationBtn({ active, onClick, label, color }: { active: boolean; onClick: () => void; label: string; color?: string }) {
  return (
    <button onClick={onClick} className={clsx('flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold', active ? 'bg-white text-slate-900' : 'bg-white/10 text-white/80')}>
      {color && <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />}
      {label}
    </button>
  );
}
function KdsBtn({ children, onClick, tone, busy }: { children: React.ReactNode; onClick: () => void; tone: string; busy?: boolean }) {
  return (
    <button disabled={busy} onClick={onClick} className={clsx('press h-14 flex-1 rounded-xl text-xl font-black tracking-wide text-white disabled:opacity-50', tone)}>
      {busy ? '…' : children}
    </button>
  );
}
