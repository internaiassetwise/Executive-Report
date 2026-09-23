'use client';

import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { BarChart3, Database, Download, FileText, Info, LoaderCircle, RefreshCw, Search, Sparkles } from 'lucide-react';
import { DataPreview } from '@/components/data-preview';
import { DashboardView } from '@/components/dashboard-view';
import { exportDataset, type Dataset } from '@/lib/datasets';
import type { DatasetAnalysis, DatasetChart as Chart, DatasetInsight, SheetProfile } from '@/lib/dataset-analysis';

const DatasetChart = lazy(() => import('@/components/dataset-chart'));
type Tab = 'dashboard' | 'report' | 'data' | 'analysis';
const tabs = [{ id: 'dashboard', label: 'Dashboard', Icon: BarChart3 }, { id: 'report', label: 'Report', Icon: FileText }, { id: 'data', label: 'Data', Icon: Database }, { id: 'analysis', label: 'Analysis', Icon: Search }] as const;
const num = (value: string | number | null | undefined) => typeof value === 'number' ? value.toLocaleString('th-TH', { maximumFractionDigits: 2 }) : value == null ? '—' : value;
const typeNames: Record<string, string> = { number: 'ตัวเลข', text: 'ข้อความ', date: 'วันที่', boolean: 'จริง/เท็จ', mixed: 'หลายชนิด', empty: 'ว่าง' };

class ChartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p className="insight-empty">แสดงกราฟไม่สำเร็จ ยังดูค่าที่คำนวณได้ในตารางข้อมูลกราฟด้านล่าง</p> : this.props.children; }
}

function Evidence({ insight }: { insight: DatasetInsight }) {
  return <details className="insight-evidence"><summary>หลักฐาน {insight.id} · {insight.evidence.sheet}</summary><p>{insight.evidence.method}</p><p>{insight.evidence.metric}: {num(insight.evidence.value)}</p><p>คอลัมน์: {insight.evidence.columns.join(', ') || 'ทั้งตาราง'}</p></details>;
}

function ChartPanel({ chart }: { chart: Chart }) {
  return <section className="insight-chart-panel"><div><h3>{chart.title}</h3><p>{chart.method}</p></div><ChartBoundary><Suspense fallback={<div className="insight-empty">กำลังเตรียมกราฟ…</div>}><DatasetChart chart={chart} /></Suspense></ChartBoundary><details className="insight-evidence"><summary>ข้อมูลที่ใช้สร้างกราฟ · {chart.data.length} จุด</summary><div className="insight-mini-table"><table><thead><tr><th>{chart.x_label}</th><th>{chart.y_label}</th></tr></thead><tbody>{chart.data.map((point, index) => <tr key={index}><td>{String(point.x)}</td><td>{num(point.y)}</td></tr>)}</tbody></table></div></details></section>;
}

function Quality({ profile }: { profile: SheetProfile }) {
  return <section className="insight-profile"><div className="insight-section-head"><h3>{profile.sheet_name}</h3><span>{num(profile.rows_count)} แถว · {profile.columns.length} คอลัมน์</span></div><div className="insight-quality-summary"><span>ค่าว่าง <b>{num(profile.missing_count)}</b> เซลล์ ({num(profile.missing_percentage)}%)</span><span>แถวซ้ำ <b>{num(profile.duplicate_rows)}</b> แถว</span></div>
    {profile.warnings.length > 0 && <ul className="insight-warnings">{profile.warnings.map((value, index) => <li key={index}>{value}</li>)}</ul>}
    <div className="insight-profile-scroll"><table><thead><tr><th>คอลัมน์</th><th>ชนิดข้อมูล</th><th>ค่าว่าง</th><th>ค่าที่ไม่ซ้ำ</th><th>ต่ำสุด</th><th>สูงสุด</th><th>เฉลี่ย</th><th>มัธยฐาน</th><th>ส่วนเบี่ยงเบน</th><th>Outliers (IQR)</th></tr></thead><tbody>{profile.columns.map(column => <tr key={column.key}><th>{column.name}</th><td>{typeNames[column.data_type]}</td><td>{num(column.missing_percentage)}%</td><td>{num(column.unique_count)}</td><td>{num(column.statistics?.min ?? column.date_range?.min)}</td><td>{num(column.statistics?.max ?? column.date_range?.max)}</td><td>{num(column.statistics?.mean)}</td><td>{num(column.statistics?.median)}</td><td>{num(column.statistics?.std)}</td><td>{num(column.outliers?.count)}</td></tr>)}</tbody></table></div>
    <details className="insight-evidence"><summary>การกระจายหมวดหมู่และความสัมพันธ์</summary>{profile.columns.filter(column => column.top_values?.length).map(column => <p key={column.key}><b>{column.name}:</b> {column.top_values?.map(value => `${value.value}: ${num(value.count)}`).join(' · ')}</p>)}{profile.correlations.map((item, index) => <p key={index}>{item.x} ↔ {item.y}: r = {num(item.value)} · {num(item.sample_size)} คู่ข้อมูล</p>)}{!profile.correlations.length && <p>ข้อมูลไม่เพียงพอสำหรับการสรุปความสัมพันธ์ระหว่างตัวเลข</p>}</details>
  </section>;
}

