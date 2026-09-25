"""Turns every other upload format into an .xlsx workbook the reader already understands.

Cells are copied as they are: spreadsheet formats (.xlsm .xltx .xltm .xlsb .ods), web and XML
exports (.html .htm .xml, and .xls files that are really HTML or SpreadsheetML), JSON, Word
tables (.docx) and PDF tables. Nothing is calculated here; plain number text becomes a number.

Scanned PDF pages and photos have no cells: each is placed as a picture on its own sheet, and
the picture reader (image-ai.mjs) reads its table. Those tables stay flagged as read from an image.

CLI: worker.py convert <input> <original filename> <output.xlsx>
"""
import io
import json
import re
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree

from worker import fail

SPREADSHEET_ZIP = {".xlsm", ".xltx", ".xltm"}
IMAGES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
CONVERTIBLE = SPREADSHEET_ZIP | IMAGES | {".xls", ".xlsb", ".ods", ".html", ".htm", ".xml", ".json", ".jsonl", ".ndjson", ".docx", ".pdf"}
MAX_CELLS = 2_000_000
MAX_PDF_PAGES = 300
MAX_PICTURE_PAGES = 12
MAX_PICTURE_SIDE = 2000
NUMBER = re.compile(r"^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$")
ILLEGAL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
SS = "urn:schemas-microsoft-com:office:spreadsheet"
ODS_TABLE = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
ODS_OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0"
ODS_TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def typed(value):
    """Number text ("1,234.50", "(300)") becomes a number; codes with leading zeros stay text."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    text = ILLEGAL.sub("", str(value)).strip()
    if not text:
        return None
    negative = text.startswith("(") and text.endswith(")")
    core = text[1:-1].strip() if negative else text
    digits = core.lstrip("+-")
    if NUMBER.match(core) and not (len(digits) > 1 and digits[0] == "0" and digits[1] != "."):
        number = float(core.replace(",", ""))
        number = -number if negative else number
        return int(number) if "." not in core and abs(number) < 2 ** 53 else number
    return text[:32_000]


class Book:
    """Collects sheets of rows (and pictures) and writes one .xlsx."""

    def __init__(self):
        self.sheets = []
        self.cells = 0

    def add(self, name, rows, title=None):
        rows = [[typed(value) for value in row] for row in rows]
        while rows and not any(value is not None for value in rows[-1]):
            rows.pop()
        if not any(any(value is not None for value in row) for row in rows):
            return
        self.cells += sum(len(row) for row in rows)
        if self.cells > MAX_CELLS:
            fail("TOO_MANY_CELLS", "ไฟล์มีข้อมูลมากเกินขีดจำกัด กรุณาแบ่งไฟล์ให้เล็กลง")
        self.sheets.append({"name": name, "rows": ([[title], []] if title else []) + rows})

    def picture(self, name, image):
        self.sheets.append({"name": name, "picture": image})

    def save(self, output):
        import openpyxl
        from openpyxl.drawing.image import Image
        book = openpyxl.Workbook()
        book.remove(book.active)
        used = set()
        for sheet in self.sheets:
            page = book.create_sheet(unique_name(sheet["name"], used))
            if "picture" in sheet:
                buffer = io.BytesIO()
                sheet["picture"].save(buffer, format="JPEG", quality=85)
                buffer.seek(0)
                picture = Image(buffer)
                picture.anchor = "A1"
                page.add_image(picture)
                continue
            for row in sheet["rows"]:
                page.append(row)
        book.save(output)


def unique_name(name, used):
    base = re.sub(r"[\[\]:*?/\\]", " ", str(name or "Sheet")).strip()[:31] or "Sheet"
    candidate, number = base, 2
    while candidate.casefold() in used:
        suffix = f" ({number})"
        candidate, number = base[:31 - len(suffix)] + suffix, number + 1
    used.add(candidate.casefold())
    return candidate


def grid(cells):
    """{(row, col): value} to a list of rows."""
    if not cells:
        return []
    rows = [[None] * (max(col for _, col in cells) + 1) for _ in range(max(row for row, _ in cells) + 1)]
    for (row, col), value in cells.items():
        rows[row][col] = value
    return rows


# --- spreadsheets ---------------------------------------------------------------------

def from_xlsb(path, book):
    try:
        from pyxlsb import open_workbook
    except ImportError:
        fail("UNSUPPORTED_FORMAT", "เซิร์ฟเวอร์ยังอ่านไฟล์ .xlsb ไม่ได้ กรุณาบันทึกเป็น .xlsx แล้วอัปโหลดใหม่")
    with open_workbook(str(path)) as workbook:
        for name in workbook.sheets:
            with workbook.get_sheet(name) as sheet:
                cells = {}
                for row in sheet.rows(sparse=True):
                    for cell in row:
                        if cell.v is not None:
                            cells[(cell.r, cell.c)] = cell.v
                book.add(name, grid(cells))


def from_ods(path, book):
    with zipfile.ZipFile(path) as archive:
        content = archive.read("content.xml")
    table_tag, row_tag = f"{{{ODS_TABLE}}}table", f"{{{ODS_TABLE}}}table-row"
    cell_tags = {f"{{{ODS_TABLE}}}table-cell", f"{{{ODS_TABLE}}}covered-table-cell"}
    for table in ElementTree.fromstring(content).iter(table_tag):
        rows, pending = [], 0
        for row in table.iter(row_tag):
            values, blank = [], 0
            for cell in row:
                if cell.tag not in cell_tags:
                    continue
                repeat = min(int(cell.get(f"{{{ODS_TABLE}}}number-columns-repeated", "1")), 1024)
                value = ods_value(cell)
                if value is None:
                    blank += repeat
                    continue
                values.extend([None] * blank + [value] * repeat)
                blank = 0
            # Files often end with "a million empty rows"; only rows before real data count.
            repeat = min(int(row.get(f"{{{ODS_TABLE}}}number-rows-repeated", "1")), 100_000)
            if not values:
                pending += repeat
                continue
            rows.extend([[]] * pending + [values] * repeat)
            pending = 0
        book.add(table.get(f"{{{ODS_TABLE}}}name"), rows)


def ods_value(cell):
    kind = cell.get(f"{{{ODS_OFFICE}}}value-type")
    if kind in ("float", "percentage", "currency"):
        return float(cell.get(f"{{{ODS_OFFICE}}}value"))
    if kind == "date":
        return cell.get(f"{{{ODS_OFFICE}}}date-value")
    if kind == "boolean":
        return cell.get(f"{{{ODS_OFFICE}}}boolean-value") == "true"
    text = "\n".join("".join(p.itertext()) for p in cell.iter(f"{{{ODS_TEXT}}}p"))
    return text or None


def from_spreadsheet_xml(root, book):
    """Excel 2003 XML (SpreadsheetML), which many systems save with an .xls name."""
    for sheet in root.iter(f"{{{SS}}}Worksheet"):
        cells, row_index = {}, -1
        for row in sheet.iter(f"{{{SS}}}Row"):
            row_index = int(row.get(f"{{{SS}}}Index", row_index + 2)) - 1
            col_index = -1
            for cell in row.iter(f"{{{SS}}}Cell"):
                col_index = int(cell.get(f"{{{SS}}}Index", col_index + 2)) - 1
                data = cell.find(f"{{{SS}}}Data")
                if data is not None and data.text is not None:
                    kind = data.get(f"{{{SS}}}Type")
                    cells[(row_index, col_index)] = float(data.text) if kind == "Number" else data.text[:10] if kind == "DateTime" else data.text
                col_index += int(cell.get(f"{{{SS}}}MergeAcross", "0"))
        book.add(sheet.get(f"{{{SS}}}Name"), grid(cells))


def from_records_xml(root, book):
    """Any other XML: the element with the most repeated same-name children is the table."""
    best = None
    for parent in root.iter():
        children = list(parent)
        if len(children) < 2:
            continue
        tag = max({child.tag for child in children}, key=lambda name: sum(child.tag == name for child in children))
        count = sum(child.tag == tag for child in children)
        if count >= 2 and (best is None or count > best[2]):
            best = (parent, tag, count)
    if best is None:
        return
    parent, tag, _ = best
    records = []
    for element in parent:
        if element.tag != tag:
            continue
        record = {local(key): value for key, value in element.attrib.items()}
        for child in element:
            record[local(child.tag)] = (child.text or "").strip() if len(child) == 0 else " ".join(text.strip() for text in child.itertext() if text.strip())
        if not record and element.text and element.text.strip():
            record[local(tag)] = element.text.strip()
        records.append(record)
    add_records(book, local(tag), records)


def local(tag):
    return tag.rsplit("}", 1)[-1]


# --- web pages ------------------------------------------------------------------------

class Tables(HTMLParser):
    """Every <table> of a page as rows of cell text; colspan leaves blanks after the value."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.done, self.order = [], [], 0

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.order += 1
            self.stack.append({"order": self.order, "rows": [], "cell": None, "span": 1})
        elif not self.stack:
            return
        elif tag == "tr":
            self.stack[-1]["rows"].append([])
        elif tag in ("td", "th"):
            table = self.stack[-1]
            if not table["rows"]:
                table["rows"].append([])
            table["cell"] = []
            span = dict(attrs).get("colspan") or "1"
            table["span"] = min(int(span), 100) if span.isdigit() else 1
        elif tag in ("br", "p", "div", "li") and self.stack[-1]["cell"] is not None:
            self.stack[-1]["cell"].append("\n")

    def handle_endtag(self, tag):
        if not self.stack:
            return
        table = self.stack[-1]
        if tag in ("td", "th") and table["cell"] is not None:
            text = re.sub(r"[ \t\r\f\v]+", " ", "".join(table["cell"])).strip()
            table["rows"][-1].extend([re.sub(r"\s*\n\s*", "\n", text)] + [None] * (table["span"] - 1))
            table["cell"] = None
        elif tag == "table":
            self.done.append(self.stack.pop())

    def handle_data(self, data):
        if self.stack and self.stack[-1]["cell"] is not None:
            self.stack[-1]["cell"].append(data)


