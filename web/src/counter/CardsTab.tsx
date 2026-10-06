import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Ban, CreditCard, History, Link2, Pause, Play, Printer, RefreshCcw, UserPlus, Wallet } from 'lucide-react';
import { EVENTS } from '@kiosk/shared';
import { parkApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, money } from '../lib/format';
import { defineStrings, useT } from '../lib/lang';
import { useSocketEvent, watch } from '../lib/socket';
import { Button, Checkbox, Empty, Field, Input, Loading, Modal, NumberInput, Select, Tabs, confirmDialog, promptDialog, toast, withManagerApproval } from '../components/ui';
import { useStaffRt } from '../components/StaffShell';
import { ScanBar } from '../park/scan';
import { PStatus, ProfilePanel } from '../park/ui';

const CD = defineStrings('cards', {
  scan: { th: 'สแกนบัตร / ริสแบนด์ / QR ตั๋ว / QR สมาชิก', en: 'Scan card / wristband / ticket QR / member QR', zh: '扫描卡 / 腕带 / 门票码 / 会员码' },
  lost: { th: 'แจ้งหาย', en: 'Report lost', zh: '挂失' },
  replace: { th: 'ออกบัตรใหม่ (ย้ายยอด)', en: 'Replace (transfer balance)', zh: '补卡（转移余额）' },
  suspend: { th: 'ระงับชั่วคราว', en: 'Suspend', zh: '暂停' },
  unsuspend: { th: 'ยกเลิกระงับ', en: 'Unsuspend', zh: '恢复' },
  block: { th: 'บล็อก', en: 'Block', zh: '冻结' },
  unblock: { th: 'ปลดบล็อก', en: 'Unblock', zh: '解冻' },
  activate: { th: 'เปิดใช้งาน', en: 'Activate', zh: '激活' },
  bindMember: { th: 'ผูกกับสมาชิก', en: 'Link to member', zh: '绑定会员' },
  print: { th: 'พิมพ์', en: 'Print', zh: '打印' },
  adjust: { th: 'ปรับยอดเงิน', en: 'Adjust wallet', zh: '调整余额' },
  cashOut: { th: 'คืนเงินคงเหลือ', en: 'Refund balance', zh: '退还余额' },
  rotate: { th: 'เปลี่ยนรหัส QR', en: 'Rotate QR', zh: '更换二维码' },
  history: { th: 'ประวัติ', en: 'History', zh: '记录' },
  newCode: { th: 'สแกนบัตร/ริสแบนด์ใหม่ (เว้นว่าง = ออกใหม่อัตโนมัติ)', en: 'Scan the new card / wristband (empty = generate)', zh: '扫描新卡/腕带（留空=自动生成）' },
  replaceReason: { th: 'สาเหตุ', en: 'Reason', zh: '原因' },
  amountHint: { th: 'ใส่ค่าติดลบเพื่อหักเงิน', en: 'Use a negative amount to deduct', zh: '负数表示扣减' },
  bonus: { th: 'เป็นเครดิตโบนัส (คืนเงินไม่ได้)', en: 'Bonus credit (non-refundable)', zh: '赠送额度（不可退）' },
  cashOutMode: { th: 'วิธีคืน', en: 'Refund to', zh: '退还方式' },
  toCash: { th: 'เงินสด', en: 'Cash', zh: '现金' },
  toMember: { th: 'โอนเข้าบัญชีสมาชิก', en: 'Transfer to member account', zh: '转入会员账户' },
  findMember: { th: 'ค้นหาสมาชิก (เบอร์ / เลขสมาชิก / ชื่อ)', en: 'Find member (phone / member no. / name)', zh: '查找会员（电话 / 会员号 / 姓名）' },
  registerMember: { th: 'สมัครสมาชิกใหม่', en: 'Register member', zh: '注册会员' },
  issueCard: { th: 'ออกบัตรสมาชิก', en: 'Issue member card', zh: '发放会员卡' },
  cardCodeOpt: { th: 'สแกนบัตรที่จะผูก (ไม่บังคับ)', en: 'Scan a card to link (optional)', zh: '扫描要绑定的卡（可选）' },
  firstName: { th: 'ชื่อ', en: 'First name', zh: '名' },
  lastName: { th: 'นามสกุล', en: 'Last name', zh: '姓' },
  birthday: { th: 'วันเกิด', en: 'Birthday', zh: '生日' },
  ledger: { th: 'กระเป๋าเงิน', en: 'Wallet', zh: '钱包' },
  sales: { th: 'การซื้อ', en: 'Purchases', zh: '购买' },
  rides: { th: 'เครื่องเล่น', en: 'Rides', zh: '游乐' },
  gates: { th: 'ประตู', en: 'Gates', zh: '闸门' },
  food: { th: 'อาหาร', en: 'Food', zh: '餐饮' },
  pointsTab: { th: 'คะแนน', en: 'Points', zh: '积分' },
  registered: { th: 'สมัครสมาชิกแล้ว {no}', en: 'Member registered {no}', zh: '会员已注册 {no}' },
});

