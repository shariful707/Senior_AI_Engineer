import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validate,compareRecords} from '../src/validation.js';
import {offlineExtract,extract} from '../src/extraction.js';
import {validateInvoice} from '../../../packages/shared-types/invoice.js';
const good={invoice_number:'INV-1',invoice_date:'2026-09-14',supplier_name:'Acme',customer_name:'Client',subtotal:100,tax:10,total:110,currency:'USD',line_items:[{description:'Item',quantity:2,unit_price:50,line_total:100}],extraction_confidence:.95};
test('clean invoice passes all validation',()=>assert.deepEqual(validate(good,{today:'2026-10-28'}),[]));
test('required values and arithmetic inconsistencies are flagged',()=>{
  const errors=validate({...good,invoice_number:null,total:130,subtotal:90},{today:'2026-10-28'});
  for(const rule of ['required_field','total_mismatch','line_sum_mismatch'])assert.ok(errors.some(e=>e.rule===rule),rule);
});
test('date validity, confidence, tax sanity and negatives',()=>{
  const errors=validate({...good,invoice_date:'2026-02-30',subtotal:-2,tax:10,total:-1,extraction_confidence:.2},{ocrConfidence:.3});
  for(const rule of ['invalid_date','negative_amount','implausible_tax','low_confidence','low_ocr_confidence'])assert.ok(errors.some(e=>e.rule===rule),rule);
  assert.ok(validate({...good,invoice_date:'2099-01-01'}).some(e=>e.rule==='future_date'));
});
test('rounding tolerance permits one cent and rejects larger errors',()=>{
  assert.ok(!validate({...good,total:110.01}).some(e=>e.rule==='total_mismatch'));
  assert.ok(validate({...good,total:110.02}).some(e=>e.rule==='total_mismatch'));
});
test('line multiplication and negative quantity are checked',()=>{
  const result=validate({...good,line_items:[{description:'bad',quantity:-1,unit_price:50,line_total:100}]});
  assert.ok(result.some(e=>e.rule==='line_total_mismatch'));assert.ok(result.some(e=>e.rule==='negative_line_amount'));
});
test('cross verification only compares known fields and uses amount tolerance',()=>{
  assert.deepEqual(compareRecords(good,{supplier_name:'ACME',total:110.01},'peer'),[]);
  const differences=compareRecords(good,{supplier_name:'Different',total:120,invoice_date:null},'peer');
  assert.deepEqual(differences.map(e=>e.field),['supplier_name','total']);
  assert.ok(differences.every(e=>e.related_document_id==='peer'));
});
test('offline extraction never calculates absent amounts',()=>{
  const invoice=offlineExtract('Invoice number: INV-7\nSupplier: Acme\nSubtotal: 100\nTax: 10\nCurrency: USD\nItem | 2 | 50 | 100');
  assert.equal(invoice.total,null);assert.equal(invoice.subtotal,100);assert.equal(invoice.line_items.length,1);assert.ok(validateInvoice(invoice));
});
test('offline extraction stores an audit entry',async()=>{
  const audits=[];const invoice=await extract('Invoice number: ABC\nTotal: 20',async a=>audits.push(a));
  assert.equal(invoice.invoice_number,'ABC');assert.equal(audits.length,1);assert.equal(audits[0].provider,'offline');
});
