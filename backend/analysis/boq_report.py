"""Render the multi-vendor BOQ report contract as printable A4 HTML.

Section order follows the reference format: title, introduction and scope,
one block per vendor (ตารางที่ 1-3 and การวิเคราะห์เชิงลึก), the cross-vendor
comparison (three matrices, signature patterns, strategy), then the executive
summary. Sections whose data is absent are omitted rather than filled in.
"""
import html
from datetime import date

NAVY = '#1f3864'


def esc(v):
    return html.escape(str(v))


def money(v):
    return f"{v:,.0f}" if v is not None else '—'


def pct(v, signed=False):
    if v is None:
        return '—'
    return f"{v:+.1f}%" if signed else f"{v:.1f}%"


def n(v):
    return f"{v:,}" if v is not None else '—'


def table(headers, rows, aligns=None, total_row=False):
    aligns = aligns or (['left'] + ['center'] * (len(headers) - 1))
    head = ''.join(f'<th>{esc(h)}</th>' for h in headers)
    body = ''
    for i, r in enumerate(rows):
        cls = ' class="total"' if total_row and i == len(rows) - 1 else ''
        body += f'<tr{cls}>' + ''.join(
            f'<td style="text-align:{aligns[j]}">{esc(c)}</td>' for j, c in enumerate(r)) + '</tr>'
    return f'<div class="tw"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


def bullets(items):
    return '<ul>' + ''.join(f'<li>{esc(b)}</li>' for b in items) + '</ul>'


def vendor_block(v, tol):
    ref, G, T = v['benchmark'], v['groups'], v['total']
    t = f"{tol * 100:.0f}%"
    out = [f'<h2>ผู้เสนองาน: {esc(v["vendor"])}</h2>']
    if 'quantity' in v['axes']:
        out.append('<h3>ตารางที่ 1: ความผิดปกติด้านปริมาณงาน (Quantity) แยกหมวดงาน</h3>')
        out.append(table(['หมวดงาน', 'รายการทั้งหมด', f'ปริมาณเกิน {ref} >{t}', f'ปริมาณต่ำกว่า {ref}', '% รายการเกิน'],
                         [[g['group'], n(g['benchmark_items']), n(g['quantity_over']), n(g['quantity_under']),
                           pct(g['quantity_over_pct'])] for g in G]))
    out.append('<h3>ตารางที่ 2: ความผิดปกติด้านราคา (Unit Rate) แยกค่าของ/ค่าแรง</h3>')
    out.append(table(['หมวดงาน', f'รายการค่าของเกิน {t}', f'รายการค่าแรงเกิน {t}',
                      f'ค่าของ % ต่าง {ref} (ถ่วงน้ำหนัก)', f'ค่าแรง % ต่าง {ref} (ถ่วงน้ำหนัก)'],
                     [[g['group'], n(g.get('material_over')), n(g.get('labour_over')),
                       pct(g.get('material_dev_pct'), True), pct(g.get('labour_dev_pct'), True)] for g in G]))
    out.append('<h3>ตารางที่ 3: ผลกระทบทางการเงิน (Original vs Normalized) แยกหมวดงาน</h3>')
    out.append(table(['หมวดงาน', 'ราคาเดิม (บาท)', 'ราคาหลัง Normalize (บาท)', 'ประหยัดได้ (บาท)', '% ลด'],
                     [[g['group'], money(g['original']), money(g['normalized']), money(g['savings']), pct(g['savings_pct'])]
                      for g in G] +
                     [['รวมทุกหมวด', money(T['original']), money(T['normalized']), money(T['savings']), pct(T['savings_pct'])]],
                     ['left', 'right', 'right', 'right', 'center'], total_row=True))
    st = T.get('stated_normalized')
    if st:
        d = (T['normalized'] - st) / st * 100
        ft = f"{v['file_tolerance'] * 100:.0f}%" if v['file_tolerance'] is not None else 'ไม่ทราบ'
        out.append(f'<p class="note">กระทบยอด: ไฟล์นี้มีคอลัมน์ยอดหลัง Normalize ของตัวเอง รวม {money(st)} บาท '
                   f'(ไฟล์ปรับไว้ที่เกณฑ์ {ft}) เทียบกับที่รายงานคำนวณใหม่ที่เกณฑ์ {t} ต่างกัน {d:+.2f}% '
                   f'{"— ตรงกันในระดับที่อธิบายได้จากรายการที่กันออก" if abs(d) < 0.5 else "— ควรตรวจสอบว่าคอลัมน์ในไฟล์ครอบคลุมทุกแถวหรือใช้เกณฑ์ต่างกัน"}</p>')
    out.append('<h3>การวิเคราะห์เชิงลึก</h3>')
    out.append(bullets(v['insights']))
    return '\n'.join(out)


