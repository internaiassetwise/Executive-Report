# Canonical models and interfaces

The canonical TypeScript response models are `frontend/lib/models.ts`; Python dictionaries are the authoritative source of calculated values.

## Inspect

Current UI calls worker `boq` with `{files:[{filename,bytes}]}` for every upload. The worker passes bytes without JSON encoding and opens each file once. If benchmark/proposal columns are detected, the result is `{mode:'boq',report,html}` and the specialized BOQ calculator/renderer is used. Otherwise the already-open sheets fall through to `{mode:'generic',book}`; multiple files retain indexed filename/sheet provenance and globally unique table IDs before entering the generic planner/calculator/writer pipeline.

Input: `{filename, bytes}` to worker action `inspect`.

Output `WorkbookProfile`: filename, sheet/table/row counts, notes, workbook metadata, all-sheet coverage, aggregated quality, eligible analysis types and tables. Coverage includes hidden, empty and metadata-only sheets with explicit reasons when no table is found. `TableProfile` has a stable ID, sheet/range, detected header row, confidence heuristic, dimensions, profiles, preview, quality, excluded rows and eligible opportunities. Full rows and source-row coordinates stay in worker memory. Original values are retained separately from normalized values.

`ColumnProfile`: original/normalized name, storage/semantic type, role, unique/nonempty/missing counts, numeric-distinct count, samples, confidence and descriptive statistics. Empty cells are never zero-filled. Inference confidence is a heuristic, not a probability.

## Analyze

UI input: `{selected_types: string[], objective}` to `analyze_workbook`. Omitted types default to all eligible types; quality always runs for every detected table. The existing `{table_id, selected: plan_ids[], objective}` action `analyze` remains available as an internal single-table contract.

Output `Report`: metadata, dataset overview with per-sheet and per-table completion, weighted quality, excluded rows, analyses, evidence, explicit calculation errors, dynamic sections, executive summary, recommendations and limitations. Each result links one `Evidence` by a report-wide unique ID. Results, evidence, issues and exclusions preserve source provenance. Confidence 1.0 expresses reproducible arithmetic only, not certainty about inferred business meaning.

Unknown actions, tables, empty selections and forged plan IDs are rejected. JSON serialization rejects NaN/Infinity. UI formatting does not recalculate analytical results.

## Gemini

Before narrative writing, duplicate evidence-set headings are merged. Outlines above 12 sections consolidate related evidence under representative titles and questions already proposed by the planner; no fixed category titles are shown and values are not aggregated across sources. Section analysis_ids retain all linked evidence; optional display_analysis_ids selects up to three illustrative results for the existing renderer. Large evidence groups are summarized in bounded batches; final section narratives are reused for executive synthesis instead of resending the same evidence globally. Executive summary and recommendations run concurrently from the same completed evidence, and both settle before returning or reporting failure. Original plan, analyses and evidence remain unchanged in JSON. Consolidation does not add supported calculations or guarantee semantic correctness.

Generic flow: POST `/api/plan` receives objective, partitioned table profiles, summaries calculated from full-table planning_context (category counts, date coverage, quartiles, IQR anomalies), bounded source-addressable examples, and eligible opportunities. Each request returns an `AIPlan` with a title, understanding, limitations and 1–8 sections referencing exact table/analysis pairs. Frontend merges plans. Python `analyze_workbook.selected_plans` validates those pairs, executes selected analyses plus global quality checks. `Report.plan` retains the plan; `dynamic_sections` links each heading to computed evidence IDs. POST `/api/report` writes sections from those records. No arbitrary generated code is executed. Raw full rows stay in worker memory, but preview/sample values are sent to Gemini.

BOQ flow: `boq_engine.build_many` detects benchmark/vendor axes and calculates quantity, material, labour, normalized totals and savings from all applicable rows. It supports side-by-side vendors, sheet-per-vendor and file-per-vendor layouts. The tolerance is inferred from the file when possible or uses the engine default. POST `/api/report` receives calculated BOQ summaries—not the workbook—and replaces narrative fields only. `boq_render` then renders the original specialized A4 report tables and sections with those AI-written narratives.

The following describes the legacy optional interpretation endpoint:

Input: objective plus an array of `{evidence_id, finding, method}`. No rows or file bytes. Output: `insights[]` with `interpretation`, `recommendation`, `evidence_ids`. No new numerical claims are accepted by the digit validator. The optional output is separate from Python facts.


The upload flow runs one planning pass: plan → full-row calculations and deterministic validation → writing. There is no automatic whole-workbook AI review or second calculation pass. The planner partitions eligible operations and column metadata into bounded fragments, packs at most six different tables per request and drains the queue with at most two concurrent requests, preserving source order and reducing concurrency to one after any failure, without a fixed part-count cutoff. Per-request size/time limits, cancellation and a three-consecutive-failure circuit remain active; this is not a total token or spend cap. Fragments carry at most 12 diverse source samples restricted to their columns. Arrays and long text are compacted with omission metadata for transport; full calculated evidence remains local. Samples are descriptive, not statistically representative.

AIPlan.processing records parts/completed/partial, failed scopes and per-table eligible/selected operation coverage. Low-confidence or unresolved-total generic tables expose quality checks only. Reports disclose partial planning, calculation and narrative failures. Section writing is followed by hierarchical evidence summaries, then executive summary and recommendations. No question/confirmation stage is required. Successful requests are cached by payload hash in page memory (256-entry limit), not persisted jobs; failures can be retried. Receipts for planning and writing are retained. The optional review argument remains for compatibility/tests, but the upload flow does not invoke it. Invalid provider responses may still receive a bounded repair retry; this is not a second workbook review.
