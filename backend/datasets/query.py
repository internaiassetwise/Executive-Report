"""Questions the analysis agent asks of the stored data.

The model never writes SQL: it sends small query specs (aggregate a column,
group by up to two columns, filter, sort) and this module computes them over
every stored row, the same way dashboards are computed. Summary lines (totals,
VAT) are left out. Each result carries its trace: sheet, range, rows counted.

payload: {"profiles": [...], "queries": [{"id", "sheet_id", "measure": key | null,
          "agg", "group_by": [key, ...], "grain", "filters": [...], "sort", "limit"}]}
Filters use the dashboard format: {"column", "values": [...]} | {"column", "from", "to"}
| {"column", "min", "max"}.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from dashboard import GRAINS, KEY, _aggregate, _bucket, _default_grain, _fail, _finite, _text, _where, filter_clause

AGGS = ("count", "count_distinct", "sum", "avg", "min", "max")
NUMERIC_AGGS = ("sum", "avg", "min", "max")
MAX_QUERIES, MAX_ROWS = 12, 50


def _column(columns, key, what):
    if not isinstance(key, str) or not KEY.fullmatch(key) or key not in columns:
        _fail("INVALID_QUERY", f"คำถามอ้างอิง{what}ที่ไม่มีอยู่")
    return columns[key]


def one(connection, sheets, profiles, query):
    if not isinstance(query, dict):
        _fail("INVALID_QUERY", "รูปแบบคำถามไม่ถูกต้อง")
    profile = profiles.get(query.get("sheet_id"))
    sheet = sheets.get(query.get("sheet_id"))
    if not profile or not sheet:
        _fail("INVALID_QUERY", "คำถามอ้างอิงตารางที่ไม่มีอยู่")
    columns = {column["key"]: column for column in profile["columns"]}
    agg = query.get("agg")
    if agg not in AGGS:
        _fail("INVALID_QUERY", "วิธีคำนวณไม่ถูกต้อง")
    measure = query.get("measure")
    if measure is None:
        if agg != "count":
            _fail("INVALID_QUERY", "วิธีคำนวณนี้ต้องระบุคอลัมน์")
    else:
        column = _column(columns, measure, "คอลัมน์")
        if agg in NUMERIC_AGGS and column.get("role") != "measure" and column.get("data_type") not in ("number", "mixed"):
            _fail("INVALID_QUERY", f"คอลัมน์ {column['name']} ไม่ใช่ตัวเลข")
    group_by = query.get("group_by") or []
    if not isinstance(group_by, list) or len(group_by) > 2:
        _fail("INVALID_QUERY", "จัดกลุ่มได้ไม่เกิน 2 คอลัมน์")
    groups = [_column(columns, key, "คอลัมน์จัดกลุ่ม") for key in group_by]
    if len({column["key"] for column in groups}) != len(groups):
        _fail("INVALID_QUERY", "คอลัมน์จัดกลุ่มซ้ำกัน")
    limit = query.get("limit") or 15
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_ROWS:
        limit = 15
    sort = query.get("sort") if query.get("sort") in ("desc", "asc", "label") else "desc"

    summary = [int(row) for row in sheet.get("summary_rows", [])]
    table = f'(SELECT * FROM "data_{sheet["id"]}"' + (f" WHERE row_number NOT IN ({', '.join(map(str, summary))})" if summary else "") + ")"
    where, params = filter_clause(columns, query.get("filters") or [])
    value_sql = _aggregate(agg, measure)
    matched = connection.execute(f"SELECT COUNT(*) FROM {table}{_where(where)}", params).fetchone()[0]
    overall = _finite(connection.execute(f"SELECT {value_sql} FROM {table}{_where(where)}", params).fetchone()[0])
    result = {"id": query.get("id"), "ok": True, "sheet_id": sheet["id"], "agg": agg, "measure": measure,
              "measure_name": columns[measure]["name"] if measure else None, "group_by": group_by,
              "group_names": [column["name"] for column in groups], "value": overall, "matched": matched,
              "excluded_summary_rows": len(summary), "rows": [], "groups_total": 0, "truncated": False,
              "trace": {"sheet": sheet.get("source_sheet") or sheet["name"], "table": sheet["name"],
                        "range": (sheet.get("area") or {}).get("ref")}}
    if not groups:
        return result
    expressions, grain = [], None
    for column in groups:
        if column.get("role") == "time" or column.get("data_type") == "date":
            grain = query.get("grain") if query.get("grain") in GRAINS else _default_grain(connection, table, column, _where(where), params)
            expressions.append(_bucket(column, grain))
        else:
            expressions.append(_text(column["key"]))
    labels = ", ".join(f"{expression} AS g{index}" for index, expression in enumerate(expressions))
    present = " AND ".join(f"{expression} IS NOT NULL" for expression in expressions)
    grouping = ", ".join(f"g{index}" for index in range(len(expressions)))
    order = {"desc": "v DESC", "asc": "v ASC", "label": grouping}[sort]
    # Groups with no numbers at all (section headings, notes) are not ranked as zero.
    body = f"FROM {table}{_where(where, present)} GROUP BY {grouping} HAVING v IS NOT NULL"
    result["groups_total"] = connection.execute(f"SELECT COUNT(*) FROM (SELECT {labels}, {value_sql} AS v {body})", params).fetchone()[0]
    rows = connection.execute(f"SELECT {labels}, {value_sql} AS v {body} ORDER BY {order}, {grouping} LIMIT ?", [*params, limit]).fetchall()
    # Shares only mean something for totals and counts over the same filtered rows.
    share_base = overall if agg in ("sum", "count") and overall else None
    result["rows"] = [{"keys": list(row[:-1]), "value": _finite(row[-1]),
                       "share": _finite(row[-1]) / share_base * 100 if share_base and _finite(row[-1]) is not None else None} for row in rows]
    result["truncated"] = result["groups_total"] > len(rows)
    result["grain"] = grain
    return result


def run(sqlite_path, payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("profiles"), list) or not isinstance(payload.get("queries"), list):
        _fail("INVALID_REQUEST", "รูปแบบคำขอคำนวณไม่ถูกต้อง")
    if not Path(sqlite_path).is_file():
        _fail("NOT_FOUND", "ไม่พบชุดข้อมูลนี้ กรุณาอัปโหลดใหม่")
    profiles = {profile["sheet_id"]: profile for profile in payload["profiles"] if isinstance(profile, dict)}
    connection = sqlite3.connect(Path(sqlite_path).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        metadata = json.loads(connection.execute("SELECT value FROM metadata WHERE key='dataset'").fetchone()[0])
        sheets = {sheet["id"]: sheet for sheet in metadata["sheets"]}
        results = []
        for query in payload["queries"][:MAX_QUERIES]:
            try:
                results.append(one(connection, sheets, profiles, query))
            except Exception as error:  # one bad question never sinks the others
                message = getattr(error, "message", None) or "คำนวณคำถามนี้ไม่สำเร็จ"
                results.append({"id": query.get("id") if isinstance(query, dict) else None, "ok": False, "error": message})
        json.dumps(results, ensure_ascii=False, allow_nan=False)
        return {"results": results}
    finally:
        connection.close()
