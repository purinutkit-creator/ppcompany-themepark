import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import clsx from 'clsx';
import { Camera, CameraOff, ScanLine } from 'lucide-react';
import { code128Svg } from '@kiosk/shared';
import { useT } from '../lib/lang';

/** QR code image (PromptPay, tickets, member card). */
export function QrCode({ value, size = 220, className, margin = 1 }: { value: string | null | undefined; size?: number; className?: string; margin?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!value) return setSrc(null);
    let alive = true;
    QRCode.toDataURL(value, { width: size * 2, margin, errorCorrectionLevel: 'M' }).then((u) => alive && setSrc(u)).catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [value, size, margin]);
  if (!src) return <div style={{ width: size, height: size }} className={clsx('animate-pulse rounded-xl bg-slate-100', className)} />;
  return <img src={src} width={size} height={size} alt="QR" className={clsx('select-none', className)} draggable={false} />;
}

/** Code 128 barcode (booking / ticket / wristband number). */
export function Barcode({ value, height = 60, module = 2, className, showText = true }: { value: string | null | undefined; height?: number; module?: number; className?: string; showText?: boolean }) {
  if (!value) return null;
  let svg = '';
  try {
    svg = code128Svg(value, { height, module });
  } catch {
    return <div className="font-mono text-sm">{value}</div>;
  }
  return (
    <div className={clsx('inline-flex flex-col items-center', className)}>
      <div className="max-w-full [&>svg]:h-auto [&>svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      {showText && <div className="mt-1 font-mono text-xs tracking-widest text-slate-600">{value}</div>}
    </div>
  );
}

/**
 * USB / Bluetooth barcode & RFID readers act as a keyboard: fast keystrokes ending with Enter.
 * Captured globally (except while the user types in a normal input) so a screen works without focus.
 */
export function useScanner(onScan: (code: string) => void, opts: { enabled?: boolean; minLength?: number } = {}) {
  const ref = useRef(onScan);
  ref.current = onScan;
  const enabled = opts.enabled ?? true;
  const minLength = opts.minLength ?? 4;
  useEffect(() => {
    if (!enabled) return;
    let buf = '';
    let last = 0;
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) && !el.dataset.scan;
      if (typing) return;
      const now = Date.now();
      if (now - last > 80) buf = '';
      last = now;
      if (e.key === 'Enter') {
        if (buf.length >= minLength) {
          e.preventDefault();
          ref.current(buf);
        }
        buf = '';
        return;
      }
      if (e.key.length === 1) buf += e.key;
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [enabled, minLength]);
}

declare global {
  interface Window {
    BarcodeDetector?: any;
  }
}

/** Camera QR / barcode reader: native BarcodeDetector when available, jsQR fallback (QR only). */
export function CameraScanner({ onScan, active, className, facing = 'environment', cooldownMs = 2500 }: { onScan: (code: string) => void; active: boolean; className?: string; facing?: 'environment' | 'user'; cooldownMs?: number }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const cb = useRef(onScan);
  cb.current = onScan;
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let stream: MediaStream | null = null;
    let stop = false;
    let lastCode = '';
    let lastAt = 0;
    const canvas = document.createElement('canvas');
    const emit = (code: string) => {
      const now = Date.now();
      if (code === lastCode && now - lastAt < cooldownMs) return;
      lastCode = code;
      lastAt = now;
      cb.current(code);
    };
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        if (stop) return stream.getTracks().forEach((tr) => tr.stop());
        const v = video.current!;
        v.srcObject = stream;
        await v.play().catch(() => {});
        let detector: any = null;
        if (window.BarcodeDetector) {
          try {
            detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'pdf417', 'data_matrix'] });
          } catch {
            detector = null;
          }
        }
        const jsqr = detector ? null : (await import('jsqr')).default;
        const tick = async () => {
          if (stop) return;
          try {
            if (v.readyState >= 2) {
              if (detector) {
                const codes = await detector.detect(v);
                if (codes?.[0]?.rawValue) emit(codes[0].rawValue);
              } else if (jsqr) {
                const w = 640;
                const h = Math.round((v.videoHeight / Math.max(1, v.videoWidth)) * w) || 480;
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
                ctx.drawImage(v, 0, 0, w, h);
                const img = ctx.getImageData(0, 0, w, h);
                const r = jsqr(img.data, w, h, { inversionAttempts: 'dontInvert' });
                if (r?.data) emit(r.data);
              }
            }
          } catch {
            /* keep scanning */
          }
          setTimeout(tick, 180);
        };
        void tick();
        setErr(null);
      } catch (e) {
        setErr((e as Error).message || 'camera');
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [active, facing, cooldownMs]);
  if (!active) return null;
  return (
    <div className={clsx('relative overflow-hidden rounded-2xl bg-black', className)}>
      <video ref={video} playsInline muted className="h-full w-full object-cover" />
      <div className="pointer-events-none absolute inset-[18%] rounded-2xl border-4 border-white/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]" />
      <div className="pointer-events-none absolute inset-x-[18%] top-1/2 h-0.5 animate-pulse bg-rose-500/80" />
      {err && <div className="absolute inset-x-0 bottom-0 bg-rose-600/90 p-2 text-center text-sm text-white">{t('cameraError')}: {err}</div>}
    </div>
  );
}

/** Scan bar: typed / USB scanner input + optional camera. */
export function ScanBar({ onScan, placeholder, autoFocus = true, busy, className, camera = true, big }: { onScan: (code: string) => void; placeholder?: string; autoFocus?: boolean; busy?: boolean; className?: string; camera?: boolean; big?: boolean }) {
  const t = useT();
  const [v, setV] = useState('');
  const [cam, setCam] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  const submit = (code: string) => {
    const c = code.trim();
    if (!c || busy) return;
    onScan(c);
    setV('');
  };
  return (
    <div className={className}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(v);
        }}
        className="flex gap-2"
      >
        <div className="relative flex-1">
          <ScanLine className={clsx('absolute top-1/2 left-3 -translate-y-1/2 text-slate-400', big ? 'h-6 w-6' : 'h-5 w-5')} />
          <input
            ref={input}
            data-scan="1"
            value={v}
            onChange={(e) => setV(e.target.value)}
            placeholder={placeholder ?? t('scanHint')}
            className={clsx('w-full rounded-xl border border-slate-300 bg-white pr-3 font-mono outline-none focus:border-primary focus:ring-2 focus:ring-primary/20', big ? 'h-14 pl-11 text-lg' : 'h-11 pl-10')}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <button type="submit" disabled={busy || !v.trim()} className={clsx('press rounded-xl bg-primary px-5 font-semibold text-white disabled:opacity-50', big ? 'h-14' : 'h-11')}>
          {t('scan')}
        </button>
        {camera && (
          <button type="button" onClick={() => setCam((c) => !c)} className={clsx('press rounded-xl border border-slate-300 bg-white px-3 text-slate-700', big ? 'h-14' : 'h-11')} title={cam ? t('cameraOff') : t('camera')}>
            {cam ? <CameraOff className="h-5 w-5" /> : <Camera className="h-5 w-5" />}
          </button>
        )}
      </form>
      {cam && <CameraScanner active={cam} onScan={submit} className="mt-3 aspect-video w-full max-w-md" />}
    </div>
  );
}
