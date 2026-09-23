"""Where the tables are in a sheet.

A layout is {"tables": [{"title", "header_rows": [n, ...], "data_start": n,
"data_end": n | None, "first_col": c, "last_col": c | None}]} using 1-based
sheet row and column numbers. `guess` finds one from the first rows of a sheet
(title lines, multi-row headers, headerless tables); an LLM-proposed layout is
checked by `validate` before use. Either way the reader then loads every row.
"""
from __future__ import annotations

import re
from datetime import date, datetime

SAMPLE_ROWS = 40
MAX_TABLES = 6
NUMERIC_TEXT = re.compile(r"[+-]?[\d,]*\.?\d+%?\Z")


def blank(value):
    return value is None or isinstance(value, str) and not value.strip()


def textual(value):
    """A label-like cell: text that is not a number, a date or a percentage."""
    return isinstance(value, str) and bool(value.strip()) and not NUMERIC_TEXT.match(value.strip().replace(" ", ""))


def numeric(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)) or isinstance(value, (date, datetime)) or \
        isinstance(value, str) and bool(value.strip()) and bool(NUMERIC_TEXT.match(value.strip().replace(" ", "")))


def filled(values):
    return [index for index, value in enumerate(values) if not blank(value)]


def column_letter(number):
    letters = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def guess(rows):
    """rows: [(row_number, values)] from the top of a sheet. Returns a layout or None when empty."""
    rows = [(number, values) for number, values in rows if filled(values)]
    if not rows:
        return None
    best = best_header(rows, 2)
    if best is None:
        # Single-column tables, or one label above a column (blank header cells beside it).
        best = best_header(rows, 1)
    if best is None and len(rows) == 1 and all(textual(rows[0][1][i]) for i in filled(rows[0][1])):
        # Only a label row: a table with no data rows yet.
        number = rows[0][0]
        return {"tables": [{"title": "", "header_rows": [number], "data_start": number + 1, "data_end": None, "first_col": min(filled(rows[0][1])) + 1, "last_col": None}]}
    if best is None:
        # No label row: a headerless table from the first multi-cell row.
        start = next((number for number, values in rows if len(filled(values)) >= 2), rows[0][0])
        first = min(min(filled(values)) for number, values in rows if number >= start) + 1
        return {"tables": [{"title": "", "header_rows": [], "data_start": start, "data_end": None, "first_col": first, "last_col": None}]}
    header_number, header = rows[best]
    header_rows = [header_number]
    cells = filled(header)
    # A sparse label row directly above (group titles over merged cells) belongs to the header.
    if best > 0:
        above_number, above = rows[best - 1]
        above_cells = filled(above)
        if above_number == header_number - 1 and len(above_cells) >= 2 and len(above_cells) < len(cells) \
                and all(textual(above[i]) for i in above_cells) and min(above_cells) >= min(cells):
            header_rows.insert(0, above_number)
    # A second label row directly below (sub-headers such as "RBP | KMIT") also belongs to it.
    if best + 2 < len(rows):
        below_number, below = rows[best + 1]
        below_cells = filled(below)
        after = rows[best + 2][1]
        if below_number == header_number + 1 and len(below_cells) >= 2 and all(textual(below[i]) for i in below_cells) \
                and any(numeric(after[i]) for i in filled(after)):
            header_rows.append(below_number)
    data_start = header_rows[-1] + 1
    data_cells = [filled(values)[0] for number, values in rows if number >= data_start][:50]
    first = min([min(cells)] + data_cells) + 1
    return {"tables": [{"title": "", "header_rows": header_rows, "data_start": data_start, "data_end": None, "first_col": first, "last_col": None}]}


def best_header(rows, min_cells):
    """Index of the likeliest label row: mostly text, followed by rows that fill a good part of its span."""
    best, best_score = None, 0
    for index, (number, values) in enumerate(rows[:SAMPLE_ROWS]):
        cells = filled(values)
        if len(cells) < min_cells:
            continue
        labels = sum(textual(values[i]) for i in cells)
        if labels / len(cells) < .6:
            continue
        span = set(range(min(cells), max(cells) + 1))
        follow = 0
        for _, below in rows[index + 1:index + 6]:
            below_cells = [i for i in filled(below) if i in span]
            if len(below_cells) >= max(min_cells, len(cells) * .4):
                follow += 1
        if not follow:
            continue
        score = labels * 2 + follow * 3 + len(cells) - index * .15
        if score > best_score:
            best, best_score = index, score
    return best


