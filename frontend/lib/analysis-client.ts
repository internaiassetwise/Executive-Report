let worker:Worker|null=null;
let pending: {reject:(error:Error)=>void}|null=null;
export function cancelAnalysis(){worker?.terminate();worker=null;pending?.reject(new Error('ยกเลิกการวิเคราะห์แล้ว กรุณาอัปโหลดใหม่เพื่อเริ่มต้น'));pending=null;}
export function runAnalysis<T>(action:string,payload:Record<string,unknown>,progress:(message:string,value:number)=>void):Promise<T>{
  if(pending)return Promise.reject(new Error('กำลังประมวลผล กรุณารอสักครู่'));
  worker??=new Worker('/analysis-worker.js');
  const active=worker;
  return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();
    let timer=setTimeout(()=>{cancelAnalysis();},180000);
    const finish=()=>{clearTimeout(timer);active.removeEventListener('message',onMessage);active.removeEventListener('error',onError);pending=null;};
    const onError=()=>{finish();active.terminate();worker=null;reject(new Error('โหลดเครื่องมือวิเคราะห์ไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตและลองอีกครั้ง'));};
    const onMessage=(e:MessageEvent)=>{if(e.data.id!==id)return;if(e.data.status==='progress'){clearTimeout(timer);timer=setTimeout(()=>cancelAnalysis(),180000);progress(e.data.message,e.data.progress);return;}finish();if(e.data.status==='error')reject(new Error(e.data.message));else resolve(e.data.result);};
    pending={reject:(error)=>{finish();reject(error);}};
    active.addEventListener('message',onMessage);active.addEventListener('error',onError);active.postMessage({id,action,payload});
  });
}
