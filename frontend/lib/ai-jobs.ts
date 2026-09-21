const completed=new Map<string,unknown>();
export function clearAIJobs(){completed.clear();}
export const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
export async function aiJob<T>(path:string,payload:unknown,signal:AbortSignal):Promise<T>{
 signal.throwIfAborted();const body=JSON.stringify(payload);
 if(new TextEncoder().encode(body).length>90000)throw Error('ส่วนข้อมูลนี้ยังใหญ่เกินขอบเขตการส่ง');
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(path+body));
 signal.throwIfAborted();
 const key=Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
 if(completed.has(key))return structuredClone(completed.get(key)) as T;
 const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body,signal:AbortSignal.any([signal,AbortSignal.timeout(110000)])});
 const result=await response.json() as T&{error?:string};
 if(!response.ok)throw Error(result.error||'AI ไม่สามารถประมวลผลงานส่วนนี้ได้');
 signal.throwIfAborted();
 if(completed.size>=256)completed.delete(completed.keys().next().value!);
 completed.set(key,structuredClone(result));return result;
}
// Only transport is compacted; original evidence stays intact in Report JSON.
export function compact(value:unknown,arrayLimit=16,stringLimit=600):unknown{
 if(typeof value==='string')return value.length>stringLimit?{text:value.slice(0,stringLimit),characters_omitted:value.length-stringLimit}:value;
 if(Array.isArray(value)){
  const kept=value.length<=arrayLimit?value:value.filter((_,i)=>i%Math.ceil(value.length/arrayLimit)===0).slice(0,arrayLimit);
  const items=kept.map(v=>compact(v,arrayLimit,stringLimit));return kept.length===value.length?items:{items,total:value.length,omitted:value.length-kept.length};
 }
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,compact(v,arrayLimit,stringLimit)]));
 return value;
}
