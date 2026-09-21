// Full synthetic CSV -> Python calculations -> real Gemini -> report contract.
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHandler} from '../backend/src/app.mjs';
import {writeNarrative} from '../frontend/lib/report-writer.ts';
process.loadEnvFile(new URL('../backend/.env',import.meta.url));
const isBoq=process.argv.includes('--boq');
const boqCode=`import sys,json,io,openpyxl
sys.path.insert(0,'backend/analysis')
import analysis_engine as e
b=openpyxl.Workbook();s=b.active;s.title='ST_A'
s.append(['No','รายการ','ปริมาณ RBP','ปริมาณ AAA เสนอ','ปริมาณ BBB เสนอ','ราคาของ RBP','ราคาของ AAA เสนอ','ราคาของ BBB เสนอ','ราคาแรง RBP','ราคาแรง AAA เสนอ','ราคาแรง BBB เสนอ'])
for i in range(12):
 q=10.0*(i+1);s.append([i+1,f'Item {i}',q,q,q*1.2,100.0,200.0 if i==0 else 100.0,100.0,50.0,50.0,52.5])
f=io.BytesIO();b.save(f)
print(json.dumps(e.boq([{'filename':'synthetic-boq.xlsx','bytes':f.getvalue()}])['report'],ensure_ascii=True))`;
const calculated=JSON.parse(execFileSync('python',['-c',isBoq?boqCode:"import sys,json;sys.path.insert(0,'backend/analysis');import analysis_engine as e;e.inspect(open('frontend/public/sample-data.csv','rb').read(),'sample-data.csv');print(json.dumps(e.analyze_workbook(),ensure_ascii=True))"],{encoding:'utf8'}));
const providerFetch=globalThis.fetch;
const handle=createHandler({apiKey:process.env.GEMINI_API_KEY,model:process.env.GEMINI_MODEL,allowedOrigins:['http://localhost:3000']},providerFetch);
globalThis.fetch=(url,init)=>handle(new Request('http://localhost'+url,{...init,headers:{...init.headers,Origin:'http://localhost:3000'}}));
try{
 const report=await writeNarrative(calculated,'สรุปประเด็นสำคัญสำหรับผู้บริหารจากข้อมูลสมมติ',new AbortController().signal,message=>console.log(message));
 assert.equal(report.writer.status,'complete');assert.deepEqual(report.evidence,calculated.evidence);
 if(isBoq){assert.deepEqual(report.executive.rows,calculated.executive.rows);assert.deepEqual(report.vendors.map(v=>v.total),calculated.vendors.map(v=>v.total));}
 else assert.ok(report.analyses.every(a=>a.narrative));
 console.log(JSON.stringify({status:'PASS',mode:isBoq?'boq':'generic',model:report.writer.model,sections:report.analyses?.length,slots:report.writer.output.length,summary:report.executive_summary||report.executive.summary,requests:report.writer.requests}));
}catch(error){console.error(error.message);process.exitCode=1;}finally{globalThis.fetch=providerFetch;}
