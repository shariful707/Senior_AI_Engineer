import React,{useEffect,useRef,useState} from 'react';
import {ArrowUpRight,ArrowLeft,ArrowRight,Check,CheckCircle2,ChevronRight,Clock3,Download,File,FileCheck2,Files,FileSpreadsheet,FileText,Layers3,Loader2,RefreshCw,Search,ShieldCheck,SlidersHorizontal,TriangleAlert,Upload,Workflow,X,FlaskConical,Settings,LogOut,Sparkles} from 'lucide-react';
import {request,getToken,setToken,uploadFiles,downloadFile} from './api.js';
import AiSettings from './AiSettings.jsx';
import DocumentAssistant from './DocumentAssistant.jsx';

const labels={completed:'Verified',needs_review:'Needs review',processing:'Processing',queued:'Queued',failed:'Failed'};
const scalarFields=['invoice_number','invoice_date','supplier_name','customer_name','subtotal','tax','total','currency'];
const numericFields=['subtotal','tax','total'];
const freshList=()=>({documents:[],counts:{},total:0,pages:0,sample_count:0});
const pretty=value=>value.replaceAll('_',' ').replace(/^./,letter=>letter.toUpperCase());
const money=(amount,currency)=>amount==null?'—':new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(amount)+(currency?` ${currency}`:'');
const date=value=>new Date(value).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
function Badge({status,stage}){return <span className={`badge ${status}`}><i/>{labels[status]||status}{status==='processing'&&stage?` · ${stage}`:''}</span>;}
function Alert({type='error',children,onDismiss}){return <div className={`alert ${type}`} role={type==='error'?'alert':'status'}>{type==='error'?<TriangleAlert size={18}/>:<CheckCircle2 size={18}/>}<span>{children}</span>{onDismiss&&<button aria-label="Dismiss message" onClick={onDismiss}><X size={16}/></button>}</div>;}

