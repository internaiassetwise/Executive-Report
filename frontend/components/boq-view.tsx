'use client';
import {useRef,useState} from 'react';
import {ArrowRight,ArrowLeft,Check,FileSpreadsheet,ShieldCheck,AlertCircle,Download,Database} from 'lucide-react';
import {Table,TableHeader,TableHead,TableBody,TableRow,TableCell} from '@/components/ui/table';
import type {BoqReport} from '@/lib/models';

const num=(n:number|null|undefined,d=0)=>typeof n==='number'?n.toLocaleString('th-TH',{maximumFractionDigits:d}):'—';
const pct=(n:number|null|undefined)=>typeof n==='number'?`${n.toFixed(1)}%`:'—';
const signed=(n:number|null|undefined)=>typeof n==='number'?`${n>0?'+':''}${n.toFixed(1)}%`:'—';
const source:Record<string,string>={inferred:'อ่านจากคอลัมน์ที่ไฟล์ปรับไว้เอง',declared:'กำหนดโดยผู้ใช้',default:'ค่าตั้งต้น ไม่พบคอลัมน์ที่ปรับไว้ในไฟล์'};

// Step 1 for BOQ uploads: what was detected, and the one input the report
// takes from the user — the tolerance. Everything else comes from the files.
export function BoqOverview({report,onBuild,busy}:{report:BoqReport;onBuild:(tolerance:number|null)=>void;busy:boolean}){
 const [tol,setTol]=useState(String(Math.round(report.tolerance*1000)/10));
 const value=Number(tol);
 const valid=tol.trim()!==''&&Number.isFinite(value)&&value>=0&&value<=100;
 const items=report.vendors.reduce((n,v)=>n+v.total.benchmark_items,0);
 return <div className="data-view">
  <div className="dataset-bar"><span className="file-icon"><FileSpreadsheet size={24}/></span><div><h2>BOQ เปรียบเทียบราคากลาง · {report.files.length} ไฟล์</h2><p>{report.files.join(' · ')}</p></div><span className="all-sheets-badge"><Check size={15}/>พบผู้เสนองาน {report.vendors.length} ราย</span></div>
  <div className="metric-grid">{[{label:'ผู้เสนองานที่ตรวจพบ',value:num(report.vendors.length),sub:report.vendors.map(v=>v.vendor).join(', ')},{label:'รายการในราคากลาง',value:num(items),sub:'รวมทุกเจ้า ทุกหมวดงาน'},{label:'ชีตที่ใช้คำนวณ',value:num(report.vendors.reduce((n,v)=>n+v.sheets_used.length,0)),sub:`ตัดชีตสรุปออก ${num(report.vendors.reduce((n,v)=>n+v.sheets_skipped.length,0))} ชีต`},{label:'เกณฑ์ที่ไฟล์ปรับไว้เอง',value:report.tolerance_source==='inferred'?pct(report.tolerance*100):'ไม่พบ',sub:source[report.tolerance_source]}].map(m=><div className="metric-card" key={m.label}><span>{m.label}</span><strong>{m.value}</strong><small>{m.sub}</small></div>)}</div>
  {report.files_skipped.length>0&&<div className="alert warning"><AlertCircle size={20}/><div>{report.files_skipped.map(f=><p key={f.filename}>{f.filename}: {f.reason}</p>)}</div></div>}
  <div className="panel details-panel boq-vendors"><p className="table-caption">ชื่อผู้เสนองาน ราคากลาง และโครงการ อ่านจากหัวคอลัมน์และเซลล์ในไฟล์ · ไม่มีการเติมข้อมูลจากภายนอก</p>
   <Table><TableHeader><TableRow><TableHead>ผู้เสนองาน</TableHead><TableHead>ราคากลาง</TableHead><TableHead>โครงการ (ตามไฟล์)</TableHead><TableHead>ไฟล์</TableHead><TableHead>ชีตที่ใช้</TableHead><TableHead>รายการในราคากลาง</TableHead><TableHead>เกณฑ์ที่ไฟล์ปรับไว้</TableHead></TableRow></TableHeader>
   <TableBody>{report.vendors.map(v=><TableRow key={v.vendor}><TableCell><b>{v.vendor}</b></TableCell><TableCell>{v.benchmark}</TableCell><TableCell>{v.project||'—'}</TableCell><TableCell>{v.filename}</TableCell><TableCell>{num(v.sheets_used.length)}{v.sheets_skipped.length?<small className="cell-samples">ตัดออก {v.sheets_skipped.map(s=>s.sheet).join(', ')}</small>:null}</TableCell><TableCell>{num(v.total.benchmark_items)}</TableCell><TableCell>{v.file_tolerance===null?'ไม่พบ':pct(v.file_tolerance*100)}</TableCell></TableRow>)}</TableBody></Table>
  </div>
  <div className="plan-layout"><section className="panel analysis-planner"><div className="panel-head"><div><h2>รูปแบบรายงาน</h2><p>ตามโครงสร้างรายงานวิเคราะห์ปริมาณและราคาเชิงลึก</p></div></div>
   <ol className="boq-outline">{['บทนำและขอบเขตการวิเคราะห์','ผู้เสนองานแต่ละราย: ตารางที่ 1 ปริมาณงาน · ตารางที่ 2 ราคาต่อหน่วย · ตารางที่ 3 ผลกระทบทางการเงิน · การวิเคราะห์เชิงลึก',report.vendors.length>1?'การวิเคราะห์เปรียบเทียบภาพรวมทุกเจ้า: 3 ตารางเปรียบเทียบ · Signature Pattern · บทวิเคราะห์เชิงกลยุทธ์':'การเปรียบเทียบข้ามเจ้า (แสดงเมื่อมีผู้เสนองานตั้งแต่ 2 รายขึ้นไป)','บทสรุปผู้บริหาร: Grand Total · ข้อสรุป · ผลรวมการประหยัด'].map((s,i)=><li key={i}><span>0{i+1}</span>{s}</li>)}</ol></section>
   <aside className="panel objective-panel"><span className="feature-icon"><ShieldCheck size={21}/></span><h2>เกณฑ์ความผิดปกติ</h2><p>ปริมาณหรือราคาที่สูงกว่าราคากลางเกินเกณฑ์นี้จะถูก Flag และปรับลงมาเท่าราคากลาง (ทิศทางเดียว) ใช้เกณฑ์เดียวกันกับทุกเจ้า</p>
    <label htmlFor="tolerance">เกินราคากลางเกิน (%)</label><input id="tolerance" className="tolerance-input" inputMode="decimal" value={tol} onChange={e=>setTol(e.target.value)} aria-invalid={!valid}/>
    <div className="objective-foot"><ShieldCheck size={15}/>{source[report.tolerance_source]}{report.tolerance_source==='inferred'?` · ${pct(report.tolerance*100)}`:''}</div>
    <button className="primary-button" disabled={!valid||busy} onClick={()=>onBuild(Math.abs(value-report.tolerance*100)<1e-9&&report.tolerance_source!=='declared'?null:value/100)}>สร้างรายงาน <ArrowRight size={17}/></button>
    <small>{num(report.vendors.length)} ผู้เสนองาน · {num(items)} รายการ</small></aside>
  </div>
 </div>;
}

