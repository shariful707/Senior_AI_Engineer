const close = (a,b) => Math.abs(Math.round(a*100)-Math.round(b*100)) <= 1;
export const same = (a,b) => String(a??'').trim().toLowerCase() === String(b??'').trim().toLowerCase();
export function validate(invoice, {today = new Date().toISOString().slice(0,10), ocrConfidence = null} = {}) {
  const errors=[];
  const add=(rule,field,message,severity='error')=>errors.push({rule,field,message,severity});
  for (const field of ['invoice_number','invoice_date','supplier_name','total','currency']) {
    if (invoice[field] === null || invoice[field] === '') add('required_field',field,`${field.replaceAll('_',' ')} is missing.`);
  }
  if (invoice.invoice_date) {
    const date=new Date(`${invoice.invoice_date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice.invoice_date) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0,10)!==invoice.invoice_date) add('invalid_date','invoice_date','Invoice date must be a valid YYYY-MM-DD date.');
    else if (invoice.invoice_date > today) add('future_date','invoice_date','Invoice date is in the future.','warning');
  }
  if (invoice.currency && !/^[A-Z]{3}$/.test(invoice.currency)) add('invalid_currency','currency','Currency must be a three-letter uppercase code.');
  for (const field of ['subtotal','tax','total']) {
    if (invoice[field] != null && invoice[field]<0) add('negative_amount',field,`${field} is negative.`);
    if (invoice[field] != null && invoice[field]>1e12) add('implausible_amount',field,`${field} exceeds the supported range.`);
  }
  if (invoice.subtotal != null && invoice.tax != null && invoice.total != null && !close(invoice.subtotal+invoice.tax,invoice.total)) add('total_mismatch','total','Subtotal plus tax does not equal total (tolerance 0.01).');
  const items=invoice.line_items||[];
  if (items.length && items.every(i=>i.line_total!=null) && invoice.subtotal!=null && !close(items.reduce((s,i)=>s+i.line_total,0),invoice.subtotal)) add('line_sum_mismatch','subtotal','Line items do not add up to subtotal.');
  items.forEach((i,n)=>{
    if (i.quantity!=null && i.unit_price!=null && i.line_total!=null && !close(i.quantity*i.unit_price,i.line_total)) add('line_total_mismatch',`line_items.${n}`,'Quantity times unit price does not equal line total.');
    if (['quantity','unit_price','line_total'].some(k=>i[k]!=null && i[k]<0)) add('negative_line_amount',`line_items.${n}`,'Line item contains a negative quantity or amount.');
  });
  if(invoice.tax!=null && invoice.subtotal!=null && invoice.tax>invoice.subtotal) add('implausible_tax','tax','Tax exceeds subtotal.','warning');
  if (invoice.extraction_confidence<0.75) add('low_confidence',null,'Extraction confidence is below 75%; verify against the source.','warning');
  if (ocrConfidence!=null && ocrConfidence<0.65) add('low_ocr_confidence',null,'OCR confidence is below 65%; source text needs review.','warning');
  return errors;
}
export function compareRecords(invoice, other, relatedId) {
  return ['supplier_name','invoice_date','total','currency'].filter(field => {
    if (invoice[field]==null || other[field]==null) return false;
    return field==='total' ? !close(Number(invoice[field]),Number(other[field])) : !same(invoice[field],other[field]);
  }).map(field=>({rule:'cross_document_mismatch',field,severity:'error',message:`${field.replaceAll('_',' ')} differs from document ${relatedId}: ${invoice[field]} versus ${other[field]}.`,related_document_id:relatedId}));
}
