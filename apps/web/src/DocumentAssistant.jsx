import React,{useEffect,useState} from 'react';
import {Sparkles,MessageSquare,FileText,TriangleAlert,Loader2,ArrowUpRight,RefreshCw} from 'lucide-react';
import {request} from './api.js';

const titles={summary:'Document summary',review:'Review explanation',question:'Document question'};
const pending=run=>['queued','processing'].includes(run.status);
export default function DocumentAssistant({document,enabled,editing,onSetup,onSuggestion,onSource}){
  const [runs,setRuns]=useState([]),[selected,setSelected]=useState(''),[question,setQuestion]=useState(''),[error,setError]=useState(''),[submitting,setSubmitting]=useState(false),[refresh,setRefresh]=useState(0);
  const working=runs.some(pending),canAsk=enabled&&!editing&&!['queued','processing'].includes(document.status)&&document.pages.some(page=>page.raw_text.trim());
  useEffect(()=>{
    let stopped=false,active=false;
    async function load(){if(active)return;active=true;try{const result=await request(`/api/documents/${document.id}/ai`);if(!stopped)setRuns(result.runs);}catch(failure){if(!stopped)setError(failure.message);}finally{active=false;}}
    load();const timer=working?setInterval(load,1500):null;return()=>{stopped=true;if(timer)clearInterval(timer);};
  },[document.id,document.revision,refresh,working]);
  const current=runs.find(run=>run.id===selected)||runs[0];
  async function ask(task,text=''){
    setSubmitting(true);setError('');
    try{
      const response=await request(`/api/documents/${document.id}/ai`,{method:'POST',body:JSON.stringify({task,question:text})});
      setSelected(response.id);setRuns(previous=>[{id:response.id,task,question:text,status:'queued',document_revision:document.revision},...previous]);setRefresh(value=>value+1);if(task==='question')setQuestion('');
    }catch(failure){setError(failure.message);}finally{setSubmitting(false);}
  }
  return <section className="document-assistant" aria-labelledby="document-assistant-title">
    <div className="panel-heading"><div><h2 id="document-assistant-title"><Sparkles size={19}/>Document assistant</h2><p>{enabled?'Answers and proposals from your connected LLM, with checked source quotes.':'Connect an LLM for real document summaries, review explanations and source-based answers.'}</p></div><button className="secondary" onClick={onSetup}>{enabled?'AI settings':'Connect an LLM'}</button></div>
    {!enabled?<div className="ai-onboarding"><MessageSquare size={25}/><div><strong>No AI answers are being generated yet.</strong><p>Use local Ollama or connect an API provider. Offline extraction remains clearly labeled.</p></div><button className="primary" onClick={onSetup}><Sparkles size={16}/>Set up AI</button></div>:<div className="assistant-content">
      <div className="assistant-tools"><button className="secondary" disabled={!canAsk||working||submitting} onClick={()=>ask('summary')}><FileText size={15}/>Summarize document</button><button className="secondary" disabled={!canAsk||working||submitting} onClick={()=>ask('review')}><TriangleAlert size={15}/>Explain review flags</button></div>
      {editing&&<p className="ai-muted">Save or cancel your edits before asking the model about the stored document.</p>}
      <form className="assistant-question" onSubmit={event=>{event.preventDefault();if(question.trim())ask('question',question.trim());}}><label htmlFor={`ask-document-${document.id}`}>Ask about this document</label><div><input id={`ask-document-${document.id}`} maxLength={1000} value={question} onChange={event=>setQuestion(event.target.value)} placeholder="What is the total, and does it match the ledger?" disabled={!canAsk}/><button className="primary" disabled={!canAsk||!question.trim()||working||submitting}><MessageSquare size={16}/>Ask AI</button></div></form>
      {error&&<div className="ai-feedback error" role="alert">{error}<button className="text-link" onClick={()=>setRefresh(value=>value+1)}>Refresh requests</button></div>}
      {runs.length>1&&<label className="assistant-history">AI response history<select value={current?.id||''} onChange={event=>setSelected(event.target.value)}>{runs.map(run=><option key={run.id} value={run.id}>{titles[run.task]}{run.question?` · ${run.question.slice(0,60)}`:''}{run.status!=='completed'?` · ${run.status}`:''}</option>)}</select></label>}
      {current&&pending(current)&&<div className="ai-feedback" role="status"><Loader2 size={17} className="spin"/>{current.status==='queued'?'AI request queued. Your worker will process it.':'The model is reading the selected document excerpts. This may take a minute locally.'}</div>}
      {current&&['failed','cancelled'].includes(current.status)&&<div className="ai-feedback error" role="alert"><span>{current.error_message||'This AI request did not complete.'}</span><button className="secondary" disabled={working||submitting||!canAsk} onClick={()=>ask(current.task,current.question||'')}><RefreshCw size={14}/>Retry AI request</button></div>}
      {current?.status==='completed'&&current.result&&<article className="ai-result"><div className="ai-result-heading"><h3>{titles[current.task]}</h3><span>{current.provider} · {current.model}{current.processing_ms!=null?` · ${(current.processing_ms/1000).toFixed(1)}s`:''}</span></div>{current.question&&<p className="ai-original-question">{current.question}</p>}
        {current.stale&&<div className="ai-feedback">This response was generated before the latest correction. Generate a fresh response before using its proposals.</div>}
        <p className="ai-answer">{current.result.answer}</p>{current.result.highlights?.length>0&&<ul className="ai-highlights">{current.result.highlights.map((item,index)=><li key={index}>{item}</li>)}</ul>}
        {current.result.insufficient_evidence&&<p className="ai-evidence-note">The available excerpts do not fully establish this answer. Verify the original document.</p>}
        {current.result.context_truncated&&<p className="ai-muted">This answer used selected excerpts from a larger document.</p>}
        {current.result.citations?.length>0&&<div className="ai-citations"><h4>Source references</h4>{current.result.citations.map((citation,index)=><button key={index} className="ai-citation" onClick={()=>onSource(citation)}><span>{citation.filename} · {citation.sheet_name||`Page ${citation.page_number||1}`}<ArrowUpRight size={13}/></span><q>{citation.quote}</q></button>)}</div>}
        {current.result.suggestions?.length>0&&<div className="ai-suggestions"><h4>Proposed corrections · review before saving</h4>{current.result.suggestions.map((proposal,index)=><div key={index}><strong>{proposal.field.replaceAll('_',' ')} → {String(proposal.value)}</strong><span className="ai-proposal-origin">{proposal.origin==='calculated'?'Calculated proposal':'Quoted source value'}</span><p>{proposal.reason}</p><button className="secondary" disabled={current.stale||editing||!document.invoice} onClick={()=>onSuggestion(proposal)}>Review proposed {proposal.field.replaceAll('_',' ')}</button></div>)}</div>}
      </article>}
      {!current&&<p className="ai-muted">Choose a summary, explain the review flags, or ask a question. The assistant has not made any model calls for this document yet.</p>}
    </div>}
  </section>;
}
