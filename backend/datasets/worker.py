"""Bounded CSV/XLSX ingestion and paginated SQLite preview.

This worker never evaluates cells or calls an LLM. Its stdout is a JSON-lines
protocol; uploaded values are returned only by the explicit preview command.
"""
from __future__ import annotations

import csv
import io
import itertools
import json
import math
import re
import sqlite3
import sys
import zipfile
from xml.etree import ElementTree
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

import layout
import workbook


DEFAULT_LIMITS = {
    "max_rows": 100_000,
    "max_columns": 200,
    "max_cells": 2_000_000,
    "max_uncompressed_bytes": 100_000_000,
    "max_sheets": 50,
}
MAX_SAFE_INTEGER = 9_007_199_254_740_991
NUMBER = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\Z")
ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}.*)?\Z")
# A summary line starts with a total word ("รวม (Total)", "Grand Total ...", "VAT 7%").
TOTAL_ROW = re.compile(r"(?:grand\s*total|sub\s*-?\s*total|totals?\b|รวม|ยอดรวม|vat\b|ภาษีมูลค่าเพิ่ม)", re.I)
# Text under a table: notes, sources and signature lines.
NOTE_ROW = re.compile(r"\s*(?:หมายเหตุ|note\b|notes\b|remarks?\b|\*|※|ที่มา\s*[:：]|source\s*:|ลงชื่อ|ผู้จัดทำ|ผู้ตรวจสอบ|ผู้อนุมัติ|prepared\s+by|checked\s+by|approved\s+by)", re.I)
# 1,234,567.89 as written in Thai and English reports.
GROUPED_NUMBER = re.compile(r"[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?\Z")
EXCEL_ERROR = re.compile(r"#(?:DIV/0!|N/A|NAME\?|NULL!|NUM!|REF!|VALUE!|SPILL!|CALC!)")


class DatasetError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def fail(code, message):
    raise DatasetError(code, message)


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def blank(value):
    return value is None or isinstance(value, str) and not value.strip()


def limits_from(values):
    if not isinstance(values, dict):
        fail("INVALID_REQUEST", "การตั้งค่าขีดจำกัดต้องเป็น JSON object")
    result = dict(DEFAULT_LIMITS)
    for key in result:
        value = values.get(key, result[key])
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            fail("INVALID_REQUEST", f"ขีดจำกัด {key} ต้องเป็นจำนวนเต็มบวก")
        result[key] = value
    return result


def is_iso_date(value):
    if not ISO_DATE.fullmatch(value):
        return False
    try:
        if "T" in value:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        else:
            date.fromisoformat(value)
        return True
    except ValueError:
        return False


def normalize(value, context):
    """Keep IDs, ambiguous dates, formula text and original text as text."""
    if blank(value):
        return None, "empty"
    if isinstance(value, bool):
        return value, "boolean"
    if isinstance(value, datetime) and value.tzinfo is None and value.time() == time(0):
        # Excel keeps every date as a date-time; a date typed without a time is just a date.
        return value.date().isoformat(), "date"
    if isinstance(value, (date, datetime)):
        return value.isoformat(), "date"
    if isinstance(value, time):
        return value.strftime("%H:%M:%S"), "text"
    if isinstance(value, timedelta):
        return str(value), "text"
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            fail("UNSUPPORTED_VALUE", f"{context}: พบตัวเลขที่ไม่เป็นค่าจำกัด กรุณาแก้ไขเซลล์นี้")
        if isinstance(value, int) and abs(value) > MAX_SAFE_INTEGER:
            return str(value), "text"
        return value, "number"
    if not isinstance(value, str):
        fail("UNSUPPORTED_VALUE", f"{context}: พบชนิดข้อมูลที่ยังไม่รองรับ กรุณาแปลงเป็นข้อความหรือตัวเลข")
    if any(ord(char) < 32 and char not in "\r\n\t" for char in value):
        fail("UNSUPPORTED_VALUE", f"{context}: พบอักขระไบนารีหรืออักขระควบคุมที่ไม่รองรับ")
    trimmed = value.strip()
    if trimmed.casefold() in ("true", "false"):
        return trimmed.casefold() == "true", "boolean"
    if is_iso_date(trimmed):
        return trimmed, "date"
    if GROUPED_NUMBER.fullmatch(trimmed):
        number = float(trimmed.replace(",", "")) if "." in trimmed else int(trimmed.replace(",", ""))
        if abs(number) <= MAX_SAFE_INTEGER:
            return number, "number"
    if NUMBER.fullmatch(trimmed) and not re.match(r"[+-]?0\d", trimmed):
        try:
            number = float(trimmed) if any(c in trimmed for c in ".eE") else int(trimmed)
            if math.isfinite(number) and abs(number) <= MAX_SAFE_INTEGER:
                return number, "number"
        except (ValueError, OverflowError):
            pass
    return value, "text"


def csv_rows(path):
    with path.open("rb") as raw:
        prefix = raw.read(4)
        raw.seek(0)
        encoding = "utf-16" if prefix.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
        if encoding == "utf-8-sig":
            # Thai Excel on Windows saves CSV as TIS-620 (cp874) unless UTF-8 is chosen.
            head = raw.read(1_048_576)
            raw.seek(0)
            try:
                head.decode("utf-8")
            except UnicodeDecodeError as error:
                if error.start < len(head) - 4:
                    encoding = "cp874"
        with io.TextIOWrapper(raw, encoding=encoding, errors="strict", newline="") as stream:
            sample = stream.read(65_536)
            stream.seek(0)
            try:
                dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
            except csv.Error:
                first = next((line for line in sample.splitlines() if line.strip()), "")
                delimiter = max(",;\t|", key=first.count)
                dialect = type("DetectedCSV", (csv.excel,), {"delimiter": delimiter})
            reader = csv.reader(stream, dialect, strict=True)
            while True:
                row_number = reader.line_num + 1
                try:
                    values = next(reader)
                except StopIteration:
                    break
                yield row_number, values, 0, None


def xlsx_preflight(path, limits):
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            if len(entries) > 10_000 or len(set(names)) != len(names):
                fail("INVALID_FILE", "โครงสร้างไฟล์ XLSX ไม่ถูกต้องหรือซับซ้อนเกินขีดจำกัด")
            if sum(entry.file_size for entry in entries) > limits["max_uncompressed_bytes"]:
                fail("LIMIT_EXCEEDED", f"ข้อมูล XLSX หลังคลายไฟล์เกิน {limits['max_uncompressed_bytes'] / 1_000_000:g} MB กรุณาแบ่งไฟล์")
            if any(entry.flag_bits & 1 for entry in entries):
                fail("INVALID_FILE", "ไม่รองรับไฟล์ XLSX ที่เข้ารหัส กรุณาบันทึกสำเนาที่ไม่ใส่รหัสผ่าน")
            if "[Content_Types].xml" not in names or "xl/workbook.xml" not in names:
                fail("INVALID_FILE", "ไฟล์นี้ไม่ใช่สมุดงาน XLSX ที่ถูกต้อง กรุณาบันทึกใหม่จาก Excel")
            # Macro parts are never loaded or run (openpyxl ignores them); the scan reports them.
            content_types = archive.read("[Content_Types].xml").lower()
            if b"spreadsheetml" not in content_types and b"sheet.macroenabled" not in content_types:
                fail("INVALID_FILE", "ไฟล์นี้ไม่ใช่สมุดงาน XLSX ที่ถูกต้อง กรุณาบันทึกใหม่จาก Excel")
            if archive.testzip() is not None:
                fail("INVALID_FILE", "ไฟล์ XLSX เสียหาย กรุณาเปิดไฟล์ใน Excel แล้วบันทึกใหม่")
    except (zipfile.BadZipFile, OSError, RuntimeError, KeyError, ElementTree.ParseError):
        fail("INVALID_FILE", "อ่านโครงสร้างไฟล์ XLSX ไม่สำเร็จ กรุณาตรวจว่าไฟล์ไม่เสียหาย")


