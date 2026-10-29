import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdir,open} from 'node:fs/promises';
import path from 'node:path';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
export async function startHarness({dataDir,mode='offline'}={}){
  const apiPort=await freePort(),ocrPort=await freePort();
  await mkdir(dataDir,{recursive:true});
  const env={...process.env,PORT:String(apiPort),HOST:'127.0.0.1',OCR_URL:`http://127.0.0.1:${ocrPort}`,DATA_DIR:dataDir,DATABASE_URL:'',REDIS_URL:'',EXTRACTION_MODE:mode,API_TOKEN:'',INTERNAL_TOKEN:'',NODE_ENV:'test',SEMANTIC_SEARCH:'false'};
  const python=path.resolve(process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
  const children=[],log=await open(path.join(dataDir,'services.log'),'w');
  const launch=(exe,args)=>{
    const child=spawn(exe,args,{env,stdio:['ignore',log.fd,log.fd],windowsHide:true});children.push(child);return child;
  };
  const stop=async()=>{
    for(const c of children)c.kill('SIGTERM');
    await Promise.all(children.map(c=>c.exitCode!==null?null:new Promise(r=>{c.once('exit',r);setTimeout(()=>{c.kill('SIGKILL');r();},3000).unref();})));
    await log.close();
  };
  try{
    launch(python,['-m','uvicorn','app.main:app','--app-dir','apps/ocr-service','--host','127.0.0.1','--port',String(ocrPort)]);
    launch(process.execPath,['apps/api/src/server.js']);
    for(const url of [`http://127.0.0.1:${ocrPort}/health`,`http://127.0.0.1:${apiPort}/health`]){
      let ready=false;
      for(let n=0;n<100;n++){
        if(children.some(c=>c.exitCode!==null))throw new Error(`A service exited. See ${dataDir}/services.log`);
        try{const response=await fetch(url);if(response.ok){ready=true;break;}}catch{}
        await delay(200);
      }
      if(!ready)throw new Error(`Service failed to start: ${url}. See ${dataDir}/services.log`);
    }
    launch(process.execPath,['apps/worker/src/main.js']);
    return {base:`http://127.0.0.1:${apiPort}`,stop};
  }catch(error){await stop();throw error;}
}
export async function uploadFixture(base,filename){
  const {readFile}=await import('node:fs/promises');
  const form=new FormData();form.append('files[]',new Blob([await readFile(path.join('eval/fixtures',filename))]),filename);
  const response=await fetch(`${base}/api/documents`,{method:'POST',body:form});
  const json=await response.json();if(!response.ok)throw new Error(JSON.stringify(json));return json.documents[0].id;
}
export async function waitDocument(base,id,timeout=180000){
  const end=Date.now()+timeout;
  while(Date.now()<end){const doc=await (await fetch(`${base}/api/documents/${id}`)).json();if(['completed','needs_review','failed'].includes(doc.status))return doc;await delay(200);}
  throw new Error(`Timed out processing ${id}`);
}
