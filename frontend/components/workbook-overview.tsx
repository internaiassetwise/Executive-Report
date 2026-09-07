'use client';
import {useState} from 'react';
import {AlertCircle,ArrowRight,Check,FileSpreadsheet,ShieldCheck,Sparkles} from 'lucide-react';
import {Tabs,TabsList,TabsTrigger,TabsContent} from '@/components/ui/tabs';
import {Checkbox} from '@/components/ui/checkbox';
import {Collapsible,CollapsibleTrigger,CollapsibleContent} from '@/components/ui/collapsible';
import {Table,TableHeader,TableHead,TableBody,TableRow,TableCell} from '@/components/ui/table';
import type {WorkbookProfile,TableProfile} from '@/lib/models';

const num=(n:number)=>n.toLocaleString('th-TH',{maximumFractionDigits:1});
const roles:Record<string,string>={measure:'ตัวชี้วัด',dimension:'หมวดหมู่',identifier:'รหัสอ้างอิง',time_dimension:'วัน / เวลา',label:'ข้อความ'};

function TableDetails({table}:{table:TableProfile}){
 const [open,setOpen]=useState(false);
 return <Collapsible open={open} onOpenChange={setOpen} className="workbook-table">
  <CollapsibleTrigger className="workbook-expand"><span>{table.name}<small>{table.range} · {num(table.rows_count)} แถว · {num(table.columns_count)} คอลัมน์</small></span><span>{open?'−':'+'}</span></CollapsibleTrigger>
  <CollapsibleContent>{open&&<Tabs defaultValue="columns">
   <TabsList variant="line" className="detail-tabs"><TabsTrigger value="columns">โครงสร้าง</TabsTrigger><TabsTrigger value="preview">ตัวอย่างข้อมูล</TabsTrigger><TabsTrigger value="quality">คุณภาพข้อมูล</TabsTrigger></TabsList>
   <TabsContent value="columns"><p className="table-caption">บทบาทคอลัมน์เป็นการอนุมาน · ความมั่นใจในการหาหัวตาราง {num(table.confidence*100)}%</p>
    <Table><TableHeader><TableRow><TableHead>คอลัมน์</TableHead><TableHead>ประเภท</TableHead><TableHead>บทบาท</TableHead><TableHead>ค่าว่าง</TableHead></TableRow></TableHeader><TableBody>{table.columns.map((c,i)=><TableRow key={i}><TableCell><b>{c.name}</b><small className="cell-samples">{c.samples.join(' · ')}</small></TableCell><TableCell>{c.type}</TableCell><TableCell>{roles[c.role]||c.role}</TableCell><TableCell>{num(c.null_pct)}%</TableCell></TableRow>)}</TableBody></Table>
   </TabsContent>
   <TabsContent value="preview"><p className="table-caption">ตัวอย่างสูงสุด 12 แถว · วิเคราะห์จากทุกแถวในตาราง</p><Table><TableHeader><TableRow>{table.columns.map((c,i)=><TableHead key={i}>{c.name}</TableHead>)}</TableRow></TableHeader><TableBody>{table.preview.map((row,i)=><TableRow key={i}>{row.map((v,j)=><TableCell key={j}>{v===null||v===''?'—':String(v)}</TableCell>)}</TableRow>)}</TableBody></Table></TabsContent>
   <TabsContent value="quality"><div className="quality-list">{table.quality.issues.length?table.quality.issues.map((q,i)=><p key={i}>{q.message}</p>):<p>ไม่พบประเด็นจากการตรวจสอบเบื้องต้น</p>}{table.excluded_rows.map(r=><p key={r.row}>แถว {r.row}: {r.reason}</p>)}</div></TabsContent>
  </Tabs>}</CollapsibleContent>
 </Collapsible>;
}

function SheetDetails({book,name}:{book:WorkbookProfile;name:string}){
 const [open,setOpen]=useState(false);
 const sheet=book.sheets.find(s=>s.name===name)!;
 return <Collapsible open={open} onOpenChange={setOpen} className="workbook-sheet">
  <CollapsibleTrigger className="workbook-expand"><span>{name}<small>{num(sheet.tables_count)} ตาราง · {num(sheet.rows_count)} แถว{sheet.state!=='visible'?' · ชีตที่ซ่อนอยู่':''}</small></span><span>{open?'−':'+'}</span></CollapsibleTrigger>
  <CollapsibleContent>{open&&(sheet.tables_count?book.tables.filter(t=>t.sheet===name).map(t=><TableDetails key={t.id} table={t}/>):<p className="table-caption">{sheet.reason}</p>)}</CollapsibleContent>
 </Collapsible>;
}