class CoordinateCheck:
    """read_only iteration can silently skip repeated/out-of-order rows and
    synthesize enormous gaps for forged coordinates. Every worksheet's structure
    is checked (during the workbook scan) before that iterator is trusted."""

    def __init__(self):
        self.previous_row, self.current_row, self.previous_column = 0, None, 0

    def __call__(self, event, element, tag):
        if event == "start" and tag == "row":
            row = element.get("r", str(self.previous_row + 1))
            if not row.isascii() or not row.isdigit() or not self.previous_row < int(row) <= 1_048_576:
                fail("INVALID_FILE", "โครงสร้าง XLSX มีเลขแถวซ้ำ ผิดลำดับ หรือเกินขอบเขต Excel กรุณาเปิดไฟล์แล้วบันทึกใหม่")
            self.current_row = self.previous_row = int(row)
            self.previous_column = 0
        elif event == "start" and tag == "c":
            if self.current_row is None:
                fail("INVALID_FILE", "โครงสร้างเซลล์ XLSX ไม่ถูกต้อง กรุณาเปิดไฟล์ใน Excel แล้วบันทึกใหม่")
            coordinate = element.get("r")
            column = self.previous_column + 1
            if coordinate:
                match = re.fullmatch(r"([A-Za-z]{1,3})([1-9][0-9]{0,6})", coordinate)
                if not match or int(match[2]) != self.current_row:
                    fail("INVALID_FILE", "ตำแหน่งเซลล์ XLSX ไม่ตรงกับแถว กรุณาเปิดไฟล์ใน Excel แล้วบันทึกใหม่")
                column = 0
                for char in match[1].upper():
                    column = column * 26 + ord(char) - ord("A") + 1
            if not self.previous_column < column <= 16_384:
                fail("INVALID_FILE", "โครงสร้าง XLSX มีคอลัมน์ซ้ำ ผิดลำดับ หรือเกินขอบเขต Excel กรุณาเปิดไฟล์แล้วบันทึกใหม่")
            self.previous_column = column
        elif event == "end" and tag == "row":
            self.current_row = None


def xlsx_rows(sheet, formula_sheet, uncached):
    """Yield (row number, values, formula cell count, extras) with the values Excel
    last calculated. Formulas are never evaluated here; a formula cell without a
    saved result is stored empty and counted in `uncached`. Extras carry the
    number formats of numeric cells and the formula text by column position."""
    # Ignore inaccurate worksheet dimensions, including styled empty tails.
    sheet.reset_dimensions()
    if formula_sheet is not None:
        formula_sheet.reset_dimensions()
    formula_rows = formula_sheet.iter_rows() if formula_sheet is not None else ()
    for index, (cells, formula_cells) in enumerate(itertools.zip_longest(sheet.iter_rows(), formula_rows, fillvalue=()), 1):
        values, formats, formulas = [], [], {}
        for position, (cell, source) in enumerate(itertools.zip_longest(cells, formula_cells)):
            value = cell.value if cell is not None else None
            error = cell is not None and cell.data_type == "e" or isinstance(value, str) and bool(EXCEL_ERROR.fullmatch(value))
            if error:
                value = None
                uncached["errors"] = uncached.get("errors", 0) + 1
            if source is not None and source.data_type == "f":
                formulas[position] = str(getattr(source.value, "text", source.value))[:200]
                if value is None and not error:
                    uncached[sheet.title] = uncached.get(sheet.title, 0) + 1
            values.append(value)
            number_format = getattr(cell, "number_format", None) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
            formats.append(number_format if number_format and number_format != "General" else None)
        while values and blank(values[-1]):
            values.pop()
        extras = {"formats": formats[:len(values)], "formulas": formulas} if formulas or any(formats) else None
        yield index, values, len(formulas), extras


def xls_rows(book, sheet):
    import xlrd
    formatted = bool(getattr(book, "formatting_info", False))
    for index in range(sheet.nrows):
        values, formats = [], []
        for column, cell in enumerate(sheet.row(index)):
            number_format = None
            if cell.ctype == xlrd.XL_CELL_DATE:
                value = xlrd.xldate_as_datetime(cell.value, book.datemode)
                values.append(value.date() if value.time() == datetime.min.time() else value)
            elif cell.ctype == xlrd.XL_CELL_NUMBER:
                values.append(int(cell.value) if float(cell.value).is_integer() and abs(cell.value) <= MAX_SAFE_INTEGER else cell.value)
                if formatted:
                    try:
                        number_format = book.format_map[book.xf_list[sheet.cell_xf_index(index, column)].format_key].format_str
                    except (IndexError, KeyError):
                        number_format = None
            elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                values.append(bool(cell.value))
            elif cell.ctype == xlrd.XL_CELL_TEXT:
                values.append(cell.value)
            else:
                values.append(None)
            formats.append(number_format if number_format and number_format != "General" else None)
        while values and blank(values[-1]):
            values.pop()
        yield index + 1, values, 0, ({"formats": formats[:len(values)], "formulas": {}} if any(formats) else None)


def xls_facts(book):
    """Merged cells and hidden rows/columns of a legacy .xls (formatting records)."""
    facts = workbook.empty_facts()
    for index in range(book.nsheets):
        sheet = book.sheet_by_index(index)
        rowinfo = getattr(sheet, "rowinfo_map", {}) or {}
        colinfo = getattr(sheet, "colinfo_map", {}) or {}
        facts["sheets"][sheet.name] = {
            "state": "visible" if sheet.visibility == 0 else "hidden", "kind": "worksheet",
            "hidden_rows": {row + 1 for row, info in rowinfo.items() if getattr(info, "hidden", 0)},
            "hidden_cols": {column + 1 for column, info in colinfo.items() if getattr(info, "hidden", 0)},
            "merges": [(rlo + 1, clo + 1, rhi, chi) for rlo, rhi, clo, chi in (getattr(sheet, "merged_cells", []) or [])[:workbook.MAX_MERGES]],
            "formulas": 0, "hyperlink_count": 0, "autofilter": None}
    return facts


def fill_merged(rows, merges, stats):
    """A block merged down several rows shows its value only in its top cell.
    Copy it down the block's first column so every row keeps its category."""
    starts = {}
    for first_row, first_col, last_row, last_col in merges:
        if last_row > first_row:
            starts.setdefault(first_row, []).append((first_col, last_row))
    if not starts:
        yield from rows
        return
    active = []
    for row_number, values, formulas, extras in rows:
        active = [item for item in active if item[1] >= row_number]
        if active:
            values = list(values)
            for column, _, value in active:
                while len(values) < column:
                    values.append(None)
                if blank(values[column - 1]):
                    values[column - 1] = value
                    stats["merged"] = stats.get("merged", 0) + 1
        for column, last_row in starts.get(row_number, ()):
            value = values[column - 1] if column <= len(values) else None
            if not blank(value):
                active.append((column, last_row, value))
        yield row_number, values, formulas, extras


