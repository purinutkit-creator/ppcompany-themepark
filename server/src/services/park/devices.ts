import { EVENTS, rooms } from '@kiosk/shared';
import { one, query } from '../../db/pool';
import { publish } from '../../lib/realtime';
import { getSettings } from '../../lib/settings';
import { emitGateHardwareEvent } from './hardware';
import { notify } from './notifications';

/** What a paired device is attached to (gate, scan point, store, locker bank) — drives which screen it opens. */
export async function deviceAssignment(deviceId: string) {
  const d = await one<any>(`SELECT id, branch_id, code, name, type, location, zone_id, config, status FROM devices WHERE id=$1`, [deviceId]);
  if (!d) return null;
  const gates = await query<any>(`SELECT g.id, g.code, g.number, g.name, g.direction, g.mode, gd.role FROM gate_devices gd JOIN gates g ON g.id=gd.gate_id WHERE gd.device_id=$1 ORDER BY g.number`, [deviceId]);
  const scanPoints = await query<any>(`SELECT sp.id, sp.code, sp.name, sp.ride_id, r.code AS ride_code, r.name AS ride_name FROM ride_scan_points sp JOIN rides r ON r.id=sp.ride_id WHERE sp.device_id=$1`, [deviceId]);
  const lockers = await query<any>(`SELECT id, code, bank FROM lockers WHERE device_id=$1 ORDER BY code`, [deviceId]);
  const branch = await one<any>(`SELECT id, code, name, timezone FROM branches WHERE id=$1`, [d.branch_id]);
  return { device: d, branch, gates, scanPoints, lockers };
}

export async function markDeviceSeen(deviceId: string, ip: string | null, version?: string | null) {
  const prev = await one<any>(`SELECT status, branch_id, type FROM devices WHERE id=$1`, [deviceId]);
  await query(`UPDATE devices SET status='ONLINE', last_seen_at=now(), ip=COALESCE($2, ip), app_version=COALESCE($3, app_version), last_error=NULL WHERE id=$1`, [deviceId, ip, version ?? null]);
  if (prev && prev.status !== 'ONLINE') {
    await publish([rooms.branchAdmin(prev.branch_id)], EVENTS.DEVICE_STATUS, { deviceId, status: 'ONLINE' });
    // Edge controllers coming back bring their gates back online.
    const gates = await query<any>(`SELECT gate_id FROM gate_devices WHERE device_id=$1 AND role='CONTROLLER'`, [deviceId]);
    for (const g of gates) await emitGateHardwareEvent(g.gate_id, 'ONLINE').catch(() => {});
  }
}

/** Background: devices silent for N minutes are OFFLINE (alert once); their controlled gates go OFFLINE. */
export async function deviceMaintenance() {
  const s = await getSettings();
  const rows = await query<any>(
    `UPDATE devices SET status='OFFLINE' WHERE status <> 'OFFLINE' AND is_active AND last_seen_at < now() - ($1 || ' minutes')::interval
     RETURNING id, code, name, type, branch_id`,
    [String(s.notification.deviceOfflineMinutes)],
  );
  for (const d of rows) {
    await publish([rooms.branchAdmin(d.branch_id)], EVENTS.DEVICE_STATUS, { deviceId: d.id, status: 'OFFLINE' });
    await notify({
      audience: 'STAFF', branchId: d.branch_id, type: d.type.startsWith('GATE') ? 'GATE_OFFLINE' : 'DEVICE_OFFLINE', severity: d.type.startsWith('GATE') ? 'CRITICAL' : 'WARNING',
      dedupeKey: `offline:${d.id}:${new Date().toISOString().slice(0, 13)}`,
      title: { th: `อุปกรณ์ออฟไลน์: ${d.name}`, en: `Device offline: ${d.name}`, zh: `设备离线：${d.name}` },
      body: { th: `${d.code} (${d.type})`, en: `${d.code} (${d.type})`, zh: `${d.code}（${d.type}）` },
      data: { deviceId: d.id },
    });
    const gates = await query<any>(`SELECT gate_id FROM gate_devices WHERE device_id=$1 AND role='CONTROLLER'`, [d.id]);
    for (const g of gates) await emitGateHardwareEvent(g.gate_id, 'OFFLINE').catch(() => {});
  }
  return rows.length;
}
