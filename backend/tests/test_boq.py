import io, json, sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'analysis'))
import analysis_engine as e
import boq_engine as B
import boq_report as R
import openpyxl


def workbook_bytes(book):
    stream = io.BytesIO(); book.save(stream); return stream.getvalue()


def sheets_of(book):
    return [{'name': ws.title, 'grid': [list(r) for r in ws.iter_rows(values_only=True)],
             'merges': [(m.min_row, m.min_col, m.max_row, m.max_col) for m in ws.merged_cells.ranges]}
            for ws in book.worksheets]


# Twelve benchmark lines. Vendor AAA prices material 2x the benchmark on the
# first line only; vendor BBB pads every quantity by 20% and labour by 5%.
ITEMS = [(f'Item {i}', 'หมวด ' + ('A' if i < 6 else 'B'), 10.0 * (i + 1), 100.0, 50.0) for i in range(12)]


def side_by_side_book():
    b = openpyxl.Workbook(); b.remove(b.active)
    for sheet in ('ST_A', 'AR_A'):
        s = b.create_sheet(sheet)
        s.append(['No', 'รายการ', 'หมวดงาน', 'หน่วย', 'ปริมาณ RBP', 'ปริมาณ AAA เสนอ', 'ปริมาณ BBB เสนอ',
                  'ราคาของ RBP', 'ราคาของ AAA เสนอ', 'ราคาของ BBB เสนอ', 'ราคาแรง RBP', 'ราคาแรง AAA เสนอ', 'ราคาแรง BBB เสนอ',
                  'ส่วนต่าง AAA', 'Flag ปริมาณ'])
        for i, (item, cat, q, m, l) in enumerate(ITEMS, 1):
            s.append([i, item, cat, 'ea', q, q, q * 1.2, m, m * (2 if i == 1 else 1), m, l, l, l * 1.05, 0, None])
    return b


def sheet_per_vendor_book():
    b = openpyxl.Workbook(); b.remove(b.active)
    for vendor, qf, mf, lf in (('AAA', 1.0, 1.5, 1.0), ('BBB', 1.3, 1.0, 1.0)):
        s = b.create_sheet(vendor)
        s.append(['No', 'รายการ', 'หมวดงาน', 'หน่วย', 'ปริมาณ (ราคากลาง)', 'ปริมาณ', 'ราคาวัสดุ/หน่วย (ราคากลาง)',
                  'ราคาวัสดุ/หน่วย', 'ราคาแรง/หน่วย (ราคากลาง)', 'ราคาแรง/หน่วย'])
        for i, (item, cat, q, m, l) in enumerate(ITEMS, 1):
            s.append([i, item, cat, 'ea', q, q * qf, m, m * mf, l, l * lf])
    return b


def single_vendor_book(label_cell=None):
    b = openpyxl.Workbook(); s = b.active; s.title = 'ST_A'
    if label_cell:
        s.append([label_cell]); s.append([])
    s.append(['No', 'รายการ', 'ปริมาณ (ราคากลาง)', 'ปริมาณ', 'ราคาวัสดุ/หน่วย (ราคากลาง)', 'ราคาวัสดุ/หน่วย',
              'ราคาแรง/หน่วย (ราคากลาง)', 'ราคาแรง/หน่วย'])
    for i, (item, _, q, m, l) in enumerate(ITEMS, 1):
        s.append([i, item, q, q, m, m * 1.5, l, l])
    return b


def sparse_category_book():
    """Categories may be merged, left blank on continuation rows, or placed
    on a heading row immediately before their detail lines."""
    b = openpyxl.Workbook(); s = b.active; s.title = 'BOQ'
    s.append(['No', 'รายการ', 'หมวดงาน', 'ปริมาณ (ราคากลาง)', 'ปริมาณ',
              'ราคาวัสดุ/หน่วย (ราคากลาง)', 'ราคาวัสดุ/หน่วย'])
    s.append([1, 'Item 1', 'งานโครงสร้าง', 10, 10, 100, 120])
    s.append([2, 'Item 2', None, 20, 20, 100, 100])
    s.merge_cells('C2:C3')
    s.append([3, 'Item 3', 'งานระบบ', 30, 30, 100, 100])
    s.append([4, 'Item 4', None, 40, 40, 100, 100])
    s.append([None, 'หัวหมวด', 'งานสถาปัตยกรรม', None, None, None, None])
    s.append([5, 'Item 5', None, 50, 50, 100, 100])
    return b


def unlabelled_vendor_tabs_book():
    b = openpyxl.Workbook(); b.remove(b.active)
    for vendor in ('AAA', 'BBB'):
        s = b.create_sheet(vendor)
        s.append(['No', 'รายการ', 'ปริมาณ (ราคากลาง)', 'ปริมาณ',
                  'ราคาวัสดุ/หน่วย (ราคากลาง)', 'ราคาวัสดุ/หน่วย'])
        for i in range(1, 13):
            s.append([i, f'Item {i}', i * 10, i * 10, 100, 110])
    return b


