import { useEffect, useState } from 'react';
import { buildPromptPayPayload } from '@kiosk/shared';
import QRCode from 'qrcode';
import { Button, Card, Checkbox, Field, I18nInput, Input, Loading, MediaInput, NumberInput, PageHeader, Select, Tabs, Toggle } from '../components/ui';
import { useSaveSetting, useSettings } from './hooks';
import { tt } from '../lib/legacy-i18n';

const TABS = [
  { id: 'store', label: 'Store' }, { id: 'tax', label: 'VAT & service' }, { id: 'order', label: 'Orders' }, { id: 'kiosk', label: 'Kiosk' },
  { id: 'payment', label: 'Payment' }, { id: 'receipt', label: 'Receipt' }, { id: 'security', label: 'Security' }, { id: 'printing', label: 'Print queue' },
] as const;
type Key = (typeof TABS)[number]['id'];

export default function SettingsPage() {
  const s = useSettings();
  const save = useSaveSetting();
  const [tab, setTab] = useState<Key>('store');
  const [v, setV] = useState<any>(null);
  useEffect(() => setV(s.data?.settings ? structuredClone(s.data.settings) : null), [s.data]);
  if (!v) return <Loading />;
  const set = (path: string, val: any) => setV((x: any) => {
    const n = structuredClone(x);
    const parts = path.split('.');
    let o = n;
    for (const p of parts.slice(0, -1)) o = o[p];
    o[parts.at(-1)!] = val;
    return n;
  });
  return (
    <div>
      <PageHeader title={tt('System settings')} sub={tt('Changes are audited and pushed to every device in real time')} actions={<Button onClick={() => save.mutate({ key: tab, value: v[tab] })} loading={save.isPending}>Save {TABS.find((t) => t.id === tab)?.label}</Button>} />
      <Tabs className="mb-4 w-fit" tabs={[...TABS]} value={tab} onChange={setTab} />
      <Card>
        {tab === 'store' && (
          <div className="space-y-4">
            <I18nInput label={tt('Store name')} value={v.store.name} onChange={(x) => set('store.name', x)} />
            <div className="grid gap-4 md:grid-cols-3">
              <Field label={tt('Address')} className="md:col-span-3"><Input value={v.store.address} onChange={(e) => set('store.address', e.target.value)} /></Field>
              <Field label={tt('Phone')}><Input value={v.store.phone} onChange={(e) => set('store.phone', e.target.value)} /></Field>
              <Field label={tt('Tax ID')}><Input value={v.store.taxId} onChange={(e) => set('store.taxId', e.target.value)} /></Field>
              <Field label={tt('Currency')}><Input value={v.store.currency} onChange={(e) => set('store.currency', e.target.value)} /></Field>
              <Field label={tt('Currency symbol')}><Input value={v.store.currencySymbol} onChange={(e) => set('store.currencySymbol', e.target.value)} /></Field>
            </div>
            <MediaInput label={tt('Logo (receipts & screens)')} value={v.store.logoUrl} onChange={(x) => set('store.logoUrl', x)} />
          </div>
        )}
        {tab === 'tax' && (
          <div className="grid gap-4 md:grid-cols-3">
            <Field label={tt('VAT rate (%)')}><NumberInput value={v.tax.vatRate} onChange={(x) => set('tax.vatRate', x ?? 0)} step="0.01" /></Field>
            <Field label={tt('Prices are')}><Select value={v.tax.vatMode} onChange={(e) => set('tax.vatMode', e.target.value)}><option value="INCLUDED">{tt('VAT included')}</option><option value="EXCLUDED">{tt('VAT excluded (added at checkout)')}</option></Select></Field>
            <Field label={tt('Service charge (%)')}><NumberInput value={v.tax.serviceChargeRate} onChange={(x) => set('tax.serviceChargeRate', x ?? 0)} step="0.01" /></Field>
            <Field label={tt('Service charge applies to')}><div className="flex gap-4">{['DINE_IN', 'TAKE_AWAY'].map((t) => <Checkbox key={t} checked={v.tax.serviceChargeOrderTypes.includes(t)} onChange={(c) => set('tax.serviceChargeOrderTypes', c ? [...v.tax.serviceChargeOrderTypes, t] : v.tax.serviceChargeOrderTypes.filter((x: string) => x !== t))} label={t.replace('_', ' ')} />)}</div></Field>
          </div>
        )}
        {tab === 'order' && (
          <div className="grid gap-4 md:grid-cols-3">
            <Field label={tt('Order types')}><div className="space-y-2">{['DINE_IN', 'TAKE_AWAY'].map((t) => <Toggle key={t} checked={v.order.orderTypes[t]} onChange={(c) => set(`order.orderTypes.${t}`, c)} label={t === 'DINE_IN' ? 'Dine in · ทานที่ร้าน' : 'Take away · กลับบ้าน'} />)}</div></Field>
            <Field label={tt('Unpaid order expires after (min)')} hint={tt('Releases reserved stock and the order number')}><NumberInput value={v.order.expiryMinutes} onChange={(x) => set('order.expiryMinutes', x ?? 20)} /></Field>
            <Field label={tt('Auto-complete READY orders after (min, 0 = off)')}><NumberInput value={v.order.autoCompleteReadyMinutes} onChange={(x) => set('order.autoCompleteReadyMinutes', x ?? 0)} /></Field>
            <Toggle checked={v.order.reserveStockOnCreate} onChange={(c) => set('order.reserveStockOnCreate', c)} label={tt('Reserve stock when order is created')} />
            <div className="text-sm text-slate-500 md:col-span-3">{tt('Order numbers: random 5 digits (00000–99999), guaranteed unique among active orders of the branch; internal order IDs are UUIDs.')}</div>
          </div>
        )}
        {tab === 'kiosk' && (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <Field label={tt('Default idle timeout')}><Select value={v.kiosk.idleTimeoutSec} onChange={(e) => set('kiosk.idleTimeoutSec', Number(e.target.value))}>{[30, 60, 90, 120].map((x) => <option key={x} value={x}>{x} seconds</option>)}</Select></Field>
              <Field label={tt('Idle warning countdown (s)')}><NumberInput value={v.kiosk.idleWarningSec} onChange={(x) => set('kiosk.idleWarningSec', x ?? 10)} /></Field>
              <Field label={tt('Return to start after order (s)')}><NumberInput value={v.kiosk.resetAfterOrderSec} onChange={(x) => set('kiosk.resetAfterOrderSec', x ?? 10)} /></Field>
            </div>
            <div className="flex flex-wrap gap-6">
              <Toggle checked={v.kiosk.upsellEnabled} onChange={(c) => set('kiosk.upsellEnabled', c)} label={tt('Upsell / recommendations')} />
              <Toggle checked={v.kiosk.allowSlipUpload} onChange={(c) => set('kiosk.allowSlipUpload', c)} label={tt('Allow slip upload')} />
              <Toggle checked={v.kiosk.allowPromoCode} onChange={(c) => set('kiosk.allowPromoCode', c)} label={tt('Promo code field')} />
            </div>
            <I18nInput label={tt('Welcome title')} value={v.kiosk.welcome.title} onChange={(x) => set('kiosk.welcome.title', x)} />
            <I18nInput label={tt('Welcome subtitle')} value={v.kiosk.welcome.subtitle} onChange={(x) => set('kiosk.welcome.subtitle', x)} />
            <p className="text-xs text-slate-500">{tt('Per-kiosk overrides (language, idle timeout, payment methods, printer, theme) are in Admin → Kiosks.')}</p>
          </div>
        )}
        {tab === 'payment' && <PaymentSettings v={v} set={set} />}
        {tab === 'receipt' && (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <Toggle checked={v.receipt.enabled} onChange={(c) => set('receipt.enabled', c)} label={tt('Print customer receipt')} />
              <Field label={tt('Copies')}><Select value={v.receipt.copies} onChange={(e) => set('receipt.copies', Number(e.target.value))}>{[0, 1, 2, 3, 4, 5].map((x) => <option key={x} value={x}>{x === 0 ? '0 (no receipt)' : `${x} cop${x > 1 ? 'ies' : 'y'}`}</option>)}</Select></Field>
              <Field label={tt('Receipt language')}><Select value={v.receipt.language} onChange={(e) => set('receipt.language', e.target.value)}><option value="ORDER">{tt('Customer\'s language')}</option><option value="th">ไทย</option><option value="en">{tt('English')}</option><option value="zh">中文</option></Select></Field>
              <Toggle checked={v.receipt.showLogo} onChange={(c) => set('receipt.showLogo', c)} label={tt('Print logo')} />
              <Toggle checked={v.receipt.showQr} onChange={(c) => set('receipt.showQr', c)} label={tt('QR code for order lookup')} />
            </div>
            <I18nInput label={tt('Footer')} value={v.receipt.footer} onChange={(x) => set('receipt.footer', x)} />
            <p className="text-xs text-slate-500">{tt('Kitchen ticket settings: Admin → Kitchen. Fonts: Admin → Fonts. Printers & routing: Admin → Printers.')}</p>
          </div>
        )}
        {tab === 'security' && (
          <div className="space-y-4">
            <Field label={tt('Require manager PIN for')}>
              <div className="flex flex-wrap gap-4">
                {[['REFUND', 'Refund'], ['VOID', 'Void'], ['MANUAL_PAYMENT_APPROVAL', 'Manual payment approval'], ['REPRINT', 'Reprint'], ['CANCEL_PAID_ORDER', 'Cancel paid order']].map(([k, l]) => (
                  <Checkbox key={k} checked={v.security.managerPinActions.includes(k)} onChange={(c) => set('security.managerPinActions', c ? [...v.security.managerPinActions, k] : v.security.managerPinActions.filter((x: string) => x !== k))} label={l} />
                ))}
              </div>
            </Field>
            <div className="grid gap-4 md:grid-cols-3">
              <Field label={tt('Max failed logins before lock')}><NumberInput value={v.security.maxLoginAttempts} onChange={(x) => set('security.maxLoginAttempts', x ?? 5)} /></Field>
              <Field label={tt('Lock duration (min)')}><NumberInput value={v.security.lockMinutes} onChange={(x) => set('security.lockMinutes', x ?? 5)} /></Field>
            </div>
          </div>
        )}
        {tab === 'printing' && (
          <div className="grid gap-4 md:grid-cols-3">
            <Field label={tt('Max automatic retries')}><NumberInput value={v.printing.retryMaxAttempts} onChange={(x) => set('printing.retryMaxAttempts', x ?? 5)} /></Field>
            <Field label={tt('Retry back-off base (s)')} hint="5s, 10s, 20s, 40s…"><NumberInput value={v.printing.retryBaseSec} onChange={(x) => set('printing.retryBaseSec', x ?? 5)} /></Field>
            <Field label={tt('Executor timeout (s)')} hint={tt('Unanswered jobs become FAILED (manual retry — avoids double printing)')}><NumberInput value={v.printing.staleClaimSec} onChange={(x) => set('printing.staleClaimSec', x ?? 90)} /></Field>
          </div>
        )}
      </Card>
    </div>
  );
}

