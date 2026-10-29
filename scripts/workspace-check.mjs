import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {access,readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {startHarness,waitDocument} from './harness.mjs';

let executable=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
try{await access(chromium.executablePath());}catch{
  const root=process.platform==='win32'?path.join(process.env.LOCALAPPDATA,'ms-playwright'):path.join(process.env.HOME,'.cache/ms-playwright');
  const versions=(await readdir(root)).filter(name=>/^chromium-\d+$/.test(name)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1]));
  for(const version of versions){const candidate=path.join(root,version,process.platform==='win32'?'chrome-win64/chrome.exe':'chrome-linux/chrome');try{await access(candidate);executable=candidate;break;}catch{}}
}
const checks=[],errors=[];
function pass(message){checks.push(message);console.log('PASS:',message);}
const dataDir=path.resolve('data',`workspace-check-${Date.now()}`);
const harness=await startHarness({dataDir});
const browser=await chromium.launch({headless:true,...(executable?{executablePath:executable}:{})});
let protectedHarness;
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(harness.base);
  await page.getByRole('heading',{name:'Every document. Understood.'}).waitFor();
  await page.getByRole('button',{name:'Workspace settings',exact:true}).click();
  await page.getByRole('heading',{name:'Local workspace — no token required'}).waitFor();
  assert.equal(await page.getByLabel('Workspace access token',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Continue to workspace'}).click();
  await page.getByRole('button',{name:'Workspace settings',exact:true}).click();
  await page.getByRole('button',{name:'Close workspace settings'}).click();
  for(const name of ['Upload documents','browse files']){
    const chooser=page.waitForEvent('filechooser');
    await page.getByRole('button',{name,exact:true}).first().click();await(await chooser).setFiles([]);
  }
  pass('local workspace explains access and does not request an unnecessary token');

  await page.getByRole('button',{name:'Sample documents',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.document-table tbody tr').length===5);
  const samples=(await(await fetch(`${harness.base}/api/documents?sample=true`)).json()).documents;
  for(const sample of samples)await waitDocument(harness.base,sample.id);
  await page.getByRole('button',{name:'Refresh documents'}).click();
  await page.getByRole('button',{name:'Sample documents',exact:true}).click();
  assert.equal((await(await fetch(`${harness.base}/api/documents`)).json()).total,5);
  assert.ok((await page.locator('.document-table').innerText()).includes('Sample'));
  pass('sample action processes five real documents and is repeatable without duplicates');

  for(const name of ['total documents','verified','needs review','in progress']){
    await page.getByRole('button',{name:`Show ${name}`,exact:true}).click();
    if(name==='total documents')await page.getByRole('button',{name:'All documents',exact:true}).waitFor();
    else await page.locator('.filter-summary').waitFor();
  }
  await page.getByRole('button',{name:'Open Finance workspace'}).click();
  for(const name of ['Needs review','Verified','In progress','Queued','Failed','All documents']){
    await page.getByRole('button',{name,exact:true}).click();
    await page.waitForFunction(name=>document.querySelector('.tabs .selected')?.textContent===name,name);
  }
  await page.getByRole('textbox',{name:'Search documents'}).fill('no-such-invoice');
  await page.getByRole('heading',{name:'No matching documents'}).waitFor();
  await page.getByRole('button',{name:'Open Finance workspace'}).focus();await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('textbox',{name:'Search documents'}).inputValue(),'');
  await page.getByRole('textbox',{name:'Search documents'}).fill('Supplier 3');
  await page.getByRole('button',{name:'Clear search'}).click();
  assert.equal(await page.getByRole('textbox',{name:'Search documents'}).inputValue(),'');
  pass('all summary cards, status tabs, search clearing and keyboard workspace navigation work');

  const review=samples.find(item=>item.original_filename==='sample-review.pdf');
  await page.locator(`.row-open[aria-label="Open sample-review.pdf"]`).click();
  await page.getByRole('heading',{name:'Total mismatch',exact:true}).waitFor();
  await page.getByRole('button',{name:'Edit fields'}).click();
  await page.getByRole('button',{name:'+ Add item',exact:true}).click();
  await page.getByLabel('Description 2',{exact:true}).fill('Temporary line');
  await page.getByRole('button',{name:'Remove item 2'}).click();
  await page.getByLabel('Total',{exact:true}).fill('9');
  assert.equal(await page.getByRole('button',{name:'Reprocess',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal((await(await fetch(`${harness.base}/api/documents/${review.id}`)).json()).invoice.total,1400);
  await page.getByRole('button',{name:'Edit fields'}).click();await page.getByLabel('Total',{exact:true}).fill('1344');
  await page.getByRole('button',{name:'Save changes'}).click();await page.getByText('All checks passed',{exact:true}).waitFor();
  await page.waitForTimeout(2800);
  await page.getByText('Changes saved. Validation and related documents have been checked again.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Dismiss message'}).click();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Source file',exact:true}).click();assert.equal((await download).suggestedFilename(),'sample-review.pdf');
  pass('add/remove/cancel/save line editing, validation, persistent feedback and source download work');

  await page.getByRole('button',{name:'Back to documents'}).click();
  await page.getByRole('button',{name:'Open sample-delivery.pdf',exact:true}).click();
  await page.getByRole('link',{name:'Compare related document'}).first().click();
  await page.getByRole('heading',{name:'Ledger records'}).waitFor();
  const revised=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Upload a revised ledger'}).click();await(await revised).setFiles([]);
  const sheetNames=await page.getByRole('combobox',{name:'Source page or sheet'}).locator('option').allTextContents();
  await page.getByRole('combobox',{name:'Source page or sheet'}).selectOption('1');
  await page.waitForFunction(name=>document.querySelector('.source-pages h3')?.textContent.includes(name),sheetNames[1]);
  await page.getByRole('button',{name:'Previous source page'}).click();
  await page.getByRole('button',{name:'Next source page'}).click();
  await page.getByRole('button',{name:'Reprocess',exact:true}).click();
  const ledger=samples.find(item=>item.original_filename==='sample-ledger.xlsx');await waitDocument(harness.base,ledger.id);
  pass('related-record links, source sheet navigation and real reprocessing work');

  await page.evaluate(()=>{location.hash='00000000-0000-0000-0000-000000000000';});
  await page.getByRole('heading',{name:'Document unavailable'}).waitFor();
  await page.getByRole('button',{name:'Back to documents',exact:true}).click();
  await page.locator('input[type=file]').setInputFiles({name:'unsupported.exe',mimeType:'application/octet-stream',buffer:Buffer.from('not a document')});
  await page.getByText('Choose PDF, JPG, PNG, TIFF, XLSX, XLS or CSV files.',{exact:true}).waitFor();
  await page.waitForTimeout(2800);
  await page.getByText('Choose PDF, JPG, PNG, TIFF, XLSX, XLS or CSV files.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Dismiss message'}).click();
  await page.route('**/api/documents?*',route=>route.abort());
  await page.getByRole('button',{name:'Refresh documents'}).click();await page.getByRole('heading',{name:'Documents could not load'}).waitFor();
  await page.unroute('**/api/documents?*');await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.getByRole('button',{name:'Open sample-invoice.pdf',exact:true}).waitFor();
  pass('missing links and upload/network failures show recoverable states rather than blank pages');

  const bytes=await readFile('eval/fixtures/digital-5.pdf');
  const bulk=Array.from({length:21},(_,n)=>({name:`pagination-${n}.pdf`,mimeType:'application/pdf',buffer:bytes}));
  await page.locator('input[type=file]').setInputFiles(bulk);
  await page.getByText('Choose up to 20 files in one upload.',{exact:true}).waitFor();
  await page.locator('input[type=file]').setInputFiles(bulk.slice(0,20));
  await page.waitForFunction(()=>document.querySelector('.alert.success')?.textContent.includes('20 documents uploaded'));
  await page.locator('input[type=file]').setInputFiles(bulk.slice(20));
  await page.waitForFunction(()=>document.querySelector('.alert.success')?.textContent.includes('1 document uploaded'));
  await page.getByRole('button',{name:'Next page'}).waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('[aria-label="Next page"]').disabled);
  await page.getByRole('button',{name:'Next page'}).click();await page.getByText('Page 2 of 2',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Previous page'}).click();await page.getByText('Page 1 of 2',{exact:true}).waitFor();
  pass('bulk-upload guard and real next/previous document pagination work');

  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Workspace settings',exact:true}).click();
  await page.getByRole('dialog').waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Documents',exact:true}).first().click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  pass('mobile settings, close/escape and navigation remain accessible');

  protectedHarness=await startHarness({dataDir:path.join(dataDir,'protected'),apiToken:'workspace-test-secret'});
  const locked=await browser.newPage({viewport:{width:1440,height:1000}});locked.on('pageerror',error=>errors.push(error.message));
  await locked.goto(protectedHarness.base);await locked.getByRole('dialog').waitFor();
  await locked.getByLabel('Workspace access token',{exact:true}).fill('wrong-key');await locked.getByRole('button',{name:'Connect',exact:true}).click();
  await locked.getByText('That access key is not correct. Check it and try again.',{exact:true}).waitFor();
  await locked.getByLabel('Workspace access token',{exact:true}).fill('workspace-test-secret');await locked.getByRole('button',{name:'Connect',exact:true}).click();
  await locked.getByText('Workspace access verified.',{exact:true}).waitFor();
  await locked.getByRole('button',{name:'Sample documents',exact:true}).click();
  await locked.waitForFunction(()=>document.querySelectorAll('.document-table tbody tr').length===5);
  await locked.getByRole('button',{name:'Workspace settings',exact:true}).click();await locked.getByRole('button',{name:'Disconnect',exact:true}).click();
  assert.equal(await locked.evaluate(()=>sessionStorage.getItem('folio-token')),null);
  await locked.getByRole('button',{name:'Close workspace settings'}).click();await locked.waitForTimeout(2800);
  assert.equal(await locked.getByRole('dialog').count(),0,'Disconnected access prompt should stay closed when dismissed.');
  await locked.getByRole('button',{name:'Enter access key',exact:true}).click();await locked.getByRole('dialog').waitFor();
  pass('protected workspace rejects invalid keys, verifies valid keys, authorizes samples and disconnects');
  assert.deepEqual(errors,[],'Unhandled browser runtime errors');
  await mkdir('docs',{recursive:true});await writeFile('docs/workspace-results.json',JSON.stringify({timestamp:new Date().toISOString(),checks,errors},null,2));
  console.log(`Workspace interaction checks passed: ${checks.length}`);
}finally{await browser.close();await protectedHarness?.stop();await harness.stop();}
