import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { EVENTS } from '@kiosk/shared';
import { deviceApi } from '../lib/api';
import { useSocketEvent } from '../lib/socket';
import { renderJob } from './render';
import { transportFor, type PrinterConfig } from './transports';

export interface ExecutorState {
  printers: (PrinterConfig & { live?: 'CONNECTED' | 'ERROR' | 'OFFLINE'; lastError?: string | null })[];
  printing: boolean;
  lastPrintedAt: number | null;
}

/**
 * Browser print executor: handles print jobs for printers bound to THIS device
 * (WebUSB / Web Bluetooth / Web Serial / Android / Desktop bridge). Jobs are claimed atomically
 * on the server, so several devices can never print the same job twice.
 */
export function useBrowserPrintExecutor(socket: Socket | null, enabled = true) {
  const [state, setState] = useState<ExecutorState>({ printers: [], printing: false, lastPrintedAt: null });
  const busy = useRef(false);
  const again = useRef(false);
  const printersRef = useRef<ExecutorState['printers']>([]);

  const setPrinterLive = (id: string, live: 'CONNECTED' | 'ERROR' | 'OFFLINE', lastError: string | null = null) => {
    printersRef.current = printersRef.current.map((p) => (p.id === id ? { ...p, live, lastError } : p));
    setState((s) => ({ ...s, printers: printersRef.current }));
    deviceApi(`/print/executor/printers/${id}/status`, { body: { status: live, error: lastError } }).catch(() => {});
  };

  const loadPrinters = async () => {
    try {
      const list = await deviceApi<PrinterConfig[]>('/print/executor/printers');
      printersRef.current = list.map((p) => ({ ...p, live: printersRef.current.find((x) => x.id === p.id)?.live }));
      setState((s) => ({ ...s, printers: printersRef.current }));
      return list;
    } catch {
      return printersRef.current;
    }
  };

  const process = async () => {
    if (!enabled) return;
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      do {
        again.current = false;
        if (!printersRef.current.length) await loadPrinters();
        if (!printersRef.current.length) break;
        const jobs = await deviceApi<any[]>('/print/executor/jobs').catch(() => []);
        for (const j of jobs) {
          const claim = await deviceApi<{ claimed: boolean; job: any; printer: PrinterConfig }>(`/print/executor/jobs/${j.id}/claim`, { method: 'POST' }).catch(() => null);
          if (!claim?.claimed) continue;
          setState((s) => ({ ...s, printing: true }));
          try {
            const bytes = await renderJob(claim.job.payload, claim.printer);
            await transportFor(claim.printer).write(bytes);
            await deviceApi(`/print/executor/jobs/${j.id}/result`, { body: { ok: true } });
            setPrinterLive(claim.printer.id, 'CONNECTED');
            setState((s) => ({ ...s, lastPrintedAt: Date.now() }));
          } catch (e) {
            const msg = (e as Error).message?.slice(0, 400) || 'Print failed';
            await deviceApi(`/print/executor/jobs/${j.id}/result`, { body: { ok: false, error: msg } }).catch(() => {});
            setPrinterLive(claim.printer.id, 'ERROR', msg);
          } finally {
            setState((s) => ({ ...s, printing: false }));
          }
        }
      } while (again.current);
    } finally {
      busy.current = false;
    }
  };

  useEffect(() => {
    if (!enabled) return;
    void loadPrinters().then(process);
    const t = setInterval(() => void process(), 15000);
    // Auto-reconnect: probe paired transports periodically.
    const r = setInterval(async () => {
      for (const p of printersRef.current) {
        if (!p.auto_reconnect) continue;
        try {
          const tr = transportFor(p);
          if (!tr.isConnected()) {
            await tr.connect();
            setPrinterLive(p.id, 'CONNECTED');
          }
        } catch (e) {
          if (p.live !== 'OFFLINE') setPrinterLive(p.id, 'OFFLINE', (e as Error).message);
        }
      }
    }, 30000);
    return () => {
      clearInterval(t);
      clearInterval(r);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useSocketEvent(socket, EVENTS.PRINT_JOB_CREATED, (d) => {
    if (!d?.printerId || printersRef.current.some((p) => p.id === d.printerId)) void process();
  });
  useSocketEvent(socket, EVENTS.PRINTER_STATUS, (d) => {
    if (d?.changed) void loadPrinters();
  });

  return { ...state, reload: loadPrinters, processNow: process };
}
