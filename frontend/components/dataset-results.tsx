'use client';

import { Component, lazy, Suspense, useRef, useState, type ReactNode } from 'react';
import { BarChart3, Download, FileCode2, FileSpreadsheet, FileText, Info, LoaderCircle, Printer } from 'lucide-react';
import { DashboardView } from '@/components/dashboard-view';
import { WorkbookSummary } from '@/components/workbook-summary';
import { exportDataset, type Dataset, type DatasetJob } from '@/lib/datasets';
import type { DatasetAnalysis, DatasetChart as Chart } from '@/lib/dataset-analysis';

const DatasetChart = lazy(() => import('@/components/dataset-chart'));
type Tab = 'dashboard' | 'report';
const tabs = [
  { id: 'dashboard', label: 'แดชบอร์ด', Icon: BarChart3 },
  { id: 'report', label: 'รายงาน', Icon: FileText },
] as const;
const num = (value: string | number | null | undefined) => typeof value === 'number' ? value.toLocaleString('th-TH', { maximumFractionDigits: 2 }) : value == null ? '—' : value;

class ChartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p className="insight-empty">แสดงกราฟไม่สำเร็จ</p> : this.props.children; }
}

function ChartPanel({ chart }: { chart: Chart }) {
  return <section className="insight-chart-panel"><div><h3>{chart.title}</h3><p>{chart.method}</p></div><ChartBoundary><Suspense fallback={<div className="insight-empty">กำลังเตรียมกราฟ…</div>}><DatasetChart chart={chart} /></Suspense></ChartBoundary></section>;
}

/** The benchmark-comparison report exactly as the BOQ engine rendered it, printable to A4. */
function BoqReport({ id, boq, filename }: { id: string; boq: NonNullable<DatasetJob['boq']>; filename: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(1400);
  const [notice, setNotice] = useState('');
  const source = `/api/datasets/${encodeURIComponent(id)}/boq-report`;
  function fit() {
    const document = frame.current?.contentDocument;
    if (document?.documentElement) setHeight(Math.max(900, document.documentElement.scrollHeight + 24));
  }
  function print() {
    const window = frame.current?.contentWindow;
    if (!window) return;
    setNotice('ในหน้าต่างพิมพ์ เลือกปลายทาง “บันทึกเป็น PDF” และกระดาษ A4');
    window.focus();
    window.print();
  }
  async function saveHtml() {
    const response = await fetch(source);
    if (!response.ok) { setNotice('ดาวน์โหลดไม่สำเร็จ กรุณาลองอีกครั้ง'); return; }
    const href = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `${filename.replace(/\.[^.]+$/, '')}-report.html`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 30_000);
  }
  return <>
    <div className="office-commandbar">
      <span>รายงานวิเคราะห์ปริมาณและราคา · {boq.vendors.join(', ')} เทียบ {boq.benchmark || 'ราคากลาง'}</span>
      <div>
        <button className="office-button" onClick={() => void saveHtml()}><FileCode2 size={15} />ดาวน์โหลด HTML</button>
        <button className="office-button primary" onClick={print}><Printer size={15} />พิมพ์ / บันทึกเป็น PDF</button>
      </div>
    </div>
    {notice && <output className="office-muted">{notice}</output>}
    {/* Engine HTML runs without scripts; same-origin lets this page size and print the frame. */}
    <iframe ref={frame} className="office-report-frame" title="รายงานวิเคราะห์ปริมาณและราคาเชิงลึก" src={source} sandbox="allow-same-origin allow-modals" style={{ height }} onLoad={fit} />
  </>;
}

