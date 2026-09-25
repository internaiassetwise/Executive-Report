"""Deterministic, domain-neutral analysis of the bounded SQLite dataset.

All statistics use the complete stored dataset. Chart point sampling and the
bounded choice of correlation columns are explicitly disclosed in methods.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import statistics
from collections import Counter, defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path

MAX_CHARTS = 12
MAX_INSIGHTS = 24
INSUFFICIENT = "Insufficient data to determine this. ข้อมูลยังไม่เพียงพอที่จะสรุปประเด็นนี้"


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def fmt(value):
    if not number(value):
        return str(value)
    if value and (abs(value) >= 1e12 or abs(value) < .001):
        return f"{value:.5g}"
    return f"{value:,.2f}".rstrip("0").rstrip(".") if isinstance(value, float) else f"{value:,}"


def label(value, maximum=120):
    text = "true" if value is True else "false" if value is False else str(value)
    return text if len(text) <= maximum else text[:maximum - 1] + "…"


def token(value):
    if value is None:
        return ("empty", None)
    if isinstance(value, bool):
        return ("boolean", value)
    if number(value):
        return ("number", int(value) if isinstance(value, float) and value.is_integer() else value)
    return ("text", value)


def date_value(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:T.*)?", value):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except (ValueError, OverflowError):
        return None


def quantile(values, probability):
    position = (len(values) - 1) * probability
    lower = int(position)
    fraction = position - lower
    return values[lower] * (1 - fraction) + values[min(lower + 1, len(values) - 1)] * fraction


def numeric_statistics(values):
    ordered = sorted(values)
    result = {
        "count": len(values), "min": ordered[0], "max": ordered[-1],
        "mean": statistics.mean(values), "median": quantile(ordered, .5),
        "std": statistics.stdev(values) if len(values) > 1 else 0,
        "sum": math.fsum(values),
    }
    if not all(number(value) for value in result.values()):
        raise OverflowError("Statistics exceed finite floating point range")
    return result, ordered


def insight(title, description, kind, sheet, columns, metric, value, method, importance="medium"):
    return {"title": title, "description": description, "importance": importance, "kind": kind,
            "evidence": {"metric": metric, "value": value, "method": method, "sheet": sheet, "columns": columns}}


def balanced(groups, limit):
    queues = [deque(group) for group in groups if group]
    selected = []
    while queues and len(selected) < limit:
        next_queues = []
        for queue in queues:
            if len(selected) >= limit:
                break
            selected.append(queue.popleft())
            if queue:
                next_queues.append(queue)
        queues = next_queues
    return selected


def running_mean(group, value, scale):
    group[0] += 1
    group[1] += (value / scale - group[1]) / group[0]


def scan_profile(connection, sheet, top_limit):
    columns = sheet["columns"]
    counters = [Counter() for _ in columns]
    numeric = [[] for _ in columns]
    dates = [[] for _ in columns]
    missing = [0] * len(columns)
    row_digests = set()
    rows_count = 0
    for (data,) in connection.execute(f'SELECT data FROM "data_{sheet["id"]}" WHERE row_number NOT IN (SELECT value FROM json_each(?)) ORDER BY row_number', [json.dumps(sheet.get("summary_rows", []))]):
        row = json.loads(data)
        values = [row.get(column["key"]) for column in columns]
        # Normalize numerically equal values before comparing duplicate rows.
        canonical = [token(value) for value in values]
        row_digests.add(hashlib.sha256(json.dumps(canonical, ensure_ascii=False, allow_nan=False).encode("utf-8")).digest())
        rows_count += 1
        for index, value in enumerate(values):
            if value is None:
                missing[index] += 1
                continue
            counters[index][token(value)] += 1
            if number(value):
                numeric[index].append(value)
            parsed = date_value(value)
            if parsed is not None:
                dates[index].append((parsed, value))
    warnings = list(sheet.get("warnings", []))
    profiles = []
    for index, column in enumerate(columns):
        count = counters[index]
        entry = {**column, "missing_count": missing[index],
                 "missing_percentage": round(missing[index] / rows_count * 100, 4) if rows_count else 0,
                 "unique_count": len(count)}
        if numeric[index]:
            try:
                stats, ordered = numeric_statistics(numeric[index])
                entry["statistics"] = stats
                if len(ordered) >= 4:
                    q1, q3 = quantile(ordered, .25), quantile(ordered, .75)
                    spread = q3 - q1
                    lower, upper = q1 - 1.5 * spread, q3 + 1.5 * spread
                    if number(lower) and number(upper):
                        entry["outliers"] = {"count": sum(value < lower or value > upper for value in ordered), "lower": lower, "upper": upper}
            except (ValueError, OverflowError):
                warnings.append(f"{column['name']}: ค่ามีขนาดเกินช่วงสถิติที่แสดงได้ จึงไม่สร้าง KPI หรือกราฟจากคอลัมน์นี้")
        if dates[index]:
            entry["date_range"] = {"min": min(dates[index], key=lambda item: item[0])[1], "max": max(dates[index], key=lambda item: item[0])[1]}
        if count and column["data_type"] not in ("number", "date"):
            entry["top_values"] = [{"value": label(value[1]), "count": frequency} for value, frequency in count.most_common(top_limit)]
            if len(count) > top_limit:
                warnings.append(f"{column['name']}: แสดงหมวดหมู่ที่พบบ่อยสูงสุด {top_limit} ค่า จาก {len(count):,} ค่าที่แตกต่างกัน; จำนวนทั้งหมดคำนวณจากทุกแถว")
        profiles.append(entry)
    total_missing = sum(missing)
    return {"sheet_id": sheet["id"], "sheet_name": sheet["name"], "rows_count": rows_count, "columns": profiles,
            "duplicate_rows": rows_count - len(row_digests), "missing_count": total_missing,
            "missing_percentage": round(total_missing / (rows_count * len(columns)) * 100, 4) if rows_count and columns else 0,
            "correlations": [], "warnings": warnings}, counters, numeric, dates


def likely_identifier(column, values, rows_count):
    if not values:
        return False
    unique = len(set(values))
    integers = all(float(value).is_integer() for value in values)
    # Codes stored as numbers (posting keys, account codes) are labels, not quantities.
    named = bool(re.search(r"(?:\bid\b|identifier|\bcode\b|\bkey\b|\bsku\b|รหัส|เลขที่|ลำดับ)", column["name"], re.I))
    sequential = len(values) >= 5 and integers and unique == len(values) and max(values) - min(values) == len(values) - 1
    return named or sequential


def sheet_patterns(connection, sheet, profile, counters, numeric, dates):
    columns = profile["columns"]
    rows_count = profile["rows_count"]
    measures = []
    for index, column in enumerate(columns):
        present = rows_count - column["missing_count"]
        if column.get("statistics") and present and len(numeric[index]) / present >= .8:
            if likely_identifier(column, numeric[index], rows_count):
                profile["warnings"].append(f"{column['name']}: มีลักษณะชื่อรหัสหรือเลขจำนวนเต็มเรียงลำดับไม่ซ้ำ จึงเก็บสถิติไว้แต่ไม่เลือกเป็นตัวชี้วัดธุรกิจอัตโนมัติ")
            else:
                measures.append(index)
    dimensions = [index for index, column in enumerate(columns) if column["data_type"] in ("text", "boolean", "mixed") and 1 < column["unique_count"] <= 30 and not column.get("statistics")]
    date_indices = [index for index in range(len(columns)) if len(dates[index]) >= 2 and len(dates[index]) / max(1, rows_count - columns[index]["missing_count"]) >= .8]
    findings, charts, kpis = [], [], []
    name, sheet_id = sheet["name"], sheet["id"]
    if profile["missing_count"] or profile["duplicate_rows"]:
        findings.append(insight(f"ตรวจสอบคุณภาพข้อมูลใน {name}",
            f"ชีต {name} มีค่าว่าง {fmt(profile['missing_count'])} เซลล์ ({fmt(profile['missing_percentage'])}%) และแถวซ้ำ {fmt(profile['duplicate_rows'])} แถว ข้อมูลเหล่านี้ยังคงอยู่ในชุดข้อมูล",
            "quality", name, [column["key"] for column in columns], "missing_percentage", profile["missing_percentage"],
            "นับค่าว่างและเปรียบเทียบค่าทุกคอลัมน์ในแต่ละแถวภายในชีต", "high" if profile["missing_percentage"] >= 10 else "medium"))

    for index in measures:
        column, stats = columns[index], columns[index]["statistics"]
        if len(kpis) < 2:
            kpis.append({"name": f"ค่าเฉลี่ย {column['name']} · {name}", "value": stats["mean"], "formatted_value": fmt(stats["mean"]),
                         "source": {"sheet": name, "column": column["key"]}, "method": f"ค่าเฉลี่ยเลขคณิตจากค่าตัวเลข {stats['count']:,} ค่า ไม่รวมค่าว่าง"})
        outliers = column.get("outliers")
        if outliers and outliers["count"]:
            findings.append(insight(f"พบค่าที่ควรตรวจสอบใน {column['name']}",
                f"ชีต {name}: {column['name']} มี {fmt(outliers['count'])} ค่าอยู่นอกช่วง {fmt(outliers['lower'])} ถึง {fmt(outliers['upper'])} ตามเกณฑ์ 1.5 × IQR; ยังไม่ถือว่าเป็นข้อมูลผิดและไม่มีการลบออก",
                "anomaly", name, [column["key"]], "iqr_outlier_count", outliers["count"], "Q1/Q3 แบบ linear interpolation; ต่ำกว่า Q1 − 1.5×IQR หรือสูงกว่า Q3 + 1.5×IQR", "high"))
        if stats["count"] >= 2:
            findings.append(insight(f"การกระจายของ {column['name']}",
                f"ชีต {name}: ค่าเฉลี่ย {fmt(stats['mean'])}, มัธยฐาน {fmt(stats['median'])}, ค่าต่ำสุด {fmt(stats['min'])} และสูงสุด {fmt(stats['max'])} จากค่าตัวเลข {fmt(stats['count'])} ค่า",
                "distribution", name, [column["key"]], "median", stats["median"], "สถิติเชิงพรรณนาจากค่าตัวเลขทั้งหมด; ส่วนเบี่ยงเบนมาตรฐานใช้ตัวอย่าง n−1", "low"))
        if len(charts) < 4 and stats["count"] >= 5 and stats["max"] > stats["min"]:
            scale = max(abs(stats["min"]), abs(stats["max"])) or 1
            low, high = stats["min"] / scale, stats["max"] / scale
            bins = min(10, max(3, math.ceil(math.sqrt(stats["count"]))))
            width = (high - low) / bins
            counts = [0] * bins
            for value in numeric[index]:
                counts[min(bins - 1, max(0, int((value / scale - low) / width)))] += 1
            data = [{"x": f"{fmt((low + step * width) * scale)} – {fmt((low + (step + 1) * width) * scale)}", "y": count} for step, count in enumerate(counts)]
            charts.append({"type": "histogram", "title": f"การกระจาย {column['name']} · {name}", "sheet_id": sheet_id,
                           "x": column["key"], "y": column["key"], "x_label": column["name"], "y_label": "จำนวนค่า", "data": data,
                           "method": f"Histogram {bins} ช่วงกว้างเท่ากันจากค่าตัวเลขทั้งหมด {stats['count']:,} ค่า; ช่วงสุดท้ายรวมขอบบน"})

    for index in dimensions[:2]:
        column = columns[index]
        groups = counters[index].most_common()
        count = sum(frequency for _, frequency in groups)
        top, frequency = groups[0]
        findings.append(insight(f"กลุ่มที่พบมากที่สุดใน {column['name']}",
            f"ชีต {name}: กลุ่ม “{label(top[1])}” มี {fmt(frequency)} แถว คิดเป็น {fmt(frequency / count * 100)}% ของ {fmt(count)} แถวที่ไม่ว่างในคอลัมน์ {column['name']}",
            "segment", name, [column["key"]], "top_category_count", frequency, "นับความถี่ตามค่าจริงทั้งหมด; สัดส่วนใช้เฉพาะแถวที่มีค่าของคอลัมน์นี้"))
        charts.append({"type": "donut" if len(groups) <= 6 else "bar", "title": f"สัดส่วน {column['name']} · {name}", "sheet_id": sheet_id,
                       "x": column["key"], "y": column["key"], "x_label": column["name"], "y_label": "จำนวนแถว",
                       "data": [{"x": label(value[1]), "y": frequency} for value, frequency in groups], "method": f"นับความถี่ทุกหมวดหมู่จาก {count:,} แถวที่ไม่ว่าง; ไม่รวมค่าว่าง"})
        if not kpis:
            kpis.append({"name": f"จำนวนกลุ่ม {column['name']} · {name}", "value": column["unique_count"], "formatted_value": fmt(column["unique_count"]),
                         "source": {"sheet": name, "column": column["key"]}, "method": "นับค่าที่แตกต่างกันทั้งหมด ไม่รวมค่าว่าง"})

    correlation_measures = [index for index in measures if columns[index]["statistics"]["max"] > columns[index]["statistics"]["min"]][:6]
    if len(measures) > 6:
        profile["warnings"].append("ตรวจ Pearson correlation เฉพาะตัวชี้วัดที่ไม่คงที่สูงสุด 6 คอลัมน์แรกตามลำดับไฟล์; ทุกคอลัมน์ยังมีสถิติครบ")
    pairs = {(a, b): {"n": 0, "mx": 0., "my": 0., "xx": 0., "yy": 0., "xy": 0., "points": []}
             for offset, a in enumerate(correlation_measures) for b in correlation_measures[offset + 1:]}
    scales = {index: max(abs(columns[index]["statistics"]["min"]), abs(columns[index]["statistics"]["max"])) or 1 for index in measures}
    categories = {(dimension, measure): defaultdict(lambda: [0, 0.]) for dimension in dimensions[:1] for measure in measures[:2]}
    trends = {}
    for date_index in date_indices[:1]:
        instants = [item[0] for item in dates[date_index]]
        first, last = min(instants), max(instants)
        days = (last - first).days
        unit = "day" if days <= 60 else "month" if days <= 365 * 5 else "year"
        year_step = max(1, math.ceil((last.year - first.year + 1) / 60))
        for measure in measures[:2]:
            trends[(date_index, measure)] = {"unit": unit, "year_step": year_step, "groups": defaultdict(lambda: [0, 0.])}
    stride = max(1, math.ceil(rows_count / 200))
    if pairs or categories or trends:
        for row_index, (stored,) in enumerate(connection.execute(f'SELECT data FROM "data_{sheet_id}" WHERE row_number NOT IN (SELECT value FROM json_each(?)) ORDER BY row_number', [json.dumps(sheet.get("summary_rows", []))])):
            row = json.loads(stored)
            values = [row.get(column["key"]) for column in columns]
            for (a, b), accumulator in pairs.items():
                x, y = values[a], values[b]
                if not number(x) or not number(y):
                    continue
                sx, sy = x / scales[a], y / scales[b]
                accumulator["n"] += 1
                dx, dy = sx - accumulator["mx"], sy - accumulator["my"]
                accumulator["mx"] += dx / accumulator["n"]
                accumulator["my"] += dy / accumulator["n"]
                accumulator["xx"] += dx * (sx - accumulator["mx"])
                accumulator["yy"] += dy * (sy - accumulator["my"])
                accumulator["xy"] += dx * (sy - accumulator["my"])
                if row_index % stride == 0 and len(accumulator["points"]) < 200:
                    accumulator["points"].append({"x": x, "y": y})
            for (dimension, measure), groups in categories.items():
                category, value = values[dimension], values[measure]
                if category is not None and number(value):
                    running_mean(groups[token(category)], value, scales[measure])
            for (date_index, measure), trend in trends.items():
                instant, value = date_value(values[date_index]), values[measure]
                if instant is None or not number(value):
                    continue
                if trend["unit"] == "day":
                    group = instant.date().isoformat()
                elif trend["unit"] == "month":
                    group = f"{instant.year:04d}-{instant.month:02d}"
                else:
                    start = (instant.year - 1) // trend["year_step"] * trend["year_step"] + 1
                    group = f"{start:04d}" if trend["year_step"] == 1 else f"{start:04d}–{start + trend['year_step'] - 1:04d}"
                running_mean(trend["groups"][group], value, scales[measure])

    for (date_index, measure), trend in trends.items():
        column = columns[measure]
        groups = sorted(trend["groups"].items())
        if len(groups) < 2:
            continue
        data = [{"x": key, "y": value[1] * scales[measure]} for key, value in groups]
        included = sum(value[0] for _, value in groups)
        first, last = data[0], data[-1]
        delta = last["y"] - first["y"]
        if not number(delta):
            continue
        metric, value = "last_minus_first_mean", delta
        comparison = f"เปลี่ยนแปลง {fmt(delta)} หน่วย"
        if first["y"] != 0:
            relative = delta / abs(first["y"]) * 100
            if number(relative):
                metric, value = "first_to_last_mean_change_pct", relative
                comparison = f"เปลี่ยนแปลง {fmt(relative)}% โดยใช้ค่าสัมบูรณ์ของช่วงแรกเป็นฐาน"
        period = {"day": "วัน", "month": "เดือน", "year": "ช่วงปี"}[trend["unit"]]
        method = f"ค่าเฉลี่ยราย{period}จาก {included:,} แถวที่มีวันที่และตัวเลขครบ; วันที่แปลงเป็น UTC; ไม่เติมช่วงเวลาที่ไม่มีข้อมูล"
        findings.insert(0, insight(f"แนวโน้ม {column['name']} เปลี่ยนระหว่างช่วงเวลา",
            f"ชีต {name}: ค่าเฉลี่ย {column['name']} จาก {fmt(first['y'])} ใน {first['x']} เป็น {fmt(last['y'])} ใน {last['x']} ({comparison}); เป็นการเปรียบเทียบช่วงแรกและสุดท้าย ไม่ใช่ข้อสรุปเหตุและผล",
            "trend", name, [columns[date_index]["key"], column["key"]], metric, value, method, "high"))
        charts.insert(0, {"type": "line", "title": f"แนวโน้ม {column['name']} · {name}", "sheet_id": sheet_id, "x": columns[date_index]["key"], "y": column["key"],
                          "x_label": columns[date_index]["name"], "y_label": f"ค่าเฉลี่ย {column['name']}", "data": data, "method": method})
    for (dimension, measure), groups in categories.items():
        if len(groups) < 2:
            continue
        ordered = sorted(groups.items(), key=lambda item: -item[1][1])
        top, first = ordered[0]
        bottom, last = ordered[-1]
        column = columns[measure]
        first_mean, last_mean = first[1] * scales[measure], last[1] * scales[measure]
        findings.append(insight(f"เปรียบเทียบ {column['name']} ตาม {columns[dimension]['name']}",
            f"ชีต {name}: กลุ่ม “{label(top[1])}” มีค่าเฉลี่ย {column['name']} สูงสุด {fmt(first_mean)} จาก {fmt(first[0])} แถว ส่วนกลุ่ม “{label(bottom[1])}” ต่ำสุด {fmt(last_mean)} จาก {fmt(last[0])} แถว",
            "segment", name, [columns[dimension]["key"], column["key"]], "highest_category_mean", first_mean, "คำนวณค่าเฉลี่ยแยกหมวดหมู่จากทุกแถวที่มีหมวดหมู่และตัวเลขครบ; ไม่บวกข้ามหน่วย"))
        charts.append({"type": "bar", "title": f"{column['name']} ตาม {columns[dimension]['name']} · {name}", "sheet_id": sheet_id,
                       "x": columns[dimension]["key"], "y": column["key"], "x_label": columns[dimension]["name"], "y_label": f"ค่าเฉลี่ย {column['name']}",
                       "data": [{"x": label(category[1]), "y": group[1] * scales[measure]} for category, group in ordered], "method": "ค่าเฉลี่ยทุกแถวที่มีข้อมูลครบในคู่คอลัมน์นั้น แยกตามหมวดหมู่"})
    correlations = []
    for (a, b), accumulator in pairs.items():
        if accumulator["n"] < 3 or accumulator["xx"] <= 0 or accumulator["yy"] <= 0:
            continue
        value = accumulator["xy"] / math.sqrt(accumulator["xx"]) / math.sqrt(accumulator["yy"])
        if number(value):
            correlations.append((abs(value), a, b, max(-1., min(1., value)), accumulator))
    for _, a, b, value, accumulator in sorted(correlations, reverse=True):
        profile["correlations"].append({"x": columns[a]["key"], "y": columns[b]["key"], "value": value, "sample_size": accumulator["n"]})
    for _, a, b, value, accumulator in sorted(correlations, reverse=True)[:2]:
        findings.append(insight(f"ความสัมพันธ์ระหว่าง {columns[a]['name']} และ {columns[b]['name']}",
            f"ชีต {name}: Pearson r = {fmt(value)} จากข้อมูลครบคู่ {fmt(accumulator['n'])} แถว ความสัมพันธ์นี้ไม่ยืนยันเหตุและผลหรือความมีนัยสำคัญทางสถิติ",
            "relationship", name, [columns[a]["key"], columns[b]["key"]], "pearson_r", value, "Pearson correlation แบบ pairwise complete จากทุกคู่ข้อมูลที่ไม่ว่าง; คำนวณแบบปรับสเกลเพื่อความเสถียร"))
        charts.append({"type": "scatter", "title": f"{columns[a]['name']} กับ {columns[b]['name']} · {name}", "sheet_id": sheet_id,
                       "x": columns[a]["key"], "y": columns[b]["key"], "x_label": columns[a]["name"], "y_label": columns[b]["name"], "data": accumulator["points"],
                       "method": f"แสดงตัวอย่างตามลำดับแถว {len(accumulator['points']):,} จุดจาก {accumulator['n']:,} คู่; Pearson ใช้ทุกคู่ ไม่ใช่เฉพาะจุดที่แสดง"})
    # Select different kinds before taking a second finding/chart of one kind.
    def diverse(items, field):
        groups = {}
        for item in items:
            groups.setdefault(item[field], []).append(item)
        return balanced(list(groups.values()), len(items))
    return diverse(findings, "kind"), diverse(charts, "type"), kpis


def report_sections(analysis, dataset):
    insights = analysis["insights"]
    def section(identifier, title, paragraphs, matches=()):
        return {"id": identifier, "title": title, "paragraphs": paragraphs or [INSUFFICIENT], "evidence_ids": [item["id"] for item in matches]}
    def selected(kind):
        return [item for item in insights if item["kind"] == kind]
    quality = selected("quality")
    trends, segments, anomalies = selected("trend"), selected("segment"), selected("anomaly")
    recommendations = []
    if any(profile["missing_count"] for profile in analysis["profiles"]):
        recommendations.append("ตรวจสอบค่าว่างกับแหล่งข้อมูลและกำหนดวิธีจัดการแยกตามคอลัมน์ ก่อนใช้ผลเพื่อการตัดสินใจ")
    if any(profile["duplicate_rows"] for profile in analysis["profiles"]):
        recommendations.append("ตรวจสอบว่าแถวซ้ำเป็นเหตุการณ์ที่เกิดซ้ำจริงหรือการบันทึกซ้ำก่อนพิจารณาลบ ขณะนี้ยังรวมทุกแถวไว้ในการคำนวณ")
    if anomalies:
        recommendations.append("ตรวจค่าที่อยู่นอกช่วง IQR กับเจ้าของข้อมูลและหน่วยของตัวชี้วัด เกณฑ์นี้เป็นจุดให้ตรวจสอบ ไม่ใช่หลักฐานว่าข้อมูลผิด")
    if trends:
        recommendations.append("ตรวจความสม่ำเสมอของช่วงเวลาและจำนวนแถวในแต่ละช่วง ก่อนอธิบายสาเหตุของการเปลี่ยนแปลงหรือคาดการณ์ช่วงถัดไป")
    recommendations.append("ยืนยันความหมายและหน่วยของคอลัมน์กับเจ้าของข้อมูล รายงานนี้ไม่อนุมานบริบทธุรกิจหรือรวมตัวชี้วัดต่างชีตเข้าด้วยกัน")
    # A general file gets only the sections its data can fill: no time column means
    # no trend section, nothing unusual means no anomaly section.
    other = [item for item in insights if item["kind"] not in ("quality", "trend", "segment", "anomaly")]
    planned = [
        # Findings have their own sections below; the summary does not repeat them.
        ("executive_summary", "บทสรุปผู้บริหาร", [analysis["summary"]], insights[:1], True),
        ("dataset_overview", "ภาพรวมชุดข้อมูล", [f"ไฟล์ {dataset['filename']}", *[f"ชีต {profile['sheet_name']}: {profile['rows_count']:,} แถว {len(profile['columns']):,} คอลัมน์" for profile in analysis["profiles"]]], (), True),
        ("key_kpis", "ตัวชี้วัดสำคัญ", [f"{kpi['name']}: {kpi['formatted_value']} — {kpi['method']}" for kpi in analysis["kpis"]], (), False),
        ("key_findings", "ข้อค้นพบสำคัญ", [item["description"] for item in other], other, False),
        ("trends", "แนวโน้มตามเวลา", [item["description"] for item in trends], trends, False),
        ("segments", "กลุ่มข้อมูลสำคัญ", [item["description"] for item in segments], segments, False),
        ("anomalies_risks", "ค่าที่ควรตรวจสอบ", [item["description"] for item in anomalies], anomalies, False),
        ("data_quality", "คุณภาพข้อมูล", [f"ชีต {profile['sheet_name']}: ค่าว่าง {profile['missing_count']:,} เซลล์ ({fmt(profile['missing_percentage'])}%), แถวซ้ำ {profile['duplicate_rows']:,} แถว" for profile in analysis["profiles"]], quality, True),
        ("recommendations", "ข้อเสนอแนะ", recommendations, [*quality, *anomalies, *trends], True),
        ("methodology", "วิธีคำนวณ", [
            "ตัวเลขทุกค่าคำนวณจากทุกแถวในไฟล์ ค่าว่างไม่นับรวมในสถิติของคอลัมน์นั้น และแถวสรุปยอด (เช่น รวม, VAT) ไม่นับซ้ำ",
            "ค่าที่ควรตรวจสอบคือค่าที่อยู่ห่างจากค่าส่วนใหญ่มากผิดปกติ เป็นจุดให้ตรวจ ไม่ได้แปลว่าข้อมูลผิด",
            "ความสัมพันธ์ระหว่างตัวเลขสองคอลัมน์บอกว่าเปลี่ยนไปด้วยกัน ไม่ได้บอกว่าอะไรเป็นสาเหตุ",
        ], (), True),
    ]
    sections = []
    for identifier, title, paragraphs, matches, always in planned:
        if always or paragraphs:
            sections.append(section(identifier, f"{len(sections) + 1}. {title}", paragraphs, matches))
    return sections


def analyze(sqlite_path, progress=None):
    from worker import DatasetError
    from dashboard import plan
    from semantics import annotate
    progress = progress or (lambda stage, value: None)
    if not Path(sqlite_path).is_file():
        raise DatasetError("NOT_FOUND", "ไม่พบชุดข้อมูล กรุณาอัปโหลดใหม่")
    connection = sqlite3.connect(Path(sqlite_path).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        record = connection.execute("SELECT value FROM metadata WHERE key='dataset'").fetchone()
        if not record:
            raise DatasetError("NOT_FOUND", "ไม่พบโครงสร้างชุดข้อมูล กรุณาอัปโหลดใหม่")
        dataset = json.loads(record[0])
        profiles, findings, charts, metrics = [], [], [], []
        top_limit = min(10, max(1, 15_000 // max(1, dataset["columns_count"])))
        for index, sheet in enumerate(dataset["sheets"]):
            progress("profiling", 40 + int(index / len(dataset["sheets"]) * 35))
            profile, counters, numeric, dates = scan_profile(connection, sheet, top_limit)
            # Workbook facts the semantics use: number formats, hidden helper columns, derived tables.
            stored = {column["key"]: column for column in sheet["columns"]}
            for column in profile["columns"]:
                for field in ("number_format", "hidden", "letter"):
                    if stored.get(column["key"], {}).get(field):
                        column[field] = stored[column["key"]][field]
            for field in ("source", "pivot"):
                if sheet.get(field):
                    profile[field] = sheet[field]
            annotate(profile, numeric, dates, counters, likely_identifier)
            progress("patterns", 40 + int((index + .5) / len(dataset["sheets"]) * 35))
            sheet_findings, sheet_charts, sheet_kpis = sheet_patterns(connection, sheet, profile, counters, numeric, dates)
            profiles.append(profile)
            findings.append(sheet_findings)
            charts.append(sheet_charts)
            metrics.append(sheet_kpis)
        # The stacked "all sheets" table and pivot tables repeat source rows, and a table read
        # from a picture is not cell data; overall totals skip them, unless pictures are all the
        # file has (a photo or a scanned PDF).
        pictures_only = all(sheet.get("source") == "image_ocr" for sheet in dataset["sheets"] if not sheet.get("combined_from"))
        originals = [profile for profile, sheet in zip(profiles, dataset["sheets"])
                     if not sheet.get("combined_from") and not sheet.get("pivot") and (pictures_only or sheet.get("source") != "image_ocr")]
        rows_count = sum(profile["rows_count"] for profile in originals)
        missing = sum(profile["missing_count"] for profile in originals)
        duplicates = sum(profile["duplicate_rows"] for profile in originals)
        cells = sum(profile["rows_count"] * len(profile["columns"]) for profile in originals)
        completeness = round((cells - missing) / cells * 100, 4) if cells else 0
        global_quality = insight("ภาพรวมคุณภาพข้อมูล", f"ข้อมูล {fmt(rows_count)} แถวจาก {fmt(len(profiles))} ชีต มีความครบถ้วน {fmt(completeness)}% พบค่าว่าง {fmt(missing)} เซลล์ และแถวซ้ำภายในชีต {fmt(duplicates)} แถว",
                                 "quality", "ทุกชีต", [], "completeness_percentage", completeness, "ความครบถ้วนถ่วงน้ำหนักตามจำนวนเซลล์ข้อมูลทุกชีต; แถวซ้ำตรวจภายในแต่ละชีต", "high" if completeness < 90 else "medium")
        selected_findings = [global_quality, *balanced(findings, MAX_INSIGHTS - 1)]
        for index, item in enumerate(selected_findings, 1):
            item["id"] = f"EV-{index:03d}"
        selected_kpis = [
            {"name": "แถวข้อมูลทั้งหมด", "value": rows_count, "formatted_value": fmt(rows_count), "source": {"sheet": "ทุกชีต"}, "method": "จำนวนแถวข้อมูลจริง รวมแถวซ้ำ ไม่รวมหัวคอลัมน์และแถวว่าง"},
            {"name": "ความครบถ้วนของข้อมูล", "value": completeness, "formatted_value": fmt(completeness) + "%", "source": {"sheet": "ทุกชีต"}, "method": "จำนวนเซลล์ที่ไม่ว่าง ÷ จำนวนเซลล์ข้อมูลทั้งหมด × 100"},
            *balanced(metrics, 6),
        ]
        for index, item in enumerate(selected_kpis, 1):
            item["id"] = f"KPI-{index:03d}"
        progress("dashboard", 85)
        selected_charts = balanced(charts, MAX_CHARTS)
        for index, item in enumerate(selected_charts, 1):
            item["id"] = f"CH-{index:03d}"
        result = {"generated_at": datetime.now(timezone.utc).isoformat(), "summary": f"วิเคราะห์ข้อมูลทั้งหมด {fmt(rows_count)} แถว {fmt(dataset['columns_count'])} คอลัมน์จาก {fmt(len(profiles))} ชีต โดยคำนวณแยกตามชีต ความครบถ้วนของข้อมูล {fmt(completeness)}% พบแถวซ้ำ {fmt(duplicates)} แถว ตัวชี้วัดและกราฟเลือกจากชนิดและค่าข้อมูลจริง โดยไม่สมมติบริบทธุรกิจ",
                  "kpis": selected_kpis, "insights": selected_findings, "profiles": profiles, "charts": selected_charts}
        progress("report", 95)
        result["report"] = {"sections": report_sections(result, dataset)}
        try:
            result["dashboard"] = plan(profiles, dataset["filename"])
        except DatasetError:
            result["dashboard"] = None
        json.dumps(result, ensure_ascii=False, allow_nan=False)
        return result
    finally:
        connection.close()
