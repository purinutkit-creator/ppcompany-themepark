import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { CreditCard, Landmark, QrCode as QrIcon, Smartphone, Upload, Wallet } from 'lucide-react';
import { money } from '../lib/format';
import { defineStrings, useT } from '../lib/lang';
import { Button, Input, toast } from '../components/ui';
import { QrCode } from './scan';

export const OP = defineStrings('pay', {
  choose: { th: 'เลือกวิธีชำระเงิน', en: 'Choose a payment method', zh: '选择支付方式' },
  promptpay: { th: 'พร้อมเพย์ QR', en: 'PromptPay QR', zh: 'PromptPay 二维码' },
  card: { th: 'บัตรเครดิต / เดบิต', en: 'Credit / debit card', zh: '信用卡 / 借记卡' },
  mobile: { th: 'โมบายแบงก์กิ้ง', en: 'Mobile banking', zh: '手机银行' },
  transfer: { th: 'โอนผ่านธนาคาร', en: 'Bank transfer', zh: '银行转账' },
  wallet: { th: 'เงินในบัตรสมาชิก', en: 'Member wallet', zh: '会员钱包' },
  scanToPay: { th: 'สแกน QR ด้วยแอปธนาคารเพื่อชำระ', en: 'Scan with any banking app to pay', zh: '使用任意银行App扫码付款' },
  expiresIn: { th: 'QR หมดอายุใน {s}', en: 'QR expires in {s}', zh: '二维码 {s} 后过期' },
  expired: { th: 'QR หมดอายุแล้ว', en: 'QR expired', zh: '二维码已过期' },
  newQr: { th: 'สร้าง QR ใหม่', en: 'New QR', zh: '重新生成' },
  iPaid: { th: 'ฉันชำระเงินแล้ว — แจ้งตรวจสอบ', en: "I've paid — verify", zh: '我已付款 — 提交核对' },
  ref: { th: 'เลขอ้างอิง / เวลาโอน (ถ้ามี)', en: 'Reference / transfer time (optional)', zh: '参考号 / 转账时间（可选）' },
  attachSlip: { th: 'แนบสลิป', en: 'Attach slip', zh: '上传凭证' },
  waiting: { th: 'กำลังตรวจสอบการชำระเงิน…', en: 'Verifying your payment…', zh: '正在核对付款…' },
  waitingSub: { th: 'เจ้าหน้าที่กำลังตรวจสอบ หน้านี้จะอัปเดตอัตโนมัติ', en: 'Our team is checking it — this page updates automatically', zh: '工作人员正在核对，本页将自动更新' },
  rejected: { th: 'ไม่สามารถยืนยันการชำระเงินได้', en: 'We could not confirm the payment', zh: '无法确认付款' },
  newSlip: { th: 'กรุณาแนบสลิปใหม่', en: 'Please upload a new slip', zh: '请重新上传凭证' },
  cardSandbox: { th: 'เกตเวย์ทดสอบ (Sandbox) — เลือกผลการชำระ', en: 'Test gateway (sandbox) — choose an outcome', zh: '测试网关（沙盒）— 选择结果' },
  approve: { th: 'ชำระสำเร็จ', en: 'Approve', zh: '支付成功' },
  decline: { th: 'ปฏิเสธ', en: 'Decline', zh: '拒绝' },
  changeMethod: { th: 'เปลี่ยนวิธีชำระ', en: 'Change method', zh: '更换方式' },
  accountName: { th: 'ชื่อบัญชี', en: 'Account name', zh: '账户名' },
  toPay: { th: 'ยอดที่ต้องชำระ', en: 'Amount due', zh: '应付金额' },
});

const ICON: Record<string, any> = { PROMPTPAY: QrIcon, CARD: CreditCard, MOBILE_BANKING: Smartphone, BANK_TRANSFER: Landmark, WALLET: Wallet };
const LABEL: Record<string, 'promptpay' | 'card' | 'mobile' | 'transfer' | 'wallet'> = { PROMPTPAY: 'promptpay', CARD: 'card', MOBILE_BANKING: 'mobile', BANK_TRANSFER: 'transfer', WALLET: 'wallet' };

export interface OnlinePayProps {
  outstanding: number;
  methods: string[];
  payments: any[];
  verifications: any[];
  accountName?: string | null;
  start: (method: string) => Promise<any>;
  verify: (paymentId: string, reference: string | null) => Promise<any>;
  uploadSlip?: (file: File) => Promise<any>;
  simulate?: (paymentId: string, outcome: 'succeeded' | 'failed') => Promise<any>;
  allowSlip?: boolean;
}

