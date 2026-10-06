import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import clsx from 'clsx';
import { Loader2, X, Upload, ImageOff, Inbox } from 'lucide-react';
import { create } from 'zustand';
import { ApiError, errorMessage, uploadFile } from '../lib/api';
import { STATUS_COLORS } from '../lib/format';
import { useUiLang } from '../lib/lang';
import { tt, ttStatus } from '../lib/legacy-i18n';

/** Translate plain English strings passed to shared components (other nodes pass through). */
const tx = <T,>(v: T): T => (typeof v === 'string' ? (tt(v) as T) : v);

/** Shared component texts in the current UI language (th / en / zh). */
const UI_TEXT = {
  loading: { th: 'กำลังโหลด…', en: 'Loading…', zh: '加载中…' },
  empty: { th: 'ยังไม่มีข้อมูล', en: 'Nothing here yet', zh: '暂无数据' },
  retry: { th: 'ลองใหม่', en: 'Retry', zh: '重试' },
  upload: { th: 'อัปโหลด', en: 'Upload', zh: '上传' },
  clear: { th: 'ล้าง', en: 'Clear', zh: '清除' },
  cancel: { th: 'ยกเลิก', en: 'Cancel', zh: '取消' },
  confirm: { th: 'ยืนยัน', en: 'Confirm', zh: '确认' },
  ok: { th: 'ตกลง', en: 'OK', zh: '确定' },
  approve: { th: 'อนุมัติ', en: 'Approve', zh: '批准' },
  managerTitle: { th: 'ต้องได้รับอนุมัติจากผู้จัดการ', en: 'Manager approval required', zh: '需要经理批准' },
  managerHint: { th: 'ต้องให้ผู้จัดการยืนยันด้วยรหัสพนักงานและ PIN', en: 'A manager must confirm with their employee code and PIN', zh: '需经理输入员工编号和PIN确认' },
  managerCode: { th: 'รหัสพนักงานผู้จัดการ', en: 'Manager employee code', zh: '经理员工编号' },
  managerInvalid: { th: 'รหัสผู้จัดการหรือ PIN ไม่ถูกต้อง', en: 'Invalid manager code or PIN', zh: '经理编号或PIN错误' },
} as const;
type UiKey = keyof typeof UI_TEXT;
/** Hook form (re-renders on language change). */
function useUiText() {
  const lang = useUiLang((s) => s.lang);
  return (k: UiKey) => UI_TEXT[k][lang];
}
/** Non-React form (toasts / helpers). */
const uiText = (k: UiKey) => UI_TEXT[k][useUiLang.getState().lang];

/* ------------------------------------------------------------------ Buttons */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline' | 'dark';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-primary text-white hover:brightness-110 shadow-sm',
  secondary: 'bg-slate-100 text-slate-800 hover:bg-slate-200',
  ghost: 'bg-transparent text-slate-700 hover:bg-slate-100',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 shadow-sm',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm',
  outline: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50',
  dark: 'bg-slate-900 text-white hover:bg-slate-800',
};
export interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  loading?: boolean;
  icon?: ReactNode;
}
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = 'primary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        'press inline-flex items-center justify-center gap-2 rounded-xl font-medium whitespace-nowrap disabled:opacity-50',
        size === 'sm' && 'h-8 px-3 text-sm',
        size === 'md' && 'h-10 px-4 text-sm',
        size === 'lg' && 'h-12 px-6 text-base',
        size === 'xl' && 'h-16 px-8 text-xl rounded-2xl',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('animate-spin text-slate-400', className ?? 'h-6 w-6')} />;
}

export function Loading({ label }: { label?: string }) {
  const u = useUiText();
  label = label ?? u('loading');
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 text-slate-500">
      <Spinner className="h-8 w-8" />
      <span className="text-sm">{tx(label)}</span>
    </div>
  );
}

export function Empty({ title, sub, icon, action }: { title?: string; sub?: string; icon?: ReactNode; action?: ReactNode }) {
  const u = useUiText();
  title = title ?? u('empty');
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center text-slate-500">
      <div className="mb-1 rounded-full bg-slate-100 p-4 text-slate-400">{icon ?? <Inbox className="h-7 w-7" />}</div>
      <div className="font-medium text-slate-700">{tx(title)}</div>
      {sub && <div className="max-w-sm text-sm">{tx(sub)}</div>}
      {action}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const u = useUiText();
  if (!error) return null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
      <span>{errorMessage(error)}</span>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          {u('retry')}
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Badges */
export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold', className ?? 'bg-slate-100 text-slate-700')}>{children}</span>;
}
export function StatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  if (!status) return null;
  return <Badge className={clsx(STATUS_COLORS[status] ?? 'bg-slate-100 text-slate-700', className)}>{ttStatus(status)}</Badge>;
}