def open_sources(input_path, filename, limits, uncached):
    """(sheet name, row iterator factory, visibility) per sheet, the open workbooks, notes and workbook facts."""
    extension = Path(filename).suffix.casefold()
    books, notes = [], []
    facts = workbook.empty_facts()
    if extension == ".xlsx":
        xlsx_preflight(input_path, limits)
        import openpyxl
        failed = False
        try:
            facts = workbook.scan(input_path, CoordinateCheck)
        except (zipfile.BadZipFile, OSError, ElementTree.ParseError, ValueError, KeyError) as error:
            error.__traceback__ = None
            failed = True
        if failed:
            fail("INVALID_FILE", "โครงสร้าง XLSX ไม่ถูกต้อง กรุณาเปิดไฟล์ใน Excel แล้วบันทึกใหม่")
        # The formula view is read only where formulas exist (it doubles the parsing work).
        with_formulas = any(sheet.get("formulas") for sheet in facts["sheets"].values())
        book = formula_book = None
        try:
            book = openpyxl.load_workbook(input_path, read_only=True, data_only=True, keep_links=False)
            if with_formulas:
                formula_book = openpyxl.load_workbook(input_path, read_only=True, data_only=False, keep_links=False)
        except (OSError, KeyError, ValueError, TypeError, zipfile.BadZipFile, ElementTree.ParseError) as error:
            # Drop the traceback: its frames keep openpyxl's archive handle open.
            error.__traceback__ = None
        if book is None or (with_formulas and formula_book is None):
            if book is not None:
                book.close()
            fail("INVALID_FILE", "ไม่สามารถอ่านสมุดงานได้ กรุณาตรวจโครงสร้างหรือเปิดไฟล์ใน Excel แล้วบันทึกใหม่")
        books = [book] + ([formula_book] if formula_book is not None else [])
        formula_sheets = formula_book.worksheets if formula_book is not None else [None] * len(book.worksheets)
        sources = []
        for sheet, formulas in zip(book.worksheets, formula_sheets):
            formulas = formulas if facts["sheets"].get(sheet.title, {}).get("formulas") else None
            sources.append((sheet.title, (lambda s=sheet, f=formulas: xlsx_rows(s, f, uncached)), sheet.sheet_state))
    elif extension == ".xls":
        import xlrd
        try:
            book = xlrd.open_workbook(str(input_path), on_demand=True, formatting_info=True)
        except NotImplementedError:
            book = xlrd.open_workbook(str(input_path), on_demand=True)
        books = [book]
        sheets = [book.sheet_by_index(index) for index in range(book.nsheets)]
        if sum(sheet.nrows * sheet.ncols for sheet in sheets) > limits["max_cells"] * 2:
            fail("LIMIT_EXCEEDED", f"จำนวนเซลล์ข้อมูลรวมเกิน {limits['max_cells']:,} เซลล์ กรุณาแบ่งไฟล์")
        facts = xls_facts(book)
        sources = [(sheet.name, (lambda s=sheet: xls_rows(book, s)), "visible" if sheet.visibility == 0 else "hidden") for sheet in sheets]
    else:
        sources = [("CSV", lambda: csv_rows(input_path), "visible")]
    if len(sources) > limits["max_sheets"]:
        notes.append(f"ไฟล์มี {len(sources):,} ชีต อ่าน {limits['max_sheets']} ชีตแรก ชีตที่เหลือไม่ได้นำมาวิเคราะห์")
        sources = sources[:limits["max_sheets"]]
    return sources, books, notes, facts


def close_books(books):
    for workbook_object in books:
        (workbook_object.release_resources if hasattr(workbook_object, "release_resources") else workbook_object.close)()


def head_rows(iterator):
    buffer = []
    for row_number, values, formulas, extras in iterator:
        buffer.append((row_number, list(values), formulas, extras))
        if len(buffer) >= layout.SAMPLE_ROWS:
            break
    return buffer


def sheet_rows(rows, facts, name, stats):
    return fill_merged(rows(), facts["sheets"].get(name, {}).get("merges", ()), stats)


def sample(input_path, filename, limits_values=None, image_dir=None):
    """First rows of each sheet for the layout request. Sheets whose header block
    reads the same are sent once, with the other names listed as members.
    Images a vision model can read are written to `image_dir`."""
    limits = limits_from({} if limits_values is None else limits_values)
    sources, books, _, facts = open_sources(Path(input_path), filename, limits, {})
    try:
        groups, order = {}, []
        for name, rows, _ in sources:
            buffer = head_rows(sheet_rows(rows, facts, name, {}))
            view = [(number, values) for number, values, _, _ in buffer]
            if not any(layout.filled(values) for _, values in view):
                continue
            key = layout.head_signature(view) or ("__single__", name)
            if key not in groups:
                groups[key] = {"sheet": name, "members": [], "rows": layout.sample_rows(view)}
                order.append(key)
            else:
                groups[key]["members"].append(name)
        sheets, size = [], 0
        for key in order[:15]:
            entry = groups[key]
            size += len(json.dumps(entry, ensure_ascii=False))
            if size > 70_000:
                break
            sheets.append(entry)
        images = []
        if image_dir is not None and facts["images"]:
            Path(image_dir).mkdir(exist_ok=True)
            images = workbook.extract_images(Path(input_path), facts, Path(image_dir))
        return {"filename": filename, "sheets": sheets, "images": images}
    finally:
        close_books(books)


def excel_table_layout(facts, sheet_name):
    """Excel tables (Insert > Table) state exactly where their data is."""
    tables = []
    for table in facts["tables"]:
        if table["sheet"] != sheet_name:
            continue
        first_row, first_col, last_row, last_col = table["bounds"]
        header_rows = list(range(first_row, first_row + table["header_rows"]))
        data_end = last_row - table["totals_rows"]
        if data_end < first_row + table["header_rows"]:
            continue
        tables.append({"title": table["name"], "header_rows": header_rows, "data_start": first_row + table["header_rows"], "data_end": data_end,
                       "first_col": first_col, "last_col": last_col, "column_names": [name for name in table["columns"] if name] or None})
    return {"tables": tables} if tables else None


