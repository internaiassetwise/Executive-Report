"""BOQ benchmark-comparison report for an uploaded workbook.

CLI: boq.py <input> <filename> <output.html>
Runs the existing comparison engine (backend/analysis/boq_engine.py) and A4
renderer (boq_report.py) on the original upload while it still exists. Writes
the report HTML and prints one JSON line: {"result": {"mode": "boq"|"none", ...}}.
Every figure and sentence comes from the deterministic engine; no model is called.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "analysis"))


def build(input_path, filename, output_path):
    import analysis_engine
    import boq_engine
    import boq_report
    raw = Path(input_path).read_bytes()
    sheets = analysis_engine.load_sheets(raw, filename)
    report = boq_engine.build_many([(sheets, filename)])
    if report is None:
        return {"mode": "none"}
    Path(output_path).write_text(boq_report.render(report), encoding="utf-8")
    executive = report.get("executive") or {}
    return {"mode": "boq", "vendors": [v["vendor"] for v in report["vendors"]],
            "benchmark": report["vendors"][0].get("benchmark"), "tolerance": report.get("tolerance"),
            "headline": executive.get("headline", "")}


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) != 4:
        print(json.dumps({"error": {"code": "INVALID_REQUEST", "message": "คำสั่งไม่ถูกต้อง"}}, ensure_ascii=False))
        return 1
    try:
        result = build(*sys.argv[1:])
    except Exception:
        # Not every workbook is a BOQ; an unreadable layout simply means no BOQ report.
        result = {"mode": "none"}
    print(json.dumps({"result": result}, ensure_ascii=False, allow_nan=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
