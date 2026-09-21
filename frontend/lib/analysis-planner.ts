import type {WorkbookProfile,AIPlan,Report,Opportunity} from './models';
import {aiJob,bytes,compact} from './ai-jobs.ts';

type Progress=(message:string,value:number)=>void;
type Part={table_id:string;table_ids:string[];payload:any};
export function planningParts(book:WorkbookProfile,objective:string,types?:string[],review?:Report):Part[]{
 const parts:Part[]=[];
 for(const table of book.tables){
  const available=table.opportunities.filter(p=>!types||types.includes(p.type)||p.type==='quality');
  const emit=(ops:Opportunity[],extra:number[]=[])=>{
   const indices=[...new Set([...extra,...ops.flatMap(p=>p.type==='quality'?[]:p.columns||[])])];
   const context=table.planning_context;
   const payload={objective,tables:[{id:table.id,name:table.name,sheet:table.sheet,range:table.range,rows_count:table.rows_count,columns_count:table.columns_count,
    columns:compact(indices.map(i=>({index:i,...table.columns[i]})),100,240),quality:compact(table.quality,12,400),confidence:table.confidence,
    planning_context:context?{rows_scanned:context.rows_scanned,columns:compact(indices.map(i=>context.columns[i]),100,240),
     samples:context.samples.filter((_,i)=>i%Math.max(1,Math.ceil(context.samples.length/12))===0).slice(0,12).map(s=>({row:s.row,values:indices.map(i=>s.values[i]),reasons:compact(s.reasons,4,120)})),
     sample_rows_total:context.samples.length,sampling:context.sampling}:undefined,
    opportunities:ops.map(p=>({...p,title:p.title?.slice(0,200),reason:p.reason?.slice(0,400),source_columns:p.type==='quality'?[]:p.source_columns?.map(c=>c.slice(0,240)),columns:p.type==='quality'?[]:p.columns}))}],
    notes:compact(book.notes,6,300),
    review:review?{evidence:review.evidence.filter(e=>e.source?.table_id===table.id&&ops.some(p=>p.id===e.calculation_id)).map(e=>compact(e,12,400)),errors:compact(review.errors?.filter(e=>e.source.table_id===table.id),6,300)}:undefined,
    scope:{table_id:table.id,total_tables:book.tables.length,total_columns:table.columns_count,included_column_indices:indices,total_eligible_analyses:available.length,fragment_analyses:ops.length,rule:'One fragment of a larger report. Never claim full workbook coverage. No joins or inferred units. Bounded examples; full source stays local.'}};
   if(bytes(payload)>75000&&ops.length>1){const mid=Math.ceil(ops.length/2);emit(ops.slice(0,mid),extra);emit(ops.slice(mid));return;}
   if(bytes(payload)>75000)throw Error('รายการวิเคราะห์หนึ่งรายการมีขนาดผิดปกติ ไม่สามารถแบ่งได้อย่างปลอดภัย: '+table.sheet);
   parts.push({table_id:table.id,table_ids:[table.id],payload});
  };
  const covered=new Set(available.filter(p=>p.type!=='quality').flatMap(p=>p.columns||[]));
  const remaining=(table.columns||[]).map((_,i)=>i).filter(i=>!covered.has(i));
  const quality=available.find(p=>p.type==='quality');
  for(let i=0;i<available.length;i+=12)emit(available.slice(i,i+12),i===0?remaining.slice(0,24):[]);
  if(quality)for(let i=24;i<remaining.length;i+=24)emit([quality],remaining.slice(i,i+24));
 }
 const packed:Part[]=[];
 for(const part of parts){
  const last=packed.at(-1);
  const joined=last?{...last.payload,tables:[...last.payload.tables,...part.payload.tables],scope:{fragments:[...(last.payload.scope.fragments||[last.payload.scope]),part.payload.scope],rule:'Independent table fragments. Never join, sum across tables or assume comparable units.'},review:review?{evidence:[...(last.payload.review?.evidence||[]),...(part.payload.review?.evidence||[])],errors:[last.payload.review?.errors,part.payload.review?.errors]}:undefined}:undefined;
  if(last&&!last.table_ids.includes(part.table_id)&&last.payload.tables.length<6&&bytes(joined)<=70000){last.payload=joined;last.table_ids.push(part.table_id);}else packed.push(part);
 }
 // Queue length is not a provider limit. Process every bounded part;
 // cancellation, per-request timeouts and the failure circuit below remain active.
 return packed;
}

