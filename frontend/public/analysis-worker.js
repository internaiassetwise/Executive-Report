let runtime;
async function ready(id) {
  if (!runtime) runtime = (async () => {
    self.postMessage({id, status:'progress', message:'กำลังเตรียมเครื่องมือวิเคราะห์ครั้งแรก…', progress:15});
    importScripts('https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.js');
    const py = await loadPyodide({indexURL:'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/'});
    self.postMessage({id,status:'progress',message:'กำลังโหลดเครื่องมืออ่าน Excel…',progress:35});
    await py.loadPackage('micropip');
    await py.runPythonAsync("import micropip\nawait micropip.install(['openpyxl==3.1.5', 'xlrd==2.0.2'])");
    const response = await fetch('/analysis_engine.py');
    if (!response.ok) throw new Error('โหลดเครื่องมือวิเคราะห์ไม่สำเร็จ');
    await py.runPythonAsync(await response.text());
    return py;
  })().catch(error => {runtime=undefined;throw error;});
  return runtime;
}
self.onmessage = async ({data:{id,action,payload}}) => {
  try {
    const py = await ready(id);
    self.postMessage({id,status:'progress',message:action==='inspect'?'กำลังทำความเข้าใจข้อมูล…':'กำลังคำนวณและตรวจสอบหลักฐาน…',progress:65});
    if(action==='inspect') {
      py.globals.set('_input_bytes',new Uint8Array(payload.bytes));
      py.globals.set('_filename',payload.filename);
      const result=await py.runPythonAsync("json.dumps(inspect(bytes(_input_bytes.to_py()), _filename), ensure_ascii=False, allow_nan=False)");
      py.globals.delete('_input_bytes');
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
