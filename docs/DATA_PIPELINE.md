# ASW Data Insight — active data pipeline

React presents one workflow and four result views. Node handles HTTP/job lifecycle and server-only Gemini calls. Python handles all file parsing, deterministic calculations, temporary SQLite queries and report exports. The existing generic/BOQ engine modules remain in source but are not selected by the active UI.

## Request flow

Upload one CSV/XLSX → validate/parse all worksheets → store SQLite → compute profiles and evidence → one Gemini reasoning request → validate typed output → publish Dashboard/Report → export on demand.

The backend returns actual stage changes. Parsing occupies the early progress range, profiling/analysis the middle, followed by AI and report assembly. A ready job reaches100 only when its usable result is available. AI failure preserves computed results and is disclosed in `analysis.ai`.

## API

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/datasets/config` | Accepted types, limits, retention, `auto_analyze`, `ai.configured`, `ai.model` |
| POST | `/api/datasets` | Exactly one multipart `file`;202 with job ID |
| GET | `/api/datasets/{id}` | Status, stage, progress, dataset metadata, analysis and optional error |
| GET | `/api/datasets/{id}/rows` | Paginated/searchable/sortable sheet data |
| POST | `/api/datasets/{id}/analyze` | Reanalyze stored data; optional JSON `objective` up to1000 characters |
| GET | `/api/datasets/{id}/export?format=pdf` | Typeset PDF report |
| GET | `/api/datasets/{id}/export?format=xlsx` | Formatted Excel summary |
| GET | `/api/datasets/{id}/export?format=csv&sheet=s0` | Selected worksheet CSV |
| DELETE | `/api/datasets/{id}` | Cancel/delete temporary dataset |

Row query: `sheet`, `page`(1-based), `page_size`(1–100), `search`, optional `column`, optional `sort`, `direction`(asc/desc). Column/sheet identifiers are validated against stored metadata. Nulls sort last; original row number breaks ties. The frontend uses the same binary-preserving proxy in production; no JSON conversion of upload/export bytes.

Status: processing/ready/error. Errors are `{error:{code,message}}`. Missing/expired IDs return404; invalid input400/415; oversized413; unfinished409; capacity429; unavailable503. No global dataset listing exists. All responses use no-store.

Analysis contract: `generated_at`, `summary`, `kpis`, `insights`(evidence IDs/methods/source columns), `profiles`, `charts`, `report.sections`, and `ai`(complete/unavailable/error). Frontend TypeScript definitions are in `frontend/lib/dataset-analysis.ts`. AI cannot overwrite deterministic KPIs, statistical values or charts.

## Gemini

Runtime/example model: `gemini-3-flash-preview`; `thinkingConfig.thinkingLevel=minimal`. Uses server-only `GEMINI_API_KEY`, JSON schema and one request containing bounded calculated evidence/schema/aggregates. No uploaded file or full raw dataframe is sent. Returned citations and numerical statements are checked against supplied evidence; AI suggestions remain interpretations and should be reviewed in business context.

Provider documentation: [model](https://ai.google.dev/gemini-api/docs/models/gemini-3-flash-preview), [Gemini3 settings](https://ai.google.dev/gemini-api/docs/generate-content/gemini-3). A configured key/provider availability is required for live AI; local deterministic results remain usable without it.

## Data and resource boundaries

Default limits:25MiB/file,100k rows,200 columns/sheet,2million cells,50 worksheets,100MB expanded XLSX. CSV streams; XLSX uses read-only parsing after archive/coordinate validation. Dataset limits reject rather than silently sample. Statistics cover ingested data. Chart/insight/correlation selection is bounded; methods disclose the subset/point sampling. Preview strings can be abbreviated with explicit metadata while SQLite/full-text search retain originals.

One rectangular table per nonempty worksheet; first nonempty row contains unique text headers. Formula text remains inert and is disclosed. Exports guard formula injection. PDF is generated as a report document with an embedded Thai-capable font, never a dashboard screenshot.

Files are temporary, have random storage names and are never executed. Original files are removed after parse. Cancellation/expiry/graceful shutdown remove job storage. Job IDs are192-bit capabilities; they are not user authentication. Use one backend instance and controlled access. Persistent/public deployment needs authentication/ownership, durable cross-instance jobs and crash-safe retention; use ephemeral temp storage until those operational requirements are addressed.
