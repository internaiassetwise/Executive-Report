import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "datasets"))
import layout


def numbered(rows):
    return [(index, values) for index, values in enumerate(rows, 1)]


class LayoutTests(unittest.TestCase):
    def test_guess_skips_titles_and_joins_sub_headers(self):
        rows = numbered([["บริษัท ตัวอย่าง จำกัด"], ["ใบเปรียบเทียบราคา"], [], ["รายการ", "หน่วย", "ราคา", None],
                         [None, None, "RBP", "KMIT"], ["ปูน", "ถุง", 100, 120], ["ทราย", "คิว", 50, 55]])
        table = layout.guess(rows)["tables"][0]
        self.assertEqual(table["header_rows"], [4, 5])
        self.assertEqual(table["data_start"], 6)
        self.assertEqual(table["first_col"], 1)

    def test_guess_headerless_and_label_only(self):
        self.assertEqual(layout.guess(numbered([[1, 2], [3, 4]]))["tables"][0]["header_rows"], [])
        only = layout.guess(numbered([["Name", "Value"]]))["tables"][0]
        self.assertEqual((only["header_rows"], only["data_start"]), ([1], 2))
        self.assertIsNone(layout.guess(numbered([[], [None, " "]])))

    def test_guess_first_column_follows_data_left_of_header(self):
        # Row numbers in column A often have no header text.
        table = layout.guess(numbered([[None, "Item", "Qty"], [1, "A", 3], [2, "B", 4]]))["tables"][0]
        self.assertEqual(table["first_col"], 1)

    def test_validate_rejects_unsafe_layouts(self):
        good = {"header_rows": [2], "data_start": 3, "data_end": None, "first_col": 1, "last_col": None}
        self.assertIsNotNone(layout.validate({"tables": [good]}))
        bad = [
            {"tables": []},
            {"tables": [dict(good, header_rows=[1, 2, 3, 4, 5], data_start=6)]},
            {"tables": [dict(good, header_rows=[3, 2])]},
            {"tables": [dict(good, data_start=2)]},
            {"tables": [dict(good, data_start=True)]},
            {"tables": [dict(good, data_end=1)]},
            {"tables": [dict(good, first_col=5, last_col=2)]},
            {"tables": [good, dict(good, header_rows=[2], data_start=4)]},
            {"tables": [dict(good)] * 7},
            "not a layout",
        ]
        for value in bad:
            with self.subTest(value=value):
                self.assertIsNone(layout.validate(value))

    def test_validate_cleans_names_and_orders_tables(self):
        second = {"title": "  B\n", "header_rows": [10], "data_start": 11, "first_col": 1, "column_names": ["  a \n b ", "c"]}
        first = {"title": "A", "header_rows": [1], "data_start": 2, "data_end": 8, "first_col": 1, "column_names": [1, 2]}
        cleaned = layout.validate({"tables": [second, first]})["tables"]
        self.assertEqual([table["title"] for table in cleaned], ["A", "B"])
        self.assertIsNone(cleaned[0]["column_names"])
        self.assertEqual(cleaned[1]["column_names"], ["a b", "c"])
        # A table starting past the end of the sheet is dropped.
        self.assertEqual(len(layout.validate({"tables": [first, second]}, max_row=9)["tables"]), 1)

    def test_column_names_group_blank_and_duplicate(self):
        names = layout.column_names([["ราคา", None, None, "รวม"], ["RBP", "KMIT", None, None]], 2, 5)
        self.assertEqual(names, ["ราคา / RBP", "ราคา / KMIT", "คอลัมน์ D", "รวม", "คอลัมน์ F"])
        self.assertEqual(layout.column_names([["Qty", "qty", "Qty"]], 1, 3), ["Qty", "qty (2)", "Qty (3)"])
        # A report title spanning the top row is not a column group.
        self.assertEqual(layout.column_names([["Report", None], ["Name", "Value"]], 1, 2), ["Name", "Value"])

    def test_sample_rows_and_signature(self):
        rows = numbered([["Name", "Value"], ["x" * 100, 2]])
        sample = layout.sample_rows(rows)
        self.assertEqual(sample[0], {"row": 1, "cells": {"A": "Name", "B": "Value"}})
        self.assertEqual(len(sample[1]["cells"]["A"]), 60)
        self.assertEqual(layout.head_signature(rows), (("Name", "Value"),))


if __name__ == "__main__":
    unittest.main()
