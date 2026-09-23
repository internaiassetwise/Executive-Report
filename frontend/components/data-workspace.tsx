'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, ChevronRight, FileSpreadsheet, Info, LoaderCircle, Plus, ShieldCheck, Upload, X } from 'lucide-react';
import { AccessGate } from '@/components/access-gate';
import { DatasetResults } from '@/components/dataset-results';
import { ACCESS_REQUIRED_EVENT, analyzeDataset, DatasetError, getDatasetConfig, getDatasetJob, removeDataset, uploadDataset, type DatasetConfig, type DatasetJob } from '@/lib/datasets';

const SESSION_KEY = 'ai-data-analyst:dataset';
const processingSteps = [
  { key: 'uploading', name: 'Upload file', th: 'อัปโหลดและตรวจสอบไฟล์' },
  { key: 'reading', name: 'Reading data', th: 'อ่านข้อมูลและโครงสร้างชีต' },
  { key: 'understanding_columns', name: 'Understanding columns', th: 'ทำความเข้าใจหัวคอลัมน์' },
  { key: 'detecting_types', name: 'Detecting data types', th: 'ตรวจจับชนิดข้อมูลแต่ละคอลัมน์' },
  { key: 'patterns', name: 'Finding patterns', th: 'คำนวณสถิติและค้นหารูปแบบ' },
  { key: 'ai', name: 'Generating insights', th: 'สร้างข้อค้นพบเชิงลึกด้วย AI' },
  { key: 'dashboard', name: 'Creating dashboard', th: 'สร้าง Dashboard และกราฟ' },
  { key: 'report', name: 'Creating report', th: 'จัดทำรายงานผู้บริหาร' },
] as const;