export function WorkbookOverview({book,selected,onSelected,objective,onObjective,onAnalyze}:{book:WorkbookProfile;selected:string[];onSelected:(v:string[])=>void;objective:string;onObjective:(v:string)=>void;onAnalyze:()=>void}){
 const quality=book.summary.quality;
 const count=book.opportunities.filter(p=>selected.includes(p.type)).reduce((n,p)=>n+p.analyses_count,0);
 return <div className="data-view">
  <div className="dataset-bar"><span className="file-icon"><FileSpreadsheet size={24}/></span><div><h2>{book.filename}</h2><p>{book.understanding.dataset_summary}</p></div><span className="all-sheets-badge"><Check size={15}/>รวมทุกชีตอัตโนมัติ</span></div>
  <div className="metric-grid">{[{label:'ชีตที่อ่านแล้ว',value:num(book.sheets_count),sub:'รวมชีตที่ซ่อนอยู่และชีตว่าง'},{label:'ตารางที่พร้อมวิเคราะห์',value:num(book.tables_count),sub:'วิเคราะห์ทุกตารางอัตโนมัติ'},{label:'แถวข้อมูลรวม',value:num(book.rows_count),sub:'รวมแถวจากตารางที่ตรวจพบ'},{label:'ข้อมูลครบถ้วน',value:num(quality.completeness)+'%',sub:`${num(quality.missing)} เซลล์ว่างจากทุกตาราง`}].map(m=><div className="metric-card" key={m.label}><span>{m.label}</span><strong>{m.value}</strong><small>{m.sub}</small></div>)}</div>
  {book.notes.length>0&&<div className="alert warning"><AlertCircle size={20}/><div>{book.notes.map((s,i)=><p key={i}>{s}</p>)}</div></div>}
  <div className="panel details-panel"><Tabs defaultValue="sheets">
   <TabsList variant="line" className="detail-tabs"><TabsTrigger value="sheets">ภาพรวมทุกชีต</TabsTrigger><TabsTrigger value="details">โครงสร้างและตัวอย่าง</TabsTrigger><TabsTrigger value="quality">คุณภาพข้อมูล <span className="count-badge">{quality.issues.length}</span></TabsTrigger></TabsList>
   <TabsContent value="sheets"><p className="table-caption">{book.understanding.grain} · ไม่ต้องเลือกชีตเพิ่มเติม</p><Table><TableHeader><TableRow><TableHead>ชีต</TableHead><TableHead>ตาราง</TableHead><TableHead>แถวข้อมูล</TableHead><TableHead>ขอบเขต</TableHead></TableRow></TableHeader><TableBody>{book.sheets.map(s=><TableRow key={s.name}><TableCell><b>{s.name}</b>{s.state!=='visible'&&<small className="cell-samples">ชีตที่ซ่อนอยู่</small>}</TableCell><TableCell>{num(s.tables_count)}</TableCell><TableCell>{num(s.rows_count)}</TableCell><TableCell>{s.tables_count?'รวมในการวิเคราะห์แล้ว':s.reason}</TableCell></TableRow>)}</TableBody></Table></TabsContent>
   <TabsContent value="details"><p className="table-caption">เปิดดูรายละเอียดได้ตามต้องการ ทุกตารางรวมอยู่ในการวิเคราะห์แล้ว</p>{book.sheets.map(s=><SheetDetails key={s.name} name={s.name} book={book}/>)}</TabsContent>
   <TabsContent value="quality"><p className="table-caption">ความครบถ้วนคิดตามจำนวนเซลล์ข้อมูลทั้งหมด · แถวซ้ำตรวจภายในแต่ละตาราง</p><div className="quality-list">{quality.issues.length?quality.issues.map((q,i)=><div key={i}><AlertCircle size={17}/><p><b>{q.source?.sheet}!{q.source?.range}</b><br/>{q.message}</p></div>):<p>ไม่พบประเด็นจากการตรวจสอบเบื้องต้น</p>}</div></TabsContent>
  </Tabs></div>
  <div className="plan-layout"><section className="panel analysis-planner"><div className="panel-head"><div><h2>การวิเคราะห์ที่เหมาะกับข้อมูล</h2><p>เตรียมให้ครบทุกตารางแล้ว ปรับประเภทการวิเคราะห์ได้ตามต้องการ</p></div></div><div className="analysis-options">{book.opportunities.map(p=><label className="analysis-option" key={p.type}><Checkbox checked={selected.includes(p.type)} disabled={p.type==='quality'} onCheckedChange={v=>onSelected(v?[...selected,p.type]:selected.filter(k=>k!==p.type))}/><div><strong>{p.title}</strong><p>{p.reason}</p><small>{num(p.analyses_count)} รายการ · {num(p.tables_count)} ตาราง{p.type==='quality'?' · ตรวจทุกตารางเสมอ':''}</small></div></label>)}</div></section>
   <aside className="panel objective-panel"><span className="feature-icon"><Sparkles size={21}/></span><h2>อยากเข้าใจเรื่องไหนเป็นพิเศษ?</h2><p>ระบุวัตถุประสงค์เพื่อแนบในรายงาน และใช้ประกอบคำตีความเมื่อเปิด Gemini</p><label htmlFor="objective">วัตถุประสงค์ <span>(ไม่บังคับ)</span></label><textarea id="objective" value={objective} maxLength={1000} onChange={e=>onObjective(e.target.value)} placeholder="เช่น มีแนวโน้มหรือค่าผิดปกติใดที่ควรติดตาม?" rows={5}/><div className="objective-foot"><ShieldCheck size={15}/>อ่านทุกชีต · คำนวณแยกแต่ละตาราง</div><button className="primary-button" onClick={onAnalyze}>วิเคราะห์ทุกชีต <ArrowRight size={17}/></button><small>{num(count)} รายการ · {num(book.tables_count)} ตาราง</small></aside>
  </div>
 </div>;
}