export default function App(){
  const [health,setHealth]=useState(null),[healthError,setHealthError]=useState('');
  const [list,setList]=useState(freshList),[listError,setListError]=useState(''),[loading,setLoading]=useState(true);
  const [search,setSearch]=useState(''),[query,setQuery]=useState(''),[status,setStatus]=useState(''),[page,setPage]=useState(1),[mode,setMode]=useState('keyword'),[sampleOnly,setSampleOnly]=useState(false);
  const [selected,setSelected]=useState(location.hash.slice(1)),[detail,setDetail]=useState(null),[detailError,setDetailError]=useState('');
  const [editing,setEditing]=useState(false),[draft,setDraft]=useState(null),[busy,setBusy]=useState(false);
  const [notice,setNotice]=useState(null),[uploading,setUploading]=useState(null),[drag,setDrag]=useState(false),[sampleBusy,setSampleBusy]=useState(false);
  const [refresh,setRefresh]=useState(0),[settings,setSettings]=useState(false),[focusAI,setFocusAI]=useState(false),[accessDenied,setAccessDenied]=useState(false);
  const input=useRef(),settingsButton=useRef(),accessPrompted=useRef(false);
  const reload=()=>setRefresh(value=>value+1);
  useEffect(()=>{const timer=setTimeout(()=>{setQuery(search);setPage(1);},350);return()=>clearTimeout(timer);},[search]);
  useEffect(()=>{
    const navigate=()=>{setSelected(location.hash.slice(1));setDetail(null);setDetailError('');setEditing(false);};
    addEventListener('hashchange',navigate);return()=>removeEventListener('hashchange',navigate);
  },[]);
  useEffect(()=>{
    const abort=new AbortController();
    const load=()=>request('/health',{signal:abort.signal}).then(result=>{setHealth(result);setHealthError('');}).catch(error=>{if(!abort.signal.aborted){setHealth(null);setHealthError(error.message);}});
    load();const timer=setInterval(load,10000);return()=>{abort.abort();clearInterval(timer);};
  },[refresh]);
  useEffect(()=>{
    const abort=new AbortController();let active=false;
    async function load(){
      if(active)return;active=true;
      try{
        const result=await request(`/api/documents?${new URLSearchParams({query,status,page,mode,sample:sampleOnly?'true':''})}`,{signal:abort.signal});
        if(!abort.signal.aborted){setList(result);setListError('');setAccessDenied(false);accessPrompted.current=false;}
      }catch(error){
        if(!abort.signal.aborted){setListError(error.message);if(error.status===401){setAccessDenied(true);setList(freshList());if(!accessPrompted.current){accessPrompted.current=true;setSettings(true);}}}
      }finally{if(!abort.signal.aborted)setLoading(false);active=false;}
    }
    setLoading(true);load();const timer=setInterval(load,2500);
    return()=>{abort.abort();clearInterval(timer);};
  },[query,status,page,mode,sampleOnly,refresh]);
  useEffect(()=>{
    if(!selected||editing||accessDenied)return;
    const abort=new AbortController();let active=false,missing=false;
    async function load(){
      if(active||missing)return;active=true;
      try{const result=await request(`/api/documents/${selected}`,{signal:abort.signal});if(!abort.signal.aborted){setDetail(result);setDetailError('');}}
      catch(error){if(!abort.signal.aborted){setDetailError(error.message);if(error.status===404)missing=true;if(error.status===401){setAccessDenied(true);setDetail(null);if(!accessPrompted.current){accessPrompted.current=true;setSettings(true);}}}}
      finally{active=false;}
    }
    load();const timer=setInterval(load,2000);return()=>{abort.abort();clearInterval(timer);};
  },[selected,editing,accessDenied,refresh]);
  const home=()=>{
    location.hash='';setSelected('');setDetail(null);setDetailError('');setEditing(false);setSearch('');setQuery('');setStatus('');setPage(1);setMode('keyword');setSampleOnly(false);setSettings(false);
  };
  function filter(next){home();setStatus(next);}
  function openDocument(id){setNotice(null);location.hash=id;}
  async function upload(files){
    files=Array.from(files||[]);if(!files.length||uploading!==null)return;
    if(input.current)input.current.value='';
    const limit=health?.limits?.max_upload_mb||25;
    if(files.length>(health?.limits?.max_files||20)){setNotice({type:'error',message:'Choose up to 20 files in one upload.'});return;}
    if(files.some(file=>file.size>limit*1024*1024)){setNotice({type:'error',message:`Each file must be ${limit} MB or smaller.`});return;}
    if(files.some(file=>! /\.(pdf|jpe?g|png|tiff?|xlsx?|csv)$/i.test(file.name))){setNotice({type:'error',message:'Choose PDF, JPG, PNG, TIFF, XLSX, XLS or CSV files.'});return;}
    setNotice(null);setUploading(0);
    try{const result=await uploadFiles(files,setUploading);home();reload();setNotice({type:'success',message:`${result.documents.length} document${result.documents.length===1?'':'s'} uploaded. Processing continues in the background.`});}
    catch(error){setNotice({type:'error',message:error.message});}
    finally{setUploading(null);if(input.current)input.current.value='';}
  }
  async function loadSamples(){
    if(sampleBusy)return;setSampleBusy(true);setNotice(null);
    try{
      const result=await request('/api/workspace/samples',{method:'POST'});home();setSampleOnly(true);reload();
      setNotice({type:'success',message:result.documents.some(document=>document.status==='queued')?'Sample documents added. Their real processing results will appear shortly.':'Sample documents are ready. You can inspect, edit and reprocess them.'});
    }catch(error){setNotice({type:'error',message:error.message});}
    finally{setSampleBusy(false);}
  }
  async function save(){
    setBusy(true);setNotice(null);
    try{const result=await request(`/api/documents/${selected}`,{method:'PATCH',headers:{'If-Match':String(detail.revision)},body:JSON.stringify(draft)});setDetail(result);setEditing(false);reload();setNotice({type:'success',message:'Changes saved. Validation and related documents have been checked again.'});}
    catch(error){setNotice({type:'error',message:error.message});}finally{setBusy(false);}
  }
  async function reprocess(){
    setBusy(true);setNotice(null);
    try{await request(`/api/documents/${selected}/reprocess`,{method:'POST'});setDetail(current=>({...current,status:'queued',stage:'queued',error_message:null}));reload();setNotice({type:'success',message:'Document queued for reprocessing.'});}
    catch(error){setNotice({type:'error',message:error.message});}finally{setBusy(false);}
  }
  async function download(){try{await downloadFile(selected,detail.original_filename);}catch(error){setNotice({type:'error',message:error.message});}}
  const updateField=(field,value)=>setDraft(current=>({...current,[field]:numericFields.includes(field)?value===''?null:Number(value):value||null}));
  const total=Object.values(list.counts).reduce((sum,count)=>sum+count,0),processing=(list.counts.processing||0)+(list.counts.queued||0);
  const filtered=Boolean(search||status||sampleOnly||mode!=='keyword');
  const openAI=()=>{setFocusAI(true);setSettings(true);};
  const closeSettings=()=>{setSettings(false);setFocusAI(false);settingsButton.current?.focus();};
  return <div className="shell">
    <aside className="sidebar">
      <a href="#" className="brand" aria-label="Folio home" onClick={event=>{event.preventDefault();home();}}><span className="brand-mark"><Layers3 size={22}/></span>folio<span className="brand-dot">.</span></a>
      <button type="button" className="workspace" aria-label="Open Finance workspace" title="Open workspace documents" onClick={home}><span className="workspace-avatar">F</span><span>Finance workspace<small>Document intelligence</small></span><ShieldCheck size={15}/></button>
      <span className="nav-caption">WORKSPACE</span>
      <button className={`nav-link ${status!=='needs_review'?'active':''}`} onClick={home}><Files size={18}/>Documents<span>{total}</span></button>
      <button className={`nav-link ${status==='needs_review'?'active':''}`} onClick={()=>filter('needs_review')}><ShieldCheck size={18}/>Review queue<span className="review-count">{list.counts.needs_review||0}</span></button>
      <div className="sidebar-note"><Workflow size={22}/><strong>From file to clarity.</strong><p>Extract the details.<br/>Catch what needs a second look.</p><div className="status-line"><i/>{health?`${health.extraction_mode==='offline'?'Offline extraction':health.ai?.model||'AI extraction'} active`:'Connecting to workspace'}</div></div>
      <button ref={settingsButton} className="profile" aria-label="Workspace settings" onClick={()=>{setFocusAI(false);setSettings(true);}}><span className="profile-avatar">FW</span><div>Workspace settings<small>{health?.authentication?(accessDenied?'Access key required':'Protected workspace'):'Local access · No token'}</small></div><Settings size={17}/></button>
    </aside>
    <main>
      <header className="topbar"><span><button onClick={home}>Workspace</button><ChevronRight size={13}/><button onClick={home}>Documents</button>{selected&&<><ChevronRight size={13}/><strong>Document review</strong></>}</span><span className="topbar-right"><button className="text-link" onClick={openAI}><Sparkles size={14}/>AI settings</button><i/>{accessDenied?'Access key required':healthError||listError?'Connection issue':!health?'Connecting…':processing?`${processing} in progress`:'Workspace connected'}</span></header>
      <div className="content">
        {notice&&<Alert type={notice.type} onDismiss={()=>setNotice(null)}>{notice.message}</Alert>}
        {healthError&&<Alert>{healthError} <button className="text-link" onClick={reload}>Retry connection</button></Alert>}
        {!selected?<>
          <div className="page-heading"><div><div className="eyebrow">YOUR DOCUMENT WORKSPACE</div><h1>Every document. <span>Understood.</span></h1><p>Turn invoices and ledgers into information you can trust.</p></div><div className="actions"><button className="secondary" onClick={loadSamples} disabled={sampleBusy||accessDenied}>{sampleBusy?<Loader2 size={16} className="spin"/>:<FlaskConical size={16}/>}Sample documents</button><button className="primary" onClick={()=>input.current.click()} disabled={uploading!==null||accessDenied}><Upload size={17}/>Upload documents</button></div></div>
          <div className="stats"><Stat label="Total documents" value={total} icon={Files} note="Open your complete library" onClick={home}/><Stat label="Verified" value={list.counts.completed||0} icon={FileCheck2} note="View passed validation checks" onClick={()=>filter('completed')}/><Stat label="Needs review" value={list.counts.needs_review||0} icon={TriangleAlert} note="Open documents needing attention" accent onClick={()=>filter('needs_review')}/><Stat label="In progress" value={processing} icon={Clock3} note="View queued and processing files" onClick={()=>filter('active')}/></div>
          {list.sample_count>0&&<div className="sample-note"><FlaskConical size={16}/><span>{list.sample_count} synthetic sample documents are included. They are labeled “Sample” and safe to edit.</span><button className="text-link" onClick={()=>{home();setSampleOnly(true);}}>View samples</button></div>}
          <div className={`dropzone ${drag?'dragging':''}`} onDragOver={event=>{event.preventDefault();setDrag(true);}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget))setDrag(false);}} onDrop={event=>{event.preventDefault();setDrag(false);if(!accessDenied)upload(event.dataTransfer.files);}}>
            <div className="upload-symbol"><Upload size={23}/></div><div><strong>{uploading!==null?`Uploading documents · ${uploading}%`:'A little less paperwork starts here.'}</strong><p>Drop your files here, or <button className="text-link" onClick={()=>input.current.click()} disabled={uploading!==null||accessDenied}>browse files</button><span>PDF, JPG, PNG, TIFF, Excel, CSV · up to {health?.limits?.max_upload_mb||25} MB each</span></p></div><div className="file-fan" aria-hidden="true"><span>PDF</span><span>XLS</span><span>CSV</span></div>{uploading!==null&&<div className="upload-progress" style={{width:`${uploading}%`}}/>}
          </div>
          <section className="library"><div className="library-header"><div><h2>Document library <span>{list.total}</span></h2><p>{sampleOnly?'Showing synthetic sample documents.':'One place for every file and every detail.'}</p></div><button className="icon-button" title="Refresh documents" aria-label="Refresh documents" onClick={reload}><RefreshCw size={17} className={loading?'spin':''}/></button></div>
            <div className="toolbar"><div className="tabs" aria-label="Filter documents">{[['','All documents'],['needs_review','Needs review'],['completed','Verified'],['active','In progress'],['queued','Queued'],['failed','Failed']].map(([value,label])=><button key={value} className={status===value?'selected':''} onClick={()=>{setStatus(value);setPage(1);}}>{label}</button>)}</div><div className="search"><Search size={17}/><input aria-label="Search documents" placeholder="Search documents…" value={search} onChange={event=>setSearch(event.target.value)}/>{search&&<button aria-label="Clear search" onClick={()=>setSearch('')}><X size={14}/></button>}</div></div>
            {health?.semantic_search&&<label className="semantic-toggle"><input type="checkbox" checked={mode==='semantic'} onChange={event=>{setMode(event.target.checked?'semantic':'keyword');setPage(1);}}/> Search by meaning</label>}
            {filtered&&<div className="filter-summary"><span>{sampleOnly?'Sample documents':status?pretty(status):'Search results'}{query?` · “${query}”`:''}</span><button className="text-link" onClick={home}>Clear filters</button></div>}
            {listError?<div className="empty"><TriangleAlert size={30}/><h3>{accessDenied?'Workspace access required':'Documents could not load'}</h3><p>{listError}</p><button className="secondary" onClick={()=>accessDenied?setSettings(true):reload()}>{accessDenied?'Enter access key':'Retry'}</button></div>:<>
              <div className="table-wrap"><table className="document-table"><thead><tr><th>DOCUMENT NAME</th><th>SUPPLIER / INVOICE</th><th>AMOUNT</th><th>STATUS</th><th>UPLOADED</th><th><span className="sr-only">Open document</span></th></tr></thead><tbody>{list.documents.map(document=>{const Icon=['xlsx','xls','csv'].includes(document.file_type)?FileSpreadsheet:FileText;return <tr key={document.id} onClick={()=>openDocument(document.id)}><td><button className="document-name" onClick={event=>{event.stopPropagation();openDocument(document.id);}}><span className={`file-icon ${document.file_type}`}><Icon size={20}/></span><span>{document.original_filename}<small>{document.file_type.toUpperCase()} document{document.is_sample?' · Sample':''}</small></span></button></td><td><span className="supplier">{document.supplier_name||'—'}</span><small>{document.invoice_number||(['xlsx','xls','csv'].includes(document.file_type)?'Spreadsheet / ledger':document.status==='failed'?'Processing failed':'Awaiting extraction')}</small></td><td className="amount">{money(document.total,document.currency)}</td><td><Badge status={document.status} stage={document.stage}/></td><td className="date">{date(document.uploaded_at)}</td><td><button className="row-open" aria-label={`Open ${document.original_filename}`} onClick={event=>{event.stopPropagation();openDocument(document.id);}}><ArrowUpRight size={16}/></button></td></tr>;})}</tbody></table></div>
              {!list.documents.length&&<div className="empty"><Files size={32}/><h3>{loading?'Loading documents…':filtered?'No matching documents':'Explore your workspace'}</h3><p>{loading?'Checking your document library.':filtered?'This filter has no documents. Your full library is one click away.':'Load the sample invoices and ledger, or upload your own documents.'}</p>{!loading&&(filtered?<button className="secondary" onClick={home}>Clear filters</button>:<div className="actions"><button className="secondary" onClick={loadSamples} disabled={sampleBusy}><FlaskConical size={16}/>Load sample documents</button><button className="primary" onClick={()=>input.current.click()}><Upload size={16}/>Upload documents</button></div>)}</div>}
            </>}
            <div className="table-footer"><span>{list.total?`${(page-1)*25+1}–${Math.min(page*25,list.total)} of ${list.total} documents`:'No documents in this view'}</span><div><button className="icon-button" aria-label="Previous page" disabled={page<=1} onClick={()=>setPage(value=>value-1)}><ArrowLeft size={15}/></button><span>Page {page} of {Math.max(1,list.pages)}</span><button className="icon-button" aria-label="Next page" disabled={page>=list.pages} onClick={()=>setPage(value=>value+1)}><ArrowRight size={15}/></button></div></div>
          </section><div className="footnote"><ShieldCheck size={14}/>Your source files stay intact. Every correction has a history.<span>FOLIO / DOCUMENT INTELLIGENCE</span></div>
        </>:detailError?<div className="empty"><TriangleAlert size={30}/><h3>Document unavailable</h3><p>{detailError}</p><div className="actions"><button className="primary" onClick={home}>Back to documents</button><button className="secondary" onClick={reload}>Retry</button></div></div>:detail?<DocumentDetail key={selected} document={detail} editing={editing} draft={draft} setDraft={setDraft} setEditing={setEditing} busy={busy} save={save} reprocess={reprocess} download={download} home={home} updateField={updateField} chooseFile={()=>input.current.click()} aiEnabled={Boolean(health?.ai?.enabled)} onSetupAI={openAI}/>:<div className="empty"><Loader2 className="spin" size={28}/><p>Loading document…</p><button className="secondary" onClick={home}>Back to documents</button></div>}
        <input ref={input} aria-label="Choose documents to upload" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.tiff,.tif,.xlsx,.xls,.csv" hidden onChange={event=>upload(event.target.files)}/>
      </div>
    </main>
    {settings&&<WorkspaceSettings health={health} focusAI={focusAI} canConfigure={!accessDenied} onAIChange={reload} onClose={closeSettings} onConnected={()=>{setAccessDenied(false);setListError('');setSettings(false);reload();setNotice({type:'success',message:'Workspace access verified.'});}} onDisconnect={()=>{setToken('');setList(freshList());setDetail(null);setAccessDenied(Boolean(health?.authentication));reload();}} onRetry={reload}/>}
  </div>;
}