def from_html(text, book):
    parser = Tables()
    parser.feed(text)
    parser.close()
    tables = [table for table in sorted(parser.done, key=lambda item: item["order"]) if len([row for row in table["rows"] if row]) >= 2]
    for index, table in enumerate(tables, 1):
        book.add(f"ตาราง {index}" if len(tables) > 1 else "ตาราง", table["rows"])


# --- JSON -----------------------------------------------------------------------------

def flat(record, prefix=""):
    out = {}
    for key, value in record.items():
        name = f"{prefix}{key}"
        if isinstance(value, dict):
            out.update(flat(value, f"{name}."))
        elif isinstance(value, list):
            out[name] = json.dumps(value, ensure_ascii=False)[:2000]
        else:
            out[name] = value
    return out


def add_records(book, name, records):
    records = [flat(record) if isinstance(record, dict) else {"value": record} for record in records]
    columns = list(dict.fromkeys(key for record in records for key in record))
    if columns:
        book.add(name, [columns] + [[record.get(column) for column in columns] for record in records])


def from_json(data, book, name="ข้อมูล"):
    if isinstance(data, list):
        if data and all(isinstance(item, list) for item in data):
            book.add(name, data)
        else:
            add_records(book, name, data)
        return
    if isinstance(data, dict):
        tables = {key: value for key, value in data.items() if isinstance(value, list) and value and all(isinstance(item, (dict, list)) for item in value)}
        for key, value in tables.items():
            from_json(value, book, key)
        if tables:
            return
        if all(not isinstance(value, (dict, list)) for value in data.values()):
            add_records(book, name, [data])
        else:
            add_records(book, name, [{"key": key, "value": json.dumps(value, ensure_ascii=False)[:2000] if isinstance(value, (dict, list)) else value} for key, value in data.items()])


