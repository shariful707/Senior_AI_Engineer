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

Fresh local offline workspaces automatically include five clearly labeled synthetic sample documents. Use **Sample documents** to load/view them again without duplicates. They use the real processing pipeline and are safe to edit. Set `SEED_SAMPLE_DOCUMENTS=false` to disable automatic loading.

**Workspace settings** explains access, extraction and upload limits. Local mode needs no token. When server protection is enabled, the workspace token is a shared access password (`API_TOKEN`), not an AI API key; entered keys are verified before they are saved.

Default mode uses SQLite and an explicit-label offline extractor. **OCR uses real Tesseract**. Connect a real LLM through **AI settings**; the UI shows its provider/model. The offline parser is intended for reproducible examples, not arbitrary invoice layouts.

## Connect a model

For local AI, install/start [Ollama](https://docs.ollama.com/quickstart), install a model that fits your PC (for example `ollama pull qwen3.5:4b`), then open **AI settings → Local Ollama → Detect installed models → Test and enable AI**. Existing installed models can be used without downloading another. The worker tests a real structured response before switching the active connection. Initial model loading can take a minute or more; later requests are usually faster. Keep Ollama running while using AI.

**Why no token?** Local Ollama runs on your PC and needs no cloud API key. The optional **workspace token** (`API_TOKEN`) is a shared password protecting this app's documents when access protection is enabled; it never connects an LLM. Local app access protection is off by default. A **provider API key** authenticates cloud model requests and is separate. Model input/output **tokens** are pieces of text, not credentials. The same explanation appears in Workspace settings and AI settings.

Once connected, new invoices use the model for schema-validated extraction. Use **Reprocess** for existing documents. Open a processed document to **Summarize document**, **Explain review flags**, or **Ask AI**. Responses include checked source quotes, source navigation, history and provider/model metadata. Supported correction proposals open an editable draft; only **Save changes** writes them. Earlier responses are marked stale after document changes. Answers still require human review; exact quote checks do not prove every model claim.

OpenAI and OpenAI-compatible providers are also supported in AI settings. Enter cloud keys only there. Saved keys are encrypted on the server, never returned to the browser. Back up `data/.ai-master-key` with your database, or set the same `AI_SETTINGS_ENCRYPTION_KEY` on API and worker. Successful workspace settings persist in the database and override extraction environment defaults. **Use offline extraction** disables the model and cancels pending assistant/configuration requests.

## Container stack

```bash
docker compose up --build -d
```

Open **http://localhost:3001**. The stack contains API/React assets, a worker, Python parser, PostgreSQL/pgvector and Redis. Under **Workspace settings**, enter `API_TOKEN` (local Compose default: `local-workspace-token-change-me`). Set real access/internal tokens and database/Redis passwords before network deployment. Only the API binds a loopback host port. Samples are available through the Sample documents button after access is verified.

For host Ollama from Docker, set its address in AI settings to `http://host.docker.internal:11434`. Ollama must accept connections from the container bridge; keep that service private to your machine. Compose supplies this URL as its default unless overridden. Alternatively configure `EXTRACTION_MODE=ollama`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, or `EXTRACTION_MODE=openai` plus `OPENAI_API_KEY` / `OPENAI_MODEL`, then restart API/worker. Stored workspace settings take precedence. Semantic search is configured separately: it needs PostgreSQL/pgvector, `SEMANTIC_SEARCH=true` and an embedding key through `OPENAI_API_KEY`. Connecting Ollama does not enable semantic embeddings. Existing documents need processing/reprocessing to generate initial embeddings; corrections refresh their vectors in background jobs.

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

[Architecture](docs/architecture.md) · [Database schema](docs/schema.md) · [Evaluation](docs/evaluation.md) · [Test results](docs/test-results.md) · [AI usage disclosure and prompts](docs/ai-prompts.md) · [Recorded demo](docs/walkthrough.webm)

## AI usage disclosure

This project was developed with substantial OpenAI Codex assistance across application code, UI, tests, synthetic fixtures, debugging and documentation. The [AI usage disclosure and prompt reference](docs/ai-prompts.md) documents that scope, exact runtime prompts, source links, data handling and the distinction between controlled tests and live model verification. Reported results come from executed checks and saved artifacts; the synthetic evaluation and one-invoice Ollama check are not general real-world accuracy claims.

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
| POST | `/api/workspace/samples` | Idempotently queue the five synthetic examples; uses normal workspace authentication |
| GET | `/api/ai/settings` | Active provider/model metadata; never returns stored keys |
| GET | `/api/ai/models?base_url=` | Detect installed local Ollama models |
| POST | `/api/ai/configure` | Queue a real connection test; enable only after it passes |
| POST | `/api/ai/disable` | Switch to offline extraction and cancel pending AI requests |
| GET | `/api/ai/runs/:runId` | Connection/assistant request status and safe result |
| GET | `/api/documents/:id/ai` | Latest 20 assistant responses with revision/stale status |
| POST | `/api/documents/:id/ai` | Queue `summary`, `review` or `question` with a question up to 1,000 characters |

`/documents` aliases are also supported. Public errors use `{ "error": { "code": "...", "message": "..." } }`.

## Test and evaluate

```powershell
npm.cmd test
.\.venv\Scripts\python.exe -m pytest apps/ocr-service/tests -q
npm.cmd run build
npm.cmd run eval
node scripts/browser-check.mjs
npm.cmd run test:workspace
npm.cmd run test:ai
```

Install Chromium with `npx playwright install chromium` if needed. Fixtures are committed; regenerate with the virtual-environment Python and `eval/generate_fixtures.py`. Evaluation runs isolated services and writes measured results. Set dedicated `POSTGRES_TEST_URL` / `REDIS_TEST_URL` for service integration tests; CI provisions both.

Saved local results: **39 Node tests passed, two service-dependent tests skipped; 14 Python tests passed; six original browser checks, nine workspace interaction groups and six AI interaction groups passed**. Evaluation processed all 17 valid fixtures and rejected both intentional invalid files. A real installed Ollama `qwen3.5:4b` also passed connection testing, sample invoice extraction and all three assistant tasks with checked citations: [measured live results](docs/llm-verification.json), [screenshot](docs/screenshots/local-ai.png). The AI browser suite uses a deterministic local HTTP provider for reproducible UI/error tests. Synthetic field matches and a single live invoice are not general accuracy claims. Cloud-provider execution, semantic retrieval and Docker/PostgreSQL/Redis execution were not verified locally.

## Design choices and limits

Express keeps HTTP orchestration small; Python uses mature parsing/OCR libraries; PostgreSQL keeps relational records, full text and vectors together; a database job outbox prevents losing work when Redis notification fails. SQLite/offline mode supports a reproducible local review.

This is one shared workspace, not multi-tenant user authentication. It models one invoice per document and spreadsheets as expected ledgers. Matching is exact normalized identity with 0.01 monetary tolerance; large deployments need scoped indexed reconciliation and operational benchmarking. Defaults bound files to 25 MB and documents to 1,200 pages/2 million text characters. A 1,000-page digital PDF is measured; a 1,000-page scanned benchmark is not claimed. PyMuPDF has AGPL/commercial licensing considerations for proprietary distribution.
