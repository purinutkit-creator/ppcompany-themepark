import crypto from 'node:crypto';
import { EVENTS, rooms } from '@kiosk/shared';
import { publish } from '../../lib/realtime';

/**
 * Hardware integration layer. Business logic (gates.ts / lockers.ts) only talks to these interfaces, so a
 * real turnstile / flap barrier / swing gate / relay board / GPIO edge box replaces the simulator without
 * touching validation code. Physical safety (emergency release, obstruction sensors, fire alarm input)
 * stays in the controller hardware; the server only *requests* opening after authorisation.
 */
export type HardwareEvent = 'OPENED' | 'PASSAGE' | 'CLOSED' | 'OBSTRUCTION' | 'EMERGENCY_ON' | 'EMERGENCY_OFF' | 'FIRE_ALARM' | 'FAULT' | 'ONLINE' | 'OFFLINE';

export interface CommandResult {
  ok: boolean;
  error?: string;
}

export interface GateTarget {
  id: string;
  branch_id: string;
  code: string;
  driver: string;
  controller_kind: string;
  controller_config: Record<string, any>;
  open_seconds: number;
}

export interface GateController {
  open(g: GateTarget): Promise<CommandResult>;
  close(g: GateTarget): Promise<CommandResult>;
  emergency(g: GateTarget, on: boolean): Promise<CommandResult>;
}

type EventHandler = (gateId: string, ev: HardwareEvent, data?: Record<string, unknown>) => Promise<void>;
let gateEventHandler: EventHandler = async () => {};
export function onGateHardwareEvent(fn: EventHandler) {
  gateEventHandler = fn;
}
export const emitGateHardwareEvent = (gateId: string, ev: HardwareEvent, data?: Record<string, unknown>) => gateEventHandler(gateId, ev, data);

// ------------------------------------------------------------------ simulator
const simTimers = new Map<string, NodeJS.Timeout[]>();
export const simulator = {
  autoPassage: true,
  passageDelayMs: 1500,
  closeDelayMs: 700,
  clear(gateId: string) {
    for (const t of simTimers.get(gateId) ?? []) clearTimeout(t);
    simTimers.delete(gateId);
  },
};

const SimulatorController: GateController = {
  async open(g) {
    simulator.clear(g.id);
    const timers: NodeJS.Timeout[] = [];
    timers.push(setTimeout(() => void emitGateHardwareEvent(g.id, 'OPENED').catch(() => {}), 150));
    if (simulator.autoPassage && g.controller_config?.autoPassage !== false) {
      timers.push(setTimeout(() => void emitGateHardwareEvent(g.id, 'PASSAGE').catch(() => {}), simulator.passageDelayMs));
      timers.push(setTimeout(() => void emitGateHardwareEvent(g.id, 'CLOSED').catch(() => {}), simulator.passageDelayMs + simulator.closeDelayMs));
    }
    simTimers.set(g.id, timers);
    return { ok: true };
  },
  async close(g) {
    simulator.clear(g.id);
    setTimeout(() => void emitGateHardwareEvent(g.id, 'CLOSED').catch(() => {}), 200);
    return { ok: true };
  },
  async emergency() {
    return { ok: true };
  },
};

