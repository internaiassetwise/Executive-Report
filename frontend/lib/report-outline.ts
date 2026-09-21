import type {Report} from './models';
type Section=NonNullable<Report['dynamic_sections']>[number];
const topicOrder=['quality','statistics','frequency','category','trend','distribution','outliers','correlation','other'];
// Group headings only: never aggregate values or infer compatible units.
export function consolidateOutline(report:Report):Section[]{
 const seen=new Set<string>();
 const sections=(report.dynamic_sections||[]).map(s=>({...s,analysis_ids:[...new Set(s.analysis_ids)]})).filter(s=>{
  const key=JSON.stringify([...s.analysis_ids].sort());
  if(!s.analysis_ids.length||seen.has(key))return false;
  seen.add(key);return true;
 });
 if(sections.length<=12)return sections;
 const groups=new Map<string,Set<string>>();
 const types=new Map(report.analyses.map(a=>[a.evidence_id,a.type]));
 for(const section of sections)for(const id of section.analysis_ids){
  const type=types.get(id)||report.evidence.find(e=>e.evidence_id===id)?.type||'other';
  const key=topicOrder.includes(type)?type:'other';
  if(!groups.has(key))groups.set(key,new Set());
  groups.get(key)!.add(id);
 }
 const grouped=topicOrder.filter(key=>groups.has(key)).map(key=>{
  const ids=[...groups.get(key)!];
  const anchor=sections.find(s=>s.analysis_ids.some(id=>ids.includes(id)))!;
  return {title:anchor.title,question:anchor.question,analysis_ids:ids};
 });
 const merged=new Map<string,Section>();
 for(const section of grouped){
  const key=section.title.trim().toLocaleLowerCase('th-TH')+'\n'+section.question.trim().toLocaleLowerCase('th-TH');
  const current=merged.get(key);
  if(current)current.analysis_ids=[...new Set([...current.analysis_ids,...section.analysis_ids])];
  else merged.set(key,{...section});
 }
 return [...merged.values()];
}
export function displayEvidenceIds(report:Report,ids:string[],limit=3):string[]{
 const available=report.analyses.filter(a=>ids.includes(a.evidence_id));
 const picked:string[]=[],tables=new Set<string>();
 for(const a of available){const table=a.source?.table_id||'';if(!tables.has(table)){picked.push(a.evidence_id);tables.add(table);}if(picked.length===limit)return picked;}
 for(const a of available){if(!picked.includes(a.evidence_id))picked.push(a.evidence_id);if(picked.length===limit)break;}
 return picked;
}
