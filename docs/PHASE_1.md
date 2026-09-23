# Phase 1: dataset preparation

## Architecture and data flow

React/TypeScript → same-origin Node HTTP API → bounded Python subprocess → temporary SQLite dataset → paginated JSON preview.

CSV is processed incrementally with Python's strict CSV reader; XLSX uses openpyxl read-only mode after ZIP/structure checks. Both use the same schema and row ingestion path. No business column names, BOQ classification or silent removal of summary rows. SQLite keeps the browser response bounded and performs filtering/sorting without transferring the full sheet to the client. Basic type detection runs over all ingested cells; full statistical profiling belongs to Phase 2.

The existing Node API is retained as transport/job coordinator rather than adding a second running service in Phase 1. Python owns parsing, normalization, storage and table queries. FastAPI can replace this transport later without changing the dataset contract; it is not required to run this delivery.

## HTTP API

All endpoints return `Cache-Control: no-store`. Mutations require an allowed `Origin`. Frontend Vite proxies `/api` in development; production app routes stream multipart data through to `BACKEND_URL`.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/datasets/config` | File types, byte/row/column/cell limits, retention |
| POST | `/api/datasets` | Multipart form with exactly one field named `file`; returns202 |
| GET | `/api/datasets/{id}` | Job state, real backend stage, result metadata or structured error |
| GET | `/api/datasets/{id}/rows` | Paginated sheet data |
| DELETE | `/api/datasets/{id}` | Cancel active workers and delete temporary dataset; returns204 |

Create response:

```json
{"id":"<32-character random capability>","status":"processing","stage":"validating","progress":10}
```

Job states: `processing`, `ready`, `error`. Processing stages: `validating`, `reading`, `detecting_types`, `preview`. Percentages are completed-stage indicators, not elapsed-time predictions; upload bytes are shown separately. `100` is returned only when parsing/storage succeeded. Polling never fabricates progress. Upload processing is asynchronous after the bounded file has been received and validated.

Ready response shape:

```json
{
  "id":"<id>", "status":"ready", "stage":"preview", "progress":100,
  "dataset":{
    "filename":"example.csv", "rows_count":2, "columns_count":2,
    "created_at":"2026-09-10T00:00:00+00:00", "warnings":[],
    "sheets":[{
      "id":"s0", "name":"CSV", "rows_count":2, "header_row":1, "warnings":[],
      "columns":[
        {"key":"c0","name":"Item","data_type":"text"},
        {"key":"c1","name":"Quantity","data_type":"number"}
      ]
    }]
  }
}
```

`columns_count` is the sum of column counts across parsed sheets. Types: `number`, `text`, `date`, `boolean`, `mixed`, `empty`. Leading-zero IDs, large integers outside JavaScript's safe integer range, ambiguous dates and formula text remain strings. ISO dates are recognized; missing cells become JSON null. Sheet names and file names are presentation data, never query identifiers or storage paths.

Rows query parameters: `sheet` (default first parsed sheet), `page` (1-based), `page_size` (1–100, default50), `search` (literal case-insensitive substring), `column` (optional `cN`, confines search), `sort` (optional `cN`), `direction` (`asc` or `desc`). Sort/filter keys are validated against the selected sheet. Nulls sort last in both directions, ties use original row number. Mixed values retain their scalar types; no domain assumptions are imposed.

```json
{
  "rows":[{"row_number":2,"values":{"c0":"Item A","c1":12}}],
  "total_rows":2,"page":1,"page_size":50,
  "truncated_cells":0,"max_cell_characters":2000
}
```

`row_number` is the original Excel row or CSV physical starting line (quoted CSV fields may span lines). `total_rows` reflects filtering, while sheet metadata retains the full count. The client requests a new page after search, sort, page-size or sheet changes and ignores stale responses.

Very long text is shortened only in preview responses to keep a wide page within a bounded payload. `truncated_cells` counts shortened cells on the page, and `max_cell_characters` is the displayed per-cell limit (adapted to page size/column count, up to2000). The UI explicitly discloses this and appends an ellipsis. SQLite values and full-value search/sort are unchanged.

Errors: `{ "error": { "code": "MISSING_HEADERS", "message": "..." } }`. Failed asynchronous jobs expose the same error object in their status response. Expected HTTP errors include400 (validation/query),403 (origin),404 (missing/expired capability),409 (not ready),413 (size),415 (format/MIME),429 (capacity),503 (runtime unavailable) and504 (worker timeout).

## Validation and limits

Accepted: CSV UTF-8/UTF-8 BOM, UTF-16 BOM; comma/semicolon/tab/pipe delimiters; XLSX worksheets. Single file only. First nonempty row is the header. A nonempty invalid sheet rejects the workbook with its location, instead of silently dropping it. Blank sheets are skipped with warnings. Blank rows are skipped with original row numbers retained. Missing trailing data values are null; data extending beyond known headers is rejected.

Checks include MIME/extension/signature consistency, empty input, strict quoting, missing/duplicate headers, malformed/corrupt/encrypted ZIP structures, macro content, expanded XLSX byte count, sheet/row/column/cell limits and unsupported Excel error values. Formula text is preserved, never executed. This phase has no export feature, so formula-injection protection must also be applied when exports are added in Phase6.

Defaults: 25MiB/file;100,000 rows/file;200 columns/sheet;2million cells/file;50 sheets;100MB expanded XLSX;2 concurrent uploads/ingests;2 concurrent preview workers;20 stored jobs;120s ingest timeout;30s preview timeout;60min retention. Runtime limits are configured through `backend/.env.example`; UI uses `/config`, not duplicated constants. Limits are enforced by rejection; there is no undisclosed sampling. Spreadsheet content is never logged.

## Lifecycle, privacy and deployment boundary

Generated IDs have192 bits of randomness and act as capabilities; the service has no list-all endpoint. The browser stores only the active ID in sessionStorage, not rows or files. Files are stored under a unique per-process temporary root, with generated filenames. Original uploads are removed after parse. Failed jobs, explicit deletion, expiry and graceful shutdown clean dataset files; expiry runs at most60seconds after its deadline and is also checked at access.

Cancellation during upload waits for the server-issued ID before deleting, so it can remove a request accepted just before the response. If the browser disconnects before receiving that ID, TTL still applies. Jobs are not durable across backend restarts. Abrupt process/machine termination can leave temporary directories: configure an isolated ephemeral temp volume (or scheduled administrator cleanup) until restart-safe ownership/retention is implemented. This limit must be addressed before persistent production storage is used.

Run one backend process for this phase. Requests across replicas cannot locate each other's in-memory jobs. Authentication, dataset ownership and per-user quotas are not implemented; CORS/origin checking is not user authentication. Add these before exposing the service to multiple untrusted users. Use HTTPS and an isolated backend runtime/temp storage in deployment. Node-only hosting images must install Python/openpyxl; no hosting configuration was changed or deployed as part of Phase1.

## AI strategy and next phases

Phase1 makes no LLM calls and does not label preview as AI findings. Phase2 adds deterministic profiling and aggregations from this dataset. Phase3 sends bounded profiles, relevant aggregations and selected samples to a server-side provider and validates structured JSON/evidence references. Existing LLM keys stay server-side; profiles may still contain sensitive categories and require appropriate privacy policy before transmission. Dashboard/chart/report outputs will be generated only from supported computed evidence, with explicit insufficient-data statements.

The old BOQ and generic analysis modules remain in source, outside the active UI. This preserves earlier work while removing the two-mode user flow. Migration must validate their schema assumptions before reuse. See `IMPLEMENTATION_PLAN.md` for all seven phases.

## Verification

`npm test` covers real Python-backed API upload/poll/preview/delete and legacy API tests. `npm run test:datasets` exercises strict CSV/XLSX parsing, all-sheet provenance, formulas, invalid headers/structures, resource limits and sorted/paginated queries. `npm run typecheck`, `npm run lint`, `npm run build:backend`, `npm run build` validate frontend and server build. Legacy deterministic tests remain separate regression checks.