class TableWriter:
    """One detected table stored as a data_sN SQLite table."""

    def __init__(self, connection, state, name, names, header_row, first_col, extendable, sheet_facts=None, source_sheet=None):
        self.connection, self.state, self.name = connection, state, name
        self.id = f"s{state['next_id']}"
        state["next_id"] += 1
        self.names, self.first_col, self.extendable = list(names), first_col, extendable
        self.kinds = [set() for _ in self.names]
        self.formats = [{} for _ in self.names]
        self.formula_rows = [0 for _ in self.names]
        self.formula_text = [None for _ in self.names]
        self.header_row = header_row
        self.source_sheet = source_sheet
        self.sheet_facts = sheet_facts or {}
        self.notes, self.title_lines, self.footnotes = [], [], []
        self.extra = {}
        self.rows = self.formulas = self.blank_rows = self.truncated = self.added_columns = self.hidden_rows = self.note_rows = 0
        self.first_row = self.last_row = None
        self.summary_rows, self.summary_labels = [], []
        self.max_columns = None
        connection.execute(f'CREATE TABLE "data_{self.id}" (row_number INTEGER PRIMARY KEY, data TEXT NOT NULL)')

    def grow(self, count):
        for index in range(len(self.names), count):
            self.names.append(f"คอลัมน์ {layout.column_letter(self.first_col + index)}")
            self.kinds.append(set())
            self.formats.append({})
            self.formula_rows.append(0)
            self.formula_text.append(None)
            self.added_columns += 1

    def check_columns(self, count):
        if count > self.max_columns:
            fail("LIMIT_EXCEEDED", f"ตาราง {self.name} มี {count:,} คอลัมน์ เกินขีดจำกัด {self.max_columns:,} คอลัมน์ กรุณาลดจำนวนคอลัมน์")

    def add(self, row_number, values, formulas, limits, sheet_name, extras=None):
        values = list(values)
        while values and blank(values[-1]):
            values.pop()
        if not any(not blank(value) for value in values):
            self.blank_rows += 1
            return
        if self.max_columns is None:
            self.max_columns = limits["max_columns"]
            self.check_columns(len(self.names))
        if len(values) > len(self.names):
            if self.extendable:
                self.check_columns(len(values))
                self.grow(len(values))
            else:
                self.truncated += 1
                values = values[:len(self.names)]
        cells = [value for value in values if not blank(value)]
        # Notes, sources and signature lines under a table are text about it, not data.
        if all(isinstance(value, str) for value in cells) and NOTE_ROW.match(cells[0]):
            self.note_rows += 1
            if len(self.footnotes) < 20:
                self.footnotes.append(re.sub(r"\s+", " ", " ".join(str(value) for value in cells)).strip()[:200])
            return
        if self.state["rows"] + 1 > limits["max_rows"]:
            fail("LIMIT_EXCEEDED", f"จำนวนแถวข้อมูลรวมเกิน {limits['max_rows']:,} แถว กรุณาแบ่งไฟล์")
        self.state["cells"] += len(self.names)
        if self.state["cells"] > limits["max_cells"]:
            fail("LIMIT_EXCEEDED", f"จำนวนเซลล์ข้อมูลรวมเกิน {limits['max_cells']:,} เซลล์ กรุณาแบ่งไฟล์")
        first = cells[0]
        summary = isinstance(first, str) and bool(TOTAL_ROW.match(first.strip()))
        if summary:
            self.summary_rows.append(row_number)
            self.summary_labels.append(first.strip()[:60])
        if row_number in self.sheet_facts.get("hidden_rows", ()):
            self.hidden_rows += 1
        record = {}
        label = next(index for index, value in enumerate(values) if not blank(value)) if summary else None
        for index in range(len(self.names)):
            value, kind = normalize(values[index] if index < len(values) else None, f"ชีต {sheet_name} แถว {row_number} คอลัมน์ {index + 1}")
            record[f"c{index}"] = value
            # "รวมทั้งสิ้น" written in a number column does not make it a text column.
            if kind != "empty" and index != label:
                self.kinds[index].add(kind)
        if extras:
            for index, number_format in enumerate(extras.get("formats") or ()):
                if number_format and index < len(self.names) and self.rows < 2000:
                    counts = self.formats[index]
                    counts[number_format] = counts.get(number_format, 0) + 1
            for index, text in (extras.get("formulas") or {}).items():
                # A total line's SUM() says nothing about how the column is computed.
                if index < len(self.names) and not summary:
                    self.formula_rows[index] += 1
                    self.formula_text[index] = self.formula_text[index] or text
        self.connection.execute(f'INSERT INTO "data_{self.id}" VALUES (?, ?)', (row_number, json.dumps(record, ensure_ascii=False, allow_nan=False)))
        self.rows += 1
        self.state["rows"] += 1
        self.formulas += formulas
        self.first_row = row_number if self.first_row is None else self.first_row
        self.last_row = row_number

    def finish(self, result):
        if not self.rows:
            self.connection.execute(f'DROP TABLE "data_{self.id}"')
            return False
        # Rows stored before the table grew lack the added columns; every row gets every key.
        for index in range(len(self.names) - self.added_columns, len(self.names)):
            self.connection.execute(f"""UPDATE "data_{self.id}" SET data = json_set(data, '$.c{index}', json('null')) WHERE json_type(data, '$.c{index}') IS NULL""")
        warnings = list(self.notes)
        if self.blank_rows:
            warnings.append(f"ข้ามแถวว่าง {self.blank_rows:,} แถว โดยคงเลขแถวต้นฉบับไว้")
        if self.added_columns:
            warnings.append(f"มีข้อมูลเกินหัวคอลัมน์ จึงเพิ่มคอลัมน์ชื่ออัตโนมัติ {self.added_columns} คอลัมน์")
        if self.truncated:
            warnings.append(f"ตัดข้อมูลที่อยู่นอกขอบตาราง {self.truncated:,} แถว")
        if self.formulas:
            warnings.append(f"ใช้ค่าที่ Excel คำนวณไว้ล่าสุดของสูตร {self.formulas:,} เซลล์ ระบบไม่คำนวณสูตรใหม่")
        if self.summary_rows:
            warnings.append(f"ไม่นำแถวสรุปยอด {len(self.summary_rows):,} แถวมาคำนวณ ({', '.join(self.summary_labels[:4])}) เพื่อไม่ให้ยอดซ้ำ แถวเหล่านี้ยังแสดงในตารางข้อมูล")
        if self.note_rows:
            warnings.append(f"แยกหมายเหตุหรือข้อความท้ายตาราง {self.note_rows:,} แถวออกจากข้อมูล")
        if self.hidden_rows:
            warnings.append(f"มีแถวที่ถูกซ่อนในไฟล์ {self.hidden_rows:,} แถว ระบบรวมไว้ในข้อมูลด้วย")
        hidden_cols = self.sheet_facts.get("hidden_cols", ())
        columns = []
        for index, (name, kinds) in enumerate(zip(self.names, self.kinds)):
            col = self.first_col + index
            column = {"key": f"c{index}", "name": name, "data_type": next(iter(kinds)) if len(kinds) == 1 else "mixed" if kinds else "empty",
                      "col": col, "letter": layout.column_letter(col)}
            if self.formats[index]:
                column["number_format"] = max(self.formats[index].items(), key=lambda item: item[1])[0][:60]
            if self.formula_rows[index]:
                column["formula"] = self.formula_text[index]
                column["formula_rows"] = self.formula_rows[index]
            if col in hidden_cols:
                column["hidden"] = True
            columns.append(column)
        hidden = [column["name"] for column in columns if column.get("hidden")]
        if hidden:
            warnings.append(f"คอลัมน์ที่ถูกซ่อนในไฟล์ {len(hidden)} คอลัมน์ ({', '.join(hidden[:4])}) ระบบอ่านไว้แต่ไม่ใช้เป็นตัวหลักของแดชบอร์ด")
        last_col = self.first_col + len(columns) - 1
        area = {"first_row": self.first_row, "last_row": self.last_row, "first_col": self.first_col, "last_col": last_col,
                "ref": f"{layout.column_letter(self.first_col)}{self.header_row or self.first_row}:{layout.column_letter(last_col)}{self.last_row}"}
        result["sheets"].append({"id": self.id, "name": self.name, "rows_count": self.rows, "columns": columns, "header_row": self.header_row,
                                 "warnings": warnings, "summary_rows": self.summary_rows[:1000], "source_sheet": self.source_sheet, "area": area,
                                 "title_lines": self.title_lines, "footnotes": self.footnotes, **self.extra})
        result["rows_count"] += self.rows
        result["columns_count"] += len(columns)
        return True


