import type {WorkbookProfile,Report,AIPlan} from './models';
import {planAnalysis,applyPlan} from './analysis-planner.ts';

// One planning pass and one deterministic calculation pass. Do not send all
// calculated evidence back through the planner before writing the report.
export async function planAndCalculate(
 profile:WorkbookProfile,objective:string,signal:AbortSignal,
 calculate:(selected:AIPlan['sections'][number]['analyses'])=>Promise<Report>,
 types?:string[],progress:(message:string,value:number)=>void=()=>{},
):Promise<Report>{
 const plan=await planAnalysis(profile,objective,signal,types,undefined,progress);
 signal.throwIfAborted();
 progress('กำลังคำนวณและตรวจสอบหลักฐานตามแผน…',75);
 const selected=[...new Map(plan.sections.flatMap(s=>s.analyses).map(a=>[JSON.stringify([a.table_id,a.analysis_id]),a])).values()];
 const raw=await calculate(selected);
 signal.throwIfAborted();
 return applyPlan(raw,plan);
}
