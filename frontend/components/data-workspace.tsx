'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
  { key: 'ai', th: 'สรุปผลการวิเคราะห์' },
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

  const stage = dataset ? 3 : uploading ? 0 : ['dashboard', 'report'].includes(job?.stage || '') ? 3 : ['profiling', 'patterns', 'ai'].includes(job?.stage || '') ? 2 : processing || jobError ? 1 : 0;

  return <div className="office-app">
    <header className="office-appbar">
      <Link className="office-brand" href="/" aria-label="หน้าหลัก"><span className="asw-original-logo" aria-hidden="true" /><strong>ระบบสร้าง Dashboard จากข้อมูล</strong></Link>
      {(dataset || processing || jobError) && <button className="office-button" disabled={deleting} onClick={() => void clearDataset()}><Plus size={16} />{deleting ? 'กำลังล้างข้อมูล…' : 'อัปโหลดไฟล์ใหม่'}</button>}
    </header>
    <main className="office-main">
      <div className="office-pagehead">
        <h1>{dataset ? dataset.filename : processing ? 'กำลังเตรียม Dashboard' : 'สร้าง Dashboard จากไฟล์ Excel'}</h1>
        <p>{dataset ? 'ดูแดชบอร์ด รายงาน และข้อมูลต้นฉบับได้จากแท็บด้านล่าง' : processing ? 'ระบบกำลังอ่านไฟล์และคำนวณ ใช้เวลาไม่กี่วินาทีถึงหนึ่งนาที' : 'อัปโหลดไฟล์ แล้วระบบจะสร้างแดชบอร์ดและรายงานให้อัตโนมัติ'}</p>
      </div>
      <ol className="office-stepper" aria-label="ขั้นตอนการทำงาน">
        {['อัปโหลดไฟล์', 'ตรวจสอบข้อมูล', 'คำนวณและสรุปผล', 'ดูผลลัพธ์'].map((label, index) =>
          <li key={label} className={index === stage ? 'active' : index < stage ? 'done' : ''} aria-current={index === stage ? 'step' : undefined}><span>{index < stage ? <Check size={13} /> : index + 1}</span>{label}</li>)}
      </ol>

      {!locked && (error || jobError) && <div className="data-error" role="alert"><Info size={20} /><div><strong>{jobError ? (job?.dataset ? 'วิเคราะห์ไม่สำเร็จ' : 'อ่านไฟล์ไม่สำเร็จ') : 'ยังดำเนินการไม่ได้'}</strong><p>{error || jobError}</p><div className="data-error-actions">{(file || job?.dataset) && <button className="office-button" disabled={processing || deleting || retrying} onClick={() => { if (job?.dataset) void reanalyze(''); else void start(); }}>ลองอีกครั้ง</button>}{jobError && <button className="data-text-button" disabled={deleting} onClick={() => void clearDataset()}>เลือกไฟล์อื่น</button>}</div></div></div>}

      {locked ? <AccessGate onUnlocked={unlocked} /> : restoring ? <output className="data-loading"><LoaderCircle size={24} className="data-spin" />กำลังเปิดข้อมูล…</output> : processing ?
        <section className="office-card office-processing" aria-label="สถานะการประมวลผล">
          <div className="office-processing-head">
            <FileSpreadsheet size={22} aria-hidden="true" />
            <div><h2>{file?.name || 'ไฟล์ที่อัปโหลด'}</h2><p>{file ? sizeLabel(file.size) : ''}</p></div>
            <strong>{progress}%</strong>
          </div>
          <progress className="office-progress" aria-label="ความคืบหน้า" max={100} value={progress}>{progress}%</progress>
          <ul className="office-checklist">
            {processingSteps.map((step, index) => <li key={step.key} className={currentStep === index ? 'active' : currentStep > index ? 'done' : ''}>
              <span aria-hidden="true">{currentStep > index ? <Check size={14} /> : currentStep === index ? <LoaderCircle size={14} className="data-spin" /> : null}</span>{step.th}
            </li>)}
          </ul>
          {pollError && <div className="data-inline-error" role="alert"><p>{pollError}</p><button className="office-button" onClick={() => { setPollError(''); setPollRetry(value => value + 1); }}>ตรวจสถานะอีกครั้ง</button></div>}
          <button className="data-text-button" disabled={deleting} onClick={() => void clearDataset()}>ยกเลิก</button>
        </section> : dataset && job ? <DatasetResults key={`${job.id}:${job.analysis?.generated_at || 'preview'}`} id={job.id} dataset={dataset} analysis={job.analysis} boq={job.boq} document={job.document} onAnalyze={reanalyze} retrying={retrying} /> : !jobError && <div className="office-upload">
          <section className="office-card" aria-label="อัปโหลดไฟล์">
            <h2>1. เลือกไฟล์ข้อมูล</h2>
            {configError ? <div className="data-inline-error" role="alert"><p>{configError}</p><button className="office-button" onClick={() => { setConfigError(''); void loadConfig(); }}>เชื่อมต่ออีกครั้ง</button></div> :
              <button className={`office-dropzone${dragging ? ' dragging' : ''}`} disabled={!config} onClick={() => input.current?.click()} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (config) selectFiles(event.dataTransfer.files); }}>
                <Upload size={30} strokeWidth={1.6} aria-hidden="true" />
                <strong>ลากไฟล์มาวางที่นี่ หรือคลิกเพื่อเลือกไฟล์</strong>
                <span>รองรับ Excel (.xlsx, .xls) และ CSV ขนาดไม่เกิน {config ? sizeLabel(config.max_file_size) : '25 MB'}</span>
              </button>}
            <input ref={input} type="file" accept={config?.accepted_extensions.join(',')} aria-label="เลือกไฟล์ข้อมูล" className="data-file-input" tabIndex={-1} onChange={event => { if (event.target.files?.length) selectFiles(event.target.files); event.target.value = ''; }} />
            {file && <div className="office-file">
              <FileSpreadsheet size={22} aria-hidden="true" />
              <div><strong>{file.name}</strong><span>{sizeLabel(file.size)}</span></div>
              <button className="data-icon-button" aria-label="นำไฟล์ออก" onClick={() => { setFile(null); setError(''); }}><X size={18} /></button>
            </div>}
            <div className="office-objective">
              <label htmlFor="analysis-objective">อยากให้วิเคราะห์เรื่องอะไร <span>(ไม่บังคับ)</span></label>
              <textarea id="analysis-objective" value={objective} maxLength={1000} rows={3} onChange={event => setObjective(event.target.value)} aria-describedby="analysis-objective-hint" placeholder="เช่น รายการ BOQ ที่ต่อรองได้สูงสุด หรือค่าใช้จ่ายที่สูงผิดปกติ" />
              <p id="analysis-objective-hint">ใช้เป็นโจทย์สำหรับบทวิเคราะห์เมื่อเปิดใช้ AI · {objective.length}/1,000 ตัวอักษร</p>
            </div>
            <div className="office-actions">
              <button className="office-button primary large" disabled={!file || !config || deleting} onClick={() => void start()}>2. สร้าง Dashboard <ArrowRight size={17} /></button>
            </div>
          </section>
          <aside className="office-card office-help">
            <h2>ระบบจะทำอะไรให้</h2>
            <ol>
              <li><strong>อ่านทุกชีตในไฟล์</strong><span>ตรวจหัวคอลัมน์ ชนิดข้อมูล ช่องว่าง และแถวซ้ำ</span></li>
              <li><strong>คำนวณตัวเลขจากทุกแถว</strong><span>ไม่นับแถวยอดรวม/VAT ซ้ำ และใช้ค่าที่ Excel คำนวณไว้</span></li>
              <li><strong>สร้างแดชบอร์ดและรายงาน</strong><span>กรองข้อมูล คลิกกราฟเพื่อดูรายละเอียด และดาวน์โหลด PDF/Excel/HTML</span></li>
            </ol>
            <p className="office-muted">เคล็ดลับ: แถวแรกของแต่ละชีตควรเป็นหัวคอลัมน์ และหนึ่งชีตควรมีตารางเดียว{config ? ` · สูงสุด ${config.max_rows.toLocaleString('th-TH')} แถว` : ''}</p>
          </aside>
        </div>}
      <footer className="office-footer"><ShieldCheck size={15} aria-hidden="true" />{config ? `ไฟล์เก็บไว้ชั่วคราว ${config.retention_minutes} นาที แล้วลบอัตโนมัติ · ตัวเลขทุกค่าคำนวณในระบบ ส่งเพียงแถวแรกของแต่ละชีตและรูปภาพในไฟล์ให้ระบบอ่านโครงสร้าง` : 'ไฟล์ประมวลผลบนเซิร์ฟเวอร์ของระบบ'}</footer>
    </main>
  </div>;
}
