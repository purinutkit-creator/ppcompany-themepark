import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Banknote, Lock, Unlock } from 'lucide-react';
import { parkApi } from '../lib/api';
import { dateTime, money } from '../lib/format';
import { defineStrings, useT } from '../lib/lang';
import { Button, Card, Field, Input, Loading, NumberInput, Select, toast, withManagerApproval } from '../components/ui';

export const SH = defineStrings('shift', {
  shift: { th: 'กะการทำงาน', en: 'Shift', zh: '班次' },
  noShift: { th: 'ยังไม่ได้เปิดกะ — ต้องเปิดกะก่อนรับเงินสด', en: 'No open shift — open one before taking cash', zh: '未开班 — 收现金前请先开班' },
  openShift: { th: 'เปิดกะ', en: 'Open shift', zh: '开班' },
  openingCash: { th: 'เงินทอนตั้งต้น', en: 'Opening cash', zh: '备用金' },
  closeShift: { th: 'ปิดกะ', en: 'Close shift', zh: '交班' },
  countedCash: { th: 'นับเงินสดได้จริง', en: 'Counted cash', zh: '实点现金' },
  expected: { th: 'เงินสดที่ควรมี', en: 'Expected cash', zh: '应有现金' },
  overShort: { th: 'ขาด / เกิน', en: 'Over / short', zh: '长短款' },
  cashSales: { th: 'ขายเงินสด', en: 'Cash sales', zh: '现金销售' },
  cashTopup: { th: 'เติมเงินด้วยเงินสด', en: 'Cash top-ups', zh: '现金充值' },
  cashRefund: { th: 'คืนเงินสด', en: 'Cash refunds', zh: '现金退款' },
  cashIn: { th: 'นำเงินเข้า', en: 'Cash in', zh: '存入' },
  cashOut: { th: 'นำเงินออก', en: 'Cash out', zh: '取出' },
  byMethod: { th: 'แยกตามวิธีชำระ', en: 'By payment method', zh: '按支付方式' },
  sales: { th: 'จำนวนบิล', en: 'Sales', zh: '单数' },
  since: { th: 'เปิดเมื่อ', en: 'Opened', zh: '开班时间' },
  closed: { th: 'ปิดกะแล้ว — พิมพ์รายงานกะ', en: 'Shift closed — shift report printed', zh: '已交班 — 已打印班次报表' },
  blind: { th: 'ปิดกะแบบไม่แสดงยอด (Blind close)', en: 'Blind close (expected hidden)', zh: '盲交班（不显示应有金额）' },
  noteReq: { th: 'บันทึก (จำเป็น)', en: 'Note (required)', zh: '备注（必填）' },
});

export function useCurrentShift() {
  return useQuery({ queryKey: ['shift-current'], queryFn: () => parkApi('/shifts/current'), refetchInterval: 60_000 });
}