def table_notes(table, index, first_row, names, visibility):
    notes = []
    if not table["header_rows"]:
        notes.append("ไม่พบแถวหัวคอลัมน์ จึงตั้งชื่อคอลัมน์อัตโนมัติ")
    elif first_row is not None and index == 0 and table["header_rows"][0] > first_row:
        notes.append(f"ใช้แถว {table['header_rows'][0]} เป็นหัวตาราง (ข้ามข้อความส่วนหัว {table['header_rows'][0] - first_row} แถวด้านบน)")
    if len(table["header_rows"]) > 1:
        notes.append(f"หัวตาราง {len(table['header_rows'])} ชั้น (แถว {table['header_rows'][0]}–{table['header_rows'][-1]}) รวมเป็นชื่อคอลัมน์")
    automatic = sum(name.startswith("คอลัมน์ ") for name in names)
    if automatic and table["header_rows"]:
        notes.append(f"หัวคอลัมน์ว่าง {automatic} คอลัมน์ จึงตั้งชื่ออัตโนมัติ")
    present = {name.casefold() for name in names}
    renamed = [name for name in names if (match := re.fullmatch(r"(.+) \(\d+\)", name)) and match[1].casefold() in present]
    if renamed:
        notes.append(f"หัวคอลัมน์ซ้ำ {len(renamed)} คอลัมน์ จึงเติมลำดับต่อท้าย เช่น {renamed[0]}")
    if visibility != "visible":
        notes.append("ชีตนี้ถูกซ่อนในไฟล์ต้นฉบับและรวมอยู่ในข้อมูลที่อ่านแล้ว")
    return notes


def overlaps(first, second):
    """Do two tables share any column?"""
    first_end = first["last_col"] or 10**9
    second_end = second["last_col"] or 10**9
    return first["first_col"] <= second_end and second["first_col"] <= first_end


def slice_extras(extras, first_col, last_col):
    if not extras:
        return None
    start = first_col - 1
    formats = extras.get("formats") or []
    formats = formats[start:last_col] if last_col else formats[start:]
    formulas = {index - start: text for index, text in (extras.get("formulas") or {}).items() if index >= start and (not last_col or index < last_col)}
    return {"formats": formats, "formulas": formulas}


def read_sheet(connection, state, result, sheet_name, iterator, visibility, plan, limits, uncached, facts=None, stats=None):
    """Load every table of one sheet following its layout: Excel tables, then a
    proposed layout, then the reader's own guess from the first rows."""
    facts = facts or workbook.empty_facts()
    sheet_facts = facts["sheets"].get(sheet_name, {})
    buffer = head_rows(iterator)
    view = [(number, values) for number, values, _, _ in buffer]
    chosen, source = excel_table_layout(facts, sheet_name), "excel_table"
    if chosen:
        chosen = layout.validate(chosen)
    if not chosen:
        chosen, source = (layout.validate(plan) if plan else None), "proposed"
    if not chosen:
        chosen, source = layout.guess(view), "guessed"
    if not chosen:
        result["warnings"].append(f"ชีต {sheet_name}: ข้ามชีตว่างเพราะไม่มีข้อมูล")
        return
    tables = chosen["tables"]
    starts = [(table["header_rows"] or [table["data_start"]])[0] for table in tables]
    ends = []
    for index, table in enumerate(tables):
        # A table ends where the next table over the same columns begins.
        following = [starts[other] for other in range(index + 1, len(tables)) if overlaps(table, tables[other]) and starts[other] > table["data_start"]]
        ends.append(table["data_end"] or (min(following) - 1 if following else None))
    first_row = next((number for number, values in view if layout.filled(values)), None)
    title_lines = []
    for number, values in view:
        if number >= starts[0] or len(title_lines) >= 5:
            break
        text = " ".join(str(value).strip() for value in values if not blank(value))
        if text:
            title_lines.append(text[:150])
    headers = [{} for _ in tables]
    writers = [None] * len(tables)
    # Guessed and proposed layouts come from the first rows only. Further down,
    # a label row after a gap starts a new table, and a repeat of the current
    # header (printed page breaks) is skipped.
    follow = source != "excel_table"
    gap, held, pending, repeated = False, [], None, {}

    def process(row_number, values, formulas, extras):
        taken = False
        for index, table in enumerate(tables):
            sliced = values[table["first_col"] - 1:table["last_col"]] if table["last_col"] else values[table["first_col"] - 1:]
            if row_number in table["header_rows"]:
                headers[index][row_number] = sliced
                continue
            if row_number < table["data_start"] or (ends[index] is not None and row_number > ends[index]):
                continue
            if writers[index] is None:
                header_values = [headers[index][number] for number in table["header_rows"] if number in headers[index]]
                width = max([len(v) for v in header_values] + [0])
                while width and all(width - 1 >= len(v) or blank(v[width - 1]) for v in header_values):
                    width -= 1
                names = layout.column_names(header_values, table["first_col"], width) if width else []
                # Names read by the layout request replace generated ones position by position.
                for position, name in enumerate(table.get("column_names") or []):
                    if name and position < len(names):
                        names[position] = name
                    elif name:
                        names.append(name)
                names = layout.column_names([names], table["first_col"], len(names)) if names else names
                title = sheet_name if index == 0 and len(tables) == 1 else f"{sheet_name} · {table['title'] or f'ตาราง {index + 1}'}"
                writers[index] = TableWriter(connection, state, title[:120], names, starts[index], table["first_col"], extendable=table["last_col"] is None,
                                             sheet_facts=sheet_facts, source_sheet=sheet_name)
                writers[index].notes = table_notes(table, index, first_row, names, visibility)
                writers[index].extra["layout_source"] = source
                if source == "excel_table":
                    writers[index].notes.insert(0, f"อ่านตามตาราง Excel ชื่อ {table['title']}")
                if index == 0:
                    writers[index].title_lines = title_lines
                elif table.get("title_lines"):
                    writers[index].title_lines = table["title_lines"]
            writers[index].add(row_number, sliced, formulas, limits, sheet_name, slice_extras(extras, table["first_col"], table["last_col"]))
            taken = True
        cells = [value for value in values if not blank(value)]
        if not taken and cells and all(isinstance(value, str) for value in cells) and NOTE_ROW.match(cells[0]):
            before = [index for index, table in enumerate(tables) if writers[index] is not None and table["data_start"] < row_number]
            if before and len(writers[before[-1]].footnotes) < 20:
                writers[before[-1]].footnotes.append(re.sub(r"\s+", " ", " ".join(str(value) for value in cells)).strip()[:200])

    def label_row(values):
        cells = layout.filled(values)
        return len(cells) >= 2 and sum(layout.textual(values[i]) for i in cells) / len(cells) >= .8 \
            and not TOTAL_ROW.match(str(values[cells[0]]).strip()) and not NOTE_ROW.match(str(values[cells[0]]))

    def same_header(values, index):
        """Every filled cell repeats the table's header text above it (a reprint may omit a few labels)."""
        table = tables[index]
        sliced = values[table["first_col"] - 1:table["last_col"]] if table["last_col"] else values[table["first_col"] - 1:]
        text = lambda value: "" if blank(value) else str(value).strip().casefold()
        filled = [position for position, value in enumerate(sliced) if not blank(value)]
        for header in headers[index].values():
            labels = [position for position, value in enumerate(header) if not blank(value)]
            if len(filled) >= 2 and len(filled) >= .6 * len(labels) \
                    and all(position < len(header) and text(sliced[position]) == text(header[position]) for position in filled):
                return True
        return False

    def inside(row_number):
        """The table whose data range holds this row, once its first data row was read."""
        return next((index for index, table in enumerate(tables) if writers[index] is not None and table["data_start"] <= row_number
                     and (ends[index] is None or row_number <= ends[index])), None)

    def start_table(row_number, values, titles):
        cells = layout.filled(values)
        ends[-1] = min(ends[-1], row_number - 1) if ends[-1] is not None else row_number - 1
        tables.append({"title": " ".join(titles)[:80], "header_rows": [row_number], "data_start": row_number + 1, "data_end": None,
                       "first_col": min(cells) + 1, "last_col": None, "column_names": None, "title_lines": titles})
        starts.append(row_number)
        ends.append(None)
        headers.append({row_number: values[min(cells):]})
        writers.append(None)

    for row in itertools.chain(buffer, iterator):
        row_number, values = row[0], row[1]
        current = inside(row_number) if follow else None
        if current is not None and current != len(tables) - 1 and same_header(values, current):
            repeated[current] = repeated.get(current, 0) + 1
            continue
        if not follow or writers[-1] is None or row_number < tables[-1]["data_start"] or len(tables) >= 30:
            process(*row)
            continue
        cells = layout.filled(values)
        if pending is not None:
            if cells and any(layout.numeric(values[i]) for i in cells):
                start_table(pending[0], pending[1], [" ".join(str(v).strip() for v in waiting[1] if not blank(v))[:150] for waiting in held])
            else:
                for waiting in held + [pending]:
                    process(*waiting)
            held, pending, gap = [], None, False
        if not cells:
            gap = True
            process(*row)
            continue
        if same_header(values, len(tables) - 1):
            repeated[len(tables) - 1] = repeated.get(len(tables) - 1, 0) + 1
            continue
        if gap and len(cells) == 1 and layout.textual(values[cells[0]]) and len(held) < 3:
            held.append(row)
            continue
        if gap and label_row(values):
            pending = row
            continue
        for waiting in held:
            process(*waiting)
        held, gap = [], False
        process(*row)
    for waiting in held + ([pending] if pending else []):
        process(*waiting)
    for index, count in repeated.items():
        if writers[index] is not None:
            writers[index].notes.append(f"ข้ามหัวตารางที่พิมพ์ซ้ำระหว่างหน้า {count:,} แถว")
    for writer in writers:
        if writer is None:
            continue
        # Formula counts are only complete once every row has been read.
        if uncached.get(sheet_name):
            writer.notes.append(f"สูตร {uncached[sheet_name]:,} เซลล์ไม่มีค่าที่คำนวณไว้ จึงเก็บเป็นค่าว่าง กรุณาเปิดไฟล์ใน Excel แล้วบันทึกใหม่ก่อนอัปโหลด")
        if stats and stats.get("merged") and writer is next(item for item in writers if item is not None):
            writer.notes.append(f"เติมค่าจากเซลล์ที่ผสาน (merge) ลงแถวด้านล่าง {stats['merged']:,} เซลล์ เพื่อให้ทุกแถวมีหมวดของตัวเอง")
        if not writer.finish(result):
            result["warnings"].append(f"ชีต {writer.name}: พบเฉพาะหัวคอลัมน์ ไม่มีแถวข้อมูล จึงข้ามชีตนี้")
    if not any(writers):
        result["warnings"].append(f"ชีต {sheet_name}: ไม่พบแถวข้อมูล จึงข้ามชีตนี้")


