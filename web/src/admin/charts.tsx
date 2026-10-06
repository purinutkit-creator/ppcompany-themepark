import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { money } from '../lib/format';

/** Single-series bar chart: one hue, 4px rounded data-ends, recessive grid, hover tooltip. */
export function SimpleBars({ data, x, y, height = 240, horizontal = false, isMoney = true, label }: { data: any[]; x: string; y: string; height?: number; horizontal?: boolean; isMoney?: boolean; label?: string }) {
  const fmt = (v: any) => (isMoney ? money(v) : String(v));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 16, left: horizontal ? 8 : 0, bottom: 0 }} barCategoryGap={horizontal ? 6 : 4}>
        <CartesianGrid stroke="#e2e8f0" strokeDasharray="0" vertical={horizontal} horizontal={!horizontal} />
        {horizontal ? (
          <>
            <XAxis type="number" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} tickFormatter={(v) => (isMoney ? `฿${Number(v).toLocaleString()}` : v)} />
            <YAxis type="category" dataKey={x} width={130} tick={{ fontSize: 12, fill: '#334155' }} axisLine={false} tickLine={false} />
          </>
        ) : (
          <>
            <XAxis dataKey={x} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={{ stroke: '#cbd5e1' }} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => (isMoney ? `฿${Number(v).toLocaleString()}` : v)} />
          </>
        )}
        <Tooltip cursor={{ fill: 'rgba(15,23,42,0.05)' }} formatter={(v: any) => [fmt(v), label ?? (isMoney ? 'Sales' : 'Count')]} contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} />
        <Bar dataKey={y} fill="var(--brand-primary)" radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}
