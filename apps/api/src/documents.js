import {randomUUID} from 'node:crypto';
import {decode} from './db/index.js';
import {validate, same, compareRecords} from './validation.js';

export const now = () => new Date().toISOString();
export async function history(db,id,event,detail={}) {
  await db.query('INSERT INTO processing_history(id,document_id,event,timestamp,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,event,now(),JSON.stringify(detail)]);
}
export async function saveInvoice(db,id,invoice) {
  const old=(await db.query('SELECT id FROM invoices WHERE document_id=$1',[id])).rows[0];
  const invoiceId=old?.id || randomUUID();
  const search=[invoice.invoice_number,invoice.supplier_name,invoice.customer_name,invoice.currency,...invoice.line_items.map(i=>i.description)].filter(Boolean).join(' ');
  const columns=['invoice_number','invoice_date','supplier_name','customer_name','subtotal','tax','total','currency','extraction_confidence'];
  await db.query(`INSERT INTO invoices(id,document_id,${columns.join(',')},needs_review,data,search_text)
    VALUES(${Array.from({length:14},(_,i)=>`$${i+1}`).join(',')})
    ON CONFLICT(document_id) DO UPDATE SET ${columns.map(k=>`${k}=excluded.${k}`).join(',')},data=excluded.data,search_text=excluded.search_text`,
  [invoiceId,id,...columns.map(k=>invoice[k]),false,JSON.stringify(invoice),search]);
  if(db.postgres) await db.query('UPDATE invoices SET embedding=NULL WHERE document_id=$1',[id]);
  await db.query('DELETE FROM line_items WHERE invoice_id=$1',[invoiceId]);
  for(const item of invoice.line_items) await db.query('INSERT INTO line_items(id,invoice_id,description,quantity,unit_price,line_total) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),invoiceId,item.description,item.quantity,item.unit_price,item.line_total]);
  return invoiceId;
}

export async function reconcile(db, documentIds, {skipIds=[]}={}) {
  // Caller holds the global reconciliation transaction lock. Reconcile affected peers
  // in both directions so upload order and corrections cannot leave stale flags.
  const invoices=(await db.query('SELECT i.*,d.status FROM invoices i JOIN documents d ON d.id=i.document_id')).rows;
  const ledgers=(await db.query("SELECT l.* FROM ledger_rows l JOIN documents d ON d.id=l.document_id WHERE d.status IN ('completed','needs_review')")).rows;
  const affected=new Set(documentIds);
  for(const row of invoices) {
    const current=decode(row.data);
    if(invoices.some(peer=>affected.has(peer.document_id) && (same(peer.invoice_number,current.invoice_number) || (same(peer.supplier_name,current.supplier_name) && same(peer.invoice_date,current.invoice_date) && Number(peer.total)===current.total)))) affected.add(row.document_id);
    if(ledgers.some(peer=>affected.has(peer.document_id) && same(peer.invoice_number,current.invoice_number))) affected.add(row.document_id);
  }
  // Also clear flags which used to reference a document before its identity changed.
  for(const id of documentIds) for(const row of (await db.query('SELECT DISTINCT document_id FROM validation_errors WHERE related_document_id=$1',[id])).rows) affected.add(row.document_id);
  for(const row of invoices.filter(i=>affected.has(i.document_id))) {
    if(skipIds.includes(row.document_id))continue;
    if(['queued','processing','failed'].includes(row.status) && !documentIds.includes(row.document_id)) continue;
    const invoice=decode(row.data);
    const ocr=(await db.query('SELECT MIN(ocr_confidence) AS confidence FROM extracted_text WHERE document_id=$1',[row.document_id])).rows[0];
    const errors=validate(invoice,{ocrConfidence:ocr?.confidence});
    for(const peer of invoices) {
      if(skipIds.includes(peer.document_id))continue;
      if(peer.document_id===row.document_id || ['queued','processing','failed'].includes(peer.status) && !documentIds.includes(peer.document_id)) continue;
      const sameNumber=invoice.invoice_number && peer.invoice_number && same(invoice.invoice_number,peer.invoice_number);
      const sameIdentity=invoice.supplier_name && invoice.invoice_date && invoice.total!=null && same(invoice.supplier_name,peer.supplier_name) && same(invoice.invoice_date,peer.invoice_date) && invoice.total===Number(peer.total);
      if(!sameNumber && !sameIdentity) continue;
      if(sameNumber && same(invoice.supplier_name,peer.supplier_name)) errors.push({rule:'duplicate_invoice',field:'invoice_number',severity:'warning',message:`Duplicate invoice number and supplier in document ${peer.document_id}.`,related_document_id:peer.document_id});
      errors.push(...compareRecords(invoice,decode(peer.data),peer.document_id));
    }
    for(const peer of ledgers.filter(l=>l.document_id!==row.document_id && invoice.invoice_number && same(l.invoice_number,invoice.invoice_number))) errors.push(...compareRecords(invoice,peer,peer.document_id));
    await db.query('DELETE FROM validation_errors WHERE document_id=$1',[row.document_id]);
    for(const e of errors) await db.query('INSERT INTO validation_errors(id,document_id,invoice_id,rule_name,severity,message,field_name,related_document_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),row.document_id,row.id,e.rule,e.severity,e.message,e.field,e.related_document_id||null]);
    await db.query('UPDATE invoices SET needs_review=$1 WHERE document_id=$2',[Boolean(errors.length),row.document_id]);
    await db.query("UPDATE documents SET status=$1,stage='done',updated_at=$2 WHERE id=$3",[errors.length?'needs_review':'completed',now(),row.document_id]);
    await history(db,row.document_id,errors.length?'validation_failed':'validation_passed',{count:errors.length});
  }
  // A mismatch is visible from both the invoice and ledger review screens.
  const ledgerDocuments=[...new Set(ledgers.map(l=>l.document_id))];
  for(const ledgerId of ledgerDocuments) {
    const rows=ledgers.filter(l=>l.document_id===ledgerId),errors=[];
    for(const row of rows) {
      if(row.total==null)errors.push({rule:'invalid_ledger_total',field:'total',severity:'error',message:`Invalid total on ${row.sheet_name} row ${row.row_number}.`});
      for(const peer of invoices.filter(i=>!skipIds.includes(i.document_id)&&(!['queued','processing','failed'].includes(i.status)||documentIds.includes(i.document_id)) && same(i.invoice_number,row.invoice_number))) errors.push(...compareRecords(row,decode(peer.data),peer.document_id));
    }
    await db.query('DELETE FROM validation_errors WHERE document_id=$1',[ledgerId]);
    for(const e of errors)await db.query('INSERT INTO validation_errors(id,document_id,rule_name,severity,message,field_name,related_document_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),ledgerId,e.rule,e.severity,e.message,e.field,e.related_document_id||null]);
    await db.query("UPDATE documents SET status=$1,updated_at=$2 WHERE id=$3",[errors.length?'needs_review':'completed',now(),ledgerId]);
  }
}
export async function lockReconciliation(db) {if(db.postgres) await db.query('SELECT pg_advisory_xact_lock(691213)');}
export async function documentDetail(db,id) {
  const row=(await db.query('SELECT * FROM documents WHERE id=$1',[id])).rows[0];
  if(!row) return null;
  const invoice=(await db.query('SELECT data,needs_review FROM invoices WHERE document_id=$1',[id])).rows[0];
  const errors=(await db.query('SELECT id,rule_name AS rule,severity,message,field_name,related_document_id FROM validation_errors WHERE document_id=$1',[id])).rows;
  const events=(await db.query('SELECT event,timestamp,detail FROM processing_history WHERE document_id=$1 ORDER BY timestamp,id',[id])).rows.map(e=>({...e,detail:decode(e.detail)}));
  const pages=(await db.query('SELECT page_number,raw_text,ocr_confidence,method,sheet_name FROM extracted_text WHERE document_id=$1 ORDER BY page_number,sheet_name',[id])).rows;
  const ledgerRows=(await db.query('SELECT sheet_name,row_number,invoice_number,supplier_name,invoice_date,total,currency FROM ledger_rows WHERE document_id=$1 ORDER BY sheet_name,row_number',[id])).rows;
  const {storage_path,...safe}=row;
  return {...safe,invoice:invoice?decode(invoice.data):null,needs_review:Boolean(invoice?.needs_review || row.status==='needs_review'),validation_errors:errors,processing_history:events,pages,ledger_rows:ledgerRows};
}