# --- Word -----------------------------------------------------------------------------

def from_docx(path, book):
    with zipfile.ZipFile(path) as archive:
        root = ElementTree.fromstring(archive.read("word/document.xml"))
    body = root.find(f"{{{WORD}}}body")
    heading, count = None, 0
    for element in list(body) if body is not None else []:
        if element.tag == f"{{{WORD}}}p":
            text = "".join(node.text or "" for node in element.iter(f"{{{WORD}}}t")).strip()
            if text:
                heading = text
        elif element.tag == f"{{{WORD}}}tbl":
            count += 1
            rows = []
            for row in element.findall(f"{{{WORD}}}tr"):
                values = []
                for cell in row.findall(f"{{{WORD}}}tc"):
                    properties = cell.find(f"{{{WORD}}}tcPr")
                    span = properties.find(f"{{{WORD}}}gridSpan") if properties is not None else None
                    merged = properties.find(f"{{{WORD}}}vMerge") if properties is not None else None
                    text = "\n".join("".join(node.text or "" for node in paragraph.iter(f"{{{WORD}}}t")) for paragraph in cell.findall(f".//{{{WORD}}}p")).strip()
                    # A continued vertical merge holds nothing of its own.
                    if merged is not None and merged.get(f"{{{WORD}}}val") in (None, "continue"):
                        text = ""
                    extra = int(span.get(f"{{{WORD}}}val", "1")) - 1 if span is not None else 0
                    values.extend([text or None] + [None] * extra)
                rows.append(values)
            # The paragraph just above a table (its name or the project) becomes the sheet title.
            book.add(f"ตาราง {count}", rows, heading if heading and len(heading) <= 150 else None)
            heading = None
    if not book.sheets:
        fail("NO_TABLE", "ไม่พบตารางในไฟล์ Word นี้ ระบบวิเคราะห์ได้เฉพาะข้อมูลที่อยู่ในรูปตาราง")


