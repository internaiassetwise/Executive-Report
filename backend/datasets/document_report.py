"""A4 reports for bid comparisons and priced bills of quantities, in the same
style and order as the BOQ benchmark report: title page, introduction and
scope, numbered tables, analysis, then the executive summary. Every figure
comes from document.py; sections without data are left out.
"""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "analysis"))
from boq_report import bullets, document, esc, table  # noqa: E402


def money(value):
    return "—" if value is None else f"{value:,.0f}"


def pct(value, signed=False):
    return "—" if value is None else (f"{value:+.1f}%" if signed else f"{value:.1f}%")


def quantity(value):
    return "—" if value is None else f"{value:,.2f}".rstrip("0").rstrip(".")


def paragraph(value, note=False):
    return f'<p class="note">{esc(value)}</p>' if note else f"<p>{esc(value)}</p>"


def title_page(heading, english, facts, lines):
    where = f"ชีต {facts['sheet']}" + (f" ช่วง {facts['range']}" if facts.get("range") else "")
    meta = "<br>".join([esc(line) for line in lines] + [f"อ้างอิงไฟล์: <i>{esc(facts['filename'])}</i>", f"ตำแหน่งข้อมูล: {esc(where)}",
                                                         "จัดทำโดย: ASW Data Insight", f"วันที่จัดทำ: {date.today().isoformat()}"])
    return f"""
 <div class="title">
  <h1>{esc(heading)}</h1>
  <p class="sub">({esc(english)})</p>
  <p class="sub"><b>{esc(facts['project'])}</b></p>
  <div class="meta">{meta}</div>
 </div>"""


