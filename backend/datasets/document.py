"""What kind of document a workbook is and, for construction cost documents,
the dashboard figures and A4 report made for that kind.

  benchmark   bids priced against a benchmark (ราคากลาง): the existing BOQ engine
  comparison  several bidders priced side by side (ใบเปรียบเทียบราคา)
  estimate    one priced bill of quantities or quotation (ใบประมาณราคา / ใบเสนอราคา)
  general     anything else: the regular analysis and a report written for the file

Every figure here is computed from the stored rows (or, for a benchmark file, by
the BOQ engine on the original upload); no model is called.

CLI: document.py <dataset.sqlite> <original upload> <filename> <out_dir> [name shown to the user]
Prints one JSON line {"result": {...}} and writes report.html to out_dir.
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
from collections import defaultdict
from itertools import accumulate
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "analysis"))

LABELS = {"benchmark": "ใบเทียบราคากับราคากลาง", "comparison": "ใบเปรียบเทียบราคาผู้เสนองาน",
          "estimate": "ใบประมาณราคา / ใบเสนอราคา", "general": "ข้อมูลทั่วไป"}

ITEM = re.compile(r"รายการ|รายละเอียด|description|ชื่องาน", re.I)
ITEM_WEAK = re.compile(r"\bitem\b|งาน", re.I)
QUANTITY = re.compile(r"ปริมาณ|จำนวน(?!เงิน)|\bqty\b|quantity", re.I)
UNIT = re.compile(r"^\s*(?:หน่วย|unit|uom)\s*\.?\s*$", re.I)
CATEGORY = re.compile(r"หมวด|category|ประเภทงาน|ระบบงาน", re.I)
UNIT_PRICE = re.compile(r"ต่อหน่วย|/\s*หน่วย|unit\s*price|unit\s*rate|\brate\b|@|ราคา/ชุด", re.I)
AMOUNT = re.compile(r"จำนวนเงิน|รวมเงิน|มูลค่า|ราคารวม|เป็นเงิน|amount|total|รวม", re.I)
PRICE_WORD = re.compile(r"ราคา|price|cost|ค่า", re.I)
MATERIAL = re.compile(r"วัสดุ|ค่าของ|material|\bmat\b", re.I)
LABOUR = re.compile(r"ค่าแรง|แรงงาน|labou?r", re.I)
BENCHMARK = re.compile(r"ราคากลาง|ราคาเป้าหมาย|เป้าหมาย|budget|target|ประมาณการ|ราคาประเมิน|engineer", re.I)
PROJECT = re.compile(r"โครงการ|project", re.I)
VAT = re.compile(r"vat|ภาษี", re.I)
GRAND = re.compile(r"grand\s*total|รวมทั้งสิ้น|รวมทั้งหมด|ยอดรวมทั้งหมด|รวมทั้งโครงการ|total\s+project|net\s+total", re.I)
PLACEHOLDER = re.compile(r"บริษัท|จำกัด|co\.?,?\s*ltd\.?|[_\s.\-]", re.I)


def number(value):
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def text(value):
    return str(value).strip() if isinstance(value, str) and value.strip() else ""


def clean_party(name):
    """'บริษัท บริษัท 68เดคคอร์เรชั่น จำกัด จำกัด' -> 'บริษัท 68เดคคอร์เรชั่น จำกัด'."""
    words = []
    for word in re.sub(r"\s+", " ", name).strip().split(" "):
        if not words or words[-1] != word:
            words.append(word)
    return " ".join(words)[:80]


def axis_of(label):
    if LABOUR.search(label):
        return "labour"
    if MATERIAL.search(label):
        return "material"
    return None


def read_columns(sheet):
    """Roles of a table's columns: item, quantity, unit, category, and priced
    columns grouped by party (a bidder, the benchmark, or None for a one-price file)."""
    roles = {"item": None, "quantity": None, "unit": None, "category": None}
    priced, weak_item = [], None
    for column in sheet["columns"]:
        name, kind = column["name"], column["data_type"]
        parts = [part.strip() for part in name.split(" / ")]
        metric, prefix = re.sub(r"\s*\(\d+\)$", "", parts[-1]), " / ".join(parts[:-1])
        if not prefix and kind in ("text", "mixed"):
            if roles["category"] is None and CATEGORY.search(name):
                roles["category"] = column["key"]
                continue
            if roles["unit"] is None and UNIT.match(name):
                roles["unit"] = column["key"]
                continue
            # 'Description' / 'รายการ' names the line; a bare 'Item' is often just its number.
            if roles["item"] is None and ITEM.search(name):
                roles["item"] = column["key"]
                continue
            if weak_item is None and ITEM_WEAK.search(name):
                weak_item = column["key"]
            if kind == "text":
                continue
        if kind not in ("number", "mixed"):
            continue
        if not prefix and roles["quantity"] is None and QUANTITY.search(name) and not PRICE_WORD.search(name):
            roles["quantity"] = column["key"]
            continue
        if UNIT_PRICE.search(metric):
            measure = "unit"
        elif AMOUNT.search(metric):
            measure = "amount"
        elif PRICE_WORD.search(metric) or MATERIAL.search(metric) or LABOUR.search(metric):
            measure = "unit" if re.search(r"หน่วย|unit", metric, re.I) else "amount"
        else:
            continue
        party, axis = None, axis_of(metric)
        if prefix:
            if BENCHMARK.search(prefix):
                party = "__benchmark__:" + clean_party(prefix)
            elif axis_of(prefix):
                axis = axis or axis_of(prefix)
            elif not (PRICE_WORD.search(prefix) or AMOUNT.search(prefix) or QUANTITY.search(prefix)):
                party = clean_party(prefix)
        priced.append({"key": column["key"], "party": party, "measure": measure, "axis": axis, "name": name})
    roles["item"] = roles["item"] or weak_item
    # An amount with no axis of its own follows the unit price just before it
    # ('ราคาวัสดุ/หน่วย', 'จำนวนเงิน', 'ราคาค่าแรง/หน่วย', 'จำนวนเงิน').
    # Only the amount right next to its unit price inherits; a line total ('รวม') never does.
    for previous, column in zip(priced, priced[1:]):
        metric = re.sub(r"\s*\(\d+\)$", "", column["name"].split(" / ")[-1])
        if column["measure"] == "amount" and column["axis"] is None and previous["measure"] == "unit" and previous["axis"] \
                and previous["party"] == column["party"] and not re.search(r"รวม|total", metric, re.I):
            column["axis"] = previous["axis"]
    return roles, priced


def load(connection, sheet):
    summary = set(sheet.get("summary_rows") or [])
    return [(row_number, json.loads(data), row_number in summary)
            for row_number, data in connection.execute(f'SELECT row_number, data FROM "data_{sheet["id"]}" ORDER BY row_number')]


def row_total(values, columns, quantity):
    """Value of one line for one party: the line total when there is one, else
    its material + labour amounts, else unit prices × quantity. Returns
    (total, material, labour) with None where the file has no figure."""
    amounts = [c for c in columns if c["measure"] == "amount"]
    parts = {"material": None, "labour": None}
    for axis in parts:
        found = [number(values.get(c["key"])) for c in amounts if c["axis"] == axis]
        found = [v for v in found if v is not None]
        if found:
            parts[axis] = sum(found)
    if not any(v is not None for v in parts.values()) and quantity is not None:
        for axis in parts:
            rates = [number(values.get(c["key"])) for c in columns if c["measure"] == "unit" and c["axis"] == axis]
            rates = [v for v in rates if v is not None]
            if rates:
                parts[axis] = rates[0] * quantity
    total = next((number(values.get(c["key"])) for c in amounts if c["axis"] is None and number(values.get(c["key"])) is not None), None)
    if total is None and any(v is not None for v in parts.values()):
        total = sum(v for v in parts.values() if v is not None)
    if total is None and quantity is not None:
        rate = next((number(values.get(c["key"])) for c in columns if c["measure"] == "unit" and c["axis"] is None
                     and number(values.get(c["key"])) is not None), None)
        total = rate * quantity if rate is not None else None
    return total, parts["material"], parts["labour"]


def lines(rows, roles, parties):
    """Line items with a category. A row with a label but no quantity and no
    price is a section heading; it names the category of the lines below it."""
    category = None
    out, stated = [], defaultdict(list)
    for row_number, values, summary in rows:
        label = text(values.get(roles["item"])) if roles["item"] else ""
        quantity = number(values.get(roles["quantity"])) if roles["quantity"] else None
        totals = {party: row_total(values, columns, quantity) for party, columns in parties.items()}
        priced = any(total[0] is not None for total in totals.values())
        first = next((text(value) for value in values.values() if text(value)), "")
        if summary:
            for party, total in totals.items():
                if total[0] is not None:
                    stated[party].append((first, total[0]))
            continue
        if roles["category"] and text(values.get(roles["category"])):
            category = text(values.get(roles["category"]))[:60]
        elif label and not priced and quantity is None:
            category = label[:60]
            continue
        if not label and not priced:
            continue
        rates = {party: next((number(values.get(c["key"])) for c in columns if c["measure"] == "unit"
                              and number(values.get(c["key"])) is not None), None) for party, columns in parties.items()}
        out.append({"row": row_number, "item": (label or first)[:120], "category": category or "ไม่ระบุหมวด", "quantity": quantity,
                    "unit": text(values.get(roles["unit"])) if roles["unit"] else "", "totals": totals, "rates": rates})
    return out, stated


def stated_total(entries):
    """What the file says the whole total is: a grand-total line, not a VAT line.
    A file split into zones has a TOTAL per zone and none of them is the whole,
    so without a grand-total line nothing is compared."""
    values = [value for label, value in entries if GRAND.search(label) and not VAT.search(label)]
    return values[-1] if values else None


def classify(dataset, connection):
    """The table that best fits a construction cost document, and its kind."""
    best = None
    # A table read from a picture counts only when pictures are all the file has (a photo or scan).
    pictures_only = all(sheet.get("source") == "image_ocr" for sheet in dataset["sheets"] if not sheet.get("combined_from"))
    for sheet in dataset["sheets"]:
        if sheet.get("combined_from") or (sheet.get("source") == "image_ocr" and not pictures_only) or sheet.get("pivot"):
            continue
        roles, priced = read_columns(sheet)
        if not roles["item"] or not priced:
            continue
        groups = defaultdict(list)
        for column in priced:
            groups[column["party"]].append(column)
        rows = load(connection, sheet)
        # A bidder column with no figure at all is an empty template slot.
        filled = {party for party in groups if any(number(values.get(c["key"])) is not None for _, values, _ in rows for c in groups[party])}
        bidders = [party for party in groups if party and not party.startswith("__benchmark__") and party in filled and PLACEHOLDER.sub("", party)]
        benchmark = next((party for party in groups if party and party.startswith("__benchmark__") and party in filled), None)
        if bidders and len(bidders) + (1 if benchmark else 0) >= 2:
            kind, parties = "comparison", {party: groups[party] for party in bidders + ([benchmark] if benchmark else [])}
        # A priced bill has quantities with a unit or a unit rate; a price list of
        # houses or a sales register does not.
        elif None in groups and None in filled and roles["quantity"] and (roles["unit"] or any(c["measure"] == "unit" for c in groups[None])):
            kind, parties = "estimate", {None: groups[None]}
        else:
            continue
        items, stated = lines(rows, roles, parties)
        priced_items = sum(any(t[0] is not None for t in line["totals"].values()) for line in items)
        if priced_items < 3:
            continue
        score = (kind == "comparison", priced_items)
        if best is None or score > best[0]:
            best = (score, {"kind": kind, "sheet": sheet, "roles": roles, "parties": parties, "benchmark": benchmark,
                            "items": items, "stated": stated})
    return best[1] if best else None


def party_name(party):
    return party.split(":", 1)[1] if party and party.startswith("__benchmark__:") else (party or "")


def project_name(sheet, filename):
    for line in sheet.get("title_lines") or []:
        match = PROJECT.search(line)
        if match:
            # 'ใบเปรียบเทียบราคา โครงการ X' -> 'โครงการ X': the document kind is already in the title.
            return line[match.start():][:100].strip()
    return Path(filename).stem[:100]


def pct(value, signed=False):
    return "—" if value is None else (f"{value:+.1f}%" if signed else f"{value:.1f}%")


def money(value):
    return "—" if value is None else f"{value:,.0f}"


def comparison(found, filename):
    sheet, items, benchmark = found["sheet"], found["items"], found["benchmark"]
    bidders = [party for party in found["parties"] if party != benchmark]
    names = {party: party_name(party) for party in found["parties"]}
    totals = {}
    for party in found["parties"]:
        values = [line["totals"][party] for line in items]
        totals[party] = {"total": sum(v[0] for v in values if v[0] is not None),
                         "material": sum(v[1] for v in values if v[1] is not None) if any(v[1] is not None for v in values) else None,
                         "labour": sum(v[2] for v in values if v[2] is not None) if any(v[2] is not None for v in values) else None,
                         "priced": sum(v[0] is not None for v in values), "stated": stated_total(found["stated"].get(party, []))}
    ranked = sorted(bidders, key=lambda party: totals[party]["total"])
    low_total = totals[ranked[0]]["total"]
    reference = totals[benchmark]["total"] if benchmark else None
    rows = []
    for rank, party in enumerate(ranked, 1):
        t = totals[party]
        rows.append({"rank": rank, "party": names[party], "total": t["total"], "material": t["material"], "labour": t["labour"],
                     "diff": t["total"] - low_total, "diff_pct": (t["total"] - low_total) / low_total * 100 if low_total else None,
                     "vs_benchmark_pct": (t["total"] - reference) / reference * 100 if reference else None, "priced": t["priced"],
                     "missing": sum(1 for line in items if line["totals"][party][0] is None
                                    and any(line["totals"][other][0] is not None for other in bidders if other != party)),
                     "stated": t["stated"]})
    # Items every bidder priced: where prices spread most, and the best-of-each-line total.
    common = [line for line in items if all(line["totals"][party][0] is not None for party in bidders)]
    spread, wins, best_of = [], defaultdict(int), 0.0
    for line in common:
        values = {party: line["totals"][party][0] for party in bidders}
        lo_party, hi_party = min(values, key=values.get), max(values, key=values.get)
        wins[names[lo_party]] += 1
        best_of += values[lo_party]
        if values[lo_party] > 0 and values[hi_party] > values[lo_party]:
            spread.append({"item": line["item"], "category": line["category"], "quantity": line["quantity"], "unit": line["unit"],
                           "low_party": names[lo_party], "low": values[lo_party], "high_party": names[hi_party], "high": values[hi_party],
                           "spread_pct": (values[hi_party] - values[lo_party]) / values[lo_party] * 100})
    spread.sort(key=lambda entry: entry["high"] - entry["low"], reverse=True)
    low_on_common = sum(line["totals"][ranked[0]][0] for line in common)
    # Totals over only the lines every bidder priced: the like-for-like comparison.
    for row, party in zip(rows, ranked):
        row["common_total"] = sum(line["totals"][party][0] for line in common) if common else None
    fair = min(zip(rows, ranked), key=lambda pair: pair[0]["common_total"])[0] if common else None
    categories = defaultdict(lambda: defaultdict(float))
    for line in items:
        for party in found["parties"]:
            if line["totals"][party][0] is not None:
                categories[line["category"]][names[party]] += line["totals"][party][0]
    facts = {
        "kind": "comparison", "project": project_name(sheet, filename), "filename": filename, "sheet": sheet.get("source_sheet") or sheet["name"],
        "range": (sheet.get("area") or {}).get("ref"), "parties": [names[p] for p in ranked], "benchmark": names[benchmark] if benchmark else None,
        "benchmark_total": reference, "items": len(items), "common_items": len(common), "ranking": rows, "spread": spread[:15],
        "wins": dict(wins), "best_of": best_of, "low_on_common": low_on_common, "fair_low": fair["party"] if fair else None,
        "categories": [{"category": name, "values": dict(values)} for name, values in sorted(categories.items(), key=lambda entry: -max(entry[1].values(), default=0))],
        "axes": any(totals[p]["material"] is not None for p in bidders),
    }
    low, high = rows[0], rows[-1]
    headline = (f"{low['party']} เสนอราคารวมต่ำสุด {money(low['total'])} บาท ต่ำกว่า {high['party']} {money(high['total'] - low['total'])} บาท "
                f"({pct(high['diff_pct'])} ของราคาต่ำสุด)") if len(rows) > 1 else f"{low['party']} เสนอราคารวม {money(low['total'])} บาท"
    if low["missing"]:
        # A low total that leaves lines unpriced is not a like-for-like low bid.
        headline += (f" แต่ {low['party']} ไม่ได้เสนอราคา {low['missing']:,} รายการที่รายอื่นเสนอ"
                     + (f" เมื่อเทียบเฉพาะ {len(common):,} รายการที่ทุกรายเสนอ ผู้ที่ราคาต่ำสุดคือ {fair['party']} {money(fair['common_total'])} บาท"
                        if fair else ""))
    elif common and low_on_common > best_of:
        headline += (f" และหากต่อรองให้ได้ราคาต่ำสุดของแต่ละรายการ จะต่ำกว่าผู้เสนอต่ำสุดอีก {money(low_on_common - best_of)} บาท "
                     f"(คิดจาก {len(common):,} รายการที่ทุกรายเสนอราคา)")
    facts["headline"] = headline
    return facts


def estimate(found, filename):
    sheet, items = found["sheet"], found["items"]
    values = [line["totals"][None] for line in items]
    total = sum(v[0] for v in values if v[0] is not None)
    material = sum(v[1] for v in values if v[1] is not None) if any(v[1] is not None for v in values) else None
    labour = sum(v[2] for v in values if v[2] is not None) if any(v[2] is not None for v in values) else None
    priced = [line for line in items if line["totals"][None][0] is not None]
    categories = defaultdict(lambda: {"value": 0.0, "items": 0})
    for line in priced:
        categories[line["category"]]["value"] += line["totals"][None][0]
        categories[line["category"]]["items"] += 1
    ordered = sorted(priced, key=lambda line: -line["totals"][None][0])
    running, pareto = 0.0, 0
    for line in ordered:
        if not total or running >= total * .8:
            break
        running += line["totals"][None][0]
        pareto += 1
    facts = {
        "kind": "estimate", "project": project_name(sheet, filename), "filename": filename, "sheet": sheet.get("source_sheet") or sheet["name"],
        "range": (sheet.get("area") or {}).get("ref"), "total": total, "material": material, "labour": labour,
        "items": len(items), "priced": len(priced), "unpriced": len(items) - len(priced), "pareto_items": pareto,
        "stated": stated_total(found["stated"].get(None, [])),
        "categories": [{"category": name, **entry, "share": entry["value"] / total * 100 if total else None}
                       for name, entry in sorted(categories.items(), key=lambda entry: -entry[1]["value"])],
        "top": [{"item": line["item"], "category": line["category"], "quantity": line["quantity"], "unit": line["unit"],
                 "rate": line["rates"][None], "value": line["totals"][None][0], "share": line["totals"][None][0] / total * 100 if total else None}
                for line in ordered[:15]],
    }
    share = pareto / len(priced) * 100 if priced else 0
    facts["headline"] = (f"มูลค่ารวม {money(total)} บาท จาก {len(priced):,} รายการ โดย {pareto:,} รายการแรก ({share:.0f}% ของรายการ) "
                         f"คิดเป็น 80% ของมูลค่า ควรตรวจราคาและปริมาณของกลุ่มนี้ก่อน") if total else "ยังคำนวณมูลค่ารวมจากไฟล์นี้ไม่ได้"
    return facts


def benchmark(report, filename):
    """Dashboard figures from the BOQ engine's comparison against the benchmark."""
    vendors = []
    for v in report["vendors"]:
        t = v["total"]
        vendors.append({"vendor": v["vendor"], "benchmark": v["benchmark"], "original": t["original"], "normalized": t["normalized"],
                        "savings": t["savings"], "savings_pct": t["savings_pct"], "items": t["benchmark_items"],
                        "material_dev_pct": t.get("material_dev_pct"), "labour_dev_pct": t.get("labour_dev_pct"),
                        "over": (t.get("material_over") or 0) + (t.get("labour_over") or 0) + (t.get("quantity_over") or 0),
                        "groups": [{"group": g["group"], "original": g["original"], "normalized": g["normalized"], "savings": g["savings"],
                                    "savings_pct": g["savings_pct"], "material_dev_pct": g.get("material_dev_pct"),
                                    "labour_dev_pct": g.get("labour_dev_pct")} for g in v["groups"]]})
    return {"kind": "benchmark", "project": next((v.get("project") for v in report["vendors"] if v.get("project")), None) or Path(filename).stem,
            "filename": filename, "vendors": vendors, "tolerance": report["tolerance"], "headline": (report.get("executive") or {}).get("headline", "")}