function Stat({label,value,icon:Icon,note,accent,onClick}){return <button type="button" className={`stat ${accent?'accent':''}`} aria-label={`Show ${label.toLowerCase()}`} onClick={onClick}><div><span>{label}</span><Icon size={18}/></div><strong>{value.toString().padStart(2,'0')}</strong><small>{note}</small></button>;}

function WorkspaceSettings({health,onClose,onConnected,onDisconnect,onRetry,onAIChange,focusAI,canConfigure}){
  const [value,setValue]=useState(getToken()),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const dialog=useRef(),close=useRef();
  useEffect(()=>{close.current?.focus();},[]);
  function keydown(event){
    if(event.key==='Escape'){event.stopPropagation();onClose();}
    if(event.key==='Tab'){
      const elements=dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]');
      const first=elements[0],last=elements[elements.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  }
  async function connect(event){
    event.preventDefault();if(!value.trim()){setError('Enter the access key provided by the person running this workspace.');return;}
    setBusy(true);setError('');
    try{await request('/api/documents?limit=1',{headers:{Authorization:`Bearer ${value.trim()}`}});setToken(value);onConnected();}
    catch(failure){setError(failure.status===401?'That access key is not correct. Check it and try again.':failure.message);}finally{setBusy(false);}
  }
  return <div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}><section ref={dialog} className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-settings-title" onKeyDown={keydown}>
    <div className="panel-heading"><div><div className="eyebrow">WORKSPACE SETTINGS</div><h2 id="workspace-settings-title">Finance workspace</h2></div><button ref={close} className="icon-button" aria-label="Close workspace settings" onClick={onClose}><X size={18}/></button></div>
    <div className="settings-content">
      {!health?<><p>Checking workspace access. Make sure the app is running.</p><button className="secondary" onClick={onRetry}>Retry connection</button></>:<>
        <div className="access-summary"><ShieldCheck size={25}/><div><h3>{health.authentication?'Protected workspace':'Local workspace — no token required'}</h3><p>{health.authentication?'An access key protects all documents in this shared workspace.':'You can upload, inspect, correct and search documents immediately on this computer.'}</p></div></div>
        <dl className="settings-facts"><div><dt>Extraction</dt><dd>{health.extraction_mode==='offline'?'Offline · explicit invoice labels':`${health.ai?.provider} · ${health.ai?.model}`}</dd></div><div><dt>Text recognition</dt><dd>Tesseract OCR</dd></div><div><dt>Search</dt><dd>{health.semantic_search?'Keyword and meaning':'Keyword search'}</dd></div><div><dt>Upload limit</dt><dd>{health.limits?.max_files||20} files · {health.limits?.max_upload_mb||25} MB each</dd></div></dl>
        <div className="token-explanation"><h3>What is a workspace token?</h3><p>It is an optional shared access key that protects this app’s documents when the server owner enables it. It is not an AI API key or a personal account.</p><p>{health.authentication?'Ask the person running this workspace for its access key.':'Access protection is currently off on this local computer, so you do not need a token. The token field was provided for shared or hosted workspaces where the server owner enables access protection.'}</p></div>
        {health.authentication?<form onSubmit={connect}><label htmlFor="workspace-token">Workspace access token</label><input id="workspace-token" type="password" autoComplete="off" value={value} onChange={event=>setValue(event.target.value)} placeholder="Enter your shared access key"/>{error&&<Alert>{error}</Alert>}<div className="actions"><button className="primary" disabled={busy}>{busy?<Loader2 size={16} className="spin"/>:<ShieldCheck size={16}/>}Connect</button>{getToken()&&<button type="button" className="secondary" onClick={()=>{onDisconnect();setValue('');setError('');}}><LogOut size={16}/>Disconnect</button>}</div></form>:<button className="primary" onClick={onClose}>Continue to workspace</button>}
        {canConfigure&&<AiSettings focus={focusAI} onChange={onAIChange}/>}
      </>}
    </div>
  </section></div>;
}

