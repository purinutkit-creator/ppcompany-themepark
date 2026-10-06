import { buildApp } from './app';
import { config } from './config';
import { migrate } from './db/migrate';
import { pool } from './db/pool';
import { startBus, stopBus } from './lib/realtime';
import { getSettings } from './lib/settings';
import { setupSocket } from './socket';
import { autoCompleteReady, expireStaleOrders } from './services/orders';
import { printMaintenance } from './services/printing';
import { query } from './db/pool';
import { expireSales, reconcileFulfilment } from './services/park/sales';
import { bookingMaintenance } from './services/park/bookings';
import { endOfDayPresence, gateMaintenance } from './services/park/gates';
import { queueMaintenance } from './services/park/queues';
import { lockerMaintenance } from './services/park/lockers';
import { membershipMaintenance } from './services/park/members';
import { deviceMaintenance } from './services/park/devices';

async function main() {
  if (process.env.AUTO_MIGRATE !== 'false') await migrate((m) => console.log(m));
  const app = await buildApp();
  await startBus((m) => app.log.warn(m));
  const io = setupSocket(app);

  // Background maintenance (safe to run on every instance: all operations are idempotent / row-locked).
  const safe = (fn: () => Promise<unknown>) => () => void fn().catch((e) => app.log.error(e));
  const timers = [
    // Theme park background jobs (row-locked / idempotent → safe on every instance).
    setInterval(safe(gateMaintenance), 2_000),
    setInterval(safe(expireSales), 30_000),
    setInterval(safe(reconcileFulfilment), 60_000),
    setInterval(safe(queueMaintenance), 30_000),
    setInterval(safe(deviceMaintenance), 30_000),
    setInterval(safe(async () => {
      await bookingMaintenance();
      await endOfDayPresence();
      await lockerMaintenance();
    }), 5 * 60_000),
    setInterval(safe(membershipMaintenance), 60 * 60_000),
    setInterval(() => expireStaleOrders().catch((e) => app.log.error(e)), 30_000),
    setInterval(() => printMaintenance().catch((e) => app.log.error(e)), 5_000),
    setInterval(async () => {
      try {
        const s = await getSettings();
        await autoCompleteReady(s.order.autoCompleteReadyMinutes);
        await query(`UPDATE kiosks SET status='OFFLINE' WHERE status='ONLINE' AND last_seen_at < now() - interval '2 minutes'`);
        await query(`UPDATE print_agents SET status='OFFLINE' WHERE status='ONLINE' AND last_seen_at < now() - interval '2 minutes'`);
        await query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '2 days'`);
      } catch (e) {
        app.log.error(e);
      }
    }, 60_000),
  ];

  await app.listen({ port: config.port, host: config.host });
  void membershipMaintenance().catch(() => {});

  const shutdown = async () => {
    timers.forEach(clearInterval);
    io.close();
    await app.close();
    await stopBus();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