function PaymentSettings({ v, set }: { v: any; set: (p: string, x: any) => void }) {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    try {
      const payload = v.payment.qr.mode === 'PROMPTPAY_STATIC' ? buildPromptPayPayload(v.payment.qr.promptpayId) : buildPromptPayPayload(v.payment.qr.promptpayId, 1.0);
      void QRCode.toDataURL(payload, { width: 160, margin: 1 }).then(setQr);
    } catch {
      setQr(null);
    }
  }, [v.payment.qr.promptpayId, v.payment.qr.mode]);
  return (
    <div className="space-y-5">
      <Field label={tt('Payment methods')}>
        <div className="flex flex-wrap gap-5">
          {[['QR', 'QR / Bank transfer'], ['CASH', 'Cash'], ['CARD', 'Credit / Debit card'], ['OTHER', 'Other']].map(([k, l]) => <Toggle key={k} checked={v.payment.methods[k]} onChange={(c) => set(`payment.methods.${k}`, c)} label={l} />)}
        </div>
      </Field>
      <div className="grid gap-4 md:grid-cols-[1fr_auto]">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label={tt('QR mode')}><Select value={v.payment.qr.mode} onChange={(e) => set('payment.qr.mode', e.target.value)}><option value="PROMPTPAY_DYNAMIC">{tt('Dynamic PromptPay (amount in QR)')}</option><option value="PROMPTPAY_STATIC">{tt('Static PromptPay')}</option><option value="GATEWAY">{tt('Payment gateway QR')}</option></Select></Field>
          <Field label={tt('PromptPay ID (phone / tax ID)')}><Input value={v.payment.qr.promptpayId} onChange={(e) => set('payment.qr.promptpayId', e.target.value)} /></Field>
          <Field label={tt('QR countdown (seconds)')}><NumberInput value={v.payment.qr.countdownSec} onChange={(x) => set('payment.qr.countdownSec', x ?? 300)} /></Field>
          <Field label={tt('Account name')}><Input value={v.payment.qr.accountName} onChange={(e) => set('payment.qr.accountName', e.target.value)} /></Field>
          <Field label={tt('Bank / label')}><Input value={v.payment.qr.bankName} onChange={(e) => set('payment.qr.bankName', e.target.value)} /></Field>
          <Field label={tt('Gateway provider')}><Select value={v.payment.qr.gatewayProvider} onChange={(e) => set('payment.qr.gatewayProvider', e.target.value)}><option value="sandbox">{tt('Sandbox (signed webhooks)')}</option></Select></Field>
        </div>
        {qr && <div className="text-center"><img src={qr} alt="" className="rounded-lg border" /><div className="text-xs text-slate-500">{tt('PromptPay test QR (฿1)')}</div></div>}
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label={tt('Cash quick amounts (comma separated)')}><Input value={v.payment.cash.quickAmounts.join(',')} onChange={(e) => set('payment.cash.quickAmounts', e.target.value.split(',').map((x) => Number(x.trim())).filter((x) => x > 0))} /></Field>
        <Field label={tt('Card provider / terminal')}><Select value={v.payment.card.provider} onChange={(e) => set('payment.card.provider', e.target.value)}><option value="sandbox">{tt('Sandbox terminal')}</option></Select></Field>
        <Field label={tt('Card timeout (s)')}><NumberInput value={v.payment.card.timeoutSec} onChange={(x) => set('payment.card.timeoutSec', x ?? 120)} /></Field>
      </div>
      <I18nInput label={tt('“Other payment” label')} value={v.payment.other.label} onChange={(x) => set('payment.other.label', x)} />
      <p className="text-xs text-slate-500">{tt('Card data never touches this system: terminals/gateways return only masked info. Provider callbacks are verified with HMAC-SHA256 signatures + timestamp window + event-id de-duplication.')}</p>
    </div>
  );
}
