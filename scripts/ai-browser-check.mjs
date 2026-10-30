import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {access,readdir,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {startHarness,waitDocument} from './harness.mjs';
import {offlineExtract} from '../apps/api/src/extraction.js';

// This deterministic local provider exercises real HTTP, queues and UI behavior.
// It tests orchestration, not model accuracy. See llm-verification.json for real Ollama results.
let failNext=false;
const provider=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/tags'){res.end(JSON.stringify({models:[{name:'browser-test',size:1}]}));return;}
  let text='';for await(const chunk of req)text+=chunk;
  const body=JSON.parse(text);
  if(failNext){failNext=false;res.statusCode=503;res.end('{}');return;}
  let output;
  if(body.format.properties.ready)output={ready:true};
  else if(body.format.properties.invoice_number)output=offlineExtract(body.messages.find(message=>message.role==='user').content);
  else{
    const context=JSON.parse(body.messages.find(message=>message.role==='user').content),source=context.sources[0],invoice=context.current_invoice;
    output={answer:context.task==='question'?'The source contains the invoice total.':'Check the subtotal and tax against the printed total.',highlights:['Verify the source before saving corrections.'],citations:[{source_id:source.source_id,quote:source.text.slice(0,550)}],insufficient_evidence:false,suggestions:context.task==='review'?[{field:'total',value:invoice.subtotal+invoice.tax,reason:'Subtotal plus tax differs from the current total.',source_id:source.source_id,quote:source.text.slice(0,550),origin:'calculated'}]:[]};
  }
  res.end(JSON.stringify({message:{content:JSON.stringify(output)},prompt_eval_count:50,eval_count:50}));
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const providerURL=`http://127.0.0.1:${provider.address().port}`;
let executable=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
try{await access(chromium.executablePath());}catch{
  const root=process.platform==='win32'?path.join(process.env.LOCALAPPDATA,'ms-playwright'):path.join(process.env.HOME,'.cache/ms-playwright');
  for(const version of (await readdir(root)).filter(name=>/^chromium-\d+$/.test(name)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1]))){const candidate=path.join(root,version,process.platform==='win32'?'chrome-win64/chrome.exe':'chrome-linux/chrome');try{await access(candidate);executable=candidate;break;}catch{}}
}
const dataDir=path.resolve('data',`ai-browser-${Date.now()}`),checks=[],errors=[];
let harness,browser;
function pass(message){checks.push(message);console.log('PASS:',message);}
try{
  harness=await startHarness({dataDir});browser=await chromium.launch({headless:true,...(executable?{executablePath:executable}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.on('pageerror',error=>errors.push(error.message));
  await page.goto(harness.base);await page.getByRole('button',{name:'AI settings',exact:true}).click();
  await page.getByRole('heading',{name:'Why no token for local AI?'}).waitFor();
  assert.equal(await page.getByLabel('AI provider API key',{exact:true}).count(),0);
  await page.getByLabel('AI provider',{exact:true}).selectOption('compatible');await page.getByLabel('AI provider API key',{exact:true}).waitFor();
  assert.ok((await page.locator('.ai-key-note').first().innerText()).includes('workspace access token'));
  await page.getByLabel('AI provider',{exact:true}).selectOption('ollama');await page.getByLabel('Ollama address').fill(providerURL);
  await page.getByRole('button',{name:'Detect installed models'}).click();await page.getByText('1 installed models found.',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('AI model',{exact:true}).inputValue(),'browser-test');
  await page.getByRole('button',{name:'Test and enable AI'}).click();await page.getByText('browser-test passed a real structured-output test and is now enabled.',{exact:true}).waitFor({timeout:30000});
  await page.getByRole('button',{name:'Close workspace settings'}).click();pass('model detection and asynchronous connection activation work; workspace and provider keys are explained separately');
  await page.getByRole('button',{name:'Sample documents',exact:true}).click();const list=await(await fetch(`${harness.base}/api/documents?sample=true`)).json();
  for(const document of list.documents)await waitDocument(harness.base,document.id);
  const sample=list.documents.find(document=>document.original_filename==='sample-review.pdf');
  await page.goto(`${harness.base}/#${sample.id}`);await page.getByRole('button',{name:'Summarize document'}).click();await page.locator('.ai-result').waitFor({timeout:30000});
  await page.locator('.ai-citation').first().click();await page.waitForFunction(()=>document.querySelector('.source-panel').getBoundingClientRect().top<600);pass('summary generates a queued result with working source references');
  await page.getByRole('button',{name:'Explain review flags'}).click();await page.getByRole('button',{name:'Review proposed total'}).waitFor({timeout:30000});
  const before=await(await fetch(`${harness.base}/api/documents/${sample.id}`)).json();
  await page.getByRole('button',{name:'Review proposed total'}).click();assert.equal(await page.getByRole('button',{name:'Save changes'}).count(),1);
  assert.equal((await(await fetch(`${harness.base}/api/documents/${sample.id}`)).json()).invoice.total,before.invoice.total);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button',{name:'Review proposed total'}).click();await page.getByRole('button',{name:'Save changes'}).click();
  await page.getByText('Changes saved. Validation and related documents have been checked again.',{exact:true}).waitFor();
  await page.getByText('This response was generated before the latest correction.',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'Review proposed total'}).isDisabled(),true);
  pass('source-backed proposal opens an editable draft, requires explicit Save, revalidates and marks previous AI responses stale');
  await page.getByLabel('Ask about this document').fill('What is the total?');await page.getByRole('button',{name:'Ask AI',exact:true}).click();await page.getByText('The source contains the invoice total.',{exact:true}).waitFor({timeout:30000});
  assert.equal((await page.getByLabel('Ask about this document').inputValue()),'');assert.ok((await page.locator('.assistant-history option').count())>=3);pass('document questions and response history work');
  failNext=true;await page.getByRole('button',{name:'Summarize document'}).click();await page.getByRole('button',{name:'Retry AI request'}).waitFor({timeout:30000});await page.getByRole('button',{name:'Retry AI request'}).click();await page.locator('.ai-result').waitFor({timeout:30000});
  pass('provider failure is visible and Retry queues a successful replacement');
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'AI settings',exact:true}).first().click();await page.getByRole('button',{name:'Use offline extraction'}).click();
  await page.getByText('Offline extraction is active.',{exact:false}).waitFor();await page.getByRole('button',{name:'Close workspace settings'}).click();await page.getByText('No AI answers are being generated yet.',{exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);pass('mobile AI settings and offline switch work without overflow or page runtime errors');
  await mkdir('docs',{recursive:true});await writeFile('docs/ai-browser-results.json',JSON.stringify({verified_at:new Date().toISOString(),provider:'deterministic local HTTP test double; not a model-accuracy result',checks,page_errors:errors},null,2));
}finally{await browser?.close();await harness?.stop();await new Promise(resolve=>provider.close(resolve));}
