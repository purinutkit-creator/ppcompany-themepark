import { useEffect, useRef, useState } from 'react';
import { buildDoc, type PrintJobPayload } from '@kiosk/shared';
import { previewCanvas } from '../printing/render';
import { Spinner } from '../components/ui';

/** Pixel-accurate preview of what the raster printer will print (same renderer as real jobs). */
export function PrintPreview({ payload, paperWidth = 80, scale = 0.6 }: { payload: PrintJobPayload; paperWidth?: 58 | 80; scale?: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(true);
  const key = JSON.stringify([payload, paperWidth]);
  useEffect(() => {
    let alive = true;
    setBusy(true);
    void previewCanvas(buildDoc(payload, 'Preview'), paperWidth, payload.font ?? undefined).then((c) => {
      if (!alive || !holder.current) return;
      c.style.width = `${c.width * scale}px`;
      c.style.imageRendering = 'pixelated';
      holder.current.replaceChildren(c);
      setBusy(false);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scale]);
  return (
    <div className="relative inline-block rounded-lg bg-white p-3 shadow-inner ring-1 ring-slate-200">
      {busy && <Spinner className="absolute top-3 right-3 h-5 w-5" />}
      <div ref={holder} />
    </div>
  );
}