def comparison_pages(f):
    rows = f["ranking"]
    low, high = rows[0], rows[-1]
    reference = f" และ{f['benchmark']}" if f["benchmark"] else ""
    intro = [
        "<h2>บทนำและขอบเขตการวิเคราะห์</h2>",
        paragraph(f"รายงานฉบับนี้เปรียบเทียบราคาของผู้เสนองาน {len(rows)} ราย ได้แก่ {', '.join(f['parties'])}{reference} "
                  f"จากรายการในใบเปรียบเทียบราคารวม {f['items']:,} รายการ"),
        paragraph("ราคารวมของแต่ละรายคำนวณจากราคารายบรรทัดในไฟล์ (จำนวนเงิน หรือราคาต่อหน่วย × ปริมาณ เมื่อไม่มีจำนวนเงิน) "
                  "โดยไม่นับแถวสรุปยอดและ VAT เพื่อไม่ให้นับซ้ำ การเทียบรายรายการใช้เฉพาะรายการที่ทุกรายเสนอราคา"),
        paragraph("ทุกตัวเลขในรายงานคำนวณจากไฟล์ที่อัปโหลดเท่านั้น ชื่อผู้เสนอราคาและหมวดงานอ่านจากหัวคอลัมน์และหัวข้อในไฟล์", True),
        "<h3>ขอบเขตข้อมูลที่นำมาคำนวณ</h3>",
        table(["ผู้เสนองาน", "รายการที่เสนอราคา", "รายการที่ไม่ได้เสนอ (รายอื่นเสนอ)", "ยอดรวมที่ไฟล์ระบุ (บาท)", "ยอดรวมที่คำนวณ (บาท)"],
              [[row["party"], f"{row['priced']:,}", f"{row['missing']:,}", money(row["stated"]), money(row["total"])] for row in rows],
              ["left", "center", "center", "right", "right"]),
    ]
    mismatch = [row["party"] for row in rows if row["stated"] and row["total"] and abs(row["stated"] - row["total"]) / row["stated"] > .005]
    if mismatch:
        intro.append(paragraph(f"ยอดรวมที่ไฟล์ระบุต่างจากที่คำนวณจากรายบรรทัดเกิน 0.5% สำหรับ {', '.join(mismatch)} "
                               "ควรตรวจว่าแถวรวมในไฟล์ครอบคลุมทุกรายการ หรือรวมรายการที่ไม่ได้อยู่ในตาราง", True))
    headers = ["อันดับ", "ผู้เสนองาน", "ราคารวม (บาท)"] + (["ค่าวัสดุ (บาท)", "ค่าแรง (บาท)"] if f["axes"] else [])
    headers += ["สูงกว่าต่ำสุด (บาท)", "สูงกว่าต่ำสุด"] + ([f"เทียบ{f['benchmark']}"] if f["benchmark"] else [])
    headers += [f"เฉพาะ {f['common_items']:,} รายการที่ทุกรายเสนอ (บาท)"] if f["common_items"] else []
    body = []
    for row in rows:
        line = [f"{row['rank']}", row["party"], money(row["total"])]
        line += [money(row["material"]), money(row["labour"])] if f["axes"] else []
        line += [money(row["diff"]), pct(row["diff_pct"])] + ([pct(row["vs_benchmark_pct"], True)] if f["benchmark"] else [])
        line += [money(row["common_total"])] if f["common_items"] else []
        body.append(line)
    tables = ["<h2>ผลการเปรียบเทียบราคา</h2>", "<h3>ตารางที่ 1: สรุปราคารวมและอันดับ</h3>",
              table(headers, body, ["center", "left"] + ["right"] * (len(headers) - 2))]
    if f["fair_low"] and f["fair_low"] != low["party"]:
        tables.append(paragraph(f"{low['party']} มีราคารวมต่ำสุดเพราะไม่ได้เสนอราคา {low['missing']:,} รายการ เมื่อเทียบเฉพาะรายการที่ทุกรายเสนอ "
                                f"ผู้ที่ราคาต่ำสุดคือ {f['fair_low']} ควรใช้ตัวเลขนี้ในการตัดสินใจ", True))
    number = 2
    if len(f["categories"]) > 1:
        columns = f["parties"] + ([f["benchmark"]] if f["benchmark"] else [])
        tables += [f"<h3>ตารางที่ {number}: เปรียบเทียบรายหมวดงาน (บาท)</h3>",
                   table(["หมวดงาน"] + columns, [[entry["category"]] + [money(entry["values"].get(name)) for name in columns] for entry in f["categories"]],
                         ["left"] + ["right"] * len(columns))]
        number += 1
    if f["spread"]:
        tables += [f"<h3>ตารางที่ {number}: รายการที่ราคาต่างกันมากที่สุด (เรียงตามส่วนต่างเป็นบาท)</h3>",
                   table(["รายการ", "ปริมาณ", "ต่ำสุด", "ราคา (บาท)", "สูงสุด", "ราคา (บาท)", "ต่างกัน"],
                         [[entry["item"], f"{quantity(entry['quantity'])} {entry['unit']}".strip(), entry["low_party"], money(entry["low"]),
                           entry["high_party"], money(entry["high"]), pct(entry["spread_pct"])] for entry in f["spread"]],
                         ["left", "center", "left", "right", "left", "right", "center"])]
    insights = []
    if len(rows) > 1:
        insights.append(f"{low['party']} เสนอราคารวมต่ำสุด {money(low['total'])} บาท ส่วน {high['party']} สูงสุด {money(high['total'])} บาท "
                        f"ต่างกัน {money(high['total'] - low['total'])} บาท ({pct(high['diff_pct'])} ของราคาต่ำสุด)")
    if f["common_items"] and f["low_on_common"] > f["best_of"]:
        insights.append(f"ในรายการที่ทุกรายเสนอราคา {f['common_items']:,} รายการ หากเลือกราคาต่ำสุดของแต่ละรายการ จะได้ราคารวม {money(f['best_of'])} บาท "
                        f"ต่ำกว่าราคาของ {low['party']} ในรายการเดียวกัน {money(f['low_on_common'] - f['best_of'])} บาท ซึ่งใช้เป็นเป้าในการต่อรองได้")
    if f["wins"]:
        leader = max(f["wins"], key=f["wins"].get)
        count = f"{f['wins'][leader]:,} จาก {f['common_items']:,} รายการ"
        insights.append(f"{leader} เสนอราคาต่ำสุดในรายรายการมากที่สุด ({count}) แม้ผู้ที่ราคารวมต่ำสุดคือ {low['party']}" if leader != low["party"]
                        else f"{leader} เสนอราคาต่ำสุดในรายรายการมากที่สุดด้วย ({count})")
    if f["spread"]:
        top = f["spread"][0]
        insights.append(f"รายการที่ราคาต่างกันมากที่สุดคือ {top['item']}: {top['low_party']} {money(top['low'])} บาท เทียบ {top['high_party']} "
                        f"{money(top['high'])} บาท ควรตรวจว่าขอบเขตงานและสเปกตรงกันก่อนเทียบราคา")
    missing = [f"{row['party']} {row['missing']:,} รายการ" for row in rows if row["missing"]]
    if missing:
        insights.append(f"มีรายการที่บางรายไม่ได้เสนอราคา: {', '.join(missing)} ราคารวมของรายเหล่านี้จึงอาจต่ำกว่าความจริง")
    if f["benchmark"] and low["vs_benchmark_pct"] is not None:
        direction = "สูงกว่า" if low["vs_benchmark_pct"] > 0 else "ต่ำกว่า"
        insights.append(f"ราคาต่ำสุด{direction}{f['benchmark']} {pct(abs(low['vs_benchmark_pct']))}")
    analysis = ["<h3>การวิเคราะห์เชิงลึก</h3>", bullets(insights)] if insights else []
    executive = ["<h2>บทสรุปผู้บริหาร (Executive Summary)</h2>",
                 table(["ผู้เสนองาน", "ราคารวม (บาท)", "สูงกว่าต่ำสุด"], [[row["party"], money(row["total"]), pct(row["diff_pct"])] for row in rows],
                       ["left", "right", "center"]),
                 f'<div class="call">{esc(f["headline"])}</div>',
                 bullets(["ยืนยันขอบเขตงานและสเปกของรายการที่ราคาต่างกันมากกับผู้เสนอทุกรายก่อนตัดสิน",
                          "ใช้ราคาต่ำสุดรายรายการเป็นเป้าในการต่อรองกับผู้เสนอที่ได้รับเลือก"]
                         + (["ขอให้ผู้ที่ยังไม่เสนอราคาบางรายการเสนอให้ครบ เพื่อเทียบราคารวมได้เท่ากัน"] if missing else []))]
    return ["\n".join(intro), "\n".join(tables + analysis), "\n".join(executive)]


