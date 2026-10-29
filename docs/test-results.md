# Verification results

Last measured locally: October 28, 2026, Windows / Node 24.19.0 / Python 3.13 / Tesseract English.

| Check | Result |
|---|---|
| Node unit/integration suite | 25 passed, 0 failed; 2 external-service tests skipped |
| Python parser/OCR suite | 14 passed |
| React production build | Passed |
| Browser workflow | Six grouped checks passed; no page runtime errors |
| Labeled evaluation | 19 files: all 17 valid inputs processed, 2 intentional negatives rejected |
| Local launcher | UI, API, parser and worker started; proxied endpoints returned HTTP 200 |

Node tests cover API access/errors, uploads/signature cleanup, fresh SQLite concurrency, durable claims, corrections/revision conflicts, search/downloads, reprocessing, cross-document flag clearing, extraction schema/retry/refusal, embedding dimensions, worker retries and lease fencing. Raw output: [node-test-results.txt](node-test-results.txt).

Python checks use real digital/scanned PDFs, real JPG/PNG/TIFF OCR, multi-frame TIFF, XLS/XLSX/CSV, corrupted/blank input, spoofing, invalid workbook ZIP and a 1,000-page digital PDF. The browser verifies uploads, correction/validation, supplier search/download, ledger mismatch navigation, reprocessing and mobile width.

The PostgreSQL/pgvector and Redis/BullMQ tests require dedicated service URLs; CI provisions them. Their local skips are not passes. Docker images, live provider extraction and semantic retrieval quality were not verified locally. A dependency deprecation warning in the Python TestClient did not fail tests.

See [evaluation](evaluation.md) and [raw measured data](../eval/results.json). The controlled synthetic dataset is a reproducibility check, not a general invoice-accuracy benchmark. The [captioned demo](walkthrough.webm) shows the actual offline/OCR workflow.
