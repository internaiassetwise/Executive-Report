'use client';

import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { BarChart3, Download, FileCode2, FileSpreadsheet, FileText, Info, LoaderCircle, MessageSquareText, Printer } from 'lucide-react';
import { AnswerView, AskBar, suggestQuestions } from '@/components/agent-answer';
import { DashboardView } from '@/components/dashboard-view';
import { DocumentDashboard, DocumentFocus } from '@/components/document-dashboard';
import { askDataset, exportDataset, type AgentAnswer, type Dataset, type DatasetJob, type DocumentInfo } from '@/lib/datasets';
import type { DatasetAnalysis, DatasetChart as Chart } from '@/lib/dataset-analysis';

const DatasetChart = lazy(() => import('@/components/dataset-chart'));
type Tab = 'dashboard' | 'questions' | 'report';
const num = (value: string | number | null | undefined) => typeof value === 'number' ? value.toLocaleString('th-TH', { maximumFractionDigits: 2 }) : value == null ? '—' : value;

class ChartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p className="insight-empty">แสดงกราฟไม่สำเร็จ</p> : this.props.children; }
}

function ChartPanel({ chart }: { chart: Chart }) {
  return <section className="insight-chart-panel"><div><h3>{chart.title}</h3><p>{chart.method}</p></div><ChartBoundary><Suspense fallback={<div className="insight-empty">กำลังเตรียมกราฟ…</div>}><DatasetChart chart={chart} /></Suspense></ChartBoundary></section>;
}

/** A construction cost report exactly as the server rendered it (BOQ benchmark, bid comparison or estimate), printable to A4. */
function DocumentReport({ id, title, filename, version }: { id: string; title: string; filename: string; version: number }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(1400);
  const [notice, setNotice] = useState('');
  // The report grows with each answered question; the version reloads the frame.
  const source = `/api/datasets/${encodeURIComponent(id)}/boq-report?v=${version}`;
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
      <span>{title}</span>
      <div>
        <button className="office-button" onClick={() => void saveHtml()}><FileCode2 size={15} />HTML</button>
        <button className="office-button primary" onClick={print}><Printer size={15} />พิมพ์ / PDF</button>
      </div>
    </div>
    {notice && <output className="office-muted">{notice}</output>}
    {/* Engine HTML runs without scripts; same-origin lets this page size and print the frame. */}
    <iframe ref={frame} className="office-report-frame" title="รายงาน" src={source} sandbox="allow-same-origin allow-modals" style={{ height }} onLoad={fit} />
  </>;
}

const RANK = { high: 0, medium: 1, low: 2 } as const;

/** First thing on the dashboard: the summary, the key findings, and the answer to the objective if one was typed. */
function OverviewSummary({ analysis }: { analysis: DatasetAnalysis }) {
  const ai = analysis.ai?.status === 'complete' ? analysis.ai : null;
  const question = analysis.answer?.question;
  const summary = ai?.summary || analysis.summary;
  const points = ai?.insights?.length
    ? ai.insights.slice(0, 4).map(item => ({ title: item.title, text: item.description }))
    : [...analysis.insights].sort((a, b) => RANK[a.importance] - RANK[b.importance]).slice(0, 4).map(item => ({ title: item.title, text: item.description }));
  const kpis = question ? analysis.answer?.kpis || [] : [];
  const charts = question ? analysis.answer?.charts || [] : [];
  if (!summary && !points.length) return null;
  return <section className="overview" aria-label="สรุป">
    <header className="answer-head">
      <span className="answer-eyebrow">{question ? 'สรุปตามโจทย์' : 'สรุปภาพรวม'}</span>
      {question && <p className="answer-question">{question}</p>}
    </header>
    {summary && <p className="answer-summary">{summary}</p>}
    {points.length > 0 && <ol className="overview-points">{points.map((point, index) => <li key={index}><strong>{point.title}</strong><span>{point.text}</span></li>)}</ol>}
    {(kpis.length > 0 || charts.length > 0) && <AnswerView answer={{ kpis, charts }} />}
  </section>;
}