// Step 2 for BOQ uploads: the headline figures behind the printable report.
export function BoqSummary({report,onReport,onBack}:{report:BoqReport;onReport:()=>void;onBack:()=>void}){
 const E=report.executive;
 return <div className="results-view">
  <div className="result-banner"><div><span className="success-label"><Check size={14}/>คำนวณครบทุกเจ้าแล้ว · เกณฑ์ {pct(report.tolerance*100)}</span><h2>ผู้เสนองาน {report.vendors.length} ราย · {report.vendors.map(v=>v.vendor).join(', ')}</h2><p>{E.summary}</p></div><button className="primary-button" onClick={onReport}>ดูรายงาน <ArrowRight size={17}/></button></div>
  <div className="metric-grid boq-cards">{E.rows.map(r=><div className="metric-card" key={r.vendor}><span>{r.vendor}</span><strong>{pct(r.savings_pct)}</strong><small>ประหยัดได้ {num(r.savings)} บาท จาก {num(r.original)}</small></div>)}</div>
  <section className="panel executive-panel"><span className="eyebrow">SIGNATURE PATTERN</span><h2>สรุปแนวโน้มเฉพาะตัวของแต่ละเจ้า</h2>
   <Table><TableHeader><TableRow><TableHead>ผู้เสนองาน</TableHead><TableHead>แนวโน้มเด่น</TableHead><TableHead>หมวดงานที่กระทบมากที่สุด</TableHead><TableHead>ค่าแรง % ต่าง</TableHead><TableHead>ค่าของ % ต่าง</TableHead><TableHead>ปริมาณเกิน</TableHead></TableRow></TableHeader>
   <TableBody>{report.vendors.map(v=>{const s=report.signatures.find(x=>x.vendor===v.vendor);return <TableRow key={v.vendor}><TableCell><b>{v.vendor}</b></TableCell><TableCell>{s?.pattern}</TableCell><TableCell>{s?.top_groups}</TableCell><TableCell>{signed(v.total.labour_dev_pct as number|null)}</TableCell><TableCell>{signed(v.total.material_dev_pct as number|null)}</TableCell><TableCell>{num(v.total.quantity_over as number)} ({pct(v.total.quantity_over_pct as number|null)})</TableCell></TableRow>;})}</TableBody></Table>
  </section>
  {report.strategy.length>0&&<section className="panel executive-panel"><span className="eyebrow">STRATEGY</span><h2>บทวิเคราะห์เชิงกลยุทธ์</h2><ul>{report.strategy.map((s,i)=><li key={i}><span>0{i+1}</span>{s}</li>)}</ul></section>}
  <div className="alert info"><Check size={18}/><span>{E.headline}</span></div>
  <div className="view-actions"><button className="secondary-button" onClick={onBack}><ArrowLeft size={16}/>ปรับเกณฑ์</button><button className="primary-button" onClick={onReport}>สร้างรายงาน <ArrowRight size={17}/></button></div>
 </div>;
}