def clean_text(value):
    return "".join(char for char in value if ord(char) >= 32 or char in "\r\n\t")[:2000]


def image_tables(connection, state, result, notes, limits):
    """Tables a vision model read from pictures in the workbook. Kept apart from
    the cell data and flagged: their numbers come from an image, not a cell."""
    for note in notes:
        table = note.get("table")
        if not isinstance(table, dict) or not isinstance(table.get("columns"), list) or not isinstance(table.get("rows"), list):
            continue
        names = [clean_text(str(name))[:120] for name in table["columns"][:60] if isinstance(name, (str, int, float)) and not isinstance(name, bool)]
        rows = [row for row in table["rows"][:500] if isinstance(row, list)]
        if not names or not rows:
            continue
        where = " ".join(filter(None, [str(note.get("sheet") or "")[:60], str(note.get("cell") or "")[:10]]))
        writer = TableWriter(connection, state, f"จากรูปภาพ {where}".strip()[:120], layout.column_names([names], 1, len(names)), None, 1, extendable=False)
        for index, row in enumerate(rows, 1):
            values = [value if isinstance(value, (str, int, float)) and not isinstance(value, bool) else None for value in row[:len(names)]]
            writer.add(index, [clean_text(value) if isinstance(value, str) else value for value in values], 0, limits, writer.name)
        writer.notes = ["ข้อมูลตารางนี้ระบบอ่านจากรูปภาพในไฟล์ (OCR) ไม่ใช่ค่าจากเซลล์ กรุณาตรวจทานกับรูปต้นฉบับก่อนใช้ตัวเลข"]
        writer.extra.update(source="image_ocr", image_id=note.get("id"), image_cell=str(note.get("cell") or "")[:10] or None)
        writer.source_sheet = str(note.get("sheet") or "")[:120] or None
        if writer.finish(result):
            # Cells of a picture have no sheet range; the trace points at the picture instead.
            result["sheets"][-1]["area"] = None
            note["table_sheet"] = writer.id


def read_layout_file(value):
    """layout.json: {"layouts": {sheet: layout}, "images": [...]} (or the older {sheet: layout})."""
    if not isinstance(value, dict):
        return {}, []
    if isinstance(value.get("layouts"), dict) or isinstance(value.get("images"), list):
        layouts = value.get("layouts") if isinstance(value.get("layouts"), dict) else {}
        images = [note for note in value.get("images") or [] if isinstance(note, dict)][:workbook.MAX_IMAGES]
        return layouts, images
    return value, []


def mark_pivots(result, facts):
    for pivot in facts["pivots"]:
        found = workbook.bounds(pivot.get("ref"))
        for sheet in result["sheets"]:
            area = sheet.get("area")
            if sheet.get("source_sheet") != pivot["sheet"] or not area or not found:
                continue
            if found[0] <= area["last_row"] and area["first_row"] <= found[2]:
                sheet["pivot"] = pivot["name"]
                source = f" จากชีต {pivot['source_sheet']}" if pivot.get("source_sheet") else ""
                sheet["warnings"].append(f"ตารางนี้เป็น Pivot Table ({pivot['name']}) ที่สรุปข้อมูล{source} ค่าเป็นผลที่ Excel คำนวณไว้ล่าสุด")