/** Follow-up questions and their answers, oldest first, with ideas to start from. */
function Questions({ conversation, pending, error, suggestions, onAsk, disabled }: { conversation: AgentAnswer[]; pending: string | null; error: string; suggestions: string[]; onAsk: (question: string) => void; disabled: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [conversation.length, pending]);
  return <div className="thread">
    {!conversation.length && !pending && <section className="thread-empty">
      <h2>ถามอะไรก็ได้เกี่ยวกับไฟล์นี้</h2>
      <p>ระบบจะเลือกคอลัมน์ คำนวณจากทุกแถว แล้วตอบพร้อมกราฟ คำตอบจะถูกเพิ่มลงในรายงานด้วย</p>
      <div className="thread-ideas">{suggestions.map(idea => <button key={idea} type="button" disabled={disabled} onClick={() => onAsk(idea)}>{idea}</button>)}</div>
    </section>}
    {conversation.map((entry, index) => <AnswerView key={entry.asked_at || index} answer={entry} question={entry.question} />)}
    {pending && <article className="answer pending" aria-live="polite">
      <header className="answer-head"><p className="answer-question">{pending}</p></header>
      <p className="answer-working"><LoaderCircle size={16} className="data-spin" />กำลังเลือกข้อมูลและคำนวณ อาจใช้เวลาราว 20–40 วินาที</p>
    </article>}
    {error && <div className="data-error" role="alert"><Info size={18} /><p>{error}</p></div>}
    <div ref={end} />
  </div>;
}

