'use client';
import type {Report} from '@/lib/models';
import {AnalysisChart} from './analysis-chart';
import {Table,TableHeader,TableHead,TableBody,TableRow,TableCell} from '@/components/ui/table';
const format=(v:unknown)=>typeof v==='number'?v.toLocaleString('th-TH',{maximumFractionDigits:2}):String(v??'—');
const labels:Record<string,string>={count:'จำนวน',mean:'ค่าเฉลี่ย',median:'มัธยฐาน',min:'ต่ำสุด',max:'สูงสุด',std:'ส่วนเบี่ยงเบนมาตรฐาน',lower:'ขอบเขตล่าง',upper:'ขอบเขตบน',sample_size:'ขนาดตัวอย่าง',excluded:'ไม่รวม',included:'รวม',missing:'ค่าว่าง',duplicates:'แถวซ้ำ',completeness:'ครบถ้วน (%)',missing_months:'เดือนที่ไม่มีข้อมูล'};

export function ReportView({report,filename,notes}:{report:Report;filename:string;notes:string[]}){
 const sections:NonNullable<Report['dynamic_sections']>=report.dynamic_sections??report.analyses.map(a=>({title:a.title,question:'',analysis_ids:[a.evidence_id],narrative:a.narrative}));
 const visibleIds=new Set(sections.flatMap(s=>s.display_analysis_ids??s.analysis_ids));
 const chartIds=new Set(report.analyses.filter(r=>r.chart&&visibleIds.has(r.evidence_id)).slice(0,12).map(r=>r.evidence_id));
 const chartCount=report.analyses.filter(r=>r.chart).length;
 return <article className="report-document" id="report-document">
  <div className="report-brand"><img src="/asw-logo_horizontal.svg" alt="AssetWise"/><span>DATA INSIGHT / ANALYSIS REPORT</span></div>
  <div className="report-title"><p className="eyebrow">BUSINESS DATA ANALYSIS</p><h1>{report.metadata.title}</h1><p>{filename}</p><small>{report.metadata.table} · {report.metadata.source_range}</small></div>
  <div className="report-meta"><span>วันที่ {new Date(report.metadata.generated_at).toLocaleDateString('th-TH')}</span><span>{format(report.dataset_overview.rows_count)} แถว · {format(report.dataset_overview.columns_count)} คอลัมน์{report.dataset_overview.scope==='workbook'?' (นับแยกแต่ละตาราง)':''}</span></div>
  {report.metadata.objective&&<section><h2>วัตถุประสงค์</h2><p>{report.metadata.objective}</p></section>}
  {report.plan?.processing&&<div className="report-note" role="note"><strong>{report.plan.processing.partial?'รายงานนี้มีข้อจำกัดในการประมวลผล':'ขอบเขตการวิเคราะห์'}</strong><p>AI ประมวลผลสำเร็จ {report.plan.processing.completed} / {report.plan.processing.parts} ส่วน · วิเคราะห์เฉพาะตารางที่ตรวจพบและรายการที่เลือก ไม่ใช่การรับรองข้อมูลทั้งไฟล์</p>{report.plan.processing.coverage.filter(c=>c.failed_parts||!c.selected).map(c=><p key={c.table_id}>{c.sheet}!{c.range} · {c.selected?'มีบางส่วนไม่สำเร็จ':'ไม่มีข้อสรุปเชิงวิเคราะห์จากตารางนี้'}</p>)}</div>}
  <section><h2>01 / บทสรุปสำหรับผู้บริหาร</h2><ul>{report.executive_summary.map((s,i)=><li key={i}>{s}</li>)}</ul></section>
  <section><h2>02 / คุณภาพข้อมูลและขอบเขตทุกชีต</h2><div className="report-metrics"><div><strong>{format(report.data_quality.completeness)}%</strong>ความครบถ้วนตามจำนวนเซลล์</div><div><strong>{format(report.data_quality.missing)}</strong>เซลล์ว่าง</div><div><strong>{format(report.data_quality.duplicates)}</strong>แถวซ้ำภายในแต่ละตาราง</div></div>
   {report.dataset_overview.sheets&&<Table className="report-coverage"><TableHeader><TableRow><TableHead>ชีต</TableHead><TableHead>ตาราง</TableHead><TableHead>แถว</TableHead><TableHead>ผลประมวลผล</TableHead></TableRow></TableHeader><TableBody>{report.dataset_overview.sheets.map(s=><TableRow key={s.name}><TableCell>{s.name}{s.state!=='visible'?' (ซ่อนอยู่)':''}</TableCell><TableCell>{s.tables_count}</TableCell><TableCell>{format(s.rows_count)}</TableCell><TableCell>{s.status==='no_table'?s.reason:`สำเร็จ ${format(s.analyses_count)} รายการ${s.errors_count?` · ไม่สำเร็จ ${s.errors_count}`:''}`}</TableCell></TableRow>)}</TableBody></Table>}
   {notes.map((s,i)=><p className="report-note" key={i}>{s}</p>)}
   {report.data_quality.issues.map((issue,i)=><p className="report-note" key={i}>{issue.source&&`${issue.source.sheet}!${issue.source.range} · `}{issue.message}</p>)}
   {!!report.errors?.length&&<><h2>รายการที่คำนวณไม่สำเร็จ</h2>{report.errors.map(e=><p className="report-note" key={e.analysis_id}>{e.source.sheet}!{e.source.range} · {e.title}: {e.message}</p>)}</>}
   {chartCount>12&&<p className="report-note">รายงานแสดงกราฟประกอบสูงสุด 12 กราฟ ข้อมูลคำนวณทั้งหมดอยู่ใน Report JSON</p>}
  </section>
  {sections.map((s,i)=><section key={i} className="report-section"><h2>{String(i+3).padStart(2,'0')} / {s.title}</h2>{s.narrative?.split('\n\n').map((p,j)=><p className="report-fact" key={j}>{p}</p>)}
   {report.analyses.filter(r=>(s.display_analysis_ids??s.analysis_ids).includes(r.evidence_id)).map(r=><div key={r.evidence_id}><p className="report-note">{r.source?.sheet} · {r.source?.source_columns.join(', ')} — {r.finding}</p>
   {r.chart&&chartIds.has(r.evidence_id)&&<AnalysisChart result={r}/>}
   {r.chart&&!chartIds.has(r.evidence_id)&&(r.data.groups||r.data.bins)&&<Table className="report-coverage"><TableHeader><TableRow><TableHead>{r.type==='distribution'?'ช่วงค่า':'กลุ่มข้อมูล'}</TableHead><TableHead>{r.chart.unit}</TableHead><TableHead>จำนวนข้อมูล</TableHead></TableRow></TableHeader><TableBody>{(s.display_analysis_ids?(r.data.groups||r.data.bins).slice(0,20):(r.data.groups||r.data.bins)).map((point:{label:string;value:number;count?:number},index:number)=><TableRow key={index}><TableCell>{point.label}</TableCell><TableCell>{format(point.value)}</TableCell><TableCell>{format(point.count??point.value)}</TableCell></TableRow>)}</TableBody></Table>}
   {s.display_analysis_ids&&(r.data.groups||r.data.bins)?.length>20&&<p className="report-note">ตารางประกอบแสดง 20 กลุ่มแรก รายละเอียดครบอยู่ใน Report JSON</p>}
   <div className="report-values">{Object.entries(r.data).filter(([,v])=>typeof v==='number').map(([k,v])=><div key={k}><span>{labels[k]||k}</span><b>{format(v)}</b></div>)}</div>
   {r.chart?.type==='line'&&!!r.data.missing_months&&<p className="report-note">มีเดือนที่ไม่มีข้อมูล กราฟเชื่อมระหว่างเดือนที่พบเท่านั้น ไม่ได้ประมาณค่าช่วงที่ขาด</p>}
  </div>)}
  </section>)}
  {!!report.plan?.limitations.length&&<div className="report-note" role="note">{report.plan.limitations.map((s,i)=><p key={i}>{s}</p>)}</div>}
  <section><h2>ข้อเสนอแนะ</h2><ul>{report.recommendations.map((r,i)=><li key={i}>{r}</li>)}</ul></section>
  <footer className="report-end">ASSETWISE · DATA INSIGHT <span>รายงานจากข้อมูลที่ผู้ใช้อัปโหลด · ตรวจสอบหลักฐานใน Report JSON</span></footer>
 </article>;
}