def ingest(input_path, sqlite_path, filename, limits_values=None, progress=None, layouts=None):
    limits = limits_from({} if limits_values is None else limits_values)
    input_path, sqlite_path = Path(input_path), Path(sqlite_path)
    progress = progress or (lambda stage, value: None)
    layouts, image_notes = read_layout_file(layouts)
    progress("validating", 20)
    extension = Path(filename).suffix.casefold()
    if extension not in (".csv", ".xlsx", ".xls"):
        fail("UNSUPPORTED_FORMAT", "รองรับไฟล์ CSV, XLSX และ XLS เท่านั้น")
    if not input_path.is_file() or not input_path.stat().st_size:
        fail("EMPTY_FILE", "ไฟล์ว่าง กรุณาเลือกไฟล์ที่มีหัวคอลัมน์และแถวข้อมูล")
    if sqlite_path.exists():
        fail("INVALID_REQUEST", "พื้นที่เก็บข้อมูลชุดนี้มีอยู่แล้ว กรุณาเริ่มการอัปโหลดใหม่")
    books = []
    connection = None
    succeeded = False
    uncached = {}
    try:
        sources, books, notes, facts = open_sources(input_path, filename, limits, uncached)
        progress("reading", 35)
        connection = sqlite3.connect(sqlite_path)
        connection.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        result = {"filename": filename, "rows_count": 0, "columns_count": 0, "sheets": [], "warnings": list(notes), "created_at": datetime.now(timezone.utc).isoformat()}
        if facts["has_macros"]:
            result["warnings"].append("ไฟล์มี macro (VBA) ระบบอ่านเฉพาะค่าในเซลล์และไม่เรียกใช้ macro")
        if facts["external_links"]:
            result["warnings"].append(f"ไฟล์อ้างอิงสมุดงานภายนอก {facts['external_links']} ไฟล์ ใช้ค่าที่บันทึกไว้ล่าสุดโดยไม่เปิดไฟล์ภายนอก")
        state = {"rows": 0, "cells": 0, "next_id": 0}
        for source_index, (sheet_name, rows, visibility) in enumerate(sources):
            progress("understanding_columns", 50)
            stats = {}
            try:
                read_sheet(connection, state, result, sheet_name, sheet_rows(rows, facts, sheet_name, stats), visibility, layouts.get(sheet_name), limits, uncached, facts, stats)
            except DatasetError as error:
                # Limits and unsafe content stop the upload; a sheet the reader cannot follow is skipped.
                if error.code in ("LIMIT_EXCEEDED", "UNSUPPORTED_VALUE"):
                    raise
                result["warnings"].append(f"ชีต {sheet_name}: {error.message} จึงข้ามชีตนี้")
            progress("reading", 35 + int((source_index + 1) / len(sources) * 35))
        for name, sheet in facts["sheets"].items():
            if sheet.get("kind") == "chartsheet":
                result["warnings"].append(f"ชีต {name} เป็นชีตกราฟ ระบบบันทึกรายละเอียดกราฟไว้ในโครงสร้างไฟล์")
        if uncached.get("errors"):
            result["warnings"].append(f"พบเซลล์ข้อผิดพลาดของสูตร Excel (เช่น #DIV/0!) {uncached['errors']:,} เซลล์ เก็บเป็นค่าว่างและไม่นำมาคำนวณ")
        image_tables(connection, state, result, image_notes, limits)
        if not result["sheets"]:
            fail("EMPTY_DATASET", "ไม่พบแถวข้อมูล กรุณาเลือกไฟล์ที่มีข้อมูลอย่างน้อยหนึ่งตาราง")
        mark_pivots(result, facts)
        combine_sheets(connection, result)
        result["workbook"] = workbook.summarize(facts, result, image_notes)
        progress("detecting_types", 80)
        connection.execute("INSERT INTO metadata VALUES ('dataset', ?)", (json.dumps(result, ensure_ascii=False, allow_nan=False),))
        connection.commit()
        progress("preview", 95)
        succeeded = True
        return result
    except DatasetError:
        raise
    except UnicodeError:
        fail("INVALID_ENCODING", "อ่านรหัสอักขระ CSV ไม่สำเร็จ กรุณาบันทึกเป็น CSV UTF-8")
    except csv.Error:
        fail("INVALID_FILE", "โครงสร้าง CSV ไม่ถูกต้อง กรุณาตรวจเครื่องหมายคำพูด ตัวคั่น และขนาดข้อความในแต่ละเซลล์")
    except ImportError:
        fail("PARSER_UNAVAILABLE", "เซิร์ฟเวอร์ยังไม่มีเครื่องมืออ่าน XLSX กรุณาให้ผู้ดูแลติดตั้ง Python dependencies ของ backend แล้วลองใหม่")
    except (OSError, sqlite3.Error):
        fail("PROCESSING_FAILED", "อ่านหรือจัดเก็บข้อมูลไม่สำเร็จ กรุณาลองอัปโหลดใหม่")
    except Exception:
        fail("INVALID_FILE", "ไม่สามารถอ่านสมุดงานได้ กรุณาตรวจโครงสร้างหรือเปิดไฟล์ใน Excel แล้วบันทึกใหม่")
    finally:
        close_books(books)
        if connection is not None:
            connection.close()
        if not succeeded and connection is not None:
            sqlite_path.unlink(missing_ok=True)


def combine_sheets(connection, result):
    """Stack sheets that share the same header row into one extra table so a
    dashboard can compare them (e.g. one BOQ sheet per building). Adds a "ชีต"
    column and, when names follow PREFIX_SUFFIX, a "กลุ่มชีต" column. Summary
    rows stay out; source sheets are untouched and dataset totals ignore it."""
    groups = {}
    for sheet in result["sheets"]:
        if sheet.get("source") == "image_ocr" or sheet.get("pivot"):
            continue
        signature = tuple(column["name"].casefold() for column in sheet["columns"])
        if len(signature) >= 2:
            groups.setdefault(signature, []).append(sheet)
    members = max((group for group in groups.values() if len(group) >= 2), key=lambda group: (sum(s["rows_count"] for s in group), len(group)), default=None)
    if not members:
        return
    width = len(members[0]["columns"])
    names = [sheet["name"] for sheet in members]
    prefixes = [name.split("_", 1)[0] for name in names]
    by_prefix = all("_" in name for name in names) and 2 <= len(set(prefixes)) < len(names)
    sheet_id = f"s{max(int(sheet['id'][1:]) for sheet in result['sheets']) + 1}"
    columns = [{**column} for column in members[0]["columns"]] + [{"key": f"c{width}", "name": "ชีต", "data_type": "text"}]
    if by_prefix:
        columns.append({"key": f"c{width + 1}", "name": "กลุ่มชีต", "data_type": "text"})
    connection.execute(f'CREATE TABLE "data_{sheet_id}" (row_number INTEGER PRIMARY KEY, data TEXT NOT NULL)')
    rows = 0
    for sheet, prefix in zip(members, prefixes):
        # Identical header rows give identical positional keys (c0, c1, ...).
        extra = f"json_set(data, '$.c{width}', ?" + (f", '$.c{width + 1}', ?)" if by_prefix else ")")
        params = [sheet["name"], prefix] if by_prefix else [sheet["name"]]
        cursor = connection.execute(f'INSERT INTO "data_{sheet_id}" (data) SELECT {extra} FROM "data_{sheet["id"]}" WHERE row_number NOT IN (SELECT value FROM json_each(?)) ORDER BY row_number', [*params, json.dumps(sheet.get("summary_rows", []))])
        rows += cursor.rowcount
    for column in columns:
        types = {sheet["columns"][index]["data_type"] for sheet in members for index, candidate in enumerate(sheet["columns"]) if candidate["key"] == column["key"]}
        if types:
            column["data_type"] = next(iter(types)) if len(types) == 1 else "mixed"
    result["sheets"].append({"id": sheet_id, "name": f"รวมทุกชีต ({len(members)} ชีต)", "rows_count": rows, "columns": columns, "header_row": None,
                             "warnings": [f"รวมข้อมูลจาก {len(members)} ชีตที่มีหัวคอลัมน์เหมือนกัน: {', '.join(names[:8])}{' …' if len(names) > 8 else ''} โดยไม่นับแถวสรุปยอด"],
                             "summary_rows": [], "combined_from": names})


