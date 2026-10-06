import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, Check, X, Loader2 } from 'lucide-react';
import { EVENTS } from '@kiosk/shared';
import { staffApi, errorMessage } from '../lib/api';
import { useSocketEvent } from '../lib/socket';
import { money, time } from '../lib/format';
import { useStaffRt } from '../components/StaffShell';
import { Button, Card, Empty, Loading, StatusBadge, toast } from '../components/ui';
import { tt } from '../lib/legacy-i18n';

/**
 * Sandbox card terminal / payment gateway simulator. Each button produces a properly
 * HMAC-signed provider webhook that goes through the exact production processing path.
 * Replace the sandbox provider with a real EDC / gateway adapter in production.
 */
export function TerminalSimulator() {
  const qc = useQueryClient();
  const { socket } = useStaffRt();
  const q = useQuery({ queryKey: ['provider-pending'], queryFn: () => staffApi<any[]>('/payments/pending-provider'), refetchInterval: 5000 });
  useSocketEvent(socket, [EVENTS.ORDER_UPDATED, EVENTS.PAYMENT_APPROVED, EVENTS.PAYMENT_STATUS], () => void qc.invalidateQueries({ queryKey: ['provider-pending'] }));
  const sim = async (paymentId: string, outcome: string) => {
    try {
      await staffApi('/payments/sandbox/simulate', { body: { paymentId, outcome } });
      toast.success(`Terminal: ${outcome}`);
      void q.refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <div className="scroll-thin h-full overflow-y-auto p-5">
      <Card title={<span className="flex items-center gap-2"><CreditCard className="h-5 w-5" /> {tt('Sandbox card terminal / gateway')}</span>}>
        <p className="mb-4 text-sm text-slate-500">{tt('Payments waiting on the card terminal or payment gateway appear here. Use the buttons to simulate the terminal result (signed webhook).')}</p>
        {q.isLoading ? <Loading /> : !q.data?.length ? <Empty title={tt('No pending terminal payments')} /> : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {q.data.map((p) => (
              <div key={p.id} className="rounded-2xl border p-4">
                <div className="flex items-center justify-between">
                  <div className="text-2xl font-black">#{p.order_number}</div>
                  <StatusBadge status={p.status} />
                </div>
                <div className="text-3xl font-bold text-primary">{money(p.amount)}</div>
                <div className="text-xs text-slate-500">{p.method} · {p.kiosk_code ?? 'POS'} · {time(p.created_at)}</div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button size="sm" variant="outline" icon={<Loader2 className="h-4 w-4" />} onClick={() => sim(p.id, 'processing')}>{tt('Processing')}</Button>
                  <Button size="sm" variant="success" icon={<Check className="h-4 w-4" />} onClick={() => sim(p.id, 'succeeded')}>{tt('Approve')}</Button>
                  <Button size="sm" variant="danger" icon={<X className="h-4 w-4" />} onClick={() => sim(p.id, 'failed')}>{tt('Decline')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => sim(p.id, 'cancelled')}>{tt('Cancel')}</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
