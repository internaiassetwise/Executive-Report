---
name: boq-comparison
description: Change the multi-vendor benchmark-comparison report path for BOQ workbooks in this project.
---

# BOQ Comparison

Purpose: Change the multi-vendor benchmark-comparison report path for BOQ workbooks in this project.

Input: One or more uploaded workbooks, each loaded as sheets with grids.

Output: Per-vendor anomaly counts, weighted rate deviations and normalized savings by group; cross-vendor matrices, signature patterns, strategy statements and an executive summary; a scope reconciliation. Code: `backend/analysis/boq_engine.py` (`build_many`) and `backend/analysis/boq_report.py` (`render`). Upload flow: the worker (`frontend/public/analysis-worker.js`) installs both modules on the Pyodide FS and calls `dispatch('boq', {files})`, which reads every upload once, keeps the sheets in `BOQ_BOOKS`, and either returns the report with rendered HTML or, for a single non-BOQ workbook, falls through to the generic profile on the same sheets; `dispatch('boq_rebuild', {tolerance})` re-aggregates without re-reading. `frontend/components/boq-view.tsx` renders the overview (tolerance input), summary and the report in an iframe.

Workflow: Detect every vendor a workbook contains, three ways: one vendor per workbook when proposal columns name nobody; several vendors side by side when proposal columns carry names ('ปริมาณ KMIT เสนอ', 'ปริมาณ WGE เสนอ'); one sheet per vendor when unlabelled sheets quote the same benchmark lines position for position — and only when that match covers every sheet under the same category prefix, because two buildings can share a benchmark template as closely as two vendors do. Match columns by header text, never by position: an axis word (ปริมาณ / ค่าของ / ค่าแรง) plus a role word (ราคากลาง, RBP, DPP → benchmark; หลังปรับ, ที่ใช้คำนวณ → normalized; neither → proposal). Ignore derived columns (ส่วนต่าง, เท่า, %, Flag). Read the vendor and benchmark names from headers, then from labelled cells (ผู้รับเหมา:, ราคาที่…เสนอ), then the filename. Classify every row as comparable, out of scope or not quoted; treat an unpriced row carrying a proposal or normalized total, or a row with no category where a category column exists, as a heading and exclude it. Skip sheets named as summaries or analyses. Compare quantity, material rate and labour rate as three independent axes; flag deviations above one report-wide tolerance (declared, else the strictest the files were normalized at, else 15%); normalize one-directionally by substituting the benchmark into flagged cells and rescaling that row's stated total. Weight rate deviations by benchmark quantity. Set aside rows whose rate exceeds the benchmark by more than 20× as unit mismatches: count and disclose them, but neither weight nor normalize them. Group by the `{CATEGORY}_{UNIT}` sheet convention, else by the category column, else by sheet. Render sections only when their data exists — the cross-vendor comparison needs two or more vendors.

Constraints: Every figure comes from the uploaded workbooks alone; never carry in a project name, bidder name, category label or amount from anywhere else. Narrative bullets are composed by rule from computed figures; Gemini commentary stays in the separate `report.ai` block and may quote only numbers present in its evidence. This path knowingly departs from the generic engine's rule that tables are never joined or summed across sheets; keep that rule intact in `analysis_engine.py`.

Common failure modes: Double counting from summary sheets and heading rows; a difference column read as a line total; fixed column indices across sheets of differing widths; averaging per-row ratios instead of weighting by value; lump-sum rows priced at zero because they carry no unit rate; a LOT price against a per-unit rate producing a several-hundred-percent deviation; an inferred tolerance overshooting the stated one; a benchmark-only total mistaken for a heading, which drops every unquoted line.

Tests: `backend/tests/test_boq.py` covers all three detection cases and the dispatch actions; `frontend/tests/pyodide-smoke.mjs` runs the side-by-side case in the browser runtime.

Definition of done: Group and grand totals reconcile against each workbook's own stated totals, or the difference is printed on the report with its cause; the three reference files produce sane figures without file-specific branches.

Read ../../DATA_MODEL.md for shared contracts and ../../IMPLEMENTATION_PLAN.md for implemented scope before extending this component.
