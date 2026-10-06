import { useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, BellRing, ClipboardCheck, CreditCard, History, LayoutList, LogOut, Printer, X } from 'lucide-react';
import { EVENTS } from '@kiosk/shared';
import { useAuth } from '../lib/auth';
import { staffApi } from '../lib/api';
import { useSocketEvent, useOnReconnect } from '../lib/socket';
import { chime, unlockAudio } from '../lib/sound';
import { money, time } from '../lib/format';
import { StaffShell, useStaffRt } from '../components/StaffShell';
import { Button, ConnectionDot, Modal, toast } from '../components/ui';
import { OrdersBoard } from './OrdersBoard';
import { VerificationCenter } from './VerificationCenter';
import { PaymentHistory } from './PaymentHistory';
import { TerminalSimulator } from './TerminalSimulator';
import { tt } from '../lib/legacy-i18n';
import { LangSwitcher } from '../lib/lang';

export default function CashierApp() {
  return (
    <StaffShell perms={['payments.verify', 'payments.cash', 'orders.view']} surface="cashier">
      <CashierLayout />
    </StaffShell>
  );
}

interface Alert {
  kind: 'VERIFICATION' | 'CASH' | 'OTHER';
  orderId: string;
  orderNumber: string;
  amount: number;
  kioskCode?: string | null;
  createdAt?: string;
  verificationId?: string;
  slipUrl?: string | null;
}

