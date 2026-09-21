import type {Report,BoqReport} from './models';
import {writeStructuredReport} from './structured-writer.ts';

type Slot={id:string;purpose:string;context:string};
type Written={id:string;paragraphs:string[];evidence_ids:string[]};
export async function writeNarrative<T extends Report|BoqReport>(original:T,objective:string,signal:AbortSignal,progress:(message:string,value:number)=>void):Promise<T>{
  if('dynamic_sections' in original&&original.dynamic_sections)return await writeStructuredReport(original,objective,signal,progress) as T;
  const report=structuredClone(original);
  const slots:Slot[]=[];
  const setters:((p:string[])=>void)[]=[];
  const add=(purpose:string,context:unknown,set:(p:string[])=>void)=>{slots.push({id:`S${slots.length}`,purpose,context:JSON.stringify(context)});setters.push(set);};
  if('vendors' in report){
    const overview={tolerance:report.tolerance,tolerance_source:report.tolerance_source,vendors:report.vendors.map(v=>({vendor:v.vendor,project:v.project,benchmark:v.benchmark,total:v.total,insights:v.insights})),files_skipped:report.files_skipped,limitations:'Normalize is a scenario, not realized savings. Different projects or benchmarks must not be ranked as bidders on the same project.'};
    report.vendors.forEach((v,i)=>{
      add('การวิเคราะห์เชิงลึกของผู้เสนองานรายนี้ อธิบายประเด็นสำคัญและสิ่งที่ควรตรวจสอบ',{...overview,vendors:[{vendor:v.vendor,project:v.project,benchmark:v.benchmark,total:v.total,groups:v.groups,axes:v.axes,insights:v.insights}]},p=>{v.insights=p;});
      const signature=report.signatures[i];
      if(signature)add('สรุปแนวโน้มเฉพาะตัวแบบสั้นหนึ่งย่อหน้า',{vendor:v.vendor,total:v.total,signature},p=>{signature.pattern=p.join(' ');});
    });
    add('บทวิเคราะห์เชิงกลยุทธ์ พร้อมข้อเสนอแนะที่มีหลักฐานรองรับ',overview,p=>{report.strategy=p;});
    add('บทสรุปผู้บริหาร ภาพรวมและผลกระทบทางการเงิน',overview,p=>{report.executive.summary=p.join(' ');});
    add('ประเด็นสำคัญสำหรับผู้บริหารและข้อเสนอแนะ',overview,p=>{report.executive.bullets=p;});
    add('ข้อสรุปสำคัญสำหรับผู้บริหารหนึ่งประโยค',overview,p=>{report.executive.headline=p.join(' ');});
  }else{
    const overview={overview:report.dataset_overview,quality:report.data_quality,findings:report.evidence.map(e=>({id:e.evidence_id,finding:e.finding,source:e.source})),limitations:report.limitations,errors:report.errors};
    add('บทสรุปสำหรับผู้บริหาร จัดลำดับประเด็นจากหลักฐานที่มี',overview,p=>{report.executive_summary=p;});
    if(report.dynamic_sections){
      for(const section of report.dynamic_sections){
        const evidence=report.evidence.filter(e=>section.analysis_ids.includes(e.evidence_id));
        add(`เขียนบทวิเคราะห์หัวข้อ ${section.title} เพื่อตอบคำถาม ${section.question} เชื่อมโยงหลักฐานเฉพาะหัวข้อนี้ แยกสิ่งที่พบกับข้อเสนอให้ตรวจสอบ ห้ามอนุมานเหตุและผลหรือนัยสำคัญ`,{evidence,limitations:report.limitations},p=>{section.narrative=p.join('\n\n');});
      }
    }else for(const a of report.analyses){
      const e=report.evidence.find(e=>e.evidence_id===a.evidence_id);
      add('บทวิเคราะห์สั้นประกอบข้อค้นพบ อธิบายความหมายและข้อควรระวัง โดยคงขอบเขตของหลักฐานนี้',e??a,p=>{a.narrative=p.join(' ');});
    }
    add('ข้อเสนอแนะที่นำไปตรวจสอบหรือดำเนินการต่อได้ ห้ามอ้างว่าสาเหตุได้รับการพิสูจน์แล้ว',overview,p=>{report.recommendations=p;});
  }
  const batches:Slot[][]=[];
  for(const slot of slots){
    let batch=batches.at(-1);
    if(!batch||batch.length===6||new TextEncoder().encode(JSON.stringify({objective,slots:[...batch,slot]})).length>90000){batch=[];batches.push(batch);}
    batch.push(slot);
    if(new TextEncoder().encode(JSON.stringify({objective,slots:batch})).length>90000)throw Error('ข้อมูลสรุปใหญ่เกินขอบเขตการเขียนรายงาน ผลคำนวณยังอยู่ครบ');
  }
  const written:Written[]=[];const requests:unknown[]='plan' in report?(report.plan?.requests||(report.plan?.receipt?[report.plan.receipt]:[])):[];let model='';
  for(let i=0;i<batches.length;i++){
    signal.throwIfAborted();progress(`กำลังเขียนรายงาน ${i+1} / ${batches.length}…`,85+Math.round(i/batches.length*13));
    const response=await fetch('/api/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({objective,slots:batches[i]}),signal});
    const result=await response.json() as {error?:string;slots:Written[];model:string;receipt?:unknown};
    if(!response.ok)throw Error(result.error||'เขียนรายงานไม่สำเร็จ');
    if(!Array.isArray(result.slots)||result.slots.length!==batches[i].length)throw Error('รายงานไม่ครบ');
    written.push(...result.slots);model=result.model;if(result.receipt)requests.push(result.receipt);
  }
  signal.throwIfAborted();
  for(const s of slots){const w=written.find(w=>w.id===s.id);if(!w)throw Error('รายงานไม่ครบ');setters[Number(s.id.slice(1))](w.paragraphs);}
  report.writer={status:'complete',model,generated_at:new Date().toISOString(),sources:slots,output:written,requests};
  return report;
}
