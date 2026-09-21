import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planningParts,planAnalysis,applyPlan} from '../lib/analysis-planner.ts';
import {clearAIJobs,bytes} from '../lib/ai-jobs.ts';
import {writeStructuredReport} from '../lib/structured-writer.ts';
import {planAndCalculate} from '../lib/planned-analysis.ts';
const table=i=>({id:'T'+i,name:'ตาราง '+i,sheet:'Sheet'+i,range:'A1:B100',rows_count:99,columns_count:2,confidence:1,columns:[{name:'Group'},{name:'Amount',stats:{mean:10}}],quality:{missing:0,duplicates:0,completeness:100,issues:[]},preview:[],opportunities:[{id:'Q'+i,type:'quality',title:'quality',reason:'quality',columns:[0,1],source_columns:['Group','Amount']},{id:'S'+i,type:'statistics',title:'statistics',reason:'mean',columns:[1],source_columns:['Amount']}],planning_context:{rows_scanned:99,columns:[{groups:Array.from({length:100},(_,j)=>({label:'Category '+j,count:j}))},{stats:{mean:10}}],samples:Array.from({length:60},(_,j)=>({row:j+1,values:['กลุ่ม'.repeat(30),j],reasons:['spread']})),sampling:'bounded'}});
const book=n=>({tables:Array.from({length:n},(_,i)=>table(i)),notes:[],sheets:[]});
const generated=b=>({title:'รายงาน',understanding:'ข้อมูล',limitations:[],sections:b.tables.map(t=>({title:t.name,question:'ภาพรวม',analyses:[{table_id:t.id,analysis_id:t.opportunities[0].id}]})),model:'test',requests:[{total_tokens:1}]});
test('201 tables larger than old cap are covered in bounded requests without dropping columns',()=>{
 const b=book(201);assert.ok(bytes(b)>95000);const parts=planningParts(b,'');assert.ok(parts.length>0);
 assert.ok(parts.every(p=>bytes(p.payload)<75000));assert.equal(new Set(parts.flatMap(p=>p.table_ids)).size,201);
 for(const p of parts)for(const t of p.payload.tables)assert.equal(t.columns.length,2);
});
test('large and wide tables split without losing any eligible operation',()=>{
 const b=book(1),t=b.tables[0];t.opportunities=Array.from({length:80},(_,i)=>({id:'P'+i,type:'statistics',title:'ข้อมูล'.repeat(500),reason:'เหตุผล'.repeat(500),columns:[1],source_columns:['Amount']}));
 const p=planningParts(b,'');assert.ok(p.length>1);assert.equal(new Set(p.flatMap(x=>x.payload.tables.flatMap(t=>t.opportunities.map(o=>o.id)))).size,80);
 assert.ok(p.every(x=>bytes(x.payload)<75000));
});

