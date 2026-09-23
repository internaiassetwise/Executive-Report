'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EChartsType } from 'echarts';
import { Download, FileCode2, Filter, Lightbulb, LoaderCircle, RefreshCw, RotateCcw, Table2, X } from 'lucide-react';
import { EChart, type ChartClick } from '@/components/echart';
import { DataPreview } from '@/components/data-preview';
import { bucketRange, exportDashboard, queryDashboard, type DashboardFilter, type DashboardResult, type DashboardSpec, type FilterOption, type ValueTrace } from '@/lib/dashboard';
import { DatasetError, type Dataset } from '@/lib/datasets';
import type { DatasetAnalysis, ProfileColumn } from '@/lib/dataset-analysis';
import { AGG_NAMES, chartOption, describeFilter, formatFull, formatNumber, seriesName, type ComputedChart } from '../../shared/dashboard-charts.mjs';

const CATEGORY_CHARTS = new Set(['bar', 'hbar', 'donut', 'treemap']);
const GRAIN_NAMES: Record<string, string> = { day: 'รายวัน', week: 'รายสัปดาห์', month: 'รายเดือน', quarter: 'รายไตรมาส', year: 'รายปี' };
type Range = { from?: string; to?: string; min?: number; max?: number };

function CategoryFilter({ label, option, selected, onChange }: { label: string; option?: FilterOption; selected: string[]; onChange: (values: string[]) => void }) {
  const [query, setQuery] = useState('');
  const values = option && 'values' in option ? option.values : [];
  const shown = values.filter(item => item.value.toLowerCase().includes(query.toLowerCase()));
  return <details className="dash-filter">
    <summary><span>{label}</span><b>{selected.length ? `${selected.length} รายการ` : 'ทั้งหมด'}</b></summary>
    <div className="dash-filter-popover">
      <input type="search" placeholder="ค้นหาค่า…" aria-label={`ค้นหาค่าใน ${label}`} value={query} onChange={event => setQuery(event.target.value)} />
      <fieldset className="dash-filter-options" aria-label={label}>
        {shown.length ? shown.map(item => <label key={item.value}><input type="checkbox" checked={selected.includes(item.value)} onChange={event => onChange(event.target.checked ? [...selected, item.value] : selected.filter(value => value !== item.value))} /><span>{item.value}</span><small>{formatFull(item.count)}</small></label>) : <p>ไม่พบค่าที่ค้นหา</p>}
      </fieldset>
      {option && 'total' in option && option.total > values.length && <p className="dash-note">แสดง {values.length} ค่าที่พบบ่อยที่สุดจาก {formatFull(option.total)} ค่า</p>}
      {selected.length > 0 && <button type="button" className="data-text-button" onClick={() => onChange([])}>ล้างการเลือก</button>}
    </div>
  </details>;
}

function RangeFilter({ label, kind, option, current, onChange }: { label: string; kind: 'date' | 'number'; option?: FilterOption; current?: DashboardFilter; onChange: (filter: Range | null) => void }) {
  const range = option && 'min' in option ? option : { min: null, max: null };
  const active = (current || {}) as Range;
  const low = kind === 'date' ? active.from : active.min;
  const high = kind === 'date' ? active.to : active.max;
  const bound = (value: unknown) => typeof value === 'string' ? (value.length === 7 ? `${value}-01` : value.slice(0, 10)) : undefined;
  const update = (field: 'low' | 'high', raw: string) => {
    const parsed = kind === 'date' ? raw || undefined : raw === '' || !Number.isFinite(Number(raw)) ? undefined : Number(raw);
    const [a, b] = field === 'low' ? [parsed, high] : [low, parsed];
    if (a === undefined && b === undefined) { onChange(null); return; }
    onChange(kind === 'date' ? { from: a as string | undefined, to: b as string | undefined } : { min: a as number | undefined, max: b as number | undefined });
  };
  const type = kind === 'date' ? 'date' : 'number';
  return <fieldset className="dash-range">
    <legend>{label}</legend>
    <input type={type} aria-label={`${label} ตั้งแต่`} value={low ?? ''} min={kind === 'date' ? bound(range.min) : undefined} max={kind === 'date' ? bound(range.max) : undefined} placeholder={kind === 'number' ? formatFull(range.min) : undefined} onChange={event => update('low', event.target.value)} />
    <span aria-hidden="true">–</span>
    <input type={type} aria-label={`${label} ถึง`} value={high ?? ''} min={kind === 'date' ? bound(range.min) : undefined} max={kind === 'date' ? bound(range.max) : undefined} placeholder={kind === 'number' ? formatFull(range.max) : undefined} onChange={event => update('high', event.target.value)} />
  </fieldset>;
}