/** Customer payment: PromptPay QR with countdown + "I've paid" verification (slip), card gateway, wallet. */
export function OnlinePay(p: OnlinePayProps) {
  const t = useT(OP);
  const open = p.payments.find((x) => ['PENDING', 'WAITING_CARD', 'PROCESSING', 'WAITING_VERIFICATION'].includes(x.status));
  const lastV = p.verifications[p.verifications.length - 1];
  const [busy, setBusy] = useState(false);
  const [ref, setRef] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [now, setNow] = useState(Date.now());
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);
  const run = async (f: () => Promise<any>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toast.error(t.err(e));
    } finally {
      setBusy(false);
    }
  };
  const waiting = open?.status === 'WAITING_VERIFICATION' || lastV?.status === 'WAITING_VERIFICATION';
  if (waiting) {
    return (
      <div className="rounded-2xl border border-violet-200 bg-violet-50 p-6 text-center">
        <div className="mx-auto mb-3 h-10 w-10 animate-spin rounded-full border-4 border-violet-300 border-t-violet-700" />
        <div className="text-lg font-bold text-violet-900">{t('waiting')}</div>
        <div className="text-sm text-violet-700">{t('waitingSub')}</div>
      </div>
    );
  }
  const secsLeft = open?.expires_at ? Math.max(0, Math.floor((new Date(open.expires_at).getTime() - now) / 1000)) : null;
  return (
    <div className="space-y-4">
      {lastV && ['REJECTED', 'NEW_SLIP_REQUESTED'].includes(lastV.status) && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          <b>{lastV.status === 'NEW_SLIP_REQUESTED' ? t('newSlip') : t('rejected')}</b>
          {lastV.reason && <div>{lastV.reason}</div>}
        </div>
      )}
      <div className="flex items-baseline justify-between rounded-2xl bg-slate-900 px-5 py-4 text-white">
        <span className="text-white/70">{t('toPay')}</span>
        <span className="text-3xl font-extrabold tabular-nums">{money(p.outstanding)}</span>
      </div>
      {!open ? (
        <div>
          <div className="mb-2 font-semibold">{t('choose')}</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {p.methods.map((m) => {
              const I = ICON[m] ?? CreditCard;
              return (
                <button key={m} disabled={busy} onClick={() => run(() => p.start(m))} className="press flex items-center gap-3 rounded-2xl border-2 border-slate-200 bg-white p-4 text-left font-semibold hover:border-primary disabled:opacity-50">
                  <I className="h-7 w-7 text-primary" />
                  {LABEL[m] ? t(LABEL[m]) : m}
                </button>
              );
            })}
          </div>
        </div>
      ) : open.qr_payload ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border bg-white p-5">
          <div className="text-sm text-slate-600">{t('scanToPay')}</div>
          <div className={clsx(secsLeft === 0 && 'opacity-20')}>
            <QrCode value={open.qr_payload} size={240} />
          </div>
          {p.accountName && <div className="text-sm text-slate-500">{t('accountName')}: <b>{p.accountName}</b></div>}
          {secsLeft != null && (secsLeft > 0 ? <div className="font-mono text-sm text-slate-600">{t('expiresIn', { s: `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, '0')}` })}</div> : <div className="font-semibold text-rose-600">{t('expired')}</div>)}
          {secsLeft === 0 ? (
            <Button onClick={() => run(() => p.start(open.method))} loading={busy}>{t('newQr')}</Button>
          ) : (
            <div className="w-full max-w-sm space-y-2">
              <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={t('ref')} />
              {p.allowSlip !== false && p.uploadSlip && (
                <>
                  <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                  <Button variant="outline" className="w-full" icon={<Upload className="h-4 w-4" />} onClick={() => fileInput.current?.click()}>{file ? file.name : t('attachSlip')}</Button>
                </>
              )}
              <Button size="lg" className="w-full" loading={busy} onClick={() => run(async () => {
                await p.verify(open.id, ref || null);
                if (file && p.uploadSlip) await p.uploadSlip(file);
              })}>{t('iPaid')}</Button>
              {p.simulate && open.provider === 'sandbox' && <Button size="sm" variant="ghost" className="w-full" onClick={() => run(() => p.simulate!(open.id, 'succeeded'))}>Sandbox: {t('approve')}</Button>}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border bg-white p-5 text-center">
          <div className="mb-3 text-sm text-slate-600">{t('cardSandbox')}</div>
          <div className="flex justify-center gap-2">
            {p.simulate && open.provider === 'sandbox' && <Button variant="success" loading={busy} onClick={() => run(() => p.simulate!(open.id, 'succeeded'))}>{t('approve')}</Button>}
            {p.simulate && open.provider === 'sandbox' && <Button variant="danger" loading={busy} onClick={() => run(() => p.simulate!(open.id, 'failed'))}>{t('decline')}</Button>}
          </div>
        </div>
      )}
      {open && <Button variant="ghost" size="sm" onClick={() => run(() => p.start('__CHANGE__'))}>{t('changeMethod')}</Button>}
    </div>
  );
}