export async function planAnalysis(book:WorkbookProfile,objective:string,signal:AbortSignal,types?:string[],review?:Report,progress:Progress=()=>{}):Promise<AIPlan>{
 const parts=planningParts(book,objective,types,review);
 if(!parts.length)throw Error('ไม่พบข้อมูลที่สามารถวิเคราะห์ได้');
 const results:AIPlan[]=[];const failed:{table_id:string;part:number;reason:string}[]=[];let consecutiveFailures=0;
 // Two independent parts at a time; consume in source order so variable
 // provider latency cannot reorder the report. A failure reduces pressure.
 let width=2,finished=0;
 progress('AI '+(review?'ทบทวนผล':'อ่านและวางแผน')+'สำเร็จ 0 / '+parts.length+'…',70);
 for(let start=0;start<parts.length;){
  signal.throwIfAborted();
  const batch=parts.slice(start,start+width);
  const outcomes=await Promise.allSettled(batch.map(async part=>{
   try{return await aiJob<AIPlan>('/api/plan',part.payload,signal);}
   finally{if(!signal.aborted)progress('AI '+(review?'ทบทวนผล':'อ่านและวางแผน')+'ดำเนินการแล้ว '+(++finished)+' / '+parts.length+'…',70);}
  }));
  signal.throwIfAborted();
  for(let offset=0;offset<outcomes.length;offset++){
   const outcome=outcomes[offset],i=start+offset;
   if(outcome.status==='fulfilled'){results.push(outcome.value);consecutiveFailures=0;}
   else{width=1;consecutiveFailures++;for(const table_id of parts[i].table_ids)failed.push({table_id,part:i+1,reason:outcome.reason instanceof Error?outcome.reason.message:'ประมวลผลไม่สำเร็จ'});}
  }
  start+=batch.length;
  if(consecutiveFailures>=3){for(let j=start;j<parts.length;j++)for(const table_id of parts[j].table_ids)failed.push({table_id,part:j+1,reason:'พักส่วนที่เหลือหลัง AI ล้มเหลวติดต่อกัน เพื่อลดเวลาและค่าใช้จ่าย'});break;}
 }
 if(!results.length)throw Error('AI ไม่สำเร็จทุกส่วน: '+(failed[0]?.reason||'ไม่พบแผน')+' ลองใหม่ได้โดยใช้ส่วนที่ทำสำเร็จแล้ว');
 const sections=results.flatMap(r=>r.sections);
 const unique=sections.filter((s,i)=>sections.findIndex(x=>JSON.stringify(x)===JSON.stringify(s))===i);
 const selected=new Set(unique.flatMap(s=>s.analyses.map(a=>JSON.stringify([a.table_id,a.analysis_id]))));
 const coverage=book.tables.map(t=>({table_id:t.id,sheet:t.sheet,range:t.range,rows:t.rows_count,eligible:t.opportunities.filter(p=>!types||types.includes(p.type)||p.type==='quality').length,selected:t.opportunities.filter(p=>selected.has(JSON.stringify([t.id,p.id]))).length,parts:parts.filter(p=>p.table_ids.includes(t.id)).length,failed_parts:failed.filter(f=>f.table_id===t.id).length}));
 return {title:results.length===1?results[0].title:'รายงานวิเคราะห์ข้อมูลจากไฟล์ที่อัปโหลด',understanding:results.map(r=>r.understanding).join('\n'),model:results[0].model,sections:unique,
  limitations:[...new Set(results.flatMap(r=>r.limitations)),...failed.map(f=>(book.tables.find(t=>t.id===f.table_id)?.sheet||f.table_id)+' ส่วน '+f.part+': AI ประมวลผลไม่สำเร็จ จึงไม่รวมข้อสรุปจากส่วนนี้')],
  requests:[...(review?.plan?.requests||[]),...results.flatMap(p=>p.requests||(p.receipt?[p.receipt]:[]))],receipt:results.at(-1)?.receipt,
  processing:{parts:parts.length,completed:results.length,failed,coverage,partial:failed.length>0||coverage.some(c=>!c.selected)||book.tables.some(t=>t.quality?.issues?.some(i=>i.kind==='ambiguous_scope'))||!!book.sheets?.some(s=>s.status==='no_table'&&s.reason!=='ชีตว่าง')}};
}
export function applyPlan(report:Report,plan:AIPlan):Report{
 const result=structuredClone(report);result.plan=structuredClone(plan);
 result.metadata.title=plan.title;result.metadata.interpretation_mode='AI planned, deterministic calculations, AI written';
 result.limitations=[...result.limitations,...plan.limitations];
 result.dynamic_sections=plan.sections.map(s=>({title:s.title,question:s.question,analysis_ids:s.analyses.flatMap(a=>{
  const match=result.analyses.find(r=>r.id===a.analysis_id&&r.source?.table_id===a.table_id);
  if(!match){result.plan!.limitations.push(s.title+': บางรายการคำนวณไม่สำเร็จ จึงไม่รวมเป็นหลักฐาน');return [];}
  return [match.evidence_id];
 })})).filter(s=>s.analysis_ids.length>0);
 if(!result.dynamic_sections.length)throw Error('ไม่มีผลคำนวณที่ตรวจสอบได้สำหรับเขียนรายงาน');
 if(result.errors?.length&&result.plan?.processing)result.plan.processing.partial=true;
 return result;
}
