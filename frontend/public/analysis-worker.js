let runtime;
async function source(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error('โหลดเครื่องมือวิเคราะห์ไม่สำเร็จ');
  return response.text();
}
async function ready(id) {
  if (!runtime) runtime = (async () => {
    self.postMessage({id, status:'progress', message:'กำลังเตรียมเครื่องมือวิเคราะห์ครั้งแรก…', progress:15});
    importScripts('https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.js');
    const py = await loadPyodide({indexURL:'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/'});
    self.postMessage({id,status:'progress',message:'กำลังโหลดเครื่องมืออ่าน Excel…',progress:35});
    await py.loadPackage('micropip');
    await py.runPythonAsync("import micropip\nawait micropip.install(['openpyxl==3.1.5', 'xlrd==2.0.2'])");
    // The generic engine runs in __main__; the BOQ modules are importable
    // files so analysis_engine can pull them in on demand.
    const [engine, boqEngine, boqReport] = await Promise.all([source('/analysis_engine.py'), source('/boq_engine.py'), source('/boq_report.py')]);
    py.FS.writeFile('/home/pyodide/boq_engine.py', boqEngine);
    py.FS.writeFile('/home/pyodide/boq_report.py', boqReport);
    await py.runPythonAsync("import sys\nif '/home/pyodide' not in sys.path: sys.path.insert(0, '/home/pyodide')");
    await py.runPythonAsync(engine);
    return py;
  })().catch(error => {runtime=undefined;throw error;});
  return runtime;
}
self.onmessage = async ({data:{id,action,payload}}) => {
  try {
    const py = await ready(id);
    const opening = {inspect:'กำลังทำความเข้าใจข้อมูล…', boq:'กำลังอ่านไฟล์และตรวจโครงสร้าง BOQ…', boq_rebuild:'กำลังคำนวณใหม่ตามเกณฑ์ที่กำหนด…'};
    self.postMessage({id,status:'progress',message:opening[action]||'กำลังคำนวณและตรวจสอบหลักฐาน…',progress:65});
    if(action==='inspect') {
      py.globals.set('_input_bytes',new Uint8Array(payload.bytes));
      py.globals.set('_filename',payload.filename);
      const result=await py.runPythonAsync("json.dumps(inspect(bytes(_input_bytes.to_py()), _filename), ensure_ascii=False, allow_nan=False)");
      py.globals.delete('_input_bytes');
      self.postMessage({id,status:'complete',result:JSON.parse(result)});
    } else if(action==='boq'||action==='boq_rebuild') {
      // Bytes cross into Python as typed arrays, never through JSON.
      if(action==='boq'){
        py.globals.set('_boq_names',payload.files.map(f=>f.filename));
        py.globals.set('_boq_bytes',payload.files.map(f=>new Uint8Array(f.bytes)));
      }
      py.globals.set('_boq_tol',payload.tolerance??null);
      py.globals.set('_report_progress',(done,total,label)=>self.postMessage({id,status:'progress',message:`กำลังอ่านไฟล์ ${done} / ${total} · ${label}`,progress:10+Math.round(done/total*80)}));
      const code=action==='boq'
        ?"json.dumps(dispatch('boq', {'files':[{'filename':n,'bytes':bytes(b.to_py())} for n,b in zip(_boq_names.to_py(), _boq_bytes)], 'tolerance': _boq_tol}, _report_progress), ensure_ascii=False, allow_nan=False)"
        :"json.dumps(dispatch('boq_rebuild', {'tolerance': _boq_tol}), ensure_ascii=False, allow_nan=False)";
      const result=await py.runPythonAsync(code);
      for(const name of ['_boq_names','_boq_bytes','_boq_tol','_report_progress'])if(py.globals.has(name))py.globals.delete(name);
      self.postMessage({id,status:'complete',result:JSON.parse(result)});
    } else {
      py.globals.set('_request_json',JSON.stringify(payload));
      py.globals.set('_request_action',action);
      py.globals.set('_report_progress',(done,total,sheet)=>self.postMessage({id,status:'progress',message:`กำลังวิเคราะห์ตาราง ${done} / ${total} · ${sheet}`,progress:10+Math.round(done/total*85)}));
      const result=await py.runPythonAsync("json.dumps(dispatch(_request_action, json.loads(_request_json), _report_progress), ensure_ascii=False, allow_nan=False)");
      py.globals.delete('_report_progress');
      self.postMessage({id,status:'complete',result:JSON.parse(result)});
    }
  } catch(error) {
    self.postMessage({id,status:'error',message:String(error.message||error).split('\n').filter(Boolean).slice(-1)[0]});
  }
};
