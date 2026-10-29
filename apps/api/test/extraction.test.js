import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {extract,embed} from '../src/extraction.js';
import {config} from '../src/config.js';
import {emptyInvoice} from '../../../packages/shared-types/invoice.js';
const saved={mode:config.extractionMode,key:config.apiKey,semantic:config.semantic};
const originalFetch=global.fetch;
afterEach(()=>{global.fetch=originalFetch;config.extractionMode=saved.mode;config.apiKey=saved.key;config.semantic=saved.semantic;});
test('AI extraction uses strict schema, retries malformed JSON and audits both attempts',async()=>{
  config.extractionMode='openai';config.apiKey='test-key';let calls=0;const audits=[];
  global.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);assert.equal(body.response_format.json_schema.strict,true);
    const content=++calls===1?'not-json':JSON.stringify({...emptyInvoice(),invoice_number:'INV-TEST'});
    return new Response(JSON.stringify({choices:[{message:{content}}]}));
  };
  const result=await extract('invoice text',async row=>audits.push(row));
  assert.equal(result.invoice_number,'INV-TEST');assert.equal(calls,2);assert.deepEqual(audits.map(a=>a.success),[false,true]);
});
test('missing schema keys fail after exactly one corrective retry',async()=>{
  config.extractionMode='openai';global.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:'{}'}}]}));const audits=[];
  await assert.rejects(extract('text',async row=>audits.push(row)),/after two attempts/);assert.equal(audits.length,2);
});
test('rate limits are retryable and refusal is terminal',async()=>{
  config.extractionMode='openai';global.fetch=async()=>new Response('{}',{status:429});
  await assert.rejects(extract('text',async()=>{}),e=>e.retryable===true);
  global.fetch=async()=>new Response(JSON.stringify({choices:[{message:{refusal:'Refused'}}]}));
  await assert.rejects(extract('text',async()=>{}),e=>e.retryable===false);
});
test('large-document merge never picks a conflicting field value',async()=>{
  config.extractionMode='openai';let n=0;
  global.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({...emptyInvoice(),invoice_number:`INV-${++n}`,total:100,extraction_confidence:.9})}}]}));
  const result=await extract('A'.repeat(20000),async()=>{});assert.equal(n,2);assert.equal(result.invoice_number,null);assert.equal(result.total,100);assert.equal(result.extraction_confidence,.5);
});
test('semantic embeddings enforce exact dimensions',async()=>{
  config.semantic=true;config.apiKey='test-key';global.fetch=async()=>new Response(JSON.stringify({data:[{embedding:[1,2]}]}));
  await assert.rejects(embed('text'),/Invalid embedding/);
  global.fetch=async()=>new Response(JSON.stringify({data:[{embedding:Array(1536).fill(.1)}]}));
  assert.equal((await embed('text')).length,1536);
});
