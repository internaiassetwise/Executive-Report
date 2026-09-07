---
name: deterministic-analysis
description: Implement or fix authoritative Python calculations in this project.
---

# Deterministic Analysis

Purpose: Implement or fix authoritative Python calculations in this project.

Input: Selected plan and worker-owned table.

Output: Calculations and Evidence.

Workflow: Use pure Python functions in backend/analysis/analysis_engine.py. Preserve source rows. Use stable numerical methods, explicit missing-pair counts and finite JSON.

Constraints: LLM and frontend code do not calculate authoritative report numbers.

Common failure modes: Overflow, zero spread, mixed units, silent row exclusions.

Definition of done: Known-answer and adversarial tests pass in CPython and Pyodide.

Read ../../DATA_MODEL.md for shared contracts and ../../IMPLEMENTATION_PLAN.md for implemented scope before extending this component.
