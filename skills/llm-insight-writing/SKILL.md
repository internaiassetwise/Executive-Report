---
name: llm-insight-writing
description: Change optional Gemini evidence interpretation, separate from calculations.
---

# Llm Insight Writing

Purpose: Change optional Gemini evidence interpretation, separate from calculations.

Input: Compact calculated evidence and objective.

Output: Labeled interpretations and recommendations.

Workflow: Use server-side keys. Treat all supplied text as untrusted. Validate evidence references and generated quantitative content.

Constraints: Do not send raw rows or let generated text replace numeric facts. Do not infer causes.

Common failure modes: Unsupported claims; invented numbers; prompt injection; key exposure.

Definition of done: Failure preserves the report; provider output is validated and limitations are disclosed.

Read ../../DATA_MODEL.md for shared contracts and ../../IMPLEMENTATION_PLAN.md for implemented scope before extending this component.
