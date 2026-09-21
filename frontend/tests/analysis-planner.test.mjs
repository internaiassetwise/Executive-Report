import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyPlan,planAnalysis} from '../lib/analysis-planner.ts';
import {clearAIJobs} from '../lib/ai-jobs.ts';
import {writeNarrative} from '../lib/report-writer.ts';
const report={metadata:{},dataset_overview:{},data_quality:{},analyses:[{id:'a',evidence_id:'EV1',source:{table_id:'T1'},data:{mean:10}}],evidence:[{evidence_id:'EV1',calculation_id:'a',source:{table_id:'T1'},data:{mean:10},finding:'mean 10'}],limitations:[],executive_summary:[],recommendations:[]};
const plan={title:'หัวข้อตามข้อมูล',understanding:'example',limitations:['ไม่ยืนยันเหตุและผล'],sections:[{title:'ประเด็นที่ผู้ใช้สนใจ',question:'ค่าเฉลี่ยเป็นอย่างไร',analyses:[{table_id:'T1',analysis_id:'a'}]}],receipt:{response_id:'planner'}};
test('dynamic sections keep immutable calculations and write by evidence group',async()=>{
 const old=globalThis.fetch;globalThis.fetch=async(url,init)=>{const b=JSON.parse(init.body);return Response.json({model:'test',slots:b.slots.map(s=>({id:s.id,paragraphs:['บทวิเคราะห์'],evidence_ids:[s.id]}))});};
 try{const applied=applyPlan(report,plan);const r=await writeNarrative(applied,'',new AbortController().signal,()=>{});assert.equal(r.dynamic_sections[0].title,plan.sections[0].title);assert.equal(r.dynamic_sections[0].narrative,'บทวิเคราะห์');assert.deepEqual(r.evidence,report.evidence);assert.deepEqual(r.analyses,report.analyses);assert.equal(report.plan,undefined);assert.equal(r.writer.requests[0].response_id,'planner');}finally{globalThis.fetch=old;}
});
test('missing calculations cannot become a completed report',()=>{assert.throws(()=>applyPlan({...report,analyses:[]},plan));});
test('review includes calculated evidence and retains both planning receipts',async()=>{
 clearAIJobs();const old=globalThis.fetch;let sent;globalThis.fetch=async(url,init)=>{sent=JSON.parse(init.body);return Response.json(plan);};
 const book={tables:[{id:'T1',planning_context:{rows_scanned:100,columns:[],samples:[{row:100,values:['tail'],reasons:['extreme']}],sampling:'bounded'},preview:[],columns:[{name:'Amount'}],opportunities:[{id:'a',type:'statistics',columns:[0],source_columns:['Amount']}]}],notes:[]};
 try{const p=await planAnalysis(book,'',new AbortController().signal,undefined,{...report,plan:{...plan,requests:[plan.receipt]}});assert.equal(p.requests.length,2);assert.equal(sent.review.evidence[0].data.mean,10);assert.equal(sent.tables[0].preview,undefined);assert.equal(sent.tables[0].planning_context.samples[0].row,100);}finally{globalThis.fetch=old;}
});
test('planning sends bounded previews, not entire raw rows, and propagates failure',async()=>{
 const old=globalThis.fetch;let sent;
 globalThis.fetch=async(url,init)=>{sent=JSON.parse(init.body);return Response.json({error:'quota'},{status:502});};
 try{await assert.rejects(planAnalysis({tables:[{id:'T1',rows:['private'],preview:Array(50).fill(['sample']),columns:[{name:'Amount'}],opportunities:[{id:'a',type:'statistics',columns:[0],source_columns:['Amount']}]}],notes:[]},'',new AbortController().signal),/quota/);assert.equal(sent.tables[0].preview,undefined);assert.equal(sent.tables[0].rows,undefined);}finally{globalThis.fetch=old;}
});
