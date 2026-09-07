---
name: analysis-planning
description: Change valid analysis selection for generic uploaded tables.
---

# Analysis Planning

Purpose: Change valid analysis selection for generic uploaded tables.

Input: Column profiles and quality.

Output: Eligible AnalysisPlan with reasons.

Workflow: Gate each analysis on usable data, sample size and meaningful roles. Default group/time aggregation to a clearly labeled mean.

Constraints: Never add correlation for one measure or time analysis without dates. Additive calculations require unit semantics.

Common failure modes: High-cardinality charts; constant-variable correlations; treating thresholds as significance.

Definition of done: Each enabled plan has a reason; invalid plans are rejected; no domain branches exist.

Read ../../DATA_MODEL.md for shared contracts and ../../IMPLEMENTATION_PLAN.md for implemented scope before extending this component.
