import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Database} from '../src/db/index.js';
import {saveInvoice,reconcile} from '../src/documents.js';
import {claimJob,enqueue} from '../src/queue.js';
import {emptyInvoice} from '../../../packages/shared-types/invoice.js';
import {Queue,Worker} from 'bullmq';
import IORedis from 'ioredis';
test('Postgres migration, full text, pgvector, cross validation and concurrent claims',{skip:!process.env.POSTGRES_TEST_URL},async()=>{
  const db=await new Database({url:process.env.POSTGRES_TEST_URL}).open(),ids=[];
  try{
    for(let n=0;n<2;n++){
      const id=randomUUID();ids.push(id);
      await db.query("INSERT INTO documents(id,original_filename,file_type,storage_path,status,batch_id,uploaded_at,updated_at) VALUES($1,'test.pdf','pdf','unused','completed','test',$2,$2)",[id,new Date().toISOString()]);
      await saveInvoice(db,id,{...emptyInvoice(),invoice_number:'PG-INVOICE',invoice_date:'2026-09-14',supplier_name:'Test Supplier',total:100+n,currency:'USD',extraction_confidence:.9,line_items:[{description:'searchable-widget',quantity:1,unit_price:100,line_total:100}]});
      await enqueue(db,id);
    }
    assert.equal((await db.query("SELECT count(*) AS n FROM invoices WHERE document_id=$1 AND search_vector @@ plainto_tsquery('simple','searchable-widget')",[ids[0]])).rows[0].n,'1');
    await db.transaction(async tx=>{await tx.query('SELECT pg_advisory_xact_lock(691213)');await reconcile(tx,ids);});
    const errors=(await db.query('SELECT rule_name FROM validation_errors WHERE document_id=$1',[ids[0]])).rows;
    assert.ok(errors.some(e=>e.rule_name==='duplicate_invoice'));assert.ok(errors.some(e=>e.rule_name==='cross_document_mismatch'));
    const claims=await Promise.all([claimJob(db,ids[0]),claimJob(db,ids[0])]);assert.equal(claims.filter(Boolean).length,1);
    const vector=Array(1536).fill(0);vector[0]=1;
    await db.query('UPDATE invoices SET embedding=$1::vector WHERE document_id=$2',[JSON.stringify(vector),ids[0]]);
    const nearest=await db.query('SELECT document_id,1-(embedding <=> $1::vector) AS similarity FROM invoices WHERE document_id=$2 ORDER BY embedding <=> $1::vector LIMIT 1',[JSON.stringify(vector),ids[0]]);
    assert.equal(nearest.rows[0].document_id,ids[0]);assert.equal(Number(nearest.rows[0].similarity),1);
  }finally{for(const id of ids)await db.query('DELETE FROM documents WHERE id=$1',[id]);await db.close();}
});
test('Redis/BullMQ dispatches a real job',{skip:!process.env.REDIS_TEST_URL},async()=>{
  const connection=new IORedis(process.env.REDIS_TEST_URL,{maxRetriesPerRequest:null});
  const name=`test-${randomUUID()}`,queue=new Queue(name,{connection});let worker;
  try{
    const delivered=new Promise((resolve,reject)=>{worker=new Worker(name,async job=>{resolve(job.data);},{connection});worker.on('error',reject);});
    await queue.add('test',{documentId:'sample'});
    const result=await Promise.race([delivered,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Redis job timeout')),10000);timer.unref();})]);
    assert.equal(result.documentId,'sample');
  }finally{await worker?.close();await queue.obliterate({force:true});await queue.close();connection.disconnect();}
});