/* ------------------------------------------------------------------ Card / Page */
export function Card({ children, className, title, actions, padded = true }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode; padded?: boolean }) {
  return (
    <div className={clsx('rounded-2xl border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
          <div className="font-semibold text-slate-800">{tx(title)}</div>
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      )}
      <div className={clsx(padded && 'p-5')}>{children}</div>
    </div>
  );
}

export function PageHeader({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{tx(title)}</h1>
        {sub && <p className="mt-0.5 text-sm text-slate-500">{tx(sub)}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

export function Stat({ label, value, sub, icon, tone = 'slate' }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode; tone?: 'slate' | 'green' | 'blue' | 'amber' | 'rose' | 'violet' }) {
  const tones = { slate: 'bg-slate-100 text-slate-600', green: 'bg-emerald-100 text-emerald-700', blue: 'bg-sky-100 text-sky-700', amber: 'bg-amber-100 text-amber-700', rose: 'bg-rose-100 text-rose-700', violet: 'bg-violet-100 text-violet-700' };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-500">{tx(label)}</div>
        {icon && <div className={clsx('rounded-xl p-2', tones[tone])}>{icon}</div>}
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums text-slate-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ Tabs */
export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { id: T; label: ReactNode; count?: number; tone?: string }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={clsx('no-scrollbar flex gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1', className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={clsx('press flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium', value === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900')}
        >
          {tx(t.label)}
          {t.count != null && t.count > 0 && <span className={clsx('min-w-5 rounded-full px-1.5 text-xs font-bold', t.tone ?? 'bg-slate-200 text-slate-700')}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Modal */
export function Modal({ open, onClose, title, children, footer, size = 'md', dismissable = true }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'; dismissable?: boolean }) {
  useEffect(() => {
    if (!open || !dismissable) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose, dismissable]);
  if (!open) return null;
  const w = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl', full: 'max-w-[96vw]' }[size];
  return (
    <div className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[2px]" onMouseDown={(e) => dismissable && e.target === e.currentTarget && onClose()}>
      <div className={clsx('anim-pop flex max-h-[92vh] w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl', w)}>
        {title && (
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <div className="text-lg font-semibold text-slate-900">{tx(title)}</div>
            {dismissable && (
              <button onClick={onClose} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
        )}
        <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Form fields */
export function Field({ label, hint, error, children, className }: { label?: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('block', className)}>
      {label && <div className="mb-1 text-sm font-medium text-slate-700">{tx(label)}</div>}
      {children}
      {hint && !error && <div className="mt-1 text-xs text-slate-500">{tx(hint)}</div>}
      {error && <div className="mt-1 text-xs text-rose-600">{error}</div>}
    </label>
  );
}
const inputCls = 'w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:bg-slate-50';
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={clsx(inputCls, className)} {...p} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={clsx(inputCls, 'min-h-20', className)} {...p} />;
});
export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx(inputCls, 'pr-8', className)} {...p}>
      {children}
    </select>
  );
}
export function NumberInput({ value, onChange, ...p }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: number | null | undefined; onChange: (v: number | null) => void }) {
  return <Input type="number" inputMode="decimal" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} {...p} />;
}
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={clsx('inline-flex cursor-pointer items-center gap-2.5 select-none', disabled && 'opacity-50')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx('relative h-6 w-11 shrink-0 rounded-full transition', checked ? 'bg-primary' : 'bg-slate-300')}
      >
        <span className={clsx('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', checked ? 'left-5.5' : 'left-0.5')} />
      </button>
      {label && <span className="text-sm text-slate-700">{tx(label)}</span>}
    </label>
  );
}
export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700 select-none">
      <input type="checkbox" className="h-4 w-4 accent-[var(--brand-primary)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {tx(label)}
    </label>
  );
}

