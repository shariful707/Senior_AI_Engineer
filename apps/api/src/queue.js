import {Queue} from 'bullmq';
import IORedis from 'ioredis';
import {randomUUID} from 'node:crypto';
import {config} from './config.js';
import {now} from './documents.js';

export function createDispatcher() {
  if(!config.redisUrl) return {notify:async()=>{},close:async()=>{}};
  const connection=new IORedis(config.redisUrl,{maxRetriesPerRequest:1,connectTimeout:2000,enableOfflineQueue:false});
  connection.on('error',()=>{});
  const queue=new Queue('documents',{connection});
  queue.on('error',()=>{});
  return {
    // DB jobs are a transactional outbox; a worker polls them even if Redis is down.
    notify:async id=>{try {await queue.add('process',{documentId:id},{jobId:randomUUID(),removeOnComplete:100,removeOnFail:100});}catch(error){console.warn('Redis notification unavailable; durable worker polling will recover.',error.message);}},
    close:async()=>{await queue.close(); connection.disconnect();}
  };
}
export async function enqueue(db,id,task='process') {
  await db.query("INSERT INTO jobs(id,document_id,status,attempts,available_at,task) VALUES($1,$2,'pending',0,$3,$4) ON CONFLICT(document_id) DO UPDATE SET status='pending',attempts=0,available_at=excluded.available_at,task=excluded.task,locked_until=NULL,lock_token=NULL,last_error=NULL",[randomUUID(),id,now(),task]);
}
export async function claimJob(db,id=null) {
  const instant=now(), until=new Date(Date.now()+120000).toISOString(), token=randomUUID();
  const predicate="((status='pending' AND available_at<=$1) OR (status='running' AND locked_until<$1))";
  const suffix=db.postgres?' FOR UPDATE SKIP LOCKED':'';
  const result=await db.query(`UPDATE jobs SET status='running',attempts=attempts+1,locked_until=$2,lock_token=$3 WHERE id=(SELECT id FROM jobs WHERE ${predicate} ${id?'AND document_id=$4':''} ORDER BY available_at LIMIT 1${suffix}) RETURNING *`,[instant,until,token,...(id?[id]:[])]);
  return result.rows[0] || null;
}
