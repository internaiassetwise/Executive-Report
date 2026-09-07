import type {Evidence} from './models';

type InterpretationEvidence={evidence_id:string;finding:string;method:string};
// Stay within the backend's evidence-count and UTF-8 request-size limits.
// Every finding is retained; batches never combine calculations across tables.
export function evidenceBatches(evidence:Evidence[],objective:string){
 const batches:InterpretationEvidence[][]=[];
 let batch:InterpretationEvidence[]=[];
 const encoder=new TextEncoder();
 for(const e of evidence){
  const source=`ที่มา ${e.source.sheet}!${e.source.range} (${e.source.table_id})`;
  const entry={evidence_id:e.evidence_id,finding:e.finding,method:`${source} · ${e.method}`};
  if(entry.finding.length>2000||entry.method.length>500)throw new Error('ข้อความหลักฐานยาวเกินขอบเขต Gemini ผลคำนวณทั้งหมดอยู่ในรายงานแล้ว');
  if(batch.length===100||encoder.encode(JSON.stringify({evidence:[...batch,entry],objective})).byteLength>80000){batches.push(batch);batch=[];}
  batch.push(entry);
 }
 if(batch.length)batches.push(batch);
 return batches;
}
