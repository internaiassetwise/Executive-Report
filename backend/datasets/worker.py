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
                yield row_number, values, 0


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
            if any("vba" in name.casefold() or "macrosheet" in name.casefold() for name in names):
                fail("UNSUPPORTED_FORMAT", "ไม่รองรับสมุดงานที่มี macro กรุณาบันทึกเป็น XLSX ที่ไม่มี macro")
            content_types = archive.read("[Content_Types].xml")
            if b"macroenabled" in content_types.lower() or b"macrosheet" in content_types.lower():
                fail("UNSUPPORTED_FORMAT", "ไม่รองรับสมุดงานที่มี macro กรุณาบันทึกเป็น XLSX ที่ไม่มี macro")
            if archive.testzip() is not None:
                fail("INVALID_FILE", "ไฟล์ XLSX เสียหาย กรุณาเปิดไฟล์ใน Excel แล้วบันทึกใหม่")
            # read_only iteration can silently skip repeated/out-of-order rows
            # and synthesize enormous gaps for forged coordinates. Validate
            # worksheet structure before trusting that iterator.
            for name in names:
                if name.startswith("xl/worksheets/") and name.endswith(".xml"):
                    with archive.open(name) as source:
                        validate_sheet_coordinates(source)
    except (zipfile.BadZipFile, OSError, RuntimeError, KeyError, ElementTree.ParseError):
        fail("INVALID_FILE", "อ่านโครงสร้างไฟล์ XLSX ไม่สำเร็จ กรุณาตรวจว่าไฟล์ไม่เสียหาย")


def validate_sheet_coordinates(source):
    previous_row = 0
    current_row = None
    previous_column = 0
    for event, element in ElementTree.iterparse(source, events=("start", "end")):
        tag = element.tag.rsplit("}", 1)[-1]
        if event == "start" and tag == "row":
            row = element.get("r", str(previous_row + 1))
            if not row.isascii() or not row.isdigit() or not previous_row < int(row) <= 1_048_576:
                fail("INVALID_FILE", "โครงสร้าง XLSX มีเลขแถวซ้ำ ผิดลำดับ หรือเกินขอบเขต Excel กรุณาเปิดไฟล์แล้วบันทึกใหม่")
            current_row = previous_row = int(row)
            previous_column = 0
        elif event == "start" and tag == "c":
            if current_row is None:
                fail("INVALID_FILE", "โครงสร้างเซลล์ XLSX ไม่ถูกต้อง กรุณาเปิดไฟล์ใน Excel แล้วบันทึกใหม่")
            coordinate = element.get("r")
            column = previous_column + 1
            if coordinate:
                match = re.fullmatch(r"([A-Za-z]{1,3})([1-9][0-9]{0,6})", coordinate)
                if not match or int(match[2]) != current_row:
                    fail("INVALID_FILE", "ตำแหน่งเซลล์ XLSX ไม่ตรงกับแถว กรุณาเปิดไฟล์ใน Excel แล้วบันทึกใหม่")
                column = 0
                for char in match[1].upper():
                    column = column * 26 + ord(char) - ord("A") + 1
            if not previous_column < column <= 16_384:
                fail("INVALID_FILE", "โครงสร้าง XLSX มีคอลัมน์ซ้ำ ผิดลำดับ หรือเกินขอบเขต Excel กรุณาเปิดไฟล์แล้วบันทึกใหม่")
            previous_column = column
        elif event == "end":
            if tag == "row":
                current_row = None
            element.clear()


def xlsx_rows(sheet, formula_sheet, uncached):
    """Yield the values Excel last calculated. Formulas are never evaluated here;
    a formula cell without a saved result is stored empty and counted in `uncached`."""
    import itertools
    # Ignore inaccurate worksheet dimensions, including styled empty tails.
    sheet.reset_dimensions()
    formula_sheet.reset_dimensions()
    for index, (cells, formula_cells) in enumerate(itertools.zip_longest(sheet.iter_rows(), formula_sheet.iter_rows(), fillvalue=()), 1):
        values = []
        formulas = 0
        for cell, source in itertools.zip_longest(cells, formula_cells):
            value = cell.value if cell is not None else None
            if cell is not None and cell.data_type == "e" or isinstance(value, str) and EXCEL_ERROR.fullmatch(value):
                value = None
                uncached["errors"] = uncached.get("errors", 0) + 1
            if source is not None and source.data_type == "f":
                formulas += 1
                if value is None:
                    uncached[sheet.title] = uncached.get(sheet.title, 0) + 1
            values.append(value)
        while values and blank(values[-1]):
            values.pop()
        yield index, values, formulas


