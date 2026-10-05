import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { EVENTS, rooms } from '@kiosk/shared';
import { one, query } from './db/pool';
import { agentFromToken, kioskFromToken, loadStaff, type JwtPayload } from './lib/auth';
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
      if (a.token) {
        const payload = app.jwt.verify<JwtPayload>(a.token);
        const staff = await loadStaff(payload.sub, payload.tv ?? 0);
        if (!staff) return next(new Error('UNAUTHORIZED'));
        let branchId = staff.branchId;
        if (!branchId && typeof a.branchId === 'string') branchId = a.branchId;
        if (!branchId) return next(new Error('BRANCH_REQUIRED'));
        socket.data.kind = 'staff';
        socket.data.staff = { id: staff.id, permissions: [...staff.permissions] };
        socket.data.branchId = branchId;
        const p = staff.permissions;
        const r: string[] = [rooms.global];
        if (p.has('orders.view') || p.has('payments.verify')) r.push(rooms.branchCashier(branchId));
        if (p.has('kitchen.view')) r.push(rooms.branchKitchen(branchId), rooms.branchQueue(branchId));
        if (p.has('dashboard.view') || p.has('printers.manage')) r.push(rooms.branchAdmin(branchId));
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