def intro_block(rep, filenames):
    V = rep['vendors']
    categories = rep.get('categories') or []
    categories_missing = bool(rep.get('categories_missing'))
    tol = rep['tolerance'] * 100
    refs = sorted({v['benchmark'] for v in V})
    items = sum(v['total']['benchmark_items'] for v in V)
    names = ', '.join(v['vendor'] for v in V)
    src = {'inferred': 'อ่านจากคอลัมน์ที่ไฟล์ปรับไว้เอง', 'declared': 'กำหนดโดยผู้ใช้',
           'default': 'ค่าตั้งต้นของระบบ เนื่องจากไฟล์ไม่มีคอลัมน์ที่ปรับไว้'}[rep['tolerance_source']]
    p1 = (f"รายงานฉบับนี้วิเคราะห์ปริมาณงานและราคา (ค่าของ/ค่าแรง) ที่ผิดปกติของผู้เสนองาน {len(V)} ราย ได้แก่ {names} "
          f"เทียบกับราคากลาง ({' / '.join(refs)}) ครอบคลุมรายการที่ราคากลางระบุไว้รวม {items:,} รายการ")
    p2 = (f"เกณฑ์การวิเคราะห์: ปริมาณหรือราคาที่สูงกว่าราคากลางเกิน {tol:.0f}% ถือว่า 'ผิดปกติ' (Flag) และใช้เป็นเกณฑ์ในการ Normalize "
          f"โดยปรับจุดที่ผิดปกติลงมาเท่าราคากลางทิศทางเดียว รายการที่ต่ำกว่าราคากลางนับไว้แต่ไม่ปรับขึ้น "
          f"เกณฑ์นี้{src} และใช้เกณฑ์เดียวกันกับทุกเจ้าเพื่อให้เปรียบเทียบกันได้")
    p3 = ("ทุกตัวเลขในรายงานคำนวณจากไฟล์ที่อัปโหลดเท่านั้น ชื่อผู้เสนอราคาและชื่อราคากลางอ่านจากหัวคอลัมน์ ส่วนชื่อหมวดงานอ่านจากค่าคอลัมน์หมวดงานหรือข้อความในชื่อชีตของไฟล์ "
          "% ต่างราคาถ่วงน้ำหนักด้วยปริมาณตามราคากลางเพื่อวัดเฉพาะส่วนต่างราคาต่อหน่วย")
    scope = table(['ผู้เสนองาน', 'ไฟล์', 'โครงการ (ตามไฟล์)', 'ชีตที่ใช้', 'ชีตที่ตัดออก', 'รายการในราคากลาง', 'เกณฑ์ที่ไฟล์ปรับไว้เอง'],
                  [[v['vendor'], v['filename'], v.get('project') or '—', n(len(v['sheets_used'])), n(len(v['sheets_skipped'])),
                    n(v['total']['benchmark_items']),
                    f"{v['file_tolerance'] * 100:.1f}%" if v['file_tolerance'] is not None else 'ไม่พบ'] for v in V],
                  ['left', 'left', 'left', 'center', 'center', 'center', 'center'])
    out = ['<h2>บทนำและขอบเขตการวิเคราะห์</h2>', f'<p>{esc(p1)}</p>', f'<p>{esc(p2)}</p>', f'<p class="note">{esc(p3)}</p>',
           '<h3>หมวดงานที่พบในไฟล์</h3>']
    if categories:
        category_scope = '<div class="category-scope">' + table(
            ['หมวดงานตามที่พบในไฟล์'], [[category] for category in categories], ['left']) + '</div>'
        out.extend([f'<p class="note">พบ {n(len(categories))} หมวด ตามลำดับที่ปรากฏในไฟล์อัปโหลด ไม่มีการเติมชื่อหมวดงานจากภายนอก</p>',
                    category_scope])
    else:
        out.append('<p class="note">ไม่พบชื่อหมวดงานในไฟล์ จึงไม่คาดเดาหรือเติมชื่อหมวดงานจากภายนอก</p>')
    if categories_missing and categories:
        out.append('<p class="note">บางรายการไม่ได้ระบุหมวดงานในไฟล์ จึงแยกไว้เป็น “ไม่ระบุหมวดงานในไฟล์” ในตารางวิเคราะห์</p>')
    out.extend(['<h3>ขอบเขตข้อมูลที่นำมาคำนวณ</h3>', scope])
    if rep['files_skipped']:
        out.append('<p class="note">ไฟล์ที่ไม่ได้นำมาวิเคราะห์: ' +
                   '; '.join(f"{esc(f['filename'])} — {esc(f['reason'])}" for f in rep['files_skipped']) + '</p>')
    excl = [(v['vendor'], v['total']['parent_rows'], v['total']['parent_value']) for v in V if v['total']['parent_rows']]
    if excl:
        out.append('<p class="note">แถวหัวข้อที่ยอดรวมซ้ำกับรายการย่อย ตัดออกเพื่อไม่นับซ้ำ: ' +
                   '; '.join(f"{esc(a)} {n(b)} แถว ({money(c)} บาท)" for a, b, c in excl) + '</p>')
    mism = [(v['vendor'], v['total'].get('mismatch') or 0) for v in V if v['total'].get('mismatch')]
    if mism:
        out.append('<p class="note">รายการที่ราคาต่อหน่วยสูงกว่าราคากลางเกิน 20 เท่า ถือว่าหน่วยหรือขอบเขตไม่ตรงกัน (เช่น เสนอเป็นเหมารวม) '
                   'จึงไม่นำมาคิด % ต่างและไม่ Normalize แต่ยังนับอยู่ในราคาเดิม: ' +
                   '; '.join(f"{esc(a)} {n(b)} รายการ" for a, b in mism) + '</p>')
    projects = {v.get('project') for v in V if v.get('project')}
    if len(V) > 1 and (len(projects) > 1 or len({v['benchmark'] for v in V}) > 1):
        out.append('<p class="note">ผู้เสนองานในรายงานนี้มาจากคนละไฟล์ซึ่งระบุคนละโครงการหรือคนละราคากลาง '
                   'การเปรียบเทียบข้ามเจ้าจึงสะท้อนแนวโน้มการเสนอราคาของแต่ละราย ไม่ใช่การประมูลงานเดียวกัน</p>')
    return '\n'.join(out)


