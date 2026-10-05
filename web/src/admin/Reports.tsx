import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet, Printer } from 'lucide-react';
import { staffApi, downloadStaff, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateOnly, dateTime, money } from '../lib/format';
import { Button, Card, Empty, ErrorBox, Field, Input, Loading, PageHeader, Select, Table, Td, toast } from '../components/ui';
import { useList } from './hooks';
import { tr } from '@kiosk/shared';

const REPORTS: [string, string][] = [
  ['daily-sales', 'Daily Sales'], ['hourly-sales', 'Hourly Sales'], ['product-sales', 'Product Sales'], ['category-sales', 'Category Sales'],
  ['payments', 'Payment Report'], ['cash', 'Cash Report'], ['transfer', 'Transfer Report'], ['card', 'Card Report'], ['orders', 'Order Report'],
  ['cancelled', 'Cancelled Orders'], ['refunds', 'Refund Report'], ['promotions', 'Promotion Report'], ['kiosk-performance', 'Kiosk Performance'],
  ['kitchen-time', 'Kitchen Preparation Time'], ['aov', 'Average Order Value'],
];

export default function Reports() {
  const { can, branch } = useAuth();
  const today = new Date();
  const [type, setType] = useState('daily-sales');
  const [from, setFrom] = useState(dateOnly(new Date(today.getTime() - 6 * 86400000)));
  const [to, setTo] = useState(dateOnly(today));
  const [hourFrom, setHourFrom] = useState('');
  const [hourTo, setHourTo] = useState('');
  const [kioskId, setKioskId] = useState('');
  const [method, setMethod] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [productId, setProductId] = useState('');
  const kiosks = useList('kiosks', '/devices/kiosks');
  const cats = useList('categories', '/menu/categories');
  const products = useList('products', '/menu/products');
  const p = new URLSearchParams({ from, to });
  if (hourFrom) p.set('hourFrom', hourFrom);
  if (hourTo) p.set('hourTo', hourTo);
  if (kioskId) p.set('kioskId', kioskId);
  if (method) p.set('method', method);
  if (categoryId) p.set('categoryId', categoryId);
  if (productId) p.set('productId', productId);
  const q = useQuery({ queryKey: ['report', type, p.toString()], queryFn: () => staffApi<any>(`/reports/${type}?${p}`) });
  const fmt = (c: any, v: any) => (v == null ? '—' : c.type === 'money' ? money(v) : c.type === 'datetime' ? dateTime(v) : c.type === 'percent' ? `${v}%` : String(v));
  const totals = q.data?.columns.filter((c: any) => c.type === 'money' || (c.type === 'number' && !/avg|per|max/i.test(c.key)));
  const exp = async (format: 'csv' | 'xlsx') => {
    try {
      await downloadStaff(`/reports/${type}?${p}&format=${format}`, `${type}-${from}-${to}.${format}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const exportPdf = () => {
    // Opens a print-optimised view; "Save as PDF" in the print dialog renders Thai/Chinese correctly.
    const w = window.open('', '_blank');
    if (!w || !q.data) return;
    const r = q.data;
    const esc = (s: string) => s.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m]!);
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.title)}</title>
      <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;700&family=Noto+Sans+SC&display=swap" rel="stylesheet">
      <style>body{font-family:Sarabun,'Noto Sans SC',sans-serif;padding:24px;color:#111}h1{margin:0}table{border-collapse:collapse;width:100%;margin-top:16px;font-size:12px}th,td{border:1px solid #ccc;padding:6px;text-align:left}th{background:#f1f5f9}.r{text-align:right}</style></head><body>
      <h1>${esc(r.title)}</h1><div>${esc(branch?.code ?? '')} · ${from} → ${to} · generated ${new Date().toLocaleString()}</div>
      <table><thead><tr>${r.columns.map((c: any) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>
      ${r.rows.map((row: any) => `<tr>${r.columns.map((c: any) => `<td class="${c.type === 'money' || c.type === 'number' ? 'r' : ''}">${esc(fmt(c, row[c.key]))}</td>`).join('')}</tr>`).join('')}
      </tbody></table><script>document.fonts.ready.then(()=>setTimeout(()=>print(),300))</script></body></html>`);
    w.document.close();
  };
  return (
    <div>
      <PageHeader
        title="Reports"
        sub="Filter, review and export (PDF / Excel / CSV)"
        actions={can('reports.export') && (
          <>
            <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={exportPdf} disabled={!q.data}>PDF</Button>
            <Button variant="outline" icon={<FileSpreadsheet className="h-4 w-4" />} onClick={() => exp('xlsx')}>Excel</Button>
            <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={() => exp('csv')}>CSV</Button>
          </>
        )}
      />
      <Card>
        <div className="grid gap-3 md:grid-cols-4 xl:grid-cols-8">
          <Field label="Report" className="md:col-span-2">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {REPORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Hour from"><Input type="number" min={0} max={23} value={hourFrom} onChange={(e) => setHourFrom(e.target.value)} placeholder="0" /></Field>
          <Field label="Hour to"><Input type="number" min={0} max={23} value={hourTo} onChange={(e) => setHourTo(e.target.value)} placeholder="23" /></Field>
          <Field label="Kiosk">
            <Select value={kioskId} onChange={(e) => setKioskId(e.target.value)}><option value="">All</option>{kiosks.data?.map((k: any) => <option key={k.id} value={k.id}>{k.code}</option>)}</Select>
          </Field>
          <Field label="Payment">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}><option value="">All</option><option>QR</option><option>CASH</option><option>CARD</option><option>OTHER</option></Select>
          </Field>
          <Field label="Category" className="md:col-span-2">
            <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">All</option>{cats.data?.filter((c: any) => c.kind === 'STANDARD').map((c: any) => <option key={c.id} value={c.id}>{tr(c.name, 'th')}</option>)}</Select>
          </Field>
          <Field label="Product" className="md:col-span-2">
            <Select value={productId} onChange={(e) => setProductId(e.target.value)}><option value="">All</option>{products.data?.map((x: any) => <option key={x.id} value={x.id}>{tr(x.translations?.th ? { th: x.translations.th.name } : {}, 'th') || x.sku}</option>)}</Select>
          </Field>
        </div>
      </Card>
      <Card className="mt-5" title={q.data?.title}>
        {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : q.data.rows.length === 0 ? <Empty title="No data for these filters" /> : (
          <Table head={q.data.columns.map((c: any) => c.label)}>
            {q.data.rows.map((r: any, i: number) => (
              <tr key={i}>{q.data.columns.map((c: any) => <Td key={c.key} className={c.type === 'money' || c.type === 'number' ? 'text-right tabular-nums' : ''}>{fmt(c, r[c.key])}</Td>)}</tr>
            ))}
            {totals.length > 0 && ['daily-sales', 'hourly-sales', 'product-sales', 'category-sales', 'payments', 'cash', 'transfer', 'card', 'refunds', 'promotions', 'cancelled'].includes(type) && (
              <tr className="bg-slate-50 font-semibold">
                {q.data.columns.map((c: any, i: number) => (
                  <Td key={c.key} className="text-right tabular-nums">{i === 0 ? 'Total' : totals.includes(c) ? fmt(c, q.data.rows.reduce((s: number, r: any) => s + Number(r[c.key] ?? 0), 0)) : ''}</Td>
                ))}
              </tr>
            )}
          </Table>
        )}
      </Card>
    </div>
  );
}
