// Shared by the React dashboard, the backend exports and the standalone HTML
// export (this file is inlined there). Keep it dependency-free, with top-level
// function declarations only.

export const PALETTE = ['#123f6d', '#2f7fc1', '#e0823d', '#3a9e7e', '#c94f5d', '#8a6fc2', '#d9a93b', '#5c6f84'];
export const OTHERS_COLOR = '#b8c4d2';
export const AGG_NAMES = { count: 'จำนวน', count_distinct: 'จำนวนที่ไม่ซ้ำ', sum: 'ผลรวม', avg: 'ค่าเฉลี่ย', min: 'ต่ำสุด', max: 'สูงสุด', median: 'มัธยฐาน' };

/** Full precision for tooltips and tables. */
export function formatFull(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value !== 'number') return String(value);
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: Math.abs(value) >= 100 ? 2 : 4 });
}

/** Short form for KPI cards and axes: 12,400,000 -> 12.4M. */
export function formatCompact(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return formatFull(value);
  if (Math.abs(value) < 10_000) return value.toLocaleString('en-US', { maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2 });
  return value.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
}

/** KPI text. Units are never invented: money stays a plain number. */
export function formatNumber(value, meaning, agg) {
  if (value === null || value === undefined) return '—';
  if (agg === 'count' || agg === 'count_distinct') return formatFull(value);
  return formatCompact(value);
}

export function describeFilter(filter, column) {
  const label = column ? column.name : filter.column;
  if (Array.isArray(filter.values)) return { label, text: filter.values.join(', ') };
  if ('from' in filter || 'to' in filter) return { label, text: `${filter.from || 'เริ่มต้น'} – ${filter.to || 'ล่าสุด'}` };
  return { label, text: `${filter.min ?? 'ต่ำสุด'} – ${filter.max ?? 'สูงสุด'}` };
}

export function seriesName(chart) {
  if (chart.type === 'histogram') return 'จำนวนแถว';
  if (!chart.y) return 'จำนวนแถว';
  return `${AGG_NAMES[chart.agg] || ''} ${chart.y_name || ''}`.trim();
}

/** Tooltips render HTML and category names come from uploaded files. */
export function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function shorten(text, size) {
  const value = String(text);
  return value.length > size ? `${value.slice(0, size - 1)}…` : value;
}

/**
 * ECharts option for one computed chart (spec fields + result fields).
 * Returns null when there is nothing to draw.
 */
export function chartOption(chart, { interactive = true } = {}) {
  const points = Array.isArray(chart.data) ? chart.data : [];
  if (!points.length) return null;
  const name = seriesName(chart);
  const base = {
    animation: interactive, color: PALETTE,
    textStyle: { fontFamily: 'inherit' },
    grid: { left: 8, right: 20, top: 28, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis', confine: true, valueFormatter: formatFull },
  };
  const valueAxis = { type: 'value', axisLabel: { formatter: formatCompact, color: '#5c6f84' }, splitLine: { lineStyle: { color: '#e7ecf2' } } };
  const others = chart.others && Number.isFinite(chart.others.y) && chart.others.y > 0 ? chart.others : null;

  if (chart.type === 'line' || chart.type === 'area') {
    const zoom = interactive && points.length > 24;
    return { ...base,
      grid: { ...base.grid, bottom: zoom ? 40 : 8 },
      xAxis: { type: 'category', boundaryGap: false, data: points.map(p => p.x), axisLabel: { color: '#5c6f84' } },
      yAxis: valueAxis,
      dataZoom: zoom ? [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 6 }] : undefined,
      series: [{ type: 'line', name, data: points.map(p => p.y), showSymbol: points.length <= 40, symbolSize: 6, lineStyle: { width: 2.5 }, areaStyle: chart.type === 'area' ? { opacity: 0.14 } : undefined }] };
  }
  if (chart.type === 'bar' || chart.type === 'histogram' || chart.type === 'hbar') {
    const rows = chart.type === 'histogram' ? points : [...points, ...(others ? [{ x: others.label, y: others.y, others: true }] : [])];
    const data = rows.map(p => ({ value: p.y, itemStyle: p.others ? { color: OTHERS_COLOR } : undefined }));
    const categories = { type: 'category', data: rows.map(p => p.x), axisLabel: { color: '#5c6f84', formatter: value => shorten(value, chart.type === 'hbar' ? 22 : 14), hideOverlap: true } };
    const series = [{ type: 'bar', name, data, barMaxWidth: 44, barCategoryGap: chart.type === 'histogram' ? '4%' : '30%', itemStyle: { borderRadius: chart.type === 'hbar' ? [0, 3, 3, 0] : [3, 3, 0, 0] } }];
    if (chart.type === 'hbar') return { ...base, tooltip: { ...base.tooltip, axisPointer: { type: 'shadow' } }, xAxis: valueAxis, yAxis: { ...categories, inverse: true }, series };
    return { ...base, tooltip: { ...base.tooltip, axisPointer: { type: 'shadow' } }, xAxis: { ...categories, axisLabel: { ...categories.axisLabel, rotate: rows.length > 8 ? 35 : 0 } }, yAxis: valueAxis, series };
  }
  if (chart.type === 'donut' || chart.type === 'treemap') {
    const data = [...points.map(p => ({ name: String(p.x), value: p.y })), ...(others ? [{ name: others.label, value: others.y, itemStyle: { color: OTHERS_COLOR } }] : [])];
    const tooltip = { trigger: 'item', confine: true, formatter: item => `${escapeText(item.name)}<br/>${formatFull(item.value)}${item.percent !== undefined ? ` (${item.percent}%)` : ''}` };
    if (chart.type === 'treemap') {
      return { ...base, tooltip, series: [{ type: 'treemap', name, data, roam: false, nodeClick: false, breadcrumb: { show: false }, label: { formatter: item => `${shorten(item.name, 18)}\n${formatCompact(item.value)}` }, levels: [{ itemStyle: { gapWidth: 2, borderColor: '#fff' } }] }] };
    }
    return { ...base, tooltip, legend: { type: 'scroll', bottom: 0, textStyle: { color: '#5c6f84' }, formatter: value => shorten(value, 18) },
      series: [{ type: 'pie', name, radius: ['46%', '70%'], center: ['50%', '45%'], data, avoidLabelOverlap: true, label: { formatter: '{d}%', color: '#34485e' }, itemStyle: { borderColor: '#fff', borderWidth: 2 } }] };
  }
  // scatter
  return { ...base, tooltip: { trigger: 'item', confine: true, formatter: item => `${escapeText(chart.x_name)}: ${formatFull(item.value[0])}<br/>${escapeText(chart.y_name)}: ${formatFull(item.value[1])}` },
    grid: { ...base.grid, left: 16, bottom: 24 },
    xAxis: { ...valueAxis, name: chart.x_name, nameLocation: 'middle', nameGap: 26, scale: true },
    yAxis: { ...valueAxis, name: chart.y_name, scale: true },
    series: [{ type: 'scatter', name, data: points.map(p => [p.x, p.y]), symbolSize: 7, itemStyle: { opacity: 0.7 } }] };
}
