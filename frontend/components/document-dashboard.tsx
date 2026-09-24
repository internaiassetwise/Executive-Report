'use client';

import { Table2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DataPreview } from '@/components/data-preview';
import { EChart } from '@/components/echart';
import type { Dataset, DocumentChart, DocumentInfo, DocumentFormat } from '@/lib/datasets';
import { formatCompact, formatFull, PALETTE } from '../../shared/dashboard-charts.mjs';

/** Text for one computed figure; money stays a plain number (the page says baht). */
export function formatValue(value: number | string | null | undefined, format: DocumentFormat, compact = false): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) return '—';
  if (format === 'percent') return `${value.toFixed(1)}%`;
  if (format === 'percent_signed') return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
  if (format === 'count') return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (format === 'number') return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return compact ? formatCompact(value) : value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

const clip = (label: string) => (label.length > 22 ? `${label.slice(0, 21)}…` : label);

export function DocumentFocus({ focus, compact = false }: { focus?: DocumentInfo['focus']; compact?: boolean }) {
  if (!focus) return null;
  const ready = ['complete', 'partial', 'unsupported'].includes(focus.status);
  return <section className="office-card doc-focus" aria-label="วิเคราะห์ตามโจทย์">
    <div className="doc-focus-head"><h3>วิเคราะห์ตามโจทย์ที่ระบุ</h3><span>{focus.status === 'complete' ? 'วิเคราะห์แล้ว' : focus.status === 'partial' ? 'ตอบได้บางส่วน' : focus.status === 'unsupported' ? 'ข้อมูลไม่เพียงพอ' : 'ยังวิเคราะห์ตามโจทย์ไม่ได้'}</span></div>
    <p className="doc-focus-objective">{focus.objective}</p>
    <p>{ready ? focus.summary : focus.message}</p>
    {!compact && ready && Boolean(focus.evidence?.length) && <><h4>หลักฐานจากข้อมูลที่คำนวณ</h4><ul>{focus.evidence?.map(item => <li key={item.id}>{item.statement}</li>)}</ul></>}
    {compact && ready && <small>บทวิเคราะห์และหลักฐานอยู่หน้าท้ายของรายงานด้านล่าง</small>}
  </section>;
}

/** ECharts option for a chart the server computed; no figure is derived here. */
function chartOption(chart: DocumentChart): Record<string, unknown> {
  const show = (value: unknown) => formatValue(typeof value === 'number' ? value : null, chart.format);
  const axis = (value: number) => formatValue(value, chart.format, true);
  const legend = chart.series.length > 1 ? { top: 0, type: 'scroll' } : undefined;
  if (chart.kind === 'donut') {
    return {
      color: PALETTE, tooltip: { trigger: 'item', valueFormatter: show }, legend: { bottom: 0, type: 'scroll' },
      series: [{ type: 'pie', radius: ['45%', '70%'], center: ['50%', '45%'], label: { formatter: '{d}%' },
        data: chart.categories.map((name, index) => ({ name, value: chart.series[0]?.values[index] ?? 0 })) }],
    };
  }
  if (chart.kind === 'pareto') {
    const [bars, cumulative] = chart.series;
    return {
      color: PALETTE, legend: { top: 0 }, grid: { left: 12, right: 12, top: 36, bottom: 8, containLabel: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'category', data: chart.categories, axisLabel: { formatter: clip, rotate: 30, fontSize: 10 } },
      yAxis: [{ type: 'value', axisLabel: { formatter: axis } }, { type: 'value', max: 100, axisLabel: { formatter: '{value}%' }, splitLine: { show: false } }],
      series: [
        { type: 'bar', name: bars?.name, data: bars?.values ?? [], tooltip: { valueFormatter: show } },
        { type: 'line', name: cumulative?.name, yAxisIndex: 1, data: cumulative?.values ?? [], smooth: true,
          tooltip: { valueFormatter: (value: unknown) => formatValue(typeof value === 'number' ? value : null, 'percent') } },
      ],
    };
  }
  const horizontal = chart.kind === 'hbar';
  const category = { type: 'category', data: chart.categories, inverse: horizontal,
    axisLabel: { formatter: clip, fontSize: 10, ...(horizontal ? {} : { rotate: chart.categories.length > 4 ? 25 : 0 }) } };
  const value = { type: 'value', axisLabel: { formatter: axis } };
  const series = chart.series.map((entry, index) => ({
    type: 'bar', name: entry.name, data: entry.values, barMaxWidth: 36, ...(chart.kind === 'stacked' ? { stack: 'total' } : {}),
    ...(index === 0 && chart.reference ? { markLine: { symbol: 'none', lineStyle: { type: 'dashed', color: '#c94f5d' },
      label: { formatter: `${chart.reference.name} ${axis(chart.reference.value)}` },
      data: [horizontal ? { xAxis: chart.reference.value } : { yAxis: chart.reference.value }] } } : {}),
  }));
  return {
    color: PALETTE, legend, grid: { left: 12, right: 24, top: legend ? 36 : 12, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: show },
    xAxis: horizontal ? value : category, yAxis: horizontal ? category : value, series,
  };
}

