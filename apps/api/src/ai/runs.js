import {randomUUID} from 'node:crypto';
import {decode} from '../db/index.js';
import {now,history} from '../documents.js';
import {getAISettings,getAIStatus,protectSettings,revealSettings,saveAISettings,AIError} from './settings.js';
import {structuredChat} from './provider.js';
import {assistantContext,verifyAssistantOutput,assistantSchema,ASSISTANT_PROMPT} from './assistant.js';

export async function enqueueAI(db,{documentId=null,task,question='',settings=null,revision=null}){
  const id=randomUUID(),input=settings?{settings:await protectSettings(settings)}:{question};
  await db.transaction(async tx=>{
    if(tx.postgres)await tx.query('SELECT pg_advisory_xact_lock(691215)');
    const pending=Number((await tx.query("SELECT count(*) AS count FROM ai_runs WHERE status IN ('queued','processing')")).rows[0].count);
    if(pending>=20)throw new AIError('The AI queue is busy. Wait for current requests to finish.',429,'AI_QUEUE_FULL');
    if(task==='configure'&&(await tx.query("SELECT id FROM ai_runs WHERE task='configure' AND status IN ('queued','processing')")).rows.length)throw new AIError('A connection test is already running. Wait for its result.',409,'AI_TEST_BUSY');
    if(documentId&&(await tx.query("SELECT id FROM ai_runs WHERE document_id=$1 AND status IN ('queued','processing')",[documentId])).rows.length)throw new AIError('This document already has an AI request running.',409,'AI_DOCUMENT_BUSY');
    await tx.query("INSERT INTO ai_runs(id,document_id,task,status,input,document_revision,provider,model,created_at,updated_at) VALUES($1,$2,$3,'queued',$4,$5,$6,$7,$8,$8)",[id,documentId,task,JSON.stringify(input),revision,settings?.provider||null,settings?.model||null,now()]);
  });
  return id;
}
export async function claimAIRun(db){
  const timestamp=now();
  await db.query("UPDATE ai_runs SET status='failed',error_message='The AI worker stopped repeatedly. Please retry.',updated_at=$1 WHERE status='processing' AND locked_until<$1 AND attempts>=3",[timestamp]);
  const token=randomUUID(),until=new Date(Date.now()+120000).toISOString();
  const suffix=db.postgres?' FOR UPDATE SKIP LOCKED':'';
  return (await db.query(`UPDATE ai_runs SET status='processing',attempts=attempts+1,lock_token=$2,locked_until=$3,updated_at=$1 WHERE id=(SELECT id FROM ai_runs WHERE (status='queued' OR (status='processing' AND locked_until<$1)) AND attempts<3 ORDER BY created_at LIMIT 1${suffix}) RETURNING *`,[timestamp,token,until])).rows[0]||null;
}
export async function publicAIRun(db,id){
  const row=(await db.query('SELECT a.*,d.revision AS current_revision FROM ai_runs a LEFT JOIN documents d ON d.id=a.document_id WHERE a.id=$1',[id])).rows[0];
  if(!row)return null;
  const input=decode(row.input);
  return {id:row.id,document_id:row.document_id,task:row.task,question:row.task==='question'?input.question:'',status:row.status,result:row.output?decode(row.output):null,error_message:row.error_message,provider:row.provider,model:row.model,created_at:row.created_at,updated_at:row.updated_at,processing_ms:row.processing_ms,document_revision:row.document_revision,stale:row.document_id!=null&&row.document_revision!==row.current_revision};
}
export async function runAI(db,run){
  const started=performance.now();
  const heartbeat=setInterval(()=>db.query("UPDATE ai_runs SET locked_until=$1 WHERE id=$2 AND lock_token=$3 AND status='processing'",[new Date(Date.now()+120000).toISOString(),run.id,run.lock_token]).catch(console.error),30000);heartbeat.unref();
  const assertOwner=async tx=>{
    const row=(await tx.query(`SELECT status,lock_token FROM ai_runs WHERE id=$1${tx.postgres?' FOR UPDATE':''}`,[run.id])).rows[0];
    if(row?.status!=='processing'||row.lock_token!==run.lock_token)throw new AIError('AI request was cancelled or reassigned.',409,'AI_LEASE_LOST');
  };
  let audit={};
  try{
    const input=decode(run.input);let settings,result,revision=run.document_revision;
    if(run.task==='configure'){
      settings=await revealSettings(input.settings);
      const schema={type:'object',additionalProperties:false,properties:{ready:{type:'boolean'}},required:['ready']};
      const response=await structuredChat(settings,{messages:[{role:'system',content:'This is a structured-output connection test. Return the JSON object with ready set to true.'},{role:'user',content:'Confirm that you can produce the requested JSON.'}],schema,name:'connection_test'});
      if(response.data?.ready!==true||Object.keys(response.data).length!==1)throw new AIError('The model did not pass the structured-output connection test.',422,'AI_TEST_FAILED');
      settings.verifiedAt=now();
      result={connected:true,provider:settings.provider,model:settings.model,latency_ms:response.latency_ms,usage:response.usage};
      audit={response:response.raw};
    }else{
      settings=await getAISettings(db);
      if(settings.provider==='offline')throw new AIError('Connect an LLM in AI settings before using the document assistant.',409,'AI_NOT_CONFIGURED');
      const context=await assistantContext(db,run.document_id,input.question,run.task);
      revision=context.document.revision;
      const messages=[{role:'system',content:ASSISTANT_PROMPT},{role:'user',content:context.prompt}];
      const response=await structuredChat(settings,{messages,schema:assistantSchema,name:'document_assistance'});
      result={...verifyAssistantOutput(response.data,context),usage:response.usage};
      audit={prompt:messages,response:response.raw};
    }
    await db.transaction(async tx=>{
      if(tx.postgres&&run.task==='configure')await tx.query('SELECT pg_advisory_xact_lock(691216)');
      await assertOwner(tx);
      if(run.task==='configure')await saveAISettings(tx,settings);
      await tx.query("UPDATE ai_runs SET status='completed',output=$1,audit=$2,provider=$3,model=$4,document_revision=$5,updated_at=$6,processing_ms=$7,locked_until=NULL WHERE id=$8 AND lock_token=$9",[JSON.stringify(result),JSON.stringify(audit),settings.provider,settings.model,revision,now(),Math.round(performance.now()-started),run.id,run.lock_token]);
      if(run.document_id)await history(tx,run.document_id,'ai_assistance_completed',{task:run.task,model:settings.model,request_id:run.id});
    });
  }catch(error){
    await db.query("UPDATE ai_runs SET status='failed',error_message=$1,audit=$2,updated_at=$3,processing_ms=$4,locked_until=NULL WHERE id=$5 AND lock_token=$6 AND status='processing'",[error.message,JSON.stringify(audit),now(),Math.round(performance.now()-started),run.id,run.lock_token]);
  }finally{clearInterval(heartbeat);}
}
export async function disableAI(db){
  await db.transaction(async tx=>{
    if(tx.postgres)await tx.query('SELECT pg_advisory_xact_lock(691216)');
    await saveAISettings(tx,{provider:'offline',model:'',baseUrl:'',apiKey:'',responseFormat:'strict',verifiedAt:null});
    await tx.query("UPDATE ai_runs SET status='cancelled',error_message='AI was disabled in settings.',updated_at=$1,locked_until=NULL WHERE status IN ('queued','processing')",[now()]);
  });
  return getAIStatus(db);
}