# ---- dashboard payloads --------------------------------------------------------------------------------------------

def kpi(label, value, fmt, note=""):
    return {"label": label, "value": value, "format": fmt, "note": note}


def chart(identifier, title, kind, categories, series, fmt="money", note=""):
    return {"id": identifier, "title": title, "kind": kind, "categories": categories, "series": series, "format": fmt, "note": note}


def comparison_dashboard(facts):
    rows = facts["ranking"]
    low, high = rows[0], rows[-1]
    kpis = [kpi("ผู้เสนอราคา", len(rows), "count", "ราย"), kpi("ราคารวมต่ำสุด", low["total"], "money", low["party"])]
    if len(rows) > 1:
        kpis.append(kpi("ส่วนต่างสูงสุด–ต่ำสุด", high["total"] - low["total"], "money", f"{pct(high['diff_pct'])} ของราคาต่ำสุด"))
    kpis.append(kpi("รายการที่เปรียบเทียบได้", facts["common_items"], "count", f"จาก {facts['items']:,} รายการ"))
    if facts["fair_low"] and facts["fair_low"] != low["party"]:
        fair = next(row for row in rows if row["party"] == facts["fair_low"])
        kpis.append(kpi("ต่ำสุดเมื่อเทียบรายการเดียวกัน", fair["common_total"], "money", fair["party"]))
    if facts["common_items"] and facts["low_on_common"] > facts["best_of"]:
        kpis.append(kpi("ต่อรองได้อีกหากใช้ราคาต่ำสุดรายรายการ", facts["low_on_common"] - facts["best_of"], "money", "เทียบกับผู้เสนอต่ำสุด"))
    if facts["benchmark"]:
        kpis.append(kpi(f"ราคาต่ำสุดเทียบ{facts['benchmark']}", low["vs_benchmark_pct"], "percent_signed", money(facts["benchmark_total"]) + " บาท"))
    parties = [row["party"] for row in rows]
    if facts["axes"]:
        totals = chart("totals", "ราคารวมแต่ละผู้เสนอ (ค่าวัสดุ + ค่าแรง)", "stacked", parties,
                       [{"name": "ค่าวัสดุ", "values": [row["material"] for row in rows]}, {"name": "ค่าแรง", "values": [row["labour"] for row in rows]}])
    else:
        totals = chart("totals", "ราคารวมแต่ละผู้เสนอ", "bar", parties, [{"name": "ราคารวม", "values": [row["total"] for row in rows]}])
    if facts["benchmark_total"]:
        totals["reference"] = {"name": facts["benchmark"], "value": facts["benchmark_total"]}
    charts = [totals]
    if len(rows) > 1:
        charts.append(chart("gap", "สูงกว่าผู้เสนอต่ำสุด", "hbar", parties[1:], [{"name": "สูงกว่าราคาต่ำสุด", "values": [row["diff_pct"] for row in rows[1:]]}], "percent"))
    categories = facts["categories"][:10]
    if len(categories) > 1:
        names = facts["parties"] + ([facts["benchmark"]] if facts["benchmark"] else [])
        charts.append(chart("categories", "เปรียบเทียบรายหมวดงาน", "bar", [entry["category"] for entry in categories],
                            [{"name": name, "values": [entry["values"].get(name) for entry in categories]} for name in names]))
    if facts["spread"]:
        top = facts["spread"][:10]
        charts.append(chart("spread", "รายการที่ราคาต่างกันมากที่สุด", "hbar", [entry["item"][:40] for entry in top],
                            [{"name": "ส่วนต่างสูงสุด–ต่ำสุด", "values": [entry["high"] - entry["low"] for entry in top]}]))
    if len(facts["wins"]) > 1:
        charts.append(chart("wins", "จำนวนรายการที่แต่ละรายเสนอต่ำสุด", "donut", list(facts["wins"]), [{"name": "รายการ", "values": list(facts["wins"].values())}], "count"))
    tables = [
        {"title": "สรุปราคารวมและอันดับ", "columns": [("อันดับ", "count"), ("ผู้เสนอราคา", "text"), ("ราคารวม (บาท)", "money"),
                                                     ("สูงกว่าต่ำสุด", "percent"), ("รายการที่เสนอ", "count"), ("ไม่ได้เสนอ", "count"),
                                                     (f"เฉพาะ {facts['common_items']:,} รายการที่ทุกรายเสนอ (บาท)", "money")],
         "rows": [[row["rank"], row["party"], row["total"], row["diff_pct"], row["priced"], row["missing"], row["common_total"]] for row in rows]},
        {"title": "รายการที่ราคาต่างกันมากที่สุด", "columns": [("รายการ", "text"), ("ต่ำสุด", "text"), ("ราคาต่ำสุด (บาท)", "money"),
                                                            ("สูงสุด", "text"), ("ราคาสูงสุด (บาท)", "money"), ("ต่างกัน", "percent")],
         "rows": [[entry["item"], entry["low_party"], entry["low"], entry["high_party"], entry["high"], entry["spread_pct"]] for entry in facts["spread"]]},
    ]
    return kpis, charts, tables


