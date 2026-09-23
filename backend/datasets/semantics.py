"""Column meaning from names AND stored values.

Each profiled column gains:
  semantic_type: integer | decimal | date | datetime | boolean | category | text | identifier | mixed | empty
  role:          measure | dimension | time | identifier | attribute
  meaning:       money | price | quantity | percent | score | None   (a hint, never used to invent units)
  time_format:   iso | year_month   (time columns only; controls bucketing and range filters)

Names alone never decide a role: a column called "amount" that holds text stays text.
money = an amount that adds up (totals, differences); price = a per-unit rate that must be averaged.
"""
from __future__ import annotations

import re

TOTAL = re.compile(r"รวม|ยอด|มูลค่า|จำนวนเงิน|ส่วนต่าง|ประหยัด|กำไร|รายได้|ค่าใช้จ่าย|งบ|total|amount|revenue|sales|income|profit|expense|budget|spend|saving|difference|variance|value", re.I)
PRICE = re.compile(r"ราคา|ค่าของ|ค่าแรง|ต่อหน่วย|price|rate|cost|fee|salary", re.I)
CURRENCY = re.compile(r"\(บาท\)|บาท|\bthb\b|\busd\b|฿|\$", re.I)
QUANTITY = re.compile(r"\bqty\b|quantity|\bunits?\b|\bcount\b|orders?|จำนวน|ปริมาณ|ชิ้น", re.I)
PERCENT = re.compile(r"percent|\bpct\b|%|\brate\b|ratio|ร้อยละ|อัตรา|สัดส่วน", re.I)
CURRENCY_FORMAT = re.compile(r"฿|\$|€|£|¥|\[\$|บาท", re.I)
SCORE = re.compile(r"score|rating|คะแนน", re.I)
NOTE = re.compile(r"หมายเหตุ|remark|note|comment|flag|ความเห็น|รายละเอียด|description", re.I)
UNIT = re.compile(r"^(?:หน่วย|unit|uom|unit of measure)\b", re.I)
ID_NAME = re.compile(r"(?:\bid\b|identifier|\bcode\b|\bsku\b|รหัส|เลขที่|ลำดับ|^no\.?$)", re.I)
YEAR_MONTH = re.compile(r"\d{4}-(?:0[1-9]|1[0-2])")
CATEGORY_MAX_UNIQUE = 200


def _meaning(name, values, number_format=None):
    # The cell format the author chose is stronger evidence than the header text.
    if number_format and "%" in number_format:
        return "percent"
    if number_format and CURRENCY_FORMAT.search(number_format):
        return "price" if PRICE.search(name) and not TOTAL.search(name) else "money"
    if PERCENT.search(name) and not TOTAL.search(name):
        return "percent"
    if SCORE.search(name):
        return "score"
    if TOTAL.search(name) or (PRICE.search(name) and CURRENCY.search(name)):
        return "money"
    if PRICE.search(name):
        return "price"
    if QUANTITY.search(name) and values and all(v >= 0 for v in values[:5000]):
        return "quantity"
    return None


def annotate(profile, numeric, dates, counters, is_identifier):
    """Add semantic fields in place. `is_identifier(column, numeric_values, rows)` is the analyzer rule."""
    rows = profile["rows_count"]
    for index, column in enumerate(profile["columns"]):
        present = rows - column["missing_count"]
        values = numeric[index]
        name = column["name"]
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
                role, meaning = "measure", _meaning(name, values, column.get("number_format"))
        elif column["data_type"] in ("text", "mixed"):
            unique = column["unique_count"]
            if ID_NAME.search(name) and unique >= present * .9:
                kind, role = "identifier", "identifier"
            elif unique == present and present > 200:
                # Unique free text in a long table: an ID or a description, never a group.
                kind, role = "identifier", "identifier"
            elif unique <= 1 or NOTE.search(name) or UNIT.search(name) or column["missing_count"] > rows * .6:
                # Remarks, flags and units of measure describe rows; grouping by them misleads.
                kind = "category" if unique <= CATEGORY_MAX_UNIQUE else "text"
            elif unique <= CATEGORY_MAX_UNIQUE and (unique <= 20 or unique <= present * .5):
                kind, role = "category", "dimension"
            else:
                # Labels (item names, one row per building/category) suit ranked bar charts.
                kind = "text"
        column["semantic_type"], column["role"], column["meaning"] = kind, role, meaning
        if time_format:
            column["time_format"] = time_format
    return profile
