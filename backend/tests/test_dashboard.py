import io
import json
import subprocess
import sys
import unittest
import zipfile
from pathlib import Path

import openpyxl

import test_datasets as fixtures
from analyzer import analyze
from dashboard import run, validate
from worker import DatasetError, ingest, preview

REGIONS = ["North", "South", "East"]


def sales_csv(rows=60):
    lines = ["order_id,order_date,region,product,revenue,quantity,customer"]
    for i in range(rows):
        month = i % 6 + 1
        lines.append(f"{1000 + i},2026-{month:02d}-{i % 28 + 1:02d},{REGIONS[i % 3]},P{i % 4},{100 + i * 10},{i % 5 + 1},Customer {i}")
    return "\n".join(lines)


class DashboardTests(unittest.TestCase):
    setUp = fixtures.DatasetTests.setUp
    tearDown = fixtures.DatasetTests.tearDown
    csv = fixtures.DatasetTests.csv

    def analysed(self, text):
        self.csv(text)
        return analyze(self.database)

    def query(self, analysis, spec=None, filters=None, options=False):
        return run(self.database, {"spec": spec or analysis["dashboard"], "profiles": analysis["profiles"], "filters": filters, "include_options": options})

    def test_semantic_roles_use_values_not_only_names(self):
        analysis = self.analysed(sales_csv())
        columns = {c["name"]: c for c in analysis["profiles"][0]["columns"]}
        self.assertEqual(columns["order_id"]["role"], "identifier")
        self.assertEqual((columns["order_date"]["role"], columns["order_date"]["semantic_type"]), ("time", "date"))
        self.assertEqual((columns["region"]["role"], columns["region"]["semantic_type"]), ("dimension", "category"))
        self.assertEqual((columns["revenue"]["role"], columns["revenue"]["meaning"]), ("measure", "money"))
        self.assertEqual((columns["quantity"]["semantic_type"], columns["quantity"]["meaning"]), ("integer", "quantity"))
        self.assertEqual(columns["customer"]["role"], "identifier")

    def test_a_text_column_named_amount_is_not_a_measure(self):
        analysis = self.analysed("amount,note\nhigh,a\nlow,b\nhigh,c\n")
        self.assertNotEqual(analysis["profiles"][0]["columns"][0]["role"], "measure")

    def test_year_month_text_is_a_time_column(self):
        analysis = self.analysed("period,cost\n2026-01,5\n2026-02,7\n2026-03,9\n")
        column = analysis["profiles"][0]["columns"][0]
        self.assertEqual((column["role"], column["time_format"]), ("time", "year_month"))

    def test_rule_plan_is_valid_and_numbers_come_from_every_row(self):
        analysis = self.analysed(sales_csv())
        spec = analysis["dashboard"]
        self.assertEqual(spec["source"], "rules")
        self.assertEqual(spec, validate(spec, analysis["profiles"]))
        types = [chart["type"] for chart in spec["charts"]]
        self.assertIn(types[0], ("line", "area"))
        self.assertIn("bar", types)
        result = self.query(analysis, options=True)
        values = {k["id"]: k["value"] for k in result["kpis"]}
        revenue = next(k for k in spec["kpis"] if k["agg"] == "sum" and k["column"] == "c4")
        count = next(k for k in spec["kpis"] if k["agg"] == "count")
        self.assertEqual(values[revenue["id"]], sum(100 + i * 10 for i in range(60)))
        self.assertEqual(values[count["id"]], 60)
        self.assertEqual(result["rows_matched"], 60)
        self.assertIn("f1", result["options"])

    def test_filters_update_kpis_and_charts(self):
        analysis = self.analysed(sales_csv())
        spec = validate({"sheet_id": "s0", "kpis": [{"column": "c4", "agg": "sum"}, {"column": "c4", "agg": "median"}],
                         "charts": [{"type": "bar", "x": "c2", "y": "c4", "agg": "sum"}, {"type": "line", "x": "c1", "y": "c4", "agg": "sum", "grain": "month"}],
                         "filters": [{"column": "c2"}, {"column": "c1"}]}, analysis["profiles"])
        north = sorted(100 + i * 10 for i in range(60) if i % 3 == 0)
        result = self.query(analysis, spec, [{"column": "c2", "values": ["North"]}])
        self.assertEqual(result["rows_matched"], len(north))
        self.assertEqual(result["kpis"][0]["value"], sum(north))
        self.assertEqual(result["kpis"][1]["value"], (north[len(north) // 2 - 1] + north[len(north) // 2]) / 2)
        self.assertEqual(result["charts"][0]["data"], [{"x": "North", "y": sum(north)}])
        self.assertEqual(result["charts"][1]["grain"], "month")
        self.assertEqual(sum(point["y"] for point in result["charts"][1]["data"]), sum(north))
        ranged = self.query(analysis, spec, [{"column": "c1", "from": "2026-02-01", "to": "2026-03-31"}])
        self.assertEqual({point["x"] for point in ranged["charts"][1]["data"]}, {"2026-02", "2026-03"})

    def test_category_limit_reports_others_and_histogram_scatter_shapes(self):
        analysis = self.analysed(sales_csv())
        spec = validate({"sheet_id": "s0", "charts": [
            {"type": "hbar", "x": "c3", "y": "c4", "agg": "sum", "limit": 3},
            {"type": "histogram", "x": "c4"}, {"type": "scatter", "x": "c4", "y": "c5"}]}, analysis["profiles"])
        bars, histogram, scatter = self.query(analysis, spec)["charts"]
        self.assertEqual(len(bars["data"]), 3)
        self.assertEqual(sum(p["y"] for p in bars["data"]) + bars["others"]["y"], sum(100 + i * 10 for i in range(60)))
        self.assertEqual(sum(p["y"] for p in histogram["data"]), 60)
        self.assertEqual(scatter["points_total"], 60)

    def test_invalid_specs_are_rejected(self):
        analysis = self.analysed(sales_csv())
        bad = [
            {"sheet_id": "s9", "kpis": [{"agg": "count"}]},
            {"sheet_id": "s0", "kpis": [{"column": "c2", "agg": "sum"}]},              # text column summed
            {"sheet_id": "s0", "charts": [{"type": "pie3d", "x": "c2"}]},
            {"sheet_id": "s0", "charts": [{"type": "line", "x": "c2", "y": "c4"}]},   # category on a time axis
            {"sheet_id": "s0", "charts": [{"type": "bar", "x": "c2); DROP TABLE x;--"}]},
            {"sheet_id": "s0"},
        ]
        for spec in bad:
            with self.assertRaises(DatasetError, msg=spec) as raised:
                validate(spec, analysis["profiles"])
            self.assertEqual(raised.exception.code, "INVALID_SPEC")
        with self.assertRaises(DatasetError) as raised:
            self.query(analysis, filters=[{"column": "c6", "values": ["x"]}])  # not referenced by the spec
        self.assertEqual(raised.exception.code, "INVALID_FILTER")

    def test_preview_applies_dashboard_filters_with_search(self):
        self.csv(sales_csv())
        page = preview(self.database, {"sheet": "s0", "filters": [{"column": "c2", "values": ["South"]}], "search": "customer 1"})
        self.assertTrue(page["rows"])
        self.assertTrue(all(row["values"]["c2"] == "South" for row in page["rows"]))

    def test_xlsx_uses_values_excel_saved_for_formulas(self):
        book = openpyxl.Workbook()
        book.active.append(["item", "price", "qty", "total"])
        book.active.append(["A", 10, 3, "=B2*C2"])
        book.active.append(["B", 5, 2, "=B3*C3"])
        buffer = io.BytesIO()
        book.save(buffer)
        # Emulate a file saved by Excel: add the cached result next to each formula.
        source = zipfile.ZipFile(io.BytesIO(buffer.getvalue()))
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
            for info in source.infolist():
                data = source.read(info.filename)
                if info.filename == "xl/worksheets/sheet1.xml":
                    for formula, value in ((b"B2*C2", b"30"), (b"B3*C3", b"10")):
                        data = data.replace(b"<f>" + formula + b"</f><v></v>", b"<f>" + formula + b"</f><v>" + value + b"</v>")
                        data = data.replace(b"<f>" + formula + b"</f></c>", b"<f>" + formula + b"</f><v>" + value + b"</v></c>")
                target.writestr(info, data)
        path = self.root / "input.xlsx"
        path.write_bytes(output.getvalue())
        result = ingest(path, self.database, "input.xlsx")
        rows = preview(self.database, {"sheet": "s0"})["rows"]
        self.assertEqual([row["values"]["c3"] for row in rows], [30, 10])
        self.assertEqual(result["sheets"][0]["columns"][3]["data_type"], "number")

    def test_corrupted_xls_is_a_readable_error(self):
        path = self.root / "input.xls"
        path.write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"broken" * 50)
        with self.assertRaises(DatasetError) as raised:
            ingest(path, self.database, "input.xls")
        self.assertEqual(raised.exception.code, "INVALID_FILE")

    def test_cli_dashboard_command_round_trip(self):
        analysis = self.analysed(sales_csv())
        payload = self.root / "payload.json"
        payload.write_text(json.dumps({"spec": analysis["dashboard"], "profiles": analysis["profiles"]}), encoding="utf-8")
        worker = Path(__file__).resolve().parents[1] / "datasets" / "worker.py"
        output = subprocess.run([sys.executable, "-B", str(worker), "dashboard", str(self.database), str(payload)], capture_output=True, text=True, encoding="utf-8", check=False)
        self.assertEqual(output.returncode, 0, output.stdout)
        self.assertEqual(json.loads(output.stdout.strip().splitlines()[-1])["result"]["rows_total"], 60)


if __name__ == "__main__":
    unittest.main()
