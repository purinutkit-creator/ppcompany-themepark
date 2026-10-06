import { EVENTS, rooms, type Lang, type ShiftReport } from '@kiosk/shared';
import { one, query, tx, type Db } from '../../db/pool';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { Outbox } from '../../lib/realtime';
import { branchToday, genShiftNo, parkSettings, round2 } from './common';
import { notify } from './notifications';
import { printShiftReport } from './print';

export async function openShift(a: { branchId: string; userId: string; terminal: 'COUNTER' | 'POS' | 'KIOSK' | 'RIDE' | 'LOCKER'; storeId?: string | null; deviceId?: string | null; openingCash: number }) {
  if (!(a.openingCash >= 0)) throw badRequest('INVALID_AMOUNT');
  const out = new Outbox();
  try {
    const r = await tx(async (c) => {
      const s = await one<any>(
        `INSERT INTO shifts (shift_no, branch_id, user_id, terminal, store_id, device_id, opening_cash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [await genShiftNo(c, await branchToday(a.branchId, c)), a.branchId, a.userId, a.terminal, a.storeId ?? null, a.deviceId ?? null, a.openingCash],
        c,
      );
      out.add([rooms.branchAdmin(a.branchId)], EVENTS.SHIFT_UPDATED, { shiftId: s.id, status: 'OPEN' });
      return s;
    });
    await out.flush();
    return r;
  } catch (e: any) {
    if (e?.code === '23505' && String(e?.constraint).includes('shifts_one_open')) throw conflict('SHIFT_ALREADY_OPEN', 'You already have an open shift');
    throw e;
  }
}

export async function currentShift(userId: string) {
  const s = await one<any>(`SELECT * FROM shifts WHERE user_id=$1 AND status='OPEN'`, [userId]);
  return s ? { ...s, summary: await shiftSummary((await import('../../db/pool')).pool, s.id) } : null;
}

export async function cashMovement(a: { shiftId: string; userId: string; type: 'CASH_IN' | 'CASH_OUT'; amount: number; note: string }) {
  if (!(a.amount > 0)) throw badRequest('INVALID_AMOUNT');
  const s = await one<any>(`SELECT * FROM shifts WHERE id=$1`, [a.shiftId]);
  if (!s || s.status !== 'OPEN') throw conflict('SHIFT_NOT_OPEN');
  return one<any>(
    `INSERT INTO cash_movements (shift_id, type, amount, ref_type, note, user_id) VALUES ($1,$2,$3,'MANUAL',$4,$5) RETURNING *`,
    [a.shiftId, a.type, a.type === 'CASH_OUT' ? -a.amount : a.amount, a.note, a.userId],
  );
}

/** Expected cash = opening + cash sales + cash top-ups + cash in − cash refunds − cash out. */
export async function shiftSummary(db: Db, shiftId: string) {
  const s = await one<any>(`SELECT s.*, u.name AS user_name FROM shifts s JOIN users u ON u.id=s.user_id WHERE s.id=$1`, [shiftId], db);
  if (!s) throw notFound('Shift');
  const m = await one<any>(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE type IN ('CASH_SALE','CASH_ORDER')),0) AS cash_sales,
            COALESCE(SUM(amount) FILTER (WHERE type='CASH_TOPUP'),0) AS cash_topup,
            COALESCE(-SUM(amount) FILTER (WHERE type='CASH_REFUND'),0) AS cash_refund,
            COALESCE(-SUM(amount) FILTER (WHERE type='CASH_OUT'),0) AS cash_out,
            COALESCE(SUM(amount) FILTER (WHERE type='CASH_IN'),0) AS cash_in
       FROM cash_movements WHERE shift_id=$1`,
    [shiftId],
    db,
  );
  const byMethod = await query<any>(
    `SELECT method, SUM(amount)::numeric AS amount, COUNT(*)::int AS count FROM (
        SELECT method, amount FROM sale_payments WHERE shift_id=$1 AND status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED')
        UNION ALL SELECT p.method, p.amount FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.shift_id=$1 AND p.status='PAID'
      ) x GROUP BY method ORDER BY method`,
    [shiftId],
    db,
  );
  const opening = Number(s.opening_cash);
  const expected = round2(opening + Number(m.cash_sales) + Number(m.cash_topup) + Number(m.cash_in) - Number(m.cash_refund) - Number(m.cash_out));
  return {
    shift: s,
    opening,
    cashSales: Number(m.cash_sales),
    cashTopup: Number(m.cash_topup),
    cashRefund: Number(m.cash_refund),
    cashOut: Number(m.cash_out),
    cashIn: Number(m.cash_in),
    expected,
    byMethod: byMethod.map((r) => ({ method: r.method, amount: Number(r.amount), count: r.count })),
    salesCount: (await one<any>(`SELECT COUNT(DISTINCT sale_id)::int AS n FROM sale_payments WHERE shift_id=$1 AND status='PAID'`, [shiftId], db)).n,
  };
}

export async function closeShift(a: { shiftId: string; userId: string; actualCash: number; note?: string | null; canManageOthers: boolean; printerId?: string | null; language?: Lang }) {
  if (!(a.actualCash >= 0)) throw badRequest('INVALID_AMOUNT');
  const out = new Outbox();
  const r = await tx(async (c) => {
    const s = await one<any>(`SELECT * FROM shifts WHERE id=$1 FOR UPDATE`, [a.shiftId], c);
    if (!s) throw notFound('Shift');
    if (s.status !== 'OPEN') throw conflict('SHIFT_NOT_OPEN');
    if (s.user_id !== a.userId && !a.canManageOthers) throw forbidden('NOT_YOUR_SHIFT');
    const sum = await shiftSummary(c, a.shiftId);
    const overShort = round2(a.actualCash - sum.expected);
    const row = await one<any>(
      `UPDATE shifts SET status='CLOSED', closed_at=now(), actual_cash=$2, expected_cash=$3, over_short=$4, totals=$5, note=$6, closed_by=$7 WHERE id=$1 RETURNING *`,
      [a.shiftId, a.actualCash, sum.expected, overShort, JSON.stringify({ ...sum, shift: undefined }), a.note ?? null, a.userId],
      c,
    );
    const settings = await parkSettings(s.branch_id, c);
    if (Math.abs(overShort) >= settings.shift.overShortAlert) {
      await notify({
        audience: 'STAFF', branchId: s.branch_id, type: 'SHIFT_OVER_SHORT', severity: 'WARNING',
        title: { th: `เงินสด${overShort < 0 ? 'ขาด' : 'เกิน'} ${Math.abs(overShort)}`, en: `Cash ${overShort < 0 ? 'short' : 'over'} ${Math.abs(overShort)}`, zh: `现金${overShort < 0 ? '短款' : '长款'} ${Math.abs(overShort)}` },
        body: { th: `กะ ${s.shift_no} (${sum.shift.user_name})`, en: `Shift ${s.shift_no} (${sum.shift.user_name})`, zh: `班次 ${s.shift_no}（${sum.shift.user_name}）` },
        data: { shiftId: s.id, overShort },
      }, c, out);
    }
    const tz = (await one<any>(`SELECT timezone FROM branches WHERE id=$1`, [s.branch_id], c)).timezone;
    const report: ShiftReport = {
      shiftNo: s.shift_no, staff: sum.shift.user_name, terminal: s.terminal, openedAt: new Date(s.opened_at).toISOString(), closedAt: new Date().toISOString(), timeZone: tz,
      opening: sum.opening, cashSales: sum.cashSales, cashTopup: sum.cashTopup, cashRefund: sum.cashRefund, cashOut: sum.cashOut, cashIn: sum.cashIn,
      expected: sum.expected, actual: a.actualCash, overShort, byMethod: sum.byMethod,
    };
    await printShiftReport(c, report, s.branch_id, a.printerId ?? null, a.language ?? 'th', out).catch(() => null);
    out.add([rooms.branchAdmin(s.branch_id)], EVENTS.SHIFT_UPDATED, { shiftId: s.id, status: 'CLOSED', overShort });
    return { shift: row, report };
  });
  await out.flush();
  return r;
}

export async function listShifts(branchId: string, f: { from?: string; to?: string; userId?: string; status?: string }) {
  return query<any>(
    `SELECT s.*, u.name AS user_name, cb.name AS closed_by_name, st.name AS store_name FROM shifts s JOIN users u ON u.id=s.user_id
       LEFT JOIN users cb ON cb.id=s.closed_by LEFT JOIN stores st ON st.id=s.store_id
      WHERE s.branch_id=$1 AND ($2::timestamptz IS NULL OR s.opened_at >= $2) AND ($3::timestamptz IS NULL OR s.opened_at < $3)
        AND ($4::uuid IS NULL OR s.user_id=$4) AND ($5::text IS NULL OR s.status=$5)
      ORDER BY s.opened_at DESC LIMIT 300`,
    [branchId, f.from ?? null, f.to ?? null, f.userId ?? null, f.status ?? null],
  );
}
