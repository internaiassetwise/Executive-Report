---
name: report-validation
description: Validate evidence and report integrity for the analysis workspace.
---

# Report Validation

Purpose: Validate evidence and report integrity for the analysis workspace.

Input: Report JSON and source calculations.

Output: Validation findings and targeted regressions.

Workflow: Check every result/evidence link, finite number, range, selection and sample count. Exercise different table shapes and sparse inputs.

Constraints: Do not claim statistical validity, provider validation or PDF rendering checks that were not run.

Common failure modes: Dangling evidence; mismatched scope; hidden exclusions; unverifiable narrative claims.

Definition of done: Numerical/structural tests pass and remaining validation gaps are recorded.

Read ../../DATA_MODEL.md for shared contracts and ../../IMPLEMENTATION_PLAN.md for implemented scope before extending this component.
