import {
  canTransition,
  EVENTS,
  GATE_SCANNABLE,
  localNow,
  parseCredentialPayload,
  rooms,
  type CheckResult,
  type CustomerSnapshot,
  type GateState,
} from '@kiosk/shared';
import { one, query, tx, type Db, type Tx } from '../../db/pool';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { Outbox } from '../../lib/realtime';
import { branchInfo, parkSettings, type ParkActor } from './common';
import { credentialProfile, credentialStatusReason, effectiveStatus, isBlacklisted, resolveScan, snapshotFrom, ticketsForCredential, touchCredential } from './credentials';
import { emitGateHardwareEvent, gateController, onGateHardwareEvent, simulator, type HardwareEvent } from './hardware';
import { notify } from './notifications';

const STATE_TIMEOUT_EVENTS = ['APPROVED', 'OPENING', 'OPEN', 'CLOSING', 'DENIED', 'WAITING_APPROVAL', 'VALIDATING', 'SCANNING'];

async function lockGate(c: Tx, gateId: string) {
  const g = await one<any>(`SELECT * FROM gates WHERE id=$1 FOR UPDATE`, [gateId], c);
  if (!g) throw notFound('Gate');
  return g;
}

/** Validated state change (the state machine refuses e.g. OPEN while already OPEN). */
async function setState(c: Tx, g: any, to: GateState, out: Outbox, extra: { scanId?: string | null; error?: string | null } = {}) {
  if (!canTransition(g.state, to)) throw conflict('GATE_INVALID_STATE', `Gate ${g.code}: ${g.state} → ${to} not allowed`);
  const row = await one<any>(
    `UPDATE gates SET state=$2, state_since=clock_timestamp(), state_version=state_version+1,
        current_scan_id = CASE WHEN $3::boolean THEN $4::uuid ELSE current_scan_id END, last_error = CASE WHEN $2='ERROR' THEN $5 ELSE last_error END
      WHERE id=$1 RETURNING *`,
    [g.id, to, extra.scanId !== undefined, extra.scanId ?? null, extra.error ?? null],
    c,
  );
  Object.assign(g, row);
  out.add([rooms.gate(g.id), rooms.branchGates(g.branch_id), rooms.branchAdmin(g.branch_id)], EVENTS.GATE_STATE, {
    gateId: g.id, code: g.code, number: g.number, state: to, stateSince: row.state_since, scanId: row.current_scan_id, version: row.state_version, error: extra.error ?? null,
  });
  return row;
}

export async function gateSummary(db: Db, gateId: string) {
  return one<any>(
    `SELECT g.*, z.name AS zone_name, u.name AS operator_name,
            (SELECT row_to_json(s) FROM (SELECT gs.id, gs.result, gs.reason_code, gs.customer, gs.checks, gs.created_at, gs.direction, gs.code FROM gate_scans gs WHERE gs.id = COALESCE(g.current_scan_id,
               (SELECT id FROM gate_scans WHERE gate_id=g.id ORDER BY created_at DESC LIMIT 1))) s) AS last_scan
       FROM gates g LEFT JOIN zones z ON z.id=g.zone_id LEFT JOIN users u ON u.id=g.operator_id WHERE g.id=$1`,
    [gateId],
    db,
  );
}

export interface GateScanCtx {
  source?: 'CAMERA' | 'USB' | 'RFID' | 'MANUAL' | 'API';
  deviceId?: string | null;
  staffId?: string | null;
  direction?: 'ENTRY' | 'EXIT' | null;
}

interface Decision {
  ok: boolean;
  reason: string | null;
  checks: CheckResult[];
  ticket: any | null;
  credential: any | null;
  snapshot: CustomerSnapshot;
  duplicate: { firstGate: string | null; firstAt: string | null } | null;
  security: { type: string; severity: string; data: Record<string, unknown> } | null;
}

const fail = (checks: CheckResult[], key: string, reason: string, detail?: string | null) => {
  checks.push({ key, ok: false, detail: detail ?? null });
  return reason;
};

/** Evaluate one ticket for entry at this gate today. Returns null when it passes. */
async function ticketEntryFailure(c: Tx, t: any, gate: any, today: string, nowTime: string, checks: CheckResult[], settings: any): Promise<{ reason: string; duplicate?: any } | null> {
  const local: CheckResult[] = [];
  const done = (reason: string, dup?: any) => {
    checks.push(...local);
    return { reason, duplicate: dup };
  };
  local.push({ key: 'TICKET_FOUND', ok: true, detail: t.ticket_no });
  if (t.branch_id !== gate.branch_id) return done(fail(local, 'BRANCH', 'WRONG_BRANCH'));
  if (t.status === 'UNPAID' || t.status === 'PAID') return done(fail(local, 'PAYMENT', t.status === 'UNPAID' ? 'NOT_PAID' : 'NOT_ACTIVATED'));
  local.push({ key: 'PAYMENT', ok: true });
  const from = String(t.valid_from).slice(0, 10);
  const to = String(t.valid_to).slice(0, 10);
  if (today < from) return done(fail(local, 'VISIT_DATE', from === to ? 'WRONG_DATE' : 'NOT_YET_VALID', from));
  if (today > to) return done(fail(local, 'VISIT_DATE', from === to ? 'WRONG_DATE' : 'TICKET_EXPIRED', to));
  local.push({ key: 'VISIT_DATE', ok: true, detail: from === to ? from : `${from} – ${to}` });
  if (t.status === 'CANCELLED') return done(fail(local, 'ACTIVE', 'CANCELLED'));
  if (t.status === 'REFUNDED') return done(fail(local, 'ACTIVE', 'REFUNDED'));
  if (t.status === 'EXPIRED') return done(fail(local, 'ACTIVE', 'TICKET_EXPIRED'));
  if (t.status === 'USED') return done(fail(local, 'ACTIVE', 'ALREADY_USED'));
  local.push({ key: 'ACTIVE', ok: true });
  local.push({ key: 'BRANCH', ok: true });
  if (settings.gate.antiPassback && t.presence !== 'OUTSIDE') {
    const first = await one<any>(
      `SELECT g.code, e.passed_at, e.approved_at FROM entry_logs e LEFT JOIN gates g ON g.id=e.gate_id
        WHERE e.ticket_id=$1 AND e.direction='ENTRY' AND e.status IN ('CONFIRMED','PENDING_PASSAGE') ORDER BY e.created_at DESC LIMIT 1`,
      [t.id],
      c,
    );
    return done(fail(local, 'NOT_INSIDE', 'ALREADY_INSIDE', first?.code ?? null), { firstGate: first?.code ?? null, firstAt: first?.passed_at ?? first?.approved_at ?? null });
  }
  local.push({ key: 'NOT_INSIDE', ok: true });
  const usage = await query<any>(`SELECT visit_date::text AS d, entries FROM ticket_usage_days WHERE ticket_id=$1`, [t.id], c);
  const todayUse = usage.find((u) => u.d === today);
  if (!t.reentry && todayUse && todayUse.entries > 0) return done(fail(local, 'NOT_USED', 'ALREADY_USED'));
  if (!t.reentry && t.entry_count > 0 && t.days_allowed === 1) return done(fail(local, 'NOT_USED', 'ALREADY_USED'));
  if (t.entries_per_day != null && todayUse && todayUse.entries >= t.entries_per_day) return done(fail(local, 'NOT_USED', 'ENTRIES_EXHAUSTED'));
  if (!todayUse && usage.length >= t.days_allowed) return done(fail(local, 'NOT_USED', 'DAYS_EXHAUSTED'));
  local.push({ key: 'NOT_USED', ok: true });
  if (t.time_start && t.time_end) {
    const s = String(t.time_start).slice(0, 5);
    const e = String(t.time_end).slice(0, 5);
    if (!(nowTime >= s && nowTime < e)) return done(fail(local, 'TIME_WINDOW', 'OUTSIDE_TIME', `${s}–${e}`));
    local.push({ key: 'TIME_WINDOW', ok: true, detail: `${s}–${e}` });
  }
  if (gate.zone_id && t.zone_ids?.length && !t.zone_ids.includes(gate.zone_id)) return done(fail(local, 'ZONE', 'ZONE_NOT_ALLOWED'));
  checks.push(...local);
  return null;
}