export function DatasetResults({ id, dataset, analysis, boq, document, conversation = [], aiReady, onAnalyze, onRefresh, retrying }: {
  id: string; dataset: Dataset; analysis?: DatasetAnalysis; boq?: DatasetJob['boq']; document?: DocumentInfo; conversation?: AgentAnswer[];
  aiReady: boolean; onAnalyze: (objective: string) => Promise<void>; onRefresh: () => Promise<void>; retrying: boolean;
}) {
  // Construction cost documents (BOQ against a benchmark, bid comparison, estimate) get their
  // own computed dashboard and report; every other file gets the general ones.
  const construction = document && document.type !== 'general' ? document : null;
  const reportTitle = boq ? `รายงานวิเคราะห์ปริมาณและราคา · ${boq.vendors.join(', ')} เทียบ ${boq.benchmark || 'ราคากลาง'}` : construction ? `รายงาน${construction.label}` : '';
  const [tab, setTab] = useState<Tab>('dashboard');
  const [exporting, setExporting] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [askError, setAskError] = useState('');
  const sheets = dataset.sheets.filter(sheet => !sheet.combined_from).length;

  async function download(format: 'pdf' | 'xlsx') {
    if (exporting) return;
    setExporting(format); setError('');
    try { await exportDataset(id, format, dataset.filename); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'ดาวน์โหลดไม่สำเร็จ กรุณาลองอีกครั้ง'); }
    finally { setExporting(''); }
  }

  async function ask(question: string): Promise<boolean> {
    if (pending) return false;
    setPending(question); setAskError(''); setTab('questions');
    try { await askDataset(id, question); await onRefresh(); return true; }
    catch (reason) { setAskError(reason instanceof Error ? reason.message : 'ตอบคำถามไม่สำเร็จ กรุณาลองอีกครั้ง'); return false; }
    finally { setPending(null); }
  }

  const tabs = [
    { id: 'dashboard', label: 'แดชบอร์ด', Icon: BarChart3 },
    { id: 'questions', label: conversation.length ? `ถาม-ตอบ (${conversation.length})` : 'ถาม-ตอบ', Icon: MessageSquareText },
    { id: 'report', label: 'รายงาน', Icon: FileText },
  ] as const;

  return <div className="results">
    <header className="results-head">
      <div>
        <h1>{dataset.filename}</h1>
        <p>{[construction?.label, `${num(dataset.rows_count)} แถว`, `${sheets} ${dataset.converted_from ? 'ตาราง' : 'ชีต'}`, dataset.converted_from && `แปลงจากไฟล์ ${dataset.converted_from.toUpperCase()}`].filter(Boolean).join(' · ')}</p>
      </div>
      <nav className="results-tabs" aria-label="มุมมอง">
        {tabs.map(({ id: value, label, Icon }) => <button key={value} className={tab === value ? 'active' : ''} aria-current={tab === value ? 'page' : undefined} onClick={() => setTab(value)}><Icon size={16} aria-hidden="true" />{label}</button>)}
      </nav>
    </header>
    {error && <div className="data-error" role="alert"><Info size={18} /><p>{error}</p></div>}

    {!analysis && <section className="office-card office-empty"><h2>ยังไม่ได้วิเคราะห์ไฟล์นี้</h2><p>ระบบจะคำนวณตัวเลข และสร้างแดชบอร์ดกับรายงานให้อัตโนมัติ</p><button className="office-button primary" disabled={retrying} onClick={() => void onAnalyze('')}>วิเคราะห์ข้อมูล</button></section>}

    {tab === 'dashboard' && <>
      {!construction?.dashboard && analysis && <OverviewSummary analysis={analysis} />}
      {construction?.dashboard && <DocumentDashboard id={id} dataset={dataset} document={construction} />}
      {!construction?.dashboard && analysis?.dashboard && <DashboardView id={id} dataset={dataset} analysis={analysis} spec={analysis.dashboard} hideSummary />}
      {!construction?.dashboard && analysis && !analysis.dashboard && <>
        <div className="insight-kpis">{analysis.kpis.map(kpi => <section key={kpi.id}><span>{kpi.name}</span><strong>{kpi.formatted_value || num(kpi.value)}</strong><small>{kpi.source.sheet}</small></section>)}</div>
        {analysis.charts.length > 0 && <div className="insight-chart-grid">{analysis.charts.map(chart => <ChartPanel key={chart.id} chart={chart} />)}</div>}
      </>}
    </>}

    {tab === 'questions' && <Questions conversation={conversation} pending={pending} error={askError} suggestions={suggestQuestions(analysis?.profiles, Boolean(construction))} onAsk={question => void ask(question)} disabled={!aiReady || !analysis || Boolean(pending)} />}

    {tab === 'report' && (boq || construction?.has_report) && <><DocumentFocus focus={construction?.focus} compact /><DocumentReport id={id} title={reportTitle} filename={dataset.filename} version={conversation.length} /></>}
    {tab === 'report' && !boq && !construction?.has_report && analysis && <>
      <div className="office-commandbar"><span>รายงานสรุปผลการวิเคราะห์ (A4)</span><div>
        <button className="office-button" disabled={Boolean(exporting)} onClick={() => void download('xlsx')}>{exporting === 'xlsx' ? <LoaderCircle size={15} className="data-spin" /> : <FileSpreadsheet size={15} />}Excel</button>
        <button className="office-button primary" disabled={Boolean(exporting)} onClick={() => void download('pdf')}>{exporting === 'pdf' ? <LoaderCircle size={15} className="data-spin" /> : <Download size={15} />}PDF</button>
      </div></div>
      <article className="insight-report">
        <header className="insight-report-header"><span>ASSETWISE</span><h2>{analysis.report.title || 'รายงานการวิเคราะห์ข้อมูล'}</h2><p>{dataset.filename}</p><div><span>{num(dataset.rows_count)} แถว · {dataset.sheets.length} ชีต</span><span>{new Date(analysis.generated_at).toLocaleDateString('th-TH', { dateStyle: 'long' })}</span></div></header>
        {analysis.report.sections.map((section, index) => <section key={section.id}><div className="insight-report-section-title"><span>{String(index + 1).padStart(2, '0')}</span><h3>{section.title.replace(/^\d+\.\s*/, '')}</h3></div>{section.paragraphs.map((paragraph, number) => <p key={number}>{paragraph}</p>)}</section>)}
        <footer>ตัวเลขทุกค่าคำนวณจากข้อมูลในไฟล์ที่อัปโหลด ข้อเสนอแนะควรพิจารณาร่วมกับบริบทของงานก่อนตัดสินใจ</footer>
      </article>
    </>}

    {analysis && <AskBar onAsk={ask} pending={Boolean(pending)} disabled={!aiReady} note="ยังไม่ได้เปิดใช้ AI บนเซิร์ฟเวอร์ จึงถามเพิ่มเติมไม่ได้" />}
  </div>;
}
