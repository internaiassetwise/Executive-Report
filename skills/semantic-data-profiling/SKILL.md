---
name: semantic-data-profiling
description: Improve value-based column profiling and role inference in ASW Data Insight.
---

# Semantic Data Profiling

Purpose: Improve value-based column profiling and role inference in ASW Data Insight.

Input: Detected table and original values.

Output: ColumnProfile and DatasetUnderstanding.

Workflow: Use types, normalized values, samples, uniqueness and names together. Preserve leading-zero IDs. Distinguish percentages from additive measures.

Constraints: Do not infer business domain as an execution rule. Ambiguous dates and separators stay unresolved.

Common failure modes: Numeric IDs become measures; raw string uniqueness differs from numeric uniqueness.

Definition of done: Roles, warnings, valid sample counts and statistics agree with the fixtures.

Read ../../DATA_MODEL.md for shared contracts and ../../IMPLEMENTATION_PLAN.md for implemented scope before extending this component.