function DocumentDetail({document,editing,draft,setDraft,setEditing,busy,save,reprocess,download,home,updateField,chooseFile,aiEnabled,onSetupAI}){
  const [sourceIndex,setSourceIndex]=useState(0),[ledgerPage,setLedgerPage]=useState(0),[historyLimit,setHistoryLimit]=useState(25);
  const sourceRef=useRef(),fieldsRef=useRef();
  const source=document.pages[Math.min(sourceIndex,Math.max(0,document.pages.length-1))];
  const invoice=editing?draft:document.invoice;
  const terminal=!['queued','processing'].includes(document.status);
  function showSource(citation){if(citation.document_id!==document.id){location.hash=citation.document_id;return;}setSourceIndex(citation.page_index||0);sourceRef.current?.scrollIntoView({behavior:'smooth',block:'start'});}
  function propose(proposal){setDraft({...structuredClone(document.invoice),[proposal.field]:proposal.value});setEditing(true);fieldsRef.current?.scrollIntoView({behavior:'smooth',block:'start'});}
  return <>
    <button className="back-link" onClick={home}><ArrowLeft size={16}/>Back to documents</button>
    <div className="detail-heading"><div><div className="eyebrow">{document.batch_id==='folio-samples-v1'?'SAMPLE DOCUMENT · SAFE TO EDIT':'DOCUMENT REVIEW'}</div><h1>{document.original_filename}</h1><Badge status={document.status} stage={document.stage}/><span className="detail-meta">{document.page_count||'—'} pages / sheets · {document.processing_ms!=null?`${(document.processing_ms/1000).toFixed(2)}s processing`:'Waiting to process'}</span></div><div className="actions"><button className="secondary" onClick={download}><Download size={16}/>Source file</button><button className="secondary" onClick={reprocess} disabled={busy||!terminal||editing} title={editing?'Save or cancel your edits before reprocessing':'Process the original file again'}><RefreshCw size={16}/>Reprocess</button></div></div>
    {document.error_message&&<Alert>{document.error_message}</Alert>}
    {!terminal&&<div className="pipeline"><Loader2 className="spin" size={18}/><strong>{document.stage==='retry_wait'?'Retrying after a temporary failure':`Processing: ${document.stage}`}</strong><span>You can leave this page. Your document will keep processing.</span></div>}
    <div className="detail-grid"><div className="extraction-panel" ref={fieldsRef}><div className="panel-heading"><div><h2>{document.ledger_rows.length?'Ledger records':'Extracted information'}</h2><p>{document.extraction_mode==='offline'?'Extracted from explicit labels · offline mode':document.extraction_mode==='ledger'?'Structured spreadsheet records':`${document.extraction_mode||'AI'} · ${document.extraction_model||'Structured invoice data'}`}</p></div>{document.invoice&&!editing&&<button className="secondary" onClick={()=>{setDraft(structuredClone(document.invoice));setEditing(true);}} disabled={!terminal}>Edit fields</button>}</div>
      {invoice?<><div className="field-grid">{scalarFields.map(field=><label key={field}><span>{pretty(field)}</span>{editing?<input type={numericFields.includes(field)?'number':'text'} step="any" value={draft[field]??''} onChange={event=>updateField(field,event.target.value)}/>:<strong className={invoice[field]==null?'missing':''}>{invoice[field]??'Not found'}</strong>}</label>)}</div>
        <div className="line-heading"><h3>Line items <span>{invoice.line_items.length}</span></h3>{editing&&<button className="text-link" onClick={()=>setDraft(current=>({...current,line_items:[...current.line_items,{description:'',quantity:null,unit_price:null,line_total:null}]}))}>+ Add item</button>}</div>
        <div className="table-wrap"><table className="line-table"><thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Line total</th>{editing&&<th><span className="sr-only">Remove</span></th>}</tr></thead><tbody>{invoice.line_items.map((item,index)=><tr key={index}>{['description','quantity','unit_price','line_total'].map(field=><td key={field}>{editing?<input aria-label={`${pretty(field)} ${index+1}`} type={field==='description'?'text':'number'} step="any" value={item[field]??''} onChange={event=>{const value=event.target.value;setDraft(current=>({...current,line_items:current.line_items.map((line,n)=>n===index?{...line,[field]:field==='description'?value:value===''?null:Number(value)}:line)}));}}/>:item[field]??'—'}</td>)}{editing&&<td><button className="icon-button" aria-label={`Remove item ${index+1}`} onClick={()=>setDraft(current=>({...current,line_items:current.line_items.filter((_,n)=>n!==index)}))}><X size={14}/></button></td>}</tr>)}</tbody></table></div>
        {!invoice.line_items.length&&<p className="muted-pad">{editing?'Add a line item using the button above.':'No line items found in the source.'}</p>}
        <div className="invoice-total"><span>Invoice total</span><strong>{money(invoice.total,invoice.currency)}</strong></div>
        {editing&&<div className="edit-actions"><span>Changes are recorded and revalidated.</span><button className="secondary" onClick={()=>setEditing(false)} disabled={busy}>Cancel</button><button className="primary" onClick={save} disabled={busy}>{busy?<Loader2 size={16} className="spin"/>:<Check size={16}/>}Save changes</button></div>}
      </>:document.ledger_rows.length?<><div className="table-wrap"><table className="line-table ledger-table"><thead><tr><th>Sheet / row</th><th>Invoice</th><th>Supplier</th><th>Date</th><th>Total</th></tr></thead><tbody>{document.ledger_rows.slice(ledgerPage*20,(ledgerPage+1)*20).map((row,n)=><tr key={n}><td>{row.sheet_name} / {row.row_number}</td><td>{row.invoice_number}</td><td>{row.supplier_name||'—'}</td><td>{row.invoice_date||'—'}</td><td>{money(row.total,row.currency)}</td></tr>)}</tbody></table></div>{document.ledger_rows.length>20&&<div className="table-footer"><span>{ledgerPage*20+1}–{Math.min((ledgerPage+1)*20,document.ledger_rows.length)} of {document.ledger_rows.length} rows</span><div><button className="icon-button" aria-label="Previous ledger rows" onClick={()=>setLedgerPage(value=>value-1)} disabled={!ledgerPage}><ArrowLeft size={15}/></button><button className="icon-button" aria-label="Next ledger rows" onClick={()=>setLedgerPage(value=>value+1)} disabled={(ledgerPage+1)*20>=document.ledger_rows.length}><ArrowRight size={15}/></button></div></div>}<div className="ledger-note"><p>Ledger records preserve the uploaded expected values.</p><button className="text-link" onClick={chooseFile}>Upload a revised ledger</button></div></>:<div className="empty"><File size={30}/><p>{document.status==='failed'?'Processing did not produce an invoice. Review the error and try another source file.':'Extracted information will appear after processing.'}</p>{document.status==='failed'&&<button className="secondary" onClick={chooseFile}>Upload another document</button>}</div>}
    </div><aside className="review-panel"><div className="panel-heading"><h2>Validation</h2><ShieldCheck size={19}/></div>{document.validation_errors.length?<><div className="review-summary"><TriangleAlert size={18}/>{document.validation_errors.length} checks need attention</div>{document.validation_errors.map(flag=><div key={flag.id} className="validation-flag"><span className={`severity ${flag.severity}`}>{flag.severity}</span><h3>{pretty(flag.rule)}</h3><p>{flag.message}</p>{flag.related_document_id&&<a href={`#${flag.related_document_id}`}>Compare related document <ArrowUpRight size={13}/></a>}</div>)}</>:<div className="validation-ok"><CheckCircle2 size={28}/><strong>{document.status==='completed'?'All checks passed':'No validation results yet'}</strong><p>{document.status==='completed'?'No inconsistencies were found.':'Checks run after extraction finishes.'}</p></div>}{document.invoice&&<div className="confidence"><span>Extraction confidence<strong>{Math.round(document.invoice.extraction_confidence*100)}%</strong></span><div><i style={{width:`${document.invoice.extraction_confidence*100}%`}}/></div><small>{document.extraction_mode==='offline'?'Label coverage score; verify against the source.':'Model confidence is not a guarantee of accuracy.'}</small></div>}</aside></div>
    <DocumentAssistant document={document} enabled={aiEnabled} editing={editing} onSetup={onSetupAI} onSuggestion={propose} onSource={showSource}/>
    <div className="source-grid" ref={sourceRef}><section className="source-panel"><div className="panel-heading"><h2>Source text</h2><span>{document.pages.length} pages / sheets</span></div>{source?<><div className="source-controls"><button className="icon-button" aria-label="Previous source page" onClick={()=>setSourceIndex(value=>Math.max(0,value-1))} disabled={sourceIndex<=0}><ArrowLeft size={15}/></button><select aria-label="Source page or sheet" value={Math.min(sourceIndex,document.pages.length-1)} onChange={event=>setSourceIndex(Number(event.target.value))}>{document.pages.map((item,n)=><option key={n} value={n}>{item.sheet_name||`Page ${item.page_number}`}</option>)}</select><button className="icon-button" aria-label="Next source page" onClick={()=>setSourceIndex(value=>value+1)} disabled={sourceIndex>=document.pages.length-1}><ArrowRight size={15}/></button></div><div className="source-pages"><h3>{source.sheet_name||`Page ${source.page_number}`}<span>{source.method}{source.ocr_confidence!=null?` · ${Math.round(source.ocr_confidence*100)}% OCR`:''}</span></h3><pre>{source.raw_text}</pre></div></>:<p className="muted-pad">No source text is available for this run.</p>}</section><section className="history-panel"><div className="panel-heading"><h2>Activity</h2><Clock3 size={17}/></div><ol>{document.processing_history.slice(-historyLimit).map((event,n)=><li key={n}><i/><div><strong>{pretty(event.event)}</strong><time>{new Date(event.timestamp).toLocaleString()}</time>{event.detail.message&&<p>{event.detail.message}</p>}{event.detail.fields&&<p>Updated {event.detail.fields.map(pretty).join(', ')}</p>}</div></li>)}</ol>{document.processing_history.length>historyLimit&&<button className="history-more" onClick={()=>setHistoryLimit(value=>value+25)}>Show earlier activity</button>}</section></div>
  </>;
}