async function decideEntry(c: Tx, gate: any, raw: string, settings: any): Promise<Decision> {
  const checks: CheckResult[] = [];
  const b = await branchInfo(gate.branch_id, c);
  const now = localNow(new Date(), b.timezone);
  const empty = { ticket: null, snapshot: {}, duplicate: null, security: null };
  const res = await resolveScan(raw, c);
  if (!res.ok) {
    checks.push({ key: 'CODE_VALID', ok: false });
    const sec = res.reason === 'FORGED_CODE' ? { type: 'FORGED_TOKEN', severity: 'CRITICAL', data: { code: res.code } } : res.reason === 'QR_ROTATED' ? { type: 'REVOKED_CREDENTIAL', severity: 'WARNING', data: { code: res.code } } : null;
    return { ...empty, ok: false, reason: res.reason ?? 'INVALID_CODE', checks, credential: res.credential ?? null, security: sec };
  }
  checks.push({ key: 'CODE_VALID', ok: true });
  const cred = res.credential;
  const st = await effectiveStatus(c, cred);
  const profile = await credentialProfile(c, cred.id);
  const reasonByStatus = credentialStatusReason(st);
  if (reasonByStatus && !(cred.type === 'QR_TICKET' && st === 'NEW')) {
    checks.push({ key: 'CREDENTIAL', ok: false, detail: st });
    const sec = ['LOST', 'BLOCKED', 'REPLACED'].includes(st) ? { type: 'REVOKED_CREDENTIAL', severity: 'WARNING', data: { code: cred.code, status: st } } : null;
    return { ...empty, ok: false, reason: reasonByStatus, checks, credential: cred, snapshot: snapshotFrom(profile), security: sec };
  }
  checks.push({ key: 'CREDENTIAL', ok: true, detail: cred.code });
  if (await isBlacklisted(c, cred, gate.branch_id)) {
    checks.push({ key: 'BLACKLIST', ok: false });
    return { ...empty, ok: false, reason: 'BLACKLISTED', checks, credential: cred, snapshot: snapshotFrom(profile), security: { type: 'BLACKLISTED', severity: 'CRITICAL', data: { code: cred.code } } };
  }
  const allowAccount = settings.gate.allowMemberCardEntry && settings.booking.memberCardEntry;
  const tickets = (await ticketsForCredential(c, cred, { includeAccount: allowAccount })).filter((t) => t.package_kind === 'ADMISSION');
  if (!tickets.length) {
    checks.push({ key: 'TICKET_FOUND', ok: false });
    return { ...empty, ok: false, reason: ['MEMBER_CARD', 'DIGITAL_CARD'].includes(cred.type) ? 'NOT_A_TICKET' : 'NO_TICKET', checks, credential: cred, snapshot: snapshotFrom(profile) };
  }
  // Prefer tickets valid today and not inside; evaluate until one passes.
  const ranked = [...tickets].sort((a, b) => score(b, now.date) - score(a, now.date));
  let firstFailure: { reason: string; checks: CheckResult[]; ticket: any; duplicate?: any } | null = null;
  for (const t of ranked) {
    const tChecks: CheckResult[] = [];
    const f = await ticketEntryFailure(c, t, gate, now.date, now.time, tChecks, settings);
    if (!f) {
      // Park capacity (block new entries when full).
      if (settings.park.blockEntryWhenFull) {
        const inside = await one<any>(`SELECT COUNT(*)::int AS n FROM tickets WHERE branch_id=$1 AND presence <> 'OUTSIDE'`, [gate.branch_id], c);
        if (inside.n >= settings.park.maxCapacity) {
          tChecks.push({ key: 'CAPACITY', ok: false, detail: `${inside.n}/${settings.park.maxCapacity}` });
          return { ok: false, reason: 'PARK_FULL', checks: [...checks, ...tChecks], ticket: t, credential: cred, snapshot: snapshotFrom(profile, t), duplicate: null, security: null };
        }
        tChecks.push({ key: 'CAPACITY', ok: true, detail: `${inside.n}/${settings.park.maxCapacity}` });
      }
      const snap = snapshotFrom(profile, t);
      if (tickets.length > 1) {
        snap.guestCount = tickets.filter((x) => x.status === 'ACTIVE').length;
        snap.guestIndex = tickets.filter((x) => x.presence !== 'OUTSIDE').length + 1;
      }
      return { ok: true, reason: null, checks: [...checks, ...tChecks], ticket: t, credential: cred, snapshot: snap, duplicate: null, security: null };
    }
    if (!firstFailure) firstFailure = { reason: f.reason, checks: tChecks, ticket: t, duplicate: f.duplicate };
  }
  const ff = firstFailure!;
  const dupSec = ff.reason === 'ALREADY_INSIDE' ? { type: 'DUPLICATE_ENTRY', severity: 'WARNING', data: { ticketNo: ff.ticket.ticket_no, firstGate: ff.duplicate?.firstGate, firstAt: ff.duplicate?.firstAt, code: cred.code } } : null;
  return { ok: false, reason: ff.reason, checks: [...checks, ...ff.checks], ticket: ff.ticket, credential: cred, snapshot: snapshotFrom(profile, ff.ticket), duplicate: ff.duplicate ?? null, security: dupSec };
}

