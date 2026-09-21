import type {Report} from './models';
import {aiJob,bytes,compact} from './ai-jobs.ts';
import {consolidateOutline,displayEvidenceIds} from './report-outline.ts';

// Hierarchical summaries bound both input and output without dropping whole tables.
export async function writeStructuredReport(original:Report,objective:string,signal:AbortSignal,progress:(m:string,v:number)=>void):Promise<Report>{
 const report=structuredClone(original),requests:unknown[]=[...(report.plan?.requests||(report.plan?.receipt?[report.plan.receipt]:[]))],sources:unknown[]=[],output:unknown[]=[];
 const originalCount=report.dynamic_sections?.length||0;
 report.dynamic_sections=consolidateOutline(report);
 const consolidated=originalCount>12;
 if(consolidated)for(const s of report.dynamic_sections)s.display_analysis_ids=displayEvidenceIds(report,s.analysis_ids);
 let model=report.plan?.model||'',done=0;
 const write=async(purpose:string,context:unknown)=>{
  signal.throwIfAborted();
  const slot={id:'S0',purpose,context:JSON.stringify(context)};
  if(bytes({objective,slots:[slot]})>85000)throw Error('ส่วนบทวิเคราะห์ใหญ่เกินงบหลังแบ่งแล้ว ผลคำนวณยังอยู่ครบ');
  const result=await aiJob<{slots:{id:string;paragraphs:string[]}[];model:string;receipt?:unknown}>('/api/report',{objective,slots:[slot]},signal);
  if(result.slots?.length!==1||result.slots[0].id!=='S0'||!result.slots[0].paragraphs?.length)throw Error('AI ส่งบทวิเคราะห์ไม่ครบ');
  sources.push(slot);output.push(result.slots[0]);if(result.receipt)requests.push(result.receipt);model=result.model;
  return result.slots[0].paragraphs;
 };
 const overview={rows:report.dataset_overview.rows_count,tables:report.dataset_overview.tables_count,sheets:report.dataset_overview.sheets_count,quality:compact(report.data_quality,8,240),partial:report.plan?.processing?.partial||!!report.errors?.length,limitations:compact(report.plan?.limitations||report.limitations,10,300),scope:'Only detected tables and selected valid calculations. Never claim the entire file is verified. No inferred units, joins, totals, or causes.'};
 const reduce=async(input:unknown[],label:string)=>{
  let nodes=input,level=0;
  while(bytes(nodes)>40000||nodes.length>40){
   signal.throwIfAborted();
   if(++level>8)throw Error('ไม่สามารถรวมหลักฐานภายในขนาดคำขอที่รองรับได้');
   const batches:unknown[][]=[];let batch:unknown[]=[];
   for(const node of nodes){if(batch.length&&(batch.length>=30||bytes([...batch,node])>35000)){batches.push(batch);batch=[];}batch.push(node);}
   if(batch.length)batches.push(batch);
   const next:unknown[]=[];
   for(let i=0;i<batches.length;i++){
    progress('AI รวมหลักฐาน '+label+' '+(i+1)+' / '+batches.length+'…',84);
    next.push({summary:await write('รวมหลักฐานเป็นประเด็นสำคัญ เก็บชื่อชีตและคอลัมน์ที่เกี่ยวข้อง ข้อจำกัดและประเด็นผิดปกติ ห้ามรวมยอดหรือจัดอันดับข้ามตารางที่หน่วยไม่ชัดเจน',{evidence:batches[i],scope:overview.scope})});
   }
   nodes=next;
  }
  return nodes;
 };
 const sectionSummaries:unknown[]=[];
 const writtenSections:NonNullable<Report['dynamic_sections']>=[];
 for(const section of report.dynamic_sections||[]){
  progress('AI เขียนบทวิเคราะห์ '+(++done)+' / '+report.dynamic_sections!.length+'…',85);
  const evidence=report.evidence.filter(e=>section.analysis_ids.includes(e.evidence_id)).map(e=>compact(e,16,300));
  try{
   const condensed=await reduce(evidence,section.title);
   section.narrative=(await write('เขียนบทวิเคราะห์หัวข้อ '+section.title+' ตอบคำถาม '+section.question+' ใช้หลักฐานเท่านั้น บอกข้อจำกัดที่มีผลต่อข้อสรุป ห้ามอ้างว่าข้อมูลครบทุกส่วน ห้ามอ้างนัยสำคัญหรือเหตุและผล',{evidence:condensed,scope:'Use only limitations attached to this evidence and its exact source columns. Keep source names. Never sum or rank across incompatible tables. Internal request batching does not imply incomplete source data. Do not repeat unrelated report-wide limitations.'})).join('\n\n');
   sectionSummaries.push({title:section.title,narrative:section.narrative});
   writtenSections.push(section);
  }catch(error){
   signal.throwIfAborted();
   const note=section.title+': AI เขียนส่วนนี้ไม่สำเร็จ จึงไม่แสดงบทวิเคราะห์ส่วนนี้ ผลคำนวณยังอยู่ใน Report JSON';
   report.limitations.push(note);report.plan?.limitations.push(note);if(report.plan?.processing)report.plan.processing.partial=true;
  }
 }
 if(report.dynamic_sections?.length&&!writtenSections.length)throw Error('AI เขียนบทวิเคราะห์ไม่สำเร็จทุกส่วน ลองใหม่ได้โดยไม่ต้องคำนวณซ้ำ');
 report.dynamic_sections=writtenSections;
 overview.partial=report.plan?.processing?.partial||!!report.errors?.length;
 overview.limitations=compact(report.plan?.limitations||report.limitations,10,300);
 // Every evidence finding participates; arrays of data stay local, numeric facts are unchanged.
 let nodes:unknown[]=consolidated?sectionSummaries:report.evidence.map(e=>({id:e.evidence_id,source:compact(e.source,12,200),finding:e.finding}));
 if(!nodes.length)throw Error('ไม่มีหลักฐานสำหรับบทสรุป');
 let level=0;
 while(bytes(nodes)>45000||nodes.length>40){
  progress('AI รวมผลวิเคราะห์เป็นบทสรุป ระดับ '+(++level)+'…',96);
  const batches:unknown[][]=[];let batch:unknown[]=[];
  for(const node of nodes){if(batch.length&&(batch.length>=30||bytes([...batch,node])>40000)){batches.push(batch);batch=[];}batch.push(node);}
  if(batch.length)batches.push(batch);
  const reduced:unknown[]=[];
  for(let i=0;i<batches.length;i++)reduced.push({summary:await write('สรุปหลักฐานส่วนนี้เพื่อรวมในรายงานเดียว เก็บประเด็นสำคัญ ขอบเขต และข้อจำกัด ไม่จัดอันดับข้ามตารางที่เทียบกันไม่ได้',{findings:batches[i],scope:overview.scope}),part:i+1,parts:batches.length});
  nodes=reduced;
  if(level>8)throw Error('ไม่สามารถย่อรายงานภายในงบงานได้อย่างปลอดภัย');
 }
 // These final sections depend on the same completed evidence, not each other.
 const finalSections=await Promise.allSettled([
  write('บทสรุปผู้บริหารของรายงานรวม ให้ตรงกับขอบเขตหลักฐานและแจ้งหากประมวลผลได้บางส่วน',{overview,findings:nodes}),
  write('ข้อเสนอแนะจากหลักฐาน เป็นสิ่งที่ควรตรวจสอบ ไม่กล่าวว่าสาเหตุได้รับการพิสูจน์แล้ว',{overview,findings:nodes}),
 ]);
 signal.throwIfAborted();
 for(const result of finalSections)if(result.status==='rejected')throw result.reason;
 report.executive_summary=(finalSections[0] as PromiseFulfilledResult<string[]>).value;
 report.recommendations=(finalSections[1] as PromiseFulfilledResult<string[]>).value;
 report.writer={status:'complete',model,generated_at:new Date().toISOString(),sources,output,requests};
 return report;
}
