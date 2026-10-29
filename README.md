# Folio — Document Intelligence

Upload invoices and ledgers, extract structured data, validate amounts, compare related documents, correct results and search the document library. Supports PDF, JPG, PNG, TIFF, XLSX, XLS and CSV.

## Run locally

Prerequisites: **Node 24+**, **Python 3.13**, and **Tesseract with English language data**.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r apps/ocr-service/requirements.txt
npm.cmd ci
Copy-Item .env.example .env
npm.cmd run dev
```

Open **http://localhost:5173**. On macOS/Linux use `.venv/bin/python`, `npm`, and `cp .env.example .env`. Install Tesseract through your operating system package manager; set `TESSERACT_CMD` if it is not on PATH. The launcher starts the API, worker, parser and Vite client. Local records/files are stored under ignored `data/`.

Default mode uses SQLite and an explicit-label offline extractor. **OCR uses real Tesseract**. Provider extraction and semantic search are optional, configured through `.env`; the UI identifies the extraction mode. The offline parser is intended for reproducible examples, not arbitrary invoice layouts.

## Container stack

```bash
docker compose up --build -d
```

Open **http://localhost:3001**. The stack contains API/React assets, a worker, Python parser, PostgreSQL/pgvector and Redis. Under **Workspace access**, enter `API_TOKEN` (local Compose default: `local-workspace-token-change-me`). Set real access/internal tokens and database/Redis passwords before network deployment. Only the API binds a loopback host port.

For model extraction, set `EXTRACTION_MODE=openai`, `OPENAI_API_KEY` and `OPENAI_MODEL`, then restart API/worker. Semantic search also needs PostgreSQL/pgvector, `SEMANTIC_SEARCH=true` and an embedding key. Existing documents need processing/reprocessing to generate initial embeddings; corrections refresh their vectors in background jobs.

## Architecture

React → Express upload API → transactional document/job storage → background worker → Python parser → structured extraction → validation/reconciliation → searchable results. Redis dispatch is backed by recoverable database polling and job leases. Manual corrections preserve source files and record changes.

| Location | Purpose |
|---|---|
| `apps/web` | React review interface |
| `apps/api` | REST API, persistence, extraction and validation |
| `apps/worker` | Background orchestration and recovery |
| `apps/ocr-service` | PDF, image and spreadsheet parsing |
| `packages/shared-types` | Invoice schema and runtime validation |
| `eval` | Labeled synthetic fixtures and measured evaluation |

[Architecture](docs/architecture.md) · [Database schema](docs/schema.md) · [Evaluation](docs/evaluation.md) · [Test results](docs/test-results.md) · [AI prompts/disclosure](docs/ai-prompts.md) · [Recorded demo](docs/walkthrough.webm)

## API

Document routes require `Authorization: Bearer <API_TOKEN>` when a token is configured.

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | Database readiness and configured capabilities |
| POST | `/api/documents` | Multipart `files` / `files[]`; returns 202 and IDs |
| GET | `/api/documents?query=&status=&page=1&limit=25&mode=keyword` | Search and pagination |
| GET | `/api/documents/:id/status` | Processing state |
| GET | `/api/documents/:id` | Results, flags, source text and history |
| GET | `/api/documents/:id/file` | Original download |
| PATCH | `/api/documents/:id` | Partial invoice correction; optional `If-Match` revision |
| POST | `/api/documents/:id/reprocess` | Requeue a terminal document |

`/documents` aliases are also supported. Public errors use `{ "error": { "code": "...", "message": "..." } }`.

## Test and evaluate

```powershell
npm.cmd test
.\.venv\Scripts\python.exe -m pytest apps/ocr-service/tests -q
npm.cmd run build
npm.cmd run eval
node scripts/browser-check.mjs
```

Install Chromium with `npx playwright install chromium` if needed. Fixtures are committed; regenerate with the virtual-environment Python and `eval/generate_fixtures.py`. Evaluation runs isolated services and writes measured results. Set dedicated `POSTGRES_TEST_URL` / `REDIS_TEST_URL` for service integration tests; CI provisions both.

Saved local results: **25 Node tests passed, two service-dependent tests skipped; 14 Python tests passed; six browser checks passed**. Evaluation processed all 17 valid fixtures and rejected both intentional invalid files. Synthetic field matches are not a general real-world accuracy claim. Live AI/semantic retrieval and Docker/PostgreSQL/Redis execution were not verified in that local run.

## Design choices and limits

Express keeps HTTP orchestration small; Python uses mature parsing/OCR libraries; PostgreSQL keeps relational records, full text and vectors together; a database job outbox prevents losing work when Redis notification fails. SQLite/offline mode supports a reproducible local review.

This is one shared workspace, not multi-tenant user authentication. It models one invoice per document and spreadsheets as expected ledgers. Matching is exact normalized identity with 0.01 monetary tolerance; large deployments need scoped indexed reconciliation and operational benchmarking. Defaults bound files to 25 MB and documents to 1,200 pages/2 million text characters. A 1,000-page digital PDF is measured; a 1,000-page scanned benchmark is not claimed. PyMuPDF has AGPL/commercial licensing considerations for proprietary distribution.
