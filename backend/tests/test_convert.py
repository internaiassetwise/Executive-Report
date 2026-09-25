"""Every other upload format becomes an .xlsx the reader already knows (datasets/convert.py)."""
import json
import shutil
import sqlite3
import sys
import unittest
import uuid
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "datasets"))
from convert import convert, typed
from worker import DatasetError, ingest, sample

ROWS = [["Region", "Amount"], ["North", "1,200"], ["South", "800"], ["East", "(50)"]]


class ConvertTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).resolve().parents[2] / f"convert-test-{uuid.uuid4().hex}"
        self.root.mkdir()

    def tearDown(self):
        shutil.rmtree(self.root)

    def run_file(self, name, content, notes=None):
        """Convert, then ingest like the upload does; returns (conversion, dataset, rows of the first sheet)."""
        source = self.root / name
        source.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
        output = self.root / f"{uuid.uuid4().hex}.xlsx"
        found = convert(source, name, output)
        database = self.root / f"{uuid.uuid4().hex}.sqlite"
        layouts = {"layouts": {}, "images": notes(output)} if notes else None
        dataset = ingest(output, database, Path(name).stem + ".xlsx", None, None, layouts)
        sheet = dataset["sheets"][0]
        connection = sqlite3.connect(database)
        try:
            rows = [json.loads(data) for (data,) in connection.execute(f'SELECT data FROM "data_{sheet["id"]}" ORDER BY row_number')]
        finally:
            connection.close()
        return found, dataset, [[row.get(column["key"]) for column in sheet["columns"]] for row in rows]

    def assert_regions(self, rows):
        self.assertEqual([row[:2] for row in rows], [["North", 1200], ["South", 800], ["East", -50]])

    def test_number_text(self):
        self.assertEqual([typed(v) for v in ["1,234.50", "(300)", "0123", "0.5", "12 ชิ้น", "", " 7 "]], [1234.5, -300, "0123", 0.5, "12 ชิ้น", None, 7])

    def test_html_and_html_named_xls(self):
        html = "<html><body><p>รายงาน</p><table>" + "".join("<tr>" + "".join(f"<td>{v}</td>" for v in row) + "</tr>" for row in ROWS) + "</table></body></html>"
        for name in ("report.html", "export.xls"):
            found, dataset, rows = self.run_file(name, html)
            self.assertEqual(found["kind"], "tables")
            self.assertEqual([c["name"] for c in dataset["sheets"][0]["columns"]][:2], ["Region", "Amount"])
            self.assert_regions(rows)

    def test_spreadsheet_xml_named_xls(self):
        cells = "".join("<Row>" + "".join(f'<Cell><Data ss:Type="{"Number" if isinstance(typed(v), int) else "String"}">{typed(v)}</Data></Cell>' for v in row) + "</Row>" for row in ROWS)
        xml = f'<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Sales"><Table>{cells}</Table></Worksheet></Workbook>'
        found, dataset, rows = self.run_file("legacy_export.xls", xml)
        self.assertEqual(dataset["sheets"][0]["name"], "Sales")
        self.assert_regions(rows)

    def test_json_shapes(self):
        records = [{"Region": r, "Amount": a} for r, a in ROWS[1:]]
        for content in (json.dumps(records), json.dumps({"sales": records, "meta": {"v": 1}}), "\n".join(json.dumps(r) for r in records)):
            name = "data.jsonl" if content.count("\n") else "data.json"
            _, _, rows = self.run_file(name, content)
            self.assert_regions(rows)

    def test_ods(self):
        def cell(value):
            number = typed(value)
            if isinstance(number, (int, float)):
                return f'<table:table-cell office:value-type="float" office:value="{number}"><text:p>{value}</text:p></table:table-cell>'
            return f"<table:table-cell><text:p>{value}</text:p></table:table-cell>"
        body = "".join("<table:table-row>" + "".join(cell(v) for v in row) + '<table:table-cell table:number-columns-repeated="1000"/></table:table-row>' for row in ROWS)
        content = ('<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">'
                   f'<office:body><office:spreadsheet><table:table table:name="ยอดขาย">{body}<table:table-row table:number-rows-repeated="1048000"><table:table-cell/></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>')
        _, dataset, rows = self.run_file("book.ods", zipped({"mimetype": "application/vnd.oasis.opendocument.spreadsheet", "content.xml": content}))
        self.assertEqual(dataset["sheets"][0]["name"], "ยอดขาย")
        self.assert_regions(rows)

    def test_docx_tables_keep_heading(self):
        w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
        table = "<w:tbl>" + "".join("<w:tr>" + "".join(f"<w:tc><w:p><w:r><w:t>{v}</w:t></w:r></w:p></w:tc>" for v in row) + "</w:tr>" for row in ROWS) + "</w:tbl>"
        document = f'<w:document xmlns:w="{w}"><w:body><w:p><w:r><w:t>ยอดขายไตรมาส 1</w:t></w:r></w:p>{table}</w:body></w:document>'
        _, dataset, rows = self.run_file("memo.docx", zipped({"word/document.xml": document}))
        self.assertIn("ยอดขายไตรมาส 1", dataset["sheets"][0].get("title_lines") or [])
        self.assert_regions(rows)
        with self.assertRaises(DatasetError):
            self.run_file("empty.docx", zipped({"word/document.xml": f'<w:document xmlns:w="{w}"><w:body><w:p/></w:body></w:document>'}))

    def test_pdf_table_across_pages(self):
        from reportlab.lib.pagesizes import A4
        from reportlab.platypus import SimpleDocTemplate, Table, TableStyle
        path = self.root / "boq.pdf"
        rows = [["Item", "Qty", "Amount"]] + [[f"Item {i}", str(i), f"{i * 100:,}"] for i in range(1, 91)]
        table = Table(rows, repeatRows=1)
        table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, "black")]))
        SimpleDocTemplate(str(path), pagesize=A4).build([table])
        found, dataset, data = self.run_file("boq.pdf", path.read_bytes())
        self.assertEqual(found["kind"], "tables")
        self.assertEqual(found["sheets"], 1, "a table running over several pages is one table")
        self.assertEqual(len(data), 90, "the header repeated on each page is not a row")
        self.assertEqual(sum(row[2] for row in data), sum(i * 100 for i in range(1, 91)))

    def test_pictures_are_read_by_the_picture_reader(self):
        from PIL import Image, ImageDraw
        picture = Image.new("RGB", (900, 400), "white")
        ImageDraw.Draw(picture).text((20, 20), "Region Amount", fill="black")
        path = self.root / "scan.png"
        picture.save(path)

        def notes(workbook_path):
            images = sample(workbook_path, "scan.xlsx", None, self.root / "images")["images"]
            self.assertEqual(len(images), 1)
            return [{"id": images[0]["id"], "sheet": images[0]["sheet"], "cell": images[0]["cell"], "kind": "table",
                     "table": {"columns": ROWS[0], "rows": [[r, str(typed(a))] for r, a in ROWS[1:]]}}]
        found, dataset, rows = self.run_file("scan.png", path.read_bytes(), notes)
        self.assertEqual(found["kind"], "pictures")
        sheet = next(sheet for sheet in dataset["sheets"] if sheet.get("source") == "image_ocr")
        self.assertEqual(sheet["columns"][0]["name"], "Region")

    def test_broken_files_fail_clearly(self):
        for name, content in (("bad.docx", b"not a zip"), ("bad.json", "{oops"), ("bad.ods", b"PK\x03\x04broken")):
            with self.assertRaises(DatasetError):
                self.run_file(name, content)


def zipped(files):
    import io
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, text in files.items():
            archive.writestr(name, text)
    return buffer.getvalue()


if __name__ == "__main__":
    unittest.main()