# --- PDF and pictures -----------------------------------------------------------------

def from_pdf(path, book):
    try:
        import pdfplumber
    except ImportError:
        fail("UNSUPPORTED_FORMAT", "เซิร์ฟเวอร์ยังอ่านไฟล์ PDF ไม่ได้")
    with pdfplumber.open(str(path)) as pdf:
        pages = pdf.pages[:MAX_PDF_PAGES]
        if not pages:
            fail("EMPTY_FILE", "ไฟล์ PDF ไม่มีหน้า")
        text_layer = sum(len(page.chars) for page in pages) >= 30 * len(pages)
        tables = pdf_tables(pages) if text_layer else []
        for index, table in enumerate(tables, 1):
            book.add(f"ตาราง {index}" if len(tables) > 1 else "ตาราง", table["rows"], table["title"])
        if book.sheets:
            return "tables"
        # Scanned pages (or text without any table): the picture reader reads the tables.
        for number, page in enumerate(pages[:MAX_PICTURE_PAGES], 1):
            book.picture(f"หน้า {number}", fit(page.to_image(resolution=150).original))
        return "pictures"


def pdf_tables(pages):
    """Tables of every page; one continuing on the next page (same width) is joined and its repeated header dropped."""
    tables = []
    for number, page in enumerate(pages, 1):
        ruled = page.find_tables()
        found = [(table, table.bbox[1]) for table in ruled]
        if not found:
            # Tables drawn without lines: keep only grids that look like data, not prose.
            found = [(table, None) for table in page.find_tables({"vertical_strategy": "text", "horizontal_strategy": "text"})]
        for position, (table, top) in enumerate(found):
            rows = [[clean(value) for value in row] for row in table.extract()]
            rows = [row for row in rows if any(value for value in row)]
            if len(rows) < 2 or len(rows[0]) < 2 or (top is None and not looks_tabular(rows)):
                continue
            last = tables[-1] if tables else None
            if last and position == 0 and last["page"] == number - 1 and last["width"] == len(rows[0]):
                if rows[0] == last["rows"][0]:
                    rows = rows[1:]
                last["rows"].extend(rows)
                last["page"] = number
                continue
            tables.append({"rows": rows, "width": len(rows[0]), "page": number, "title": line_above(page, top) if position == 0 else None})
    return tables


def clean(value):
    return re.sub(r"\s*\n\s*", " ", value).strip() if isinstance(value, str) else value


def looks_tabular(rows):
    cells = [value for row in rows for value in row if value]
    numbers = sum(isinstance(typed(value), (int, float)) for value in cells)
    return len(rows) >= 3 and len(rows[0]) >= 3 and bool(cells) and numbers / len(cells) >= 0.2


def line_above(page, top):
    """The line just above a page's first table (a project or document name), when short."""
    if top is None or top < 20:
        return None
    try:
        text = page.crop((0, max(0, top - 60), page.width, top)).extract_text() or ""
    except Exception:
        return None
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return lines[-1] if lines and len(lines[-1]) <= 150 else None


def fit(image):
    from PIL import Image
    image = image.convert("RGB")
    image.thumbnail((MAX_PICTURE_SIDE, MAX_PICTURE_SIDE), Image.LANCZOS)
    return image


