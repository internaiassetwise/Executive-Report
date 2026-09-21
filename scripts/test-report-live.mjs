// Explicit smoke check with synthetic data only. Never prints credentials.
import {createHandler} from '../backend/src/app.mjs';
process.loadEnvFile(new URL('../backend/.env',import.meta.url));
const handle=createHandler({apiKey:process.env.GEMINI_API_KEY,model:process.env.GEMINI_MODEL,allowedOrigins:['http://localhost:3000']},async(...args)=>{
 let response;
 try{response=await fetch(...args);}catch(error){console.log(JSON.stringify({networkError:error.name,code:error.cause?.code}));throw error;}
 if(response.ok){const data=await response.clone().json();console.log(JSON.stringify({finish:data.candidates?.[0]?.finishReason,response_id:data.responseId,total_tokens:data.usageMetadata?.totalTokenCount}));}
 if(!response.ok){const error=(await response.clone().json()).error;console.log(JSON.stringify({providerStatus:response.status,providerCode:error?.status}));}
 return response;
});
const response=await handle(new Request('http://localhost/api/report',{method:'POST',headers:{Origin:'http://localhost:3000'},body:JSON.stringify({objective:'เขียนบทสรุปจากข้อมูลสมมติสำหรับทดสอบระบบ',slots:[{id:'S0',purpose:'บทสรุปสำหรับผู้บริหาร',context:JSON.stringify({dataset:'ข้อมูลทดสอบสมมติ',rows:20,completeness:100,finding:'ค่าเฉลี่ย 10 บาท ไม่สามารถระบุสาเหตุได้'})}]})}));
const result=await response.json();
console.log(JSON.stringify({status:response.status,model:result.model,slots:result.slots?.length,error:result.error}));
if(!response.ok)process.exitCode=1;