export function CardsTab() {
  const t = useT(CD);
  const { can } = useAuth();
  const { socket } = useStaffRt();
  const qc = useQueryClient();
  const [code, setCode] = useState<string | null>(null);
  const [register, setRegister] = useState(false);
  const prof = useQuery({ queryKey: ['card-profile', code], queryFn: () => parkApi('/cards/scan', { body: { code } }), enabled: !!code, retry: false });
  const p = prof.data;
  const accountId = p?.credential?.account_id;
  useSocketEvent(socket, [EVENTS.WALLET_UPDATED, EVENTS.CREDENTIAL_UPDATED, EVENTS.POINTS_UPDATED, EVENTS.TICKET_UPDATED], () => void qc.invalidateQueries({ queryKey: ['card-profile'] }));
  // Stream this account's events (wallet / points) while the profile is open.
  useEffect(() => watch(socket, 'account', accountId), [socket, accountId]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['card-profile'] });
  const run = async (fn: () => Promise<any>, ok?: string) => {
    try {
      await fn();
      if (ok) toast.success(ok);
      refresh();
    } catch (e) { toast.error(t.err(e)); }
  };
  const status = (action: string, needReason = false) => run(async () => {
    const reason = needReason ? await promptDialog(t('reason')) : null;
    if (needReason && !reason) return;
    await parkApi(`/cards/${p.credential.id}/status`, { body: { action, reason } });
  });
  const st = p?.credential?.status;
  return (
    <div className="grid min-h-full gap-3 p-3 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 shadow-sm">
          <ScanBar className="min-w-72 flex-1" onScan={(c) => setCode(c)} placeholder={t('scan')} />
          {can('members.manage') && <Button variant="outline" icon={<UserPlus className="h-4 w-4" />} onClick={() => setRegister(true)}>{t('registerMember')}</Button>}
        </div>
        {!code ? <div className="rounded-2xl bg-white p-8 shadow-sm"><Empty icon={<CreditCard className="h-7 w-7" />} title={t('scan')} /></div> : prof.isError ? <div className="rounded-2xl bg-rose-50 p-4 text-rose-700">{t.err(prof.error)}</div> : !p ? <Loading /> : (
          <ProfilePanel
            p={p}
            actions={can('cards.manage') ? (
              <>
                {['ACTIVE', 'SUSPENDED'].includes(st) && <ActionBtn icon={Ban} onClick={async () => (await confirmDialog(t('lost'), p.credential.code, true)) && status('LOST')}>{t('lost')}</ActionBtn>}
                {['ACTIVE', 'LOST', 'SUSPENDED', 'BLOCKED', 'EXPIRED'].includes(st) && <ReplaceDialog credentialId={p.credential.id} onDone={(newCode) => { setCode(newCode); refresh(); }} />}
                {st === 'ACTIVE' && <ActionBtn icon={Pause} onClick={() => status('SUSPEND', true)}>{t('suspend')}</ActionBtn>}
                {st === 'SUSPENDED' && <ActionBtn icon={Play} onClick={() => status('UNSUSPEND')}>{t('unsuspend')}</ActionBtn>}
                {st !== 'BLOCKED' && st !== 'CLOSED' && <ActionBtn icon={Ban} onClick={() => status('BLOCK', true)}>{t('block')}</ActionBtn>}
                {st === 'BLOCKED' && <ActionBtn icon={Play} onClick={() => status('UNBLOCK')}>{t('unblock')}</ActionBtn>}
                {st === 'NEW' && <ActionBtn icon={Play} onClick={() => status('ACTIVATE')}>{t('activate')}</ActionBtn>}
                <ActionBtn icon={RefreshCcw} onClick={() => run(() => parkApi(`/cards/${p.credential.id}/rotate`, { method: 'POST' }), t('rotate'))}>{t('rotate')}</ActionBtn>
                <ActionBtn icon={Printer} onClick={() => run(() => parkApi(`/cards/${p.credential.id}/print`, { body: { kind: p.credential.type.includes('WRISTBAND') ? 'WRISTBAND' : 'CARD', language: t.lang } }), t('print'))}>{t('print')}</ActionBtn>
              </>
            ) : null}
          />
        )}
      </div>
      {p && (
        <div className="space-y-3">
          {!p.member && can('cards.issue') && <LinkMember credentialId={p.credential.id} onDone={refresh} />}
          {accountId && (can('wallet.adjust') || can('wallet.refund')) && <WalletTools accountId={accountId} credentialId={p.credential.id} onDone={refresh} />}
          <CardHistory credentialId={p.credential.id} />
        </div>
      )}
      {register && <RegisterMember onClose={() => setRegister(false)} onDone={(c) => { setRegister(false); if (c) setCode(c); }} />}
    </div>
  );
}

