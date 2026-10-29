import {randomUUID} from 'node:crypto';
import {mkdir,copyFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config} from './config.js';
import {history,now} from './documents.js';
import {enqueue} from './queue.js';

export const SAMPLE_BATCH='folio-samples-v1';
const files=[
  ['sample-invoice.pdf','pdf'],['sample-review.pdf','pdf'],
  ['sample-delivery.pdf','pdf'],['sample-scan.png','png'],['sample-ledger.xlsx','xlsx']
];

export async function seedSamples(db,{onlyIfEmpty=false}={}) {
  const created=[];
  await mkdir(path.join(config.dataDir,'uploads'),{recursive:true});
  try {
    return await db.transaction(async tx=>{
      if(tx.postgres)await tx.query('SELECT pg_advisory_xact_lock(691214)');
      const existing=(await tx.query('SELECT id,original_filename AS filename,status FROM documents WHERE batch_id=$1 ORDER BY original_filename',[SAMPLE_BATCH])).rows;
      if(existing.length)return existing;
      if(onlyIfEmpty && Number((await tx.query('SELECT count(*) AS count FROM documents')).rows[0].count)>0)return [];
      const documents=[];
      for(const [filename,type] of files){
        const id=randomUUID(),destination=path.join(config.dataDir,'uploads',randomUUID());
        await copyFile(fileURLToPath(new URL(`../samples/${filename}`,import.meta.url)),destination);
        created.push(destination);
        await tx.query("INSERT INTO documents(id,original_filename,file_type,storage_path,status,stage,batch_id,uploaded_by,uploaded_at,updated_at) VALUES($1,$2,$3,$4,'queued','queued',$5,'sample',$6,$6)",[id,filename,type,destination,SAMPLE_BATCH,now()]);
        await history(tx,id,'uploaded',{sample:true,description:'Synthetic example document; safe to edit.'});
        await enqueue(tx,id);
        documents.push({id,filename,status:'queued'});
      }
      return documents;
    });
  }catch(error){await Promise.all(created.map(file=>unlink(file).catch(()=>{})));throw error;}
}
