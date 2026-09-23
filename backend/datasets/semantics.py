"""Column meaning from names AND stored values.

Each profiled column gains:
  semantic_type: integer | decimal | date | datetime | boolean | category | text | identifier | mixed | empty
  role:          measure | dimension | time | identifier | attribute
  meaning:       money | quantity | percent | score | None   (a hint, never used to invent units)
  time_format:   iso | year_month   (time columns only; controls bucketing and range filters)

Names alone never decide a role: a column called "amount" that holds text stays text.
"""
from __future__ import annotations

import re

MONEY = re.compile(r"revenue|sales|amount|price|cost|total|profit|income|expense|budget|value|fee|salary|payment|ยอด|ราคา|เงิน|รายได้|ต้นทุน|ค่าใช้จ่าย|กำไร|งบ|มูลค่า|บาท|\bthb\b|\busd\b", re.I)
QUANTITY = re.compile(r"\bqty\b|quantity|\bunits?\b|\bcount\b|orders?|จำนวน|ชิ้น|หน่วย", re.I)
PERCENT = re.compile(r"percent|\bpct\b|%|\brate\b|ratio|ร้อยละ|อัตรา|สัดส่วน", re.I)
SCORE = re.compile(r"score|rating|คะแนน", re.I)
YEAR_MONTH = re.compile(r"\d{4}-(?:0[1-9]|1[0-2])")
CATEGORY_MAX_UNIQUE = 200


def _meaning(name, values):
    if PERCENT.search(name):
        return "percent"
    if SCORE.search(name):
        return "score"
    if MONEY.search(name):
        return "money"
    if QUANTITY.search(name) and values and all(float(v).is_integer() and v >= 0 for v in values[:5000]):
        return "quantity"
    return None


def annotate(profile, numeric, dates, counters, is_identifier):
    """Add semantic fields in place. `is_identifier(column, numeric_values, rows)` is the analyzer rule."""
    rows = profile["rows_count"]
    for index, column in enumerate(profile["columns"]):
        present = rows - column["missing_count"]
        values = numeric[index]
        kind, role, meaning, time_format = "mixed", "attribute", None, None
        if not present:
            kind = "empty"
        elif column["data_type"] == "boolean":
            kind, role = "boolean", "dimension"
        elif dates[index] and len(dates[index]) / present >= .8:
            kind = "datetime" if any("T" in raw for _, raw in dates[index][:200]) else "date"
            role, time_format = "time", "iso"
        elif column["data_type"] == "text" and all(value[0] == "text" and YEAR_MONTH.fullmatch(str(value[1])) for value in counters[index]):
            kind, role, time_format = "date", "time", "year_month"
        elif values and len(values) / present >= .8:
            kind = "integer" if all(float(v).is_integer() for v in values) else "decimal"
            if is_identifier(column, values, rows):
                kind, role = "identifier", "identifier"
            else:
                role, meaning = "measure", _meaning(column["name"], values)
        elif column["data_type"] in ("text", "mixed"):
            unique = column["unique_count"]
            if unique == present and present >= 20:
                kind, role = "identifier", "identifier"
            elif unique <= CATEGORY_MAX_UNIQUE and (unique <= 20 or unique <= present * .5):
                kind, role = "category", "dimension"
            else:
                kind = "text"
        column["semantic_type"], column["role"], column["meaning"] = kind, role, meaning
        if time_format:
            column["time_format"] = time_format
    return profile
