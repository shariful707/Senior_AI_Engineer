import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Database,decode} from '../src/db/index.js';
import {config} from '../src/config.js';
import {createApp} from '../src/app.js';
import {saveInvoice,documentDetail,now} from '../src/documents.js';
import {candidateSettings,protectSettings,revealSettings,validateProviderURL,getAIStatus,saveAISettings} from '../src/ai/settings.js';
import {enqueueAI,claimAIRun,runAI,publicAIRun,disableAI} from '../src/ai/runs.js';
import {assistantContext,verifyAssistantOutput} from '../src/ai/assistant.js';
import {extract} from '../src/extraction.js';

let db,temp,app,server,base,id;
const settings={provider:'ollama',model:'test-model',baseUrl:'http://127.0.0.1:44444',apiKey:'',responseFormat:'strict'};
const invoice={invoice_number:'AI-1',invoice_date:'2026-10-30',supplier_name:'Local Supplies',customer_name:'Folio',subtotal:100,tax:10,total:150,currency:'USD',line_items:[],extraction_confidence:.9};
const answer={answer:'Subtotal and tax imply 110; the stored total is 150.',highlights:['Review the printed total.'],insufficient_evidence:false,citations:[{source_id:'S1',quote:'Subtotal: 100\nTax: 10'}],suggestions:[{field:'total',value:110,reason:'100 + 10 = 110',source_id:'S1',quote:'Subtotal: 100\nTax: 10',origin:'calculated'}]};
const originalFetch=global.fetch;
let providerReply={ready:true},providerStatus=200,lastRequest;
before(async()=>{
  temp=await mkdtemp(path.join(os.tmpdir(),'folio-ai-'));config.dataDir=temp;
  db=await new Database({url:'',file:path.join(temp,'test.sqlite')}).open();
  app=await createApp(db,{apiToken:'workspace-test',dispatcher:{notify:async()=>{},close:async()=>{}}});
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  global.fetch=async(url,options)=>{
    if(String(url).startsWith(settings.baseUrl)){
      lastRequest=JSON.parse(options.body);
      return Response.json({message:{content:JSON.stringify(providerReply)},prompt_eval_count:80,eval_count:30},{status:providerStatus});
    }
    return originalFetch(url,options);
  };
  id=randomUUID();
  await db.query("INSERT INTO documents(id,original_filename,file_type,storage_path,status,stage,batch_id,uploaded_at,updated_at) VALUES($1,'test.pdf','pdf','unused','needs_review','done','test',$2,$2)",[id,now()]);
  await db.query("INSERT INTO extracted_text(id,document_id,page_number,raw_text,method) VALUES($1,$2,1,$3,'digital')",[randomUUID(),id,'Invoice number: AI-1\nSupplier: Local Supplies\nSubtotal: 100\nTax: 10\nTotal: 150\nCurrency: USD']);
  await saveInvoice(db,id,invoice);
});
after(async()=>{global.fetch=originalFetch;await new Promise(resolve=>server.close(resolve));await app.locals.close();await db.close();await rm(temp,{recursive:true,force:true});});
const api=(route,body,auth=true)=>fetch(base+route,{headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer workspace-test'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});

test('AI routes use workspace authentication and distinguish access from provider credentials',async()=>{
  for(const route of ['/api/ai/settings','/api/ai/runs/unknown',`/api/documents/${id}/ai`])assert.equal((await api(route,null,false)).status,401);
  assert.equal((await api('/api/ai/settings')).status,200);
  const disabled=await api(`/api/documents/${id}/ai`,{task:'summary'});assert.equal(disabled.status,409);assert.equal((await disabled.json()).error.code,'AI_NOT_CONFIGURED');
});

test('provider settings reject unsafe URLs, accidental secret URLs and invalid fields',async()=>{
  for(const url of ['http://example.com','http://169.254.169.254','http://localhost:11434?key=secret','http://name:secret@localhost:11434','file:///etc/passwd'])await assert.rejects(validateProviderURL('ollama',url));
  await assert.rejects(validateProviderURL('compatible','https://192.168.1.3/v1'));
  await assert.rejects(validateProviderURL('openai','https://example.com/v1'));
  await assert.rejects(candidateSettings({provider:'ollama',model:'ok',unknown:true},settings));
  await assert.rejects(candidateSettings({provider:'ollama',model:'bad name'},settings));
  const local=await candidateSettings({provider:'ollama',model:'test-model',api_key:'not-needed'},null);assert.equal(local.apiKey,'');
});

test('saved provider keys are authenticated-encrypted and never in public settings',async()=>{
  const secret={...settings,provider:'compatible',apiKey:'private-test-key'};
  const stored=await protectSettings(secret);assert.ok(!JSON.stringify(stored).includes(secret.apiKey));assert.equal((await revealSettings(stored)).apiKey,secret.apiKey);
  assert.equal((await readFile(path.join(temp,'.ai-master-key'))).length,32);
  await saveAISettings(db,secret);assert.equal((await getAIStatus(db)).has_key,true);assert.ok(!JSON.stringify(await getAIStatus(db)).includes(secret.apiKey));
  await assert.rejects(revealSettings({...stored,encryptedKey:stored.encryptedKey.slice(0,-4)+'AAAA'}));
  await disableAI(db);
});

test('configure stays asynchronous, prevents duplicate tests and activates only verified output',async()=>{
  providerReply={ready:true};
  const response=await api('/api/ai/configure',{provider:'ollama',model:settings.model,base_url:settings.baseUrl});assert.equal(response.status,202);
  const queued=await response.json();assert.equal((await getAIStatus(db)).enabled,false);
  assert.equal((await api('/api/ai/configure',{provider:'ollama',model:settings.model,base_url:settings.baseUrl})).status,409);
  const claimed=await claimAIRun(db);assert.equal(claimed.id,queued.id);assert.equal(await claimAIRun(db),null);
  await runAI(db,claimed);
  const result=await publicAIRun(db,queued.id);assert.equal(result.status,'completed');assert.equal((await getAIStatus(db)).provider,'ollama');assert.equal(result.input,undefined);assert.equal(result.audit,undefined);
  assert.equal(lastRequest.stream,false);assert.equal(lastRequest.think,false);assert.equal(lastRequest.format.properties.ready.type,'boolean');assert.equal(lastRequest.messages.at(-1).role,'user');
});

test('failed connection test preserves the working provider and returns safe errors',async()=>{
  providerReply={ready:false};const failed=await enqueueAI(db,{task:'configure',settings:{...settings,model:'bad-model'}});await runAI(db,await claimAIRun(db));
  assert.equal((await publicAIRun(db,failed)).status,'failed');assert.equal((await getAIStatus(db)).model,'test-model');
  providerStatus=401;const rejected=await enqueueAI(db,{task:'configure',settings:{...settings,apiKey:'private-test-key'}});await runAI(db,await claimAIRun(db));
  const result=await publicAIRun(db,rejected);assert.equal(result.status,'failed');assert.match(result.error_message,/rejected the API key/);assert.ok(!JSON.stringify(result).includes('private-test-key'));providerStatus=200;
});

test('assistant quotes and calculated proposals are verified against actual source without mutation',async()=>{
  const context=await assistantContext(db,id,'Why is total wrong?','review');
  const valid=verifyAssistantOutput(answer,context);assert.equal(valid.citations.length,1);assert.equal(valid.suggestions.length,1);assert.equal(valid.suggestions[0].citation.document_id,id);
  const fabricated=verifyAssistantOutput({...answer,citations:[{source_id:'S99',quote:'made up source'}],suggestions:[{...answer.suggestions[0],value:999}]},context);assert.equal(fabricated.citations.length,0);assert.equal(fabricated.suggestions.length,0);assert.equal(fabricated.insufficient_evidence,true);
  const noOperands=verifyAssistantOutput({...answer,suggestions:[{...answer.suggestions[0],quote:'Supplier: Local Supplies'}]},context);assert.equal(noOperands.suggestions.length,0);
  const wrongSourceValue=verifyAssistantOutput({...answer,suggestions:[{...answer.suggestions[0],origin:'source',value:110}]},context);assert.equal(wrongSourceValue.suggestions.length,0);
  await assert.rejects(async()=>verifyAssistantOutput({...answer,unexpected:true},context));
  assert.equal((await documentDetail(db,id)).invoice.total,150);
});

test('assistant requests queue, persist grounded results, reject overlaps and become stale after correction',async()=>{
  providerReply=answer;
  assert.equal((await api(`/api/documents/${id}/ai`,{task:'question',question:''})).status,400);
  const response=await api(`/api/documents/${id}/ai`,{task:'review'});assert.equal(response.status,202);const queued=await response.json();
  assert.equal((await api(`/api/documents/${id}/ai`,{task:'summary'})).status,409);
  await runAI(db,await claimAIRun(db));let run=await publicAIRun(db,queued.id);assert.equal(run.status,'completed');assert.equal(run.result.suggestions[0].value,110);assert.equal(run.stale,false);
  assert.equal((await documentDetail(db,id)).invoice.total,150);
  await db.query('UPDATE documents SET revision=revision+1 WHERE id=$1',[id]);run=await publicAIRun(db,queued.id);assert.equal(run.stale,true);
  assert.equal((await(await api(`/api/documents/${id}/ai`)).json()).runs.length,1);
});

test('native Ollama invoice extraction validates schema and records actual model audit',async()=>{
  providerReply=invoice;const audits=[];const result=await extract('untrusted invoice source',event=>audits.push(event),settings);
  assert.equal(result.invoice_number,'AI-1');assert.equal(audits[0].provider,'ollama');assert.equal(audits[0].model,'test-model');assert.equal(lastRequest.format.properties.invoice_number.type[0],'string');
});

test('expired AI leases recover and disable fences late configuration activation',async()=>{
  const queued=await enqueueAI(db,{task:'configure',settings});const first=await claimAIRun(db);await db.query('UPDATE ai_runs SET locked_until=$1 WHERE id=$2',['2000-01-01T00:00:00Z',queued]);
  const next=await claimAIRun(db);assert.notEqual(first.lock_token,next.lock_token);assert.equal(next.attempts,2);
  await disableAI(db);providerReply={ready:true};await runAI(db,next);
  assert.equal((await publicAIRun(db,queued)).status,'cancelled');assert.equal((await getAIStatus(db)).enabled,false);
  const queuedInput=decode((await db.query('SELECT input FROM ai_runs WHERE id=$1',[queued])).rows[0].input);assert.equal(queuedInput.settings.apiKey,undefined);
});
