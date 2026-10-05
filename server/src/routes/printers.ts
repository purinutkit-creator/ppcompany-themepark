import type { FastifyInstance, FastifyRequest } from 'fastify';
import { EVENTS, rooms } from '@kiosk/shared';
import { one, query } from '../db/pool';
import { audit } from '../lib/audit';
import { branchOf, requireDeviceOrStaff, requireStaff } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { getIo, publish } from '../lib/realtime';
import { newDeviceToken } from '../lib/tokens';
import { parse, uuid, z } from '../lib/validate';
import { cancelJob, claimJob, pendingJobsFor, reportJob, retryJob, testPrint } from '../services/printing';

const printerSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(['RECEIPT', 'KITCHEN', 'BEVERAGE', 'DESSERT', 'OTHER']),
  connection: z.enum(['USB', 'BLUETOOTH', 'BLE', 'LAN', 'ETHERNET', 'WIFI']),
  executor: z.enum(['AGENT', 'BROWSER', 'ANDROID', 'DESKTOP']).default('AGENT'),
  driver: z.string().max(30).default('ESCPOS'),
  host: z.string().max(120).nullish(),
  port: z.coerce.number().int().min(1).max(65535).nullish(),
  device_path: z.string().max(200).nullish(),
  device_id: z.string().max(200).nullish(),
  agent_id: uuid.nullish(),
  host_device_id: z.string().max(100).nullish(),
  station_id: uuid.nullish(),
  paper_width: z.union([z.literal(58), z.literal(80)]).default(80),
  dots_per_line: z.coerce.number().int().min(200).max(1000).nullish(),
  chars_per_line: z.coerce.number().int().min(20).max(80).nullish(),
  raster_mode: z.enum(['AUTO', 'TEXT', 'RASTER']).default('AUTO'),
  cut: z.boolean().default(true),
  open_drawer: z.boolean().default(false),
  is_default: z.boolean().default(false),
  auto_reconnect: z.boolean().default(true),
  is_enabled: z.boolean().default(true),
});
const COLS = Object.keys(printerSchema.shape);

/** Identify the executor making a request: agent, kiosk device or staff browser device. */
function executorOf(req: FastifyRequest) {
  const deviceId = (req.headers['x-device-id'] as string) || '';
  if (req.agent) return { key: `agent:${req.agent.id}`, branchId: req.agent.branch_id, agentId: req.agent.id, deviceId: null as string | null };
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(deviceId)) throw badRequest('DEVICE_ID_REQUIRED', 'X-Device-Id header required');
  const branchId = req.kiosk?.branch_id ?? req.staff?.branchId ?? ((req.headers['x-branch-id'] as string) || null);
  return { key: `device:${deviceId}`, branchId, agentId: null, deviceId };
}

async function executorPrinters(req: FastifyRequest) {
  const ex = executorOf(req);
  if (ex.agentId) {
    return query<any>(
      `SELECT * FROM printers WHERE executor='AGENT' AND is_enabled AND (agent_id=$1 OR (agent_id IS NULL AND branch_id=$2)) ORDER BY name`,
      [ex.agentId, ex.branchId],
    );
  }
  return query<any>(
    `SELECT * FROM printers WHERE executor <> 'AGENT' AND is_enabled AND host_device_id=$1 AND ($2::uuid IS NULL OR branch_id=$2) ORDER BY name`,
    [ex.deviceId, ex.branchId],
  );
}

async function assertOwnsJob(req: FastifyRequest, jobId: string) {
  const job = await one<any>(`SELECT printer_id FROM print_jobs WHERE id=$1`, [jobId]);
  if (!job) throw notFound('Print job');
  const mine = await executorPrinters(req);
  if (!mine.some((p) => p.id === job.printer_id)) throw forbidden('NOT_YOUR_PRINTER', 'This executor does not own the printer');
}