def comparison_block(rep):
    V, groups, C = rep['vendors'], rep['groups'], rep['comparison']
    tol = f"{rep['tolerance'] * 100:.0f}%"
    ref = V[0]['benchmark'] if len({v['benchmark'] for v in V}) == 1 else 'ราคากลาง'
    names = [v['vendor'] for v in V]
    out = ['<h2>การวิเคราะห์เปรียบเทียบภาพรวมทุกเจ้า</h2>']
    for title, key, fmt in ((f'% ค่าแรงสูงกว่า {ref} แยกหมวดงาน (ถ่วงน้ำหนักตามมูลค่า)', 'labour_dev', lambda x: pct(x, True)),
                            (f'% ค่าของสูงกว่า {ref} แยกหมวดงาน (ถ่วงน้ำหนักตามมูลค่า)', 'material_dev', lambda x: pct(x, True)),
                            (f'จำนวนรายการปริมาณเกิน {ref} >{tol} แยกหมวดงาน', 'quantity_over', n)):
        out.append(f'<h3>ตารางเปรียบเทียบ: {esc(title)}</h3>')
        out.append(table(['หมวดงาน'] + names, [[g] + [fmt(C[key][g].get(v)) for v in names] for g in groups]))
    out.append('<h3>สรุปแนวโน้มเฉพาะตัวของแต่ละเจ้า (Signature Pattern)</h3>')
    out.append(table(['ผู้เสนองาน', 'แนวโน้มเด่น', 'หมวดงานที่กระทบมากที่สุด'],
                     [[s['vendor'], s['pattern'], s['top_groups']] for s in rep['signatures']], ['left', 'center', 'center']))
    out.append('<h3>บทวิเคราะห์เชิงกลยุทธ์</h3>')
    out.append(bullets(rep['strategy']))
    return '\n'.join(out)


def executive_block(rep):
    E = rep['executive']
    out = ['<h2>บทสรุปผู้บริหาร (Executive Summary)</h2>',
           '<h3>ผลกระทบทางการเงินระดับโครงการ (Grand Total Project Cost)</h3>',
           table(['ผู้เสนองาน', 'ราคาเดิม (บาท)', 'ราคาหลัง Normalize (บาท)', 'ประหยัดได้ (บาท)', '% ลด'],
                 [[r['vendor'], money(r['original']), money(r['normalized']), money(r['savings']), pct(r['savings_pct'])]
                  for r in E['rows']], ['left', 'right', 'right', 'right', 'center']),
           f'<p>{esc(E["summary"])}</p>', bullets(E['bullets']),
           f'<div class="call">{esc(E["headline"])}</div>']
    return '\n'.join(out)


