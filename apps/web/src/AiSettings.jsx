import React,{useEffect,useState} from 'react';
import {Sparkles,RefreshCw,Loader2,CheckCircle2,TriangleAlert} from 'lucide-react';
import {request} from './api.js';

export default function AiSettings({onChange,focus=false}){
  const [active,setActive]=useState(null),[provider,setProvider]=useState('ollama'),[model,setModel]=useState('qwen3.5:4b'),[base,setBase]=useState('http://127.0.0.1:11434'),[key,setKey]=useState(''),[format,setFormat]=useState('strict');
  const [models,setModels]=useState([]),[detecting,setDetecting]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[runId,setRunId]=useState(null),[runStatus,setRunStatus]=useState(''),[busy,setBusy]=useState(false);
  async function load(){
    const result=await request('/api/ai/settings');setActive(result);
    if(result.enabled){setProvider(result.provider);setModel(result.model);setBase(result.base_url);setKey('');}
    return result;
  }
  useEffect(()=>{let alive=true;request('/api/ai/settings').then(result=>{if(!alive)return;setActive(result);if(result.enabled){setProvider(result.provider);setModel(result.model);setBase(result.base_url);}else{setModel(result.defaults?.ollama_model||'qwen3.5:4b');setBase(result.defaults?.ollama_url||'http://127.0.0.1:11434');}}).catch(failure=>{if(alive)setError(failure.message);});return()=>{alive=false;};},[]);
  useEffect(()=>{if(focus)document.getElementById('ai-configuration')?.scrollIntoView({block:'start'});},[focus,active]);
  useEffect(()=>{
    if(!runId)return;let stopped=false,inFlight=false;
    const poll=async()=>{
      if(inFlight)return;inFlight=true;
      try{
        const run=await request(`/api/ai/runs/${runId}`);if(stopped)return;setRunStatus(run.status);
        if(run.status==='completed'){await load();setRunId(null);setBusy(false);setMessage(`${run.result.model} passed a real structured-output test and is now enabled.`);onChange();}
        else if(['failed','cancelled'].includes(run.status)){setError(run.error_message||'Connection test did not complete.');setRunId(null);setBusy(false);}
      }catch(failure){if(!stopped){setError(failure.message);setBusy(false);setRunId(null);}}finally{inFlight=false;}
    };
    poll();const timer=setInterval(poll,1200);return()=>{stopped=true;clearInterval(timer);};
  },[runId]);
  function chooseProvider(value){setProvider(value);setKey('');setError('');setMessage('');setModels([]);setFormat(value==='compatible'?'json':'strict');setModel(value==='ollama'?active?.defaults?.ollama_model||'qwen3.5:4b':value==='openai'?'gpt-4o-mini':'');setBase(value==='ollama'?active?.defaults?.ollama_url||'http://127.0.0.1:11434':value==='openai'?'https://api.openai.com/v1':'');}
  async function detect(){setDetecting(true);setError('');try{const result=await request(`/api/ai/models?base_url=${encodeURIComponent(base)}`);setModels(result.models);if(result.models.length&&!result.models.some(item=>item.name===model))setModel(result.models[0].name);setMessage(result.models.length?`${result.models.length} installed models found.`:'No local models are installed. Install a model in Ollama, then detect again.');}catch(failure){setError(failure.message);}finally{setDetecting(false);}}
  async function enable(event){event.preventDefault();setBusy(true);setError('');setMessage('');try{const run=await request('/api/ai/configure',{method:'POST',body:JSON.stringify({provider,model:model.trim(),base_url:base.trim(),api_key:key,response_format:format})});setRunStatus('queued');setRunId(run.id);}catch(failure){setError(failure.message);setBusy(false);}}
  async function disable(){setBusy(true);setError('');try{const result=await request('/api/ai/disable',{method:'POST'});setActive(result);setRunId(null);setMessage('Offline extraction is active. The document assistant is disabled until a model is connected.');onChange();}catch(failure){setError(failure.message);}finally{setBusy(false);}}
  return <section id="ai-configuration" className="ai-settings">
    <div className="ai-settings-heading"><Sparkles size={20}/><div><h3>AI model connection</h3><p>{active?.enabled?`${active.provider==='ollama'?'Local Ollama':active.provider==='openai'?'OpenAI':'Compatible provider'} · ${active.model}`:'No LLM is connected. Current extraction uses explicit labels.'}</p></div>{active?.enabled&&<span className="ai-connected"><CheckCircle2 size={13}/>Enabled</span>}</div>
    <p className="ai-privacy">{provider==='ollama'?'Local Ollama keeps these model requests on your PC. No API key is needed.':'This provider receives document text for extraction and answers. Store its API key here on the server, never in chat or Git.'}</p>
    <div className="token-explanation"><h4>Why no token for local AI?</h4><p>Ollama runs the model on your computer. This local connection does not use a cloud account, so it needs no cloud API key. The model still processes input and output tokens; these are pieces of text, not passwords.</p><p>The workspace token shown in earlier settings was an optional shared password for access to this app and its documents. It is useful when the server is shared or hosted. It does not connect an LLM. An AI provider API key is separate and is needed when using a cloud provider.</p></div>
    <form onSubmit={enable}>
      <label htmlFor="ai-provider">AI provider</label><select id="ai-provider" value={provider} onChange={event=>chooseProvider(event.target.value)} disabled={busy}><option value="ollama">Local Ollama</option><option value="openai">OpenAI</option><option value="compatible">OpenAI-compatible provider</option></select>
      <label htmlFor="ai-base-url">{provider==='ollama'?'Ollama address':'Provider API base URL'}</label><input id="ai-base-url" type="url" required value={base} onChange={event=>setBase(event.target.value)} readOnly={provider==='openai'} disabled={busy} placeholder="https://provider.example/v1"/>
      {provider==='ollama'&&<button type="button" className="secondary detect-models" onClick={detect} disabled={busy||detecting}>{detecting?<Loader2 size={15} className="spin"/>:<RefreshCw size={15}/>}Detect installed models</button>}
      <label htmlFor="ai-model">AI model</label><input id="ai-model" list="installed-ai-models" required value={model} onChange={event=>setModel(event.target.value)} disabled={busy} placeholder="Enter the exact model name"/><datalist id="installed-ai-models">{models.map(item=><option value={item.name} key={item.name}/>)}</datalist>
      {provider!=='ollama'&&<><label htmlFor="ai-provider-key">AI provider API key</label><input id="ai-provider-key" type="password" autoComplete="off" value={key} onChange={event=>setKey(event.target.value)} disabled={busy} placeholder={active?.has_key&&active.provider===provider?'Key stored on server; leave blank to keep it':'Enter the provider API key'}/><small className="ai-key-note">This is separate from your workspace access token. Saved keys are encrypted and never returned to the browser.</small></>}
      {provider==='compatible'&&<><label htmlFor="ai-response-format">Provider output support</label><select id="ai-response-format" value={format} onChange={event=>setFormat(event.target.value)} disabled={busy}><option value="json">JSON mode</option><option value="strict">Strict JSON Schema</option></select></>}
      {error&&<div className="ai-feedback error" role="alert"><TriangleAlert size={16}/>{error}</div>}{message&&<div className="ai-feedback success" role="status"><CheckCircle2 size={16}/>{message}</div>}
      {busy&&runId&&<div className="ai-feedback" role="status"><Loader2 className="spin" size={16}/>{runStatus==='queued'?'Connection test queued for the worker.':'Testing a real structured model response. A cold local model may take a minute.'}</div>}
      <div className="actions"><button className="primary" disabled={busy}>{busy?<Loader2 className="spin" size={16}/>:<Sparkles size={16}/>}Test and enable AI</button>{active?.enabled&&<button type="button" className="secondary" onClick={disable} disabled={busy}>Use offline extraction</button>}</div>
    </form>
    {active?.verified_at&&<small className="ai-key-note">Last verified {new Date(active.verified_at).toLocaleString()}. New uploads use this model; use Reprocess to update existing results.</small>}
  </section>;
}
