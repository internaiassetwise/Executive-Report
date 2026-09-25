'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, FileSpreadsheet, Info, LoaderCircle, Plus, ShieldCheck, Upload, X } from 'lucide-react';
import { AccessGate } from '@/components/access-gate';
import { DatasetResults } from '@/components/dataset-results';
import { ACCESS_REQUIRED_EVENT, analyzeDataset, DatasetError, getDatasetConfig, getDatasetJob, removeDataset, uploadDataset, type DatasetConfig, type DatasetJob } from '@/lib/datasets';

const SESSION_KEY = 'ai-data-analyst:dataset';
const processingSteps = [
  { key: 'uploading', th: 'อัปโหลดไฟล์' },
  { key: 'reading', th: 'อ่านข้อมูลทุกชีต' },
  { key: 'understanding_columns', th: 'ตรวจหัวคอลัมน์' },
  { key: 'detecting_types', th: 'ตรวจชนิดข้อมูล' },
  { key: 'patterns', th: 'คำนวณตัวเลขและสถิติ' },
  { key: 'ai', th: 'วางแผนและคำนวณตามโจทย์' },
  { key: 'dashboard', th: 'จัดทำแดชบอร์ด' },
  { key: 'report', th: 'จัดทำรายงาน' },
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
  const [objective, setObjective] = useState('');
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
    if (files.length !== 1) { setError('เลือกครั้งละ 1 ไฟล์ ระบบจะอ่านทุกชีต ทุกหน้า และทุกตารางในไฟล์ให้'); return; }
    const selected = files[0];
    if (!config) { setError('ยังเชื่อมต่อบริการข้อมูลไม่ได้ กรุณาลองอีกครั้ง'); return; }
    const extension = selected.name.slice(selected.name.lastIndexOf('.')).toLowerCase();
    if (!config.accepted_extensions.includes(extension)) { setError(extension === '.doc' ? 'ไฟล์ Word รุ่นเก่า (.doc) กรุณาบันทึกเป็น .docx แล้วอัปโหลดใหม่' : 'ยังไม่รองรับไฟล์ชนิดนี้ รองรับ Excel, CSV, PDF, Word (.docx), รูปภาพ, ODS, HTML, XML และ JSON'); return; }
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
      activeId.current = null; remember(null); setJob(null); setFile(null); setObjective(''); setPollError('');
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
      pendingUpload.current = uploadDataset(file, objective, setUploadPercent, controller.signal);
      const created = await pendingUpload.current;
      // clearDataset owns cancellation cleanup and waits for this same promise.
      if (operation !== activeOperation.current) return;
      activeId.current = created.id; remember(created.id); setJob(created);
    } catch (reason) { if (!controller.signal.aborted && operation === activeOperation.current) setError(message(reason)); }
    finally { pendingUpload.current = null; if (operation === activeOperation.current) setUploading(false); }
  }

  async function reanalyze(requestedObjective: string) {
    if (!job || retrying) return;
    const operation = activeOperation.current;
    setRetrying(true); setError('');
    try {
      const result = await analyzeDataset(job.id, requestedObjective || objective);
      if (operation === activeOperation.current) setJob(result);
    } catch (reason) { if (operation === activeOperation.current) setError(message(reason)); }
    finally { setRetrying(false); }
  }

  const currentStep = getStepIndex(uploading, job?.stage);
  const jobError = job?.status === 'error' ? job.error?.message || 'อ่านข้อมูลไม่สำเร็จ กรุณาตรวจไฟล์แล้วลองอีกครั้ง' : '';
  const progress = uploading ? uploadPercent : Math.min(99, Math.max(0, job?.progress || 0));
  const drop = {
    onDragOver: (event: DragEvent) => { event.preventDefault(); setDragging(true); },
    onDragLeave: (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); },
    onDrop: (event: DragEvent) => { event.preventDefault(); setDragging(false); if (config) selectFiles(event.dataTransfer.files); },
  };

  async function refresh() {
    const current = activeId.current;
    if (!current) return;
    const next = await getDatasetJob(current);
    if (activeId.current === current) setJob(next);
  }

  return <div className="office-app">
    <header className="office-appbar">
      <Link className="office-brand" href="/" aria-label="หน้าหลัก"><span className="asw-original-logo" aria-hidden="true" /><strong>Dashboard จากข้อมูล</strong></Link>
      {(dataset || processing || jobError) && <button className="office-button" disabled={deleting} onClick={() => void clearDataset()}><Plus size={16} />{deleting ? 'กำลังล้างข้อมูล…' : 'ไฟล์ใหม่'}</button>}
    </header>
    <main className={`office-main${dataset ? ' wide' : ''}`}>
      {!locked && (error || jobError) && <div className="data-error" role="alert"><Info size={20} /><div><strong>{jobError ? (job?.dataset ? 'วิเคราะห์ไม่สำเร็จ' : 'อ่านไฟล์ไม่สำเร็จ') : 'ยังดำเนินการไม่ได้'}</strong><p>{error || jobError}</p><div className="data-error-actions">{(file || job?.dataset) && <button className="office-button" disabled={processing || deleting || retrying} onClick={() => { if (job?.dataset) void reanalyze(''); else void start(); }}>ลองอีกครั้ง</button>}{jobError && <button className="data-text-button" disabled={deleting} onClick={() => void clearDataset()}>เลือกไฟล์อื่น</button>}</div></div></div>}

      {locked ? <AccessGate onUnlocked={unlocked} /> : restoring ? <output className="data-loading"><LoaderCircle size={24} className="data-spin" />กำลังเปิดข้อมูล…</output> : processing ?
        <section className="progress-card" aria-label="สถานะการประมวลผล">
          <div className="progress-head">
            <FileSpreadsheet size={20} aria-hidden="true" />
            <div><h2>{file?.name || 'ไฟล์ที่อัปโหลด'}</h2><p>{processingSteps[Math.min(currentStep, processingSteps.length - 1)].th}…</p></div>
            <strong>{progress}%</strong>
          </div>
          <progress className="office-progress" aria-label="ความคืบหน้า" max={100} value={progress}>{progress}%</progress>
          <ol className="progress-steps">
            {processingSteps.map((step, index) => <li key={step.key} className={currentStep === index ? 'active' : currentStep > index ? 'done' : ''}>
              <span aria-hidden="true">{currentStep > index ? <Check size={12} /> : currentStep === index ? <LoaderCircle size={12} className="data-spin" /> : null}</span>{step.th}
            </li>)}
          </ol>
          {objective.trim() && <p className="progress-objective"><span>โจทย์</span>{objective.trim()}</p>}
          {pollError && <div className="data-inline-error" role="alert"><p>{pollError}</p><button className="office-button" onClick={() => { setPollError(''); setPollRetry(value => value + 1); }}>ตรวจสถานะอีกครั้ง</button></div>}
          <button className="data-text-button" disabled={deleting} onClick={() => void clearDataset()}>ยกเลิก</button>
        </section> : dataset && job ? <DatasetResults key={`${job.id}:${job.analysis?.generated_at || 'preview'}`} id={job.id} dataset={dataset} analysis={job.analysis} boq={job.boq} document={job.document} conversation={job.conversation} aiReady={Boolean(config?.ai?.configured)} onAnalyze={reanalyze} onRefresh={refresh} retrying={retrying} /> : !jobError && <section className="start">
          <div className="start-intro">
            <h1>อัปโหลดไฟล์ แล้วบอกว่าอยากรู้อะไร</h1>
            <p>รองรับ Excel, CSV, PDF, Word และรูปภาพตาราง ระบบคำนวณจากทุกแถว แล้วสร้างแดชบอร์ดกับรายงานให้ ถ้าไม่พิมพ์โจทย์ ระบบจะสรุปภาพรวมให้เอง</p>
          </div>
          {configError ? <div className="data-inline-error" role="alert"><p>{configError}</p><button className="office-button" onClick={() => { setConfigError(''); void loadConfig(); }}>เชื่อมต่ออีกครั้ง</button></div> :
          <div className={`composer${dragging ? ' dragging' : ''}`} {...drop}>
            {file ? <div className="composer-file">
              <FileSpreadsheet size={22} aria-hidden="true" />
              <div><strong>{file.name}</strong><span>{sizeLabel(file.size)}</span></div>
              <button className="data-icon-button" aria-label="นำไฟล์ออก" onClick={() => { setFile(null); setError(''); }}><X size={18} /></button>
            </div> : <button className="composer-drop" disabled={!config} onClick={() => input.current?.click()}>
              <Upload size={22} strokeWidth={1.8} aria-hidden="true" />
              <span><strong>เลือกไฟล์</strong> หรือลากไฟล์มาวางที่นี่</span>
              <small>Excel, CSV, PDF, Word, รูปภาพ · ไม่เกิน {config ? sizeLabel(config.max_file_size) : '25 MB'}</small>
            </button>}
            <input ref={input} type="file" accept={config?.accepted_extensions.join(',')} aria-label="เลือกไฟล์ข้อมูล" className="data-file-input" tabIndex={-1} onChange={event => { if (event.target.files?.length) selectFiles(event.target.files); event.target.value = ''; }} />
            <textarea id="analysis-objective" className="composer-input" value={objective} maxLength={1000} rows={3} onChange={event => setObjective(event.target.value)} aria-label="โจทย์การวิเคราะห์ (ไม่บังคับ)" placeholder="อยากรู้อะไรจากไฟล์นี้ (ไม่บังคับ) เช่น โครงการไหนใช้งบเกินแผนมากที่สุด" />
            <div className="composer-foot">
              <span>{objective.length ? `${objective.length.toLocaleString('th-TH')}/1,000` : ''}</span>
              <button className="office-button primary large" disabled={!file || !config || deleting} onClick={() => void start()}>สร้าง Dashboard และรายงาน <ArrowRight size={17} /></button>
            </div>
          </div>}
          <footer className="office-footer"><ShieldCheck size={15} aria-hidden="true" />{config ? `ไฟล์เก็บไว้ชั่วคราว ${config.retention_minutes} นาทีแล้วลบอัตโนมัติ · ส่งเพียงแถวแรกของแต่ละชีตให้ AI อ่านโครงสร้าง` : 'ไฟล์ประมวลผลบนเซิร์ฟเวอร์ของระบบ'}</footer>
        </section>}
    </main>
  </div>;
}