const largeQueueBook=()=>{
 const b=book(1);
 b.tables[0].opportunities=Array.from({length:86*12},(_,i)=>({id:'P'+i,type:'statistics',title:'ค่าเฉลี่ย',reason:'ข้อมูลตัวเลข',columns:[1],source_columns:['Amount']}));
 return b;
};
test('upload pipeline plans 86 parts only once, calculates once and writes without review',async()=>{
 clearAIJobs();const old=globalThis.fetch;let planningCalls=0,calculations=0,writingCalls=0;
 globalThis.fetch=async(url,init)=>{
  const payload=JSON.parse(init.body);
  if(url==='/api/plan'){
   planningCalls++;assert.equal(payload.review,undefined);
   const plan=generated(payload);plan.sections.push(structuredClone(plan.sections[0]));
   return Response.json(plan);
  }
  assert.equal(url,'/api/report');writingCalls++;
  return Response.json({model:'test',slots:[{id:'S0',paragraphs:['จากหลักฐาน']}],receipt:{total_tokens:1}});
 };
 try{
  const computed=await planAndCalculate(largeQueueBook(),'',new AbortController().signal,async selected=>{
   calculations++;assert.equal(selected.length,86);
   const analyses=selected.map((s,i)=>({id:s.analysis_id,evidence_id:'EV'+i,source:{table_id:s.table_id}}));
   return {metadata:{},dataset_overview:{},data_quality:{},limitations:[],analyses,evidence:analyses.map(a=>({evidence_id:a.evidence_id,source:a.source,finding:'หลักฐาน'})),executive_summary:[],recommendations:[]};
  });
  const written=await writeStructuredReport(computed,'',new AbortController().signal,()=>{});
  assert.equal(planningCalls,86);assert.equal(calculations,1);assert.ok(writingCalls>0);
  assert.equal(written.writer.status,'complete');assert.deepEqual(written.evidence,computed.evidence);
 }finally{globalThis.fetch=old;clearAIJobs();}
});
test('cancelled calculation never triggers review or returns a completed report',async()=>{
 clearAIJobs();const old=globalThis.fetch,controller=new AbortController();let calls=0;
 globalThis.fetch=async(url,init)=>{calls++;return Response.json(generated(JSON.parse(init.body)));};
 try{
  await assert.rejects(planAndCalculate(book(1),'',controller.signal,async()=>{controller.abort();return {};}),{name:'AbortError'});
  assert.equal(calls,1);
 }finally{globalThis.fetch=old;clearAIJobs();}
});
test('86 parts complete with at most two concurrent requests and full operation coverage',async()=>{
 clearAIJobs();const old=globalThis.fetch;let active=0,maxActive=0,calls=0;const seen=new Set(),progress=[];
 globalThis.fetch=async(url,init)=>{
  active++;maxActive=Math.max(maxActive,active);calls++;
  await new Promise(resolve=>setImmediate(resolve));
  const payload=JSON.parse(init.body);assert.ok(bytes(payload)<=75000);
  payload.tables.flatMap(t=>t.opportunities).forEach(p=>seen.add(p.id));
  active--;return Response.json(generated(payload));
 };
 try{
  const b=largeQueueBook();assert.equal(planningParts(b,'').length,86);
  const initial=await planAnalysis(b,'',new AbortController().signal,undefined,undefined,m=>progress.push(m));
  assert.equal(initial.processing.completed,86);assert.equal(initial.processing.partial,false);
  const reviewed=await planAnalysis(b,'',new AbortController().signal,undefined,{plan:initial,evidence:[],errors:[]});
  assert.equal(reviewed.processing.completed,86);assert.equal(reviewed.processing.partial,false);
  assert.equal(calls,172);assert.equal(maxActive,2);assert.equal(seen.size,86*12);
  assert.equal(reviewed.requests.length,172);assert.ok(progress.at(-1).includes('86 / 86'));
 }finally{globalThis.fetch=old;clearAIJobs();}
});
test('failure after part 64 stops safely and retry resumes uncached parts of an 86-part queue',async()=>{
 clearAIJobs();const old=globalThis.fetch;let calls=0,fail=true;
 globalThis.fetch=async(url,init)=>{
  calls++;const payload=JSON.parse(init.body),id=Number(payload.tables[0].opportunities[0].id.slice(1));
  if(fail&&id>=64*12)return Response.json({error:'temporary failure'},{status:502});
  return Response.json(generated(payload));
 };
 try{
  const b=largeQueueBook();const first=await planAnalysis(b,'',new AbortController().signal);
  assert.equal(calls,67);assert.equal(first.processing.completed,64);
  assert.equal(first.processing.failed.length,22);assert.equal(first.processing.partial,true);
  fail=false;const retry=await planAnalysis(b,'',new AbortController().signal);
  assert.equal(calls,67+22);assert.equal(retry.processing.completed,86);assert.equal(retry.processing.partial,false);
 }finally{globalThis.fetch=old;clearAIJobs();}
});
test('86-part queue remains cancellable after the old boundary',async()=>{
 clearAIJobs();const old=globalThis.fetch,controller=new AbortController();let calls=0;
 globalThis.fetch=async(url,init)=>{calls++;if(calls===65)controller.abort();return Response.json(generated(JSON.parse(init.body)));};
 try{await assert.rejects(planAnalysis(largeQueueBook(),'',controller.signal),{name:'AbortError'});assert.equal(calls,65);}finally{globalThis.fetch=old;clearAIJobs();}
});
test('partial failure is disclosed and retry reuses only successful checkpoints',async()=>{
 clearAIJobs();const old=globalThis.fetch;let calls=0,fail=true;
 globalThis.fetch=async(url,init)=>{calls++;const b=JSON.parse(init.body);if(fail&&b.tables.some(t=>t.id==='T6'))return Response.json({error:'temporary failure'},{status:502});return Response.json(generated(b));};
 try{const b=book(7);const p=await planAnalysis(b,'',new AbortController().signal);assert.equal(p.processing.partial,true);assert.equal(p.processing.failed.length,1);assert.equal(p.processing.coverage.length,7);const first=calls;fail=false;const next=await planAnalysis(b,'',new AbortController().signal);assert.equal(calls,first+1);assert.equal(next.processing.partial,false);}finally{globalThis.fetch=old;clearAIJobs();}
});
test('out-of-order provider responses retain source order and monotonic completed progress',async()=>{
 clearAIJobs();const old=globalThis.fetch,completed=[],progress=[];
 globalThis.fetch=async(url,init)=>{
  const b=JSON.parse(init.body),id=b.tables[0].id;
  await new Promise(resolve=>setTimeout(resolve,id==='T0'?30:1));
  completed.push(id);return Response.json(generated(b));
 };
 try{
  const result=await planAnalysis(book(7),'',new AbortController().signal,undefined,undefined,m=>progress.push(m));
  assert.deepEqual(completed,['T6','T0']);
  assert.deepEqual(result.sections.map(s=>s.analyses[0].table_id),['T0','T1','T2','T3','T4','T5','T6']);
  assert.ok(progress[0].includes('0 / 2'));assert.ok(progress[1].includes('1 / 2'));assert.ok(progress[2].includes('2 / 2'));
 }finally{globalThis.fetch=old;clearAIJobs();}
});
test('cancellation stops further requests and never returns a completed plan',async()=>{
 clearAIJobs();const old=globalThis.fetch,c=new AbortController();let calls=0;
 globalThis.fetch=async(url,init)=>{calls++;c.abort();return Response.json(generated(JSON.parse(init.body)));};
 try{await assert.rejects(planAnalysis(book(7),'',c.signal));assert.equal(calls,1);}finally{globalThis.fetch=old;clearAIJobs();}
});
test('hierarchical writer handles 804 evidence records and preserves original facts',async()=>{
 clearAIJobs();const old=globalThis.fetch;let calls=0;
 globalThis.fetch=async(url,init)=>{calls++;assert.ok(new TextEncoder().encode(init.body).length<90000);return Response.json({model:'test',slots:[{id:'S0',paragraphs:['สรุปจากหลักฐาน']}],receipt:{total_tokens:1}});};
 const evidence=Array.from({length:804},(_,i)=>({evidence_id:'EV'+i,finding:'ข้อมูล'.repeat(70),source:{table_id:'T'+i,sheet:'Sheet'+i,range:'A1:B100',source_columns:['Amount']},data:{mean:i}}));
 const r={metadata:{},dataset_overview:{rows_count:100,tables_count:201},data_quality:{},limitations:[],evidence,analyses:[],dynamic_sections:[],executive_summary:[],recommendations:[]};
 try{const result=await writeStructuredReport(r,'',new AbortController().signal,()=>{});assert.equal(result.writer.status,'complete');assert.ok(calls>2);assert.deepEqual(result.evidence,evidence);assert.deepEqual(r.executive_summary,[]);}finally{globalThis.fetch=old;clearAIJobs();}
});

