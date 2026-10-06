import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, FileImage, RotateCcw, XCircle } from 'lucide-react';
import { EVENTS } from '@kiosk/shared';
import { parkApi } from '../lib/api';
import { dateTime, money } from '../lib/format';
import { defineStrings, useT } from '../lib/lang';
import { chime } from '../lib/sound';
import { useSocketEvent } from '../lib/socket';
import { Button, Empty, Loading, Modal, Tabs, promptDialog, toast } from '../components/ui';
import { useStaffRt } from '../components/StaffShell';
import { PStatus } from '../park/ui';

const VF = defineStrings('verify', {
  waiting: { th: 'รอตรวจสอบ', en: 'Waiting', zh: '待核对' },
  decided: { th: 'ตรวจแล้ว (24 ชม.)', en: 'Decided (24 h)', zh: '已处理（24小时）' },
  expected: { th: 'ยอดที่ต้องได้รับ', en: 'Expected amount', zh: '应收金额' },
  reference: { th: 'เลขอ้างอิง', en: 'Reference', zh: '参考号' },
  slip: { th: 'สลิป', en: 'Slip', zh: '凭证' },
  noSlip: { th: 'ไม่มีสลิป — ตรวจสอบยอดในบัญชีธนาคาร', en: 'No slip — check the bank account statement', zh: '无凭证 — 请核对银行账户' },
  approve: { th: 'อนุมัติ', en: 'Approve', zh: '批准' },
  reject: { th: 'ปฏิเสธ', en: 'Reject', zh: '拒绝' },
  newSlip: { th: 'ขอสลิปใหม่', en: 'Request new slip', zh: '要求重新上传' },
  approved: { th: 'อนุมัติแล้ว — ลูกค้าได้รับการยืนยันทันที', en: 'Approved — the customer sees it instantly', zh: '已批准 — 客户即时收到确认' },
  booking: { th: 'การจอง', en: 'Booking', zh: '预订' },
  requested: { th: 'แจ้งเมื่อ', en: 'Requested', zh: '提交时间' },
  by: { th: 'โดย', en: 'by', zh: '处理人' },
  newRequest: { th: 'มีรายการรอตรวจสอบการชำระเงินใหม่', en: 'New payment waiting for verification', zh: '有新的待核对付款' },
});

/** Park payment verification center: PromptPay / transfer slips for bookings, top-ups and memberships. */
export function VerifyTab() {
  const t = useT(VF);
  const { socket } = useStaffRt();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'WAITING_VERIFICATION' | 'APPROVED,REJECTED,NEW_SLIP_REQUESTED'>('WAITING_VERIFICATION');
  const [img, setImg] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['park-verifications', tab], queryFn: () => parkApi(`/sales/verifications/list?status=${tab}`), refetchInterval: 30_000 });
  useSocketEvent(socket, EVENTS.PARK_PAYMENT_WAITING, (d) => {
    if (d?.kind === 'CASH') return;
    chime('ding');
    toast.info(t('newRequest'), d?.saleNo ?? '');
    void qc.invalidateQueries({ queryKey: ['park-verifications'] });
  });
  useSocketEvent(socket, [EVENTS.SALE_PAID, EVENTS.BOOKING_UPDATED], () => void qc.invalidateQueries({ queryKey: ['park-verifications'] }));
  const act = async (id: string, kind: 'approve' | 'reject' | 'newSlip') => {
    try {
      if (kind === 'approve') {
        await parkApi(`/sales/verifications/${id}/approve`, { method: 'POST' });
        toast.success(t('approved'));
      } else {
        const reason = await promptDialog(kind === 'reject' ? t('reject') : t('newSlip'), t('reason'));
        if (!reason) return;
        await parkApi(`/sales/verifications/${id}/reject`, { body: { reason, requestNewSlip: kind === 'newSlip' } });
      }
      void qc.invalidateQueries({ queryKey: ['park-verifications'] });
    } catch (e) { toast.error(t.err(e)); }
  };
  return (
    <div className="space-y-3 p-3">
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'WAITING_VERIFICATION', label: t('waiting'), count: tab === 'WAITING_VERIFICATION' ? q.data?.length : undefined }, { id: 'APPROVED,REJECTED,NEW_SLIP_REQUESTED', label: t('decided') }]} />
      {!q.data ? <Loading /> : !q.data.length ? <div className="rounded-2xl bg-white p-6 shadow-sm"><Empty /></div> : (
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {q.data.map((v: any) => (
            <div key={v.id} className={clsx('rounded-2xl bg-white p-4 shadow-sm', v.status === 'WAITING_VERIFICATION' && 'ring-2 ring-violet-300')}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-mono text-sm font-semibold">{v.booking_no ?? v.sale_no}</div>
                  <div className="text-sm">{v.customer_name ?? v.sale_customer ?? '—'} {v.phone ? `· ${v.phone}` : ''}</div>
                  <div className="text-xs text-slate-500">{t.method(v.method)} · {v.kind} · {t('requested')} {dateTime(v.requested_at)}</div>
                  {v.visit_date && <div className="text-xs text-slate-500">{t('booking')}: {v.visit_date} · {v.guests}</div>}
                </div>
                <div className="text-right">
                  <div className="text-xs text-slate-500">{t('expected')}</div>
                  <div className="text-2xl font-extrabold">{money(v.expected_amount)}</div>
                  <PStatus s={v.status} />
                </div>
              </div>
              <div className="mt-3 flex items-center gap-3">
                {v.slip_url ? (
                  <button onClick={() => setImg(v.slip_url)} className="overflow-hidden rounded-xl border"><img src={v.slip_url} alt={t('slip')} className="h-28 w-20 object-cover" /></button>
                ) : <div className="flex h-28 w-20 items-center justify-center rounded-xl bg-slate-100 text-slate-400"><FileImage className="h-6 w-6" /></div>}
                <div className="flex-1 text-sm">
                  {v.reference && <div>{t('reference')}: <b className="font-mono">{v.reference}</b></div>}
                  {!v.slip_url && <div className="text-xs text-slate-500">{t('noSlip')}</div>}
                  {v.reason && <div className="text-xs text-rose-700">{v.reason}</div>}
                  {v.decided_by_name && <div className="text-xs text-slate-500">{t('by')} {v.decided_by_name} · {dateTime(v.decided_at)}</div>}
                </div>
              </div>
              {v.status === 'WAITING_VERIFICATION' && (
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <Button variant="success" size="sm" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => act(v.id, 'approve')}>{t('approve')}</Button>
                  <Button variant="outline" size="sm" icon={<RotateCcw className="h-4 w-4" />} onClick={() => act(v.id, 'newSlip')}>{t('newSlip')}</Button>
                  <Button variant="danger" size="sm" icon={<XCircle className="h-4 w-4" />} onClick={() => act(v.id, 'reject')}>{t('reject')}</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <Modal open={!!img} onClose={() => setImg(null)} title={t('slip')} size="lg">{img && <img src={img} alt="" className="mx-auto max-h-[75vh]" />}</Modal>
    </div>
  );
}
