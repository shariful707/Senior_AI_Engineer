import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
// Tests never use production credentials or the user's workspace database.
const result=spawnSync(process.execPath,['--test','--test-concurrency=1','apps/api/test/*.test.js'],{
  encoding:'utf8',maxBuffer:10*1024*1024,
  env:{...process.env,EXTRACTION_MODE:'offline',OPENAI_API_KEY:'',DATABASE_URL:'',REDIS_URL:'',API_TOKEN:'',INTERNAL_TOKEN:'',SEMANTIC_SEARCH:'false',NODE_ENV:'test'}
});
const output=(result.stdout||'')+(result.stderr||'');
process.stdout.write(output);mkdirSync('docs',{recursive:true});writeFileSync('docs/node-test-results.txt',output,'utf8');
if(result.error)throw result.error;
process.exitCode=result.status??1;
