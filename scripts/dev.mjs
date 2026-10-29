import {spawn,spawnSync} from 'node:child_process';
import path from 'node:path';
import {existsSync} from 'node:fs';
import 'dotenv/config';
const python=process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python';
if(!existsSync(python))throw new Error('Create .venv and install apps/ocr-service/requirements.txt first; see README.');
const children=[];
const launch=(command,args,options={})=>{
  const child=spawn(command,args,{stdio:'inherit',...options});children.push(child);
  child.on('error',error=>{console.error(error);stop(1);});child.on('exit',code=>{if(code && !stopping){console.error(`Process exited: ${code}`);stop(code);}});
};
let stopping=false;
function stop(code=0){
  if(stopping)return;stopping=true;process.exitCode=code;
  for(const child of children){
    // Windows venv launchers can spawn a second Python process. Stop the
    // complete process tree that this launcher owns, including that redirector.
    if(process.platform==='win32'&&child.pid)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
    else child.kill('SIGTERM');
  }
}
launch(path.resolve(python),['-m','uvicorn','app.main:app','--app-dir','apps/ocr-service','--host','127.0.0.1','--port','8000']);
launch(process.execPath,['apps/api/src/server.js']);
launch(process.execPath,['apps/worker/src/main.js']);
launch(process.execPath,['node_modules/vite/bin/vite.js','--config','apps/web/vite.config.js','apps/web']);
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>stop(0));