def validate(layout, max_row=None):
    """Return a cleaned layout or None. Rejects anything the reader cannot follow safely."""
    if not isinstance(layout, dict) or not isinstance(layout.get("tables"), list) or not 1 <= len(layout["tables"]) <= MAX_TABLES:
        return None
    integer = lambda value: isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 10_000_000
    tables = []
    for table in layout["tables"]:
        if not isinstance(table, dict):
            return None
        header_rows = table.get("header_rows") or []
        data_start, data_end = table.get("data_start"), table.get("data_end") or None
        first_col, last_col = table.get("first_col") or 1, table.get("last_col") or None
        if not isinstance(header_rows, list) or len(header_rows) > 4 or not all(integer(row) for row in header_rows) or sorted(set(header_rows)) != header_rows:
            return None
        if not integer(data_start) or (header_rows and data_start <= header_rows[-1]) or not integer(first_col) or first_col > 1000:
            return None
        if data_end is not None and (not integer(data_end) or data_end < data_start):
            return None
        if last_col is not None and (not integer(last_col) or last_col < first_col or last_col > 1000):
            return None
        if max_row and data_start > max_row:
            continue
        title = table.get("title") if isinstance(table.get("title"), str) else ""
        names = table.get("column_names")
        names = [re.sub(r"\s+", " ", name).strip()[:200] for name in names] if isinstance(names, list) and 0 < len(names) <= 300 and all(isinstance(name, str) for name in names) else None
        tables.append({"title": re.sub(r"\s+", " ", title).strip()[:80], "header_rows": header_rows, "data_start": data_start,
                       "data_end": data_end, "first_col": first_col, "last_col": last_col, "column_names": names})
    tables.sort(key=lambda table: (table["header_rows"] or [table["data_start"]])[0])
    for previous, current in zip(tables, tables[1:]):
        start = (current["header_rows"] or [current["data_start"]])[0]
        if start <= previous["data_start"] or (previous["data_end"] and previous["data_end"] >= start):
            return None
    return {"tables": tables} if tables else None


def column_names(header_values, first_col, width):
    """Names from one or more header rows (already sliced to the table's columns).
    Group titles over merged cells are carried right until the next title."""
    grid = [list(values) + [None] * max(0, width - len(values)) for values in header_values]
    # An upper row with a single repeated text is a report title, not a column group.
    grid = [row for level, row in enumerate(grid) if level == len(grid) - 1 or len({str(v).strip() for v in row if not blank(v)}) > 1]
    for level, row in enumerate(grid[:-1]):
        carried = None
        for index in range(width):
            if not blank(row[index]):
                carried = row[index]
            elif carried is not None and any(not blank(lower[index]) for lower in grid[level + 1:]):
                row[index] = carried
    names, seen = [], {}
    for index in range(width):
        parts = []
        for row in grid:
            value = row[index]
            text = value.strftime("%Y-%m-%d") if isinstance(value, (date, datetime)) else "" if blank(value) else re.sub(r"\s+", " ", str(value)).strip()
            if text and (not parts or parts[-1] != text):
                parts.append(text[:200])
        name = " / ".join(parts) or f"คอลัมน์ {column_letter(first_col + index)}"
        key = name.casefold()
        if key in seen:
            seen[key] += 1
            name = f"{name} ({seen[key]})"
        else:
            seen[key] = 1
        names.append(name)
    return names


def sample_rows(rows, limit=SAMPLE_ROWS, width=40, text=60):
    """Compact grid for the LLM: non-empty cells keyed by column letter."""
    out = []
    for number, values in rows[:limit]:
        cells = {}
        for index, value in enumerate(values[:width]):
            if blank(value):
                continue
            shown = value.strftime("%Y-%m-%d") if isinstance(value, (date, datetime)) else str(value)
            cells[column_letter(index + 1)] = shown[:text]
        if cells:
            out.append({"row": number, "cells": cells})
    return out


def head_signature(rows):
    """Sheets whose header block reads the same share one layout request."""
    layout = guess(rows)
    if not layout:
        return None
    headers = set(layout["tables"][0]["header_rows"])
    return tuple(tuple("" if blank(v) else str(v).strip() for v in values) for number, values in rows if number in headers) or None
