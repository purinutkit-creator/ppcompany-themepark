import { get, set, del, keys } from 'idb-keyval';

/** Local persistence for kiosk offline/degraded mode (IndexedDB). */
export const cache = {
  async save<T>(key: string, value: T) {
    try {
      await set(`cache:${key}`, { at: Date.now(), value });
    } catch {
      /* storage full / private mode */
    }
  },
  async load<T>(key: string): Promise<{ at: number; value: T } | null> {
    try {
      return ((await get(`cache:${key}`)) as any) ?? null;
    } catch {
      return null;
    }
  },
};

export interface OutboxOrder {
  clientOrderId: string;
  offlineRef: string;
  payload: any;
  createdAt: number;
  status: 'SYNC_PENDING' | 'SYNCED' | 'FAILED';
  orderNumber?: string;
  error?: string;
  attempts: number;
}

export const outbox = {
  async add(o: OutboxOrder) {
    await set(`outbox:${o.clientOrderId}`, o);
  },
  async update(id: string, patch: Partial<OutboxOrder>) {
    const cur = (await get(`outbox:${id}`)) as OutboxOrder | undefined;
    if (cur) await set(`outbox:${id}`, { ...cur, ...patch });
  },
  async list(): Promise<OutboxOrder[]> {
    const ks = (await keys()).filter((k) => String(k).startsWith('outbox:'));
    const items = await Promise.all(ks.map((k) => get(k)));
    return (items.filter(Boolean) as OutboxOrder[]).sort((a, b) => a.createdAt - b.createdAt);
  },
  async remove(id: string) {
    await del(`outbox:${id}`);
  },
};

export function offlineRef(kioskCode: string) {
  const n = Math.floor(Math.random() * 9000 + 1000);
  return `${kioskCode.replace(/[^A-Z0-9]/gi, '').slice(-3)}-OFF-${n}`;
}