export function DatasetResults({ id, dataset, analysis, onAnalyze, retrying }: { id: string; dataset: Dataset; analysis?: DatasetAnalysis; onAnalyze: (objective: string) => Promise<void>; retrying: boolean }) {
  const [tab, setTab] = useState<Tab>(analysis ? 'dashboard' : 'data');
  const [sheetId, setSheetId] = useState(dataset.sheets[0]?.id || '');
  const [chartSheet, setChartSheet] = useState('');
  const [objective, setObjective] = useState('');
  const [exporting, setExporting] = useState('');
  const [error, setError] = useState('');
  const sheet = dataset.sheets.find(item => item.id === sheetId) || dataset.sheets[0];
  const ai = analysis?.ai;
  const aiComplete = ai?.status === 'complete';
  const charts = analysis?.charts.filter(chart => !chartSheet || chart.sheet_id === chartSheet) || [];
  const missing = analysis?.profiles.reduce((sum, profile) => sum + profile.missing_count, 0) || 0;
  const duplicates = analysis?.profiles.reduce((sum, profile) => sum + profile.duplicate_rows, 0) || 0;

  async function download(format: 'pdf' | 'xlsx' | 'csv') {
    if (exporting) return;
    setExporting(format); setError('');
    try { await exportDataset(id, format, dataset.filename, format === 'csv' ? sheet.id : undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'ส่งออกไม่สำเร็จ กรุณาลองอีกครั้ง'); }
    finally { setExporting(''); }
  }

  return <div className="insight-results">
    <div className="data-ready-summary"><span className="data-ready-label">{analysis ? 'วิเคราะห์ข้อมูลเสร็จแล้ว' : 'ข้อมูลพร้อมวิเคราะห์'}</span><span>{num(dataset.rows_count)} แถว</span><span>{dataset.sheets.length} ชีต</span><span>{analysis ? 'วิเคราะห์เมื่อ ' : 'อัปโหลดเมื่อ '}{new Date(analysis?.generated_at || dataset.created_at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })}</span></div>
    <div className="insight-navigation"><nav aria-label="มุมมองผลการวิเคราะห์">{tabs.map(({ id: value, label, Icon }) => <button key={value} className={tab === value ? 'active' : ''} aria-current={tab === value ? 'page' : undefined} onClick={() => setTab(value)}><Icon size={17} />{label}</button>)}</nav><div className="insight-export-actions"><button className="data-button secondary compact" disabled={!analysis || Boolean(exporting)} onClick={() => void download('xlsx')}>{exporting === 'xlsx' ? <LoaderCircle size={15} className="data-spin" /> : <Download size={15} />}Excel</button><button className="data-button primary compact" disabled={!analysis || Boolean(exporting)} onClick={() => void download('pdf')}>{exporting === 'pdf' ? <LoaderCircle size={15} className="data-spin" /> : <FileText size={15} />}PDF</button></div></div>
    {error && <div className="data-error" role="alert"><Info size={18} /><p>{error}</p></div>}
    {dataset.warnings.length > 0 && <details className="data-warnings"><summary><Info size={16} />ข้อสังเกตจากไฟล์ ({dataset.warnings.length})</summary><ul>{dataset.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    {analysis && !aiComplete && <div className="insight-ai-notice"><Info size={18} /><p>{ai?.message || 'ยังไม่มีคำตีความจาก AI ผลสถิติและกราฟคำนวณจากข้อมูลจริงพร้อมใช้งานแล้ว'}</p><button className="data-text-button" disabled={retrying} onClick={() => void onAnalyze(objective)}>ลองวิเคราะห์อีกครั้ง</button></div>}

    {tab !== 'data' && !analysis ? <section className="insight-empty-state"><Sparkles size={28} /><h2>เริ่มวิเคราะห์ข้อมูลชุดนี้</h2><p>คำนวณสถิติ ตรวจคุณภาพข้อมูล สร้างกราฟ และให้ AI สรุปรายงานจากหลักฐาน</p><button className="data-button primary" disabled={retrying} onClick={() => void onAnalyze(objective)}>วิเคราะห์ข้อมูล</button></section> : null}

    {tab === 'dashboard' && analysis?.dashboard && <DashboardView id={id} dataset={dataset} analysis={analysis} spec={analysis.dashboard} />}
    {tab === 'dashboard' && analysis && !analysis.dashboard && <>
      <section className="insight-executive"><span className="analyst-eyebrow">EXECUTIVE SUMMARY</span><h2>ภาพรวมจากข้อมูลของคุณ</h2><p>{aiComplete && ai?.summary ? ai.summary : analysis.summary}</p><small>{aiComplete ? `คำตีความโดย ${ai.model} · อ้างอิงผลคำนวณจาก Python` : 'สรุปจากผลคำนวณและหลักฐานในชุดข้อมูล'}</small></section>
      <div className="insight-kpis">{analysis.kpis.map(kpi => <section key={kpi.id}><span>{kpi.name}</span><strong>{kpi.formatted_value || num(kpi.value)}</strong><small>{kpi.source.sheet}{kpi.source.column ? ` · ${kpi.source.column}` : ''}</small><details><summary>วิธีคำนวณ</summary><p>{kpi.method}</p></details></section>)}</div>
      <section className="insight-findings"><div className="insight-section-head"><h2>ประเด็นสำคัญ</h2><span>{analysis.insights.length} ข้อค้นพบที่มีหลักฐาน</span></div>{aiComplete && ai?.insights?.length ? ai.insights.map((insight, index) => <article key={index}><span className="insight-number">{String(index + 1).padStart(2, '0')}</span><div><h3>{insight.title}</h3><p>{insight.description}</p><small>{insight.evidence_ids.join(' · ')}</small></div></article>) : analysis.insights.slice(0, 8).map((insight, index) => <article key={insight.id}><span className="insight-number">{String(index + 1).padStart(2, '0')}</span><div><h3>{insight.title}</h3><p>{insight.description}</p><Evidence insight={insight} /></div></article>)}</section>
      <div className="insight-section-head"><h2>สำรวจข้อมูลด้วยกราฟ</h2><label>ชีต <select aria-label="กรองกราฟตามชีต" value={chartSheet} onChange={event => setChartSheet(event.target.value)}><option value="">ทุกชีต</option>{dataset.sheets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
      {charts.length ? <div className="insight-chart-grid">{charts.map(chart => <ChartPanel key={chart.id} chart={chart} />)}</div> : <p className="insight-empty">ข้อมูลในชีตนี้ไม่เพียงพอสำหรับกราฟที่เหมาะสม ดูรายละเอียดเพิ่มเติมใน Analysis</p>}
      <div className="insight-quality-strip"><div><span>คุณภาพข้อมูล</span><strong>{num(missing)} ค่าว่าง · {num(duplicates)} แถวซ้ำ</strong></div><button className="data-button secondary compact" onClick={() => setTab('analysis')}>ดูรายละเอียดคุณภาพข้อมูล</button></div>
    </>}

    {tab === 'report' && analysis && <article className="insight-report">
      <header className="insight-report-header"><span>ASSETWISE · DATA INSIGHT</span><h2>รายงานการวิเคราะห์ข้อมูล</h2><p>{dataset.filename}</p><div><span>{num(dataset.rows_count)} แถว · {dataset.sheets.length} ชีต</span><span>{new Date(analysis.generated_at).toLocaleDateString('th-TH', { dateStyle: 'long' })}</span></div></header>
      {analysis.report.sections.map((section, index) => <section key={section.id}><div className="insight-report-section-title"><span>{String(index + 1).padStart(2, '0')}</span><h3>{section.title}</h3></div>{section.paragraphs.map((paragraph, number) => <p key={number}>{paragraph}</p>)}{index === 0 && aiComplete && ai?.summary && <div className="insight-report-ai"><strong>มุมมองจาก AI</strong><p>{ai.summary}</p></div>}{section.evidence_ids.length > 0 && <small>หลักฐาน: {section.evidence_ids.join(' · ')}</small>}</section>)}
      {aiComplete && (ai?.recommendations?.length || 0) > 0 && <section><div className="insight-report-section-title"><Sparkles size={20} /><h3>ข้อเสนอแนะเพิ่มเติมจาก AI</h3></div>{ai?.recommendations?.map((item, index) => <div key={index}><p>{item.text}</p><small>หลักฐาน: {item.evidence_ids.join(' · ')}</small></div>)}</section>}
      <footer>ASW Data Insight · ตัวเลขคำนวณจากข้อมูลที่อัปโหลด คำแนะนำควรตรวจสอบร่วมกับบริบทธุรกิจก่อนตัดสินใจ</footer>
    </article>}

    {tab === 'data' && sheet && <>
      <div className="data-sheet-bar"><label>ชีต<select aria-label="เลือกชีต" value={sheet.id} onChange={event => setSheetId(event.target.value)}>{dataset.sheets.map(item => <option value={item.id} key={item.id}>{item.name} ({num(item.rows_count)} แถว)</option>)}</select></label><button className="data-button secondary compact" disabled={Boolean(exporting)} onClick={() => void download('csv')}><Download size={15} />{exporting === 'csv' ? 'กำลังส่งออก…' : 'CSV ชีตนี้'}</button></div>
      {sheet.warnings.length > 0 && <details className="data-warnings"><summary><Info size={16} />ข้อสังเกตในชีตนี้ ({sheet.warnings.length})</summary><ul>{sheet.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      <DataPreview key={`${id}:${sheet.id}`} id={id} sheet={sheet} />
    </>}

    {tab === 'analysis' && analysis && <>
      <section className="insight-analysis-settings"><div><h2>การวิเคราะห์และหลักฐาน</h2><p>{ai?.model || 'Gemini'} · ใช้สถิติและข้อมูลสรุป ไม่ส่งไฟล์ต้นฉบับให้โมเดล</p></div><label htmlFor="analysis-objective">สิ่งที่ต้องการให้ AI เน้น (ไม่จำเป็น)</label><textarea id="analysis-objective" value={objective} maxLength={1000} rows={3} placeholder="เช่น เน้นคุณภาพข้อมูลและรายการที่ควรตรวจสอบเพิ่มเติม" onChange={event => setObjective(event.target.value)} /><button className="data-button secondary" disabled={retrying} onClick={() => void onAnalyze(objective)}><RefreshCw size={16} />วิเคราะห์อีกครั้ง</button></section>
      <div className="insight-section-head"><h2>สถิติและคุณภาพรายชีต</h2><span>คำนวณจากชุดข้อมูลที่อ่านทั้งหมด</span></div>{analysis.profiles.map(profile => <Quality key={profile.sheet_id} profile={profile} />)}
      <section className="insight-findings"><div className="insight-section-head"><h2>ข้อค้นพบและวิธีคำนวณ</h2><span>{analysis.insights.length} หลักฐาน</span></div>{analysis.insights.map(insight => <article key={insight.id}><span className={`insight-priority ${insight.importance}`}>{insight.importance === 'high' ? 'สำคัญ' : insight.importance === 'medium' ? 'ตรวจสอบ' : 'ข้อมูล'}</span><div><h3>{insight.title}</h3><p>{insight.description}</p><Evidence insight={insight} /></div></article>)}</section>
    </>}
  </div>;
}