def one_category_book(category):
    b = openpyxl.Workbook(); s = b.active; s.title = 'BOQ'
    s.append(['รายการ', 'หมวดงาน', 'ปริมาณ (ราคากลาง)', 'ปริมาณ',
              'ราคาวัสดุ/หน่วย (ราคากลาง)', 'ราคาวัสดุ/หน่วย'])
    s.append(['Item', category, 10, 10, 100, 100])
    return b


def merged_header_book():
    b = openpyxl.Workbook(); s = b.active; s.title = 'ST_A'
    s.append(['รายการ', 'category', 'quantity benchmark', 'quantity',
              'material benchmark', 'material'])
    s.append([None, None, None, None, None, None])
    s.merge_cells('B1:B2')
    s.append(['Item', None, 10, 10, 100, 100])
    return b


class Detection(unittest.TestCase):
    def test_side_by_side_vendors_in_one_sheet(self):
        rep = B.build_many([(sheets_of(side_by_side_book()), 'compare.xlsx')])
        self.assertEqual([v['vendor'] for v in rep['vendors']], ['AAA', 'BBB'])
        self.assertEqual(rep['groups'], ['หมวด A', 'หมวด B'])
        self.assertEqual(rep['categories'], ['หมวด A', 'หมวด B'])
        self.assertFalse(rep['categories_missing'])
        self.assertEqual(rep['tolerance_source'], 'default')
        aaa, bbb = rep['vendors']
        self.assertEqual(aaa['benchmark'], 'RBP')
        # AAA: one material line at 2x on each sheet; nothing else over.
        self.assertEqual(aaa['total']['material_over'], 2)
        self.assertEqual(aaa['total']['labour_over'], 0)
        self.assertEqual(aaa['total']['quantity_over'], 0)
        # BBB: every quantity 20% over the default 15% tolerance; labour +5% is within it.
        self.assertEqual(bbb['total']['quantity_over'], 24)
        self.assertEqual(bbb['total']['labour_over'], 0)
        self.assertAlmostEqual(bbb['total']['labour_dev_pct'], 5.0, places=6)
        self.assertAlmostEqual(bbb['total']['material_dev_pct'], 0.0, places=6)
        # Derived columns never become inputs.
        self.assertNotIn('ส่วนต่าง', json.dumps(rep, ensure_ascii=False))
        # Normalization is one-directional and priced from the unit rates.
        self.assertAlmostEqual(aaa['total']['savings'], 2 * 10.0 * 100.0, places=6)
        self.assertGreater(bbb['total']['savings'], 0)
        self.assertEqual(len(rep['comparison']['quantity_over']['หมวด A']), 2)

    def test_one_sheet_per_vendor(self):
        rep = B.build_many([(sheets_of(sheet_per_vendor_book()), 'tabs.xlsx')])
        self.assertEqual([v['vendor'] for v in rep['vendors']], ['AAA', 'BBB'])
        self.assertEqual(rep['groups'], ['หมวด A', 'หมวด B'])
        aaa, bbb = rep['vendors']
        self.assertEqual(aaa['total']['material_over'], 12)
        self.assertEqual(bbb['total']['quantity_over'], 12)
        self.assertEqual(aaa['sheets_used'], ['AAA'])

    def test_single_unlabelled_vendor_is_named_from_the_file(self):
        rep = B.build_many([(sheets_of(single_vendor_book()), 'BOQ_Wisawapat.xlsx')])
        self.assertEqual(rep['vendors'][0]['vendor'], 'BOQ_Wisawapat')
        self.assertEqual(rep['categories'], ['ST'])
        self.assertEqual(rep['groups'], ['ST'])
        rep = B.build_many([(sheets_of(single_vendor_book('ผู้รับเหมา: วิศวพัฒน์ จำกัด')), 'x.xlsx')])
        self.assertEqual(rep['vendors'][0]['vendor'], 'วิศวพัฒน์ จำกัด')
        self.assertEqual(rep['vendors'][0]['benchmark'], 'ราคากลาง')

    def test_merged_blank_and_heading_categories_keep_file_order(self):
        rep = B.build_many([(sheets_of(sparse_category_book()), 'sparse.xlsx')])
        expected = ['งานโครงสร้าง', 'งานระบบ', 'งานสถาปัตยกรรม']
        self.assertEqual(rep['categories'], expected)
        self.assertEqual(rep['groups'], expected)
        self.assertEqual(rep['vendors'][0]['total']['benchmark_items'], 5)
        self.assertFalse(rep['categories_missing'])

    def test_vendor_tab_names_are_not_reported_as_categories(self):
        rep = B.build_many([(sheets_of(unlabelled_vendor_tabs_book()), 'tabs.xlsx')])
        self.assertEqual([v['vendor'] for v in rep['vendors']], ['AAA', 'BBB'])
        self.assertEqual(rep['categories'], [])
        self.assertTrue(rep['categories_missing'])
        self.assertEqual(rep['groups'], [B.UNCATEGORIZED])
        self.assertNotIn('AAA', rep['categories'])
        self.assertNotIn('BBB', rep['categories'])

    def test_same_vendor_in_two_files_stays_distinguishable(self):
        rep = B.build_many([(sheets_of(single_vendor_book()), 'a.xlsx'), (sheets_of(single_vendor_book()), 'b.xlsx')])
        self.assertEqual(len(rep['vendors']), 2)
        self.assertNotEqual(rep['vendors'][0]['vendor'], rep['vendors'][1]['vendor'])

    def test_category_order_is_preserved_across_uploaded_files(self):
        rep = B.build_many([(sheets_of(one_category_book('งานภายนอก')), 'first.xlsx'),
                            (sheets_of(one_category_book('งานโครงสร้าง')), 'second.xlsx')])
        self.assertEqual(rep['categories'], ['งานภายนอก', 'งานโครงสร้าง'])
        self.assertEqual(rep['groups'], rep['categories'])

    def test_merged_header_is_not_used_as_a_category_value(self):
        rep = B.build_many([(sheets_of(merged_header_book()), 'header.xlsx')])
        self.assertEqual(rep['categories'], ['ST'])
        self.assertEqual(rep['groups'], ['ST'])
        self.assertNotIn('category', rep['categories'])

    def test_workbook_without_benchmark_columns_is_not_boq(self):
        b = openpyxl.Workbook(); s = b.active
        s.append(['Region', 'Amount']); s.append(['North', 10]); s.append(['South', 20])
        self.assertIsNone(B.build_many([(sheets_of(b), 'sales.xlsx')]))


