import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Database} from '../src/db/index.js';
import {config} from '../src/config.js';
import {createApp} from '../src/app.js';
import {seedSamples,SAMPLE_BATCH} from '../src/samples.js';

let temp,db,app,server,base;
before(async()=>{
  temp=await mkdtemp(path.join(os.tmpdir(),'folio-samples-'));config.dataDir=temp;
  db=await new Database({url:'',file:path.join(temp,'test.sqlite')}).open();
  app=await createApp(db,{apiToken:'sample-test-token',dispatcher:{notify:async()=>{},close:async()=>{}}});
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await app.locals.close();await db.close();await rm(temp,{recursive:true,force:true});});
const headers={Authorization:'Bearer sample-test-token'};
test('sample creation requires workspace access',async()=>{
  assert.equal((await fetch(`${base}/api/workspace/samples`,{method:'POST'})).status,401);
});
test('samples are real files queued once, including concurrent requests',async()=>{
  const [first,second]=await Promise.all([seedSamples(db),seedSamples(db)]);
  assert.equal(first.length,5);assert.deepEqual(first.map(d=>d.id).sort(),second.map(d=>d.id).sort());
  assert.equal((await db.query('SELECT count(*) AS n FROM jobs')).rows[0].n,5);
  const docs=(await db.query('SELECT storage_path,batch_id FROM documents')).rows;
  for(const doc of docs){assert.equal(doc.batch_id,SAMPLE_BATCH);assert.ok((await readFile(doc.storage_path)).length>0);}
});
test('sample and active filters return labeled queued examples',async()=>{
  const res=await fetch(`${base}/api/documents?sample=true&status=active`,{headers});assert.equal(res.status,200);
  const result=await res.json();assert.equal(result.total,5);assert.equal(result.sample_count,5);assert.ok(result.documents.every(d=>d.is_sample));
  assert.equal((await(await fetch(`${base}/api/documents?sample=false`,{headers})).json()).total,0);
  assert.equal((await fetch(`${base}/api/documents?sample=wrong`,{headers})).status,400);
});
test('loading samples again is idempotent through the API',async()=>{
  const res=await fetch(`${base}/api/workspace/samples`,{method:'POST',headers});assert.equal(res.status,202);
  assert.equal((await res.json()).documents.length,5);
  assert.equal((await db.query('SELECT count(*) AS n FROM documents')).rows[0].n,5);
});
test('automatic samples do not change a workspace that already has user documents',async()=>{
  const separate=await new Database({url:'',file:path.join(temp,'existing-user.sqlite')}).open();
  try{
    const time=new Date().toISOString();
    await separate.query("INSERT INTO documents(id,original_filename,file_type,storage_path,status,batch_id,uploaded_at,updated_at) VALUES('user-document','user.csv','csv','unused','completed','user-batch',$1,$1)",[time]);
    assert.deepEqual(await seedSamples(separate,{onlyIfEmpty:true}),[]);
    assert.equal((await separate.query('SELECT count(*) AS n FROM documents')).rows[0].n,1);
  }finally{await separate.close();}
});
