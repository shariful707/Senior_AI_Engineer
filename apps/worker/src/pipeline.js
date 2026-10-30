import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Agent,fetch as httpFetch,FormData as MultipartFormData} from 'undici';
import {config} from '../../api/src/config.js';
import {extract,embed,ProcessingError} from '../../api/src/extraction.js';
import {history,now,saveInvoice,reconcile,lockReconciliation} from '../../api/src/documents.js';
import {getAISettings} from '../../api/src/ai/settings.js';
const parserAgent=new Agent({headersTimeout:3600000,bodyTimeout:3600000});

export async function runJob(db,job,{parseFetch=httpFetch}={}) {
  const start=performance.now();
  const id=job.document_id;
  const heartbeat=setInterval(()=>{db.query("UPDATE jobs SET locked_until=$1 WHERE id=$2 AND lock_token=$3 AND status='running'",[new Date(Date.now()+120000).toISOString(),job.id,job.lock_token]).catch(console.error);},30000);
  heartbeat.unref();
  const assertLease=async tx=>{
    const lease=(await tx.query(`SELECT lock_token FROM jobs WHERE id=$1 AND status='running'${tx.postgres?' FOR UPDATE':''}`,[job.id])).rows[0];
    if(lease?.lock_token!==job.lock_token)throw new ProcessingError('Worker lease lost; stale result discarded.');
  };
  const stage=async name=>db.transaction(async tx=>{
    await assertLease(tx);
    await tx.query("UPDATE documents SET status='processing',stage=$1,updated_at=$2,error_message=NULL WHERE id=$3",[name,now(),id]);
    await history(tx,id,`${name}_started`,{attempt:job.attempts});
  });
  try {
    const document=(await db.query('SELECT * FROM documents WHERE id=$1',[id])).rows[0];
    if(!document) throw new ProcessingError('Document no longer exists.');
    const aiSettings=await getAISettings(db);
    if(job.task==='embedding'){
      const row=(await db.query('SELECT data FROM invoices WHERE document_id=$1',[id])).rows[0];
      if(row&&db.postgres){
        const invoice=typeof row.data==='string'?JSON.parse(row.data):row.data;
        const vector=await embed(JSON.stringify(invoice));
        await db.transaction(async tx=>{
          await assertLease(tx);
          await tx.query('UPDATE invoices SET embedding=$1::vector WHERE document_id=$2 AND data=$3::jsonb',[JSON.stringify(vector),id,JSON.stringify(invoice)]);
          await history(tx,id,'embedding_completed',{reason:'manual_correction'});
          await tx.query("UPDATE jobs SET status='done',locked_until=NULL WHERE id=$1 AND lock_token=$2",[job.id,job.lock_token]);
        });
      }
      else await db.query("UPDATE jobs SET status='done',locked_until=NULL WHERE id=$1 AND lock_token=$2",[job.id,job.lock_token]);
      return;
    }
    await stage('ocr');
    const data=await readFile(document.storage_path);
    const form=new MultipartFormData(); form.append('file',new Blob([data]),document.original_filename);
    let response;
    try {response=await parseFetch(`${config.ocrUrl}/parse`,{method:'POST',headers:{'X-Internal-Token':config.internalToken},body:form,dispatcher:parserAgent,signal:AbortSignal.timeout(3600000)});}
    catch {throw new ProcessingError('Parsing service unavailable or timed out.',true);}
    if(!response.ok) {
      const body=await response.json().catch(()=>({detail:'Parsing failed'}));
      throw new ProcessingError(`Parsing: ${String(body.detail).slice(0,1000)}`,response.status>=500);
    }
    const parsed=await response.json();
    await db.transaction(async tx=>{
      await assertLease(tx);
      await tx.query('DELETE FROM extracted_text WHERE document_id=$1',[id]);
      for(const page of parsed.pages) await tx.query('INSERT INTO extracted_text(id,document_id,page_number,raw_text,ocr_confidence,method,sheet_name) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),id,page.page_number,page.raw_text,page.ocr_confidence,page.method,page.sheet_name]);
      await tx.query('UPDATE documents SET page_count=$1 WHERE id=$2',[parsed.page_count,id]);
      await history(tx,id,'ocr_completed',{pages:parsed.page_count,methods:[...new Set(parsed.pages.map(p=>p.method))]});
    });
    await stage('extraction');
    const audit=async row=>db.query('INSERT INTO extraction_audits(id,document_id,timestamp,provider,model,prompt,raw_response,success) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),id,now(),row.provider,row.model,row.prompt,row.raw_response,row.success]);
    // A tabular ledger is kept as individual expected records rather than invented invoice fields.
    let invoice=null;
    if(!parsed.ledger_rows.length) invoice=await extract(parsed.pages.map(p=>p.raw_text).join('\n\n'),audit,aiSettings);
    await history(db,id,'extraction_completed',{mode:aiSettings.provider,model:aiSettings.provider==='offline'?null:aiSettings.model,ledger_rows:parsed.ledger_rows.length});
    await stage('validation');
    await db.transaction(async tx=>{
      await lockReconciliation(tx);
      await assertLease(tx);
      await tx.query('DELETE FROM ledger_rows WHERE document_id=$1',[id]);
      for(const row of parsed.ledger_rows) await tx.query('INSERT INTO ledger_rows(id,document_id,sheet_name,row_number,invoice_number,supplier_name,invoice_date,total,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),id,row.sheet_name,row.row_number,row.invoice_number,row.supplier_name,row.invoice_date,row.total,row.currency]);
      if(invoice) await saveInvoice(tx,id,invoice);
      else {
        await tx.query('DELETE FROM invoices WHERE document_id=$1',[id]);
        await tx.query('DELETE FROM validation_errors WHERE document_id=$1',[id]);
        for(const row of parsed.ledger_rows.filter(r=>r.total==null)) await tx.query('INSERT INTO validation_errors(id,document_id,rule_name,severity,message,field_name) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,'invalid_ledger_total','error',`Invalid total on ${row.sheet_name} row ${row.row_number}.`,'total']);
        const bad=parsed.ledger_rows.some(r=>r.total==null);
        await tx.query("UPDATE documents SET status=$1,stage='done',updated_at=$2 WHERE id=$3",[bad?'needs_review':'completed',now(),id]);
      }
      await reconcile(tx,[id]);
      await tx.query('UPDATE documents SET processing_ms=$1,extraction_mode=$2,extraction_model=$3,error_message=NULL,revision=revision+1 WHERE id=$4',[Math.round(performance.now()-start),parsed.ledger_rows.length?'ledger':aiSettings.provider,parsed.ledger_rows.length||aiSettings.provider==='offline'?null:aiSettings.model,id]);
      await tx.query("UPDATE jobs SET status='done',locked_until=NULL WHERE id=$1 AND lock_token=$2",[job.id,job.lock_token]);
      await history(tx,id,'processing_completed',{processing_ms:Math.round(performance.now()-start)});
    });
    if(invoice && config.semantic && db.postgres) {
      try {
        const vector=await embed(JSON.stringify(invoice));
        await db.query('UPDATE invoices SET embedding=$1::vector WHERE document_id=$2 AND data=$3::jsonb',[JSON.stringify(vector),id,JSON.stringify(invoice)]);
        await history(db,id,'embedding_completed');
      } catch(error) {await history(db,id,'embedding_failed',{message:error.message});}
    }
  } catch(error) {
    await db.transaction(async tx=>{
      const lease=(await tx.query('SELECT lock_token,status FROM jobs WHERE id=$1',[job.id])).rows[0];
      if(lease?.lock_token!==job.lock_token || lease.status!=='running') return;
      const retry=Boolean(error.retryable && job.attempts<3);
      const delay=1000*2**job.attempts;
      await tx.query('UPDATE jobs SET status=$1,available_at=$2,locked_until=NULL,last_error=$3 WHERE id=$4 AND lock_token=$5',[retry?'pending':'failed',new Date(Date.now()+delay).toISOString(),error.message,job.id,job.lock_token]);
      if(job.task!=='embedding')await tx.query('UPDATE documents SET status=$1,stage=$2,error_message=$3,updated_at=$4,processing_ms=$5 WHERE id=$6',[retry?'queued':'failed',retry?'retry_wait':'failed',error.message,now(),Math.round(performance.now()-start),id]);
      await history(tx,id,job.task==='embedding'?'embedding_failed':retry?'retry_scheduled':'processing_failed',{message:error.message,attempt:job.attempts,retry});
    });
  } finally {clearInterval(heartbeat);}
}