export function ShiftPanel({ terminal, storeId, blindClose }: { terminal: 'COUNTER' | 'POS' | 'LOCKER' | 'RIDE'; storeId?: string | null; blindClose?: boolean }) {
  const t = useT(SH);
  const qc = useQueryClient();
  const cur = useCurrentShift();
  const [opening, setOpening] = useState<number | null>(2000);
  const [counted, setCounted] = useState<number | null>(null);
  const [mv, setMv] = useState<{ type: 'CASH_IN' | 'CASH_OUT'; amount: number | null; note: string }>({ type: 'CASH_IN', amount: null, note: '' });
  const [closedReport, setClosedReport] = useState<any>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['shift-current'] });
  if (cur.isLoading) return <Loading />;
  const s = cur.data;
  if (!s) {
    return (
      <div className="space-y-4">
        {closedReport && (
          <div className="rounded-2xl bg-emerald-50 p-4 text-emerald-900">
            <b>{t('closed')}</b>
            <div className="mt-1 text-sm">{t('expected')} {money(closedReport.report.expected)} · {t('countedCash')} {money(closedReport.shift.actual_cash)} · {t('overShort')} <b className={Number(closedReport.report.overShort) < 0 ? 'text-rose-700' : ''}>{money(closedReport.report.overShort)}</b></div>
          </div>
        )}
        <Card title={<span className="flex items-center gap-2"><Unlock className="h-4 w-4" />{t('openShift')}</span>}>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('openingCash')}><NumberInput value={opening} onChange={setOpening} min={0} /></Field>
            <Button onClick={async () => {
              try {
                await parkApi('/shifts/open', { body: { openingCash: opening ?? 0, terminal, storeId: storeId ?? null } });
                setClosedReport(null);
                refresh();
              } catch (e) { toast.error(t.err(e)); }
            }}>{t('openShift')}</Button>
          </div>
        </Card>
      </div>
    );
  }
  const sum = s.summary;
  const diff = counted != null ? counted - sum.expected : null;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={<span className="flex items-center gap-2"><Banknote className="h-4 w-4" />{t('shift')} · {s.terminal}</span>} actions={<span className="text-xs text-slate-500">{t('since')} {dateTime(s.opened_at)}</span>}>
        <dl className="space-y-1.5 text-sm">
          <Row k={t('openingCash')} v={money(sum.opening)} />
          <Row k={t('cashSales')} v={money(sum.cashSales)} />
          <Row k={t('cashTopup')} v={money(sum.cashTopup)} />
          <Row k={t('cashIn')} v={money(sum.cashIn)} />
          <Row k={t('cashOut')} v={`−${money(sum.cashOut)}`} />
          <Row k={t('cashRefund')} v={`−${money(sum.cashRefund)}`} />
          {!blindClose && <Row k={t('expected')} v={money(sum.expected)} strong />}
          <Row k={t('sales')} v={sum.salesCount} />
        </dl>
        <div className="mt-3 text-xs font-semibold text-slate-500">{t('byMethod')}</div>
        <div className="mt-1 flex flex-wrap gap-1.5">{sum.byMethod.map((m: any) => <span key={m.method} className="rounded-full bg-slate-100 px-3 py-1 text-xs">{t.method(m.method)} {money(m.amount)} ({m.count})</span>)}</div>
      </Card>
      <div className="space-y-4">
        <Card title={`${t('cashIn')} / ${t('cashOut')}`}>
          <div className="grid gap-2 sm:grid-cols-[120px_120px_1fr_auto] sm:items-end">
            <Field label={t('type')}><Select value={mv.type} onChange={(e) => setMv({ ...mv, type: e.target.value as any })}><option value="CASH_IN">{t('cashIn')}</option><option value="CASH_OUT">{t('cashOut')}</option></Select></Field>
            <Field label={t('amount')}><NumberInput value={mv.amount} onChange={(v) => setMv({ ...mv, amount: v })} min={0} /></Field>
            <Field label={t('noteReq')}><Input value={mv.note} onChange={(e) => setMv({ ...mv, note: e.target.value })} /></Field>
            <Button disabled={!mv.amount || mv.note.length < 2} onClick={async () => {
              try {
                const send = (a: Record<string, unknown> = {}) => parkApi(`/shifts/${s.id}/cash`, { body: { type: mv.type, amount: mv.amount, note: mv.note, ...a } });
                if (mv.type === 'CASH_OUT') await withManagerApproval(t('cashOut'), send);
                else await send();
                setMv({ type: 'CASH_IN', amount: null, note: '' });
                refresh();
              } catch (e) { toast.error(t.err(e)); }
            }}>{t('save')}</Button>
          </div>
        </Card>
        <Card title={<span className="flex items-center gap-2"><Lock className="h-4 w-4" />{t('closeShift')}</span>}>
          {blindClose && <div className="mb-2 text-xs text-slate-500">{t('blind')}</div>}
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('countedCash')}><NumberInput value={counted} onChange={setCounted} min={0} /></Field>
            {!blindClose && diff != null && <div className={clsx('rounded-xl px-3 py-2 font-bold', Math.abs(diff) < 0.01 ? 'bg-emerald-50 text-emerald-700' : diff < 0 ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700')}>{t('overShort')} {money(diff)}</div>}
            <Button variant="dark" disabled={counted == null} onClick={async () => {
              try {
                const r = await parkApi(`/shifts/${s.id}/close`, { body: { actualCash: counted, language: t.lang } });
                setClosedReport(r);
                setCounted(null);
                refresh();
              } catch (e) { toast.error(t.err(e)); }
            }}>{t('closeShift')}</Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Row({ k, v, strong }: { k: string; v: any; strong?: boolean }) {
  return <div className={clsx('flex justify-between', strong && 'border-t pt-1.5 text-base font-bold')}><dt className="text-slate-600">{k}</dt><dd className="tabular-nums">{v}</dd></div>;
}
