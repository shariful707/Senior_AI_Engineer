import {Worker} from 'bullmq';
import IORedis from 'ioredis';
import {Database} from '../../api/src/db/index.js';
import {config} from '../../api/src/config.js';
import {claimJob} from '../../api/src/queue.js';
import {runJob} from './pipeline.js';
import {claimAIRun,runAI} from '../../api/src/ai/runs.js';
export async function startWorker(db) {
  let stopped=false, active=false, current=Promise.resolve();
  const tick=async id=>{
    if(stopped || active) return;
    active=true;
    try {const job=await claimJob(db,id); if(job) await runJob(db,job);else{const aiRun=await claimAIRun(db);if(aiRun)await runAI(db,aiRun);}}
    catch(error) {console.error('Worker failure:',error.message);} finally {active=false;}
  };
  const timer=setInterval(()=>{if(!active) current=tick();},500);
  let worker,connection;
  if(config.redisUrl) {
    connection=new IORedis(config.redisUrl,{maxRetriesPerRequest:null});
    connection.on('error',()=>{});
    worker=new Worker('documents',async job=>{if(!active) {current=tick(job.data.documentId); await current;}},{connection,concurrency:1});
    worker.on('error',error=>console.error('Redis worker:',error.message));
  }
  console.log('Document worker ready; durable queue polling enabled.');
  return async()=>{stopped=true;clearInterval(timer);await worker?.close();await current;connection?.disconnect();};
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/worker/src/main.js')) {
  const db=await new Database().open();
  const stop=await startWorker(db);
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await stop();await db.close();process.exit(0);});
}
