"""The agent's query engine (datasets/query.py) against hand-checkable fixtures."""
import shutil
import sys
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "datasets"))
from analyzer import analyze
from query import run
from worker import ingest

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "excel"


class QueryTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).resolve().parents[2] / f"query-test-{uuid.uuid4().hex}"
        self.root.mkdir()

    def tearDown(self):
        shutil.rmtree(self.root)

    def load(self, name):
        database = self.root / f"{uuid.uuid4().hex}.sqlite"
        ingest(FIXTURES / name, database, name)
        return database, analyze(database)["profiles"]

    def ask(self, database, profiles, *queries):
        return run(database, {"profiles": profiles, "queries": [{"id": f"Q-{index}", "sheet_id": "s0", **query} for index, query in enumerate(queries, 1)]})["results"]

    def test_group_sort_share_filter_and_time(self):
        database, profiles = self.load("simple.xlsx")
        # Order, Region, Product, Amount, Date = c0..c4
        by_region, cement, by_month, pairs, rows = self.ask(
            database, profiles,
            {"measure": "c3", "agg": "sum", "group_by": ["c1"], "sort": "desc"},
            {"measure": "c3", "agg": "sum", "filters": [{"column": "c2", "values": ["Cement"]}]},
            {"measure": "c3", "agg": "sum", "group_by": ["c4"], "grain": "month", "sort": "label"},
            {"measure": None, "agg": "count", "group_by": ["c1", "c2"], "limit": 3},
            {"measure": None, "agg": "count"},
        )
        self.assertEqual(by_region["value"], 11150)
        self.assertEqual([(row["keys"], row["value"]) for row in by_region["rows"]], [(["North"], 5700), (["South"], 3900), (["East"], 1550)])
        self.assertAlmostEqual(by_region["rows"][0]["share"], 5700 / 11150 * 100)
        self.assertEqual(by_region["trace"]["sheet"], "Sales")
        self.assertEqual((cement["value"], cement["matched"]), (2150, 2))
        self.assertEqual([(row["keys"], row["value"]) for row in by_month["rows"]], [(["2026-01"], 2000), (["2026-02"], 5450), (["2026-03"], 3700)])
        self.assertEqual(by_month["grain"], "month")
        self.assertEqual((len(pairs["rows"]), pairs["groups_total"], pairs["truncated"]), (3, 6, True))
        self.assertEqual(rows["value"], 6)

    def test_summary_lines_are_left_out(self):
        database, profiles = self.load("messy_real_world.xlsx")
        (total,) = self.ask(database, profiles, {"measure": "c5", "agg": "sum"})
        self.assertEqual((total["value"], total["excluded_summary_rows"]), (150000, 2))

    def test_bad_questions_fail_alone(self):
        database, profiles = self.load("simple.xlsx")
        text_sum, unknown, good = self.ask(database, profiles, {"measure": "c1", "agg": "sum"}, {"measure": "c99", "agg": "avg"}, {"measure": "c3", "agg": "max"})
        self.assertFalse(text_sum["ok"])
        self.assertIn("ไม่ใช่ตัวเลข", text_sum["error"])
        self.assertFalse(unknown["ok"])
        self.assertEqual((good["ok"], good["value"]), (True, 4500))
        results = run(database, {"profiles": profiles, "queries": [{"id": "x", "sheet_id": "s0", "measure": "c3", "agg": "sum; DROP TABLE metadata"}]})["results"]
        self.assertFalse(results[0]["ok"])


if __name__ == "__main__":
    unittest.main()
