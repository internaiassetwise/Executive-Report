# Implementation status

## Implemented and tested

1. Workbook readers: XLSX, XLS, CSV; Thai/English; visible/hidden inspection and formula-cache warnings.
2. Table detector: displaced headers, supported merged header parents, separate vertical/horizontal regions, partial/headerless tables, ranges and confidence.
3. Profiles: types, roles, samples, unique counts, nulls, numeric statistics. Quality: missingness, duplicates, constants, mixed numeric cells, ambiguous dates and summary candidates.
4. Planner: Gemini chooses eligible analyses automatically, with one planning pass followed by one deterministic calculation pass, without a whole-workbook AI review. Bounded fragments handle multi-table/wide workbooks; all bounded parts are processed with at most two concurrent requests (one after an error), including queues larger than 64 parts. Users need not choose tables or answer clarification questions.
5. Deterministic engine: summary statistics, category frequencies/means, monthly means, distributions, IQR outliers and stable Pearson correlation.
6. Evidence: calculation IDs, table/sheet/range/columns, methods and limitations. Numeric evidence remains Python-owned.
7. Server-side Gemini planning and narrative writing are required for the current upload flow. Numeric claims and operation IDs are checked; semantic correctness is not guaranteed. Real Gemini 2.5 Flash calls have been tested using synthetic BOQ data.
8. Dynamic report sections from executed analyses, executive facts, provenance, quality and recommendations; JSON download and A4 browser PDF printing.
9. Responsive Thai UI using supplied ASW SVG, navy and white; loading/error/cancel/reset states and synthetic sample data.
10. Tests cover parser ambiguity, multi-table workbooks, bounded planning for 201 tables, 804-evidence hierarchical summaries, cancellation, cached retries and partial narrative failures, including an 86-part single-pass upload-to-writing regression, legacy review compatibility and recovery after part 64. Pyodide integration checks CSV/XLSX and sample analyses.
11. The upload entry point probes for BOQ comparison structure first. Detected BOQ files use the original deterministic comparison engine and A4 renderer with Gemini replacing narrative slots only; non-BOQ files fall through to the generic AI-planned report without a second file parse.
11. Partial processing is disclosed in report UI and JSON. In-memory successful-request checkpoints support retry without resending successful parts; no durable background queue yet.

## Remaining for the full production brief

- Optional manual header/region, role, date-format and unit overrides; richer semantic understanding. Current automatic mode limits ambiguous tables to quality checks instead of asking questions or guessing.
- Stronger multi-row header, note/summary-region and arbitrary sparse-layout detection. Multi-sheet relationships require explicit keys and cardinality checks.
- Additive metric/unit validation before sums, Pareto, contribution, ratios, growth or financial calculations. Weighted rates, period completeness and incompatible currencies need explicit rules. MAD/robust Z-score, cross-tabs, concentration and segmentation are not yet implemented.
- A Python job service and queue with authorization, durable evidence, retention policy and operational monitoring, if server storage is needed.
- Jinja2 → Chromium/Playwright PDF service with automatic page-render validation and repeated headers/footers. Current hosted export uses the user's browser print dialog; printing support and page numbering depend on the browser.
- Stronger semantic validation of free-form LLM text: current validator rejects digit characters and unknown evidence IDs, but cannot prove that all qualitative or spelled-out numerical claims are supported. Keep interpretation clearly separate from facts.
- Comprehensive integration/browser/accessibility/load/security review before an enterprise production rollout. The Sites starter's pinned dependencies should undergo a dependency advisory review. No browser UI QA was requested for this build.
- WebMCP tools feature-detect support; no supported validation context was available, so registration and execution were not independently verified.

## Local validation

`python backend/tests/test_engine.py` (requires openpyxl)

`node frontend/tests/pyodide-smoke.mjs` (requires internet for runtime parser packages)

`npm run typecheck`

`npm run build`

## Local usage

`npm install` then `npm run dev`. Open the URL printed by the server. For Gemini, set `GEMINI_API_KEY` and `GEMINI_MODEL` in `backend/.env`; the UI checks whether both are present. For future hosting, deploy a reachable backend and set frontend `BACKEND_URL` plus backend `FRONTEND_ORIGINS`. The current folder split is local only and does not republish the old Site. Never place provider secrets in public assets or client-side environment variables.

## Frontend/backend folder separation

UI and browser worker are in frontend/. Gemini HTTP API, its private .env, canonical Python engine and Python tests are in backend/. Same-origin frontend routes proxy the two existing browser requests to backend. Browser analysis and PDF behavior are unchanged. Root npm scripts start both services; Node API tests additionally cover source delivery, accepted frontend origins, malformed payloads and secret-free status responses.
