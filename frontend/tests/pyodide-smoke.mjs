import {loadPyodide} from 'pyodide';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
async function main(){
const py=await loadPyodide();
await py.loadPackage('micropip');
await py.runPythonAsync("import micropip\nawait micropip.install(['openpyxl==3.1.5','xlrd==2.0.2'])");
await py.runPythonAsync(await fs.readFile(new URL('../../backend/analysis/analysis_engine.py',import.meta.url),'utf8'));
py.globals.set('_input_bytes',new Uint8Array(await fs.readFile(new URL('../public/sample-data.csv',import.meta.url))));
py.globals.set('_filename','sample-data.csv');
const book=JSON.parse(await py.runPythonAsync("json.dumps(inspect(bytes(_input_bytes.to_py()), _filename), ensure_ascii=False, allow_nan=False)"));
assert.equal(book.tables[0].rows_count,72);
const table=book.tables[0];
py.globals.set('_request_json',JSON.stringify({table_id:table.id,selected:table.opportunities.map(p=>p.id)}));
const report=JSON.parse(await py.runPythonAsync("json.dumps(dispatch('analyze', json.loads(_request_json)), ensure_ascii=False, allow_nan=False)"));
assert.ok(report.analyses.length>10);assert.equal(report.evidence.length,report.analyses.length);
assert.ok(report.analyses.some(r=>r.type==='correlation'));
await py.runPythonAsync(`import openpyxl
b=openpyxl.Workbook()
s=b.active
s.title='Small'
for row in [['Item','Amount'],['A',10],['B',20]]:s.append(row)
s=b.create_sheet('Wide')
for row in [['Item','Missing A','Missing B','Amount'],['C',None,None,100],['D',None,None,200]]:s.append(row)
b.create_sheet('Empty')
f=io.BytesIO()
b.save(f)
x=inspect(f.getvalue(),'runtime.xlsx')
assert x['sheets_count']==3`);
const progress=[];
py.globals.set('_report_progress',(done,total,sheet)=>progress.push({done,total,sheet}));
const whole=JSON.parse(await py.runPythonAsync("json.dumps(dispatch('analyze_workbook', {}, _report_progress), ensure_ascii=False, allow_nan=False)"));
assert.equal(whole.data_quality.completeness,66.7);
assert.deepEqual(whole.analyses.filter(r=>r.type==='statistics').map(r=>[r.source.sheet,r.data.mean]),[['Small',15],['Wide',150]]);
assert.equal(new Set(whole.evidence.map(e=>e.evidence_id)).size,whole.analyses.length);
assert.equal(progress.at(-1).done,2);
assert.equal(whole.dataset_overview.sheets.at(-1).status,'no_table');
// BOQ comparison path: the two modules are files on the Pyodide FS, exactly
// as the worker installs them, and a side-by-side two-vendor workbook built
// in the runtime goes through dispatch('boq') and dispatch('boq_rebuild').
py.FS.writeFile('/home/pyodide/boq_engine.py',await fs.readFile(new URL('../../backend/analysis/boq_engine.py',import.meta.url),'utf8'));
py.FS.writeFile('/home/pyodide/boq_report.py',await fs.readFile(new URL('../../backend/analysis/boq_report.py',import.meta.url),'utf8'));
await py.runPythonAsync("import sys\nif '/home/pyodide' not in sys.path: sys.path.insert(0,'/home/pyodide')");
const boqProgress=[];
py.globals.set('_report_progress',(done,total,name)=>boqProgress.push({done,total,name}));
const boq=JSON.parse(await py.runPythonAsync(`import openpyxl, io
b=openpyxl.Workbook(); b.remove(b.active)
for sheet in ('ST_A','AR_A'):
    s=b.create_sheet(sheet)
    s.append(['No','รายการ','ปริมาณ RBP','ปริมาณ AAA เสนอ','ปริมาณ BBB เสนอ','ราคาของ RBP','ราคาของ AAA เสนอ','ราคาของ BBB เสนอ','ราคาแรง RBP','ราคาแรง AAA เสนอ','ราคาแรง BBB เสนอ'])
    for i in range(12):
        q=10.0*(i+1); s.append([i+1,f'Item {i}',q,q,q*1.2,100.0,200.0 if i==0 else 100.0,100.0,50.0,50.0,52.5])
f=io.BytesIO(); b.save(f)
json.dumps(dispatch('boq',{'files':[{'filename':'compare.xlsx','bytes':f.getvalue()}]},_report_progress),ensure_ascii=False,allow_nan=False)`));
assert.equal(boq.mode,'boq');
assert.deepEqual(boq.report.vendors.map(v=>v.vendor),['AAA','BBB']);
assert.deepEqual(boq.report.categories,['ST','AR']);
assert.equal(boq.report.categories_missing,false);
assert.equal(boq.report.vendors[1].total.quantity_over,24);
assert.ok(boq.html.includes('ผู้เสนองาน: AAA')&&boq.html.includes('การวิเคราะห์เปรียบเทียบภาพรวมทุกเจ้า'));
assert.deepEqual(boqProgress,[{done:1,total:1,name:'compare.xlsx'}]);
const rebuilt=JSON.parse(await py.runPythonAsync("json.dumps(dispatch('boq_rebuild',{'tolerance':0.01}),ensure_ascii=False,allow_nan=False)"));
assert.equal(rebuilt.report.tolerance_source,'declared');
console.log(JSON.stringify({runtime:py.version,rows:table.rows_count,analyses:report.analyses.length,evidence:report.evidence.length,xlsx:'passed',boq:boq.report.vendors.length}));
}
main().catch(e=>{console.error(String(e.message).slice(-4000));process.exitCode=1;});
