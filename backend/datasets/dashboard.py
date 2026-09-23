"""Dashboard specification: validation, rule-based plan and filtered queries.

The AI (or the rule-based fallback) only proposes a *specification*: which
columns, aggregations and chart types to show. This module is the single
validator for that specification and the only place that computes the numbers
shown on a dashboard, always from the stored SQLite rows.

Spec (version 1):
  {version, source: ai|rules, title, description, sheet_id,
   kpis:    [{id, label, column|null, agg}],
   charts:  [{id, type, title, x, y|null, agg|null, grain|null, limit}],
   filters: [{id, column, kind: category|date|number}]}
"""
from __future__ import annotations

import json
import math
import re
import sqlite3
from pathlib import Path

VERSION = 1
CHART_TYPES = ("line", "area", "bar", "hbar", "donut", "treemap", "histogram", "scatter")
KPI_AGGS = ("count", "count_distinct", "sum", "avg", "min", "max", "median")
CHART_AGGS = ("count", "sum", "avg", "min", "max")
GRAINS = ("day", "week", "month", "quarter", "year")
MAX_KPIS, MAX_CHARTS, MAX_FILTERS = 6, 8, 5
MAX_TIME_POINTS, SCATTER_POINTS, OPTION_VALUES = 400, 500, 200
KEY = re.compile(r"c\d{1,4}\Z")
DAY = re.compile(r"\d{4}-\d{2}-\d{2}\Z")
AGG_LABELS = {"count": "จำนวน", "count_distinct": "จำนวนที่ไม่ซ้ำของ", "sum": "ผลรวม", "avg": "ค่าเฉลี่ย", "min": "ต่ำสุด", "max": "สูงสุด", "median": "มัธยฐาน"}
CATEGORY_CHARTS = ("bar", "hbar", "donut", "treemap")


def _fail(code, message):
    from worker import fail
    fail(code, message)


def _label(value, limit):
    if not isinstance(value, str):
        return ""
    text = re.sub(r"[\x00-\x1f\x7f‪-‮⁦-⁩]", " ", value)
    return re.sub(r"\s+", " ", text).strip()[:limit]