function getStepIndex(uploading: boolean, stage: string | undefined): number {
  if (uploading) return 0;
  switch (stage) {
    case 'validating': return 0;
    case 'reading': return 1;
    case 'understanding_columns': return 2;
    case 'detecting_types':
    case 'preview': return 3;
    case 'profiling':
    case 'patterns': return 4;
    case 'ai': return 5;
    case 'dashboard': return 6;
    case 'report': return 7;
    case 'complete': return 8;
    default: return 0;
  }
}
const sizeLabel = (size: number) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toLocaleString('th-TH', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.ceil(size / 1024)).toLocaleString('th-TH')} KB`;
const message = (reason: unknown) => reason instanceof Error ? reason.message : 'เกิดข้อผิดพลาด กรุณาลองอีกครั้ง';
function remember(id: string | null) {
  try { if (id) sessionStorage.setItem(SESSION_KEY, id); else sessionStorage.removeItem(SESSION_KEY); } catch { /* Storage may be disabled. */ }
}

export function DataWorkspace() {
  const [config, setConfig] = useState<DatasetConfig | null>(null);
  const [configError, setConfigError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<DatasetJob | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [restoring, setRestoring] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [pollRetry, setPollRetry] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [locked, setLocked] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pendingUpload = useRef<Promise<DatasetJob> | null>(null);
  const activeId = useRef<string | null>(null);
  const activeOperation = useRef(0);
  const dataset = job && job.status !== 'processing' ? job.dataset : undefined;
  const processing = uploading || job?.status === 'processing';
  const processingId = job?.status === 'processing' ? job.id : null;

  const loadConfig = useCallback((signal?: AbortSignal) =>
    getDatasetConfig(signal).then(value => { if (!signal?.aborted) setConfig(value); })
      .catch(reason => { if (!signal?.aborted) setConfigError(message(reason)); }), []);

  useEffect(() => {
    const lock = () => setLocked(true);
    window.addEventListener(ACCESS_REQUIRED_EVENT, lock);
    return () => window.removeEventListener(ACCESS_REQUIRED_EVENT, lock);
  }, []);

  function unlocked() {
    setLocked(false); setConfigError(''); setError('');
    void loadConfig();
    if (activeId.current) void getDatasetJob(activeId.current).then(setJob).catch(() => { remember(null); activeId.current = null; });
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadConfig(controller.signal);
    let stored: string | null = null;
    try { stored = sessionStorage.getItem(SESSION_KEY); } catch { /* Optional session persistence. */ }
    if (!stored) queueMicrotask(() => { if (!controller.signal.aborted) setRestoring(false); });
    else {
      activeId.current = stored;
      void getDatasetJob(stored, controller.signal).then(value => {
        if (!controller.signal.aborted) setJob(value);
      }).catch(reason => {
        if (controller.signal.aborted) return;
        if (reason instanceof DatasetError && [404, 410].includes(reason.status)) { remember(null); activeId.current = null; }
        setError(message(reason));
      }).finally(() => { if (!controller.signal.aborted) setRestoring(false); });
    }
    return () => { controller.abort(); };
  }, [loadConfig]);

  useEffect(() => {
    if (!processingId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const id = processingId;
    const poll = async () => {
      try {
        const result = await getDatasetJob(id, controller.signal);
        if (controller.signal.aborted || activeId.current !== id) return;
        setJob(result); setPollError(''); failures = 0;
        if (result.status === 'processing') timer = setTimeout(poll, 700);
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (reason instanceof DatasetError && [404, 410].includes(reason.status)) {
          remember(null); activeId.current = null; setJob(null); setError(message(reason)); return;
        }
        setPollError(message(reason));
        failures++;
        if (failures < 3) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => { clearTimeout(timer); controller.abort(); };
  }, [processingId, pollRetry]);

  function selectFiles(files: FileList | File[]) {
    setError('');
    setFile(null);
    if (files.length !== 1) { setError('เลือกครั้งละ 1 ไฟล์ หากเป็น Excel ระบบจะอ่านทุกชีตในไฟล์ให้'); return; }
    const selected = files[0];
    if (!config) { setError('ยังเชื่อมต่อบริการข้อมูลไม่ได้ กรุณาลองอีกครั้ง'); return; }
    const extension = selected.name.slice(selected.name.lastIndexOf('.')).toLowerCase();
    if (!config.accepted_extensions.includes(extension)) { setError(`รองรับ ${config.accepted_extensions.join(' และ ')} เท่านั้น กรุณาบันทึกไฟล์เป็นรูปแบบที่รองรับ`); return; }
    if (!selected.size) { setError('ไฟล์นี้ว่าง กรุณาเลือกไฟล์ที่มีหัวคอลัมน์และแถวข้อมูล'); return; }
    if (selected.size > config.max_file_size) { setError(`ไฟล์ใหญ่เกิน ${sizeLabel(config.max_file_size)} กรุณาแบ่งข้อมูลเป็นไฟล์เล็กลง`); return; }
    setFile(selected);
  }

  async function clearDataset() {
    if (deleting) return;
    activeOperation.current++;
    setDeleting(true); setError('');
    try {
      // Wait for the accepted job ID before deleting. Aborting a completed
      // upload response can orphan a server job that the browser cannot name.
      const accepted = await pendingUpload.current?.catch(() => null);
      if (accepted && accepted.id !== activeId.current) await removeDataset(accepted.id);
      if (activeId.current) await removeDataset(activeId.current);
      activeId.current = null; remember(null); setJob(null); setFile(null); setPollError('');
      if (input.current) input.current.value = '';
    } catch (reason) { setError(message(reason)); }
    finally { setDeleting(false); setUploading(false); }
  }

  async function start() {
    if (!file || !config || uploading || restoring || deleting) return;
    const operation = ++activeOperation.current;
    const controller = new AbortController();
    setError(''); setPollError(''); setUploading(true); setUploadPercent(0);
    try {
      if (activeId.current) await removeDataset(activeId.current);
      if (operation !== activeOperation.current) return;
      activeId.current = null; remember(null); setJob(null);
      pendingUpload.current = uploadDataset(file, setUploadPercent, controller.signal);
      const created = await pendingUpload.current;
      // clearDataset owns cancellation cleanup and waits for this same promise.
      if (operation !== activeOperation.current) return;
      activeId.current = created.id; remember(created.id); setJob(created);
    } catch (reason) { if (!controller.signal.aborted && operation === activeOperation.current) setError(message(reason)); }
    finally { pendingUpload.current = null; if (operation === activeOperation.current) setUploading(false); }
  }

  async function reanalyze(objective: string) {
    if (!job || retrying) return;
    const operation = activeOperation.current;
    setRetrying(true); setError('');
    try {
      const result = await analyzeDataset(job.id, objective);
      if (operation === activeOperation.current) setJob(result);
    } catch (reason) { if (operation === activeOperation.current) setError(message(reason)); }
    finally { setRetrying(false); }
  }

  const currentStep = getStepIndex(uploading, job?.stage);
  const jobError = job?.status === 'error' ? job.error?.message || 'อ่านข้อมูลไม่สำเร็จ กรุณาตรวจไฟล์แล้วลองอีกครั้ง' : '';
  const progress = uploading ? uploadPercent : Math.min(99, Math.max(0, job?.progress || 0));

  return <div className="analyst-app">
    <header className="analyst-header">
      <Link className="analyst-brand" href="/" aria-label="AI Data Analyst หน้าหลัก"><span className="asw-original-logo" aria-hidden="true" /><strong>AI Data Analyst</strong></Link>
      <span className="analyst-header-detail">AI DATA ANALYSIS & REPORTING</span>
      {(dataset || processing || jobError) && <button className="data-button secondary compact" disabled={deleting} onClick={() => void clearDataset()}><Plus size={16} />{deleting ? 'กำลังลบข้อมูล…' : 'เริ่มด้วยไฟล์ใหม่'}</button>}
    </header>
    <main className="analyst-main">
      <div className="data-breadcrumb"><span>AI Data Analyst</span><ChevronRight size={13} /><span>{dataset ? 'ผลการวิเคราะห์' : processing ? 'กำลังวิเคราะห์' : 'อัปโหลดข้อมูล'}</span></div>
      <div className="analyst-title"><div><span className="analyst-eyebrow">{dataset ? 'YOUR DATA' : processing ? 'PROCESSING' : 'UPLOAD YOUR DATA'}</span>
        <h1>{dataset ? dataset.filename : processing ? 'Analyzing your data' : 'Upload your data'}</h1>
        <p>{dataset ? 'สำรวจข้อค้นพบ กราฟ รายงาน และข้อมูลต้นฉบับในที่เดียว' : processing ? 'อ่านข้อมูล ตรวจสอบคอลัมน์ คำนวณสถิติ และสร้างรายงานจากหลักฐานจริง' : 'Drop your CSV or Excel file here and let AI turn it into an understandable business report.'}</p></div>
        <span className="analyst-phase">{config?.ai?.model || 'GEMINI · DATA ANALYST'}</span>
      </div>
      <ol className="analyst-flow" aria-label="ขั้นตอนการทำงาน">
        {['Upload', 'Validation & Profiling', 'AI Analysis', 'Dashboard & Report'].map((label, index) => {
          const current = dataset ? 3 : uploading ? 0 : ['dashboard', 'report'].includes(job?.stage || '') ? 3 : ['profiling', 'patterns', 'ai'].includes(job?.stage || '') ? 2 : processing || jobError ? 1 : 0;
          return <li key={label} className={index === current ? 'active' : index < current ? 'done' : ''} aria-current={index === current ? 'step' : undefined}><span>{index < current ? <Check size={14} /> : index + 1}</span>{label}</li>;
        })}
      </ol>

      {!locked && (error || jobError) && <div className="data-error" role="alert"><Info size={20} /><div><strong>{jobError ? (job?.dataset ? 'วิเคราะห์ไม่สำเร็จ' : 'อ่านไฟล์ไม่สำเร็จ') : 'ยังดำเนินการไม่ได้'}</strong><p>{error || jobError}</p><div className="data-error-actions">{(file || job?.dataset) && <button className="data-button secondary compact" disabled={processing || deleting || retrying} onClick={() => { if (job?.dataset) void reanalyze(''); else void start(); }}>ลองอีกครั้ง</button>}{jobError && <button className="data-text-button" disabled={deleting} onClick={() => void clearDataset()}>เลือกไฟล์อื่น</button>}</div></div></div>}

      {locked ? <AccessGate onUnlocked={unlocked} /> : restoring ? <output className="data-loading"><LoaderCircle size={24} className="data-spin" />กำลังเปิดชุดข้อมูล…</output> : processing ?
        <section className="data-processing" aria-label="สถานะการประมวลผล">
          <div className="data-processing-heading">
            <span className="data-process-icon"><LoaderCircle size={28} className="data-spin" /></span>
            <div>
              <span className="analyst-eyebrow">PROCESSING PIPELINE</span>
              <h2>Analyzing your data</h2>
              <p>{file?.name || 'ไฟล์ที่อัปโหลด'}{file ? ` · ${sizeLabel(file.size)}` : ''}</p>
            </div>
            <strong>{progress}%</strong>
          </div>
          <progress className="data-progress" aria-label="ความคืบหน้าการประมวลผล" max={100} value={progress}>{progress}%</progress>
          <div className="data-current-step-badge">
            <span>Current step: </span>
            <strong>{currentStep < processingSteps.length ? `${processingSteps[currentStep].name} (${processingSteps[currentStep].th})` : 'Analysis complete'}</strong>
          </div>
          <ul className="data-stage-list">
            {processingSteps.map((step, index) => {
              const isDone = currentStep > index;
              const isActive = currentStep === index;
              return (
                <li key={step.key} className={isActive ? 'active' : isDone ? 'done' : 'pending'}>
                  <span className="data-stage-marker">
                    {isDone ? <Check size={16} /> : isActive ? <LoaderCircle size={16} className="data-spin" /> : <span className="data-stage-dot" />}
                  </span>
                  <div className="data-stage-text">
                    <strong>{step.name}</strong>
                    <small>{step.th}</small>
                  </div>
                </li>
              );
            })}
          </ul>
          {pollError && <div className="data-inline-error" role="alert"><p>{pollError}</p><button className="data-button secondary compact" onClick={() => { setPollError(''); setPollRetry(value => value + 1); }}>ตรวจสถานะอีกครั้ง</button></div>}
          <button className="data-text-button" disabled={deleting} onClick={() => void clearDataset()}>ยกเลิกและลบข้อมูล</button>
        </section> : dataset && job ? <DatasetResults key={`${job.id}:${job.analysis?.generated_at || 'preview'}`} id={job.id} dataset={dataset} analysis={job.analysis} onAnalyze={reanalyze} retrying={retrying} /> : !jobError && <div className="data-upload-layout">
          <section className="data-upload-panel" aria-label="อัปโหลดข้อมูล">
            <div className="data-panel-title">
              <div>
                <h2>Upload your data</h2>
                <p className="data-panel-subtitle">Drop your CSV or Excel file here to start analysis</p>
              </div>
              <span className="data-step-badge">01 / UPLOAD</span>
            </div>
            {configError ? <div className="data-inline-error" role="alert"><p>{configError}</p><button className="data-button secondary" onClick={() => { setConfigError(''); void loadConfig(); }}>เชื่อมต่ออีกครั้ง</button></div> :
              <button className={`data-dropzone${dragging ? ' dragging' : ''}`} disabled={!config} onClick={() => input.current?.click()} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (config) selectFiles(event.dataTransfer.files); }}>
                <span className="data-upload-icon"><Upload size={28} strokeWidth={1.7} /></span>
                <strong>Drop your CSV or Excel file here</strong>
                <span>หรือคลิกเพื่อเลือกไฟล์จากคอมพิวเตอร์ของคุณ</span>
                <div className="data-upload-badges">
                  <span className="data-badge">Supported: CSV, XLSX</span>
                  <span className="data-badge">Max size: {config ? sizeLabel(config.max_file_size) : '25 MB'}</span>
                </div>
              </button>}
            <input ref={input} type="file" accept={config?.accepted_extensions.join(',')} aria-label="เลือกไฟล์ข้อมูล" className="data-file-input" tabIndex={-1} onChange={event => { if (event.target.files?.length) selectFiles(event.target.files); event.target.value = ''; }} />
            {file && (
              <div className="data-selected-file">
                <span className="data-file-symbol"><FileSpreadsheet size={24} /></span>
                <div>
                  <strong>{file.name}</strong>
                  <span>{sizeLabel(file.size)} · พร้อมสำหรับการวิเคราะห์ข้อมูล</span>
                </div>
                <button className="data-icon-button" aria-label="นำไฟล์ออก" onClick={() => { setFile(null); setError(''); }}><X size={18} /></button>
              </div>
            )}
            <div className="data-upload-action">
              <p>{file ? 'ระบบจะอ่านข้อมูล ตรวจสอบโครงสร้าง และสังเคราะห์รายงานอัตโนมัติ' : 'รองรับไฟล์ CSV และ XLSX พร้อมวิเคราะห์ทุกชีต'}</p>
              <button className="data-button primary" disabled={!file || !config || deleting} onClick={() => void start()}>
                Analyze Data <ArrowRight size={18} />
              </button>
            </div>
          </section>
          <aside className="data-upload-guide">
            <span className="analyst-eyebrow">AI-POWERED WORKFLOW</span>
            <h2>Upload your Excel file and let AI turn it into a business report</h2>
            <ol>
              <li>
                <span>01</span>
                <div>
                  <strong>Read & Validate Data</strong>
                  <p>ตรวจจับโครงสร้างชีต คอลัมน์ ชนิดข้อมูล ค่าว่าง และแถวซ้ำ</p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <strong>AI Analysis & Insights</strong>
                  <p>คำนวณสถิติจริง และให้ AI สังเคราะห์แนวโน้มพร้อมหลักฐานที่ตรวจสอบได้</p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <strong>Dashboard & Executive Report</strong>
                  <p>สร้าง KPI Cards กราฟที่เหมาะสม และรายงานสรุปสำหรับผู้บริหาร พร้อมส่งออก PDF/Excel</p>
                </div>
              </li>
            </ol>
            {config && <p className="data-limits">หนึ่งตารางต่อชีต หัวคอลัมน์เป็นข้อความครบและไม่ซ้ำ · สูงสุด {config.max_rows.toLocaleString('th-TH')} แถว · {config.max_columns} คอลัมน์ต่อชีต</p>}
          </aside>
        </div>}
      <footer className="analyst-footer"><span><ShieldCheck size={16} />{config ? `ไฟล์เก็บชั่วคราว ${config.retention_minutes} นาที · AI รับสถิติและข้อมูลสรุป ไม่รับไฟล์ต้นฉบับ` : 'ประมวลผลไฟล์บนเซิร์ฟเวอร์ และส่งข้อมูลสรุปให้ AI'}</span><span>AI DATA ANALYST</span></footer>
    </main>
  </div>;
}
