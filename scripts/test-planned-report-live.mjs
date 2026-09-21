import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHandler} from '../backend/src/app.mjs';
import {planAndCalculate} from '../frontend/lib/planned-analysis.ts';
import {writeNarrative} from '../frontend/lib/report-writer.ts';
process.loadEnvFile(new URL('../backend/.env',import.meta.url));
const inspect=process.argv.includes('--boq')?`import sys,json,io,openpyxl
sys.path.insert(0,'backend/analysis');import analysis_engine as e
w=openpyxl.Workbook();s=w.active
s.append(['No','รายการ','ปริมาณ RBP','ปริมาณ AAA เสนอ','ราคาของ RBP','ราคาของ AAA เสนอ'])
for i in range(12):s.append([i+1,f'Item {i}',10+i,11+i,100,120+i])
f=io.BytesIO();w.save(f)
b=e.dispatch('inspect_files',{'files':[{'filename':'synthetic-boq.xlsx','bytes':f.getvalue()}]})
` : "import sys,json;sys.path.insert(0,'backend/analysis');import analysis_engine as e;b=e.dispatch('inspect_files',{'files':[{'filename':'sample-data.csv','bytes':open('frontend/public/sample-data.csv','rb').read()}]});";
const book=JSON.parse(execFileSync('python',['-c',inspect+'print(json.dumps(b,ensure_ascii=True))'],{encoding:'utf8'}));
const originalFetch=globalThis.fetch;
const handle=createHandler({apiKey:process.env.GEMINI_API_KEY,model:process.env.GEMINI_MODEL,allowedOrigins:['http://localhost:3000']},originalFetch);
globalThis.fetch=(url,init)=>handle(new Request('http://localhost'+url,{...init,headers:{...init.headers,Origin:'http://localhost:3000'}}));
try{
 const signal=new AbortController().signal;
 let calculations=0;
 const calculate=async selected=>{calculations++;return JSON.parse(execFileSync('python',['-c',inspect+"p=json.load(sys.stdin);print(json.dumps(e.dispatch('analyze_workbook',{'selected_plans':p}),ensure_ascii=True))"],{input:JSON.stringify(selected),encoding:'utf8'}));};
 const raw=await planAndCalculate(book,'วิเคราะห์ความแตกต่างระหว่างทีมและค่าผิดปกติ ไม่ต้องแจกแจงทุกคอลัมน์',signal,calculate);
 const plan=raw.plan;assert.equal(calculations,1);assert.ok(plan.requests.length>=1);
 console.log('Plan:',plan.title,plan.sections.map(s=>s.title));
 const report=await writeNarrative(raw,'วิเคราะห์ความแตกต่างระหว่างทีมและค่าผิดปกติ',signal,message=>console.log(message));
 assert.ok(report.dynamic_sections.every(s=>s.narrative));assert.deepEqual(report.evidence,raw.evidence);assert.ok(plan.receipt.response_id);
 console.log(JSON.stringify({status:'PASS',title:report.metadata.title,sections:report.dynamic_sections.map(s=>({title:s.title,narrative:s.narrative})),requests:report.writer.requests}));
}finally{globalThis.fetch=originalFetch;}
