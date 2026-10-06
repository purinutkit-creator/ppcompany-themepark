import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { EVENTS, rooms } from '@kiosk/shared';
import { one, query } from './db/pool';
import { agentFromToken, deviceFromToken, kioskFromToken, loadStaff, memberFromJwt, type JwtPayload } from './lib/auth';
import { markDeviceSeen } from './services/park/devices';
import { attachIo, publish } from './lib/realtime';
import { config } from './config';

/**
 * Socket.IO gateway. Every connection authenticates in the handshake and is placed in rooms:
 *  - staff:   branch rooms according to permissions (cashier / kitchen / admin / printers)
 *  - kiosk:   kiosk:<id>, branch kiosks + printers rooms
 *  - agent:   agent:<id>, branch printers room
 *  - display: branch queue room (public — only queue numbers are sent there)
 */
export function setupSocket(app: FastifyInstance) {
  const io = new Server(app.server, {
    cors: { origin: config.corsOrigins.length ? config.corsOrigins : false, credentials: true },
    pingInterval: 20000,
    pingTimeout: 20000,
  });
  attachIo(io);

  io.use(async (socket, next) => {
    try {
      const a = socket.handshake.auth ?? {};
      const deviceId = typeof a.deviceId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(a.deviceId) ? a.deviceId : null;
      socket.data.deviceId = deviceId;
      if (a.memberToken) {
        const m = await memberFromJwt(app.jwt.verify<JwtPayload>(a.memberToken));
        if (!m) return next(new Error('UNAUTHORIZED'));
        socket.data.kind = 'member';
        socket.data.accountId = m.accountId;
        socket.join([rooms.account(m.accountId), rooms.global]);
        return next();
      }
      if (a.bookingNo && a.bookingToken) {
        const b = await one<any>(`SELECT id, access_token, branch_id, sale_id FROM bookings WHERE booking_no=$1`, [String(a.bookingNo).toUpperCase()]);
        if (!b || b.access_token !== a.bookingToken) return next(new Error('UNAUTHORIZED'));
        socket.data.kind = 'booking';
        socket.join([rooms.booking(b.id), rooms.sale(b.sale_id), rooms.global]);
        return next();
      }
      if (a.deviceToken) {
        const dev = await deviceFromToken(a.deviceToken);
        if (!dev) return next(new Error('UNAUTHORIZED'));
        socket.data.kind = 'pdevice';
        socket.data.parkDeviceId = dev.id;
        socket.data.branchId = dev.branch_id;
        socket.data.deviceType = dev.type;
        const r = [rooms.parkDevice(dev.id), rooms.branchPublic(dev.branch_id), rooms.global, rooms.branchPrinters(dev.branch_id)];
        const gates = await query<any>(`SELECT gate_id FROM gate_devices WHERE device_id=$1`, [dev.id]);
        for (const g of gates) r.push(rooms.gate(g.gate_id));
        const sps = await query<any>(`SELECT id, ride_id FROM ride_scan_points WHERE device_id=$1`, [dev.id]);
        for (const sp of sps) r.push(rooms.scanPoint(sp.id), rooms.ride(sp.ride_id));
        if (['POS', 'COUNTER'].includes(dev.type)) r.push(rooms.branchCounter(dev.branch_id));
        if (dev.type === 'LOCKER_CONTROLLER') r.push(rooms.locker(dev.branch_id));
        if (dev.type === 'GATE_DISPLAY' || dev.type === 'GATE_SCANNER') r.push(rooms.branchGates(dev.branch_id));
        socket.join(r);
        return next();
      }
      if (a.display === 'park' && typeof a.branchCode === 'string') {
        const b = await one<any>(`SELECT id FROM branches WHERE code=$1 AND is_active`, [a.branchCode.toUpperCase()]);
        if (!b) return next(new Error('BRANCH_NOT_FOUND'));
        socket.data.kind = 'display';
        socket.data.branchId = b.id;
        socket.join([rooms.branchPublic(b.id), rooms.global]);
        return next();
      }
      if (a.token) {
        const payload = app.jwt.verify<JwtPayload>(a.token);
        if (payload.typ === 'member') return next(new Error('UNAUTHORIZED'));
        const staff = await loadStaff(payload.sub, payload.tv ?? 0);
        if (!staff) return next(new Error('UNAUTHORIZED'));
        let branchId = staff.branchId;
        if (!branchId && typeof a.branchId === 'string') branchId = a.branchId;
        if (!branchId) return next(new Error('BRANCH_REQUIRED'));
        socket.data.kind = 'staff';
        socket.data.staff = { id: staff.id, permissions: [...staff.permissions] };
        socket.data.kind = 'staff';
        socket.data.branchId = branchId;
        const p = staff.permissions;
        const r: string[] = [rooms.global];
        if (p.has('orders.view') || p.has('payments.verify')) r.push(rooms.branchCashier(branchId));
        if (p.has('kitchen.view')) r.push(rooms.branchKitchen(branchId), rooms.branchQueue(branchId));
        if (p.has('dashboard.view') || p.has('printers.manage')) r.push(rooms.branchAdmin(branchId));
        if (p.has('gates.view') || p.has('gates.operate')) r.push(rooms.branchGates(branchId));
        if (p.has('rides.view') || p.has('rides.operate')) r.push(rooms.branchRides(branchId));
        if (p.has('tickets.sell') || p.has('pos.sell') || p.has('payments.verify') || p.has('wallet.topup')) r.push(rooms.branchCounter(branchId));
        if (p.has('lockers.operate')) r.push(rooms.locker(branchId));
        r.push(rooms.branchPublic(branchId));
        if (deviceId) r.push(rooms.branchPrinters(branchId), rooms.device(deviceId));
        socket.join(r);
        return next();
      }
      if (a.kioskToken) {
        const kiosk = await kioskFromToken(a.kioskToken);
        if (!kiosk) return next(new Error('UNAUTHORIZED'));
        socket.data.kind = 'kiosk';
        socket.data.kioskId = kiosk.id;
        socket.data.branchId = kiosk.branch_id;
        socket.join([rooms.kiosk(kiosk.id), rooms.branchKiosks(kiosk.branch_id), rooms.branchPrinters(kiosk.branch_id), rooms.global]);
        if (deviceId) socket.join(rooms.device(deviceId));
        return next();
      }
      if (a.agentToken) {
        const agent = await agentFromToken(a.agentToken);
        if (!agent) return next(new Error('UNAUTHORIZED'));
        socket.data.kind = 'agent';
        socket.data.agentId = agent.id;
        socket.data.branchId = agent.branch_id;
        socket.join([rooms.agent(agent.id), rooms.branchPrinters(agent.branch_id), rooms.global]);
        return next();
      }
      if (a.display === 'queue' && typeof a.branchCode === 'string') {
        const b = await one<any>(`SELECT id FROM branches WHERE code=$1 AND is_active`, [a.branchCode]);
        if (!b) return next(new Error('BRANCH_NOT_FOUND'));
        socket.data.kind = 'display';
        socket.data.branchId = b.id;
        socket.join([rooms.branchQueue(b.id), rooms.global]);
        return next();
      }
      next(new Error('UNAUTHORIZED'));
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', async (socket) => {
    const d = socket.data;
    // Screens watching a specific card / sale / gate / ride (POS card profile, ride scanner awaiting payment…).
    socket.on('watch', async (w: { kind?: string; id?: string } = {}, ack?: (r: unknown) => void) => {
      try {
        const id = typeof w.id === 'string' && /^[0-9a-f-]{36}$/i.test(w.id) ? w.id : null;
        if (!id || !['account', 'sale', 'gate', 'ride', 'scanpoint'].includes(String(w.kind))) return ack?.({ ok: false });
        const perms: string[] = d.staff?.permissions ?? [];
        const isStaff = d.kind === 'staff';
        const isDevice = d.kind === 'pdevice' || d.kind === 'kiosk';
        if (!isStaff && !isDevice) return ack?.({ ok: false });
        if (w.kind === 'account' && isStaff && !perms.some((p: string) => ['cards.view', 'pos.sell', 'tickets.sell', 'wallet.view', 'members.view'].includes(p))) return ack?.({ ok: false });
        if (w.kind === 'account' && isDevice) {
          const own = await one(`SELECT 1 FROM customer_accounts WHERE id=$1 AND (branch_id=$2 OR branch_id IS NULL OR kind='MEMBER')`, [id, d.branchId]);
          if (!own) return ack?.({ ok: false });
        }
        const room = w.kind === 'account' ? rooms.account(id) : w.kind === 'sale' ? rooms.sale(id) : w.kind === 'gate' ? rooms.gate(id) : w.kind === 'ride' ? rooms.ride(id) : rooms.scanPoint(id);
        await socket.join(room);
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false });
      }
    });
    socket.on('unwatch', (w: { kind?: string; id?: string } = {}) => {
      if (typeof w.id !== 'string') return;
      const room = w.kind === 'account' ? rooms.account(w.id) : w.kind === 'sale' ? rooms.sale(w.id) : w.kind === 'gate' ? rooms.gate(w.id) : w.kind === 'ride' ? rooms.ride(w.id) : rooms.scanPoint(w.id);
      void socket.leave(room);
    });
    if (d.kind === 'pdevice') {
      await markDeviceSeen(d.parkDeviceId, socket.handshake.address ?? null).catch(() => {});
      socket.on('heartbeat', (info: { version?: string } = {}) => void markDeviceSeen(d.parkDeviceId, socket.handshake.address ?? null, typeof info?.version === 'string' ? info.version.slice(0, 40) : null).catch(() => {}));
    }
    if (d.kind === 'kiosk') {
      await query(`UPDATE kiosks SET status='ONLINE', last_seen_at=now() WHERE id=$1`, [d.kioskId]);
      await publish(rooms.branchAdmin(d.branchId), EVENTS.KIOSK_STATUS, { kioskId: d.kioskId, status: 'ONLINE' });
      socket.on('heartbeat', async (info: { version?: string } = {}) => {
        await query(`UPDATE kiosks SET status='ONLINE', last_seen_at=now(), app_version=COALESCE($2, app_version) WHERE id=$1`, [
          d.kioskId,
          typeof info?.version === 'string' ? info.version.slice(0, 40) : null,
        ]).catch(() => {});
      });
    }
    if (d.kind === 'agent') {
      await query(`UPDATE print_agents SET status='ONLINE', last_seen_at=now() WHERE id=$1`, [d.agentId]);
      await publish(rooms.branchAdmin(d.branchId), EVENTS.PRINTER_STATUS, { agentId: d.agentId, agentStatus: 'ONLINE' });
      socket.on('heartbeat', async (info: { version?: string; hostname?: string } = {}) => {
        await query(`UPDATE print_agents SET status='ONLINE', last_seen_at=now(), version=COALESCE($2,version), hostname=COALESCE($3,hostname) WHERE id=$1`, [
          d.agentId,
          typeof info?.version === 'string' ? info.version.slice(0, 40) : null,
          typeof info?.hostname === 'string' ? info.hostname.slice(0, 100) : null,
        ]).catch(() => {});
      });
    }
    socket.on('disconnect', async () => {
      if (d.kind === 'kiosk') {
        const still = (await io.in(rooms.kiosk(d.kioskId)).fetchSockets()).length;
        if (!still) {
          await query(`UPDATE kiosks SET status='OFFLINE' WHERE id=$1`, [d.kioskId]).catch(() => {});
          await publish(rooms.branchAdmin(d.branchId), EVENTS.KIOSK_STATUS, { kioskId: d.kioskId, status: 'OFFLINE' }).catch(() => {});
        }
      }
      if (d.kind === 'agent') {
        const still = (await io.in(rooms.agent(d.agentId)).fetchSockets()).length;
        if (!still) {
          await query(`UPDATE print_agents SET status='OFFLINE' WHERE id=$1`, [d.agentId]).catch(() => {});
          await query(`UPDATE printers SET status='OFFLINE' WHERE agent_id=$1 OR (executor='AGENT' AND agent_id IS NULL AND branch_id=$2 AND NOT EXISTS (SELECT 1 FROM print_agents WHERE branch_id=$2 AND status='ONLINE'))`, [d.agentId, d.branchId]).catch(() => {});
          await publish([rooms.branchAdmin(d.branchId), rooms.branchCashier(d.branchId)], EVENTS.PRINTER_STATUS, { agentId: d.agentId, agentStatus: 'OFFLINE' }).catch(() => {});
        }
      }
    });
  });
  return io;
}
