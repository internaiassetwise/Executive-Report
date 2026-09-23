# Phase 1 verification — 2026-09-10

## Passed

- `npm run typecheck` — React/TypeScript contracts and app routes.
- `npm run build:backend` — Node syntax checks, including dataset service.
- `npm run build` — final production frontend build and dataset route discovery.
- `npm test` — 2 frontend interpretation tests and23 backend tests. The dataset API tests call the real Python worker and include real HTTP bodies above the former100KB cap.
- Three additional production proxy tests pass: binary XLSX upload through the streaming app adapter with real Python processing, exact query forwarding/deletion, origin rejection, and backend unavailable handling. The frontend test glob now includes these tests (28 JavaScript tests total).
- `npm run test:datasets` —16 parser/SQLite tests, including malformed XLSX coordinates, UTF-16, hidden sheets, formulas, full-value search and bounded Unicode previews.
- `npm run test:analysis` —21 existing deterministic engine tests.
- `npm run test:boq` —10 existing BOQ engine tests.
- Focused oxlint on all new/changed frontend application files passes.

## Browser checks on localhost

- Select a synthetic Thai CSV, see filename/size, explicitly start, observe backend processing, arrive at real typed data.
- Preserve `001` as text; detect dates and numeric fields; sort5,12,20,100 numerically.
- Search a Thai category and return only the two matching rows.
- Reload and restore the active dataset in the same tab.
- Reset/delete, then upload an XLSX with120 ordinary rows and a separate2-row BOQ sheet through the same path.
- Render50 rows, open page2 starting at source row52, switch to BOQ and reset pagination.
- Reject duplicate CSV headers with a clear sheet/row error and retry/replace controls.
- Inspect upload and horizontally scrollable preview at390×844 and desktop size; reset temporary viewport override after QA.

## Existing baseline issue

Full `npm run lint` still fails in legacy components/UI primitives, `lib/models.ts`, and `hooks/use-mobile.ts` (accessibility rules, explicit-any/formatting types, existing effect patterns). These files are outside the new home-page flow and were not changed to silence the errors. Introduced lint errors were fixed, and scoped lint for the new flow passes.

## Scope and limits

No live LLM call, statistical dashboard, report/export or deployment was performed: these are subsequent phases in the supplied brief. Runtime storage remains single-process/temporary, with authentication and crash-safe retention pending. Full details are in PHASE_1.md. Existing uncommitted changes in the analysis/BOQ/Gemini engines and their tests were preserved.
