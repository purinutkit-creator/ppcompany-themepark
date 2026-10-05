import 'dotenv/config';
import os from 'node:os';
import { io } from 'socket.io-client';
import { EVENTS } from '@kiosk/shared';
import { renderJob, syncFonts } from './render';
import { scanDevices, scanNetwork } from './discovery';
import { transportFor, type AgentPrinter } from './transports';

const VERSION = '1.0.0';
const SERVER = (process.env.SERVER_URL || 'http://localhost:4000').replace(/\/$/, '');
const TOKEN = process.env.AGENT_TOKEN || '';
const CACHE = process.env.CACHE_DIR || './.cache';
if (!TOKEN) {
  console.error('AGENT_TOKEN is required (Admin → Printers → Print agents → New agent)');
  process.exit(1);
}
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SERVER}/api${path}`, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: { 'X-Agent-Token': TOKEN, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${res.status} ${data?.error?.code ?? ''} ${data?.error?.message ?? ''}`.trim());
  return data as T;
}

let printers: AgentPrinter[] = [];
const lastStatus = new Map<string, string>();

async function loadPrinters() {
  printers = await api<AgentPrinter[]>('/print/executor/printers');
  return printers;
}

async function reportStatus(p: AgentPrinter, status: 'CONNECTED' | 'OFFLINE' | 'ERROR', error: string | null = null) {
  const key = `${status}:${error ?? ''}`;
  if (lastStatus.get(p.id) === key && status === 'CONNECTED') return;
  lastStatus.set(p.id, key);
  await api(`/print/executor/printers/${p.id}/status`, { status, error }).catch(() => {});
}

let busy = false;
let again = false;
/** Pull pending jobs, claim each atomically, print, report. Serialised to keep ticket order. */
async function processJobs() {
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  try {
    do {
      again = false;
      const jobs = await api<any[]>('/print/executor/jobs');
      for (const j of jobs) {
        const claim = await api<{ claimed: boolean; job: any; printer: AgentPrinter }>(`/print/executor/jobs/${j.id}/claim`, {}).catch((e) => {
          log('claim failed', e.message);
          return null;
        });
        if (!claim?.claimed) continue;
        const p = claim.printer;
        try {
          const bytes = await renderJob(claim.job.payload, p, SERVER);
          await transportFor(p).send(bytes);
          await api(`/print/executor/jobs/${j.id}/result`, { ok: true });
          await reportStatus(p, 'CONNECTED');
          log(`printed ${claim.job.document_type} #${claim.job.order_number ?? '-'} on ${p.name} (${bytes.length} bytes)`);
        } catch (e) {
          const msg = (e as Error).message.slice(0, 400);
          log(`print failed on ${p.name}: ${msg}`);
          await api(`/print/executor/jobs/${j.id}/result`, { ok: false, error: msg }).catch(() => {});
          await reportStatus(p, 'ERROR', msg);
        }
      }
    } while (again);
  } catch (e) {
    log('job loop error', (e as Error).message);
  } finally {
    busy = false;
  }
}

/** Auto-reconnect / health: probe each printer and report CONNECTED / OFFLINE. */
async function probeAll() {
  for (const p of printers) {
    try {
      await transportFor(p).probe();
      await reportStatus(p, 'CONNECTED');
    } catch (e) {
      await reportStatus(p, 'OFFLINE', (e as Error).message);
    }
  }
}

async function refreshFonts() {
  const fonts = await api<any[]>('/print/executor/fonts').catch(() => []);
  await syncFonts(fonts, SERVER, CACHE, log);
}

const socket = io(SERVER, { auth: { agentToken: TOKEN }, transports: ['websocket', 'polling'], reconnectionDelayMax: 10000 });
socket.on('connect', async () => {
  log(`connected to ${SERVER}`);
  socket.emit('heartbeat', { version: VERSION, hostname: os.hostname() });
  try {
    await loadPrinters();
    log(`managing ${printers.length} printer(s): ${printers.map((p) => p.name).join(', ') || '—'}`);
    await refreshFonts();
    await probeAll();
    await processJobs();
  } catch (e) {
    log('startup error', (e as Error).message);
  }
});
socket.on('connect_error', (e) => log('connection error:', e.message));
socket.on('disconnect', (r) => log('disconnected:', r));
socket.on(EVENTS.PRINT_JOB_CREATED, () => void processJobs());
socket.on(EVENTS.PRINTER_STATUS, (d: any) => d?.changed && void loadPrinters().then(probeAll));
socket.on(EVENTS.SETTINGS_UPDATED, (d: any) => d?.key === 'fonts' && void refreshFonts());
socket.on(EVENTS.AGENT_COMMAND, async (cmd: any, ack?: (r: unknown) => void) => {
  if (cmd?.command !== 'scan') return ack?.({ error: 'unknown command' });
  log('scan requested', cmd.kind ?? 'all');
  const subnets = (cmd.subnet ? [String(cmd.subnet)] : (process.env.SCAN_SUBNETS || '').split(',').filter(Boolean)).map((s: string) => s.split('.').slice(0, 3).join('.'));
  const found = [
    ...(cmd.kind === 'network' || cmd.kind === 'all' || !cmd.kind ? await scanNetwork(subnets) : []),
    ...(cmd.kind === 'usb' || cmd.kind === 'bluetooth' || cmd.kind === 'all' || !cmd.kind ? scanDevices() : []),
  ];
  ack?.({ printers: found });
});

setInterval(() => socket.connected && socket.emit('heartbeat', { version: VERSION, hostname: os.hostname() }), 30_000);
setInterval(() => socket.connected && void processJobs(), 15_000); // safety net for missed events / due retries
setInterval(() => socket.connected && void loadPrinters().then(probeAll).catch(() => {}), 30_000);
process.on('SIGINT', () => {
  socket.close();
  process.exit(0);
});