function CashierLayout() {
  const { user, branch, logout } = useAuth();
  const { socket, connected, client, printer } = useStaffRt();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [alert, setAlert] = useState<Alert | null>(null);
  const [printerErrors, setPrinterErrors] = useState<{ id: string; message: string; orderNumber?: string; jobId?: string }[]>([]);
  const pending = useQuery({ queryKey: ['verifications', 'count'], queryFn: () => staffApi<any[]>('/payments/verifications'), refetchInterval: 30000 });
  const sandbox = client?.settings?.payment?.card?.provider === 'sandbox' || client?.settings?.payment?.qr?.mode === 'GATEWAY';

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['orders'] });
    void qc.invalidateQueries({ queryKey: ['verifications'] });
    void qc.invalidateQueries({ queryKey: ['order'] });
    void qc.invalidateQueries({ queryKey: ['provider-pending'] });
  };
  useSocketEvent(socket, [EVENTS.ORDER_CREATED, EVENTS.ORDER_UPDATED, EVENTS.ORDER_CONFIRMED, EVENTS.ORDER_READY, EVENTS.ORDER_COMPLETED, EVENTS.ORDER_CANCELLED, EVENTS.PAYMENT_APPROVED, EVENTS.PAYMENT_REJECTED, EVENTS.PAYMENT_STATUS, EVENTS.PRINT_JOB_UPDATED], refresh);
  useOnReconnect(socket, refresh);
  useSocketEvent(socket, EVENTS.PAYMENT_WAITING, (d: Alert) => {
    refresh();
    chime('alert');
    if (d.kind === 'VERIFICATION') setAlert(d);
    else toast.info(`${d.kind === 'CASH' ? `💵 ${tt('Cash payment waiting')}` : tt('Payment at counter')} — #${d.orderNumber}`, `${money(d.amount)}${d.kioskCode ? ` · ${d.kioskCode}` : ''}`);
  });
  useSocketEvent(socket, EVENTS.STAFF_CALL, (d) => {
    chime('alert');
    toast.warning(`🔔 ${d.reason === 'LATE_PAYMENT_NEEDS_REFUND' ? tt('Late payment needs refund') : tt('Customer needs help')}${d.orderNumber ? ` — #${d.orderNumber}` : ''}`, d.kioskCode ?? '');
  });
  useSocketEvent(socket, EVENTS.PRINTER_ERROR, (d) => {
    chime('alert');
    setPrinterErrors((l) => [{ id: `${d.jobId ?? d.printerId}-${Date.now()}`, message: d.message, orderNumber: d.orderNumber, jobId: d.jobId }, ...l].slice(0, 5));
  });

  const nav_items = [
    { to: '/cashier', label: 'Orders', icon: LayoutList, end: true },
    { to: '/cashier/verify', label: 'Slip Verification', icon: ClipboardCheck, count: pending.data?.length },
    { to: '/cashier/history', label: 'Payment History', icon: History },
    ...(sandbox ? [{ to: '/cashier/terminal', label: 'Card Terminal', icon: CreditCard }] : []),
  ];

  return (
    <div className="flex h-full flex-col bg-slate-100" onPointerDown={unlockAudio}>
      <header className="flex h-16 shrink-0 items-center gap-4 border-b bg-white px-4">
        <img src="/icon.svg" className="h-9 w-9" alt="" />
        <div className="leading-tight">
          <div className="font-bold">{tt('Cashier')}</div>
          <div className="text-xs text-slate-500">{branch?.code}</div>
        </div>
        <nav className="ml-4 flex gap-1">
          {nav_items.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => clsx('flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium', isActive ? 'bg-primary text-white' : 'text-slate-600 hover:bg-slate-100')}>
              <n.icon className="h-4 w-4" />
              {tt(n.label)}
              {!!n.count && <span className="rounded-full bg-rose-500 px-1.5 text-xs font-bold text-white">{n.count}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {printer.printers.length > 0 && (
            <span className="flex items-center gap-1 text-xs text-slate-500">
              <Printer className="h-4 w-4" /> {printer.printers.length} {tt('local')}
            </span>
          )}
          <LangSwitcher compact />
          <ConnectionDot connected={connected} />
          <span className="text-sm font-medium">{user?.name}</span>
          <Button size="sm" variant="ghost" icon={<LogOut className="h-4 w-4" />} onClick={() => logout()}>
            {tt('Logout')}
          </Button>
        </div>
      </header>
      {printerErrors.length > 0 && (
        <div className="space-y-1 bg-rose-600 px-4 py-2 text-sm text-white">
          {printerErrors.map((p) => (
            <div key={p.id} className="flex items-center gap-3">
              <AlertTriangle className="h-4 w-4" />
              <span className="font-semibold">{p.message}</span>
              {p.orderNumber && <span>— {tt('Order #')}{p.orderNumber}</span>}
              {p.jobId && (
                <button className="rounded bg-white/20 px-2 py-0.5 text-xs" onClick={() => staffApi(`/print/jobs/${p.jobId}/retry`, { method: 'POST' }).then(() => toast.success(tt('Retry queued'))).catch((e) => toast.error(e))}>
                  {tt('Retry')}
                </button>
              )}
              <button className="ml-auto" onClick={() => setPrinterErrors((l) => l.filter((x) => x.id !== p.id))}>
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      <main className="min-h-0 flex-1 overflow-hidden">
        <Routes>
          <Route index element={<OrdersBoard />} />
          <Route path="verify" element={<VerificationCenter />} />
          <Route path="verify/:id" element={<VerificationCenter />} />
          <Route path="history" element={<PaymentHistory />} />
          <Route path="terminal" element={<TerminalSimulator />} />
        </Routes>
      </main>

      <Modal open={!!alert} onClose={() => setAlert(null)} title={<span className="flex items-center gap-2 text-orange-600"><BellRing className="h-5 w-5 animate-bounce" /> มีรายการรอตรวจสอบการชำระเงิน</span>} size="sm"
        footer={<><Button variant="ghost" onClick={() => setAlert(null)}>{tt('Later')}</Button><Button onClick={() => { nav(`/cashier/verify/${alert!.verificationId}`); setAlert(null); }}>{tt('Open verification')}</Button></>}>
        {alert && (
          <div className="space-y-2 text-center">
            <div className="text-sm text-slate-500">{tt('Payment verification request')}</div>
            <div className="text-5xl font-black tracking-wider">#{alert.orderNumber}</div>
            <div className="text-3xl font-bold text-primary">{money(alert.amount)}</div>
            <div className="text-sm text-slate-500">
              {alert.kioskCode ?? 'Kiosk'} · ordered {time(alert.createdAt)}
            </div>
            {alert.slipUrl && <img src={alert.slipUrl} alt="slip" className="mx-auto max-h-48 rounded-lg" />}
          </div>
        )}
      </Modal>
    </div>
  );
}
