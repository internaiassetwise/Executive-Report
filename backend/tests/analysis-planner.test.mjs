import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/app.mjs';
const config={legacyAi:true,apiKey:'fake',model:'gemini-2.5-flash',allowedOrigins:['http://localhost:3000']};
const input={objective:'test',tables:[{id:'T1',opportunities:[{id:'a'}]}]};
const plan={title:'แนวโน้มยอดขาย',understanding:'ข้อมูลตัวอย่าง',limitations:[],sections:[{title:'แนวโน้ม',question:'มีแนวโน้มอย่างไร',analyses:[{table_id:'T1',analysis_id:'a'}]}]};
const request=(body=input,origin='http://localhost:3000')=>new Request('http://localhost/api/plan',{method:'POST',headers:{Origin:origin},body:JSON.stringify(body)});
const wire={...plan,sections:plan.sections.map(s=>({title:s.title,question:s.question,choice_ids:['A0']}))};
const provider=(output=wire,finishReason='STOP')=>async()=>Response.json({responseId:'real-receipt',usageMetadata:{totalTokenCount:300},candidates:[{finishReason,content:{parts:[{text:JSON.stringify(output)}]}}]});
test('planner returns dynamic headings and real receipt for valid supported plan',async()=>{
 const r=await createHandler(config,provider())(request());assert.equal(r.status,200);const p=await r.json();assert.deepEqual(p.sections,plan.sections);assert.equal(p.receipt.total_tokens,300);
});
test('shared references across sections are valid; repeated choices within a section deduplicate',async()=>{
 const output={...wire,sections:[{...wire.sections[0],choice_ids:['A0','A0']},wire.sections[0]]};
 const r=await createHandler(config,provider(output))(request());assert.equal(r.status,200);const p=await r.json();assert.equal(p.sections.length,2);assert.deepEqual(p.sections[0].analyses,plan.sections[0].analyses);
});
test('invalid choices are repaired once with enum and targeted feedback',async()=>{
 let calls=0;
 const fetcher=async(url,init)=>{calls++;const b=JSON.parse(init.body);assert.deepEqual(b.generationConfig.responseSchema.properties.sections.items.properties.choice_ids.items.enum,['A0']);
  const input=JSON.parse(b.contents[0].parts[0].text);if(calls===2)assert.equal(input.correction.code,'UNKNOWN_CHOICE');
  return provider(calls===1?{...wire,sections:[{...wire.sections[0],choice_ids:['BAD']}]}:wire)();};
 const r=await createHandler(config,fetcher)(request());assert.equal(r.status,200);assert.equal(calls,2);assert.equal((await r.json()).requests.length,2);
});
test('invalid plans stop after bounded retries with distinct diagnostic codes',async()=>{
 for(const [p,code] of [[{...wire,sections:[{...wire.sections[0],choice_ids:['BAD']}]},'UNKNOWN_CHOICE'],[{...wire,title:'<script>'},'INVALID_PLAN'],[{...wire,sections:[null]},'INVALID_SECTION'],[null,'INVALID_PLAN']]){
  let calls=0;const r=await createHandler(config,async()=>{calls++;return provider(p)();})(request());assert.equal(r.status,502);const b=await r.json();assert.equal(b.code,code);assert.equal(calls,2);assert.equal(b.diagnostic.attempts,2);
 }
 const r=await createHandler(config,provider(wire,'MAX_TOKENS'))(request());assert.equal((await r.json()).code,'INCOMPLETE');
});
test('invalid input, origins and missing keys never call Gemini',async()=>{
 const handle=createHandler(config,()=>{throw Error('Must not call');});
 assert.equal((await handle(request({},'https://evil.invalid'))).status,403);
 assert.equal((await handle(request({}))).status,400);
 assert.equal((await handle(request({objective:'x'.repeat(100001)}))).status,413);
 assert.equal((await createHandler({...config,apiKey:''},()=>{throw Error('Must not call');})(request())).status,503);
});