export function DatasetResults({ id, dataset, analysis, boq, onAnalyze, retrying }: { id: string; dataset: Dataset; analysis?: DatasetAnalysis; boq?: DatasetJob['boq']; onAnalyze: (objective: string) => Promise<void>; retrying: boolean }) {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [exporting, setExporting] = useState('');
  const [error, setError] = useState('');

  async function download(format: 'pdf' | 'xlsx') {
    if (exporting) return;
    setExporting(format); setError('');
    try { await exportDataset(id, format, dataset.filename); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'ดาวน์โหลดไม่สำเร็จ กรุณาลองอีกครั้ง'); }
    finally { setExporting(''); }
  }

  return <div className="office-results">
    <nav className="office-tabs" aria-label="มุมมอง">
      {tabs.map(({ id: value, label, Icon }) => <button key={value} className={tab === value ? 'active' : ''} aria-current={tab === value ? 'page' : undefined} onClick={() => setTab(value)}><Icon size={16} aria-hidden="true" />{label}</button>)}
      <span className="office-tabs-meta">{num(dataset.rows_count)} แถว · {dataset.sheets.filter(sheet => !sheet.combined_from).length} ชีต</span>
    </nav>
    {error && <div className="data-error" role="alert"><Info size={18} /><p>{error}</p></div>}

    {!analysis && <section className="office-card office-empty"><h2>ยังไม่ได้วิเคราะห์ไฟล์นี้</h2><p>ระบบจะคำนวณตัวเลข และสร้างแดชบอร์ดกับรายงานให้อัตโนมัติ</p><button className="office-button primary" disabled={retrying} onClick={() => void onAnalyze('')}>วิเคราะห์ข้อมูล</button></section>}

    {tab === 'dashboard' && analysis?.dashboard && <DashboardView id={id} dataset={dataset} analysis={analysis} spec={analysis.dashboard} />}
    {tab === 'dashboard' && analysis && !analysis.dashboard && <>
      <div className="insight-kpis">{analysis.kpis.map(kpi => <section key={kpi.id}><span>{kpi.name}</span><strong>{kpi.formatted_value || num(kpi.value)}</strong><small>{kpi.source.sheet}</small></section>)}</div>
      {analysis.charts.length > 0 && <div className="insight-chart-grid">{analysis.charts.map(chart => <ChartPanel key={chart.id} chart={chart} />)}</div>}
    </>}

    {tab === 'report' && boq && <BoqReport id={id} boq={boq} filename={dataset.filename} />}
    {tab === 'report' && !boq && analysis && <>
      <div className="office-commandbar"><span>รายงานสรุปผลการวิเคราะห์ (A4)</span><div>
        <button className="office-button" disabled={Boolean(exporting)} onClick={() => void download('xlsx')}>{exporting === 'xlsx' ? <LoaderCircle size={15} className="data-spin" /> : <FileSpreadsheet size={15} />}ดาวน์โหลด Excel</button>
        <button className="office-button primary" disabled={Boolean(exporting)} onClick={() => void download('pdf')}>{exporting === 'pdf' ? <LoaderCircle size={15} className="data-spin" /> : <Download size={15} />}ดาวน์โหลด PDF</button>
      </div></div>
      <article className="insight-report">
        <header className="insight-report-header"><span>ASSETWISE</span><h2>รายงานการวิเคราะห์ข้อมูล</h2><p>{dataset.filename}</p><div><span>{num(dataset.rows_count)} แถว · {dataset.sheets.length} ชีต</span><span>{new Date(analysis.generated_at).toLocaleDateString('th-TH', { dateStyle: 'long' })}</span></div></header>
        {analysis.report.sections.map((section, index) => <section key={section.id}><div className="insight-report-section-title"><span>{String(index + 1).padStart(2, '0')}</span><h3>{section.title}</h3></div>{section.paragraphs.map((paragraph, number) => <p key={number}>{paragraph}</p>)}</section>)}
        <footer>ตัวเลขทุกค่าคำนวณจากข้อมูลในไฟล์ที่อัปโหลด ข้อเสนอแนะควรพิจารณาร่วมกับบริบทของงานก่อนตัดสินใจ</footer>
      </article>
    </>}
    {tab === 'report' && (boq || analysis) && <WorkbookSummary dataset={dataset} />}
  </div>;
}
