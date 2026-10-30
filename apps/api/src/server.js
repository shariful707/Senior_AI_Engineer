import {Database} from './db/index.js';
import {createApp} from './app.js';
import {config} from './config.js';
import {getAIStatus} from './ai/settings.js';
const db=await new Database().open();
const app=await createApp(db);
if(!(await getAIStatus(db)).enabled && config.extractionMode==='offline' && process.env.NODE_ENV!=='production' && process.env.SEED_SAMPLE_DOCUMENTS!=='false') {
  try{await app.locals.loadSamples({onlyIfEmpty:true});}catch(error){console.warn('Sample documents could not be loaded:',error.message);}
}
const server=app.listen(config.port,config.host,()=>console.log(`Document Intelligence API: http://${config.host}:${config.port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close(async()=>{await app.locals.close();await db.close();process.exit(0);});});