def xls_rows(book, sheet):
    import xlrd
    for index in range(sheet.nrows):
        values = []
        for cell in sheet.row(index):
            if cell.ctype == xlrd.XL_CELL_DATE:
                value = xlrd.xldate_as_datetime(cell.value, book.datemode)
                values.append(value.date() if value.time() == datetime.min.time() else value)
            elif cell.ctype == xlrd.XL_CELL_NUMBER:
                values.append(int(cell.value) if float(cell.value).is_integer() and abs(cell.value) <= MAX_SAFE_INTEGER else cell.value)
            elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                values.append(bool(cell.value))
            elif cell.ctype == xlrd.XL_CELL_TEXT:
                values.append(cell.value)
            else:
                values.append(None)
        while values and blank(values[-1]):
            values.pop()
        yield index + 1, values, 0


def open_sources(input_path, filename, limits, uncached):
    """(sheet name, row iterator factory, visibility) per sheet, the open workbooks, and notes."""
    extension = Path(filename).suffix.casefold()
    books, notes = [], []
    if extension == ".xlsx":
        xlsx_preflight(input_path, limits)
        import openpyxl
        book = openpyxl.load_workbook(input_path, read_only=True, data_only=True, keep_links=False)
        formula_book = openpyxl.load_workbook(input_path, read_only=True, data_only=False, keep_links=False)
        books = [book, formula_book]
        pairs = list(zip(book.worksheets, formula_book.worksheets))
        sources = [(sheet.title, (lambda s=sheet, f=formulas: xlsx_rows(s, f, uncached)), sheet.sheet_state) for sheet, formulas in pairs]
    elif extension == ".xls":
        import xlrd
        book = xlrd.open_workbook(str(input_path), on_demand=True)
        books = [book]
        sheets = [book.sheet_by_index(index) for index in range(book.nsheets)]
        if sum(sheet.nrows * sheet.ncols for sheet in sheets) > limits["max_cells"] * 2:
            fail("LIMIT_EXCEEDED", f"จำนวนเซลล์ข้อมูลรวมเกิน {limits['max_cells']:,} เซลล์ กรุณาแบ่งไฟล์")
        sources = [(sheet.name, (lambda s=sheet: xls_rows(book, s)), "visible" if sheet.visibility == 0 else "hidden") for sheet in sheets]
    else:
        sources = [("CSV", lambda: csv_rows(input_path), "visible")]
    if len(sources) > limits["max_sheets"]:
        notes.append(f"ไฟล์มี {len(sources):,} ชีต อ่าน {limits['max_sheets']} ชีตแรก ชีตที่เหลือไม่ได้นำมาวิเคราะห์")
        sources = sources[:limits["max_sheets"]]
    return sources, books, notes


def close_books(books):
    for workbook in books:
        (workbook.release_resources if hasattr(workbook, "release_resources") else workbook.close)()


def head_rows(iterator):
    buffer = []
    for row_number, values, formulas in iterator:
        buffer.append((row_number, list(values), formulas))
        if len(buffer) >= layout.SAMPLE_ROWS:
            break
    return buffer


def sample(input_path, filename, limits_values=None):
    """First rows of each sheet for the layout request. Sheets whose header block
    reads the same are sent once, with the other names listed as members."""
    limits = limits_from({} if limits_values is None else limits_values)
    sources, books, _ = open_sources(Path(input_path), filename, limits, {})
    try:
        groups, order = {}, []
        for name, rows, _ in sources:
            buffer = head_rows(rows())
            view = [(number, values) for number, values, _ in buffer]
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
        return {"filename": filename, "sheets": sheets}
    finally:
        close_books(books)


