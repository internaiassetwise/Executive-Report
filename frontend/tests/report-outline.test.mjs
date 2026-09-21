import {test} from 'node:test';
import assert from 'node:assert/strict';
import {consolidateOutline} from '../lib/report-outline.ts';
import {writeStructuredReport} from '../lib/structured-writer.ts';
import {clearAIJobs} from '../lib/ai-jobs.ts';

test('372 headings become bounded topics; all evidence reaches synthesis once and facts stay intact',async()=>{
 clearAIJobs();const old=globalThis.fetch;let calls=0,narratives=0;const seen=new Map();
 const types=['statistics','category','outliers','trend','correlation','frequency','distribution'];
 const evidence=Array.from({length:372},(_,i)=>({evidence_id:'E'+i,type:types[i%7],source:{table_id:'T'+i,sheet:'Sheet'+i,range:'A1:B50',source_columns:['Value']},finding:'ค่าเฉลี่ย '+i,data:{mean:i},limitations:[]}));
 const r={metadata:{},dataset_overview:{},data_quality:{},limitations:[],evidence,analyses:evidence.map(e=>({...e,id:e.evidence_id})),dynamic_sections:evidence.map(e=>({title:'หัวข้อ '+e.evidence_id,question:'ภาพรวม',analysis_ids:[e.evidence_id]})),executive_summary:[],recommendations:[]};
 globalThis.fetch=async(url,init)=>{
  calls++;assert.ok(new TextEncoder().encode(init.body).length<90000);
  const slot=JSON.parse(init.body).slots[0],ctx=JSON.parse(slot.context);
  if(slot.purpose.startsWith('เขียนบทวิเคราะห์หัวข้อ'))narratives++;
  for(const e of ctx.evidence||[])if(e.evidence_id)seen.set(e.evidence_id,(seen.get(e.evidence_id)||0)+1);
  return Response.json({model:'test',slots:[{id:'S0',paragraphs:['สรุปหลักฐานชุด '+calls]}]});
 };
 try{
  const out=await writeStructuredReport(r,'',new AbortController().signal,()=>{});
  assert.equal(out.dynamic_sections.length,7);assert.equal(narratives,7);assert.ok(calls<40);
  assert.ok(out.dynamic_sections.every(s=>r.dynamic_sections.some(original=>original.title===s.title&&original.question===s.question)));
  assert.equal(seen.size,372);assert.ok([...seen.values()].every(n=>n===1));
  assert.equal(new Set(out.dynamic_sections.flatMap(s=>s.analysis_ids)).size,372);
  assert.ok(out.dynamic_sections.every(s=>s.display_analysis_ids.length<=3));
  assert.deepEqual(out.evidence,r.evidence);assert.deepEqual(out.analyses,r.analyses);assert.equal(r.dynamic_sections.length,372);
 }finally{globalThis.fetch=old;clearAIJobs();}
});
test('small custom outlines keep their titles and duplicate evidence sets merge',()=>{
 const r={analyses:[],evidence:[],dynamic_sections:[{title:'หัวข้อเฉพาะข้อมูล',question:'คำถาม',analysis_ids:['A','B']},{title:'ซ้ำ',question:'คำถาม',analysis_ids:['B','A']}]};
 assert.deepEqual(consolidateOutline(r),[r.dynamic_sections[0]]);
});
