import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {Database} from '../src/db/index.js';
import {enqueue,claimJob} from '../src/queue.js';
import {saveInvoice,reconcile,lockReconciliation} from '../src/documents.js';
import {runJob as processJob} from '../../worker/src/pipeline.js';
const runJob=(db,job)=>processJob(db,job,{parseFetch:global.fetch});
let db,temp;const fetchOriginal=global.fetch;
before(async()=>{temp=await mkdtemp(path.join(os.tmpdir(),'folio-pipeline-'));db=await new Database({url:'',file:path.join(temp,'pipeline.sqlite')}).open();});
after(async()=>{global.fetch=fetchOriginal;await db.close();await rm(temp,{recursive:true,force:true});});
async function createDocument(){
  const id=randomUUID(),file=path.join(temp,id),time=new Date().toISOString();await writeFile(file,'placeholder');
  await db.query("INSERT INTO documents(id,original_filename,file_type,storage_path,status,batch_id,uploaded_at,updated_at) VALUES($1,'fixture.pdf','pdf',$2,'queued','batch',$3,$3)",[id,file,time]);await enqueue(db,id);return id;
}
const parsed=()=>({page_count:1,ledger_rows:[],pages:[{page_number:1,raw_text:'Invoice number: TEST\nInvoice date: 2026-09-14\nSupplier: Acme\nCustomer: Northwind\nSubtotal: 100\nTax: 10\nTotal: 110\nCurrency: USD',ocr_confidence:null,method:'pdf_text',sheet_name:null}]});
test('transient parser failure is retried and recovery commits the result',async()=>{
  const id=await createDocument();global.fetch=async()=>{throw new Error('service down');};
  await runJob(db,await claimJob(db,id));
  let row=(await db.query('SELECT status,stage FROM documents WHERE id=$1',[id])).rows[0];assert.equal(row.status,'queued');assert.equal(row.stage,'retry_wait');
  await db.query('UPDATE jobs SET available_at=$1 WHERE document_id=$2',['2000-01-01T00:00:00Z',id]);
  global.fetch=async()=>new Response(JSON.stringify(parsed()));await runJob(db,await claimJob(db,id));
  row=(await db.query('SELECT status FROM documents WHERE id=$1',[id])).rows[0];assert.equal(row.status,'completed');
  assert.equal((await db.query('SELECT count(*) AS n FROM extraction_audits WHERE document_id=$1',[id])).rows[0].n,1);
});
test('permanent parsing failure does not retry or crash the worker',async()=>{
  const id=await createDocument();global.fetch=async()=>new Response('{"detail":"Corrupted file"}',{status:422});
  await runJob(db,await claimJob(db,id));const doc=(await db.query('SELECT * FROM documents WHERE id=$1',[id])).rows[0];assert.equal(doc.status,'failed');assert.match(doc.error_message,/Corrupted file/);
});
test('a stale worker cannot replace a newly leased document result',async()=>{
  const id=await createDocument(),old=await claimJob(db,id);
  await db.query('UPDATE jobs SET locked_until=$1 WHERE document_id=$2',['2000-01-01T00:00:00Z',id]);const current=await claimJob(db,id);
  global.fetch=async()=>new Response(JSON.stringify(parsed()));await runJob(db,old);
  assert.equal((await db.query('SELECT status FROM documents WHERE id=$1',[id])).rows[0].status,'queued');
  assert.equal((await db.query('SELECT lock_token FROM jobs WHERE document_id=$1',[id])).rows[0].lock_token,current.lock_token);
});
test('ledger mismatch is visible on both records and clears after correction',async()=>{
  const unique=parsed();unique.pages[0].raw_text=unique.pages[0].raw_text.replace('TEST','LEDGERTEST');
  const invoiceId=await createDocument();global.fetch=async()=>new Response(JSON.stringify(unique));await runJob(db,await claimJob(db,invoiceId));
  const ledgerId=await createDocument();
  global.fetch=async()=>new Response(JSON.stringify({...parsed(),ledger_rows:[{sheet_name:'Sheet1',row_number:2,invoice_number:'LEDGERTEST',supplier_name:'Acme',invoice_date:'2026-09-14',total:150,currency:'USD'}]}));
  await runJob(db,await claimJob(db,ledgerId));
  for(const id of [invoiceId,ledgerId])assert.ok((await db.query("SELECT id FROM validation_errors WHERE document_id=$1 AND rule_name='cross_document_mismatch'",[id])).rows.length);
  const invoice=JSON.parse((await db.query('SELECT data FROM invoices WHERE document_id=$1',[invoiceId])).rows[0].data);
  await db.transaction(async tx=>{await lockReconciliation(tx);await saveInvoice(tx,invoiceId,{...invoice,total:150,subtotal:140});await reconcile(tx,[invoiceId]);});
  for(const id of [invoiceId,ledgerId])assert.equal((await db.query("SELECT id FROM validation_errors WHERE document_id=$1 AND rule_name='cross_document_mismatch'",[id])).rows.length,0);
});
