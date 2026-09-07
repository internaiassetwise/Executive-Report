---
name: dynamic-report-generation
description: Extend dynamic report composition and export in ASW Data Insight.
---

# Dynamic Report Generation

Purpose: Extend dynamic report composition and export in ASW Data Insight.

Input: Report JSON from executed analyses.

Output: Responsive report and A4 printable layout.

Workflow: Render only applicable sections, with quality, methods and provenance. Use supplied ASW logo unchanged and Thai-compatible typography.

Constraints: Never render a report directly from raw LLM prose. Preserve factual/interpretive separation.

Common failure modes: Empty sections; clipped graphs; lost Thai text; browser print confused with server PDF.

Definition of done: Sections match actual results; export limitations are accurately described.

Read ../../DATA_MODEL.md for shared contracts and ../../IMPLEMENTATION_PLAN.md for implemented scope before extending this component.