/** Where the number comes from in the uploaded file, to check it against the source. */
function TraceLine({ trace }: { trace?: ValueTrace }) {
  if (!trace) return null;
  const where = trace.combined_from ? `${trace.combined_from.length} ชีต (${trace.combined_from.slice(0, 3).join(', ')}${trace.combined_from.length > 3 ? ' …' : ''})` : trace.range || `ชีต ${trace.sheet}`;
  const detail = [`${formatFull(trace.rows)} แถว${trace.filtered ? 'ตามตัวกรอง' : ''}`, trace.excluded_summary_rows ? `ไม่รวมแถวสรุป ${formatFull(trace.excluded_summary_rows)} แถว` : '', trace.from_image ? 'อ่านจากรูปภาพ' : ''].filter(Boolean).join(' · ');
  return <em className={`dash-trace${trace.from_image ? ' warn' : ''}`} title={`ที่มา: ${where} · ${detail}`}>ที่มา {where} · {detail}</em>;
}

export function DashboardView({ id, dataset, analysis, spec: planned }: { id: string; dataset: Dataset; analysis: DatasetAnalysis; spec: DashboardSpec }) {
  const [sheetId, setSheetId] = useState(planned.sheet_id);
  const [filters, setFilters] = useState<DashboardFilter[]>([]);
  const [result, setResult] = useState<DashboardResult | null>(null);
  const [options, setOptions] = useState<Record<string, FilterOption>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [exporting, setExporting] = useState('');
  const [tables, setTables] = useState<Record<string, boolean>>({});
  const instances = useRef(new Map<string, EChartsType>());
  const optionsLoaded = useRef(false);
  // Another sheet is planned by rules on the server; its spec arrives with the result.
  const spec = result?.spec.sheet_id === sheetId ? result.spec : sheetId === planned.sheet_id ? planned : null;
  const profile = analysis.profiles.find(item => item.sheet_id === sheetId);
  const columns = useMemo(() => new Map<string, ProfileColumn>((profile?.columns || []).map(column => [column.key, column])), [profile]);
  const sheet = dataset.sheets.find(item => item.id === sheetId) || dataset.sheets[0];
  const name = useCallback((key: string | null) => (key ? columns.get(key)?.name || key : ''), [columns]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true); setError('');
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const next = await queryDashboard(id, filters, !optionsLoaded.current, controller.signal, sheetId === planned.sheet_id ? undefined : sheetId);
          if (controller.signal.aborted) return;
          if (next.options) { optionsLoaded.current = true; setOptions(next.options); }
          setResult(next); setLoading(false);
          return;
        } catch (reason) {
          if (controller.signal.aborted) return;
          // The server runs two dashboard queries at once; back off briefly when busy.
          if (reason instanceof DatasetError && reason.status === 429 && attempt < 2) { await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1))); continue; }
          setError(reason instanceof Error ? reason.message : 'คำนวณแดชบอร์ดไม่สำเร็จ'); setLoading(false);
          return;
        }
      }
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [id, filters, retry, sheetId, planned.sheet_id]);

  function changeSheet(value: string) {
    optionsLoaded.current = false;
    setSheetId(value); setFilters([]); setOptions({}); setTables({}); setResult(null);
  }

  const setFilter = useCallback((column: string, value: Range | { values: string[] } | null) => {
    setFilters(current => [...current.filter(item => item.column !== column), ...(value ? [{ column, ...value } as DashboardFilter] : [])]);
  }, []);

  const charts = useMemo(() => (spec?.charts || []).map(chart => {
    const computed = result?.spec.sheet_id === sheetId ? result.charts.find(item => item.id === chart.id) : undefined;
    return { ...chart, x_name: name(chart.x), y_name: chart.y ? name(chart.y) : 'จำนวนรายการ', data: [], ...computed } as ComputedChart;
  }), [spec, result, sheetId, name]);
  const chartOptions = useMemo(() => new Map(charts.map(chart => [chart.id, chartOption(chart)])), [charts]);

  function drill(chart: ComputedChart, event: ChartClick) {
    const label = typeof event.name === 'string' ? event.name : '';
    if (!label || label.startsWith('อื่น ๆ')) return;
    if (CATEGORY_CHARTS.has(chart.type)) setFilter(chart.x, { values: [label] });
    else if (chart.type === 'line' || chart.type === 'area') { const range = bucketRange(label); if (range) setFilter(chart.x, range); }
  }

  async function download(format: 'html' | 'pdf') {
    if (exporting) return;
    setExporting(format); setError('');
    try {
      // Pictures only decorate the PDF; its numbers are recomputed on the server.
      const images = format === 'pdf' ? [...instances.current].map(([chartId, instance]) => ({ id: chartId, data: instance.getDataURL({ type: 'jpeg', pixelRatio: 2, backgroundColor: '#ffffff' }) })).filter(item => item.data.startsWith('data:image/jpeg')) : [];
      await exportDashboard(id, format, filters, dataset.filename, images, sheetId === planned.sheet_id ? undefined : sheetId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'ดาวน์โหลดไม่สำเร็จ'); }
    finally { setExporting(''); }
  }

  const summary = analysis.ai?.status === 'complete' ? analysis.ai : null;
  const evidence = new Map(analysis.insights.map(item => [item.id, item]));
  // Written observations when available; otherwise calculated findings for this sheet.
  const insights = summary?.insights?.length && sheetId === planned.sheet_id ? summary.insights.map(item => ({ title: item.title, description: item.description, ids: item.evidence_ids }))
    : analysis.insights.filter(item => item.evidence.sheet === sheet?.name || item.evidence.sheet === 'ทุกชีต').slice(0, 6).map(item => ({ title: item.title, description: item.description, ids: [item.id] }));
  const kpiValue = (kpiId: string) => result?.spec.sheet_id === sheetId ? result.kpis.find(item => item.id === kpiId)?.value ?? null : null;
  const kpiTrace = (kpiId: string) => result?.spec.sheet_id === sheetId ? result.kpis.find(item => item.id === kpiId)?.trace : undefined;
  const extraFilters = filters.filter(item => !spec?.filters.some(entry => entry.column === item.column));
  const ready = Boolean(result && result.spec.sheet_id === sheetId);

  return <div className="dash">
    <header className="dash-header">
      <div>
        <h2>{spec?.title || `ภาพรวมข้อมูล ${sheet?.name || ''}`}</h2>
        {spec?.description && <p>{spec.description}</p>}
        <div className="dash-meta">
          <label>ชีต <select aria-label="เลือกชีตที่ต้องการดู" value={sheetId} onChange={event => changeSheet(event.target.value)}>{[...dataset.sheets].sort((a, b) => Number(Boolean(b.combined_from)) - Number(Boolean(a.combined_from))).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <span>{dataset.filename}</span>
          <span>วิเคราะห์เมื่อ {new Date(analysis.generated_at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })}</span>
        </div>
      </div>
      <div className="dash-actions">
        <button className="office-button" disabled={!!exporting || !ready} onClick={() => void download('html')}>{exporting === 'html' ? <LoaderCircle size={15} className="data-spin" /> : <FileCode2 size={15} />}ดาวน์โหลด HTML</button>
        <button className="office-button primary" disabled={!!exporting || !ready} onClick={() => void download('pdf')}>{exporting === 'pdf' ? <LoaderCircle size={15} className="data-spin" /> : <Download size={15} />}ดาวน์โหลด PDF</button>
      </div>
    </header>

    {spec && spec.filters.length > 0 && <section className="dash-filters" aria-label="ตัวกรอง">
      <span className="dash-filters-title"><Filter size={15} aria-hidden="true" />ตัวกรอง</span>
      {spec.filters.map(item => {
        const current = filters.find(filter => filter.column === item.column);
        if (item.kind === 'category') return <CategoryFilter key={item.id} label={name(item.column)} option={options[item.id]} selected={current && 'values' in current ? current.values : []} onChange={values => setFilter(item.column, values.length ? { values } : null)} />;
        return <RangeFilter key={item.id} label={name(item.column)} kind={item.kind} option={options[item.id]} current={current} onChange={value => setFilter(item.column, value)} />;
      })}
      {filters.length > 0 && <button className="data-text-button dash-reset" onClick={() => setFilters([])}><RotateCcw size={14} />ล้างตัวกรอง</button>}
    </section>}
    {extraFilters.length > 0 && <div className="dash-chips" aria-label="ตัวกรองจากการคลิกกราฟ">
      {extraFilters.map(item => { const text = describeFilter(item, columns.get(item.column)); return <span key={item.column} className="dash-chip">{text.label}: {text.text}<button aria-label={`ลบตัวกรอง ${text.label}`} onClick={() => setFilter(item.column, null)}><X size={12} /></button></span>; })}
      {spec?.filters.length === 0 && <button className="data-text-button" onClick={() => setFilters([])}>ล้างตัวกรอง</button>}
    </div>}

    <div className="dash-status" aria-live="polite">
      {loading ? <><LoaderCircle size={14} className="data-spin" />กำลังคำนวณ…</> : ready && result && <>ใช้ข้อมูล {formatFull(result.rows_matched)} จาก {formatFull(result.rows_total)} แถว{filters.length ? ' ตามตัวกรอง' : ''} · คลิกกราฟเพื่อกรองข้อมูล{result.summary_rows_excluded ? ` · ไม่นับแถวสรุปยอด ${formatFull(result.summary_rows_excluded)} แถว (เช่น รวม, VAT) เพื่อไม่ให้ยอดซ้ำ` : ''}</>}
    </div>
    {error && <div className="data-inline-error" role="alert"><p>{error}</p><button className="office-button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />ลองอีกครั้ง</button></div>}

    {spec && <section className="dash-kpis" aria-label="ตัวเลขสรุป">
      {spec.kpis.map(kpi => {
        const value = kpiValue(kpi.id);
        return <article key={kpi.id} className={loading ? 'loading' : ''}>
          <span>{kpi.label}</span>
          <strong title={formatFull(value)}>{ready ? formatNumber(value, columns.get(kpi.column || '')?.meaning, kpi.agg) : '…'}</strong>
          <small>{kpi.column ? `${AGG_NAMES[kpi.agg]} · ${name(kpi.column)}` : 'นับทุกแถวที่ตรงตัวกรอง'}</small>
          {ready && <TraceLine trace={kpiTrace(kpi.id)} />}
        </article>;
      })}
    </section>}

    <section className="dash-grid" aria-label="กราฟ">
      {charts.map(chart => {
        const option = chartOptions.get(chart.id);
        const rows = [...(chart.data || []), ...(chart.others ? [{ x: chart.others.label, y: chart.others.y }] : [])];
        const notes = [seriesName(chart), chart.grain ? GRAIN_NAMES[chart.grain] : '', chart.groups_total && chart.groups_total > (chart.data?.length || 0) ? `แสดง ${chart.data?.length} อันดับแรกจาก ${formatFull(chart.groups_total)} รายการ` : '', chart.sampled ? `แสดงตัวอย่างจุดจาก ${formatFull(chart.points_total)} คู่` : ''].filter(Boolean);
        return <article key={chart.id} className={`dash-panel${chart.type === 'line' || chart.type === 'area' || chart.type === 'hbar' ? ' wide' : ''}`}>
          <div className="dash-panel-head">
            <div><h3>{chart.title}</h3><p>{notes.join(' · ')}</p></div>
            <button className="data-icon-button" aria-pressed={!!tables[chart.id]} aria-label={`แสดงตัวเลขของ ${chart.title}`} title="ดูตัวเลข" onClick={() => setTables(current => ({ ...current, [chart.id]: !current[chart.id] }))}><Table2 size={16} /></button>
          </div>
          {chart.error ? <p className="dash-empty">{chart.error}</p> : option ? <EChart option={option} label={`${chart.title} ${rows.length} รายการ`} onSelect={event => drill(chart, event)} onReady={instance => { if (instance) instances.current.set(chart.id, instance); else instances.current.delete(chart.id); }} /> : <p className="dash-empty">{loading ? 'กำลังคำนวณ…' : 'ไม่มีข้อมูลตามตัวกรองนี้'}</p>}
          {tables[chart.id] && rows.length > 0 && <div className="dash-mini-table"><table><thead><tr><th>{chart.x_name || 'รายการ'}</th><th>{chart.type === 'scatter' ? chart.y_name : seriesName(chart)}</th></tr></thead><tbody>{rows.slice(0, 100).map((row, index) => <tr key={index}><td>{formatFull(row.x)}</td><td>{formatFull(row.y)}</td></tr>)}</tbody></table></div>}
        </article>;
      })}
    </section>

    {insights.length > 0 && <section className="dash-insights" aria-label="ข้อสังเกตสำคัญ">
      <div className="dash-section-head"><h3><Lightbulb size={17} aria-hidden="true" />ข้อสังเกตสำคัญ</h3><span>สรุปจากข้อมูลทั้งไฟล์ · ไม่เปลี่ยนตามตัวกรอง</span></div>
      {summary?.summary && sheetId === planned.sheet_id && <p className="dash-summary">{summary.summary}</p>}
      <ol>{insights.map((item, index) => <li key={index}><strong>{item.title}</strong><p>{item.description}</p>
        <details><summary>ที่มาของตัวเลข</summary>{item.ids.map(evidenceId => { const source = evidence.get(evidenceId); return source ? <p key={evidenceId}>{source.evidence.sheet} · {source.evidence.metric}: {formatFull(source.evidence.value)} · {source.evidence.method}</p> : null; })}</details>
      </li>)}</ol>
    </section>}

    {sheet && <section className="dash-data" aria-label="ข้อมูลตามตัวกรอง">
      <div className="dash-section-head"><h3>ข้อมูลในชีต {sheet.name}</h3><span>{filters.length ? 'แสดงเฉพาะแถวที่ตรงกับตัวกรอง' : 'ทุกแถวของชีตนี้'}</span></div>
      <DataPreview key={`${id}:${sheet.id}`} id={id} sheet={sheet} filters={filters} />
    </section>}
  </div>;
}