function score(t: any, today: string) {
  let s = 0;
  if (t.status === 'ACTIVE') s += 8;
  if (String(t.valid_from).slice(0, 10) <= today && String(t.valid_to).slice(0, 10) >= today) s += 4;
  if (t.presence === 'OUTSIDE') s += 2;
  return s;
}

async function decideExit(c: Tx, gate: any, raw: string, settings: any): Promise<Decision> {
  const checks: CheckResult[] = [];
  const empty = { ticket: null, snapshot: {}, duplicate: null, security: null };
  const res = await resolveScan(raw, c);
  if (!res.ok) {
    checks.push({ key: 'CODE_VALID', ok: false });
    return { ...empty, ok: false, reason: res.reason ?? 'INVALID_CODE', checks, credential: res.credential ?? null };
  }
  checks.push({ key: 'CODE_VALID', ok: true });
  const cred = res.credential;
  const profile = await credentialProfile(c, cred.id);
  const tickets = await ticketsForCredential(c, cred, { includeAccount: true });
  const inside = tickets.find((t) => t.presence === 'INSIDE' && t.branch_id === gate.branch_id);
  if (!inside) {
    if (settings.gate.exitRequiresInside) {
      checks.push({ key: 'NOT_INSIDE', ok: false });
      return { ...empty, ok: false, reason: 'NOT_INSIDE', checks, credential: cred, snapshot: snapshotFrom(profile) };
    }
    checks.push({ key: 'PARK_ENTRY', ok: false, detail: 'no entry record — exit allowed' });
    return { ok: true, reason: null, checks, ticket: null, credential: cred, snapshot: snapshotFrom(profile), duplicate: null, security: null };
  }
  checks.push({ key: 'PARK_ENTRY', ok: true, detail: inside.ticket_no });
  return { ok: true, reason: null, checks, ticket: inside, credential: cred, snapshot: snapshotFrom(profile, inside), duplicate: null, security: null };
}

/**
 * A scan at a gate. Validation is always server-side; the gate only opens after this authorises it
 * (AUTO mode) or an operator approves (MANUAL mode). The ticket is reserved (presence ENTERING) inside the
 * same transaction, so the same QR shown at two gates at once can only win once.
 */
