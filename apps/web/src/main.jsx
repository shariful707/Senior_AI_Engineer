import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowUpRight,ArrowLeft,ArrowRight,Check,CheckCircle2,ChevronRight,Clock3,Download,File,FileCheck2,Files,FileSpreadsheet,FileText,Layers3,Loader2,RefreshCw,Search,ShieldCheck,SlidersHorizontal,TriangleAlert,Upload,Workflow,X} from 'lucide-react';
import './style.css';

const labels={completed:'Verified',needs_review:'Needs review',processing:'Processing',queued:'Queued',failed:'Failed'};
const fields=['invoice_number','invoice_date','supplier_name','customer_name','subtotal','tax','total','currency'];
const numeric=['subtotal','tax','total'];
let token=sessionStorage.getItem('folio-token')||'';
const headers=()=>token?{Authorization:`Bearer ${token}`} : {};
async function request(url,options={}) {
  const response=await fetch(url,{...options,headers:{...headers(),...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error?.message||'Request failed.');
  return result;
}
const iconFor=type=>['xlsx','xls','csv'].includes(type)?FileSpreadsheet:FileText;
const pretty=value=>value.replaceAll('_',' ').replace(/^./,s=>s.toUpperCase());
const money=(amount,currency)=>amount==null?'—':new Intl.NumberFormat('en-US',{style:'decimal',minimumFractionDigits:2,maximumFractionDigits:2}).format(amount)+(currency?` ${currency}`:'');
function Badge({status,stage}){return <span className={`badge ${status}`}><i/>{labels[status]||status}{status==='processing'&&stage?` · ${stage}`:''}</span>;}

function App(){
  const [health,setHealth]=useState(null),[list,setList]=useState({documents:[],counts:{},total:0,pages:0});
  const [search,setSearch]=useState(''),[query,setQuery]=useState(''),[status,setStatus]=useState(''),[page,setPage]=useState(1),[mode,setMode]=useState('keyword');
  const [selected,setSelected]=useState(location.hash.slice(1)),[detail,setDetail]=useState(null),[editing,setEditing]=useState(false),[draft,setDraft]=useState(null);
  const [error,setError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[uploading,setUploading]=useState(null),[drag,setDrag]=useState(false),[refresh,setRefresh]=useState(0),[showToken,setShowToken]=useState(false),[tokenValue,setTokenValue]=useState(token);
  const input=useRef();
  useEffect(()=>{const timer=setTimeout(()=>{setQuery(search);setPage(1);},350);return()=>clearTimeout(timer);},[search]);
  useEffect(()=>{const listener=()=>{setSelected(location.hash.slice(1));setEditing(false);setDetail(null);};addEventListener('hashchange',listener);return()=>removeEventListener('hashchange',listener);},[]);
  useEffect(()=>{request('/health').then(setHealth).catch(e=>setError(e.message));},[refresh]);
  useEffect(()=>{
    const abort=new AbortController();let inFlight=false;
    const load=async()=>{
      if(inFlight)return;inFlight=true;
      try{const result=await request(`/api/documents?${new URLSearchParams({query,status,page,mode})}`,{signal:abort.signal});setList(result);setError('');}
      catch(e){if(e.name!=='AbortError')setError(e.message);}finally{if(!abort.signal.aborted)setLoading(false);inFlight=false;}
    };
    setLoading(true);load();const timer=setInterval(load,2500);return()=>{abort.abort();clearInterval(timer);};
  },[query,status,page,mode,refresh]);
  useEffect(()=>{
    if(!selected||editing)return;
    const abort=new AbortController();let inFlight=false;
    const load=async()=>{if(inFlight)return;inFlight=true;try{const result=await request(`/api/documents/${selected}`,{signal:abort.signal});setDetail(result);}catch(e){if(e.name!=='AbortError')setError(e.message);}finally{inFlight=false;}};
    load();const timer=setInterval(load,2000);return()=>{abort.abort();clearInterval(timer);};
  },[selected,editing,refresh]);
  const reload=()=>setRefresh(n=>n+1);
  function upload(files){
    if(!files.length||uploading!==null)return;
    setError('');setUploading(0);
    const form=new FormData();for(const file of files)form.append('files[]',file);
    const xhr=new XMLHttpRequest();xhr.open('POST','/api/documents');for(const [k,v]of Object.entries(headers()))xhr.setRequestHeader(k,v);
    xhr.upload.onprogress=e=>{if(e.lengthComputable)setUploading(Math.round(e.loaded/e.total*100));};
    xhr.onload=()=>{setUploading(null);try{const result=JSON.parse(xhr.responseText);if(xhr.status>=400)throw new Error(result.error?.message||'Upload failed.');setStatus('');setPage(1);reload();}catch(e){setError(e.message);}};
    xhr.onerror=()=>{setUploading(null);setError('Upload failed. Check that the API is running.');};xhr.send(form);input.current.value='';
  }
  async function save(){
    setBusy(true);setError('');
    try{const result=await request(`/api/documents/${selected}`,{method:'PATCH',headers:{'If-Match':String(detail.revision)},body:JSON.stringify(draft)});setDetail(result);setEditing(false);reload();}catch(e){setError(e.message);}finally{setBusy(false);}
  }
  async function reprocess(){setBusy(true);setError('');try{await request(`/api/documents/${selected}/reprocess`,{method:'POST'});setEditing(false);reload();}catch(e){setError(e.message);}finally{setBusy(false);}}
  async function download(){try{const res=await fetch(`/api/documents/${selected}/file`,{headers:headers()});if(!res.ok)throw new Error('Download failed.');const url=URL.createObjectURL(await res.blob());const a=document.createElement('a');a.href=url;a.download=detail.original_filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){setError(e.message);}}
  const change=(field,value)=>setDraft(d=>({...d,[field]:numeric.includes(field)?value===''?null:Number(value):value||null}));
  const total=Object.values(list.counts).reduce((a,b)=>a+b,0),processing=(list.counts.processing||0)+(list.counts.queued||0);
  const back=()=>{location.hash='';};
  return <div className="shell">
    <aside className="sidebar">
      <a href="#" className="brand" aria-label="Folio home"><span className="brand-mark"><Layers3 size={22}/></span>folio<span className="brand-dot">.</span></a>
      <div className="workspace"><span className="workspace-avatar">F</span><div>Finance workspace<small>Document intelligence</small></div><ShieldCheck size={15}/></div>
      <span className="nav-caption">WORKSPACE</span>
      <button className="nav-link active" onClick={()=>{back();setStatus('');}}><Files size={18}/>Documents<span>{total}</span></button>
      <button className={`nav-link ${status==='needs_review'?'current':''}`} onClick={()=>{back();setStatus('needs_review');setPage(1);}}><ShieldCheck size={18}/>Review queue<span className="review-count">{list.counts.needs_review||0}</span></button>
      <div className="sidebar-note"><Workflow size={22}/><strong>From file to clarity.</strong><p>Extract the details.<br/>Catch what needs a second look.</p><div className="status-line"><i/>{health?`${health.extraction_mode==='offline'?'Offline extraction':'AI extraction'} active`:'Connecting to workspace'}</div></div>
      <button className="profile" onClick={()=>setShowToken(v=>!v)}><span className="profile-avatar">FW</span><div>Workspace access<small>{token?'Token configured':'Local workspace'}</small></div><SlidersHorizontal size={17}/></button>
    </aside>
    <main>
      <header className="topbar"><span>Workspace <ChevronRight size={13}/> Documents{selected&&<><ChevronRight size={13}/><strong>Document review</strong></>}</span><span className="topbar-right"><i/>{processing?`${processing} in progress`:'All systems ready'}</span></header>
      <div className="content">
        {error&&<div className="alert error" role="alert"><TriangleAlert size={18}/><span>{error}</span><button aria-label="Dismiss error" onClick={()=>setError('')}><X size={16}/></button></div>}
        {showToken&&<form className="token-form" onSubmit={e=>{e.preventDefault();token=tokenValue;sessionStorage.setItem('folio-token',token);setShowToken(false);reload();}}><label htmlFor="token">Workspace access token</label><input id="token" type="password" value={tokenValue} onChange={e=>setTokenValue(e.target.value)} autoComplete="off"/><button className="primary">Connect</button><button type="button" className="secondary" onClick={()=>setShowToken(false)}>Cancel</button></form>}
        {!selected?<>
          <div className="page-heading"><div><div className="eyebrow">YOUR DOCUMENT WORKSPACE</div><h1>Every document. <span>Understood.</span></h1><p>Turn invoices and ledgers into information you can trust.</p></div><button className="primary" onClick={()=>input.current.click()} disabled={uploading!==null}><Upload size={17}/>Upload documents</button></div>
          <div className="stats"><Stat label="Total documents" value={total} icon={Files} note="Your complete library"/><Stat label="Verified" value={list.counts.completed||0} icon={FileCheck2} note="Passed all validation checks"/><Stat label="Needs review" value={list.counts.needs_review||0} icon={TriangleAlert} note="A closer look required" accent/><Stat label="In progress" value={processing} icon={Clock3} note="Working in the background"/></div>
          <div className={`dropzone ${drag?'dragging':''}`} onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);upload(e.dataTransfer.files);}}>
            <div className="upload-symbol"><Upload size={23}/></div><div><strong>{uploading!==null?`Uploading documents · ${uploading}%`:'A little less paperwork starts here.'}</strong><p>Drop your files here, or <button className="text-link" onClick={()=>input.current.click()} disabled={uploading!==null}>browse files</button><span>PDF, JPG, PNG, TIFF, Excel, CSV · up to 25 MB each</span></p></div><div className="file-fan"><span>PDF</span><span>XLS</span><span>CSV</span></div>
            {uploading!==null&&<div className="upload-progress" style={{width:`${uploading}%`}}/>}
          </div>
          <section className="library"><div className="library-header"><div><h2>Document library <span>{list.total}</span></h2><p>One place for every file and every detail.</p></div><button className="icon-button" title="Refresh documents" aria-label="Refresh documents" onClick={reload}><RefreshCw size={17} className={loading?'spin':''}/></button></div>
            <div className="toolbar"><div className="tabs" aria-label="Filter documents">{[['','All documents'],['needs_review','Needs review'],['completed','Verified'],['processing','Processing'],['queued','Queued'],['failed','Failed']].map(([key,label])=><button key={key} className={status===key?'selected':''} onClick={()=>{setStatus(key);setPage(1);}}>{label}</button>)}</div><div className="search"><Search size={17}/><input aria-label="Search documents" placeholder="Search documents…" value={search} onChange={e=>setSearch(e.target.value)}/>{search&&<button aria-label="Clear search" onClick={()=>setSearch('')}><X size={14}/></button>}</div></div>
            {health?.semantic_search&&<label className="semantic-toggle"><input type="checkbox" checked={mode==='semantic'} onChange={e=>{setMode(e.target.checked?'semantic':'keyword');setPage(1);}}/> Search by meaning</label>}
            <div className="table-wrap"><table className="document-table"><thead><tr><th>DOCUMENT NAME</th><th>SUPPLIER / INVOICE</th><th>AMOUNT</th><th>STATUS</th><th>UPLOADED</th><th/></tr></thead><tbody>{list.documents.map(doc=>{const Icon=iconFor(doc.file_type);return <tr key={doc.id} onClick={()=>{location.hash=doc.id;}}><td><button className="document-name" onClick={e=>{e.stopPropagation();location.hash=doc.id;}}><span className={`file-icon ${doc.file_type}`}><Icon size={20}/></span><span>{doc.original_filename}<small>{doc.file_type.toUpperCase()} document</small></span></button></td><td><span className="supplier">{doc.supplier_name||'—'}</span><small>{doc.invoice_number||(['xlsx','xls','csv'].includes(doc.file_type)?'Spreadsheet / ledger':'Awaiting extraction')}</small></td><td className="amount">{money(doc.total,doc.currency)}</td><td><Badge status={doc.status} stage={doc.stage}/></td><td className="date">{new Date(doc.uploaded_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</td><td><ArrowUpRight size={16}/></td></tr>;})}</tbody></table></div>
            {!list.documents.length&&<div className="empty"><Files size={32}/><h3>{loading?'Loading documents…':search||status?'No matching documents':'Your workspace is ready'}</h3><p>{search||status?'Try a different search or filter.':'Upload an invoice or a ledger to see the details come together.'}</p></div>}
            <div className="table-footer"><span>{list.total?`${(page-1)*25+1}–${Math.min(page*25,list.total)} of ${list.total} documents`:'No documents yet'}</span><div><button className="icon-button" aria-label="Previous page" disabled={page<=1} onClick={()=>setPage(p=>p-1)}><ArrowLeft size={15}/></button><span>Page {page} of {Math.max(1,list.pages)}</span><button className="icon-button" aria-label="Next page" disabled={page>=list.pages} onClick={()=>setPage(p=>p+1)}><ArrowRight size={15}/></button></div></div>
          </section><div className="footnote"><ShieldCheck size={14}/>Your source files stay intact. Every correction has a history.<span>FOLIO / DOCUMENT INTELLIGENCE</span></div>
        </>:detail?<>
          <button className="back-link" onClick={back}><ArrowLeft size={16}/>Back to documents</button>
          <div className="detail-heading"><div><div className="eyebrow">DOCUMENT REVIEW</div><h1>{detail.original_filename}</h1><Badge status={detail.status} stage={detail.stage}/><span className="detail-meta">{detail.page_count||'—'} pages / sheets · {detail.processing_ms!=null?`${(detail.processing_ms/1000).toFixed(2)}s processing`:'Waiting to process'}</span></div><div className="actions"><button className="secondary" onClick={download}><Download size={16}/>Source file</button><button className="secondary" onClick={reprocess} disabled={busy||['queued','processing'].includes(detail.status)}><RefreshCw size={16}/>Reprocess</button></div></div>
          {detail.error_message&&<div className="alert error"><TriangleAlert size={18}/>{detail.error_message}</div>}
          {['queued','processing'].includes(detail.status)&&<div className="pipeline"><Loader2 className="spin" size={18}/><strong>{detail.stage==='retry_wait'?'Retrying after a temporary failure':`Processing: ${detail.stage}`}</strong><span>You can leave this page. Your document will keep processing.</span></div>}
          <div className="detail-grid"><div className="extraction-panel">
            <div className="panel-heading"><div><h2>{detail.ledger_rows.length?'Ledger records':'Extracted information'}</h2><p>{detail.extraction_mode==='offline'?'Extracted from explicit labels · offline mode':detail.extraction_mode==='ledger'?'Structured spreadsheet records':'Structured invoice data'}</p></div>{detail.invoice&&!editing&&<button className="secondary" onClick={()=>{setDraft(structuredClone(detail.invoice));setEditing(true);}}>Edit fields</button>}</div>
            {detail.invoice?<><div className="field-grid">{fields.map(field=><label key={field}><span>{pretty(field)}</span>{editing?<input type={numeric.includes(field)?'number':'text'} step="0.01" value={draft[field]??''} onChange={e=>change(field,e.target.value)}/>:<strong className={detail.invoice[field]==null?'missing':''}>{detail.invoice[field]??'Not found'}</strong>}</label>)}</div>
              <div className="line-heading"><h3>Line items <span>{(editing?draft:detail.invoice).line_items.length}</span></h3>{editing&&<button className="text-link" onClick={()=>setDraft(d=>({...d,line_items:[...d.line_items,{description:'',quantity:null,unit_price:null,line_total:null}]}))}>+ Add item</button>}</div><div className="table-wrap"><table className="line-table"><thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Line total</th>{editing&&<th/>}</tr></thead><tbody>{(editing?draft:detail.invoice).line_items.map((item,index)=><tr key={index}>{['description','quantity','unit_price','line_total'].map(key=><td key={key}>{editing?<input aria-label={`${pretty(key)} ${index+1}`} type={key==='description'?'text':'number'} step="any" value={item[key]??''} onChange={e=>{const value=e.target.value;setDraft(d=>({...d,line_items:d.line_items.map((it,n)=>n===index?{...it,[key]:key==='description'?value:value===''?null:Number(value)}:it)}));}}/>:item[key]??'—'}</td>)}{editing&&<td><button className="icon-button" aria-label={`Remove item ${index+1}`} onClick={()=>setDraft(d=>({...d,line_items:d.line_items.filter((_,n)=>n!==index)}))}><X size={14}/></button></td>}</tr>)}</tbody></table></div>
              {!detail.invoice.line_items.length&&!editing&&<p className="muted-pad">No line items found in the source.</p>}
              <div className="invoice-total"><span>Invoice total</span><strong>{money((editing?draft:detail.invoice).total,(editing?draft:detail.invoice).currency)}</strong></div>
              {editing&&<div className="edit-actions"><span>Changes are recorded and revalidated.</span><button className="secondary" onClick={()=>setEditing(false)} disabled={busy}>Cancel</button><button className="primary" onClick={save} disabled={busy}>{busy?<Loader2 size={16} className="spin"/>:<Check size={16}/>}Save changes</button></div>}
            </>:detail.ledger_rows.length?<div className="table-wrap"><table className="line-table ledger-table"><thead><tr><th>Sheet / row</th><th>Invoice</th><th>Supplier</th><th>Date</th><th>Total</th></tr></thead><tbody>{detail.ledger_rows.map((row,n)=><tr key={n}><td>{row.sheet_name} / {row.row_number}</td><td>{row.invoice_number}</td><td>{row.supplier_name||'—'}</td><td>{row.invoice_date||'—'}</td><td>{money(row.total,row.currency)}</td></tr>)}</tbody></table></div>:<div className="empty"><File size={30}/><p>Extracted information will appear after processing.</p></div>}
          </div><aside className="review-panel"><div className="panel-heading"><h2>Validation</h2><ShieldCheck size={19}/></div>{detail.validation_errors.length?<><div className="review-summary"><TriangleAlert size={18}/>{detail.validation_errors.length} checks need attention</div>{detail.validation_errors.map(flag=><div key={flag.id} className="validation-flag"><span className={`severity ${flag.severity}`}>{flag.severity}</span><h3>{pretty(flag.rule)}</h3><p>{flag.message}</p>{flag.related_document_id&&<a href={`#${flag.related_document_id}`}>Compare related document <ArrowUpRight size={13}/></a>}</div>)}</>:<div className="validation-ok"><CheckCircle2 size={28}/><strong>{detail.status==='completed'?'All checks passed':'No validation results yet'}</strong><p>{detail.status==='completed'?'No inconsistencies were found.':'Checks run after extraction finishes.'}</p></div>}{detail.invoice&&<div className="confidence"><span>Extraction confidence<strong>{Math.round(detail.invoice.extraction_confidence*100)}%</strong></span><div><i style={{width:`${detail.invoice.extraction_confidence*100}%`}}/></div><small>{detail.extraction_mode==='offline'?'Label coverage score; verify against the source.':'Model confidence is not a guarantee of accuracy.'}</small></div>}</aside></div>
          <div className="source-grid"><section className="source-panel"><div className="panel-heading"><h2>Source text</h2><span>{detail.pages.length} pages / sheets</span></div><div className="source-pages">{detail.pages.map((p,n)=><div key={n}><h3>{p.sheet_name||`Page ${p.page_number}`}<span>{p.method}{p.ocr_confidence!=null?` · ${Math.round(p.ocr_confidence*100)}% OCR`:''}</span></h3><pre>{p.raw_text}</pre></div>)}{!detail.pages.length&&<p className="muted-pad">No text extracted yet.</p>}</div></section><section className="history-panel"><div className="panel-heading"><h2>Activity</h2><Clock3 size={17}/></div><ol>{detail.processing_history.map((event,n)=><li key={n}><i/><div><strong>{pretty(event.event)}</strong><time>{new Date(event.timestamp).toLocaleString()}</time>{event.detail.message&&<p>{event.detail.message}</p>}{event.detail.fields&&<p>Updated {event.detail.fields.map(pretty).join(', ')}</p>}</div></li>)}</ol></section></div>
        </>:<div className="empty"><Loader2 className="spin" size={28}/><p>Loading document…</p></div>}
        <input ref={input} type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.tiff,.tif,.xlsx,.xls,.csv" hidden onChange={e=>upload(e.target.files)}/>
      </div>
    </main>
  </div>;
}
function Stat({label,value,icon:Icon,note,accent}){return <div className={`stat ${accent?'accent':''}`}><div><span>{label}</span><Icon size={18}/></div><strong>{value.toString().padStart(2,'0')}</strong><small>{note}</small></div>;}
createRoot(document.getElementById('root')).render(<App/>);
