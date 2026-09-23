"""The reader against the fixture corpus in tests/fixtures/excel/.

Each test pins what the ingestion harness must get right for one kind of file:
table positions, column names and types, values, and the workbook facts in the
IR. Rebuild the corpus with tests/fixtures/build_excel_fixtures.py.
"""
import shutil
import sys
import time
import unittest
import uuid
from datetime import date
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "datasets"))
from worker import DatasetError, ingest, preview, sample

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "excel"


class ExcelFixtureTests(unittest.TestCase):
    def setUp(self):
        workspace = Path(__file__).resolve().parents[2]
        self.root = workspace / f"fixture-test-{uuid.uuid4().hex}"
        self.root.mkdir()
        self.database = self.root / "dataset.sqlite"

    def tearDown(self):
        shutil.rmtree(self.root)

    def read(self, name, layouts=None, limits=None):
        self.database.unlink(missing_ok=True)
        return ingest(FIXTURES / name, self.database, name, limits, None, layouts)

    def rows(self, sheet_id):
        return [(row["row_number"], list(row["values"].values())) for row in preview(self.database, {"sheet": sheet_id, "page_size": 100})["rows"]]

    @staticmethod
    def names(sheet):
        return [column["name"] for column in sheet["columns"]]

    def warnings(self, sheet):
        return " ".join(sheet["warnings"])

    def test_simple_xlsx_and_csv_read_the_same(self):
        for name in ("simple.xlsx", "simple.csv"):
            with self.subTest(name=name):
                result = self.read(name)
                sheet = result["sheets"][0]
                self.assertEqual(self.names(sheet), ["Order", "Region", "Product", "Amount", "Date"])
                self.assertEqual([c["data_type"] for c in sheet["columns"]], ["text", "text", "text", "number", "date"])
                self.assertEqual(sheet["rows_count"], 6)
                self.assertEqual(self.rows(sheet["id"])[0], (2, ["SO-001", "North", "Cement", 1200, "2026-01-05"]))
                self.assertEqual(sheet["area"]["ref"], "A1:E7")

    def test_multi_sheet_stacks_sheets_with_the_same_columns(self):
        result = self.read("multi_sheet.xlsx")
        self.assertEqual([s["name"] for s in result["sheets"]], ["Jan", "Feb", "Mar", "Summary", "รวมทุกชีต (3 ชีต)"])
        combined = result["sheets"][-1]
        self.assertEqual(combined["combined_from"], ["Jan", "Feb", "Mar"])
        self.assertEqual(combined["rows_count"], 9)
        self.assertEqual(result["rows_count"], 12)

    def test_formulas_use_saved_results_and_record_the_formula(self):
        result = self.read("formulas.xlsx")
        data, summary = result["sheets"]
        amount = data["columns"][3]
        self.assertEqual((amount["formula"], amount["formula_rows"]), ("=B2*C2", 3))
        self.assertNotIn("formula", data["columns"][1], "a total line's SUM is not the column's formula")
        rows = self.rows(data["id"])
        self.assertEqual([row[1][3] for row in rows], [250, 600, 0, 850])
        self.assertIsNone(rows[2][1][4], "#DIV/0! is stored empty")
        self.assertIn("#DIV/0!", " ".join(result["warnings"]))
        self.assertNotIn("ไม่มีค่าที่คำนวณไว้", self.warnings(data), "an error result is not a missing result")
        self.assertEqual(data["summary_rows"], [5])
        self.assertEqual(self.rows(summary["id"])[0][1], ["Grand total", 850])
        self.assertIn({"from": "Summary", "to": "Data", "via": "formula", "count": 2}, result["workbook"]["relationships"])

    def test_merged_cells_fill_categories_and_group_headers(self):
        result = self.read("merged_cells.xlsx")
        sheet = result["sheets"][0]
        self.assertEqual(self.names(sheet), ["Category", "Item", "Price / Vendor A", "Price / Vendor B"])
        self.assertEqual([row[1][0] for row in self.rows(sheet["id"])], ["Structure"] * 3 + ["Finishing"] * 2)
        self.assertIn("merge", self.warnings(sheet))
        self.assertEqual(result["workbook"]["sheets"][0]["merged_ranges"], 5)

    def test_hidden_sheets_rows_and_columns_are_read_and_flagged(self):
        result = self.read("hidden_sheet.xlsx")
        visible, lookup = result["sheets"]
        self.assertEqual(visible["rows_count"], 5, "hidden rows stay in the data")
        self.assertTrue(visible["columns"][2]["hidden"])
        self.assertIn("ถูกซ่อน", self.warnings(visible))
        self.assertIn("ถูกซ่อน", self.warnings(lookup))
        facts = {sheet["name"]: sheet for sheet in result["workbook"]["sheets"]}
        self.assertEqual((facts["Visible"]["hidden_rows"], facts["Visible"]["hidden_columns"]), (1, ["C"]))
        self.assertEqual(facts["Lookup"]["state"], "hidden")

    def test_several_tables_in_one_sheet_including_below_the_sample(self):
        result = self.read("multiple_tables.xlsx")
        self.assertEqual([s["name"] for s in result["sheets"]], ["Report", "Report · Vendor prices", "Report · Payments"])
        self.assertEqual([self.names(s) for s in result["sheets"]], [["Item", "Qty", "Unit"], ["Vendor", "Cement", "Sand", "Steel"], ["Date", "Paid"]])
        self.assertEqual([s["rows_count"] for s in result["sheets"]], [3, 2, 2])
        self.assertEqual(result["sheets"][0]["title_lines"], ["Quantities"])
        self.assertEqual(result["sheets"][2]["columns"][0]["data_type"], "date")

    def test_excel_tables_define_the_layout_and_names_are_kept(self):
        result = self.read("excel_tables.xlsx")
        sheet = result["sheets"][0]
        self.assertEqual(sheet["layout_source"], "excel_table")
        self.assertEqual(self.names(sheet), ["Region", "Rep", "Units", "Revenue"])
        self.assertEqual(sheet["rows_count"], 5, "the totals row is not data")
        self.assertEqual(sheet["area"]["ref"], "B3:E8")
        ir = result["workbook"]
        self.assertEqual(ir["excel_tables"][0]["name"], "Sales")
        self.assertEqual(ir["defined_names"][0]["name"], "Revenue")
        self.assertEqual(ir["comments"][0]["text"], "Ann covers two provinces")
        self.assertEqual(ir["hyperlinks"][0]["target"], "https://example.com/regions/north")

    def test_images_are_listed_and_their_reading_becomes_a_flagged_table(self):
        result = self.read("images.xlsx")
        images = result["workbook"]["images"]
        self.assertEqual([(image["cell"], image["content_type"]) for image in images], [("D2", "image/png"), ("D12", "image/jpeg")])
        self.assertFalse(images[0]["read"])
        extracted = sample(FIXTURES / "images.xlsx", "images.xlsx", None, self.root / "images")["images"]
        self.assertEqual([image["id"] for image in extracted], ["img1"], "tiny images such as logos are not sent")
        self.assertTrue(Path(extracted[0]["path"]).is_file())
        notes = [{"id": "img1", "sheet": "Site", "cell": "D2", "kind": "table", "description": "ตารางราคาวัสดุ", "text": "Item Qty Price",
                  "table": {"columns": ["Item", "Qty", "Price"], "rows": [["Cement", "120", "150"], ["Sand", "30", "400"]]}}]
        result = self.read("images.xlsx", {"images": notes})
        table = next(sheet for sheet in result["sheets"] if sheet.get("source") == "image_ocr")
        self.assertEqual(self.names(table), ["Item", "Qty", "Price"])
        self.assertEqual(self.rows(table["id"])[0][1], ["Cement", 120, 150])
        self.assertIn("OCR", self.warnings(table))
        described = result["workbook"]["images"][0]
        self.assertEqual((described["read"], described["description"], described["table_sheet"]), (True, "ตารางราคาวัสดุ", table["id"]))

    def test_charts_are_described_and_mapped_to_columns(self):
        result = self.read("charts.xlsx")
        charts = result["workbook"]["charts"]
        self.assertEqual([(chart["type"], chart["title"]) for chart in charts], [("bar", "Revenue by month"), ("line", "Cost trend")])
        series = charts[0]["series"][0]
        self.assertEqual(series["values_column"]["column_name"], "Revenue")
        self.assertEqual(series["categories_column"]["column_name"], "Month")

    def test_pivot_tables_are_marked_and_linked_to_their_source(self):
        result = self.read("pivot.xlsx")
        data, pivot = result["sheets"]
        self.assertEqual(pivot["pivot"], "RegionPivot")
        self.assertEqual(self.names(pivot), ["Row Labels", "Sum of Amount"])
        self.assertIn("Pivot", self.warnings(pivot))
        self.assertEqual(result["workbook"]["pivots"][0]["source_sheet"], "Data")
        self.assertIn({"from": "Pivot", "to": "Data", "via": "pivot", "count": 1}, result["workbook"]["relationships"])
        self.assertIsNone(data.get("pivot"))

    def test_thai_text_formats_and_encodings(self):
        result = self.read("thai.xlsx")
        sheet = result["sheets"][0]
        self.assertEqual(self.names(sheet), ["วันที่", "หมวด", "รายละเอียด", "จำนวนเงิน", "สัดส่วน"])
        self.assertEqual(sheet["columns"][3]["number_format"], '#,##0.00 "฿"')
        self.assertEqual(sheet["columns"][4]["number_format"], "0.0%")
        self.assertEqual(self.rows(sheet["id"])[2][1][2], "ค่าทางด่วน 🚗")
        result = self.read("thai_cp874.csv")
        self.assertEqual(self.rows(result["sheets"][0]["id"]), [(2, ["ค่าน้ำ", 1250.5]), (3, ["ค่าไฟ", 8420])])

    def test_messy_real_world_boq(self):
        result = self.read("messy_real_world.xlsx")
        boq, summary, total = result["sheets"]
        self.assertEqual(self.names(boq), ["ลำดับ", "หมวดงาน", "รายการ", "จำนวน", "ราคา (บาท) / ต่อหน่วย", "ราคา (บาท) / รวม", "helper"])
        self.assertEqual([c["data_type"] for c in boq["columns"][:6]], ["number", "text", "text", "number", "number", "number"])
        self.assertEqual(boq["title_lines"][:2], ["บริษัท ตัวอย่าง คอนสตรัคชั่น จำกัด", "ใบเสนอราคา / BOQ โครงการอาคาร A"])
        self.assertEqual(boq["footnotes"], ["หมายเหตุ: ราคารวมภาษีมูลค่าเพิ่ม 7% แล้ว", "ลงชื่อ ............ ผู้จัดทำ"])
        rows = self.rows(boq["id"])
        self.assertEqual([row[0] for row in rows], [7, 8, 9, 10, 14, 15, 16], "repeated page headers are skipped")
        self.assertEqual(rows[0][1][4], 1250.0, "'1,250.00' is a number")
        self.assertEqual([row[1][1] for row in rows[:3]], ["งานโครงสร้าง"] * 3)
        self.assertEqual(boq["summary_rows"], [10, 16])
        self.assertTrue(boq["columns"][6]["hidden"])
        self.assertIn("พิมพ์ซ้ำ", self.warnings(boq))
        self.assertEqual(summary["name"], "BOQ ตึก A · สรุปตามหมวดงาน")
        self.assertEqual(self.rows(summary["id"]), [(22, ["งานโครงสร้าง", 85000, 0.567]), (23, ["งานสถาปัตย์", 65000, 0.433])])
        self.assertEqual(summary["columns"][2]["number_format"], "0.0%")
        self.assertEqual(self.rows(total["id"]), [(2, ["มูลค่ารวม", 150000])])

    def test_legacy_xls_merges_hidden_rows_and_formats(self):
        result = self.read("legacy.xls")
        sheet = result["sheets"][0]
        self.assertEqual([row[1] for row in self.rows(sheet["id"])], [["P1", "Civil", 1200.5], ["P2", "Civil", 800], ["P3", "MEP", 450]])
        self.assertEqual(sheet["columns"][2]["number_format"], "#,##0.00")
        self.assertIn("ถูกซ่อน", self.warnings(sheet))

    def test_corrupted_workbook_fails_cleanly(self):
        with self.assertRaises(DatasetError) as caught:
            self.read("corrupted.xlsx")
        self.assertEqual(caught.exception.code, "INVALID_FILE")
        self.assertFalse(self.database.exists())

    def test_large_workbook_streams_within_limits(self):
        source = self.root / "large.xlsx"
        book = openpyxl.Workbook(write_only=True)
        sheet = book.create_sheet("Big")
        sheet.append(["ID", "Zone", "Qty", "Price", "Amount", "Date", "Note", "Flag"])
        for index in range(60_000):
            sheet.append([f"R{index:06d}", f"Z{index % 12}", index % 50, 10.5, (index % 50) * 10.5, date(2026, 1 + index % 12, 1), "ok", index % 2 == 0])
        book.save(source)
        started = time.monotonic()
        result = ingest(source, self.database, "large.xlsx")
        self.assertEqual(result["rows_count"], 60_000)
        self.assertEqual(preview(self.database, {"page": 600, "page_size": 100})["rows"][-1]["row_number"], 60_001)
        self.assertLess(time.monotonic() - started, 120)
        self.database.unlink()
        with self.assertRaises(DatasetError) as caught:
            ingest(source, self.database, "large.xlsx", {"max_rows": 50_000})
        self.assertEqual(caught.exception.code, "LIMIT_EXCEEDED")


if __name__ == "__main__":
    unittest.main()
