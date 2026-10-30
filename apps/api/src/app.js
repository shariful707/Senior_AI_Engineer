import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import {mkdir,unlink,open,access} from 'node:fs/promises';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {config} from './config.js';
import {decode} from './db/index.js';
import {documentDetail,history,saveInvoice,reconcile,lockReconciliation,now} from './documents.js';
import {enqueue,createDispatcher} from './queue.js';
import {validatePatch} from '../../../packages/shared-types/invoice.js';
import {embed} from './extraction.js';
import {seedSamples,SAMPLE_BATCH} from './samples.js';
import {getAISettings,getAIStatus,candidateSettings,AIError} from './ai/settings.js';
import {localModels} from './ai/provider.js';
import {enqueueAI,publicAIRun,disableAI} from './ai/runs.js';

const statuses=['queued','processing','completed','needs_review','failed'];
export class ApiError extends Error {constructor(status,code,message){super(message);this.status=status;this.code=code;}}
const safeEqual=(a,b)=>{const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length && timingSafeEqual(left,right);};
const fileType=async file=>{
  const ext=path.extname(file.originalname).slice(1).toLowerCase();
  const type={jpeg:'jpg',tif:'tiff'}[ext]||ext;
  if(!['pdf','jpg','png','tiff','xlsx','xls','csv'].includes(type)) throw new ApiError(400,'UNSUPPORTED_TYPE',`Unsupported file type: ${ext||'none'}.`);
  const handle=await open(file.path,'r');const bytes=Buffer.alloc(Math.min(4096,file.size));
  try{await handle.read(bytes,0,bytes.length,0);}finally{await handle.close();}
  const starts=hex=>bytes.subarray(0,hex.length/2).equals(Buffer.from(hex,'hex'));
  const valid={pdf:bytes.subarray(0,5).toString()==='%PDF-',jpg:starts('ffd8ff'),png:starts('89504e470d0a1a0a'),tiff:starts('49492a00')||starts('4d4d002a'),xlsx:starts('504b0304'),xls:starts('d0cf11e0a1b11ae1'),csv:!bytes.includes(0) && bytes.length>0};
  if(!valid[type])throw new ApiError(400,'INVALID_SIGNATURE',`File signature does not match ${file.originalname}.`);
  return type;
};
export async function createApp(db,{dispatcher=createDispatcher(),apiToken=config.apiToken}={}) {
  await mkdir(path.join(config.dataDir,'uploads'),{recursive:true});
  const app=express();
  app.disable('x-powered-by');
  app.use(helmet({contentSecurityPolicy:{directives:{'img-src':["'self'",'data:','blob:'],'frame-src':["'self'",'blob:']}}}));
  app.use(cors({origin:process.env.CORS_ORIGIN||'http://localhost:5173',exposedHeaders:['Content-Disposition']}));
  app.use(express.json({limit:'2mb'}));
  app.get('/health',async(req,res)=>{await db.query('SELECT 1');const ai=await getAIStatus(db);res.json({status:'ok',database:db.postgres?'postgres':'sqlite',extraction_mode:ai.provider,ai,semantic_search:config.semantic&&db.postgres&&Boolean(config.apiKey),authentication:Boolean(apiToken),limits:{max_upload_mb:config.maxUpload/1024/1024,max_files:20}});});
  const router=express.Router();
  router.use((req,res,next)=>{
    if(apiToken && !safeEqual(req.headers.authorization||'',`Bearer ${apiToken}`))return next(new ApiError(401,'UNAUTHORIZED','A valid workspace token is required.'));
    next();
  });
  router.use(rateLimit({windowMs:60000,limit:300,standardHeaders:'draft-8',legacyHeaders:false,handler:(req,res)=>res.status(429).json({error:{code:'RATE_LIMITED',message:'Too many requests; try again in a minute.'}})}));
  const aiLimit=rateLimit({windowMs:60000,limit:20,standardHeaders:'draft-8',legacyHeaders:false,handler:(req,res)=>res.status(429).json({error:{code:'AI_RATE_LIMITED',message:'Too many AI requests. Wait a minute and retry.'}})});
  router.get('/ai/settings',async(req,res)=>res.json(await getAIStatus(db)));
  router.get('/ai/models',aiLimit,async(req,res)=>res.json({models:await localModels(typeof req.query.base_url==='string'?req.query.base_url:config.ollamaUrl)}));
  router.post('/ai/configure',aiLimit,async(req,res)=>{
    const settings=await candidateSettings(req.body,await getAISettings(db));
    const id=await enqueueAI(db,{task:'configure',settings});
    res.status(202).json({id,status:'queued',message:'The worker will test structured output before enabling this provider.'});
  });
  router.post('/ai/disable',aiLimit,async(req,res)=>res.json(await disableAI(db)));
  router.get('/ai/runs/:runId',async(req,res)=>{
    const run=await publicAIRun(db,req.params.runId);if(!run)throw new ApiError(404,'NOT_FOUND','AI request not found.');res.json(run);
  });
  app.locals.loadSamples=async options=>{
    const documents=await seedSamples(db,options);
    for(const document of documents)if(document.status==='queued')void dispatcher.notify(document.id);
    return documents;
  };
  router.post('/workspace/samples',async(req,res)=>{
    const documents=await app.locals.loadSamples();
    res.status(documents.some(d=>d.status==='queued')?202:200).json({documents,sample:true});
  });
  const upload=multer({storage:multer.diskStorage({destination:path.join(config.dataDir,'uploads'),filename:(req,file,cb)=>cb(null,randomUUID())}),limits:{fileSize:config.maxUpload,files:20,fields:0}}).any();
  router.post('/documents',(req,res,next)=>upload(req,res,error=>{
    if(error){Promise.all((req.files||[]).map(f=>unlink(f.path).catch(()=>{}))).finally(()=>next(error));return;}
    next();
  }),async(req,res)=>{
    const files=req.files||[];
    let committed=false;
    try {
      if(!files.length)throw new ApiError(400,'NO_FILES','Upload at least one file using files or files[].');
      if(files.some(f=>!['files','files[]'].includes(f.fieldname)))throw new ApiError(400,'INVALID_FIELD','Use the multipart field files or files[].');
      const batchId=randomUUID(),rows=[];
      for(const file of files) {
        file.originalname=path.basename(file.originalname.replaceAll('\\','/'));
        rows.push({id:randomUUID(),filename:file.originalname,file_type:await fileType(file),file});
      }
      await db.transaction(async tx=>{
        for(const row of rows) {
          await tx.query("INSERT INTO documents(id,original_filename,file_type,storage_path,status,stage,batch_id,uploaded_at,updated_at) VALUES($1,$2,$3,$4,'queued','queued',$5,$6,$6)",[row.id,row.filename,row.file_type,row.file.path,batchId,now()]);
          await history(tx,row.id,'uploaded',{batch_id:batchId,bytes:row.file.size});
          await enqueue(tx,row.id);
        }
      });
      committed=true;
      for(const row of rows) void dispatcher.notify(row.id);
      res.status(202).json({batch_id:batchId,documents:rows.map(({id,filename})=>({id,filename,status:'queued'}))});
    } finally {if(!committed)await Promise.all(files.map(f=>unlink(f.path).catch(()=>{})));}
  });
  router.get('/documents',async(req,res)=>{
    const {query='',status='',mode='keyword',sample=''}=req.query;
    const page=Number(req.query.page||1),limit=Number(req.query.limit||25);
    if(typeof query!=='string'||query.length>500||typeof status!=='string'||status&&!statuses.includes(status)&&status!=='active'||!Number.isInteger(page)||page<1||!Number.isInteger(limit)||limit<1||limit>100||!['keyword','semantic'].includes(mode)||!['','true','false'].includes(sample))throw new ApiError(400,'INVALID_QUERY','Invalid search, status, pagination or search mode.');
    const values=[],where=[];
    const bind=value=>{values.push(value);return `$${values.length}`;};
    if(status==='active')where.push("d.status IN ('queued','processing')");
    else if(status)where.push(`d.status=${bind(status)}`);
    if(sample)where.push(`d.batch_id${sample==='true'?'=':'<>'}${bind(SAMPLE_BATCH)}`);
    let score='NULL AS similarity',order='d.uploaded_at DESC,d.id DESC';
    if(query && mode==='semantic') {
      if(!db.postgres||!config.semantic||!config.apiKey)throw new ApiError(503,'SEMANTIC_UNAVAILABLE','Semantic search requires PostgreSQL, enabled embeddings and an AI key.');
      const vector=await embed(query);
      const marker=bind(JSON.stringify(vector));
      where.push('i.embedding IS NOT NULL');score=`1-(i.embedding <=> ${marker}::vector) AS similarity`;order=`i.embedding <=> ${marker}::vector`;
    } else if(query) {
      if(db.postgres)where.push(`(i.search_vector @@ plainto_tsquery('simple',${bind(query)}) OR d.original_filename ILIKE ${bind('%'+query.replaceAll('%','\\%').replaceAll('_','\\_')+'%')} OR EXISTS (SELECT 1 FROM ledger_rows l WHERE l.document_id=d.id AND (l.invoice_number ILIKE ${bind('%'+query.replaceAll('%','\\%').replaceAll('_','\\_')+'%')} OR l.supplier_name ILIKE ${bind('%'+query.replaceAll('%','\\%').replaceAll('_','\\_')+'%')})))`);
      else {const marker=bind('%'+query.toLowerCase().replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_')+'%');where.push(`(lower(coalesce(i.search_text,'')||' '||d.original_filename) LIKE ${marker} ESCAPE '\\' OR EXISTS(SELECT 1 FROM ledger_rows l WHERE l.document_id=d.id AND lower(l.invoice_number||' '||coalesce(l.supplier_name,'')) LIKE ${marker} ESCAPE '\\'))`);}
    }
    const from=`FROM documents d LEFT JOIN invoices i ON d.id=i.document_id ${where.length?'WHERE '+where.join(' AND '):''}`;
    // Semantic placeholders appear only in SELECT/ORDER BY and are excluded from count SQL.
    const countValues=query&&mode==='semantic'?values.slice(0,-1):values;
    const total=Number((await db.query(`SELECT count(*) AS count ${from}`,countValues)).rows[0].count);
    const rows=(await db.query(`SELECT d.id,d.original_filename,d.file_type,d.batch_id,d.status,d.stage,d.uploaded_at,d.processing_ms,d.error_message,i.invoice_number,i.supplier_name,i.total,i.currency,${score} ${from} ORDER BY ${order} LIMIT ${bind(limit)} OFFSET ${bind((page-1)*limit)}`,values)).rows.map(row=>({...row,is_sample:row.batch_id===SAMPLE_BATCH}));
    const counts=(await db.query('SELECT status,count(*) AS count FROM documents GROUP BY status')).rows;
    const sampleCount=Number((await db.query('SELECT count(*) AS count FROM documents WHERE batch_id=$1',[SAMPLE_BATCH])).rows[0].count);
    res.json({documents:rows,total,page,limit,pages:Math.ceil(total/limit),sample_count:sampleCount,counts:Object.fromEntries(counts.map(r=>[r.status,Number(r.count)]))});
  });
  router.param('id',(req,res,next,id)=>{if(!/^[a-f0-9-]{36}$/i.test(id))return next(new ApiError(404,'NOT_FOUND','Document not found.'));next();});
  router.get('/documents/:id/status',async(req,res)=>{
    const row=(await db.query('SELECT id,status,stage,updated_at,error_message FROM documents WHERE id=$1',[req.params.id])).rows[0];
    if(!row)throw new ApiError(404,'NOT_FOUND','Document not found.');res.json(row);
  });
  router.get('/documents/:id',async(req,res)=>{
    const detail=await documentDetail(db,req.params.id);
    if(!detail)throw new ApiError(404,'NOT_FOUND','Document not found.');res.json(detail);
  });
  router.get('/documents/:id/ai',async(req,res)=>{
    if(!(await db.query('SELECT id FROM documents WHERE id=$1',[req.params.id])).rows.length)throw new ApiError(404,'NOT_FOUND','Document not found.');
    const ids=(await db.query("SELECT id FROM ai_runs WHERE document_id=$1 ORDER BY created_at DESC LIMIT 20",[req.params.id])).rows;
    res.json({runs:await Promise.all(ids.map(row=>publicAIRun(db,row.id)))});
  });
  router.post('/documents/:id/ai',aiLimit,async(req,res)=>{
    if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).some(key=>!['task','question'].includes(key)))throw new AIError('Invalid document assistant request.');
    const {task,question=''}=req.body;
    if(!['summary','review','question'].includes(task)||typeof question!=='string'||question.length>1000||task==='question'&&!question.trim())throw new AIError('Choose an AI task and enter a question of up to 1000 characters.');
    const doc=(await db.query('SELECT status,revision FROM documents WHERE id=$1',[req.params.id])).rows[0];
    if(!doc)throw new ApiError(404,'NOT_FOUND','Document not found.');
    if(['queued','processing'].includes(doc.status))throw new ApiError(409,'DOCUMENT_BUSY','Wait for document processing to finish.');
    if((await getAIStatus(db)).enabled!==true)throw new AIError('Connect a model in AI settings first.',409,'AI_NOT_CONFIGURED');
    const id=await enqueueAI(db,{documentId:req.params.id,task,question:question.trim(),revision:doc.revision});
    res.status(202).json({id,status:'queued'});
  });
  router.get('/documents/:id/file',async(req,res)=>{
    const row=(await db.query('SELECT storage_path,original_filename FROM documents WHERE id=$1',[req.params.id])).rows[0];
    if(!row)throw new ApiError(404,'NOT_FOUND','Document not found.');
    res.download(row.storage_path,row.original_filename);
  });
  router.patch('/documents/:id',async(req,res)=>{
    if(!validatePatch(req.body))throw new ApiError(400,'INVALID_CORRECTION','Correction must contain only valid invoice fields with the expected types.');
    await db.transaction(async tx=>{
      await lockReconciliation(tx);
      const row=(await tx.query('SELECT d.status,d.revision,i.data FROM documents d LEFT JOIN invoices i ON i.document_id=d.id WHERE d.id=$1',[req.params.id])).rows[0];
      if(!row)throw new ApiError(404,'NOT_FOUND','Document not found.');
      if(['queued','processing'].includes(row.status))throw new ApiError(409,'DOCUMENT_BUSY','Wait for processing to finish before correcting.');
      if(!row.data)throw new ApiError(409,'NO_INVOICE','This document has no extracted invoice to correct.');
      if(req.headers['if-match'] && req.headers['if-match']!==String(row.revision))throw new ApiError(409,'REVISION_CONFLICT','The document changed. Reload before saving.');
      const before=decode(row.data),after={...before,...req.body};
      await saveInvoice(tx,req.params.id,after);
      await history(tx,req.params.id,'manual_correction',{before,after,fields:Object.keys(req.body)});
      await reconcile(tx,[req.params.id]);
      await tx.query('UPDATE documents SET revision=revision+1,updated_at=$1 WHERE id=$2',[now(),req.params.id]);
      if(config.semantic&&db.postgres)await enqueue(tx,req.params.id,'embedding');
    });
    if(config.semantic&&db.postgres)void dispatcher.notify(req.params.id);
    res.json(await documentDetail(db,req.params.id));
  });
  router.post('/documents/:id/reprocess',async(req,res)=>{
    await db.transaction(async tx=>{
      await lockReconciliation(tx);
      const row=(await tx.query('SELECT status FROM documents WHERE id=$1',[req.params.id])).rows[0];
      if(!row)throw new ApiError(404,'NOT_FOUND','Document not found.');
      if(['queued','processing'].includes(row.status))throw new ApiError(409,'DOCUMENT_BUSY','Document is already queued or processing.');
      await tx.query("UPDATE documents SET status='queued',stage='queued',updated_at=$1,error_message=NULL WHERE id=$2",[now(),req.params.id]);
      await tx.query('DELETE FROM validation_errors WHERE document_id=$1',[req.params.id]);
      await reconcile(tx,[req.params.id],{skipIds:[req.params.id]});
      await enqueue(tx,req.params.id);await history(tx,req.params.id,'reprocessed');
    });
    void dispatcher.notify(req.params.id);res.status(202).json({id:req.params.id,status:'queued'});
  });
  router.use((req,res,next)=>next(new ApiError(404,'NOT_FOUND','API route not found.')));
  app.use('/api',router);
  // The assignment's unprefixed routes are aliases; the browser uses /api.
  app.use('/documents', (req,res,next)=>{req.url='/documents'+(req.url==='/'?'':req.url);router(req,res,next);});
  const dist=path.resolve('apps/web/dist');
  try{await access(path.join(dist,'index.html'));app.use(express.static(dist));app.get('/{*path}',(req,res)=>res.sendFile(path.join(dist,'index.html')));}catch{}
  app.use((req,res,next)=>next(new ApiError(404,'NOT_FOUND','Route not found.')));
  app.use((error,req,res,next)=>{
    if(res.headersSent)return next(error);
    const status=error instanceof multer.MulterError? (error.code==='LIMIT_FILE_SIZE'?413:400) :error.status||500;
    if(status>=500)console.error(error);
    res.status(status).json({error:{code:error.code|| (status===400?'BAD_REQUEST':'INTERNAL_ERROR'),message:status>=500&&!error.code?'An internal error occurred.':error.message}});
  });
  app.locals.close=()=>dispatcher.close();
  return app;
}
