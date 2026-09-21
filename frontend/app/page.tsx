'use client';
import {useState,useEffect,useRef} from 'react';
import {ArrowRight,FileSpreadsheet,FileText,ShieldCheck,Upload,Check,AlertCircle,Download,LoaderCircle,RotateCcw,Database,Info,X} from 'lucide-react';
import {ReportView} from '@/components/report-view';
import {BoqReportFrame} from '@/components/boq-view';
import {WorkbookOverview} from '@/components/workbook-overview';
import {writeNarrative} from '@/lib/report-writer';
import {planAndCalculate} from '@/lib/planned-analysis';
import {clearAIJobs} from '@/lib/ai-jobs';
import {runAnalysis,cancelAnalysis} from '@/lib/analysis-client';
import type {WorkbookProfile,Report,BoqReport,BoqResult} from '@/lib/models';

const steps=['อัปโหลดข้อมูล','ประมวลผลและวิเคราะห์','รายงาน'];
function download(value:unknown,name:string){const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

export default function Home(){
 const [step,setStep]=useState(0),[book,setBook]=useState<WorkbookProfile|null>(null),[selected,setSelected]=useState<string[]>([]),[report,setReport]=useState<Report|null>(null),[boq,setBoq]=useState<{report:BoqReport;html:string}|null>(null),[flowKind,setFlowKind]=useState<'generic'|'boq'|null>(null),[objective,setObjective]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(''),[error,setError]=useState(''),[drag,setDrag]=useState(false),[isDemo,setIsDemo]=useState(false),[notice,setNotice]=useState('');
 const [pendingFiles,setPendingFiles]=useState<File[]>([]);
 const [phase,setPhase]=useState(0);
 const heading=useRef<HTMLHeadingElement|null>(null);
 useEffect(()=>{heading.current?.focus();},[step]);
 const [files,setFiles]=useState<string[]>([]);
 const operation=useRef(0);
 const writing=useRef<AbortController|null>(null);
 const calculated=useRef<{report:Report}|null>(null);
 const calculatedBoq=useRef<{report:BoqReport}|null>(null);

 const actions=useRef<{getState:()=>unknown;sample:()=>Promise<unknown>}>({getState:()=>({}),sample:async()=>({})});
 function updateProgress(message:string,value:number){setLoading(message);if(value>=65)setPhase(previous=>previous===0?1:previous);}
 async function processFiles(input:File|File[],demo=false){
  if(busy)return;
  const list=Array.isArray(input)?input:[input];
  setError('');setNotice('');
  if(!list.length)return;
  for(const file of list){
   if(!/\.(xlsx|xls|csv)$/i.test(file.name)){setError(`${file.name}: รองรับไฟล์ .xlsx, .xls และ .csv เท่านั้น`);return;}
   if(file.size>15*1024*1024){setError(`${file.name}: ไฟล์ใหญ่กว่า 15 MB กรุณาแบ่งไฟล์ก่อนอัปโหลด`);return;}
  }
  const current=++operation.current;
  calculated.current=null;calculatedBoq.current=null;
  setBusy(true);setLoading(list.length>1?`กำลังอ่าน ${list.length} ไฟล์…`:'กำลังอ่านไฟล์…');setBook(null);setReport(null);setBoq(null);setFlowKind(null);setFiles(list.map(f=>f.name));setPhase(0);setStep(1);setIsDemo(demo);
  try{
   const payload=await Promise.all(list.map(async f=>({filename:f.name,bytes:await f.arrayBuffer()})));
   if(current!==operation.current)return;
   const result=await runAnalysis<BoqResult>('boq',{files:payload},updateProgress);
   if(current!==operation.current)return;
   if(result.mode==='boq'){
    setFlowKind('boq');calculatedBoq.current={report:result.report};await finishBoq(result.report,current);return {mode:'boq',vendors:result.report.vendors.length};
   }
   if(result.mode==='generic'){
    setFlowKind('generic');setBook(result.book);setSelected(result.book.opportunities.map(p=>p.type));await finishGeneric(result.book,current);return {mode:'generic',tables:result.book.tables_count,rows:result.book.rows_count};
   }
   throw new Error('ไม่พบโครงสร้างข้อมูลที่รองรับในไฟล์ที่อัปโหลด');
  }
  catch(e){if(current!==operation.current)return;setError(e instanceof Error?e.message:'อ่านไฟล์ไม่สำเร็จ');setStep(calculated.current||calculatedBoq.current?1:0);}
  finally{if(current===operation.current)setBusy(false);}
 }
 function upload(input:File|File[],demo=false){
  const list=Array.isArray(input)?input:[input];if(busy||!list.length)return;
  const invalid=list.find(f=>! /\.(xlsx|xls|csv)$/i.test(f.name)||f.size>15*1024*1024);
  if(invalid){setError(`${invalid.name}: รองรับ Excel/CSV ขนาดไม่เกิน 15 MB ต่อไฟล์`);return;}
  clearAIJobs();setPendingFiles(list);setIsDemo(demo);setError('');setNotice('');
 }
 async function sample(){const response=await fetch('/sample-data.csv');if(!response.ok)throw new Error('เปิดข้อมูลตัวอย่างไม่สำเร็จ');return upload(new File([await response.text()],'sample-data.csv',{type:'text/csv'}),true);}
 async function analyze(){if(!book||busy)return;calculated.current=null;const current=++operation.current;setBusy(true);setStep(1);setPhase(1);setError('');setNotice('');setLoading('กำลังเตรียมการวิเคราะห์…');try{await finishGeneric(book,current,selected);}catch(e){if(current===operation.current){setError(e instanceof Error?e.message:'วิเคราะห์ไม่สำเร็จ');setStep(1);}}finally{if(current===operation.current)setBusy(false);}}
 function reset(){clearAIJobs();calculated.current=null;calculatedBoq.current=null;operation.current++;writing.current?.abort();cancelAnalysis();setBusy(false);setStep(0);setBook(null);setSelected([]);setReport(null);setBoq(null);setFlowKind(null);setFiles([]);setObjective('');setError('');setNotice('');setIsDemo(false);setPendingFiles([]);}
 async function compose(r:Report):Promise<Report>{
  setPhase(2);setLoading('กำลังเรียบเรียงรายงาน…');writing.current?.abort();const controller=new AbortController();writing.current=controller;
  return await writeNarrative(r,objective,controller.signal,updateProgress);
 }
 async function finishGeneric(profile:WorkbookProfile,current:number,types=profile.opportunities.map(p=>p.type)){
  setPhase(1);
  setLoading('AI กำลังทำความเข้าใจข้อมูลและเลือกประเด็นวิเคราะห์…');
  writing.current?.abort();const controller=new AbortController();writing.current=controller;
  const computed=await planAndCalculate(profile,objective,controller.signal,
   selected_plans=>runAnalysis<Report>('analyze_workbook',{selected_plans,objective},updateProgress),types,updateProgress);
  if(current!==operation.current)return;calculated.current={report:computed};const r=await compose(computed);
  if(current!==operation.current)return;setReport(r);setStep(2);
 }
 async function finishBoq(base:BoqReport,current:number){
  setPhase(2);setLoading('AI กำลังเรียบเรียงบทวิเคราะห์ BOQ…');
  writing.current?.abort();const controller=new AbortController();writing.current=controller;
  const written=await writeNarrative(base,objective,controller.signal,updateProgress);
  if(current!==operation.current)return;calculatedBoq.current={report:written};setLoading('กำลังจัดหน้ารายงาน BOQ…');
  const html=await runAnalysis<string>('boq_render',{report:written},updateProgress);
  if(current!==operation.current)return;setBoq({report:written,html});setStep(2);
 }
 async function retryWriting(){
  const saved=calculated.current,savedBoq=calculatedBoq.current;if((!saved&&!book&&!savedBoq)||busy)return;const current=++operation.current;
  setBusy(true);setError('');setStep(1);
  try{
   if(savedBoq)await finishBoq(savedBoq.report,current);
   else if((!saved||saved.report.plan?.processing?.partial)&&book)await finishGeneric(book,current,selected);
   else if(saved){const r=await compose(saved.report);if(current===operation.current){setReport(r);setStep(2);}}
  }catch(e){if(current===operation.current)setError(e instanceof Error?e.message:'เขียนรายงานไม่สำเร็จ');}
  finally{if(current===operation.current)setBusy(false);}
 }
 async function print(){setNotice('เลือก “บันทึกเป็น PDF” ในหน้าต่างพิมพ์ และใช้กระดาษ A4');await document.fonts.ready;window.print();}
 useEffect(()=>()=>{writing.current?.abort();cancelAnalysis();},[]);
 actions.current={getState:()=>({step:steps[step],mode:flowKind,filename:book?.filename||null,files,tables:book?.tables.map(t=>({id:t.id,name:t.name,rows:t.rows_count})),selected,report:report?{findings:report.executive_summary,evidence:report.evidence}:boq?{vendors:boq.report.vendors.map(v=>v.vendor),executive:boq.report.executive}:null,busy}),sample};
 useEffect(()=>{const context=(document as any).modelContext;if(!context?.registerTool)return;const lifecycle=new AbortController();const tools=[{name:'read_analysis_workspace',title:'Read analysis workspace',description:'Read current dataset, selected analyses and calculated findings.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:(input:unknown)=>{if(!input||typeof input!=='object'||Object.keys(input).length)throw new Error('Expected empty object');return actions.current.getState();}},{name:'load_sample_dataset',title:'Load sample dataset',description:'Replace the current local dataset with synthetic demonstration data and inspect it.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute:async(input:unknown)=>{if(!input||typeof input!=='object'||Object.keys(input).length)throw new Error('Expected empty object');return actions.current.sample();}}];for(const tool of tools){try{Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}}return()=>lifecycle.abort();},[]);
 const uploadSafe=(input:File|File[])=>upload(input);

 return <div className="app-shell flow-shell"><aside className="side no-print"><a href="/" className="brand" aria-label="AssetWise Data Insight"><img src="/asw-logo_horizontal.svg" alt="AssetWise"/></a></aside>
 <div className="workspace"><header className="topbar no-print"><span>ASW DATA INSIGHT</span><span>สร้างรายงานจากข้อมูลของคุณ</span></header>
 <main className="main"><div className="heading no-print"><div><p className="eyebrow">DATA TO DECISIONS</p><h1 ref={heading} tabIndex={-1}>{['เปลี่ยนข้อมูลเป็นรายงานใน 3 ขั้นตอน',busy?'กำลังวิเคราะห์ข้อมูลของคุณ':'ยังสร้างรายงานไม่สำเร็จ',report?.plan?.processing?.partial?'รายงานพร้อมแล้ว · มีข้อจำกัดบางส่วน':'รายงานของคุณพร้อมแล้ว'][step]}</h1><p className="subtitle">{['เลือกไฟล์ ระบุสิ่งที่อยากรู้ แล้วให้ระบบจัดทำรายงานให้','ระบบกำลังอ่านข้อมูล คำนวณ และเรียบเรียงรายงาน','ตรวจทานผลวิเคราะห์ แล้วบันทึกหรือส่งต่อรายงาน'][step]}</p></div>{step===2&&<button className="secondary-button" onClick={reset}><RotateCcw size={16} aria-hidden="true"/>เริ่มรายงานใหม่</button>}</div>
 <ol className="flow-steps no-print" aria-label="ขั้นตอนการสร้างรายงาน">{steps.map((label,i)=><li key={label} className={step===i?'active':step>i?'complete':''} aria-current={step===i?'step':undefined}><span>{step>i?<Check size={18} aria-hidden="true"/>:i+1}</span><div><b>{label}</b><small>{['เลือกไฟล์และเป้าหมาย','ตรวจข้อมูลและเขียนบทวิเคราะห์','ตรวจทานและดาวน์โหลด'][i]}</small></div></li>)}</ol>
 {error&&<div role="alert" className="alert error no-print"><AlertCircle size={20} aria-hidden="true"/><span>{error}</span></div>}
 {notice&&<div role="status" className="alert info no-print"><Info size={20} aria-hidden="true"/><span>{notice}</span></div>}
 {step===0&&<section className="panel flow-upload">
  <div className="flow-upload-head"><span className="feature-icon"><Upload size={22} aria-hidden="true"/></span><div><h2>อัปโหลดข้อมูล</h2><p>รองรับ .xlsx, .xls และ .csv สูงสุด 15 MB ต่อไฟล์</p></div></div>
  <label className={'dropzone flow-dropzone '+(drag?'dragging':'')} onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);uploadSafe(Array.from(e.dataTransfer.files));}}>
   <input type="file" multiple accept=".xlsx,.xls,.csv" aria-label="เลือกไฟล์ข้อมูล" onChange={e=>{uploadSafe(Array.from(e.target.files??[]));e.target.value='';}}/>
   <span className="upload-symbol"><FileSpreadsheet size={30} aria-hidden="true"/></span><h3>{pendingFiles.length?'เลือกไฟล์ใหม่เพื่อเปลี่ยนชุดข้อมูล':'ลากไฟล์มาวางที่นี่'}</h3><p>หรือคลิกเพื่อเลือกไฟล์จากอุปกรณ์</p><span className="secondary-button">เลือกไฟล์</span><small>BOQ และข้อมูลทั่วไปใช้ขั้นตอนเดียวกัน · เลือกหลายไฟล์ได้</small>
  </label>
  {pendingFiles.length>0&&<ul className="flow-files" aria-label="ไฟล์ที่เลือก">{pendingFiles.map((f,i)=><li key={f.name+i}><FileSpreadsheet size={20} aria-hidden="true"/><div><b>{f.name}</b><small>{(f.size/1024).toLocaleString('th-TH',{maximumFractionDigits:1})} KB{isDemo?' · ข้อมูลสมมติสำหรับทดลอง':''}</small></div><button type="button" onClick={()=>setPendingFiles(p=>p.filter((_,j)=>j!==i))} aria-label={'นำไฟล์ '+f.name+' ออก'}><X size={18} aria-hidden="true"/></button></li>)}</ul>}
  <div className="flow-objective"><label htmlFor="report-objective">อยากให้รายงานเน้นเรื่องอะไร? <span>ไม่บังคับ</span></label><textarea id="report-objective" rows={3} maxLength={1000} value={objective} onChange={e=>setObjective(e.target.value)} placeholder="เช่น สรุปต้นทุน แนวโน้ม และรายการที่ควรตรวจสอบ"/><p>เว้นว่างได้ ระบบจะสรุปประเด็นสำคัญจากข้อมูลที่พบ</p></div>
  <div className="flow-privacy"><ShieldCheck size={18} aria-hidden="true"/><p>คำนวณไฟล์บนอุปกรณ์ ข้อมูลทั่วไปจะส่งชื่อคอลัมน์ ตัวอย่างบางแถว และสถิติให้ Gemini วางแผน ส่วน BOQ ส่งเฉพาะผลคำนวณเพื่อเขียนบทวิเคราะห์ โปรดหลีกเลี่ยงข้อมูลส่วนบุคคลหรือข้อมูลลับ</p></div>
  <div className="flow-upload-actions"><button className="text-button" onClick={()=>void sample().catch(e=>setError(e.message))}>ลองใช้ข้อมูลตัวอย่าง</button><button className="primary-button" disabled={!pendingFiles.length} onClick={()=>void processFiles(pendingFiles,isDemo)}>เริ่มวิเคราะห์ข้อมูล <ArrowRight size={18} aria-hidden="true"/></button></div>
 </section>}
 {step===1&&busy&&<section className="panel flow-processing" aria-busy="true">
  <div className="flow-processing-icon"><LoaderCircle className="spin" size={32} aria-hidden="true"/></div><h2>กำลังประมวลผลและวิเคราะห์</h2><p className="flow-filenames">{files.join(' · ')}</p>
  <div role="status" aria-live="polite" aria-atomic="true" className="flow-status">{loading}</div>
  <ol className="flow-tasks">{['อ่านไฟล์และตรวจโครงสร้างข้อมูล',flowKind==='boq'?'คำนวณเปรียบเทียบราคากลางและราคาเสนอ':'AI ทำความเข้าใจ วางแผน และสั่งคำนวณ',flowKind==='boq'?'AI เรียบเรียงบทวิเคราะห์ BOQ และจัดหน้ารายงาน':'เรียบเรียงบทวิเคราะห์และสร้างรายงาน'].map((label,i)=><li key={label} className={phase===i?'active':phase>i?'complete':''}><span>{phase>i?<Check size={18} aria-hidden="true"/>:phase===i?<LoaderCircle className="spin" size={18} aria-hidden="true"/>:i+1}</span><b>{label}</b><small>{phase>i?'เสร็จแล้ว':phase===i?'กำลังดำเนินการ':'รอดำเนินการ'}</small></li>)}</ol>
  <p>โปรดเปิดหน้านี้ไว้ ระบบจะพาไปยังรายงานเมื่อเสร็จ<br/>ระยะเวลาขึ้นอยู่กับขนาดข้อมูลและการตอบกลับของ AI</p><button className="secondary-button" onClick={()=>{operation.current++;writing.current?.abort();cancelAnalysis();setBusy(false);setBook(null);setReport(null);setBoq(null);setFlowKind(null);setNotice('');setStep(0);}}>ยกเลิกและกลับไปเลือกไฟล์</button>
 </section>}
 {step===1&&!busy&&<section className="panel flow-processing"><AlertCircle size={32} aria-hidden="true"/><h2>AI ยังสร้างรายงานไม่สำเร็จ</h2><p>ข้อมูลยังอยู่ในหน้านี้ สามารถลองใหม่ได้โดยไม่ต้องอัปโหลดอีกครั้ง<br/>รายงานจะเปิดให้ดาวน์โหลดเมื่อ Gemini เขียนครบและผ่านการตรวจสอบแล้ว</p><div className="flow-upload-actions"><button className="secondary-button" onClick={reset}>เลือกข้อมูลใหม่</button><button className="primary-button" onClick={()=>void retryWriting()} disabled={!calculated.current&&!calculatedBoq.current&&!book}>ลองให้ AI เขียนอีกครั้ง</button></div></section>}
 {step===2&&!busy&&<>
  {report?.plan?.processing?.partial&&<button className="secondary-button no-print" onClick={()=>void retryWriting()}>ลองประมวลผลส่วนที่ไม่สำเร็จอีกครั้ง</button>}
  {report&&<div className="flow-report-status no-print"><FileText size={20} aria-hidden="true"/><div><b>{(report.plan?.processing?.partial?'รายงานบางส่วน · ':'เขียนด้วย AI สำเร็จ · ')+(report.writer?.model||'Gemini')}</b><p>{files.join(' · ')} · เขียนเมื่อ {new Date(report.writer?.generated_at||'').toLocaleString('th-TH')}</p></div></div>}
  {boq&&<div className="flow-report-status no-print"><FileText size={20} aria-hidden="true"/><div><b>รายงาน BOQ รูปแบบเดิม · เขียนด้วย AI สำเร็จ · {boq.report.writer?.model||'Gemini'}</b><p>{files.join(' · ')} · เกณฑ์ความผิดปกติ {(boq.report.tolerance*100).toLocaleString('th-TH',{maximumFractionDigits:2})}% · เขียนเมื่อ {new Date(boq.report.writer?.generated_at||'').toLocaleString('th-TH')}</p></div></div>}
  {boq&&<BoqReportFrame report={boq.report} html={boq.html} onNotice={setNotice}/>}
  {report&&book&&<><div className="report-view"><div className="report-toolbar no-print"><div><h2>ตัวอย่างรายงาน</h2><p>รูปแบบ A4 · ตรวจทานก่อนส่งต่อ</p></div><div><button className="secondary-button" onClick={()=>void analyze()}>เขียนรายงานใหม่</button><button className="secondary-button" onClick={()=>download(report,'asw-analysis-report.json')}><Database size={16} aria-hidden="true"/>Report JSON</button><button className="primary-button" onClick={print}><Download size={16} aria-hidden="true"/>บันทึก PDF</button></div></div><ReportView report={report} filename={book.filename} notes={book.notes}/></div><details className="flow-adjust no-print"><summary>ดูข้อมูลและปรับการวิเคราะห์</summary><WorkbookOverview book={book} selected={selected} onSelected={setSelected} objective={objective} onObjective={setObjective} onAnalyze={analyze}/></details></>}
 </>}
 <footer className="main-footer no-print"><span>ASSETWISE · DATA INSIGHT</span><span>ข้อมูลของคุณ สู่รายงานที่พร้อมตัดสินใจ</span></footer>
 </main></div></div>;
}
