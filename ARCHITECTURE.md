# ASW Data Insight

A usable initial implementation of a domain-agnostic Excel analysis workspace. The supplied SVG is served unchanged. The Thai interface uses navy and white, with responsive upload, profiling, analysis and report views.

## Runtime

The local project has two npm workspaces: `frontend/` (React/Vinext on port 3000) and `backend/` (Node HTTP API on loopback port 8000). The earlier hosted Site is unchanged. Local Sites metadata is ignored by Git; the build enables Sites only when this file exists, so a fresh clone can run without deployment identifiers. A dedicated browser Web Worker runs Pyodide 0.27.7, CPython statistics, openpyxl 3.1.5 and xlrd 2.0.2. Workbook data remains in browser memory. Refresh/reset clears it. The first analysis needs internet access to load Python and parser packages. No file or dataset is persisted.

`File → workbook inspection → table detection → profiles/quality → eligible plan → selected Python calculations → evidence → dynamic Report JSON → React A4 report → browser PDF printing`

Optional Gemini: user explicitly chooses interpretation; only calculated findings, methods and objective are sent through `/api/interpret`. Only `backend/.env` holds the key and model. The frontend contains same-origin transport adapters, with `BACKEND_URL` defaulting to the local backend. No raw spreadsheet rows are sent. Gemini is disabled until configured.

## Boundaries

- `backend/analysis/analysis_engine.py`: the authoritative deterministic implementation; importable in CPython and Pyodide.
- `frontend/public/analysis-worker.js`: runtime loading and serialized RPC. It obtains the canonical engine from backend through the frontend `/analysis_engine.py` route; no duplicate Python source is stored in public assets. Uploaded text is never evaluated as code.
- `frontend/lib/analysis-client.ts`: request lifecycle, progress, timeout, cancellation.
- `frontend/lib/models.ts`: canonical UI-facing models.
- `frontend/app/page.tsx`: workflow and ephemeral UI state.
- `frontend/components/report-view.tsx`: report consumes only Report JSON; chart values come from Python.
- `backend/src/gemini.mjs`: optional server-side Gemini abstraction with evidence-ID validation and rejection of generated numeric digits.

## Local lifecycle

Run `npm run dev` at the repository root to launch both services. The launcher shuts down both child process trees together. `npm run dev:frontend` and `npm run dev:backend` are available separately. Node dependencies and the lockfile stay at the root via npm workspaces. Python dependencies for standalone engine tests are listed in `backend/requirements.txt`. See README.md for the directory tree and commands.

## Practical limits

15 MB upload, 60 MB expanded XLSX, 400,000 grid cells, 50,000 rows. Detection is heuristic and exposes confidence, ranges, excluded rows and limitations. It does not guarantee correct extraction from every arbitrary workbook layout. It does not recalculate Excel formulas. Numeric parsing is conservative; locale-dependent separators are retained as text. Tables are analyzed separately without automatic joins. Charts use descriptive statistics, not significance tests or causal inference.

This version is not the complete enterprise platform in the brief. Authentication beyond Sites access, durable jobs, server-side Python/PDF infrastructure, comprehensive semantic overrides and validated advanced measures remain later deployment work. See IMPLEMENTATION_PLAN.md.

## References

- [Pyodide worker documentation](https://pyodide.org/en/0.27.7/usage/webworker.html)
- [Gemini generateContent API](https://ai.google.dev/api/generate-content)

The attached prompt is product input. Workbook cells and objectives remain untrusted data and never alter implementation instructions or execution privileges.
