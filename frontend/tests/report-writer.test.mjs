import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeNarrative} from '../lib/report-writer.ts';
test('generic writing preserves all numerical evidence and leaves original untouched',async()=>{
 const original={metadata:{},dataset_overview:{},data_quality:{},evidence:[{evidence_id:'EV-1',finding:'mean 10',source:{}}],analyses:[{id:'a',evidence_id:'EV-1',finding:'mean 10',data:{mean:10},chart:{points:[10]}}],executive_summary:['old'],recommendations:['old'],limitations:[]};
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(init.body);return Response.json({model:'test',slots:body.slots.map(s=>({id:s.id,paragraphs:['ข้อความใหม่'],evidence_ids:[s.id]}))});};
 try{const r=await writeNarrative(original,'',new AbortController().signal,()=>{});assert.deepEqual(r.evidence,original.evidence);assert.deepEqual(r.analyses[0].data,original.analyses[0].data);assert.deepEqual(r.analyses[0].chart,original.analyses[0].chart);assert.equal(r.analyses[0].narrative,'ข้อความใหม่');assert.deepEqual(original.executive_summary,['old']);assert.equal(r.writer.status,'complete');}finally{globalThis.fetch=oldFetch;}
});
test('failure or cancellation never mutates the calculated report',async()=>{
 const original={vendors:[],executive:{summary:'old',bullets:[],headline:'old'},strategy:[],signatures:[],files_skipped:[]};const oldFetch=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({error:'failed'},{status:502});
 try{await assert.rejects(writeNarrative(original,'',new AbortController().signal,()=>{}));assert.equal(original.executive.summary,'old');const c=new AbortController();c.abort();await assert.rejects(writeNarrative(original,'',c.signal,()=>{}));}finally{globalThis.fetch=oldFetch;}
});
test('BOQ writer changes narrative slots only across multiple batches',async()=>{
 const vendors=['AAA','BBB'].map(vendor=>({vendor,project:'demo',benchmark:'RBP',total:{original:100,normalized:90,savings:10},groups:[{group:'A',original:100,normalized:90}],axes:['quantity'],insights:['old']}));
 const original={vendors,tolerance:0.1,tolerance_source:'default',executive:{rows:[{vendor:'AAA',original:100,normalized:90}],summary:'old',bullets:['old'],headline:'old'},strategy:['old'],signatures:vendors.map(v=>({vendor:v.vendor,pattern:'old',top_groups:'A'})),files_skipped:[],comparison:{A:{AAA:10}}};
 const oldFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async(_url,init)=>{calls++;const body=JSON.parse(init.body);return Response.json({model:'test',slots:body.slots.map(s=>({id:s.id,paragraphs:['ข้อความใหม่'],evidence_ids:[s.id]}))});};
 try{const r=await writeNarrative(original,'',new AbortController().signal,()=>{});assert.equal(calls,2);assert.deepEqual(r.executive.rows,original.executive.rows);assert.deepEqual(r.comparison,original.comparison);assert.deepEqual(r.vendors.map(v=>v.total),original.vendors.map(v=>v.total));assert.deepEqual(r.vendors.map(v=>v.groups),original.vendors.map(v=>v.groups));assert.equal(r.vendors[1].insights[0],'ข้อความใหม่');assert.equal(r.signatures[0].pattern,'ข้อความใหม่');assert.equal(original.executive.summary,'old');}finally{globalThis.fetch=oldFetch;}
});