// Step 3: the report exactly as the engine rendered it, printable to A4.
export function BoqReportFrame({report,html,onNotice}:{report:BoqReport;html:string;onNotice:(m:string)=>void}){
 const frame=useRef<HTMLIFrameElement>(null);
 const [height,setHeight]=useState(1200);
 function fit(){const doc=frame.current?.contentDocument;if(doc?.documentElement)setHeight(Math.max(800,doc.documentElement.scrollHeight+24));}
 function print(){const w=frame.current?.contentWindow;if(!w)return;onNotice('เลือก “บันทึกเป็น PDF” ในหน้าต่างพิมพ์ และใช้กระดาษ A4');w.focus();w.print();}
 function json(){const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='asw-boq-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 return <div className="report-view"><div className="report-toolbar no-print"><div><h2>ตัวอย่างรายงาน</h2><p>ตรวจทานก่อนบันทึก · กระดาษ A4 · {report.vendors.length} ผู้เสนองาน</p></div><div><button className="secondary-button" onClick={json}><Database size={16}/>Report JSON</button><button className="primary-button" onClick={print}><Download size={16}/>บันทึก PDF</button></div></div>
  <iframe ref={frame} className="boq-frame" title="รายงานวิเคราะห์ปริมาณและราคาเชิงลึก" srcDoc={html} style={{height}} onLoad={fit}/>
 </div>;
}
