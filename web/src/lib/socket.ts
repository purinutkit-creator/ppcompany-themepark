import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { deviceId } from './device';

export type SocketAuth =
  | { token: string; branchId?: string | null }
  | { kioskToken: string }
  | { display: 'queue'; branchCode: string };

/** Connect a Socket.IO client with auth; reconnects automatically and exposes connection state. */
export function useRealtime(auth: SocketAuth | null) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const key = auth ? JSON.stringify(auth) : '';
  useEffect(() => {
    if (!auth) return;
    const s = io({ path: '/socket.io', auth: { ...auth, deviceId: deviceId() }, transports: ['websocket', 'polling'], reconnectionDelayMax: 5000 });
    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    s.on('connect_error', () => setConnected(false));
    setSocket(s);
    return () => {
      s.close();
      setSocket(null);
      setConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { socket, connected };
}

/** Subscribe to one or more events; handler always sees latest closure. */
export function useSocketEvent(socket: Socket | null, events: string | string[], handler: (data: any, event: string) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  const list = Array.isArray(events) ? events : [events];
  const k = list.join(',');
  useEffect(() => {
    if (!socket) return;
    const fns = list.map((ev) => {
      const fn = (d: any) => ref.current(d, ev);
      socket.on(ev, fn);
      return [ev, fn] as const;
    });
    return () => fns.forEach(([ev, fn]) => socket.off(ev, fn));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, k]);
}

/** Re-run a callback whenever the socket (re)connects — used to resync state after outages. */
export function useOnReconnect(socket: Socket | null, fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!socket) return;
    const h = () => ref.current();
    socket.on('connect', h);
    return () => {
      socket.off('connect', h);
    };
  }, [socket]);
}