/** Three-language text input (TH / EN / 中文). */
export function I18nInput({ value, onChange, multiline, label, required }: { value: Record<string, string | undefined> | null | undefined; onChange: (v: Record<string, string>) => void; multiline?: boolean; label?: ReactNode; required?: boolean }) {
  const v = (value ?? {}) as Record<string, string>;
  const langs: [string, string][] = [['th', '🇹🇭 ไทย'], ['en', '🇬🇧 English'], ['zh', '🇨🇳 中文']];
  return (
    <div>
      {label && <div className="mb-1 text-sm font-medium text-slate-700">{tx(label)}</div>}
      <div className="grid gap-2 md:grid-cols-3">
        {langs.map(([l, name]) => (
          <div key={l}>
            <div className="mb-0.5 text-[11px] font-medium text-slate-500">{name}</div>
            {multiline ? (
              <Textarea value={v[l] ?? ''} onChange={(e) => onChange({ ...v, [l]: e.target.value })} lang={l} />
            ) : (
              <Input value={v[l] ?? ''} required={required && l === 'th'} onChange={(e) => onChange({ ...v, [l]: e.target.value })} lang={l} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Image (or video / font) picker: paste a URL or upload a file. */
export function MediaInput({ value, onChange, kind = 'image', label }: { value: string | null | undefined; onChange: (v: string) => void; kind?: 'image' | 'video'; label?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div>
      {label && <div className="mb-1 text-sm font-medium text-slate-700">{tx(label)}</div>}
      <div className="flex items-start gap-3">
        <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
          {value ? kind === 'video' ? <video src={value} className="h-full w-full object-cover" muted /> : <img src={value} className="h-full w-full object-cover" alt="" /> : <ImageOff className="h-6 w-6 text-slate-300" />}
        </div>
        <div className="flex-1 space-y-2">
          <Input placeholder={kind === 'video' ? 'https://…/video.mp4 or upload' : 'https://…/image.jpg or upload'} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
          <div className="flex gap-2">
            <input
              ref={ref}
              type="file"
              hidden
              accept={kind === 'video' ? 'video/mp4,video/webm' : 'image/png,image/jpeg,image/webp,image/gif'}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setBusy(true);
                setErr(null);
                try {
                  onChange((await uploadFile(f, kind)).url);
                } catch (x) {
                  setErr(errorMessage(x));
                } finally {
                  setBusy(false);
                  e.target.value = '';
                }
              }}
            />
            <Button type="button" size="sm" variant="outline" loading={busy} icon={<Upload className="h-4 w-4" />} onClick={() => ref.current?.click()}>
              {uiText('upload')}
            </Button>
            {value && (
              <Button type="button" size="sm" variant="ghost" onClick={() => onChange('')}>
                {uiText('clear')}
              </Button>
            )}
          </div>
          {err && <div className="text-xs text-rose-600">{err}</div>}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Toasts */
interface Toast {
  id: number;
  tone: 'info' | 'success' | 'error' | 'warning';
  title: string;
  body?: string;
}
const useToasts = create<{ items: Toast[]; push: (t: Omit<Toast, 'id'>) => void; remove: (id: number) => void }>((set) => ({
  items: [],
  push: (t) => {
    const id = Date.now() + Math.random();
    set((s) => ({ items: [...s.items.slice(-4), { ...t, id }] }));
    setTimeout(() => set((s) => ({ items: s.items.filter((x) => x.id !== id) })), t.tone === 'error' ? 7000 : 4000);
  },
  remove: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));
export const toast = {
  success: (title: string, body?: string) => useToasts.getState().push({ tone: 'success', title, body }),
  error: (title: string | unknown, body?: string) => useToasts.getState().push({ tone: 'error', title: typeof title === 'string' ? title : errorMessage(title), body }),
  info: (title: string, body?: string) => useToasts.getState().push({ tone: 'info', title, body }),
  warning: (title: string, body?: string) => useToasts.getState().push({ tone: 'warning', title, body }),
};
export function Toaster() {
  const { items, remove } = useToasts();
  const tone = { info: 'border-sky-200 bg-white', success: 'border-emerald-300 bg-emerald-50', error: 'border-rose-300 bg-rose-50', warning: 'border-amber-300 bg-amber-50' };
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-80 flex-col gap-2 no-print">
      {items.map((t) => (
        <div key={t.id} className={clsx('anim-up pointer-events-auto rounded-xl border px-4 py-3 shadow-lg', tone[t.tone])} onClick={() => remove(t.id)}>
          <div className="text-sm font-semibold text-slate-900">{tx(t.title)}</div>
          {t.body && <div className="mt-0.5 text-xs text-slate-600">{tx(t.body)}</div>}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Confirm & manager approval */
interface DialogState {
  kind: 'confirm' | 'manager' | 'prompt' | null;
  title?: string;
  body?: ReactNode;
  danger?: boolean;
  placeholder?: string;
  resolve?: (v: any) => void;
}
const useDialog = create<{ s: DialogState; open: (s: DialogState) => void; close: () => void }>((set) => ({
  s: { kind: null },
  open: (s) => set({ s }),
  close: () => set({ s: { kind: null } }),
}));

export function confirmDialog(title: string, body?: ReactNode, danger = false): Promise<boolean> {
  return new Promise((resolve) => useDialog.getState().open({ kind: 'confirm', title, body, danger, resolve }));
}
export function promptDialog(title: string, placeholder = '', body?: ReactNode): Promise<string | null> {
  return new Promise((resolve) => useDialog.getState().open({ kind: 'prompt', title, placeholder, body, resolve }));
}
function askManager(title: string): Promise<{ managerCode: string; managerPin: string } | null> {
  return new Promise((resolve) => useDialog.getState().open({ kind: 'manager', title, resolve }));
}

/**
 * Run an API action; if the server answers MANAGER_PIN_REQUIRED / INVALID, prompt for a manager's
 * employee code + PIN and retry with the approval attached.
 */
export async function withManagerApproval<T>(title: string, run: (approval: { managerCode?: string; managerPin?: string }) => Promise<T>): Promise<T | null> {
  let approval: { managerCode?: string; managerPin?: string } = {};
  for (let i = 0; i < 4; i++) {
    try {
      return await run(approval);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'MANAGER_PIN_REQUIRED' || e.code === 'MANAGER_PIN_INVALID')) {
        if (e.code === 'MANAGER_PIN_INVALID') toast.error(uiText('managerInvalid'));
        const a = await askManager(title);
        if (!a) return null;
        approval = a;
        continue;
      }
      throw e;
    }
  }
  return null;
}

export function DialogHost() {
  const u = useUiText();
  const { s, close } = useDialog();
  const [text, setText] = useState('');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  useEffect(() => {
    setText('');
    setPin('');
  }, [s.kind]);
  if (!s.kind) return null;
  const done = (v: any) => {
    s.resolve?.(v);
    close();
  };
  if (s.kind === 'confirm')
    return (
      <Modal open onClose={() => done(false)} title={tx(s.title)} size="sm" footer={<><Button variant="ghost" onClick={() => done(false)}>{u('cancel')}</Button><Button variant={s.danger ? 'danger' : 'primary'} onClick={() => done(true)} autoFocus>{u('confirm')}</Button></>}>
        <div className="text-sm text-slate-600">{tx(s.body)}</div>
      </Modal>
    );
  if (s.kind === 'prompt')
    return (
      <Modal open onClose={() => done(null)} title={tx(s.title)} size="sm" footer={<><Button variant="ghost" onClick={() => done(null)}>{u('cancel')}</Button><Button disabled={!text.trim()} onClick={() => done(text.trim())}>{u('ok')}</Button></>}>
        {s.body && <div className="mb-3 text-sm text-slate-600">{tx(s.body)}</div>}
        <Textarea autoFocus value={text} placeholder={tx(s.placeholder)} onChange={(e) => setText(e.target.value)} />
      </Modal>
    );
  return (
    <Modal open onClose={() => done(null)} title={u('managerTitle')} size="sm" footer={<><Button variant="ghost" onClick={() => done(null)}>{u('cancel')}</Button><Button disabled={!code || pin.length < 4} onClick={() => done({ managerCode: code.toUpperCase(), managerPin: pin })}>{u('approve')}</Button></>}>
      <div className="mb-3 text-sm text-slate-600">{tx(s.title)} — {u('managerHint')}</div>
      <div className="space-y-3">
        <Field label={u('managerCode')}>
          <Input autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="MGR001" />
        </Field>
        <Field label="PIN">
          <Input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} onKeyDown={(e) => e.key === 'Enter' && code && pin.length >= 4 && done({ managerCode: code.toUpperCase(), managerPin: pin })} />
        </Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ Table */
export function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('scroll-thin overflow-x-auto', className)}>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs tracking-wide text-slate-500 uppercase">
            {head.map((h, i) => (
              <th key={i} className="px-3 py-2.5 font-semibold whitespace-nowrap">
                {tx(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}
export const Td = ({ children, className, ...p }: { children?: ReactNode; className?: string; colSpan?: number; onClick?: () => void }) => (
  <td className={clsx('px-3 py-2.5 align-middle', className)} {...p}>
    {children}
  </td>
);

export function ConnectionDot({ connected, label }: { connected: boolean; label?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium', connected ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700')}>
      <span className={clsx('h-2 w-2 rounded-full', connected ? 'bg-emerald-500' : 'animate-pulse bg-rose-500')} />
      {tx(label) ?? tt(connected ? 'Live' : 'Reconnecting…')}
    </span>
  );
}