test('failed narrative is excluded and disclosed without changing calculated evidence',async()=>{
 clearAIJobs();const old=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{const b=JSON.parse(init.body);if(b.slots[0].purpose.includes('หัวข้อ failed'))return Response.json({error:'temporary'},{status:502});return Response.json({model:'test',slots:[{id:'S0',paragraphs:['จากหลักฐาน']}],receipt:{total_tokens:1}});};
 const r={dataset_overview:{rows_count:2,tables_count:1},data_quality:{},limitations:[],evidence:[{evidence_id:'EV1',finding:'ข้อมูล',source:{table_id:'T1'}},{evidence_id:'EV2',finding:'รายละเอียด',source:{table_id:'T1'}}],analyses:[],dynamic_sections:[{title:'ok',question:'ภาพรวม',analysis_ids:['EV1']},{title:'failed',question:'รายละเอียด',analysis_ids:['EV2']}],plan:{limitations:[],processing:{partial:false}},executive_summary:[],recommendations:[]};
 try{const result=await writeStructuredReport(r,'',new AbortController().signal,()=>{});assert.equal(result.plan.processing.partial,true);assert.equal(result.dynamic_sections.length,1);assert.ok(result.limitations.some(x=>x.includes('failed')));assert.deepEqual(result.evidence,r.evidence);assert.equal(r.dynamic_sections.length,2);assert.equal(r.plan.processing.partial,false);}finally{globalThis.fetch=old;clearAIJobs();}
});
