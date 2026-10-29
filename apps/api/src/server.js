import {Database} from './db/index.js';
import {createApp} from './app.js';
import {config} from './config.js';
const db=await new Database().open();
const app=await createApp(db);
const server=app.listen(config.port,config.host,()=>console.log(`Document Intelligence API: http://${config.host}:${config.port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close(async()=>{await app.locals.close();await db.close();process.exit(0);});});
