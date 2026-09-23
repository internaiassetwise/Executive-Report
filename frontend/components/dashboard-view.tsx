'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EChartsType } from 'echarts';
import { Download, FileCode2, Filter, Info, LoaderCircle, RefreshCw, RotateCcw, Sparkles, Table2, X } from 'lucide-react';
import { EChart, type ChartClick } from '@/components/echart';
import { DataPreview } from '@/components/data-preview';
import { bucketRange, exportDashboard, queryDashboard, type DashboardFilter, type DashboardResult, type DashboardSpec, type FilterOption } from '@/lib/dashboard';
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

export function DashboardView({ id, dataset, analysis, spec }: { id: string; dataset: Dataset; analysis: DatasetAnalysis; spec: DashboardSpec }) {
  const profile = analysis.profiles.find(item => item.sheet_id === spec.sheet_id);
  const columns = useMemo(() => new Map<string, ProfileColumn>((profile?.columns || []).map(column => [column.key, column])), [profile]);
  const sheet = dataset.sheets.find(item => item.id === spec.sheet_id) || dataset.sheets[0];
  const name = useCallback((key: string | null) => (key ? columns.get(key)?.name || key : ''), [columns]);
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

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true); setError('');
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const next = await queryDashboard(id, filters, !optionsLoaded.current, controller.signal);
          if (controller.signal.aborted) return;
          if (next.options) { optionsLoaded.current = true; setOptions(next.options); }
          setResult(next); setLoading(false);
          return;
        } catch (reason) {
          if (controller.signal.aborted) return;
          // The server runs two dashboard queries at once; back off briefly when busy.
          if (reason instanceof DatasetError && reason.status === 429 && attempt < 2) { await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1))); continue; }
          setError(reason instanceof Error ? reason.message : 'คำนวณ Dashboard ไม่สำเร็จ'); setLoading(false);
          return;
        }
      }
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [id, filters, retry]);

  const setFilter = useCallback((column: string, value: Range | { values: string[] } | null) => {
    setFilters(current => [...current.filter(item => item.column !== column), ...(value ? [{ column, ...value } as DashboardFilter] : [])]);
  }, []);

  const charts = useMemo(() => spec.charts.map(chart => {
    const computed = result?.charts.find(item => item.id === chart.id);
    return { ...chart, x_name: name(chart.x), y_name: chart.y ? name(chart.y) : 'จำนวนแถว', data: [], ...computed } as ComputedChart;
  }), [spec, result, name]);
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
      await exportDashboard(id, format, filters, dataset.filename, images);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'ส่งออกไม่สำเร็จ'); }
    finally { setExporting(''); }
  }

  const ai = analysis.ai?.status === 'complete' ? analysis.ai : null;
  const evidence = new Map(analysis.insights.map(item => [item.id, item]));
  const insights = ai?.insights?.length ? ai.insights.map(item => ({ title: item.title, description: item.description, ids: item.evidence_ids }))
    : analysis.insights.slice(0, 6).map(item => ({ title: item.title, description: item.description, ids: [item.id] }));
  const extraFilters = filters.filter(item => !spec.filters.some(entry => entry.column === item.column));
  const kpiValue = (kpiId: string) => result?.kpis.find(item => item.id === kpiId)?.value ?? null;

  return <div className="dash">
    <header className="dash-header">
      <div>
        <span className={`dash-source ${spec.source}`}><Sparkles size={13} aria-hidden="true" />{spec.source === 'ai' ? 'AI วางแผน Dashboard' : 'Dashboard อัตโนมัติ'}</span>
        <h2>{spec.title}</h2>
        {spec.description && <p>{spec.description}</p>}
        <small>{dataset.filename} · ชีต {sheet?.name} · วิเคราะห์เมื่อ {new Date(analysis.generated_at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })}</small>
      </div>
      <div className="dash-actions">
        <button className="data-button secondary compact" disabled={!!exporting || !result} onClick={() => void download('html')}>{exporting === 'html' ? <LoaderCircle size={15} className="data-spin" /> : <FileCode2 size={15} />}Export HTML</button>
        <button className="data-button primary compact" disabled={!!exporting || !result} onClick={() => void download('pdf')}>{exporting === 'pdf' ? <LoaderCircle size={15} className="data-spin" /> : <Download size={15} />}Export PDF</button>
      </div>
    </header>

    {spec.filters.length > 0 && <section className="dash-filters" aria-label="ตัวกรอง Dashboard">
      <span className="dash-filters-title"><Filter size={15} aria-hidden="true" />ตัวกรอง</span>
      {spec.filters.map(item => {
        const current = filters.find(filter => filter.column === item.column);
        if (item.kind === 'category') return <CategoryFilter key={item.id} label={name(item.column)} option={options[item.id]} selected={current && 'values' in current ? current.values : []} onChange={values => setFilter(item.column, values.length ? { values } : null)} />;
        return <RangeFilter key={item.id} label={name(item.column)} kind={item.kind} option={options[item.id]} current={current} onChange={value => setFilter(item.column, value)} />;
      })}
      {filters.length > 0 && <button className="data-text-button dash-reset" onClick={() => setFilters([])}><RotateCcw size={14} />ล้างตัวกรองทั้งหมด</button>}
    </section>}
    {extraFilters.length > 0 && <div className="dash-chips" aria-label="ตัวกรองจากการคลิกกราฟ">
      {extraFilters.map(item => { const text = describeFilter(item, columns.get(item.column)); return <span key={item.column} className="dash-chip">{text.label}: {text.text}<button aria-label={`ลบตัวกรอง ${text.label}`} onClick={() => setFilter(item.column, null)}><X size={12} /></button></span>; })}
      {spec.filters.length === 0 && <button className="data-text-button" onClick={() => setFilters([])}>ล้างตัวกรอง</button>}
    </div>}

    <div className="dash-status" aria-live="polite">
      {loading ? <><LoaderCircle size={14} className="data-spin" />กำลังคำนวณจากข้อมูลจริง…</> : result && <>ใช้ข้อมูล {formatFull(result.rows_matched)} จาก {formatFull(result.rows_total)} แถว{filters.length ? ' ตามตัวกรอง' : ''} · คลิกแท่งกราฟหรือจุดเวลาเพื่อกรองข้อมูล</>}
    </div>
    {error && <div className="data-inline-error" role="alert"><p>{error}</p><button className="data-button secondary compact" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />ลองอีกครั้ง</button></div>}

    <section className="dash-kpis" aria-label="ตัวชี้วัดหลัก">
      {spec.kpis.map(kpi => {
        const value = kpiValue(kpi.id);
        return <article key={kpi.id} className={loading ? 'loading' : ''}>
          <span>{kpi.label}</span>
          <strong title={formatFull(value)}>{result ? formatNumber(value, columns.get(kpi.column || '')?.meaning, kpi.agg) : '…'}</strong>
          <small>{kpi.column ? `${AGG_NAMES[kpi.agg]} · ${name(kpi.column)}` : 'นับทุกแถวที่ตรงตัวกรอง'}</small>
        </article>;
      })}
    </section>

    <section className="dash-grid" aria-label="กราฟ">
      {charts.map(chart => {
        const option = chartOptions.get(chart.id);
        const rows = [...(chart.data || []), ...(chart.others ? [{ x: chart.others.label, y: chart.others.y }] : [])];
        const notes = [seriesName(chart), chart.grain ? GRAIN_NAMES[chart.grain] : '', chart.groups_total && chart.groups_total > (chart.data?.length || 0) ? `แสดง ${chart.data?.length} จาก ${formatFull(chart.groups_total)} กลุ่ม` : '', chart.sampled ? `ตัวอย่างจุดจาก ${formatFull(chart.points_total)} คู่` : ''].filter(Boolean);
        return <article key={chart.id} className={`dash-panel${chart.type === 'line' || chart.type === 'area' ? ' wide' : ''}`}>
          <div className="dash-panel-head">
            <div><h3>{chart.title}</h3><p>{notes.join(' · ')}</p></div>
            <button className="data-icon-button" aria-pressed={!!tables[chart.id]} aria-label={`แสดงตัวเลขของ ${chart.title}`} title="ดูตัวเลข" onClick={() => setTables(current => ({ ...current, [chart.id]: !current[chart.id] }))}><Table2 size={16} /></button>
          </div>
          {chart.error ? <p className="dash-empty">{chart.error}</p> : option ? <EChart option={option} label={`${chart.title} ${rows.length} รายการ`} onSelect={event => drill(chart, event)} onReady={instance => { if (instance) instances.current.set(chart.id, instance); else instances.current.delete(chart.id); }} /> : <p className="dash-empty">{loading ? 'กำลังคำนวณ…' : 'ไม่มีข้อมูลตามตัวกรองนี้'}</p>}
          {tables[chart.id] && rows.length > 0 && <div className="dash-mini-table"><table><thead><tr><th>{chart.x_name || 'กลุ่ม'}</th><th>{chart.type === 'scatter' ? chart.y_name : seriesName(chart)}</th></tr></thead><tbody>{rows.slice(0, 100).map((row, index) => <tr key={index}><td>{formatFull(row.x)}</td><td>{formatFull(row.y)}</td></tr>)}</tbody></table></div>}
        </article>;
      })}
    </section>

    <section className="dash-insights" aria-label="Key Insights">
      <div className="dash-section-head"><h3><Sparkles size={17} aria-hidden="true" />Key Insights</h3><span>{ai ? `วิเคราะห์โดย ${ai.model} จากข้อมูลทั้งหมด` : 'ข้อค้นพบจากการคำนวณ'} · ไม่เปลี่ยนตามตัวกรอง</span></div>
      {ai?.summary && <p className="dash-summary">{ai.summary}</p>}
      {!ai && analysis.ai?.message && <p className="dash-note"><Info size={13} aria-hidden="true" /> {analysis.ai.message}</p>}
      <ol>{insights.map((item, index) => <li key={index}><strong>{item.title}</strong><p>{item.description}</p>
        <details><summary>หลักฐาน {item.ids.join(', ')}</summary>{item.ids.map(evidenceId => { const source = evidence.get(evidenceId); return source ? <p key={evidenceId}><b>{evidenceId}</b> {source.evidence.metric}: {formatFull(source.evidence.value)} · {source.evidence.method}</p> : null; })}</details>
      </li>)}</ol>
    </section>

    {sheet && <section className="dash-data" aria-label="ข้อมูลตามตัวกรอง">
      <div className="dash-section-head"><h3>ข้อมูลที่ใช้ใน Dashboard</h3><span>{filters.length ? 'แสดงเฉพาะแถวที่ตรงกับตัวกรอง' : 'ข้อมูลทุกแถวของชีตนี้'}</span></div>
      <DataPreview key={`${id}:${sheet.id}`} id={id} sheet={sheet} filters={filters} />
    </section>}
  </div>;
}
