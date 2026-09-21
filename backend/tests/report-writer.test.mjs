import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../src/app.mjs';
const config={apiKey:'test-secret',model:'gemini-2.5-flash',allowedOrigins:['http://localhost:3000']};
const payload={objective:'ทดสอบ',slots:[{id:'S0',purpose:'สรุป',context:'ค่าเฉลี่ย 10 บาท'}]};
const request=(body=payload)=>new Request('http://localhost/api/report',{method:'POST',headers:{Origin:'http://localhost:3000'},body:JSON.stringify(body)});
const output={slots:[{id:'S0',paragraphs:['ค่าเฉลี่ย 10 บาท ควรตรวจสอบข้อมูลประกอบ'],evidence_ids:['S0']}]};
const provider=(value=output,reason='STOP')=>async()=>Response.json({candidates:[{finishReason:reason,content:{parts:[{text:JSON.stringify(value)}]}}]});
test('writer accepts grounded prose and keeps server-selected model',async()=>{
 const result=await createHandler(config,provider())(request());assert.equal(result.status,200);assert.equal((await result.json()).model,config.model);
});
test('server binds citations to validated slot IDs without requiring model to echo them',async()=>{
 const result=await createHandler(config,provider({slots:[{id:'S0',paragraphs:['ค่าเฉลี่ย 10 บาท']}]}))(request());
 assert.equal(result.status,200);assert.deepEqual((await result.json()).slots[0].evidence_ids,['S0']);
});
test('invalid numerical claim is regenerated once with real writer contract',async()=>{
 let calls=0;
 const fetcher=async()=>{calls++;return provider({slots:[{id:'S0',paragraphs:[calls===1?'ค่าเฉลี่ย 999 บาท':'ควรตรวจสอบข้อมูลประกอบการตัดสินใจ']} ]})();};
 const response=await createHandler(config,fetcher)(request());assert.equal(response.status,200);assert.equal(calls,2);
});
test('writer rejects invented numbers, references, duplicate/missing slots, markup and truncation',async()=>{
 const bad=[{slots:[{...output.slots[0],paragraphs:['ค่าเฉลี่ย 99 บาท']}]},{slots:[{...output.slots[0],evidence_ids:['S1']}]},{slots:[]},{slots:[output.slots[0],output.slots[0]]},{slots:[{...output.slots[0],paragraphs:['<script>bad</script>']}]}];
 for(const o of bad)assert.equal((await createHandler(config,provider(o))(request())).status,502);
 assert.equal((await createHandler(config,provider(output,'MAX_TOKENS'))(request())).status,502);
 assert.equal((await createHandler(config,provider({slots:[{...output.slots[0],paragraphs:['ค่าเฉลี่ย -10 บาท']}]}))(request())).status,502);
});
test('writer does not call provider for malformed or unconfigured requests',async()=>{
 let called=false;const fetcher=async()=>{called=true;throw Error('unexpected');};
 assert.equal((await createHandler(config,fetcher)(request({slots:[]}))).status,400);
 assert.equal((await createHandler({...config,apiKey:''},fetcher)(request())).status,503);assert.equal(called,false);
});
test('writer rejects oversized requests and foreign origins',async()=>{
 const handle=createHandler(config,provider());
 assert.equal((await handle(request({objective:'x'.repeat(100001)}))).status,413);
 assert.equal((await handle(new Request('http://localhost/api/report',{method:'POST',headers:{Origin:'http://evil.test'},body:JSON.stringify(payload)}))).status,403);
});