class Dispatch(unittest.TestCase):
    def test_boq_action_returns_report_and_html(self):
        progress = []
        out = e.dispatch('boq', {'files': [{'filename': 'compare.xlsx', 'bytes': workbook_bytes(side_by_side_book())}]},
                         lambda d, t, n: progress.append((d, t, n)))
        self.assertEqual(out['mode'], 'boq')
        self.assertEqual(progress, [(1, 1, 'compare.xlsx')])
        html = out['html']
        self.assertIn('หมวดงานที่พบในไฟล์', html)
        self.assertIn('พบ 2 หมวด ตามลำดับที่ปรากฏในไฟล์อัปโหลด', html)
        for category in out['report']['categories']:
            self.assertIn(f'>{category}</td>', html)
        for heading in ('บทนำและขอบเขตการวิเคราะห์', 'ผู้เสนองาน: AAA', 'ผู้เสนองาน: BBB', 'ตารางที่ 1', 'ตารางที่ 2', 'ตารางที่ 3',
                        'การวิเคราะห์เชิงลึก', 'การวิเคราะห์เปรียบเทียบภาพรวมทุกเจ้า', 'Signature Pattern', 'บทวิเคราะห์เชิงกลยุทธ์',
                        'บทสรุปผู้บริหาร', 'Grand Total Project Cost'):
            self.assertIn(heading, html)
        json.dumps(out, ensure_ascii=False, allow_nan=False)
        rebuilt = e.dispatch('boq_rebuild', {'tolerance': 0.01})
        self.assertEqual(rebuilt['report']['tolerance_source'], 'declared')
        self.assertEqual(rebuilt['report']['vendors'][1]['total']['labour_over'], 24)

    def test_single_generic_upload_falls_through_with_its_profile(self):
        b = openpyxl.Workbook(); s = b.active
        s.append(['Region', 'Amount']); s.append(['North', 10]); s.append(['South', 20])
        out = e.dispatch('boq', {'files': [{'filename': 'sales.xlsx', 'bytes': workbook_bytes(b)}]})
        self.assertEqual(out['mode'], 'generic')
        self.assertEqual(out['book']['tables_count'], 1)
        self.assertEqual(e.dispatch('boq', {'files': [{'filename': 'a.xlsx', 'bytes': workbook_bytes(b)},
                                                      {'filename': 'b.xlsx', 'bytes': workbook_bytes(b)}]})['mode'], 'none')

    def test_single_vendor_report_omits_the_comparison_section(self):
        html = R.render(B.build_many([(sheets_of(single_vendor_book()), 'one.xlsx')]))
        self.assertIn('ผู้เสนองาน: one', html)
        self.assertNotIn('การวิเคราะห์เปรียบเทียบภาพรวมทุกเจ้า', html)
        self.assertIn('บทสรุปผู้บริหาร', html)

    def test_report_discloses_when_category_names_are_absent(self):
        rep = B.build_many([(sheets_of(unlabelled_vendor_tabs_book()), 'tabs.xlsx')])
        html = R.render(rep)
        self.assertIn('ไม่พบชื่อหมวดงานในไฟล์', html)
        self.assertNotIn('หมวดงาน 0 หมวด', html)
        self.assertNotIn('หมวดงานตามที่พบในไฟล์</th>', html)


if __name__ == '__main__':
    unittest.main()