def estimate_dashboard(facts):
    kpis = [kpi("มูลค่ารวม", facts["total"], "money", "บาท"), kpi("จำนวนรายการ", facts["priced"], "count", f"{len(facts['categories'])} หมวดงาน")]
    if facts["material"] is not None and facts["total"]:
        kpis.append(kpi("สัดส่วนค่าวัสดุ", facts["material"] / facts["total"] * 100, "percent", money(facts["material"]) + " บาท"))
    if facts["labour"] is not None and facts["total"]:
        kpis.append(kpi("สัดส่วนค่าแรง", facts["labour"] / facts["total"] * 100, "percent", money(facts["labour"]) + " บาท"))
    if facts["pareto_items"]:
        kpis.append(kpi("รายการที่รวมกันเป็น 80% ของมูลค่า", facts["pareto_items"], "count", "รายการ"))
    if facts["unpriced"]:
        kpis.append(kpi("รายการที่ยังไม่มีราคา", facts["unpriced"], "count", "รายการ"))
    charts = []
    categories = facts["categories"][:12]
    if len(categories) > 1:
        charts.append(chart("categories", "มูลค่าตามหมวดงาน", "hbar", [entry["category"] for entry in categories], [{"name": "มูลค่า", "values": [entry["value"] for entry in categories]}]))
    if facts["material"] is not None and facts["labour"] is not None:
        charts.append(chart("split", "สัดส่วนค่าวัสดุและค่าแรง", "donut", ["ค่าวัสดุ", "ค่าแรง"], [{"name": "มูลค่า", "values": [facts["material"], facts["labour"]]}]))
    top = facts["top"][:12]
    if top:
        cumulative = list(accumulate(entry["share"] or 0 for entry in top))
        charts.append(chart("top", "รายการที่มีมูลค่าสูงสุด", "pareto", [entry["item"][:40] for entry in top],
                            [{"name": "มูลค่า", "values": [entry["value"] for entry in top]}, {"name": "สะสม (% ของมูลค่ารวม)", "values": cumulative}]))
    tables = [
        {"title": "มูลค่าตามหมวดงาน", "columns": [("หมวดงาน", "text"), ("มูลค่า (บาท)", "money"), ("สัดส่วน", "percent"), ("รายการ", "count")],
         "rows": [[entry["category"], entry["value"], entry["share"], entry["items"]] for entry in facts["categories"]]},
        {"title": "รายการที่มีมูลค่าสูงสุด", "columns": [("รายการ", "text"), ("ปริมาณ", "number"), ("หน่วย", "text"), ("ราคาต่อหน่วย", "money"),
                                                      ("มูลค่า (บาท)", "money"), ("สัดส่วน", "percent")],
         "rows": [[entry["item"], entry["quantity"], entry["unit"], entry["rate"], entry["value"], entry["share"]] for entry in facts["top"]]},
    ]
    return kpis, charts, tables


