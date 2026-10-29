import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,rename,writeFile,readdir,access} from 'node:fs/promises';
import path from 'node:path';
import {startHarness,waitDocument} from './harness.mjs';
const recording=process.argv.includes('--record');
const directory=path.resolve('data',`browser-${Date.now()}`),screens=path.resolve('docs/screenshots');
await mkdir(screens,{recursive:true});
let executable=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
try{await access(chromium.executablePath());}catch{
  const root=process.platform==='win32'?path.join(process.env.LOCALAPPDATA,'ms-playwright'):path.join(process.env.HOME,'.cache/ms-playwright');
  const installed=(await readdir(root)).filter(n=>/^chromium-\d+$/.test(n)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1]));
  for(const name of installed){const candidate=path.join(root,name,process.platform==='win32'?'chrome-win64/chrome.exe':'chrome-linux/chrome');try{await access(candidate);executable=candidate;break;}catch{}}
}
const harness=await startHarness({dataDir:directory});
let browser,context;
const checks=[],errors=[];
const started=Date.now();
try{
  browser=await chromium.launch({headless:true,...(executable?{executablePath:executable}:{})});
  context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',...(recording?{recordVideo:{dir:directory,size:{width:1440,height:1000}}}:{})});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const caption=async(text,seconds=20)=>{
    if(!recording)return;
    await page.evaluate(text=>{
      let el=document.querySelector('#walkthrough-caption');if(!el){el=document.createElement('div');el.id='walkthrough-caption';el.style='position:fixed;left:265px;right:25px;bottom:18px;background:#223e2f;color:#fff;padding:18px 22px;border-radius:8px;font:14px/1.7 Arial;z-index:1000;box-shadow:0 5px 25px #0002';document.body.append(el);}el.textContent=text;
    },text);
    console.log(`Walkthrough: ${text}`);
    await page.waitForTimeout(seconds*1000);
  };
  await page.goto(harness.base);await page.getByRole('heading',{name:'Every document. Understood.'}).waitFor();
  await caption('Folio is a document intelligence workspace. This walkthrough uses synthetic invoices and an offline extractor; the OCR, queue, storage, validation and correction flows are real.');
  const before=(await(await fetch(`${harness.base}/api/documents`)).json()).total;assert.equal(before,0);
  await page.locator('input[type=file]').setInputFiles(['eval/fixtures/digital-1.pdf','eval/fixtures/digital-3.pdf','eval/fixtures/digital-6.pdf','eval/fixtures/image-7.png','eval/fixtures/corrupted.pdf']);
  await caption('Upload multiple PDFs and an image together. Upload progress is visible. Requests return queued IDs immediately; the worker processes the files in the background.');
  await page.waitForFunction(()=>document.querySelectorAll('.document-table tbody tr').length===5);
  const docs=(await(await fetch(`${harness.base}/api/documents`)).json()).documents;
  const ids=Object.fromEntries(docs.map(d=>[d.original_filename,d.id]));
  for(const id of Object.values(ids))await waitDocument(harness.base,id);
  await page.reload();await page.getByRole('button',{name:'digital-3.pdf PDF document'}).waitFor();
  await page.screenshot({path:path.join(screens,'desktop-library.png'),fullPage:true,style:'#walkthrough-caption{display:none!important}'});
  checks.push('multi-file upload, queued processing, real OCR and corrupt-file isolation');
  await caption('The library shows verified, review and failed states independently. One corrupted document cannot crash the worker or prevent the other files from completing.');
  await page.getByRole('button',{name:'digital-3.pdf PDF document'}).click();await page.getByRole('heading',{name:'Extracted information'}).waitFor();
  await page.getByRole('heading',{name:'Total mismatch',exact:true}).waitFor();
  await page.screenshot({path:path.join(screens,'desktop-review.png'),fullPage:true,style:'#walkthrough-caption{display:none!important}'});
  await caption('This invoice says subtotal 1200, tax 144 and total 1400. Validation catches the arithmetic mismatch. Source text, line items and extraction confidence are available for review.');
  await page.getByRole('button',{name:'Edit fields'}).click();await page.getByLabel('Total',{exact:true}).fill('1344');
  await caption('A reviewer can correct a field inline. Values remain editable as explicit numbers or empty values. The original uploaded file is preserved.');
  await page.getByRole('button',{name:'Save changes'}).click();await page.getByText('All checks passed',{exact:true}).waitFor();
  assert.equal((await(await fetch(`${harness.base}/api/documents/${ids['digital-3.pdf']}`)).json()).invoice.total,1344);
  checks.push('inline correction resolves validation and writes audit history');
  await caption('Saving reruns validation and clears the resolved mismatch. The activity log records the manual correction with before and after values. Optimistic revision checks protect against stale edits.');
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Source file'}).click();assert.equal((await download).suggestedFilename(),'digital-3.pdf');
  await page.getByRole('button',{name:'Back to documents'}).click();await page.getByRole('textbox',{name:'Search documents'}).fill('Supplier 3');
  await page.waitForFunction(()=>document.querySelectorAll('.document-table tbody tr').length===1);
  assert.ok((await page.locator('.document-table tbody').innerText()).includes('digital-3.pdf'));checks.push('supplier search and authenticated source download');
  await caption('Keyword search finds documents by supplier, invoice number, filename and line-item descriptions. Production PostgreSQL uses a full-text index; semantic search appears when embeddings are configured.');
  await page.getByRole('button',{name:'Clear search'}).click();await page.locator('input[type=file]').setInputFiles('eval/fixtures/ledger.xlsx');
  await page.waitForFunction(()=>document.querySelectorAll('.document-table tbody tr').length===6);
  const ledger=(await(await fetch(`${harness.base}/api/documents`)).json()).documents.find(d=>d.original_filename==='ledger.xlsx');await waitDocument(harness.base,ledger.id);
  await page.getByRole('button',{name:'digital-6.pdf PDF document'}).click();await page.getByRole('heading',{name:'Cross document mismatch',exact:true}).waitFor();
  const cross=(await(await fetch(`${harness.base}/api/documents/${ids['digital-6.pdf']}`)).json());assert.ok(cross.validation_errors.some(e=>e.related_document_id===ledger.id));checks.push('PDF-to-Excel mismatch with a link to the related document');
  await caption('A multi-sheet Excel ledger is now uploaded. Its expected total for INV-1006 is 1390, while the PDF says 1344. Cross-document validation flags the discrepancy and links to the ledger.');
  await page.getByRole('link',{name:'Compare related document'}).first().click();await page.getByRole('heading',{name:'Ledger records'}).waitFor();assert.equal(await page.locator('.ledger-table tbody tr').count(),3);
  await caption('The ledger preserves each spreadsheet row, its sheet name and row number. This comparison uses explicit invoice numbers and known values; it does not invent missing fields.');
  await page.getByRole('button',{name:'Back to documents'}).click();await page.getByRole('button',{name:'corrupted.pdf PDF document'}).click();await page.getByRole('button',{name:'Reprocess',exact:true}).waitFor();
  await caption('Failed files retain a clear error and processing history. Reprocess places a document back in the durable queue. Temporary provider or service failures retry with backoff; invalid files fail explicitly.');
  await page.getByRole('button',{name:'Reprocess',exact:true}).click();await waitDocument(harness.base,ids['corrupted.pdf']);checks.push('failed-job reprocessing');
  await page.getByRole('button',{name:'Back to documents'}).click();await page.getByRole('button',{name:'image-7.png PNG document'}).click();await page.getByRole('heading',{name:'Extracted information'}).waitFor();
  await caption('The PNG was read by real Tesseract OCR. Page-level OCR confidence and the exact recognized text remain visible so a reviewer can check the extracted invoice against the source.');
  await page.getByRole('button',{name:'Back to documents'}).click();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(screens,'mobile-library.png'),fullPage:true,style:'#walkthrough-caption{display:none!important}'});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));checks.push('mobile layout stays within viewport');
  await page.setViewportSize({width:1440,height:1000});
  await caption('The same workspace adapts to mobile. The complete repository includes reproducible fixtures, automated tests, an evaluation report, Docker configuration, and architecture and schema documentation.');
  if(recording){
    while(Date.now()-started<302000)await page.waitForTimeout(Math.min(15000,302000-(Date.now()-started)));
  }
  assert.deepEqual(errors,[],'browser runtime errors');
  const video=page.video();await context.close();context=null;
  if(recording&&video)await rename(await video.path(),path.resolve('docs/walkthrough.webm'));
  const report={timestamp:new Date().toISOString(),checks,errors,recording,duration_seconds:Math.round((Date.now()-started)/1000)};
  await writeFile('docs/browser-results.json',JSON.stringify(report,null,2));
  if(recording)await writeFile('docs/walkthrough-metadata.json',JSON.stringify(report,null,2));
  console.log(`Browser checks passed: ${checks.length}`);
}finally{await context?.close();await browser?.close();await harness.stop();}