export default async function printerRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- printer management
  app.get('/printers', { preHandler: requireStaff() }, async (req) =>
    query(
      `SELECT p.*, a.name AS agent_name, a.status AS agent_status, s.name AS station_name,
              (SELECT COUNT(*)::int FROM print_jobs j WHERE j.printer_id=p.id AND j.status IN ('QUEUED','RETRYING','PRINTING')) AS pending_jobs,
              (SELECT COUNT(*)::int FROM print_jobs j WHERE j.printer_id=p.id AND j.status='FAILED' AND j.created_at > now() - interval '24 hours') AS failed_jobs
         FROM printers p LEFT JOIN print_agents a ON a.id=p.agent_id LEFT JOIN kitchen_stations s ON s.id=p.station_id
        WHERE p.branch_id=$1 ORDER BY p.type, p.name`,
      [branchOf(req)],
    ),
  );

  app.post('/printers', { preHandler: requireStaff('printers.manage') }, async (req) => {
    const b = parse(printerSchema, req.body);
    const branchId = branchOf(req);
    if (b.is_default) await query(`UPDATE printers SET is_default=false WHERE branch_id=$1 AND type=$2`, [branchId, b.type]);
    const vals = COLS.map((c) => (b as any)[c] ?? null);
    const row = await one<any>(
      `INSERT INTO printers (branch_id, ${COLS.join(',')}) VALUES ($1, ${COLS.map((_, i) => `$${i + 2}`).join(',')}) RETURNING *`,
      [branchId, ...vals],
    );
    await audit(req, { action: 'PRINTER_CREATE', entity: 'printer', entityId: row.id, newValue: row });
    await publish(rooms.branchPrinters(branchId), EVENTS.PRINTER_STATUS, { printerId: row.id, changed: true });
    return row;
  });

  app.put('/printers/:id', { preHandler: requireStaff('printers.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(printerSchema, req.body);
    const old = await one<any>(`SELECT * FROM printers WHERE id=$1`, [id]);
    if (!old) throw notFound('Printer');
    if (b.is_default) await query(`UPDATE printers SET is_default=false WHERE branch_id=$1 AND type=$2 AND id<>$3`, [old.branch_id, b.type, id]);
    const row = await one<any>(
      `UPDATE printers SET ${COLS.map((c, i) => `${c}=$${i + 2}`).join(', ')} WHERE id=$1 RETURNING *`,
      [id, ...COLS.map((c) => (b as any)[c] ?? null)],
    );
    await audit(req, { action: 'PRINTER_UPDATE', entity: 'printer', entityId: id, oldValue: old, newValue: row });
    await publish(rooms.branchPrinters(old.branch_id), EVENTS.PRINTER_STATUS, { printerId: id, changed: true });
    return row;
  });

  /** Quick actions: rename / set default / connect (enable) / disconnect (disable). */
  app.patch('/printers/:id', { preHandler: requireStaff('printers.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ name: z.string().min(1).max(80).optional(), is_default: z.boolean().optional(), is_enabled: z.boolean().optional(), auto_reconnect: z.boolean().optional(), host_device_id: z.string().max(100).nullish() }), req.body);
    const old = await one<any>(`SELECT * FROM printers WHERE id=$1`, [id]);
    if (!old) throw notFound('Printer');
    if (b.is_default) await query(`UPDATE printers SET is_default=false WHERE branch_id=$1 AND type=$2 AND id<>$3`, [old.branch_id, old.type, id]);
    const row = await one<any>(
      `UPDATE printers SET name=COALESCE($2,name), is_default=COALESCE($3,is_default), is_enabled=COALESCE($4,is_enabled), auto_reconnect=COALESCE($5,auto_reconnect),
         host_device_id = CASE WHEN $6::boolean THEN $7 ELSE host_device_id END,
         status = CASE WHEN $4 = false THEN 'OFFLINE' ELSE status END WHERE id=$1 RETURNING *`,
      [id, b.name ?? null, b.is_default ?? null, b.is_enabled ?? null, b.auto_reconnect ?? null, b.host_device_id !== undefined, b.host_device_id ?? null],
    );
    await audit(req, { action: 'PRINTER_UPDATE', entity: 'printer', entityId: id, oldValue: old, newValue: b });
    await publish([rooms.branchPrinters(old.branch_id), rooms.branchAdmin(old.branch_id)], EVENTS.PRINTER_STATUS, { printerId: id, changed: true, status: row.status });
    return row;
  });

  app.delete('/printers/:id', { preHandler: requireStaff('printers.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const old = await one<any>(`DELETE FROM printers WHERE id=$1 RETURNING *`, [id]);
    if (!old) throw notFound('Printer');
    await audit(req, { action: 'PRINTER_DELETE', entity: 'printer', entityId: id, oldValue: old });
    await publish(rooms.branchPrinters(old.branch_id), EVENTS.PRINTER_STATUS, { printerId: id, changed: true });
    return { ok: true };
  });

  app.post('/printers/:id/test', { preHandler: requireStaff('printers.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const job = await testPrint(id, req.staff!.id);
    await audit(req, { action: 'PRINTER_TEST', entity: 'printer', entityId: id });
    return job;
  });

  // ---------------------------------------------------------------- print agents
  app.get('/agents', { preHandler: requireStaff('printers.manage') }, async (req) =>
    query(`SELECT id, branch_id, name, status, version, hostname, last_seen_at, created_at FROM print_agents WHERE branch_id=$1 ORDER BY name`, [branchOf(req)]),
  );
  app.post('/agents', { preHandler: requireStaff('printers.manage') }, async (req) => {
    const b = parse(z.object({ name: z.string().min(1).max(80) }), req.body);
    const id = crypto.randomUUID();
    const t = newDeviceToken(id);
    await query(`INSERT INTO print_agents (id, branch_id, name, token_hash) VALUES ($1,$2,$3,$4)`, [id, branchOf(req), b.name, t.hash]);
    await audit(req, { action: 'PRINT_AGENT_CREATE', entity: 'print_agent', entityId: id, newValue: { name: b.name } });
    return { id, name: b.name, token: t.token };
  });
  app.post('/agents/:id/rotate', { preHandler: requireStaff('printers.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const t = newDeviceToken(id);
    const r = await one(`UPDATE print_agents SET token_hash=$2 WHERE id=$1 RETURNING id`, [id, t.hash]);
    if (!r) throw notFound('Agent');
    await audit(req, { action: 'PRINT_AGENT_ROTATE', entity: 'print_agent', entityId: id });
    return { id, token: t.token };
  });
  app.delete('/agents/:id', { preHandler: requireStaff('printers.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await query(`DELETE FROM print_agents WHERE id=$1`, [id]);
    await audit(req, { action: 'PRINT_AGENT_DELETE', entity: 'print_agent', entityId: id });
    return { ok: true };
  });
  /** Ask a connected agent to discover printers (network scan :9100, USB / serial devices). */
  app.post('/agents/:id/scan', { preHandler: requireStaff('printers.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ kind: z.enum(['network', 'usb', 'bluetooth', 'all']).default('all'), subnet: z.string().max(40).optional() }), req.body ?? {});
    const io = getIo();
    if (!io) throw badRequest('REALTIME_UNAVAILABLE');
    try {
      const replies = await io.in(rooms.agent(id)).timeout(25_000).emitWithAck(EVENTS.AGENT_COMMAND, { command: 'scan', ...b });
      if (!replies.length) throw badRequest('AGENT_OFFLINE', 'Print agent is not connected');
      return replies[0];
    } catch (e: any) {
      if (e?.code) throw e;
      throw badRequest('AGENT_TIMEOUT', 'Print agent did not respond');
    }
  });

  // ---------------------------------------------------------------- print queue
  app.get('/jobs', { preHandler: requireStaff('printers.manage') }, async (req) => {
    const q = parse(z.object({ status: z.string().optional(), printerId: uuid.optional(), limit: z.coerce.number().int().max(500).default(100) }), req.query);
    return query(
      `SELECT j.id, j.order_id, j.order_number, j.printer_id, j.document_type, j.copy_no, j.is_reprint, j.status, j.attempts, j.max_attempts,
              j.last_error, j.claimed_by, j.created_at, j.printed_at, j.next_retry_at, p.name AS printer_name, p.type AS printer_type
         FROM print_jobs j LEFT JOIN printers p ON p.id=j.printer_id
        WHERE j.branch_id=$1 AND ($2::text IS NULL OR j.status = ANY(string_to_array($2, ','))) AND ($3::uuid IS NULL OR j.printer_id=$3)
        ORDER BY j.created_at DESC LIMIT $4`,
      [branchOf(req), q.status ?? null, q.printerId ?? null, q.limit],
    );
  });
  app.post('/jobs/:id/retry', { preHandler: requireStaff() }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    if (!req.staff!.permissions.has('printers.manage') && !req.staff!.permissions.has('orders.reprint') && !req.staff!.permissions.has('payments.verify')) throw forbidden();
    const j = await retryJob(id);
    await audit(req, { action: 'PRINT_RETRY', entity: 'print_job', entityId: id, orderId: j.order_id });
    return j;
  });
  app.post('/jobs/:id/cancel', { preHandler: requireStaff('printers.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await cancelJob(id);
    await audit(req, { action: 'PRINT_CANCEL', entity: 'print_job', entityId: id });
    return { ok: true };
  });

  // ---------------------------------------------------------------- executor API (agent / kiosk / browser device)
  app.get('/executor/printers', { preHandler: requireDeviceOrStaff }, async (req) => executorPrinters(req));
  app.get('/executor/jobs', { preHandler: requireDeviceOrStaff }, async (req) => {
    const printers = await executorPrinters(req);
    return pendingJobsFor(printers.map((p) => p.id));
  });
  app.post('/executor/jobs/:id/claim', { preHandler: requireDeviceOrStaff }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await assertOwnsJob(req, id);
    const job = await claimJob(id, executorOf(req).key);
    if (!job) return { claimed: false };
    const printer = await one(`SELECT * FROM printers WHERE id=$1`, [job.printer_id]);
    return { claimed: true, job, printer };
  });
  app.post('/executor/jobs/:id/result', { preHandler: requireDeviceOrStaff }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ ok: z.boolean(), error: z.string().max(500).optional() }), req.body);
    await assertOwnsJob(req, id);
    return reportJob(id, executorOf(req).key, b);
  });
  app.post('/executor/printers/:id/status', { preHandler: requireDeviceOrStaff }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ status: z.enum(['CONNECTED', 'OFFLINE', 'ERROR']), error: z.string().max(500).nullish() }), req.body);
    const mine = await executorPrinters(req);
    const p = mine.find((x) => x.id === id);
    if (!p) throw forbidden('NOT_YOUR_PRINTER');
    if (p.status !== b.status || (p.last_error ?? null) !== (b.error ?? null)) {
      await query(`UPDATE printers SET status=$2, last_error=$3, last_seen_at=now() WHERE id=$1`, [id, b.status, b.error ?? null]);
      await publish([rooms.branchAdmin(p.branch_id), rooms.branchCashier(p.branch_id)], EVENTS.PRINTER_STATUS, { printerId: id, status: b.status, error: b.error ?? null, name: p.name });
    } else await query(`UPDATE printers SET last_seen_at=now() WHERE id=$1`, [id]);
    return { ok: true };
  });
}
