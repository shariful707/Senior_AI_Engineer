# Verification results

Verification updated October 30, 2026 (Asia/Dhaka), Windows / Node 24.19.0 / Python 3.13 / Tesseract English. The unchanged Python parser suite and labeled accuracy evaluation were originally measured October 28.

| Check | Result |
|---|---|
| Node unit/integration suite | 39 passed, 0 failed; 2 external-service tests skipped |
| Python parser/OCR suite | 14 passed |
| React production build | Passed |
| Browser workflow | Six grouped checks passed; no page runtime errors |
| Workspace interaction suite | Nine groups passed: navigation, samples, edits, source navigation, error recovery, pagination, mobile and real token verification |
| AI interaction suite | Six groups passed using a deterministic local HTTP provider; settings, queued requests, proposals, stale results, retry, mobile and offline switching |
| Real Ollama model | `qwen3.5:4b`: connection test, sample extraction, summary, review and question all completed; six checked source quotes per assistant response |
| Labeled evaluation | 19 files: all 17 valid inputs processed, 2 intentional negatives rejected |
| Local launcher | UI, API, parser and worker started; proxied endpoints returned HTTP 200 |

Node tests cover API access/errors, uploads/signature cleanup, fresh SQLite concurrency, durable claims, corrections/revision conflicts, search/downloads, reprocessing, cross-document flag clearing, extraction schema/retry/refusal, embedding dimensions, worker retries and lease fencing. Raw output: [node-test-results.txt](node-test-results.txt).

Additional sample tests verify authentication, concurrent idempotence, real copied files, queued jobs, sample labeling and combined active-status filtering. [Workspace browser results](workspace-results.json) exercise all main controls, persistent mutation/error feedback, source sheets, bulk-upload limits, next/previous pagination, missing documents, mobile settings, invalid/correct tokens and disconnect. Samples remain separate from the labeled evaluation dataset; test/evaluation harnesses disable automatic sample loading.

Python checks use real digital/scanned PDFs, real JPG/PNG/TIFF OCR, multi-frame TIFF, XLS/XLSX/CSV, corrupted/blank input, spoofing, invalid workbook ZIP and a 1,000-page digital PDF. The browser verifies uploads, correction/validation, supplier search/download, ledger mismatch navigation, reprocessing and mobile width.

AI backend tests additionally cover credential encryption/tampering, public-response secret exclusion, unsafe URL rejection, asynchronous configuration activation, failure preservation, native Ollama schema/audits, quote/operand checks, non-mutation of invoice data, revision staleness, expired lease recovery and cancellation fencing. [AI browser results](ai-browser-results.json) use a controlled local HTTP test double and do not measure model quality.

[Real model measurements](llm-verification.json) use the installed local Ollama service: the connection test took 70.3 seconds including initial loading, sample invoice extraction took 4.46 seconds, and summary/review/question responses took 7.11 / 6.83 / 4.62 seconds. The source invoice `INV-1001` extracted total 1,344 USD. [The screenshot](screenshots/local-ai.png) shows the real answer rendered in the UI. Only one synthetic invoice was checked live, so these results do not establish general extraction accuracy or model reliability.

The PostgreSQL/pgvector and Redis/BullMQ tests require dedicated service URLs; CI provisions them. Their local skips are not passes. Docker images, cloud providers and semantic retrieval quality were not verified locally. A dependency deprecation warning in the Python TestClient did not fail tests.

See [evaluation](evaluation.md) and [raw measured data](../eval/results.json). The controlled synthetic dataset is a reproducibility check, not a general invoice-accuracy benchmark. The [captioned demo](walkthrough.webm) shows the actual offline/OCR workflow.
