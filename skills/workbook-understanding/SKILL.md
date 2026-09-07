---
name: workbook-understanding
description: Inspect workbook structure and improve generic table detection in this project.
---

# Workbook Understanding

Purpose: Inspect workbook structure and improve generic table detection in this project.

Input: Workbook bytes and filename.

Output: WorkbookProfile and table regions.

Workflow: Inspect actual cells, merged ranges, hidden data and formula caches. Score headers using values and type contrast. Retain sparse records and header-defined empty columns. Verify sheet coordinates.

Constraints: Never mutate the source or infer one sheet equals one table. Never execute cell text.

Common failure modes: Sparse-tail loss; header promotion; styled empty tails; unresolved subtotals.

Definition of done: All detected/excluded regions are explained and structural regression fixtures pass.

Read ../../DATA_MODEL.md for shared contracts and ../../IMPLEMENTATION_PLAN.md for implemented scope before extending this component.