class TableWriter:
    """One detected table stored as a data_sN SQLite table."""

    def __init__(self, connection, state, name, names, header_row, first_col, extendable):
        self.connection, self.state, self.name = connection, state, name
        self.id = f"s{state['next_id']}"
        state["next_id"] += 1
        self.names, self.first_col, self.extendable = list(names), first_col, extendable
        self.max_columns = None
        self.kinds = [set() for _ in self.names]
        self.header_row = header_row
        self.notes = []
        self.rows = self.formulas = self.blank_rows = self.truncated = self.added_columns = 0
        self.summary_rows, self.summary_labels = [], []
        connection.execute(f'CREATE TABLE "data_{self.id}" (row_number INTEGER PRIMARY KEY, data TEXT NOT NULL)')

    def add(self, row_number, values, formulas, limits, sheet_name):
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
                for index in range(len(self.names), len(values)):
                    self.names.append(f"คอลัมน์ {layout.column_letter(self.first_col + index)}")
                    self.kinds.append(set())
                    self.added_columns += 1
            else:
                self.truncated += 1
                values = values[:len(self.names)]
        if self.state["rows"] + 1 > limits["max_rows"]:
            fail("LIMIT_EXCEEDED", f"จำนวนแถวข้อมูลรวมเกิน {limits['max_rows']:,} แถว กรุณาแบ่งไฟล์")
        self.state["cells"] += len(self.names)
        if self.state["cells"] > limits["max_cells"]:
            fail("LIMIT_EXCEEDED", f"จำนวนเซลล์ข้อมูลรวมเกิน {limits['max_cells']:,} เซลล์ กรุณาแบ่งไฟล์")
        first = next((value for value in values if not blank(value)), None)
        if isinstance(first, str) and TOTAL_ROW.match(first.strip()):
            self.summary_rows.append(row_number)
            self.summary_labels.append(first.strip()[:60])
        record = {}
        for index in range(len(self.names)):
            value, kind = normalize(values[index] if index < len(values) else None, f"ชีต {sheet_name} แถว {row_number} คอลัมน์ {index + 1}")
            record[f"c{index}"] = value
            if kind != "empty":
                self.kinds[index].add(kind)
        self.connection.execute(f'INSERT INTO "data_{self.id}" VALUES (?, ?)', (row_number, json.dumps(record, ensure_ascii=False, allow_nan=False)))
        self.rows += 1
        self.state["rows"] += 1
        self.formulas += formulas

    def check_columns(self, count):
        if count > self.max_columns:
            fail("LIMIT_EXCEEDED", f"ตาราง {self.name} มี {count:,} คอลัมน์ เกินขีดจำกัด {self.max_columns:,} คอลัมน์ กรุณาลดจำนวนคอลัมน์")

    def finish(self, result):
        if not self.rows:
            self.connection.execute(f'DROP TABLE "data_{self.id}"')
            return False
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
        columns = [{"key": f"c{index}", "name": name, "data_type": next(iter(kinds)) if len(kinds) == 1 else "mixed" if kinds else "empty"}
                   for index, (name, kinds) in enumerate(zip(self.names, self.kinds))]
        result["sheets"].append({"id": self.id, "name": self.name, "rows_count": self.rows, "columns": columns, "header_row": self.header_row,
                                 "warnings": warnings, "summary_rows": self.summary_rows[:1000]})
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