function ActionBtn({ icon: I, children, onClick }: { icon: any; children: React.ReactNode; onClick: () => void }) {
  return <button onClick={onClick} className="flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold hover:bg-white/25"><I className="h-3.5 w-3.5" />{children}</button>;
}

function ReplaceDialog({ credentialId, onDone }: { credentialId: string; onDone: (code: string) => void }) {
  const t = useT(CD);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('LOST');
  const [print, setPrint] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <ActionBtn icon={RefreshCcw} onClick={() => setOpen(true)}>{t('replace')}</ActionBtn>
      <Modal open={open} onClose={() => setOpen(false)} title={t('replace')} size="md" footer={<Button loading={busy} onClick={async () => {
        setBusy(true);
        try {
          const r = await withManagerApproval(t('replace'), (a) => parkApi(`/cards/${credentialId}/replace`, { body: { newCode: code.trim() || null, generate: !code.trim(), reason, print, ...a } }));
          if (r) {
            setOpen(false);
            onDone(r.profile?.credential?.qr ?? code);
          }
        } catch (e) { toast.error(t.err(e)); } finally { setBusy(false); }
      }}>{t('confirm')}</Button>}>
        <div className="space-y-3">
          <Field label={t('newCode')}><Input data-scan="1" value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" /></Field>
          <Field label={t('replaceReason')}><Select value={reason} onChange={(e) => setReason(e.target.value)}>{['LOST', 'DAMAGED', 'STOLEN', 'UPGRADE', 'OTHER'].map((r) => <option key={r} value={r}>{t.status(r)}</option>)}</Select></Field>
          <Checkbox checked={print} onChange={setPrint} label={t('print')} />
        </div>
      </Modal>
    </>
  );
}