def render(rep, filenames=None, generated=None):
    V = rep['vendors']
    categories = rep.get('categories') or []
    categories_missing = bool(rep.get('categories_missing'))
    filenames = filenames or [v['filename'] for v in V]
    generated = generated or date.today().isoformat()
    projects = sorted({v['project'] for v in V if v.get('project')})
    names = ', '.join(v['vendor'] for v in V)
    run = f"{esc(projects[0]) if len(projects) == 1 else esc(names)} — Comprehensive Quantity &amp; Price Anomaly Analysis"
    pages = []
    category_summary = (f"หมวดงาน {len(categories)} หมวดตามไฟล์" if categories
                        else 'ไม่พบชื่อหมวดงานในไฟล์')
    if categories and categories_missing:
        category_summary += ' · มีบางรายการไม่ระบุหมวด'
    pages.append(f"""
 <div class="title">
  <h1>รายงานวิเคราะห์ปริมาณและราคาเชิงลึก</h1>
  <p class="sub">(Comprehensive Quantity &amp; Price Anomaly Analysis)</p>
  <p class="sub"><b>{'โครงการ ' + esc(' / '.join(projects)) if projects else 'ผู้เสนองาน ' + esc(names)}</b></p>
  <p class="sub">ผู้เสนองาน {len(V)} ราย ({esc(names)}) · {esc(category_summary)}</p>
  <div class="meta">
   จัดทำโดย: ASW Data Insight<br>
   อ้างอิงไฟล์: <i>{esc(', '.join(filenames))}</i><br>
   เกณฑ์ความผิดปกติ: เกินราคากลางเกิน {rep['tolerance'] * 100:.0f}%<br>
   วันที่จัดทำ: {esc(generated)}
  </div>
 </div>""")
    pages.append(intro_block(rep, filenames) + '\n' + vendor_block(V[0], rep['tolerance']))
    for v in V[1:]:
        pages.append(vendor_block(v, rep['tolerance']))
    if len(V) > 1:
        pages.append(comparison_block(rep))
    pages.append(executive_block(rep))
    total = len(pages)
    body = ''.join(f'<section class="page"><div class="run">{run}</div>{p}<div class="foot">หน้า {i} / {total}</div></section>'
                   for i, p in enumerate(pages, 1))
    return f"""<!doctype html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(projects[0] if len(projects) == 1 else names)} — Quantity &amp; Price Anomaly</title>
<style>
:root{{--navy:{NAVY};--line:#b9c4d6;--stripe:#f2f4f8;--ink:#1a1a1a;--muted:#5b6472}}
*{{box-sizing:border-box}}
body{{margin:0;background:#eceff4;color:var(--ink);font-family:"Sarabun","IBM Plex Sans Thai","Noto Sans Thai","Thonburi",-apple-system,sans-serif;font-size:12.5px;line-height:1.7}}
.page{{position:relative;width:210mm;min-height:297mm;margin:12px auto;padding:16mm 15mm 20mm;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.15)}}
.run{{text-align:right;font-size:9px;color:var(--muted);margin-bottom:18px}}
.foot{{position:absolute;left:0;right:0;bottom:8mm;text-align:center;font-size:9px;color:var(--muted)}}
.title{{text-align:center;padding-top:60px}}
h1{{color:var(--navy);font-size:24px;margin:0 0 8px}}
.sub{{margin:4px 0;font-size:14px}}
.meta{{margin-top:40px;font-size:12px;line-height:2.1}}
h2{{color:var(--navy);font-size:17px;margin:26px 0 10px}}
h3{{color:var(--navy);font-size:13.5px;margin:20px 0 6px}}
p{{margin:6px 0}}
.tw{{overflow-x:auto;margin:6px 0 14px}}
table{{border-collapse:collapse;width:100%;font-size:11px}}
th{{background:var(--navy);color:#fff;font-weight:600;padding:7px 8px;border:1px solid var(--navy);text-align:center;line-height:1.35}}
td{{padding:6px 8px;border:1px solid var(--line);line-height:1.4}}
tbody tr:nth-child(even){{background:var(--stripe)}}
tr.total td{{font-weight:700;background:#e6ebf4}}
.category-scope table{{table-layout:fixed}}.category-scope td{{overflow-wrap:anywhere;word-break:break-word}}.category-scope tr{{break-inside:avoid}}
ul{{margin:6px 0 14px;padding-left:22px}} li{{margin-bottom:6px}}
.note{{font-size:10.5px;color:var(--muted)}}
.call{{background:#fdf1dc;border-left:5px solid #e3901c;padding:10px 14px;font-weight:600;margin:18px 0 8px}}
@media print{{body{{background:#fff}}.page{{margin:0;box-shadow:none;width:auto;min-height:auto;page-break-after:always}}.page:last-child{{page-break-after:auto}}}}
</style></head><body>{body}</body></html>"""