def read_sheet(connection, state, result, sheet_name, iterator, visibility, plan, limits, uncached):
    """Load every table of one sheet following its layout (given, or guessed from the first rows)."""
    buffer = head_rows(iterator)
    view = [(number, values) for number, values, _ in buffer]
    chosen = (layout.validate(plan) if plan else None) or layout.guess(view)
    if not chosen:
        result["warnings"].append(f"ชีต {sheet_name}: ข้ามชีตว่างเพราะไม่มีข้อมูล")
        return
    tables = chosen["tables"]
    starts = [(table["header_rows"] or [table["data_start"]])[0] for table in tables]
    ends = [table["data_end"] or (starts[index + 1] - 1 if index + 1 < len(tables) else None) for index, table in enumerate(tables)]
    first_row = next((number for number, values in view if layout.filled(values)), None)
    headers = [{} for _ in tables]
    writers = [None] * len(tables)
    for row_number, values, formulas in itertools.chain(buffer, iterator):
        for index, table in enumerate(tables):
            sliced = values[table["first_col"] - 1:table["last_col"]] if table["last_col"] else values[table["first_col"] - 1:]
            if row_number in table["header_rows"]:
                headers[index][row_number] = sliced
                break
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
                title = sheet_name if len(tables) == 1 else f"{sheet_name} · {table['title'] or f'ตาราง {index + 1}'}"
                writers[index] = TableWriter(connection, state, title[:120], names, starts[index], table["first_col"], extendable=table["last_col"] is None)
                writers[index].notes = table_notes(table, index, first_row, names, visibility)
            writers[index].add(row_number, sliced, formulas, limits, sheet_name)
            break
    for writer in writers:
        if writer is None:
            continue
        # Formula counts are only complete once every row has been read.
        if uncached.get(sheet_name):
            writer.notes.append(f"สูตร {uncached[sheet_name]:,} เซลล์ไม่มีค่าที่คำนวณไว้ จึงเก็บเป็นค่าว่าง กรุณาเปิดไฟล์ใน Excel แล้วบันทึกใหม่ก่อนอัปโหลด")
        if not writer.finish(result):
            result["warnings"].append(f"ชีต {writer.name}: พบเฉพาะหัวคอลัมน์ ไม่มีแถวข้อมูล จึงข้ามชีตนี้")
    if not any(writers):
        result["warnings"].append(f"ชีต {sheet_name}: ไม่พบแถวข้อมูล จึงข้ามชีตนี้")


def ingest(input_path, sqlite_path, filename, limits_values=None, progress=None, layouts=None):
    limits = limits_from({} if limits_values is None else limits_values)
    input_path, sqlite_path = Path(input_path), Path(sqlite_path)
    progress = progress or (lambda stage, value: None)
    layouts = layouts if isinstance(layouts, dict) else {}
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
        sources, books, notes = open_sources(input_path, filename, limits, uncached)
        progress("reading", 35)
        connection = sqlite3.connect(sqlite_path)
        connection.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        result = {"filename": filename, "rows_count": 0, "columns_count": 0, "sheets": [], "warnings": list(notes), "created_at": datetime.now(timezone.utc).isoformat()}
        state = {"rows": 0, "cells": 0, "next_id": 0}
        for source_index, (sheet_name, rows, visibility) in enumerate(sources):
            progress("understanding_columns", 50)
            try:
                read_sheet(connection, state, result, sheet_name, rows(), visibility, layouts.get(sheet_name), limits, uncached)
            except DatasetError as error:
                # Limits and unsafe content stop the upload; a sheet the reader cannot follow is skipped.
                if error.code in ("LIMIT_EXCEEDED", "UNSUPPORTED_VALUE"):
                    raise
                result["warnings"].append(f"ชีต {sheet_name}: {error.message} จึงข้ามชีตนี้")
            progress("reading", 35 + int((source_index + 1) / len(sources) * 35))
        if uncached.get("errors"):
            result["warnings"].append(f"พบเซลล์ข้อผิดพลาดของสูตร Excel (เช่น #DIV/0!) {uncached['errors']:,} เซลล์ เก็บเป็นค่าว่างและไม่นำมาคำนวณ")
        if not result["sheets"]:
            fail("EMPTY_DATASET", "ไม่พบแถวข้อมูล กรุณาเลือกไฟล์ที่มีข้อมูลอย่างน้อยหนึ่งตาราง")
        combine_sheets(connection, result)
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
            found = sample(sys.argv[2], sys.argv[3], json.loads(sys.argv[5]))
            Path(sys.argv[4]).write_text(json.dumps(found, ensure_ascii=False), encoding="utf-8")
            result = {"sheets": len(found["sheets"])}
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