export async function gateScan(gateId: string, raw: string, ctx: GateScanCtx) {
  const out = new Outbox();
  let openAfter = false;
  const r = await tx(async (c) => {
    const gate = await lockGate(c, gateId);
    if (!gate.is_active) throw conflict('GATE_DISABLED', 'Gate is disabled');
    const settings = await parkSettings(gate.branch_id, c);
    const direction: 'ENTRY' | 'EXIT' = gate.direction === 'BOTH' ? (ctx.direction ?? 'ENTRY') : gate.direction;
    // Same code re-read at the same gate within a few seconds (customer still holding the QR): ignore.
    const parsed = parseCredentialPayload(raw);
    if (parsed.code) {
      const recent = await one<any>(
        `SELECT * FROM gate_scans WHERE gate_id=$1 AND code=$2 AND created_at > clock_timestamp() - ($3 || ' seconds')::interval ORDER BY created_at DESC LIMIT 1`,
        [gateId, parsed.code, String(settings.gate.duplicateIgnoreSec)],
        c,
      );
      if (recent && ['GRANTED', 'PENDING', 'APPROVED'].includes(recent.result)) {
        return { scanId: recent.id, gateId, result: recent.result, reasonCode: recent.reason_code, checks: recent.checks, customer: recent.customer, state: gate.state, ignoredDuplicate: true };
      }
    }
    if (gate.state === 'EMERGENCY' || gate.state === 'OFFLINE' || gate.state === 'ERROR') {
      const reason = gate.state === 'EMERGENCY' ? 'EMERGENCY' : 'GATE_OFFLINE';
      const scan = await insertScan(c, gate, direction, ctx, { ok: false, reason, checks: [], ticket: null, credential: null, snapshot: {}, duplicate: null, security: null }, raw, 'DENIED');
      out.add([rooms.gate(gate.id), rooms.branchGates(gate.branch_id)], EVENTS.GATE_SCAN, scanEvent(gate, scan, null));
      return { scanId: scan.id, gateId, result: 'DENIED', reasonCode: reason, checks: [], customer: {}, state: gate.state };
    }
    if (!GATE_SCANNABLE.includes(gate.state)) throw conflict('GATE_BUSY', `Gate is ${gate.state}`);
    if (direction === 'ENTRY' && gate.direction === 'EXIT') throw conflict('EXIT_ONLY');

    let d = direction === 'ENTRY' ? await decideEntry(c, gate, raw, settings) : await decideExit(c, gate, raw, settings);
    if (direction === 'ENTRY' && d.ok && d.ticket) {
      // Serialise concurrent scans of the same ticket at different gates: lock it, then decide again on the
      // committed state (the loser now sees ENTERING and is denied as a duplicate instead of erroring).
      await one(`SELECT id FROM tickets WHERE id=$1 FOR UPDATE`, [d.ticket.id], c);
      d = await decideEntry(c, gate, raw, settings);
    }
    const manual = gate.mode === 'MANUAL' && direction === 'ENTRY';
    const result = !d.ok ? 'DENIED' : manual ? 'PENDING' : 'GRANTED';
    const scan = await insertScan(c, gate, direction, ctx, d, raw, result);
    if (d.credential) await touchCredential(c, d.credential.id, gate.zone_id);
    if (d.security) {
      await query(
        `INSERT INTO security_events (branch_id, type, severity, gate_id, scan_id, credential_id, ticket_id, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [gate.branch_id, d.security.type, d.security.severity, gate.id, scan.id, d.credential?.id ?? null, d.ticket?.id ?? null, { ...d.security.data, gate: gate.code, at: scan.created_at }],
        c,
      );
      out.add([rooms.branchGates(gate.branch_id), rooms.branchAdmin(gate.branch_id)], EVENTS.SECURITY_ALERT, {
        type: d.security.type, severity: d.security.severity, gateId: gate.id, gate: gate.code, scanId: scan.id, ticketNo: d.ticket?.ticket_no ?? null,
        firstGate: d.duplicate?.firstGate ?? null, firstAt: d.duplicate?.firstAt ?? null, at: scan.created_at, customer: d.snapshot,
      });
      if (d.security.type === 'DUPLICATE_ENTRY') {
        await notify({
          audience: 'STAFF', branchId: gate.branch_id, type: 'SUSPICIOUS_DUPLICATE_QR', severity: 'WARNING',
          title: { th: 'พบการใช้ QR ซ้ำ', en: 'Duplicate entry attempt', zh: '重复入园尝试' },
          body: { th: `${gate.code}: ${d.ticket?.ticket_no} (เข้าแล้วที่ ${d.duplicate?.firstGate ?? '-'})`, en: `${gate.code}: ${d.ticket?.ticket_no} (first entry ${d.duplicate?.firstGate ?? '-'})`, zh: `${gate.code}: ${d.ticket?.ticket_no}（首次入园 ${d.duplicate?.firstGate ?? '-'}）` },
          data: { scanId: scan.id, gateId: gate.id },
        }, c, out);
      }
    }
    await setState(c, gate, 'VALIDATING', out, { scanId: scan.id });
    if (result === 'DENIED') {
      await setState(c, gate, 'DENIED', out);
    } else {
      if (direction === 'ENTRY' && d.ticket) await reserveTicket(c, d.ticket.id, gate, scan.id);
      if (result === 'PENDING') {
        await setState(c, gate, 'WAITING_APPROVAL', out);
      } else {
        await createEntryLog(c, gate, scan, d, direction, null, false, ctx.deviceId ?? null);
        await setState(c, gate, 'APPROVED', out);
        openAfter = true;
      }
    }
    out.add([rooms.gate(gate.id), rooms.branchGates(gate.branch_id), rooms.branchAdmin(gate.branch_id)], EVENTS.GATE_SCAN, scanEvent(gate, scan, d.duplicate));
    await query(`UPDATE gates SET last_scan_at=now() WHERE id=$1`, [gate.id], c);
    return { scanId: scan.id, gateId, result, reasonCode: d.reason, checks: d.checks, customer: d.snapshot, duplicate: d.duplicate, state: gate.state, direction };
  });
  await out.flush();
  if (openAfter) await openGate(gateId, { type: 'SYSTEM' }).catch(() => {});
  return r;
}

function scanEvent(gate: any, scan: any, duplicate: any) {
  return {
    gateId: gate.id, code: gate.code, number: gate.number, scanId: scan.id, result: scan.result, reasonCode: scan.reason_code, checks: scan.checks,
    customer: scan.customer, direction: scan.direction, at: scan.created_at, mode: scan.mode, duplicate,
  };
}

async function insertScan(c: Tx, gate: any, direction: string, ctx: GateScanCtx, d: Decision, raw: string, result: string) {
  const code = d.credential?.code ?? raw.trim().slice(0, 60);
  return one<any>(
    `INSERT INTO gate_scans (branch_id, gate_id, direction, code, credential_id, ticket_id, member_id, booking_id, result, reason_code, checks, customer, mode, source, device_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [gate.branch_id, gate.id, direction, code, d.credential?.id ?? null, d.ticket?.id ?? null, d.credential?.member_id ?? d.ticket?.member_id ?? null, d.ticket?.booking_id ?? null,
     result, d.reason, JSON.stringify(d.checks), JSON.stringify(d.snapshot ?? {}), gate.mode, ctx.source ?? 'CAMERA', ctx.deviceId ?? null],
    c,
  );
}

async function reserveTicket(c: Tx, ticketId: string, gate: any, scanId: string) {
  const t = await one<any>(`SELECT presence FROM tickets WHERE id=$1 FOR UPDATE`, [ticketId], c);
  if (t.presence !== 'OUTSIDE') throw conflict('ALREADY_INSIDE', 'Ticket is already entering / inside');
  await query(`UPDATE tickets SET presence='ENTERING', presence_gate_id=$2, presence_scan_id=$3, presence_since=now() WHERE id=$1`, [ticketId, gate.id, scanId], c);
}

async function releaseReservation(c: Tx, scanId: string) {
  await query(`UPDATE tickets SET presence='OUTSIDE', presence_gate_id=NULL, presence_scan_id=NULL WHERE presence='ENTERING' AND presence_scan_id=$1`, [scanId], c);
  await query(`UPDATE entry_logs SET status='CANCELLED' WHERE scan_id=$1 AND status='PENDING_PASSAGE'`, [scanId], c);
}

async function createEntryLog(c: Tx, gate: any, scan: any, d: { ticket: any; credential: any }, direction: string, operatorId: string | null, override: boolean, deviceId: string | null) {
  const b = await branchInfo(gate.branch_id, c);
  const today = localNow(new Date(), b.timezone).date;
  return one<any>(
    `INSERT INTO entry_logs (branch_id, gate_id, scan_id, ticket_id, credential_id, member_id, direction, status, visit_date, operator_id, override, device_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING_PASSAGE',$8,$9,$10,$11) RETURNING *`,
    [gate.branch_id, gate.id, scan.id, d.ticket?.id ?? null, d.credential?.id ?? null, d.credential?.member_id ?? d.ticket?.member_id ?? null, direction, today, operatorId, override, deviceId],
    c,
  );
}

/** Operator APPROVE ENTRY (manual mode). */
export async function gateApprove(gateId: string, scanId: string, staff: { id: string; name: string }) {
  const out = new Outbox();
  await tx(async (c) => {
    const gate = await lockGate(c, gateId);
    if (gate.state !== 'WAITING_APPROVAL' || gate.current_scan_id !== scanId) throw conflict('NOTHING_TO_APPROVE', 'This scan is no longer waiting for approval');
    const scan = await one<any>(`UPDATE gate_scans SET result='APPROVED', decided_by=$2, decided_at=now() WHERE id=$1 RETURNING *`, [scanId, staff.id], c);
    const ticket = scan.ticket_id ? await one<any>(`SELECT * FROM tickets WHERE id=$1`, [scan.ticket_id], c) : null;
    const cred = scan.credential_id ? await one<any>(`SELECT * FROM credentials WHERE id=$1`, [scan.credential_id], c) : null;
    await createEntryLog(c, gate, scan, { ticket, credential: cred }, scan.direction, staff.id, false, scan.device_id);
    await setState(c, gate, 'APPROVED', out);
    out.add([rooms.gate(gate.id), rooms.branchGates(gate.branch_id)], EVENTS.GATE_SCAN, { ...scanEvent(gate, scan, null), decidedBy: staff.name });
  });
  await out.flush();
  await openGate(gateId, { type: 'STAFF', id: staff.id, name: staff.name });
  return gateSummary((await import('../../db/pool')).pool, gateId);
}

/** Operator DENY ENTRY: gate turns red, ticket reservation released, nothing opens. */
export async function gateDeny(gateId: string, scanId: string, staff: { id: string; name: string }, reason?: string | null) {
  const out = new Outbox();
  await tx(async (c) => {
    const gate = await lockGate(c, gateId);
    if (gate.current_scan_id !== scanId || !['WAITING_APPROVAL', 'VALIDATING'].includes(gate.state)) throw conflict('NOTHING_TO_DENY', 'This scan is no longer pending');
    const scan = await one<any>(`UPDATE gate_scans SET result='OPERATOR_DENIED', reason_code='OPERATOR_DENIED', decided_by=$2, decided_at=now() WHERE id=$1 RETURNING *`, [scanId, staff.id], c);
    await releaseReservation(c, scanId);
    await setState(c, gate, 'DENIED', out);
    out.add([rooms.gate(gate.id), rooms.branchGates(gate.branch_id)], EVENTS.GATE_SCAN, { ...scanEvent(gate, scan, null), decidedBy: staff.name, note: reason ?? null });
  });
  await out.flush();
  return { ok: true };
}

/** Supervisor override of a denied scan (e.g. missed exit → anti-passback). Manager PIN checked by the route. */
export async function gateOverride(gateId: string, scanId: string, staff: { id: string; name: string }, approvedBy: string | null, reason: string) {
  const out = new Outbox();
  await tx(async (c) => {
    const gate = await lockGate(c, gateId);
    if (!GATE_SCANNABLE.includes(gate.state) && gate.state !== 'WAITING_APPROVAL') throw conflict('GATE_BUSY', `Gate is ${gate.state}`);
    const scan = await one<any>(`SELECT * FROM gate_scans WHERE id=$1 AND gate_id=$2`, [scanId, gateId], c);
    if (!scan) throw notFound('Scan');
    if (scan.ticket_id) {
      const t = await one<any>(`SELECT * FROM tickets WHERE id=$1 FOR UPDATE`, [scan.ticket_id], c);
      if (t.status !== 'ACTIVE' && t.status !== 'USED') throw conflict('TICKET_NOT_USABLE', `Ticket is ${t.status}`);
      // Close any dangling entry and re-admit.
      await query(`UPDATE entry_logs SET status='CANCELLED' WHERE ticket_id=$1 AND status='PENDING_PASSAGE'`, [t.id], c);
      await query(`UPDATE tickets SET presence='ENTERING', presence_gate_id=$2, presence_scan_id=$3, presence_since=now(), status='ACTIVE' WHERE id=$1`, [t.id, gate.id, scanId], c);
    }
    const s2 = await one<any>(`UPDATE gate_scans SET result='OVERRIDE', decided_by=$2, approved_by=$3, decided_at=now() WHERE id=$1 RETURNING *`, [scanId, staff.id, approvedBy], c);
    const ticket = scan.ticket_id ? await one<any>(`SELECT * FROM tickets WHERE id=$1`, [scan.ticket_id], c) : null;
    const cred = scan.credential_id ? await one<any>(`SELECT * FROM credentials WHERE id=$1`, [scan.credential_id], c) : null;
    await createEntryLog(c, gate, s2, { ticket, credential: cred }, scan.direction, staff.id, true, scan.device_id);
    await query(`INSERT INTO security_events (branch_id, type, severity, gate_id, scan_id, ticket_id, data) VALUES ($1,'OVERRIDE','INFO',$2,$3,$4,$5)`, [
      gate.branch_id, gate.id, scanId, scan.ticket_id, { by: staff.name, approvedBy, reason },
    ], c);
    if (gate.state === 'WAITING_APPROVAL') await setState(c, gate, 'APPROVED', out, { scanId });
    else await setState(c, gate, 'APPROVED', out, { scanId });
    out.add([rooms.gate(gate.id), rooms.branchGates(gate.branch_id)], EVENTS.GATE_SCAN, { ...scanEvent(gate, s2, null), decidedBy: staff.name });
  });
  await out.flush();
  await openGate(gateId, { type: 'STAFF', id: staff.id, name: staff.name });
  return { ok: true };
}

/** Manual gate open without a ticket (staff with gates.open + manager PIN). Logged as an override entry. */
export async function manualOpen(gateId: string, staff: { id: string; name: string }, approvedBy: string | null, reason: string) {
  const out = new Outbox();
  await tx(async (c) => {
    const gate = await lockGate(c, gateId);
    if (['OPENING', 'OPEN'].includes(gate.state)) throw conflict('GATE_ALREADY_OPEN', 'Gate is already open');
    if (!['IDLE', 'DENIED', 'WAITING_APPROVAL'].includes(gate.state)) throw conflict('GATE_BUSY', `Gate is ${gate.state}`);
    if (gate.state === 'WAITING_APPROVAL' && gate.current_scan_id) await releaseReservation(c, gate.current_scan_id);
    const scan = await one<any>(
      `INSERT INTO gate_scans (branch_id, gate_id, direction, result, reason_code, mode, source, decided_by, approved_by, decided_at, checks, customer)
       VALUES ($1,$2,'ENTRY','OVERRIDE','MANUAL_OPEN',$3,'MANUAL',$4,$5,now(),'[]',$6) RETURNING *`,
      [gate.branch_id, gate.id, gate.mode, staff.id, approvedBy, { name: reason }],
      c,
    );
    await query(`INSERT INTO security_events (branch_id, type, severity, gate_id, scan_id, data) VALUES ($1,'OVERRIDE','WARNING',$2,$3,$4)`, [gate.branch_id, gate.id, scan.id, { manualOpen: true, by: staff.name, approvedBy, reason }], c);
    await setState(c, gate, 'APPROVED', out, { scanId: scan.id });
    out.add([rooms.gate(gate.id), rooms.branchGates(gate.branch_id)], EVENTS.GATE_SCAN, { ...scanEvent(gate, scan, null), decidedBy: staff.name });
  });
  await out.flush();
  await openGate(gateId, { type: 'STAFF', id: staff.id, name: staff.name });
  return { ok: true };
}

/** Send OPEN to the controller — only from APPROVED (never a second OPEN while OPENING / OPEN). */
export async function openGate(gateId: string, actor: ParkActor) {
  const out = new Outbox();
  const gate = await tx(async (c) => {
    const g = await lockGate(c, gateId);
    if (g.state === 'OPENING' || g.state === 'OPEN') throw conflict('GATE_ALREADY_OPEN', 'Gate is already open');
    if (g.state !== 'APPROVED') throw conflict('GATE_NOT_APPROVED', `Gate is ${g.state}`);
    await setState(c, g, 'OPENING', out);
    return g;
  });
  await out.flush();
  const res = await gateController(gate.driver).open(gate).catch((e) => ({ ok: false, error: (e as Error).message }));
  if (!res.ok) await gateFault(gateId, res.error ?? 'Open failed');
  return res;
}

export async function closeGate(gateId: string) {
  const g = await one<any>(`SELECT * FROM gates WHERE id=$1`, [gateId]);
  if (!g) throw notFound('Gate');
  if (!['OPENING', 'OPEN'].includes(g.state)) throw conflict('GATE_NOT_OPEN', `Gate is ${g.state}`);
  const res = await gateController(g.driver).close(g);
  if (!res.ok) await gateFault(gateId, res.error ?? 'Close failed');
  return res;
}

async function gateFault(gateId: string, error: string) {
  const out = new Outbox();
  await tx(async (c) => {
    const g = await lockGate(c, gateId);
    if (g.current_scan_id) await releaseReservation(c, g.current_scan_id);
    if (g.state !== 'ERROR') await setState(c, g, 'ERROR', out, { error });
    await notify({
      audience: 'STAFF', branchId: g.branch_id, type: 'GATE_ERROR', severity: 'CRITICAL', dedupeKey: `gate-error:${g.id}:${new Date().toISOString().slice(0, 13)}`,
      title: { th: `ประตู ${g.code} ขัดข้อง`, en: `Gate ${g.code} error`, zh: `闸机 ${g.code} 故障` },
      body: { th: error, en: error, zh: error },
      data: { gateId: g.id },
    }, c, out);
  });
  await out.flush();
}

/** Hardware / sensor events (from the simulator, a network controller or an edge agent). */
export async function handleGateEvent(gateId: string, ev: HardwareEvent, data: Record<string, unknown> = {}) {
  const out = new Outbox();
  let emergencyBranch: string | null = null;
  await tx(async (c) => {
    const g = await lockGate(c, gateId);
    const settings = await parkSettings(g.branch_id, c);
    if (ev === 'OPENED') {
      if (g.state === 'OPENING') await setState(c, g, 'OPEN', out);
    } else if (ev === 'PASSAGE') {
      if (['OPENING', 'OPEN', 'APPROVED'].includes(g.state)) {
        if (g.state !== 'OPEN') await setState(c, g, g.state === 'APPROVED' ? 'OPENING' : 'OPEN', out).catch(() => {});
        if (g.state === 'OPENING') await setState(c, g, 'OPEN', out);
        await confirmPassage(c, g, out);
        await setState(c, g, 'CLOSING', out);
      }
    } else if (ev === 'CLOSED') {
      if (['OPEN', 'OPENING'].includes(g.state)) {
        // Closed without a passage signal.
        if (!settings.gate.requirePassageConfirm) await confirmPassage(c, g, out);
        else if (g.current_scan_id) await noPassage(c, g);
        await setState(c, g, 'CLOSING', out);
      }
      if (g.state === 'CLOSING') await setState(c, g, 'IDLE', out, { scanId: null });
    } else if (ev === 'OBSTRUCTION') {
      await query(`INSERT INTO security_events (branch_id, type, severity, gate_id, data) VALUES ($1,'OBSTRUCTION','WARNING',$2,$3)`, [g.branch_id, g.id, data], c);
      out.add([rooms.branchGates(g.branch_id)], EVENTS.SECURITY_ALERT, { type: 'OBSTRUCTION', gateId: g.id, gate: g.code, at: new Date().toISOString() });
    } else if (ev === 'EMERGENCY_ON' || ev === 'FIRE_ALARM') {
      if (g.state !== 'EMERGENCY') {
        if (g.current_scan_id) await releaseReservation(c, g.current_scan_id);
        await setState(c, g, 'EMERGENCY', out, { scanId: null });
      }
      await query(`INSERT INTO security_events (branch_id, type, severity, gate_id, data) VALUES ($1,$2,'CRITICAL',$3,$4)`, [g.branch_id, ev === 'FIRE_ALARM' ? 'FIRE_ALARM' : 'EMERGENCY', g.id, data], c);
      if (ev === 'FIRE_ALARM') emergencyBranch = g.branch_id;
    } else if (ev === 'EMERGENCY_OFF') {
      if (g.state === 'EMERGENCY') await setState(c, g, 'IDLE', out, { scanId: null });
    } else if (ev === 'FAULT') {
      if (g.current_scan_id) await releaseReservation(c, g.current_scan_id);
      if (g.state !== 'ERROR') await setState(c, g, 'ERROR', out, { error: String(data.error ?? 'Controller fault') });
    } else if (ev === 'OFFLINE') {
      if (g.state !== 'OFFLINE' && canTransition(g.state, 'OFFLINE')) await setState(c, g, 'OFFLINE', out);
    } else if (ev === 'ONLINE') {
      if (g.state === 'OFFLINE' || g.state === 'ERROR') await setState(c, g, 'IDLE', out, { scanId: null });
    }
  });
  await out.flush();
  // Fire alarm on any gate → every gate of the branch goes into emergency (hardware releases physically).
  if (emergencyBranch) await setEmergency(emergencyBranch, null, true, { type: 'SYSTEM', name: 'FIRE_ALARM' });
}
onGateHardwareEvent((gateId, ev, data) => handleGateEvent(gateId, ev, data));

async function confirmPassage(c: Tx, g: any, out: Outbox) {
  const entry = await one<any>(`SELECT * FROM entry_logs WHERE scan_id=$1 AND status='PENDING_PASSAGE' FOR UPDATE`, [g.current_scan_id], c);
  if (!entry) return;
  await query(`UPDATE entry_logs SET status='CONFIRMED', passed_at=now() WHERE id=$1`, [entry.id], c);
  if (entry.ticket_id) {
    const t = await one<any>(`SELECT * FROM tickets WHERE id=$1 FOR UPDATE`, [entry.ticket_id], c);
    if (entry.direction === 'ENTRY') {
      await query(
        `UPDATE tickets SET presence='INSIDE', presence_since=now(), entry_count=entry_count+1, first_entry_at=COALESCE(first_entry_at, now()), last_entry_at=now(),
            used_at=COALESCE(used_at, now()) WHERE id=$1`,
        [t.id],
        c,
      );
      const firstToday = await one<any>(
        `INSERT INTO ticket_usage_days (ticket_id, visit_date, entries) VALUES ($1,$2,1)
         ON CONFLICT (ticket_id, visit_date) DO UPDATE SET entries = ticket_usage_days.entries + 1 RETURNING (xmax = 0) AS inserted`,
        [t.id, entry.visit_date],
        c,
      );
      if (firstToday?.inserted && t.member_id) await query(`UPDATE members SET visit_count=visit_count+1, last_visit_date=$2 WHERE id=$1`, [t.member_id, entry.visit_date], c);
      if (t.booking_id) await query(`UPDATE bookings SET status='CHECKED_IN', checked_in_at=COALESCE(checked_in_at, now()) WHERE id=$1 AND status='CONFIRMED'`, [t.booking_id], c);
    } else {
      // Single-entry tickets are used up on exit.
      const used = !t.reentry && t.days_allowed <= 1;
      await query(`UPDATE tickets SET presence='OUTSIDE', presence_gate_id=NULL, presence_scan_id=NULL, last_exit_at=now(), status = CASE WHEN $2 THEN 'USED' ELSE status END WHERE id=$1`, [t.id, used], c);
    }
    out.add([rooms.branchAdmin(g.branch_id)], EVENTS.TICKET_UPDATED, { ticketId: t.id, presence: entry.direction === 'ENTRY' ? 'INSIDE' : 'OUTSIDE' });
  }
  await announceOccupancy(c, g.branch_id, out);
}

async function noPassage(c: Tx, g: any) {
  await query(`UPDATE entry_logs SET status='NO_PASSAGE' WHERE scan_id=$1 AND status='PENDING_PASSAGE'`, [g.current_scan_id], c);
  await query(`UPDATE tickets SET presence='OUTSIDE', presence_gate_id=NULL, presence_scan_id=NULL WHERE presence='ENTERING' AND presence_scan_id=$1`, [g.current_scan_id], c);
}

/** EMERGENCY on/off for one gate or all gates of a branch. Business logic yields to hardware safety. */
export async function setEmergency(branchId: string, gateId: string | null, on: boolean, actor: ParkActor) {
  const gates = await query<any>(`SELECT * FROM gates WHERE branch_id=$1 AND ($2::uuid IS NULL OR id=$2) AND is_active ORDER BY number`, [branchId, gateId]);
  for (const g of gates) {
    await handleGateEvent(g.id, on ? 'EMERGENCY_ON' : 'EMERGENCY_OFF', { by: actor.name ?? actor.type });
    await gateController(g.driver).emergency(g, on).catch(() => ({ ok: false }));
  }
  if (on) {
    await notify({
      audience: 'STAFF', branchId, type: 'EMERGENCY_MODE', severity: 'CRITICAL',
      title: { th: 'โหมดฉุกเฉินเปิดใช้งาน', en: 'Emergency mode activated', zh: '紧急模式已启动' },
      body: { th: `โดย ${actor.name ?? actor.type}`, en: `By ${actor.name ?? actor.type}`, zh: `操作人 ${actor.name ?? actor.type}` },
      data: { gateId },
    });
  }
  return { gates: gates.length };
}

/** Reset an ERROR / OFFLINE gate back to IDLE (operator) after the issue is fixed. */
export async function resetGate(gateId: string) {
  const out = new Outbox();
  await tx(async (c) => {
    const g = await lockGate(c, gateId);
    if (g.current_scan_id) await releaseReservation(c, g.current_scan_id);
    if (g.state !== 'IDLE') {
      if (['OPEN', 'OPENING'].includes(g.state)) await setState(c, g, 'CLOSING', out);
      await setState(c, g, 'IDLE', out, { scanId: null });
    }
  });
  await out.flush();
}

// ------------------------------------------------------------------ occupancy
export async function occupancy(db: Db, branchId: string) {
  const settings = await parkSettings(branchId, db);
  const b = await branchInfo(branchId, db);
  const today = localNow(new Date(), b.timezone).date;
  const r = await one<any>(
    `SELECT (SELECT COUNT(*)::int FROM tickets WHERE branch_id=$1 AND presence='INSIDE') AS inside,
            (SELECT COUNT(*)::int FROM tickets WHERE branch_id=$1 AND presence='ENTERING') AS entering,
            (SELECT COUNT(*)::int FROM entry_logs WHERE branch_id=$1 AND visit_date=$2 AND direction='ENTRY' AND status='CONFIRMED') AS entered,
            (SELECT COUNT(DISTINCT ticket_id)::int FROM entry_logs WHERE branch_id=$1 AND visit_date=$2 AND direction='ENTRY' AND status='CONFIRMED') AS visitors,
            (SELECT COUNT(*)::int FROM entry_logs WHERE branch_id=$1 AND visit_date=$2 AND direction='EXIT' AND status='CONFIRMED') AS exited`,
    [branchId, today],
    db,
  );
  const hourly = await query<any>(
    `SELECT extract(hour FROM passed_at AT TIME ZONE $3)::int AS h,
            SUM(CASE WHEN direction='ENTRY' THEN 1 ELSE 0 END)::int AS entries, SUM(CASE WHEN direction='EXIT' THEN 1 ELSE 0 END)::int AS exits
       FROM entry_logs WHERE branch_id=$1 AND visit_date=$2 AND status='CONFIRMED' GROUP BY 1 ORDER BY 1`,
    [branchId, today, b.timezone],
    db,
  );
  let running = 0;
  let peak = { hour: null as number | null, inside: 0 };
  for (const h of hourly) {
    running += h.entries - h.exits;
    if (running > peak.inside) peak = { hour: h.h, inside: running };
  }
  const max = settings.park.maxCapacity;
  return { inside: r.inside, entering: r.entering, enteredToday: r.entered, visitorsToday: r.visitors, exitedToday: r.exited, capacity: max, pct: max ? Math.round((r.inside / max) * 1000) / 10 : 0, peak, hourly };
}

async function announceOccupancy(c: Tx, branchId: string, out: Outbox) {
  const o = await occupancy(c, branchId);
  out.add([rooms.branchAdmin(branchId), rooms.branchGates(branchId), rooms.branchPublic(branchId)], EVENTS.OCCUPANCY_UPDATED, o);
  const settings = await parkSettings(branchId, c);
  for (const pct of [...settings.park.warnPcts].sort((a, b) => b - a)) {
    if (o.pct >= pct) {
      const today = new Date().toISOString().slice(0, 10);
      await notify({
        audience: 'STAFF', branchId, type: 'CAPACITY_WARNING', severity: pct >= 100 ? 'CRITICAL' : 'WARNING', dedupeKey: `cap:${branchId}:${today}:${pct}`,
        title: { th: `จำนวนผู้เข้าชมถึง ${pct}%`, en: `Park capacity ${pct}% reached`, zh: `园区容量已达 ${pct}%` },
        body: { th: `${o.inside} / ${o.capacity} คน`, en: `${o.inside} / ${o.capacity} guests`, zh: `${o.inside} / ${o.capacity} 人` },
        data: { inside: o.inside, capacity: o.capacity, pct },
      }, c, out);
      out.add([rooms.branchAdmin(branchId), rooms.branchGates(branchId)], EVENTS.CAPACITY_ALERT, { pct, inside: o.inside, capacity: o.capacity });
      break;
    }
  }
}

// ------------------------------------------------------------------ background maintenance
/** Timeouts: approval, passage (re-close & release), denied display reset, stuck closing. Row-locked & idempotent. */
export async function gateMaintenance() {
  const gates = await query<any>(
    `SELECT g.id, g.state, g.branch_id, g.open_seconds, extract(epoch FROM clock_timestamp() - g.state_since) AS age FROM gates g
      WHERE g.state = ANY($1) AND g.is_active`,
    [STATE_TIMEOUT_EVENTS],
  );
  for (const g of gates) {
    const s = await parkSettings(g.branch_id);
    const age = Number(g.age);
    try {
      if (g.state === 'WAITING_APPROVAL' && age > s.gate.approvalTimeoutSec) {
        const out = new Outbox();
        await tx(async (c) => {
          const gate = await lockGate(c, g.id);
          if (gate.state !== 'WAITING_APPROVAL') return;
          await query(`UPDATE gate_scans SET result='TIMEOUT', reason_code='APPROVAL_TIMEOUT', decided_at=now() WHERE id=$1 AND result='PENDING'`, [gate.current_scan_id], c);
          await releaseReservation(c, gate.current_scan_id);
          await setState(c, gate, 'DENIED', out);
        });
        await out.flush();
      } else if (g.state === 'DENIED' && age > s.gate.deniedDisplaySec) {
        const out = new Outbox();
        await tx(async (c) => {
          const gate = await lockGate(c, g.id);
          if (gate.state === 'DENIED') await setState(c, gate, 'IDLE', out, { scanId: null });
        });
        await out.flush();
      } else if (['APPROVED', 'OPENING', 'OPEN'].includes(g.state) && age > g.open_seconds + s.gate.passageTimeoutSec) {
        const gate = await one<any>(`SELECT * FROM gates WHERE id=$1`, [g.id]);
        if (gate.state === 'APPROVED') {
          // Approved but OPEN never sent (crash between commit and command) — send it now.
          await openGate(g.id, { type: 'SYSTEM', name: 'recovery' }).catch(() => {});
        } else {
          await gateController(gate.driver).close(gate).catch(() => {});
          await handleGateEvent(g.id, 'CLOSED', { reason: 'PASSAGE_TIMEOUT' });
        }
      } else if (g.state === 'CLOSING' && age > 3) {
        await handleGateEvent(g.id, 'CLOSED', { reason: 'CLOSING_TIMEOUT' });
      } else if ((g.state === 'VALIDATING' || g.state === 'SCANNING') && age > 10) {
        await resetGate(g.id);
      }
    } catch {
      /* next tick */
    }
  }
}

/** End of day: anyone still "inside" yesterday is checked out (no exit scan) so anti-passback resets. */
export async function endOfDayPresence() {
  const rows = await query<any>(
    `SELECT t.id, t.branch_id, t.reentry, t.days_allowed, b.timezone FROM tickets t JOIN branches b ON b.id=t.branch_id
      WHERE t.presence <> 'OUTSIDE' AND COALESCE(t.presence_since, t.last_entry_at) < ((now() AT TIME ZONE b.timezone)::date)::timestamp AT TIME ZONE b.timezone LIMIT 500`,
  );
  for (const r of rows) {
    await query(
      `UPDATE tickets SET presence='OUTSIDE', presence_gate_id=NULL, presence_scan_id=NULL, last_exit_at=COALESCE(last_exit_at, now()),
          status = CASE WHEN NOT reentry AND days_allowed <= 1 AND status='ACTIVE' THEN 'USED' ELSE status END WHERE id=$1`,
      [r.id],
    );
  }
  await query(
    `UPDATE tickets t SET status='EXPIRED' FROM branches b WHERE b.id=t.branch_id AND t.status IN ('ACTIVE','PAID') AND t.valid_to < (now() AT TIME ZONE b.timezone)::date`,
  );
  await query(
    `UPDATE tickets t SET status='CANCELLED' FROM branches b WHERE b.id=t.branch_id AND t.status='UNPAID' AND t.valid_to < (now() AT TIME ZONE b.timezone)::date`,
  );
  return rows.length;
}

export async function listGates(db: Db, branchId: string) {
  return query<any>(
    `SELECT g.*, z.name AS zone_name, u.name AS operator_name,
            (SELECT row_to_json(s) FROM (SELECT gs.id, gs.result, gs.reason_code, gs.customer, gs.checks, gs.created_at, gs.direction FROM gate_scans gs
               WHERE gs.id = COALESCE(g.current_scan_id, (SELECT id FROM gate_scans WHERE gate_id=g.id ORDER BY created_at DESC LIMIT 1))) s) AS last_scan,
            (SELECT json_agg(json_build_object('id', d.id, 'code', d.code, 'name', d.name, 'type', d.type, 'role', gd.role, 'status',
               CASE WHEN d.last_seen_at > now() - interval '2 minutes' THEN d.status ELSE 'OFFLINE' END, 'last_seen_at', d.last_seen_at))
               FROM gate_devices gd JOIN devices d ON d.id=gd.device_id WHERE gd.gate_id=g.id) AS devices,
            (SELECT COUNT(*)::int FROM gate_scans s WHERE s.gate_id=g.id AND s.created_at > date_trunc('day', now())) AS scans_today,
            (SELECT COUNT(*)::int FROM gate_scans s WHERE s.gate_id=g.id AND s.created_at > date_trunc('day', now()) AND s.result IN ('GRANTED','APPROVED','OVERRIDE')) AS approved_today,
            (SELECT COUNT(*)::int FROM gate_scans s WHERE s.gate_id=g.id AND s.created_at > date_trunc('day', now()) AND s.result IN ('DENIED','OPERATOR_DENIED','TIMEOUT')) AS denied_today,
            (SELECT COUNT(*)::int FROM gate_scans s WHERE s.gate_id=g.id AND s.created_at > date_trunc('day', now()) AND s.reason_code='ALREADY_INSIDE') AS duplicate_today
       FROM gates g LEFT JOIN zones z ON z.id=g.zone_id LEFT JOIN users u ON u.id=g.operator_id
      WHERE g.branch_id=$1 ORDER BY g.number`,
    [branchId],
    db,
  );
}

export { emitGateHardwareEvent, simulator };
export function assertGateConfig(driver: string, cfg: Record<string, any>) {
  if (driver === 'HTTP' && !/^https?:\/\//.test(cfg?.url ?? '')) throw badRequest('CONTROLLER_URL_REQUIRED', 'HTTP controllers need a url');
  if (driver === 'RELAY_HTTP' && !/^https?:\/\//.test(cfg?.openUrl ?? '')) throw badRequest('CONTROLLER_URL_REQUIRED', 'Relay controllers need an openUrl');
  if (driver === 'EDGE_AGENT' && !cfg?.deviceId) throw badRequest('DEVICE_REQUIRED', 'Edge agent driver needs a deviceId');
}
