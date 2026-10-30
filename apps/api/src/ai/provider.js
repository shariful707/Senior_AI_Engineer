import {AIError,validateProviderURL} from './settings.js';

export async function structuredChat(settings,{messages,schema,name='document_answer'}){
  await validateProviderURL(settings.provider,settings.baseUrl);
  const native=settings.provider==='ollama';
  const grounded=[{role:'system',content:`${messages.filter(item=>item.role==='system').map(item=>item.content).join('\n')}\nReturn JSON matching this exact schema: ${JSON.stringify(schema)}`},...messages.filter(item=>item.role!=='system')];
  const body=native?{model:settings.model,messages:grounded,stream:false,think:false,format:schema,options:{temperature:0,num_ctx:8192,num_predict:2048}}:{model:settings.model,messages:grounded,response_format:settings.responseFormat==='json'?{type:'json_object'}:{type:'json_schema',json_schema:{name,strict:true,schema}}};
  const endpoint=native?'api/chat':'chat/completions';let response;
  const started=performance.now();
  try{response=await fetch(`${settings.baseUrl}/${endpoint}`,{method:'POST',headers:{'Content-Type':'application/json',...(settings.apiKey?{Authorization:`Bearer ${settings.apiKey}`}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(180000),redirect:'error'});}
  catch{throw new AIError(native?'Cannot reach Ollama or the model timed out. Check that Ollama is running.':'AI provider network error or timeout.',503,'AI_PROVIDER_UNAVAILABLE',true);}
  if(!response.ok){
    const message=response.status===401?'The AI provider rejected the API key.':response.status===404?'The model or provider endpoint was not found. Check the model name.':response.status===429?'The AI provider rate or quota limit was reached.':`AI provider returned HTTP ${response.status}.`;
    throw new AIError(message,503,'AI_PROVIDER_ERROR',response.status===429||response.status>=500);
  }
  let raw;try{raw=await response.json();}catch{throw new AIError('The AI provider returned invalid JSON.',503);}
  const message=native?raw.message:raw.choices?.[0]?.message;
  if(message?.refusal)throw new AIError('The model declined this request.',422,'AI_REFUSAL');
  let data;try{data=JSON.parse(message?.content||'');}catch{throw new AIError('The model did not return a complete structured response. Retry or choose another model.',422,'AI_INVALID_OUTPUT');}
  return {data,raw,provider:settings.provider,model:settings.model,latency_ms:Math.round(performance.now()-started),usage:native?{input_tokens:raw.prompt_eval_count||0,output_tokens:raw.eval_count||0}:raw.usage||{}};
}
export async function localModels(baseUrl){
  const base=await validateProviderURL('ollama',baseUrl);let response;
  try{response=await fetch(`${base}/api/tags`,{signal:AbortSignal.timeout(5000),redirect:'error'});}catch{throw new AIError('Ollama is not reachable. Start Ollama, then detect models again.',503);}
  if(!response.ok)throw new AIError('Ollama could not list models.',503);
  const body=await response.json();return (body.models||[]).map(model=>({name:model.name,size:model.size}));
}