def estimate_pages(f):
    share = lambda value: pct(value / f["total"] * 100 if f["total"] and value is not None else None)
    intro = [
        "<h2>บทนำและขอบเขตการวิเคราะห์</h2>",
        paragraph(f"รายงานฉบับนี้สรุปราคาประมาณการจากรายการ {f['priced']:,} รายการที่มีราคา แบ่งเป็น {len(f['categories']):,} หมวดงาน "
                  f"มูลค่ารวม {money(f['total'])} บาท"),
        paragraph("มูลค่าแต่ละรายการใช้จำนวนเงินในไฟล์ หรือราคาต่อหน่วย × ปริมาณ เมื่อไม่มีจำนวนเงิน โดยไม่นับแถวสรุปยอดและ VAT เพื่อไม่ให้นับซ้ำ"),
        paragraph("ทุกตัวเลขในรายงานคำนวณจากไฟล์ที่อัปโหลดเท่านั้น หมวดงานอ่านจากคอลัมน์หมวดหรือหัวข้อในไฟล์", True),
        "<h3>ตารางที่ 1: สรุปมูลค่า</h3>",
    ]
    summary = [["มูลค่ารวม (บาท)", money(f["total"])], ["รายการที่มีราคา", f"{f['priced']:,}"], ["หมวดงาน", f"{len(f['categories']):,}"]]
    if f["material"] is not None:
        summary.append(["ค่าวัสดุ (บาท)", f"{money(f['material'])} ({share(f['material'])})"])
    if f["labour"] is not None:
        summary.append(["ค่าแรง (บาท)", f"{money(f['labour'])} ({share(f['labour'])})"])
    if f["unpriced"]:
        summary.append(["รายการที่ยังไม่มีราคา", f"{f['unpriced']:,}"])
    if f["stated"]:
        summary.append(["ยอดรวมที่ไฟล์ระบุ (บาท)", money(f["stated"])])
    intro.append(table(["หัวข้อ", "ค่า"], summary, ["left", "right"]))
    if f["stated"] and f["total"] and abs(f["stated"] - f["total"]) / f["stated"] > .005:
        intro.append(paragraph(f"ยอดรวมที่ไฟล์ระบุ {money(f['stated'])} บาท ต่างจากที่คำนวณจากรายบรรทัด {money(f['total'])} บาท "
                               "ควรตรวจว่าแถวรวมในไฟล์ครอบคลุมทุกรายการ หรือรวมค่าดำเนินการ/กำไรที่ไม่ได้อยู่ในรายการ", True))
    tables = ["<h2>รายละเอียดมูลค่า</h2>"]
    number = 2
    if len(f["categories"]) > 1:
        tables += [f"<h3>ตารางที่ {number}: มูลค่าตามหมวดงาน</h3>",
                   table(["หมวดงาน", "มูลค่า (บาท)", "สัดส่วน", "รายการ"],
                         [[entry["category"], money(entry["value"]), pct(entry["share"]), f"{entry['items']:,}"] for entry in f["categories"]]
                         + [["รวมทุกหมวด", money(f["total"]), "100.0%", f"{f['priced']:,}"]],
                         ["left", "right", "center", "center"], total_row=True)]
        number += 1
    tables += [f"<h3>ตารางที่ {number}: รายการที่มีมูลค่าสูงสุด</h3>",
               table(["รายการ", "หมวดงาน", "ปริมาณ", "ราคาต่อหน่วย (บาท)", "มูลค่า (บาท)", "สัดส่วน"],
                     [[entry["item"], entry["category"], f"{quantity(entry['quantity'])} {entry['unit']}".strip(), money(entry["rate"]),
                       money(entry["value"]), pct(entry["share"])] for entry in f["top"]],
                     ["left", "left", "center", "right", "right", "center"])]
    insights = []
    if f["pareto_items"] and f["priced"]:
        insights.append(f"{f['pareto_items']:,} รายการแรก ({f['pareto_items'] / f['priced'] * 100:.0f}% ของรายการ) รวมกันเป็น 80% ของมูลค่า "
                        "การตรวจราคาและปริมาณของกลุ่มนี้ให้ผลต่องบประมาณมากที่สุด")
    if len(f["categories"]) > 1:
        top = f["categories"][0]
        insights.append(f"หมวดที่มีมูลค่าสูงสุดคือ {top['category']} {money(top['value'])} บาท ({pct(top['share'])} ของมูลค่ารวม)")
    if f["material"] is not None and f["labour"] is not None and f["total"]:
        insights.append(f"ค่าวัสดุคิดเป็น {share(f['material'])} และค่าแรง {share(f['labour'])} ของมูลค่ารวม")
    if f["top"]:
        insights.append(f"รายการที่มีมูลค่าสูงสุดคือ {f['top'][0]['item']} {money(f['top'][0]['value'])} บาท ({pct(f['top'][0]['share'])})")
    if f["unpriced"]:
        insights.append(f"ยังมี {f['unpriced']:,} รายการที่ไม่มีราคา มูลค่ารวมจึงยังไม่ครบ")
    analysis = ["<h3>การวิเคราะห์เชิงลึก</h3>", bullets(insights)] if insights else []
    actions = ["ตรวจราคาต่อหน่วยของรายการมูลค่าสูงเทียบราคาตลาดหรือราคากลาง", "ยืนยันปริมาณงานของรายการมูลค่าสูงกับแบบก่อสร้าง"]
    if f["unpriced"]:
        actions.append("เติมราคารายการที่ยังว่างก่อนใช้มูลค่ารวมเป็นงบประมาณ")
    executive = ["<h2>บทสรุปผู้บริหาร (Executive Summary)</h2>", f'<div class="call">{esc(f["headline"])}</div>', bullets(actions)]
    return ["\n".join(intro), "\n".join(tables + analysis), "\n".join(executive)]


def render(facts):
    if facts["kind"] == "comparison":
        english = "Bid Price Comparison Analysis"
        lines = [f"ผู้เสนองาน {len(facts['ranking'])} ราย: {', '.join(facts['parties'])}"] + ([f"ราคาอ้างอิง: {facts['benchmark']}"] if facts["benchmark"] else [])
        cover = title_page("รายงานเปรียบเทียบราคาผู้เสนองาน", english, facts, lines)
        pages = comparison_pages(facts)
    else:
        english = "Cost Estimate Summary"
        cover = title_page("รายงานสรุปราคาประมาณการ", english, facts, [f"มูลค่ารวม {money(facts['total'])} บาท"])
        pages = estimate_pages(facts)
    run = f"{esc(facts['project'])} — {english}"
    return document(run, run, [cover, *pages])
