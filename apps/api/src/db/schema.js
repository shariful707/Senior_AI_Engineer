export function schema(postgres) {
  const json = postgres ? 'JSONB' : 'TEXT';
  const time = postgres ? 'TIMESTAMPTZ' : 'TEXT';
  const bool = postgres ? 'BOOLEAN' : 'INTEGER';
  return `
CREATE TABLE IF NOT EXISTS documents (
 id TEXT PRIMARY KEY, original_filename TEXT NOT NULL, file_type TEXT NOT NULL,
 storage_path TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','processing','completed','failed','needs_review')),
 stage TEXT, batch_id TEXT NOT NULL, uploaded_by TEXT NOT NULL DEFAULT 'workspace',
 uploaded_at ${time} NOT NULL, updated_at ${time} NOT NULL, error_message TEXT, processing_ms INTEGER,
 extraction_mode TEXT, page_count INTEGER, revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS documents_status_uploaded_idx ON documents(status,uploaded_at);
CREATE INDEX IF NOT EXISTS documents_batch_idx ON documents(batch_id);
CREATE TABLE IF NOT EXISTS extracted_text (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 page_number INTEGER, raw_text TEXT NOT NULL, ocr_confidence REAL, method TEXT NOT NULL, sheet_name TEXT
);
CREATE INDEX IF NOT EXISTS extracted_text_document_idx ON extracted_text(document_id);
CREATE TABLE IF NOT EXISTS invoices (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
 invoice_number TEXT, invoice_date TEXT, supplier_name TEXT, customer_name TEXT,
 subtotal NUMERIC(18,4), tax NUMERIC(18,4), total NUMERIC(18,4), currency TEXT,
 extraction_confidence REAL NOT NULL, needs_review ${bool} NOT NULL,
 data ${json} NOT NULL, search_text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invoices_number_idx ON invoices(invoice_number);
CREATE INDEX IF NOT EXISTS invoices_supplier_date_idx ON invoices(supplier_name,invoice_date);
CREATE TABLE IF NOT EXISTS line_items (
 id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
 description TEXT NOT NULL, quantity NUMERIC(18,4), unit_price NUMERIC(18,4), line_total NUMERIC(18,4)
);
CREATE INDEX IF NOT EXISTS line_items_invoice_idx ON line_items(invoice_id);
CREATE TABLE IF NOT EXISTS ledger_rows (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 sheet_name TEXT, row_number INTEGER NOT NULL, invoice_number TEXT NOT NULL,
 supplier_name TEXT, invoice_date TEXT, total NUMERIC(18,4), currency TEXT
);
CREATE INDEX IF NOT EXISTS ledger_rows_number_idx ON ledger_rows(invoice_number);
CREATE INDEX IF NOT EXISTS ledger_rows_document_idx ON ledger_rows(document_id);
CREATE TABLE IF NOT EXISTS validation_errors (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 invoice_id TEXT REFERENCES invoices(id) ON DELETE CASCADE, rule_name TEXT NOT NULL,
 severity TEXT NOT NULL CHECK(severity IN ('error','warning')), message TEXT NOT NULL,
 field_name TEXT, related_document_id TEXT REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS validation_errors_document_idx ON validation_errors(document_id);
CREATE INDEX IF NOT EXISTS validation_errors_invoice_idx ON validation_errors(invoice_id);
CREATE INDEX IF NOT EXISTS validation_errors_related_idx ON validation_errors(related_document_id);
CREATE TABLE IF NOT EXISTS processing_history (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 event TEXT NOT NULL, timestamp ${time} NOT NULL, detail ${json} NOT NULL
);
CREATE INDEX IF NOT EXISTS processing_history_document_idx ON processing_history(document_id,timestamp);
CREATE TABLE IF NOT EXISTS extraction_audits (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 timestamp ${time} NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
 prompt TEXT NOT NULL, raw_response TEXT NOT NULL, success ${bool} NOT NULL
);
CREATE INDEX IF NOT EXISTS extraction_audits_document_idx ON extraction_audits(document_id);
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('pending','running','done','failed')),
 task TEXT NOT NULL DEFAULT 'process',
 attempts INTEGER NOT NULL DEFAULT 0, available_at ${time} NOT NULL,
 locked_until ${time}, lock_token TEXT, last_error TEXT
);
CREATE INDEX IF NOT EXISTS jobs_pending_idx ON jobs(status,available_at);
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at ${time} NOT NULL);
`;
}
export const postgresSearch = `
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED;
CREATE INDEX IF NOT EXISTS invoices_search_idx ON invoices USING gin(search_vector);
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS embedding vector(1536);
CREATE INDEX IF NOT EXISTS invoices_embedding_idx ON invoices USING hnsw (embedding vector_cosine_ops);
`;