async function httpCall(url: string, body: unknown, secret?: string, timeoutMs = 3000, method = 'POST'): Promise<CommandResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const raw = body == null ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (raw) headers['Content-Type'] = 'application/json';
    if (secret && raw) {
      const t = Math.floor(Date.now() / 1000);
      headers['X-Signature'] = `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
    }
    const res = await fetch(url, { method, headers, body: raw, signal: ctrl.signal });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).name === 'AbortError' ? 'Controller timeout' : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** Network gate controller with a JSON API: POST {url} { command, gate, pulseMs } (HMAC signed). */
const HttpController: GateController = {
  open: (g) => httpCall(g.controller_config.url, { command: 'OPEN', gate: g.code, kind: g.controller_kind, pulseMs: g.controller_config.pulseMs ?? 800, holdSeconds: g.open_seconds }, g.controller_config.secret),
  close: (g) => httpCall(g.controller_config.url, { command: 'CLOSE', gate: g.code }, g.controller_config.secret),
  emergency: (g, on) => httpCall(g.controller_config.url, { command: on ? 'EMERGENCY_OPEN' : 'EMERGENCY_CLEAR', gate: g.code }, g.controller_config.secret),
};

/** Relay boards with plain URLs (e.g. http://10.0.0.20/relay/1/pulse) — openUrl / closeUrl / emergencyUrl. */
const RelayHttpController: GateController = {
  open: (g) => httpCall(g.controller_config.openUrl, null, undefined, 3000, g.controller_config.method ?? 'GET'),
  close: (g) => (g.controller_config.closeUrl ? httpCall(g.controller_config.closeUrl, null, undefined, 3000, g.controller_config.method ?? 'GET') : Promise.resolve({ ok: true })),
  emergency: (g, on) =>
    g.controller_config.emergencyUrl ? httpCall(`${g.controller_config.emergencyUrl}${on ? '' : '?off=1'}`, null, undefined, 3000, g.controller_config.method ?? 'GET') : Promise.resolve({ ok: true }),
};

/**
 * Edge agent (Raspberry Pi / industrial PC next to the gate driving GPIO, RS-485 or relays). The command is
 * pushed over the realtime channel to the paired device; the agent reports results / sensor events back to
 * POST /api/park/hardware/gates/:id/events with its device token.
 */
const EdgeAgentController: GateController = {
  async open(g) {
    if (!g.controller_config.deviceId) return { ok: false, error: 'No edge device assigned' };
    await publish(rooms.parkDevice(g.controller_config.deviceId), EVENTS.GATE_COMMAND, { commandId: crypto.randomUUID(), gateId: g.id, gate: g.code, command: 'OPEN', pin: g.controller_config.pin, pulseMs: g.controller_config.pulseMs ?? 800 });
    return { ok: true };
  },
  async close(g) {
    if (!g.controller_config.deviceId) return { ok: true };
    await publish(rooms.parkDevice(g.controller_config.deviceId), EVENTS.GATE_COMMAND, { commandId: crypto.randomUUID(), gateId: g.id, gate: g.code, command: 'CLOSE', pin: g.controller_config.pin });
    return { ok: true };
  },
  async emergency(g, on) {
    if (!g.controller_config.deviceId) return { ok: true };
    await publish(rooms.parkDevice(g.controller_config.deviceId), EVENTS.GATE_COMMAND, { commandId: crypto.randomUUID(), gateId: g.id, gate: g.code, command: on ? 'EMERGENCY_OPEN' : 'EMERGENCY_CLEAR' });
    return { ok: true };
  },
};

const GATE_DRIVERS: Record<string, GateController> = {
  SIMULATOR: SimulatorController,
  HTTP: HttpController,
  RELAY_HTTP: RelayHttpController,
  EDGE_AGENT: EdgeAgentController,
};
export function registerGateDriver(name: string, c: GateController) {
  GATE_DRIVERS[name] = c;
}
export const gateController = (driver: string) => GATE_DRIVERS[driver] ?? SimulatorController;

// ------------------------------------------------------------------ lockers
export interface LockerTarget {
  id: string;
  branch_id: string;
  code: string;
  driver: string;
  controller_config: Record<string, any>;
}
export interface LockerController {
  open(l: LockerTarget): Promise<CommandResult>;
}
const LOCKER_DRIVERS: Record<string, LockerController> = {
  SIMULATOR: { open: async () => ({ ok: true }) },
  HTTP: { open: (l) => httpCall(l.controller_config.url, { command: 'OPEN', locker: l.code, channel: l.controller_config.channel }, l.controller_config.secret) },
  EDGE_AGENT: {
    async open(l) {
      if (!l.controller_config.deviceId) return { ok: false, error: 'No edge device assigned' };
      await publish(rooms.parkDevice(l.controller_config.deviceId), EVENTS.LOCKER_COMMAND, { commandId: crypto.randomUUID(), lockerId: l.id, locker: l.code, channel: l.controller_config.channel, command: 'OPEN' });
      return { ok: true };
    },
  },
};
export function registerLockerDriver(name: string, c: LockerController) {
  LOCKER_DRIVERS[name] = c;
}
export const lockerController = (driver: string) => LOCKER_DRIVERS[driver] ?? LOCKER_DRIVERS.SIMULATOR;