/** Dashboard of a construction cost document: figures, charts and tables computed on the server. */
export function DocumentDashboard({ id, dataset, document }: { id: string; dataset: Dataset; document: DocumentInfo }) {
  const board = document.dashboard;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const options = useMemo(() => new Map((board?.charts || []).map(chart => [chart.id, chartOption(chart)])), [board]);
  const sheet = dataset.sheets.find(item => item.id === document.sheet_id) || dataset.sheets.find(item => !item.combined_from);
  if (!board) return <section className="office-card office-empty"><h2>ยังสร้างแดชบอร์ดของไฟล์นี้ไม่ได้</h2></section>;
  const where = [board.source.sheet && `ชีต ${board.source.sheet}`, board.source.range].filter(Boolean).join(' ช่วง ');
  return <div className="dash">
    <header className="dash-header"><div>
      <span className="doc-badge">{document.label}</span>
      <h2>{board.title}</h2>
      <p>{board.headline}</p>
      <small>คำนวณจากทุกรายการในไฟล์ {board.source.filename}{where ? ` · ${where}` : ''} · ไม่นับแถวสรุปยอดและ VAT</small>
    </div></header>

    <DocumentFocus focus={document.focus} />

    <section className="dash-kpis" aria-label="ตัวเลขสรุป">
      {board.kpis.map(kpi => <article key={kpi.label}>
        <span>{kpi.label}</span>
        <strong title={formatValue(kpi.value, kpi.format)}>{formatValue(kpi.value, kpi.format, true)}</strong>
        <small>{kpi.note}</small>
      </article>)}
    </section>

    <section className="dash-grid" aria-label="กราฟ">
      {board.charts.map(chart => {
        const wide = chart.kind === 'hbar' || chart.kind === 'pareto' || chart.categories.length > 6;
        return <article key={chart.id} className={`dash-panel${wide ? ' wide' : ''}`}>
          <div className="dash-panel-head">
            <div><h3>{chart.title}</h3>{chart.note && <p>{chart.note}</p>}</div>
            <button className="data-icon-button" aria-pressed={!!open[chart.id]} aria-label={`แสดงตัวเลขของ ${chart.title}`} title="ดูตัวเลข"
              onClick={() => setOpen(current => ({ ...current, [chart.id]: !current[chart.id] }))}><Table2 size={16} /></button>
          </div>
          <EChart option={options.get(chart.id) || {}} label={chart.title} />
          {open[chart.id] && <div className="dash-mini-table"><table>
            <thead><tr><th>รายการ</th>{chart.series.map(entry => <th key={entry.name}>{entry.name}</th>)}</tr></thead>
            <tbody>{chart.categories.map((name, index) => <tr key={index}><td>{name}</td>
              {chart.series.map(entry => <td key={entry.name}>{formatValue(entry.values[index], entry.name.includes('%') ? 'percent' : chart.format)}</td>)}</tr>)}</tbody>
          </table></div>}
        </article>;
      })}
    </section>

    {board.tables.map(table => <section key={table.title} className="dash-panel doc-table">
      <div className="dash-panel-head"><div><h3>{table.title}</h3></div></div>
      <div className="doc-table-scroll"><table>
        <thead><tr>{table.columns.map(column => <th key={column.label} className={column.format === 'text' ? '' : 'num'}>{column.label}</th>)}</tr></thead>
        <tbody>{table.rows.map((row, index) => <tr key={index}>{row.map((cell, position) =>
          <td key={position} className={table.columns[position]?.format === 'text' ? '' : 'num'}>{formatValue(cell, table.columns[position]?.format || 'text')}</td>)}</tr>)}</tbody>
      </table></div>
    </section>)}

    {sheet && <DataPreview key={`${id}:${sheet.id}`} id={id} sheet={sheet} />}
    <p className="dash-note">{formatFull(dataset.rows_count)} แถวจาก {dataset.filename}</p>
  </div>;
}
