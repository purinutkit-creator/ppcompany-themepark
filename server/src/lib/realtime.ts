import { EventEmitter } from 'node:events';
import type { Server as IOServer } from 'socket.io';
import pg from 'pg';
import { config } from '../config';
import { pool } from '../db/pool';

/**
 * Cross-instance real-time bus. Events are published through Postgres NOTIFY so that every
 * server instance (behind a load balancer) forwards them to its own Socket.IO clients.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

let io: IOServer | null = null;
let listener: pg.Client | null = null;
const CHANNEL = 'kiosk_realtime';
const instanceId = Math.random().toString(36).slice(2);

export interface RtMessage {
  rooms: string[];
  event: string;
  data: unknown;
}

function deliver(msg: RtMessage) {
  bus.emit('event', msg);
  if (io && msg.rooms.length) io.to(msg.rooms).emit(msg.event, msg.data);
}

export const getIo = () => io;

export function attachIo(server: IOServer) {
  io = server;
}

export async function startBus(log: (m: string) => void = () => {}) {
  if (listener) return;
  const connect = async () => {
    const client = new pg.Client({ connectionString: config.databaseUrl });
    client.on('notification', (n) => {
      try {
        const parsed = JSON.parse(n.payload || '{}') as RtMessage & { src?: string };
        deliver(parsed);
      } catch {
        /* ignore malformed */
      }
    });
    client.on('error', (e) => {
      log(`realtime listener error: ${e.message}; reconnecting`);
      listener = null;
      setTimeout(() => connect().catch(() => {}), 2000);
    });
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    listener = client;
  };
  await connect();
}

export async function stopBus() {
  const l = listener;
  listener = null;
  if (l) await l.end().catch(() => {});
}

export async function publish(rooms: string | string[], event: string, data: unknown): Promise<void> {
  const msg: RtMessage = { rooms: Array.isArray(rooms) ? rooms : [rooms], event, data };
  const payload = JSON.stringify({ ...msg, src: instanceId });
  // NOTIFY payloads are limited to 8000 bytes; large payloads are delivered locally only.
  if (listener && Buffer.byteLength(payload) < 7900) {
    try {
      await pool.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]);
      return;
    } catch {
      /* fall through to local delivery */
    }
  }
  deliver(msg);
}

/** Collects events during a DB transaction; flushed only after COMMIT (transactional outbox). */
export class Outbox {
  private items: RtMessage[] = [];
  add(rooms: string | string[], event: string, data: unknown) {
    this.items.push({ rooms: Array.isArray(rooms) ? rooms : [rooms], event, data });
  }
  async flush() {
    const items = this.items;
    this.items = [];
    for (const m of items) await publish(m.rooms, m.event, m.data);
  }
}