def _finite(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


# ---------------------------------------------------------------- validation

def validate(spec, profiles):
    """Return a normalised spec or raise INVALID_SPEC. Every rule the renderer relies on lives here.
    An AI plan keeps its valid items and drops the rest; a rule-based plan must be entirely valid."""
    from worker import DatasetError
    if not isinstance(spec, dict):
        _fail("INVALID_SPEC", "รูปแบบ Dashboard ไม่ถูกต้อง")
    profile = next((p for p in profiles if p["sheet_id"] == spec.get("sheet_id")), None)
    if profile is None:
        _fail("INVALID_SPEC", "Dashboard อ้างอิงชีตที่ไม่มีอยู่")
    columns = {column["key"]: column for column in profile["columns"]}
    lenient = spec.get("source") == "ai"

    def column(key, roles, optional=False):
        if key is None and optional:
            return None
        if not isinstance(key, str) or not KEY.fullmatch(key) or key not in columns:
            _fail("INVALID_SPEC", "Dashboard อ้างอิงคอลัมน์ที่ไม่มีอยู่")
        if columns[key].get("role") not in roles:
            _fail("INVALID_SPEC", f"คอลัมน์ {columns[key]['name']} ไม่เหมาะกับการใช้งานนี้")
        return key

    def collect(name, limit, build):
        value = spec.get(name) or []
        if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
            _fail("INVALID_SPEC", "รูปแบบ Dashboard ไม่ถูกต้อง")
        built, seen = [], set()
        for item in value[:limit]:
            try:
                entry = build(item)
            except DatasetError:
                if not lenient:
                    raise
                continue
            signature = entry.pop("signature")
            if signature not in seen:
                seen.add(signature)
                built.append(entry)
        return built

    def kpi(item):
        agg = item.get("agg")
        if agg not in KPI_AGGS:
            _fail("INVALID_SPEC", "วิธีรวมค่าของ KPI ไม่ถูกต้อง")
        if agg == "count":
            key = column(item.get("column"), ("measure", "dimension", "time", "identifier", "attribute"), optional=True)
        elif agg == "count_distinct":
            key = column(item.get("column"), ("dimension", "identifier", "attribute", "time"))
        else:
            key = column(item.get("column"), ("measure",))
        default = "จำนวนรายการ" if key is None else f"{AGG_LABELS[agg]} {columns[key]['name']}"
        return {"signature": (agg, key), "label": _label(item.get("label"), 80) or default, "column": key, "agg": agg}

    def chart(item):
        kind = item.get("type")
        if kind not in CHART_TYPES:
            _fail("INVALID_SPEC", "ชนิดกราฟไม่รองรับ")
        agg, grain, limit = item.get("agg"), None, None
        if kind in ("line", "area"):
            x = column(item.get("x"), ("time",))
            y = column(item.get("y"), ("measure",), optional=True)
            grain = item.get("grain") if item.get("grain") in GRAINS else None
            if columns[x].get("time_format") == "year_month" and grain in ("day", "week"):
                grain = "month"
        elif kind in CATEGORY_CHARTS:
            x = column(item.get("x"), ("dimension",) if kind in ("donut", "treemap") else ("dimension", "attribute"))
            y = column(item.get("y"), ("measure",), optional=True)
            limit = item.get("limit") if isinstance(item.get("limit"), int) and not isinstance(item.get("limit"), bool) else 12
            limit = max(3, min(8 if kind == "donut" else 30, limit))
        elif kind == "histogram":
            x, y, agg = column(item.get("x"), ("measure",)), None, "count"
        else:
            x, y, agg = column(item.get("x"), ("measure",)), column(item.get("y"), ("measure",)), None
            if x == y:
                _fail("INVALID_SPEC", "กราฟความสัมพันธ์ต้องใช้สองคอลัมน์ที่ต่างกัน")
        if kind not in ("histogram", "scatter"):
            if y is None:
                agg = "count"
            elif agg not in CHART_AGGS or agg == "count":
                agg = "sum" if columns[y].get("meaning") in ("money", "quantity") else "avg"
        return {"signature": (kind, x, y, agg), "type": kind, "title": _label(item.get("title"), 120) or _chart_title(kind, columns, x, y, agg),
                "x": x, "y": y, "agg": agg, "grain": grain, "limit": limit}

    kinds = {"dimension": "category", "time": "date", "measure": "number"}

    def filter_item(item):
        key = column(item.get("column"), tuple(kinds))
        return {"signature": key, "column": key, "kind": kinds[columns[key]["role"]]}

    kpis = [{"id": f"k{index}", **entry} for index, entry in enumerate(collect("kpis", MAX_KPIS, kpi), 1)]
    charts = [{"id": f"c{index}", **entry} for index, entry in enumerate(collect("charts", MAX_CHARTS, chart), 1)]
    filters = [{"id": f"f{index}", **entry} for index, entry in enumerate(collect("filters", MAX_FILTERS, filter_item), 1)]
    if not kpis and not charts:
        _fail("INVALID_SPEC", "Dashboard ต้องมี KPI หรือกราฟอย่างน้อยหนึ่งรายการ")
    return {"version": VERSION, "source": "ai" if lenient else "rules", "sheet_id": profile["sheet_id"],
            "title": _label(spec.get("title"), 120) or f"Dashboard · {profile['sheet_name']}",
            "description": _label(spec.get("description"), 400), "kpis": kpis, "charts": charts, "filters": filters}


def _chart_title(kind, columns, x, y, agg):
    name = columns[x]["name"]
    if kind == "histogram":
        return f"การกระจายของ {name}"
    if kind == "scatter":
        return f"{name} กับ {columns[y]['name']}"
    measure = "จำนวนแถว" if y is None else f"{AGG_LABELS[agg]} {columns[y]['name']}"
    return f"{measure} ตามช่วงเวลา" if kind in ("line", "area") else f"{measure} ตาม {name}"


# ------------------------------------------------------------- rule-based plan

SUMMARY_SHEET = re.compile(r"summary|สรุป|overview|dashboard|ภาพรวม", re.I)


def plan(profiles, filename="", sheet_id=None):
    """Deterministic dashboard used when AI is off, over budget or returns an invalid spec,
    and for any sheet the user picks later. `sheet_id` forces the sheet."""
    def score(profile):
        roles = [column.get("role") for column in profile["columns"]]
        # A summary sheet is what a reader wants first, even when detail sheets are longer.
        return ("measure" in roles, bool(SUMMARY_SHEET.search(profile["sheet_name"])), "dimension" in roles or "time" in roles or "attribute" in roles, profile["rows_count"])
    candidates = [p for p in profiles if p["sheet_id"] == sheet_id] if sheet_id else profiles
    if not candidates:
        _fail("INVALID_SPEC", "ไม่พบชีตที่เลือก")
    profile = max(candidates, key=score)
    columns = profile["columns"]
    # Amounts that add up come first; per-unit prices are averaged and shown last.
    rank = {"money": 0, "quantity": 1, None: 2, "score": 3, "percent": 3, "price": 4}
    measures = sorted((c for c in columns if c.get("role") == "measure"), key=lambda c: (rank.get(c.get("meaning"), 2), c["missing_count"]))
    dimensions = sorted((c for c in columns if c.get("role") == "dimension" and c["unique_count"] > 1), key=lambda c: (c["unique_count"] > 12, c["missing_count"], c["unique_count"]))
    times = [c for c in columns if c.get("role") == "time"]
    labels = sorted((c for c in columns if c.get("role") == "attribute" and c.get("semantic_type") == "text" and c["unique_count"] > 12), key=lambda c: c["missing_count"])
    agg = lambda measure: "sum" if measure.get("meaning") in ("money", "quantity") else "avg"
    main = measures[0] if measures else None
    second = next((m for m in measures[1:] if m.get("meaning") == main.get("meaning")), None) if main else None

    kpis = [{"column": None, "agg": "count", "label": "จำนวนรายการ"}]
    kpis += [{"column": m["key"], "agg": agg(m)} for m in measures[:4]]
    if len(kpis) < 5 and dimensions:
        kpis.append({"column": dimensions[0]["key"], "agg": "count_distinct"})

    charts = []
    if times:
        charts.append({"type": "area" if main and agg(main) == "sum" else "line", "x": times[0]["key"], "y": main and main["key"], "agg": main and agg(main)})
    if main and labels:
        # Ranked items: the clearest view of a summary table or a long item list.
        charts.append({"type": "hbar", "x": labels[0]["key"], "y": main["key"], "agg": agg(main), "limit": 15})
    for dimension in dimensions[:2]:
        charts.append({"type": "bar", "x": dimension["key"], "y": main and main["key"], "agg": main and agg(main), "limit": 12})
    # A share chart only adds information for a dimension the bars do not already show.
    small = next((d for d in dimensions[2:] if d["unique_count"] <= 8), None) or (dimensions[0] if len(dimensions) == 1 and dimensions[0]["unique_count"] <= 8 and labels else None)
    if small:
        share = main and agg(main) == "sum"
        charts.append({"type": "donut", "x": small["key"], "y": main["key"] if share else None, "agg": "sum" if share else "count"})
    if second and labels:
        charts.append({"type": "hbar", "x": labels[0]["key"], "y": second["key"], "agg": agg(second), "limit": 15})
    if main and profile["rows_count"] >= 30 and not labels:
        charts.append({"type": "histogram", "x": main["key"]})
    measure_keys = {m["key"] for m in measures}
    pair = next((c for c in profile.get("correlations", []) if abs(c["value"]) >= .3 and {c["x"], c["y"]} <= measure_keys), None)
    if pair:
        charts.append({"type": "scatter", "x": pair["x"], "y": pair["y"]})

    filters = [{"column": times[0]["key"]}] if times else []
    filters += [{"column": d["key"]} for d in dimensions[:3]]
    subject = Path(filename).stem if filename and len(profiles) == 1 else profile["sheet_name"]
    return validate({"source": "rules", "sheet_id": profile["sheet_id"], "title": f"ภาพรวมข้อมูล {subject}",
                     "kpis": kpis, "charts": charts, "filters": filters}, profiles)


# ------------------------------------------------------------------- queries

def _numeric(key):
    return f"(CASE WHEN json_type(data, '$.{key}') IN ('integer', 'real') THEN json_extract(data, '$.{key}') END)"


def _text(key):
    # One text form per stored value so filters, grouping and options agree.
    return (f"(CASE json_type(data, '$.{key}') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' "
            f"WHEN 'text' THEN json_extract(data, '$.{key}') WHEN 'integer' THEN CAST(json_extract(data, '$.{key}') AS TEXT) "
            f"WHEN 'real' THEN CAST(json_extract(data, '$.{key}') AS TEXT) END)")


def _time(column):
    width = 7 if column.get("time_format") == "year_month" else 10
    return f"(CASE WHEN json_type(data, '$.{column['key']}') = 'text' THEN substr(json_extract(data, '$.{column['key']}'), 1, {width}) END)"


def _bucket(column, grain):
    value = _time(column)
    return {"day": value, "month": f"substr({value}, 1, 7)", "year": f"substr({value}, 1, 4)",
            "quarter": f"(substr({value}, 1, 4) || '-Q' || ((CAST(substr({value}, 6, 2) AS INTEGER) + 2) / 3))",
            "week": f"strftime('%Y-W%W', {value})"}[grain]


def _aggregate(agg, key):
    if key is None:
        return "COUNT(*)"
    value = _numeric(key)
    return {"count": f"COUNT(json_extract(data, '$.{key}'))", "count_distinct": f"COUNT(DISTINCT {_text(key)})",
            "sum": f"(CASE WHEN COUNT({value}) THEN TOTAL({value}) END)", "avg": f"AVG({value})", "min": f"MIN({value})", "max": f"MAX({value})"}[agg]


def filter_clause(columns, filters, allowed=None):
    """SQL WHERE fragment + parameters. `columns` maps key -> column; values are always bound parameters."""
    if filters in (None, []):
        return "", []
    if not isinstance(filters, list) or len(filters) > 12:
        _fail("INVALID_FILTER", "รูปแบบตัวกรองไม่ถูกต้อง")
    clauses, params = [], []
    for item in filters:
        key = item.get("column") if isinstance(item, dict) else None
        column = columns.get(key) if isinstance(key, str) and KEY.fullmatch(key) else None
        if column is None or (allowed is not None and key not in allowed):
            _fail("INVALID_FILTER", "ตัวกรองอ้างอิงคอลัมน์ที่ไม่มีอยู่")
        if "values" in item:
            values = item["values"]
            if not isinstance(values, list) or not 1 <= len(values) <= OPTION_VALUES or not all(isinstance(v, str) and len(v) <= 500 for v in values):
                _fail("INVALID_FILTER", "ค่าที่เลือกในตัวกรองไม่ถูกต้อง")
            clauses.append(f"{_text(key)} IN ({', '.join('?' * len(values))})")
            params.extend(values)
        elif "from" in item or "to" in item:
            if column.get("role") != "time" and column.get("data_type") != "date":
                _fail("INVALID_FILTER", "ช่วงวันที่ใช้ได้กับคอลัมน์วันที่เท่านั้น")
            width = 7 if column.get("time_format") == "year_month" else 10
            for field, operator in (("from", ">="), ("to", "<=")):
                value = item.get(field)
                if value in (None, ""):
                    continue
                if not isinstance(value, str) or not DAY.fullmatch(value):
                    _fail("INVALID_FILTER", "วันที่ในตัวกรองต้องอยู่ในรูปแบบ YYYY-MM-DD")
                clauses.append(f"{_time(column)} {operator} ?")
                params.append(value[:width])
        elif "min" in item or "max" in item:
            for field, operator in (("min", ">="), ("max", "<=")):
                value = item.get(field)
                if value is None:
                    continue
                if _finite(value) is None:
                    _fail("INVALID_FILTER", "ช่วงตัวเลขในตัวกรองไม่ถูกต้อง")
                clauses.append(f"{_numeric(key)} {operator} ?")
                params.append(value)
        else:
            _fail("INVALID_FILTER", "รูปแบบตัวกรองไม่ถูกต้อง")
    return " AND ".join(clauses), params


def _where(*parts):
    parts = [part for part in parts if part]
    return f" WHERE {' AND '.join(parts)}" if parts else ""


def _default_grain(connection, table, column, where, params):
    low, high = connection.execute(f"SELECT MIN({_time(column)}), MAX({_time(column)}) FROM {table}{where}", params).fetchone()
    if column.get("time_format") == "year_month":
        return "month"
    if not low or not high or not DAY.fullmatch(low) or not DAY.fullmatch(high):
        return "month"
    from datetime import date
    days = (date.fromisoformat(high) - date.fromisoformat(low)).days
    return "day" if days <= 92 else "month" if days <= 3 * 366 else "quarter" if days <= 8 * 366 else "year"


def _chart(connection, table, columns, chart, where, params):
    from analyzer import fmt
    x = columns[chart["x"]]
    if chart["type"] in ("line", "area"):
        grain = chart["grain"] or _default_grain(connection, table, x, _where(where), params)
        order = GRAINS[GRAINS.index(grain):]
        for grain in order:
            bucket = _bucket(x, grain)
            rows = connection.execute(f"SELECT {bucket} AS b, {_aggregate(chart['agg'], chart['y'])} FROM {table}{_where(where, f'{bucket} IS NOT NULL')} GROUP BY b ORDER BY b LIMIT ?", [*params, MAX_TIME_POINTS + 1]).fetchall()
            if len(rows) <= MAX_TIME_POINTS:
                break
        return {"grain": grain, "data": [{"x": b, "y": _finite(v)} for b, v in rows if _finite(v) is not None]}
    if chart["type"] in CATEGORY_CHARTS:
        label, value = _text(chart["x"]), _aggregate(chart["agg"], chart["y"])
        scope = _where(where, f"{label} IS NOT NULL")
        rows = connection.execute(f"SELECT {label} AS g, {value} AS v FROM {table}{scope} GROUP BY g HAVING v IS NOT NULL ORDER BY v DESC, g ASC LIMIT ?", [*params, chart["limit"]]).fetchall()
        groups = connection.execute(f"SELECT COUNT(DISTINCT {label}) FROM {table}{scope}", params).fetchone()[0]
        result = {"data": [{"x": g, "y": _finite(v)} for g, v in rows if _finite(v) is not None], "groups_total": groups, "others": None}
        if groups > len(rows) and chart["agg"] in ("sum", "count"):
            total = _finite(connection.execute(f"SELECT {value} FROM {table}{scope}", params).fetchone()[0]) or 0
            result["others"] = {"label": f"อื่น ๆ ({groups - len(rows):,} กลุ่ม)", "y": total - sum(point["y"] for point in result["data"])}
        return result
    if chart["type"] == "histogram":
        value = _numeric(chart["x"])
        scope = _where(where, f"{value} IS NOT NULL")
        count, low, high = connection.execute(f"SELECT COUNT(*), MIN({value}), MAX({value}) FROM {table}{scope}", params).fetchone()
        if not count:
            return {"data": []}
        bins = 1 if low == high else max(5, min(20, math.ceil(math.sqrt(count))))
        width = (high - low) / bins or 1
        counts = dict(connection.execute(f"SELECT MIN(CAST(({value} - ?) / ? AS INTEGER), ?) AS b, COUNT(*) FROM {table}{scope} GROUP BY b", [low, width, bins - 1, *params]).fetchall())
        return {"data": [{"x": f"{fmt(low + i * width)} – {fmt(low + (i + 1) * width)}", "y": counts.get(i, 0), "from": low + i * width, "to": low + (i + 1) * width} for i in range(bins)]}
    a, b = _numeric(chart["x"]), _numeric(chart["y"])
    scope = _where(where, f"{a} IS NOT NULL AND {b} IS NOT NULL")
    total = connection.execute(f"SELECT COUNT(*) FROM {table}{scope}", params).fetchone()[0]
    step = max(1, math.ceil(total / SCATTER_POINTS))
    rows = connection.execute(f"SELECT x, y FROM (SELECT {a} AS x, {b} AS y, ROW_NUMBER() OVER (ORDER BY row_number) AS n FROM {table}{scope}) WHERE (n - 1) % ? = 0 LIMIT ?", [*params, step, SCATTER_POINTS]).fetchall()
    return {"data": [{"x": x, "y": y} for x, y in rows], "points_total": total, "sampled": step > 1}


def _kpi(connection, table, kpi, where, params):
    if kpi["agg"] != "median":
        return _finite(connection.execute(f"SELECT {_aggregate(kpi['agg'], kpi['column'])} FROM {table}{_where(where)}", params).fetchone()[0])
    value = _numeric(kpi["column"])
    scope = _where(where, f"{value} IS NOT NULL")
    count = connection.execute(f"SELECT COUNT(*) FROM {table}{scope}", params).fetchone()[0]
    if not count:
        return None
    middle = [row[0] for row in connection.execute(f"SELECT {value} AS v FROM {table}{scope} ORDER BY v LIMIT ? OFFSET ?", [*params, 2 - count % 2, (count - 1) // 2])]
    return _finite(sum(middle) / len(middle))


def _options(connection, table, columns, spec):
    options = {}
    for item in spec["filters"]:
        column = columns[item["column"]]
        if item["kind"] == "category":
            label = _text(column["key"])
            rows = connection.execute(f"SELECT {label} AS g, COUNT(*) FROM {table} WHERE {label} IS NOT NULL GROUP BY g ORDER BY 2 DESC, g LIMIT ?", [OPTION_VALUES]).fetchall()
            total = connection.execute(f"SELECT COUNT(DISTINCT {label}) FROM {table}").fetchone()[0]
            options[item["id"]] = {"values": [{"value": g, "count": n} for g, n in rows], "total": total}
        elif item["kind"] == "date":
            low, high = connection.execute(f"SELECT MIN({_time(column)}), MAX({_time(column)}) FROM {table}").fetchone()
            options[item["id"]] = {"min": low, "max": high}
        else:
            low, high = connection.execute(f"SELECT MIN({_numeric(column['key'])}), MAX({_numeric(column['key'])}) FROM {table}").fetchone()
            options[item["id"]] = {"min": _finite(low), "max": _finite(high)}
    return options


def referenced(spec):
    keys = {item["column"] for item in spec["kpis"] if item["column"]} | {item["column"] for item in spec["filters"]}
    for chart in spec["charts"]:
        keys |= {chart["x"], chart["y"]} - {None}
    return keys


def run(sqlite_path, payload):
    """Validate the spec, apply filters and compute every KPI and chart for one request."""
    if not isinstance(payload, dict) or not isinstance(payload.get("profiles"), list):
        _fail("INVALID_REQUEST", "รูปแบบคำขอ Dashboard ไม่ถูกต้อง")
    if not Path(sqlite_path).is_file():
        _fail("NOT_FOUND", "ไม่พบชุดข้อมูลนี้ กรุณาอัปโหลดใหม่")
    requested = payload.get("sheet_id")
    if requested and requested != (payload.get("spec") or {}).get("sheet_id"):
        # Another sheet: plan it by rules; no AI request is made for sheet switching.
        spec = plan(payload["profiles"], payload.get("filename", ""), requested)
    else:
        spec = validate(payload.get("spec"), payload["profiles"])
    profile = next(p for p in payload["profiles"] if p["sheet_id"] == spec["sheet_id"])
    columns = {column["key"]: column for column in profile["columns"]}
    where, params = filter_clause(columns, payload.get("filters"), referenced(spec))
    connection = sqlite3.connect(Path(sqlite_path).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        metadata = json.loads(connection.execute("SELECT value FROM metadata WHERE key='dataset'").fetchone()[0])
        sheet = next(item for item in metadata["sheets"] if item["id"] == spec["sheet_id"])
        summary = [int(row) for row in sheet.get("summary_rows", [])]
        table = f'"data_{spec["sheet_id"]}"'
        if summary:
            # Subtotal / total / VAT lines would double every sum; the view hides them from all queries.
            connection.execute(f"CREATE TEMP VIEW dashboard_rows AS SELECT * FROM {table} WHERE row_number NOT IN ({', '.join(map(str, summary))})")
            table = "dashboard_rows"
        result = {"spec": spec, "filters": payload.get("filters") or [], "summary_rows_excluded": len(summary),
                  "rows_total": connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0],
                  "rows_matched": connection.execute(f"SELECT COUNT(*) FROM {table}{_where(where)}", params).fetchone()[0],
                  "kpis": [], "charts": []}
        for kpi in spec["kpis"]:
            result["kpis"].append({"id": kpi["id"], "value": _kpi(connection, table, kpi, where, params)})
        for chart in spec["charts"]:
            try:
                result["charts"].append({"id": chart["id"], **_chart(connection, table, columns, chart, where, params)})
            except (sqlite3.Error, ValueError, OverflowError, ZeroDivisionError):
                result["charts"].append({"id": chart["id"], "data": [], "error": "คำนวณกราฟนี้ไม่สำเร็จ"})
        if payload.get("include_options"):
            result["options"] = _options(connection, table, columns, spec)
        json.dumps(result, ensure_ascii=False, allow_nan=False)
        return result
    finally:
        connection.close()
