# Canonical models and interfaces

The canonical TypeScript response models are `frontend/lib/models.ts`; Python dictionaries are the authoritative source of calculated values.

## Inspect

Input: `{filename, bytes}` to worker action `inspect`.

Output `WorkbookProfile`: filename, sheet/table/row counts, notes, workbook metadata, all-sheet coverage, aggregated quality, eligible analysis types and tables. Coverage includes hidden, empty and metadata-only sheets with explicit reasons when no table is found. `TableProfile` has a stable ID, sheet/range, detected header row, confidence heuristic, dimensions, profiles, preview, quality, excluded rows and eligible opportunities. Full rows and source-row coordinates stay in worker memory. Original values are retained separately from normalized values.

`ColumnProfile`: original/normalized name, storage/semantic type, role, unique/nonempty/missing counts, numeric-distinct count, samples, confidence and descriptive statistics. Empty cells are never zero-filled. Inference confidence is a heuristic, not a probability.

## Analyze

UI input: `{selected_types: string[], objective}` to `analyze_workbook`. Omitted types default to all eligible types; quality always runs for every detected table. The existing `{table_id, selected: plan_ids[], objective}` action `analyze` remains available as an internal single-table contract.

Output `Report`: metadata, dataset overview with per-sheet and per-table completion, weighted quality, excluded rows, analyses, evidence, explicit calculation errors, dynamic sections, executive summary, recommendations and limitations. Each result links one `Evidence` by a report-wide unique ID. Results, evidence, issues and exclusions preserve source provenance. Confidence 1.0 expresses reproducible arithmetic only, not certainty about inferred business meaning.

Unknown actions, tables, empty selections and forged plan IDs are rejected. JSON serialization rejects NaN/Infinity. UI formatting does not recalculate analytical results.

## Gemini

Input: objective plus an array of `{evidence_id, finding, method}`. No rows or file bytes. Output: `insights[]` with `interpretation`, `recommendation`, `evidence_ids`. No new numerical claims are accepted by the digit validator. The optional output is separate from Python facts.
