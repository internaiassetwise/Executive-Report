import type { DocumentChart, DocumentFormat } from '@/lib/datasets';
import { formatCompact, PALETTE } from '../../shared/dashboard-charts.mjs';

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

/** ECharts option for a chart the server computed; no figure is derived here. */
export function chartOption(chart: DocumentChart): Record<string, unknown> {
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
  const line = chart.kind === 'line';
  const series = chart.series.map((entry, index) => ({
    type: line ? 'line' : 'bar', name: entry.name, data: entry.values, barMaxWidth: 36, ...(line ? { smooth: false, symbolSize: 6, connectNulls: true } : {}), ...(chart.kind === 'stacked' ? { stack: 'total' } : {}),
    ...(index === 0 && chart.reference ? { markLine: { symbol: 'none', lineStyle: { type: 'dashed', color: '#c94f5d' },
      label: { formatter: `${chart.reference.name} ${axis(chart.reference.value)}` },
      data: [horizontal ? { xAxis: chart.reference.value } : { yAxis: chart.reference.value }] } } : {}),
  }));
  return {
    color: PALETTE, legend, grid: { left: 12, right: 24, top: legend ? 36 : 12, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: line ? 'line' : 'shadow' }, valueFormatter: show },
    xAxis: horizontal ? value : category, yAxis: horizontal ? category : value, series,
  };
}