function LinkMember({ credentialId, onDone }: { credentialId: string; onDone: () => void }) {
  const t = useT(CD);
  const [q, setQ] = useState('');
  const res = useQuery({ queryKey: ['member-search', q], queryFn: () => parkApi(`/members?q=${encodeURIComponent(q)}&limit=8`), enabled: q.trim().length >= 3 });
  return (
    <div className="rounded-2xl bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Link2 className="h-4 w-4" />{t('bindMember')}</div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('findMember')} />
      <div className="mt-2 space-y-1">
        {(res.data ?? []).map((m: any) => (
          <button key={m.id} onClick={async () => {
            try {
              await parkApi(`/cards/${credentialId}/member`, { body: { memberId: m.id } });
              onDone();
            } catch (e) { toast.error(t.err(e)); }
          }} className="flex w-full items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-left text-sm hover:bg-primary/10">
            <span>{m.first_name} {m.last_name} · <span className="font-mono text-xs">{m.member_no}</span></span><span className="text-xs text-slate-500">{m.phone}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function WalletTools({ accountId, credentialId, onDone }: { accountId: string; credentialId: string; onDone: () => void }) {
  const t = useT(CD);
  const { can } = useAuth();
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [bonus, setBonus] = useState(false);
  const [mode, setMode] = useState<'CASH' | 'TRANSFER_TO_MEMBER'>('CASH');
  const run = async (fn: () => Promise<any>) => {
    try {
      const r = await fn();
      if (r) {
        toast.success(t('saved'));
        onDone();
      }
    } catch (e) { toast.error(t.err(e)); }
  };
  return (
    <div className="space-y-3 rounded-2xl bg-white p-3 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-semibold"><Wallet className="h-4 w-4" />{t('ledger')}</div>
      {can('wallet.adjust') && (
        <div className="space-y-2">
          <Field label={t('adjust')} hint={t('amountHint')}><NumberInput value={amount} onChange={setAmount} /></Field>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('reason')} />
          <Checkbox checked={bonus} onChange={setBonus} label={t('bonus')} />
          <Button size="sm" disabled={!amount || reason.length < 3} onClick={() => run(() => withManagerApproval(t('adjust'), (a) => parkApi(`/wallets/${accountId}/adjust`, { body: { amount, reason, bonus, credentialId, ...a } })))}>{t('adjust')}</Button>
        </div>
      )}
      {can('wallet.refund') && (
        <div className="space-y-2 border-t pt-3">
          <Field label={t('cashOutMode')}><Select value={mode} onChange={(e) => setMode(e.target.value as any)}><option value="CASH">{t('toCash')}</option><option value="TRANSFER_TO_MEMBER">{t('toMember')}</option></Select></Field>
          <Button size="sm" variant="outline" onClick={async () => (await confirmDialog(t('cashOut'))) && run(() => withManagerApproval(t('cashOut'), (a) => parkApi(`/wallets/${accountId}/cash-out`, { body: { mode, credentialId, ...a } })))}>{t('cashOut')}</Button>
        </div>
      )}
    </div>
  );
}

function CardHistory({ credentialId }: { credentialId: string }) {
  const t = useT(CD);
  const [tab, setTab] = useState<'ledger' | 'sales' | 'rides' | 'gates' | 'orders' | 'points'>('ledger');
  const h = useQuery({ queryKey: ['card-history', credentialId], queryFn: () => parkApi(`/cards/${credentialId}/history`) });
  const rows: any[] = h.data?.[tab] ?? [];
  return (
    <div className="rounded-2xl bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><History className="h-4 w-4" />{t('history')}</div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'ledger', label: t('ledger') }, { id: 'sales', label: t('sales') }, { id: 'rides', label: t('rides') }, { id: 'gates', label: t('gates') }, { id: 'orders', label: t('food') }, { id: 'points', label: t('pointsTab') }]} className="mb-2" />
      {!h.data ? <Loading /> : !rows.length ? <Empty /> : (
        <div className="scroll-thin max-h-96 space-y-1 overflow-y-auto text-xs">
          {rows.map((r: any, i: number) => (
            <div key={r.id ?? i} className="flex items-center gap-2 rounded-lg bg-slate-50 px-2 py-1.5">
              <span className="w-28 shrink-0 text-slate-500">{dateTime(r.created_at)}</span>
              <span className="min-w-0 flex-1 truncate">
                {tab === 'ledger' && <>{t.status(r.type)} {r.reference ?? ''}</>}
                {tab === 'sales' && <>{r.sale_no} · {r.kind}</>}
                {tab === 'rides' && <>{t.tr(r.ride_name)} {r.reason_code ? `· ${t.reason(r.reason_code)}` : ''}</>}
                {tab === 'gates' && <>{r.gate} · {r.direction} {r.reason_code ? `· ${t.reason(r.reason_code)}` : ''}</>}
                {tab === 'orders' && <>#{r.order_number} · {t.method(r.payment_method)}</>}
                {tab === 'points' && <>{t.status(r.type)} {r.reference ?? ''}</>}
              </span>
              <span className={clsx('shrink-0 font-semibold tabular-nums', tab === 'ledger' && Number(r.credit) > 0 && 'text-emerald-700', tab === 'ledger' && Number(r.debit) > 0 && 'text-rose-700')}>
                {tab === 'ledger' ? (Number(r.credit) > 0 ? `+${money(r.credit)}` : `−${money(r.debit)}`) : tab === 'points' ? r.points : tab === 'sales' || tab === 'orders' ? money(r.total) : null}
              </span>
              {(tab === 'sales' || tab === 'rides' || tab === 'gates' || tab === 'orders') && <PStatus s={r.status ?? r.result} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RegisterMember({ onClose, onDone }: { onClose: () => void; onDone: (cardCode: string | null) => void }) {
  const t = useT(CD);
  const [f, setF] = useState({ phone: '', firstName: '', lastName: '', email: '', birthday: '', cardCode: '' });
  const [issue, setIssue] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Modal open onClose={onClose} title={t('registerMember')} size="md" footer={<Button loading={busy} disabled={!f.phone || !f.firstName} onClick={async () => {
      setBusy(true);
      try {
        const r = await parkApi('/members', { body: { phone: f.phone, firstName: f.firstName, lastName: f.lastName, email: f.email || null, birthday: f.birthday || null, language: t.lang, issuePhysicalCard: issue, cardCode: f.cardCode.trim() || null } });
        toast.success(t('registered', { no: r.member.member_no }));
        onDone(f.cardCode.trim() || r.card?.credential?.qr || null);
      } catch (e) { toast.error(t.err(e)); } finally { setBusy(false); }
    }}>{t('save')}</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('firstName')}><Input value={f.firstName} onChange={(e) => set('firstName', e.target.value)} /></Field>
        <Field label={t('lastName')}><Input value={f.lastName} onChange={(e) => set('lastName', e.target.value)} /></Field>
        <Field label={t('phone')}><Input value={f.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" /></Field>
        <Field label={t('email')}><Input value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label={t('birthday')}><Input type="date" value={f.birthday} onChange={(e) => set('birthday', e.target.value)} /></Field>
        <Field label={t('cardCodeOpt')}><Input data-scan="1" value={f.cardCode} onChange={(e) => set('cardCode', e.target.value)} className="font-mono" /></Field>
        <div className="sm:col-span-2"><Checkbox checked={issue} onChange={setIssue} label={t('issueCard')} /></div>
      </div>
    </Modal>
  );
}