def from_image(path, book):
    from PIL import Image, ImageSequence
    try:
        with Image.open(path) as picture:
            frames = [fit(frame.copy()) for frame in ImageSequence.Iterator(picture)][:MAX_PICTURE_PAGES]
    except Exception:
        fail("INVALID_FILE", "เปิดไฟล์รูปภาพไม่ได้ หรือไฟล์เสียหาย")
    for number, frame in enumerate(frames, 1):
        book.picture("รูปภาพ" if len(frames) == 1 else f"หน้า {number}", frame)


# --- entry ----------------------------------------------------------------------------

def sniff(path, extension):
    """The real format: systems often save HTML or XML with an .xls name."""
    head = Path(path).read_bytes()[:2048]
    if head.startswith(b"%PDF"):
        return "pdf"
    if extension in (".xls", ".xml", ".html", ".htm"):
        if head.startswith(b"\xd0\xcf\x11\xe0"):
            return "xls"
        if head.startswith(b"PK\x03\x04"):
            return "xlsx"
        lowered = head.lstrip(b"\xef\xbb\xbf \t\r\n").lower()
        # SpreadsheetML has <Table> too; an XML declaration without <html> is XML.
        if b"<html" in lowered or lowered.startswith(b"<!doctype html") or (b"<table" in lowered and not lowered.startswith(b"<?xml")):
            return "html"
        if lowered.startswith(b"<"):
            return "xml"
    return extension.lstrip(".")


def read_text(path):
    raw = Path(path).read_bytes()
    for encoding in ("utf-8-sig", "cp874"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def convert(input_path, filename, output_path):
    """Writes output_path (.xlsx). Returns {"kind": "copy" | "tables" | "pictures", "sheets", "from"}."""
    extension = Path(filename).suffix.casefold()
    if extension not in CONVERTIBLE:
        fail("UNSUPPORTED_FORMAT", "ยังไม่รองรับไฟล์ชนิดนี้")
    kind = sniff(input_path, extension)
    output = Path(output_path)
    if kind in ("xlsx", "xlsm", "xltx", "xltm"):
        # Same package as .xlsx; macros are never run and are ignored by the reader.
        output.write_bytes(Path(input_path).read_bytes())
        return {"kind": "copy", "sheets": None, "from": extension}
    if kind == "xls":
        return {"kind": "xls", "sheets": None, "from": extension}
    book = Book()
    mode = "tables"
    try:
        if kind == "xlsb":
            from_xlsb(input_path, book)
        elif kind == "ods":
            from_ods(input_path, book)
        elif kind == "docx":
            from_docx(input_path, book)
        elif kind == "pdf":
            mode = from_pdf(input_path, book)
        elif extension in IMAGES:
            from_image(input_path, book)
            mode = "pictures"
        elif kind == "xml":
            root = ElementTree.fromstring(read_text(input_path).lstrip("﻿").encode("utf-8"))
            if root.tag == f"{{{SS}}}Workbook":
                from_spreadsheet_xml(root, book)
            else:
                from_records_xml(root, book)
        elif kind == "html":
            from_html(read_text(input_path), book)
        elif kind in ("jsonl", "ndjson"):
            add_records(book, "ข้อมูล", [json.loads(line) for line in read_text(input_path).splitlines() if line.strip()])
        elif kind == "json":
            from_json(json.loads(read_text(input_path)), book)
    except zipfile.BadZipFile:
        fail("INVALID_FILE", "ไฟล์เสียหาย หรือเนื้อหาไม่ตรงกับนามสกุล")
    except (ElementTree.ParseError, json.JSONDecodeError):
        fail("INVALID_FILE", "อ่านโครงสร้างไฟล์ไม่ได้ ไฟล์อาจเสียหายหรือไม่ใช่รูปแบบที่ระบุ")
    except KeyError:
        fail("INVALID_FILE", "ไฟล์ไม่สมบูรณ์ หรือไม่ใช่รูปแบบที่ระบุ")
    if not book.sheets:
        fail("NO_TABLE", "ไม่พบตารางข้อมูลในไฟล์นี้ ระบบวิเคราะห์ได้เฉพาะข้อมูลที่อยู่ในรูปตาราง")
    book.save(output)
    return {"kind": mode, "sheets": len(book.sheets), "from": extension}
