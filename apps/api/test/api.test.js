import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Database} from '../src/db/index.js';
import {createApp} from '../src/app.js';
import {config} from '../src/config.js';
import {claimJob} from '../src/queue.js';
import {saveInvoice,reconcile,lockReconciliation} from '../src/documents.js';

let db,server,base,temp,app,id;
const auth={Authorization:'Bearer test-secret'};
before(async()=>{temp=await mkdtemp(path.join(os.tmpdir(),'folio-test-'));config.dataDir=temp;db=await new Database({url:'',file:path.join(temp,'test.sqlite')}).open();app=await createApp(db,{apiToken:'test-secret',dispatcher:{notify:async()=>{},close:async()=>{}}});server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;});
after(async()=>{await new Promise(resolve=>server.close(resolve));await app.locals.close();await db.close();await rm(temp,{recursive:true,force:true});});
test('authentication, consistent errors and parameter validation',async()=>{
  assert.equal((await fetch(`${base}/api/documents`)).status,401);
  for(const endpoint of ['?status=unknown','?page=-1','?limit=1000','?mode=bad'])assert.equal((await fetch(`${base}/api/documents${endpoint}`,{headers:auth})).status,400);
  const res=await fetch(`${base}/api/documents/not-an-id`,{headers:auth});assert.equal(res.status,404);assert.equal((await res.json()).error.code,'NOT_FOUND');
});
test('API and worker can initialize the same fresh SQLite database concurrently',async()=>{
  const file=path.join(temp,'concurrent.sqlite');
  const connections=await Promise.all([new Database({url:'',file}).open(),new Database({url:'',file}).open()]);
  try{for(const connection of connections)assert.equal((await connection.query('SELECT count(*) AS n FROM schema_migrations')).rows[0].n,2);}
  finally{await Promise.all(connections.map(connection=>connection.close()));}
});
test('upload returns queued and stores a durable job',async()=>{
  const form=new FormData();form.append('files[]',new Blob(['Invoice number: INV-1\nTotal: 110']),'invoice.csv');
  const res=await fetch(`${base}/api/documents`,{method:'POST',headers:auth,body:form});assert.equal(res.status,202);const body=await res.json();id=body.documents[0].id;
  assert.equal(body.documents[0].status,'queued');assert.equal((await db.query('SELECT count(*) AS n FROM jobs')).rows[0].n,1);
  assert.equal((await (await fetch(`${base}/documents/${id}/status`,{headers:auth})).json()).status,'queued');
});
test('signature mismatch rejects batch and removes uploaded files',async()=>{
  const beforeFiles=await readdir(path.join(temp,'uploads'));
  const form=new FormData();form.append('files',new Blob(['not pdf']),'fake.pdf');
  const res=await fetch(`${base}/api/documents`,{method:'POST',headers:auth,body:form});assert.equal(res.status,400);assert.equal((await res.json()).error.code,'INVALID_SIGNATURE');
  assert.deepEqual(await readdir(path.join(temp,'uploads')),beforeFiles);
});
test('job claim is exclusive and expired leases recover',async()=>{
  const a=await claimJob(db);assert.equal(a.document_id,id);assert.equal(await claimJob(db),null);
  await db.query('UPDATE jobs SET locked_until=$1 WHERE id=$2',['2000-01-01T00:00:00Z',a.id]);
  const recovered=await claimJob(db);assert.equal(recovered.id,a.id);assert.notEqual(recovered.lock_token,a.lock_token);assert.equal(recovered.attempts,2);
});
test('detail, correction, keyword search and history work together',async()=>{
  const invoice={invoice_number:'INV-1',invoice_date:'2026-09-14',supplier_name:'Acme',customer_name:'Client',subtotal:100,tax:10,total:150,currency:'USD',line_items:[{description:'Widget',quantity:2,unit_price:50,line_total:100}],extraction_confidence:.9};
  await db.transaction(async tx=>{await saveInvoice(tx,id,invoice);await reconcile(tx,[id]);});
  let detail=await (await fetch(`${base}/api/documents/${id}`,{headers:auth})).json();assert.equal(detail.status,'needs_review');assert.ok(detail.validation_errors.some(e=>e.rule==='total_mismatch'));assert.equal(detail.storage_path,undefined);
  const res=await fetch(`${base}/api/documents/${id}`,{method:'PATCH',headers:{...auth,'Content-Type':'application/json','If-Match':'0'},body:JSON.stringify({total:110})});assert.equal(res.status,200);detail=await res.json();assert.equal(detail.status,'completed');assert.ok(detail.processing_history.some(e=>e.event==='manual_correction'));
  assert.equal((await fetch(`${base}/api/documents/${id}`,{method:'PATCH',headers:{...auth,'Content-Type':'application/json','If-Match':'0'},body:'{"total":111}'})).status,409);
  assert.equal((await (await fetch(`${base}/api/documents?query=Widget`,{headers:auth})).json()).total,1);
  assert.equal((await (await fetch(`${base}/api/documents?query=does-not-exist`,{headers:auth})).json()).total,0);
  assert.equal((await fetch(`${base}/api/documents/${id}/file`,{headers:auth})).status,200);
});
test('invalid corrections and reprocessing a busy document fail clearly',async()=>{
  assert.equal((await fetch(`${base}/api/documents/${id}`,{method:'PATCH',headers:{...auth,'Content-Type':'application/json'},body:'{"total":"bad"}'})).status,400);
  const res=await fetch(`${base}/api/documents/${id}/reprocess`,{method:'POST',headers:auth});assert.equal(res.status,202);
  assert.equal((await fetch(`${base}/api/documents/${id}/reprocess`,{method:'POST',headers:auth})).status,409);
});
test('cross-document and ledger flags update in both directions after a correction',async()=>{
  const form=new FormData();form.append('files',new Blob(['Invoice number: PAIR\nTotal: 100']),'pair.csv');
  const res=await fetch(`${base}/api/documents`,{method:'POST',headers:auth,body:form});const peer=(await res.json()).documents[0].id;
  const template={invoice_number:'PAIR',invoice_date:'2026-09-14',supplier_name:'Acme',customer_name:'Client',subtotal:100,tax:0,total:100,currency:'USD',line_items:[],extraction_confidence:.9};
  await db.transaction(async tx=>{
    await lockReconciliation(tx);
    await db.query("UPDATE documents SET status='completed' WHERE id=$1 OR id=$2",[id,peer]);
    await saveInvoice(tx,id,template);await saveInvoice(tx,peer,{...template,subtotal:200,total:200});
    await reconcile(tx,[id,peer]);
  });
  for(const current of [id,peer])assert.ok((await db.query("SELECT rule_name FROM validation_errors WHERE document_id=$1 AND rule_name='cross_document_mismatch'",[current])).rows.length);
  await fetch(`${base}/api/documents/${peer}`,{method:'PATCH',headers:{...auth,'Content-Type':'application/json'},body:'{"total":100,"subtotal":100}'});
  for(const current of [id,peer])assert.equal((await db.query("SELECT rule_name FROM validation_errors WHERE document_id=$1 AND rule_name='cross_document_mismatch'",[current])).rows.length,0);
  // Reusing invoice numbers still produces a duplicate warning until the identity changes.
  assert.ok((await db.query("SELECT id FROM validation_errors WHERE document_id=$1 AND rule_name='duplicate_invoice'",[id])).rows.length);
  await fetch(`${base}/api/documents/${peer}`,{method:'PATCH',headers:{...auth,'Content-Type':'application/json'},body:'{"invoice_number":"NEW-IDENTITY","invoice_date":"2026-08-01"}'});
  assert.equal((await db.query('SELECT id FROM validation_errors WHERE document_id=$1',[id])).rows.length,0);
});
