'use client';

import { Bar, BarChart, CartesianGrid, Line, LineChart, Pie, PieChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import type { DatasetChart as Chart } from '@/lib/dataset-analysis';

const palette = ['#123f6d', '#315e89', '#5d82a6', '#88a3bf', '#a9bed3', '#c4d3e2'];
const shorten = (value: unknown) => String(value).length > 18 ? String(value).slice(0, 16) + '…' : String(value);
const format = (value: number) => value.toLocaleString('th-TH', { maximumFractionDigits: 2, notation: Math.abs(value) >= 1_000_000 ? 'compact' : 'standard' });
const tick = { fontSize: 11, fill: '#718095' };

export default function DatasetChart({ chart }: { chart: Chart }) {
  if (!chart.data.length) return <p className="insight-empty">ข้อมูลไม่เพียงพอสำหรับกราฟนี้</p>;
  const tooltip = <Tooltip formatter={value => typeof value === 'number' ? format(value) : String(value)} contentStyle={{ border: '1px solid #e3e9f0', borderRadius: 6, fontSize: 12 }} />;
  return <figure className="insight-chart" aria-label={`${chart.title} ${chart.data.length} จุดข้อมูล ${chart.method}`}>
    <ResponsiveContainer width="100%" height={270}>
      {chart.type === 'line' ? <LineChart data={chart.data} margin={{ top: 12, right: 20, left: 3, bottom: 8 }}>
        <CartesianGrid vertical={false} stroke="#e8edf3" strokeDasharray="3 5" /><XAxis dataKey="x" tick={tick} tickFormatter={shorten} axisLine={false} tickLine={false} minTickGap={30} /><YAxis tick={tick} tickFormatter={format} axisLine={false} tickLine={false} width={66} />{tooltip}<Line dataKey="y" name={chart.y_label} stroke={palette[0]} strokeWidth={2.5} dot={chart.data.length < 35} isAnimationActive={false} />
      </LineChart> : chart.type === 'scatter' ? <ScatterChart margin={{ top: 12, right: 20, left: 3, bottom: 8 }}>
        <CartesianGrid stroke="#e8edf3" strokeDasharray="3 5" /><XAxis dataKey="x" type="number" name={chart.x_label} tick={tick} tickFormatter={format} /><YAxis dataKey="y" type="number" name={chart.y_label} tick={tick} tickFormatter={format} width={66} />{tooltip}<Scatter data={chart.data} fill={palette[1]} isAnimationActive={false} />
      </ScatterChart> : chart.type === 'donut' ? <PieChart>{tooltip}<Pie data={chart.data.map((point, index) => ({ ...point, fill: palette[index % palette.length] }))} dataKey="y" nameKey="x" innerRadius={62} outerRadius={98} paddingAngle={2} isAnimationActive={false} /></PieChart> :
        <BarChart data={chart.data} margin={{ top: 12, right: 20, left: 3, bottom: 8 }}><CartesianGrid vertical={false} stroke="#e8edf3" strokeDasharray="3 5" /><XAxis dataKey="x" tick={tick} tickFormatter={shorten} axisLine={false} tickLine={false} minTickGap={18} /><YAxis tick={tick} tickFormatter={format} axisLine={false} tickLine={false} width={66} />{tooltip}<Bar dataKey="y" name={chart.y_label} fill={palette[1]} radius={[3, 3, 0, 0]} maxBarSize={48} isAnimationActive={false} /></BarChart>}
    </ResponsiveContainer>
    <div className="insight-chart-axis"><span>{chart.x_label}</span><span>{chart.y_label}</span></div>
  </figure>;
}