def benchmark_dashboard(facts):
    vendors = facts["vendors"]
    first = vendors[0]
    kpis = [kpi("ราคาที่เสนอ", sum(v["original"] for v in vendors), "money", ", ".join(v["vendor"] for v in vendors)),
            kpi("ราคาหลังปรับเทียบราคากลาง", sum(v["normalized"] for v in vendors), "money", f"เกณฑ์ {facts['tolerance'] * 100:.0f}%"),
            kpi("ส่วนที่ควรต่อรอง", sum(v["savings"] for v in vendors), "money", pct(first["savings_pct"]) if len(vendors) == 1 else f"{len(vendors)} ราย"),
            kpi("ค่าวัสดุเทียบราคากลาง", first["material_dev_pct"], "percent_signed", first["benchmark"]),
            kpi("ค่าแรงเทียบราคากลาง", first["labour_dev_pct"], "percent_signed", first["benchmark"]),
            kpi("รายการที่เกินเกณฑ์", sum(v["over"] for v in vendors), "count", f"จาก {sum(v['items'] for v in vendors):,} รายการ")]
    groups = sorted(first["groups"], key=lambda g: -(g["savings"] or 0))[:12]
    names = [g["group"] for g in groups]
    charts = [chart("savings", "ส่วนที่ควรต่อรองแยกหมวดงาน", "hbar", names,
                    [{"name": v["vendor"], "values": [next((x["savings"] for x in v["groups"] if x["group"] == name), None) for name in names]} for v in vendors]),
              chart("normalized", "ราคาที่เสนอเทียบราคาหลังปรับ", "bar", names,
                    [{"name": "ราคาที่เสนอ", "values": [g["original"] for g in groups]}, {"name": "ราคาหลังปรับ", "values": [g["normalized"] for g in groups]}])]
    if any(g["material_dev_pct"] is not None or g["labour_dev_pct"] is not None for g in groups):
        charts.append(chart("deviation", f"% ต่างจาก{first['benchmark']} แยกหมวดงาน", "hbar", names,
                            [{"name": "ค่าวัสดุ", "values": [g["material_dev_pct"] for g in groups]}, {"name": "ค่าแรง", "values": [g["labour_dev_pct"] for g in groups]}], "percent_signed"))
    tables = [{"title": "ผลกระทบทางการเงินแยกหมวดงาน", "columns": [("หมวดงาน", "text"), ("ราคาที่เสนอ (บาท)", "money"), ("หลังปรับ (บาท)", "money"),
                                                                  ("ต่อรองได้ (บาท)", "money"), ("% ลด", "percent")],
               "rows": [[g["group"], g["original"], g["normalized"], g["savings"], g["savings_pct"]] for g in first["groups"]]}]
    return [item for item in kpis if item["value"] is not None], charts, tables


