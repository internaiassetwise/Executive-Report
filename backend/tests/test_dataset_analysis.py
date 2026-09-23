import json
import statistics
import unittest

import test_datasets as fixtures
from analyzer import analyze


class DatasetAnalysisTests(unittest.TestCase):
    setUp = fixtures.DatasetTests.setUp
    tearDown = fixtures.DatasetTests.tearDown
    csv = fixtures.DatasetTests.csv

    def test_calculated_statistics_relationships_and_real_chart_columns(self):
        values = [10, 10, 12, 14, 16, 100]
        dates = ["2026-01-01", "2026-01-02", "2026-02-01", "2026-02-02", "2026-03-01", "2026-03-02"]
        rows = [f"{i + 1},{'North' if i % 2 else 'South'},{value},{value * 2},{dates[i]}," for i, value in enumerate(values)]
        dataset = self.csv("ID,Group,Value,Other,Date,Empty\n" + "\n".join(rows))
        result = analyze(self.database)
        profile = result["profiles"][0]
        column = profile["columns"][2]
        self.assertEqual(column["statistics"]["mean"], statistics.mean(values))
        self.assertEqual(column["statistics"]["median"], statistics.median(values))
        self.assertAlmostEqual(column["statistics"]["std"], statistics.stdev(values))
        self.assertEqual(column["statistics"]["sum"], 162)
        self.assertEqual(column["outliers"]["count"], 1)
        self.assertEqual(profile["missing_count"], 6)
        self.assertEqual(profile["columns"][0]["unique_count"], 6)
        correlation = next(item for item in profile["correlations"] if {item["x"], item["y"]} == {"c2", "c3"})
        self.assertAlmostEqual(correlation["value"], 1)
        self.assertEqual(correlation["sample_size"], 6)
        self.assertTrue(any(item["kind"] == "trend" for item in result["insights"]))
        keys = {column["key"] for column in dataset["sheets"][0]["columns"]}
        for chart in result["charts"]:
            self.assertIn(chart["x"], keys)
            self.assertIn(chart["y"], keys)
            self.assertNotIn("c0", [chart["x"], chart["y"]], "Sequential IDs must not become a business measure")
        evidence_ids = {item["id"] for item in result["insights"]}
        self.assertEqual(len(result["report"]["sections"]), 10)
        self.assertTrue(all(set(section["evidence_ids"]) <= evidence_ids for section in result["report"]["sections"]))
        json.dumps(result, allow_nan=False)

    def test_categorical_only_duplicate_rows_and_insufficient_trend(self):
        self.csv("Team,State\nNorth,Open\nSouth,Closed\nNorth,Open\n")
        result = analyze(self.database)
        self.assertEqual(result["profiles"][0]["duplicate_rows"], 1)
        self.assertEqual(result["profiles"][0]["columns"][0]["top_values"][0], {"value": "North", "count": 2})
        self.assertTrue(any(item["kind"] == "quality" for item in result["insights"]))
        self.assertTrue(any(item["kind"] == "segment" for item in result["insights"]))
        self.assertTrue(result["charts"])
        trends = next(section for section in result["report"]["sections"] if section["id"] == "trends")
        self.assertIn("Insufficient data", trends["paragraphs"][0])
        self.assertLessEqual(len(result["charts"]), 12)
        self.assertLessEqual(len(result["insights"]), 24)
        json.dumps(result, allow_nan=False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
