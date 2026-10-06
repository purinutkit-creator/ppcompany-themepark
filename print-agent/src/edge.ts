import { execFile } from 'node:child_process';
import { io, type Socket } from 'socket.io-client';
import { EVENTS } from '@kiosk/shared';

/**
 * Edge controller for gates and lockers (driver EDGE_AGENT). Runs next to the turnstile / flap / swing
 * gate or locker bank, receives commands from the server over the device socket, pulses a relay and
 * reports hardware events back (OPENED → PASSAGE → CLOSED, faults, emergency).
 *
 * Relay backends (EDGE_RELAY):
 *   simulate  log only (default) — useful for commissioning
 *   gpio      libgpiod `gpioset <EDGE_GPIO_CHIP> <pin>=1` then `=0` after the pulse
 *   http      GET/POST EDGE_RELAY_URL with {pin} / {state} / {channel} placeholders (network relay boards)
 * Passage (EDGE_PASSAGE): `auto` reports PASSAGE after EDGE_PASSAGE_MS (no sensor), `none` when the gate
 * reports passage itself through POST /api/park/hardware/gates/:id/events.
 */
export interface EdgeOptions {
  server: string;
  deviceToken: string;
  version: string;
  log: (...a: unknown[]) => void;
}

interface GateCommand {
  commandId: string;
  gateId: string;
  gate: string;
  command: 'OPEN' | 'CLOSE' | 'EMERGENCY_OPEN' | 'EMERGENCY_CLEAR';
  pin?: number | string;
  pulseMs?: number;
}
interface LockerCommand {
  commandId: string;
  lockerId: string;
  locker: string;
  channel?: number | string;
  command: 'OPEN';
}

const env = (k: string, d: string) => process.env[k] ?? d;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setRelay(pin: string, on: boolean) {
  const mode = env('EDGE_RELAY', 'simulate');
  if (mode === 'gpio') {
    await new Promise<void>((resolve, reject) =>
      execFile('gpioset', [env('EDGE_GPIO_CHIP', 'gpiochip0'), `${pin}=${on ? 1 : 0}`], { timeout: 3000 }, (e) => (e ? reject(e) : resolve())),
    );
  } else if (mode === 'http') {
    const url = env('EDGE_RELAY_URL', '').replace('{pin}', pin).replace('{channel}', pin).replace('{state}', on ? '1' : '0');
    if (!url) throw new Error('EDGE_RELAY_URL is not set');
    const res = await fetch(url, { method: env('EDGE_RELAY_METHOD', 'GET'), signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`relay HTTP ${res.status}`);
  }
}

async function pulse(pin: string, ms: number) {
  await setRelay(pin, true);
  await sleep(ms);
  await setRelay(pin, false);
}

export function startEdge(o: EdgeOptions): Socket {
  const report = async (gateId: string, event: string, data: Record<string, unknown> = {}) => {
    const res = await fetch(`${o.server}/api/park/hardware/gates/${gateId}/events`, {
      method: 'POST',
      headers: { 'X-Device-Token': o.deviceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, data }),
    }).catch((e) => ({ ok: false, status: 0, statusText: (e as Error).message }) as Response);
    if (!res.ok) o.log(`edge: report ${event} failed (${res.status} ${res.statusText})`);
  };
  const held = new Set<string>(); // gates held open by emergency

  const socket = io(o.server, { auth: { deviceToken: o.deviceToken }, transports: ['websocket', 'polling'], reconnectionDelayMax: 10000 });
  socket.on('connect', () => {
    o.log('edge: connected as gate / locker controller');
    socket.emit('heartbeat', { version: o.version });
  });
  socket.on('connect_error', (e) => o.log('edge: connection error:', e.message));

  socket.on(EVENTS.GATE_COMMAND, async (c: GateCommand) => {
    const pin = String(c.pin ?? env('EDGE_DEFAULT_PIN', '17'));
    o.log(`edge: ${c.gate} ${c.command} (pin ${pin})`);
    try {
      if (c.command === 'OPEN') {
        await pulse(pin, c.pulseMs ?? 800);
        await report(c.gateId, 'OPENED', { commandId: c.commandId });
        if (env('EDGE_PASSAGE', 'auto') === 'auto') {
          await sleep(Number(env('EDGE_PASSAGE_MS', '2500')));
          await report(c.gateId, 'PASSAGE', { commandId: c.commandId });
          await sleep(Number(env('EDGE_CLOSE_MS', '800')));
          if (!held.has(c.gateId)) await report(c.gateId, 'CLOSED', { commandId: c.commandId });
        }
      } else if (c.command === 'CLOSE') {
        held.delete(c.gateId);
        await setRelay(pin, false);
        await report(c.gateId, 'CLOSED', { commandId: c.commandId });
      } else if (c.command === 'EMERGENCY_OPEN') {
        held.add(c.gateId);
        await setRelay(pin, true); // fail-safe: hold open
      } else if (c.command === 'EMERGENCY_CLEAR') {
        held.delete(c.gateId);
        await setRelay(pin, false);
      }
    } catch (e) {
      o.log(`edge: ${c.gate} relay error: ${(e as Error).message}`);
      await report(c.gateId, 'FAULT', { commandId: c.commandId, error: (e as Error).message.slice(0, 200) });
    }
  });

  socket.on(EVENTS.LOCKER_COMMAND, async (c: LockerCommand) => {
    const ch = String(c.channel ?? '');
    o.log(`edge: locker ${c.locker} OPEN (channel ${ch || '-'})`);
    try {
      if (ch) await pulse(ch, Number(env('EDGE_LOCKER_PULSE_MS', '500')));
    } catch (e) {
      o.log(`edge: locker ${c.locker} relay error: ${(e as Error).message}`);
    }
  });

  setInterval(() => socket.connected && socket.emit('heartbeat', { version: o.version }), 30_000);
  return socket;
}
