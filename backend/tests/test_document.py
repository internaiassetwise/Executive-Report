"""Document kinds and their computed dashboards/reports (datasets/document.py).

Fixture figures are chosen so every expected number can be checked by hand:
see tests/fixtures/build_excel_fixtures.py (bid_comparison, cost_estimate).
"""
import json
import shutil
import sys
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "datasets"))
import document
from worker import ingest

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "excel"


class DocumentTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).resolve().parents[2] / f"document-test-{uuid.uuid4().hex}"
        self.root.mkdir()

    def tearDown(self):
        shutil.rmtree(self.root)

    def build(self, name):
        database = self.root / f"{uuid.uuid4().hex}.sqlite"
        ingest(FIXTURES / name, database, name)
        result = document.build(database, FIXTURES / name, name, self.root)
        json.dumps(result, ensure_ascii=False, allow_nan=False)
        return result

    def report(self, result):
        return (self.root / result["report"]).read_text(encoding="utf-8")

    @staticmethod
    def kpis(result):
        return {item["label"]: item["value"] for item in result["dashboard"]["kpis"]}

    def test_bid_comparison_ranks_bidders_and_compares_like_for_like(self):
        result = self.build("bid_comparison.xlsx")
        self.assertEqual(result["type"], "comparison")
        board = result["dashboard"]
        ranking = board["tables"][0]["rows"]
        # rank, bidder, total, % above lowest, lines priced, lines missing, total on lines every bidder priced
        self.assertEqual([row[:3] for row in ranking], [[1, "บริษัท ซี จำกัด", 55000], [2, "บริษัท เอ จำกัด", 74000], [3, "บริษัท บี จำกัด", 75500]])
        self.assertEqual([row[5] for row in ranking], [1, 0, 0], "bidder C left one line unpriced")
        self.assertEqual([row[6] for row in ranking], [55000, 49000, 51500])
        self.assertNotIn("______", json.dumps(board, ensure_ascii=False), "an empty bidder template slot is not a bidder")
        kpis = self.kpis(result)
        self.assertEqual(kpis["ผู้เสนอราคา"], 3)
        self.assertEqual(kpis["ต่ำสุดเมื่อเทียบรายการเดียวกัน"], 49000)
        self.assertEqual(kpis["ต่อรองได้อีกหากใช้ราคาต่ำสุดรายรายการ"], 7000, "55,000 on common lines against a best-of 48,000")
        self.assertAlmostEqual(kpis["ราคาต่ำสุดเทียบราคากลาง"], (55000 - 76250) / 76250 * 100)
        self.assertIn("ไม่ได้เสนอราคา 1 รายการ", board["headline"])
        self.assertIn("บริษัท เอ จำกัด 49,000", board["headline"])
        categories = next(chart for chart in board["charts"] if chart["id"] == "categories")
        self.assertEqual(categories["categories"], ["งานคอนกรีต", "งานดิน"])
        self.assertEqual(next(s for s in categories["series"] if s["name"] == "บริษัท เอ จำกัด")["values"], [65000, 9000])
        html = self.report(result)
        for text in ("รายงานเปรียบเทียบราคาผู้เสนองาน", "ตารางที่ 1", "บทสรุปผู้บริหาร", "74,000", "ราคากลาง"):
            self.assertIn(text, html)
        self.assertNotIn("ยอดรวมที่ไฟล์ระบุต่าง", html, "the file's grand total matches the computed totals")

    def test_cost_estimate_splits_material_labour_and_categories(self):
        result = self.build("cost_estimate.xlsx")
        self.assertEqual(result["type"], "estimate")
        kpis = self.kpis(result)
        self.assertEqual(kpis["มูลค่ารวม"], 56500, "the line-total column is not added to labour again")
        self.assertAlmostEqual(kpis["สัดส่วนค่าวัสดุ"], 37000 / 56500 * 100)
        self.assertAlmostEqual(kpis["สัดส่วนค่าแรง"], 19500 / 56500 * 100)
        self.assertEqual(kpis["รายการที่ยังไม่มีราคา"], 1)
        self.assertEqual(kpis["รายการที่รวมกันเป็น 80% ของมูลค่า"], 3)
        categories = result["dashboard"]["tables"][0]["rows"]
        self.assertEqual([row[:2] for row in categories], [["หมวด 2 งานสถาปัตย์", 39000], ["หมวด 1 งานโครงสร้าง", 17500]])
        self.assertIn("บ้านตัวอย่าง", result["dashboard"]["title"])
        html = self.report(result)
        for text in ("รายงานสรุปราคาประมาณการ", "56,500", "มูลค่าตามหมวดงาน", "ก่ออิฐ"):
            self.assertIn(text, html)

    def test_messy_boq_is_an_estimate_with_summary_lines_left_out(self):
        result = self.build("messy_real_world.xlsx")
        self.assertEqual(result["type"], "estimate")
        self.assertEqual(self.kpis(result)["มูลค่ารวม"], 150000)

    def test_general_files_stay_general(self):
        for name in ("simple.xlsx", "thai.xlsx", "multi_sheet.xlsx", "pivot.xlsx", "simple.csv"):
            with self.subTest(name=name):
                self.assertEqual(self.build(name)["type"], "general")


if __name__ == "__main__":
    unittest.main()
