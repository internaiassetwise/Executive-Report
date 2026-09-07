import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evidenceBatches} from '../lib/interpretation.ts';

test('all 804 findings retain unique IDs and source through Gemini request batches',()=>{
 const evidence=Array.from({length:804},(_,i)=>({evidence_id:`EV-${i+1}`,finding:'ผลคำนวณจากข้อมูล'.repeat(85),method:'ค่าเฉลี่ยต่อหมวดหมู่',source:{sheet:`Sheet${Math.floor(i/20)+1}`,table_id:`T${Math.floor(i/4)+1}`,range:'A1:B3',source_columns:[]}}));
 const objective='ตรวจสอบข้อมูล'.repeat(60);
 const batches=evidenceBatches(evidence,objective);
 assert.deepEqual(batches.flat().map(e=>e.evidence_id),evidence.map(e=>e.evidence_id));
 assert.ok(batches.length>8);
 for(const batch of batches){
  assert.ok(batch.length<=100);
  assert.ok(Buffer.byteLength(JSON.stringify({evidence:batch,objective}))<=80000);
  for(const e of batch)assert.match(e.method,/Sheet\d+!A1:B3 \(T\d+\)/);
 }
});

test('evidence length overflow is explicit instead of silently truncating findings',()=>{
 assert.throws(()=>evidenceBatches([{evidence_id:'EV-1',finding:'x'.repeat(2001),method:'method',source:{sheet:'Sheet1',table_id:'T001',range:'A1:B3'}}],''));
});