def dashboard(facts):
    kpis, charts, tables = {"comparison": comparison_dashboard, "estimate": estimate_dashboard, "benchmark": benchmark_dashboard}[facts["kind"]](facts)
    for table in tables:
        table["columns"] = [{"label": label, "format": fmt} for label, fmt in table["columns"]]
    return {"title": f"{LABELS[facts['kind']]}: {facts['project']}", "headline": facts["headline"], "kpis": kpis, "charts": charts,
            "tables": [table for table in tables if table["rows"]],
            "source": {"sheet": facts.get("sheet"), "range": facts.get("range"), "filename": facts["filename"]}}


def build(sqlite_path, input_path, filename, out_dir, display=None):
    """filename picks the reader (a converted PDF or photo is read as .xlsx); display is what the user uploaded."""
    display = display or filename
    report_path = Path(out_dir) / "report.html"
    # 1. Bids against a benchmark: the BOQ engine reads the original workbook.
    try:
        import analysis_engine
        import boq_engine
        import boq_report
        engine = boq_engine.build_many([(analysis_engine.load_sheets(Path(input_path).read_bytes(), filename), display)])
    except Exception:
        engine = None
    if engine is not None:
        report_path.write_text(boq_report.render(engine), encoding="utf-8")
        facts = benchmark(engine, display)
        return {"type": "benchmark", "label": LABELS["benchmark"], "headline": facts["headline"], "dashboard": dashboard(facts),
                "report": report_path.name, "vendors": [v["vendor"] for v in engine["vendors"]], "benchmark": engine["vendors"][0].get("benchmark")}
    # 2. Bidders side by side, or one priced bill, from the stored tables.
    connection = sqlite3.connect(Path(sqlite_path).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        dataset = json.loads(connection.execute("SELECT value FROM metadata WHERE key='dataset'").fetchone()[0])
        found = classify(dataset, connection)
    finally:
        connection.close()
    if not found:
        return {"type": "general", "label": LABELS["general"]}
    import document_report
    facts = comparison(found, display) if found["kind"] == "comparison" else estimate(found, display)
    report_path.write_text(document_report.render(facts), encoding="utf-8")
    return {"type": found["kind"], "label": LABELS[found["kind"]], "headline": facts["headline"], "dashboard": dashboard(facts),
            "report": report_path.name, "sheet_id": found["sheet"]["id"]}


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) not in (5, 6):
        print(json.dumps({"error": {"code": "INVALID_REQUEST", "message": "คำสั่งไม่ถูกต้อง"}}, ensure_ascii=False))
        return 1
    try:
        result = build(*sys.argv[1:])
    except Exception:
        # A document the classifier cannot follow is treated as a general file.
        result = {"type": "general", "label": LABELS["general"]}
    print(json.dumps({"result": result}, ensure_ascii=False, allow_nan=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