def preview(sqlite_path, query):
    if not isinstance(query, dict):
        fail("INVALID_REQUEST", "พารามิเตอร์ค้นหาต้องเป็น JSON object")
    if not Path(sqlite_path).is_file():
        fail("NOT_FOUND", "ไม่พบชุดข้อมูลนี้ กรุณาอัปโหลดใหม่")
    page, page_size = query.get("page", 1), query.get("page_size", 25)
    if isinstance(page, bool) or not isinstance(page, int) or page < 1 or page > 1_000_000:
        fail("INVALID_REQUEST", "หมายเลขหน้าต้องเป็นจำนวนเต็มตั้งแต่ 1 ถึง 1,000,000")
    if isinstance(page_size, bool) or not isinstance(page_size, int) or not 1 <= page_size <= 100:
        fail("INVALID_REQUEST", "จำนวนแถวต่อหน้าต้องอยู่ระหว่าง 1 ถึง 100")
    search = query.get("search", "")
    if not isinstance(search, str) or len(search) > 500:
        fail("INVALID_REQUEST", "คำค้นหาต้องเป็นข้อความไม่เกิน 500 ตัวอักษร")
    direction = query.get("direction", "asc")
    if direction not in ("asc", "desc"):
        fail("INVALID_REQUEST", "ทิศทางเรียงลำดับต้องเป็น asc หรือ desc")
    connection = sqlite3.connect(Path(sqlite_path).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        connection.create_function("casefold", 1, lambda value: str(value).casefold() if value is not None else "", deterministic=True)
        metadata = connection.execute("SELECT value FROM metadata WHERE key='dataset'").fetchone()
        if not metadata:
            fail("NOT_FOUND", "ไม่พบข้อมูลชุดนี้ กรุณาอัปโหลดใหม่")
        dataset = json.loads(metadata[0])
        sheet_id = query.get("sheet", dataset["sheets"][0]["id"])
        sheet = next((item for item in dataset["sheets"] if item["id"] == sheet_id), None)
        if sheet is None or not re.fullmatch(r"s\d+", sheet_id):
            fail("INVALID_REQUEST", "ไม่พบชีตที่ระบุ กรุณาเลือกชีตจากรายการ")
        columns = {column["key"]: column for column in sheet["columns"]}
        sort, column = query.get("sort", ""), query.get("column", "")
        if not isinstance(sort, str) or not isinstance(column, str):
            fail("INVALID_REQUEST", "ชื่อคอลัมน์สำหรับค้นหาหรือเรียงลำดับต้องเป็นข้อความ")
        if sort and sort not in columns or column and column not in columns:
            fail("INVALID_REQUEST", "ไม่พบคอลัมน์ที่ระบุ กรุณาเลือกคอลัมน์จากรายการ")
        keys = [column] if column else list(columns)
        where, params = "", []
        filters = query.get("filters") or []
        if filters:
            from dashboard import filter_clause
            semantics = query.get("columns") if isinstance(query.get("columns"), dict) else {}
            known = {key: {**value, **{field: semantics[key][field] for field in ("role", "time_format") if isinstance(semantics.get(key), dict) and field in semantics[key]}} for key, value in columns.items()}
            clause, filter_params = filter_clause(known, filters)
            where, params = f" WHERE ({clause})", filter_params
        if search:
            def search_expression(key):
                return f"CASE json_type(data, '$.{key}') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE casefold(json_extract(data, '$.{key}')) END"
            matches = " OR ".join(f"instr({search_expression(key)}, ?) > 0" for key in keys)
            where = f"{where} AND ({matches})" if where else f" WHERE ({matches})"
            params = [*params, *[search.casefold()] * len(keys)]
        order = "row_number ASC"
        if sort:
            expression = f"json_extract(data, '$.{sort}')"
            dtype = columns[sort]["data_type"]
            value = f"casefold({expression})" if dtype == "text" else f"julianday({expression})" if dtype == "date" else expression
            order = f"({expression} IS NULL) ASC, {value} {direction.upper()}, row_number ASC"
        table = f'"data_{sheet_id}"'
        total_rows = connection.execute(f"SELECT COUNT(*) FROM {table}{where}", params).fetchone()[0]
        items = connection.execute(f"SELECT row_number, data FROM {table}{where} ORDER BY {order} LIMIT ? OFFSET ?", [*params, page_size, (page - 1) * page_size]).fetchall()
        # Bound display payloads without modifying stored cells or the full
        # values used above for filtering/sorting. The UI must disclose this
        # preview-only abbreviation using the accompanying count and limit.
        max_cell_characters = min(2000, max(20, 1_000_000 // (page_size * len(columns) * 4)))
        truncated_cells = 0
        rows = []
        for row_number, stored in items:
            values = json.loads(stored)
            for key, value in values.items():
                if isinstance(value, str) and len(value) > max_cell_characters:
                    values[key] = value[:max_cell_characters - 1] + "…"
                    truncated_cells += 1
            rows.append({"row_number": row_number, "values": values})
        return {"rows": rows, "total_rows": total_rows, "page": page, "page_size": page_size,
                "truncated_cells": truncated_cells, "max_cell_characters": max_cell_characters}
    finally:
        connection.close()


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        if len(sys.argv) in (6, 7) and sys.argv[1] == "ingest":
            layouts = json.loads(Path(sys.argv[6]).read_text(encoding="utf-8")) if len(sys.argv) == 7 else None
            result = ingest(sys.argv[2], sys.argv[3], sys.argv[4], json.loads(sys.argv[5]), lambda stage, progress: emit({"stage": stage, "progress": progress}), layouts)
        elif len(sys.argv) == 6 and sys.argv[1] == "sample":
            found = sample(sys.argv[2], sys.argv[3], json.loads(sys.argv[5]), Path(sys.argv[4]).parent / "images")
            Path(sys.argv[4]).write_text(json.dumps(found, ensure_ascii=False), encoding="utf-8")
            result = {"sheets": len(found["sheets"]), "images": len(found["images"])}
        elif len(sys.argv) == 4 and sys.argv[1] == "preview":
            result = preview(sys.argv[2], json.loads(sys.argv[3]))
        elif len(sys.argv) == 4 and sys.argv[1] == "dashboard":
            from dashboard import run
            result = run(sys.argv[2], json.loads(Path(sys.argv[3]).read_text(encoding="utf-8")))
        elif len(sys.argv) == 3 and sys.argv[1] == "analyze":
            from analyzer import analyze
            result = analyze(sys.argv[2], lambda stage, progress: emit({"stage": stage, "progress": progress}))
        else:
            fail("INVALID_REQUEST", "รูปแบบคำสั่งไม่ถูกต้อง")
        emit({"result": result})
    except DatasetError as error:
        emit({"error": {"code": error.code, "message": error.message}})
        return 1
    except Exception:
        emit({"error": {"code": "PROCESSING_FAILED", "message": "ประมวลผลข้อมูลไม่สำเร็จ กรุณาลองใหม่"}})
        return 1
    return 0


if __name__ == "__main__":
    # Analyzer imports the shared protocol exception; keep one class identity
    # when this file is the CLI entrypoint rather than an imported module.
    sys.modules.setdefault("worker", sys.modules[__name__])
    sys.exit(main())
