export class ApiError extends Error {
  constructor(message,status=0,code=''){super(message);this.status=status;this.code=code;}
}
let token='';
try{token=sessionStorage.getItem('folio-token')||'';}catch{}
export const getToken=()=>token;
export function setToken(value){
  token=value.trim();
  try{if(token)sessionStorage.setItem('folio-token',token);else sessionStorage.removeItem('folio-token');}catch{}
}
export const authHeaders=()=>token?{Authorization:`Bearer ${token}`} : {};
export async function request(url,{timeout=20000,...options}={}){
  let response;
  try{
    response=await fetch(url,{...options,headers:{...authHeaders(),...(options.body?{'Content-Type':'application/json'}:{}),...options.headers},signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout)});
  }catch(error){
    if(options.signal?.aborted)throw error;
    throw new ApiError(error.name==='TimeoutError'?'The workspace took too long to respond. Please retry.':'Cannot reach the workspace. Check that the app is running, then retry.');
  }
  let result;
  try{result=await response.json();}catch{throw new ApiError('The server returned an unexpected response. Refresh or restart the app.',response.status);}
  if(!result||typeof result!=='object'||Array.isArray(result))throw new ApiError('The server returned an unexpected response. Refresh or restart the app.',response.status);
  if(!response.ok)throw new ApiError(result.error?.message||'The request could not be completed.',response.status,result.error?.code);
  return result;
}
export function uploadFiles(files,onProgress){
  return new Promise((resolve,reject)=>{
    const form=new FormData();for(const file of files)form.append('files[]',file);
    const xhr=new XMLHttpRequest();xhr.open('POST','/api/documents');xhr.timeout=120000;
    for(const [name,value]of Object.entries(authHeaders()))xhr.setRequestHeader(name,value);
    xhr.upload.onprogress=event=>{if(event.lengthComputable)onProgress(Math.round(event.loaded/event.total*100));};
    xhr.onload=()=>{
      let result;try{result=JSON.parse(xhr.responseText);}catch{reject(new ApiError('Upload received an unexpected server response.'));return;}
      if(xhr.status>=400)reject(new ApiError(result.error?.message||'Upload failed.',xhr.status));else resolve(result);
    };
    xhr.onerror=()=>reject(new ApiError('Upload could not reach the workspace. Check your connection and retry.'));
    xhr.ontimeout=()=>reject(new ApiError('The upload timed out. Try fewer or smaller files.'));
    xhr.onabort=()=>reject(new ApiError('Upload was interrupted. Select the files again to retry.'));
    xhr.send(form);
  });
}
export async function downloadFile(id,filename){
  let response;
  try{response=await fetch(`/api/documents/${id}/file`,{headers:authHeaders(),signal:AbortSignal.timeout(30000)});}
  catch{throw new ApiError('Could not download the source file. Check your connection and retry.');}
  if(!response.ok){const error=await response.json().catch(()=>null);throw new ApiError(error?.error?.message||'The source file could not be downloaded.',response.status);}
  const url=URL.createObjectURL(await response.blob());
  const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;document.body.append(anchor);anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),10000);
}
