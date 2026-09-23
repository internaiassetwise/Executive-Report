"""Workbook facts a cell grid does not show.

Merged cells, hidden rows and columns, Excel tables, named ranges, formulas'
cross-sheet references, comments, hyperlinks, text boxes, images, charts and
pivot tables are read straight from the XLSX package (streaming XML, nothing
in the file is executed or evaluated). `scan` returns the full facts the reader
needs; `summarize` turns them into the workbook part of the dataset's
intermediate representation (IR), which is what the planner sees.
"""
from __future__ import annotations

import posixpath
import re
import zipfile
from xml.etree import ElementTree

MAX_MERGES = 20_000
MAX_HIDDEN_ROWS = 50_000
MAX_LISTED = 40
MAX_IMAGES = 12
MAX_IMAGE_BYTES = 4_000_000
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
               ".bmp": "image/bmp", ".emf": "image/emf", ".wmf": "image/wmf", ".tif": "image/tiff", ".tiff": "image/tiff"}
# Formats a vision model reads; the others are listed in the IR only.
VISION_TYPES = {"image/png", "image/jpeg", "image/webp"}
CELL = re.compile(r"\$?([A-Za-z]{1,3})\$?(\d+)")
SHEET_REF = re.compile(r"(?:'((?:[^']|'')+)'|([^\s'!=(),:;+\-*/&^<>\"{}\[\]]+))!")
CHART_KINDS = {"barChart": "bar", "bar3DChart": "bar", "lineChart": "line", "line3DChart": "line", "pieChart": "pie", "pie3DChart": "pie",
               "doughnutChart": "doughnut", "areaChart": "area", "area3DChart": "area", "scatterChart": "scatter", "radarChart": "radar",
               "bubbleChart": "bubble", "stockChart": "stock", "surfaceChart": "surface", "ofPieChart": "pie"}


def local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def attr(element, name):
    for key, value in element.attrib.items():
        if local(key) == name:
            return value
    return None


def column_number(letters):
    number = 0
    for char in letters.upper():
        number = number * 26 + ord(char) - 64
    return number


def column_letter(number):
    letters = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def bounds(ref):
    """'B3:D10' -> (3, 2, 10, 4) as (first row, first col, last row, last col); None if unreadable."""
    cells = CELL.findall(ref or "")
    if not cells:
        return None
    (c1, r1), (c2, r2) = cells[0], cells[-1]
    r1, r2, c1, c2 = int(r1), int(r2), column_number(c1), column_number(c2)
    return min(r1, r2), min(c1, c2), max(r1, r2), max(c1, c2)


def split_ref(ref):
    """"'My Sheet'!$A$1:$B$5" -> ("My Sheet", "A1:B5")."""
    ref = (ref or "").strip().lstrip("=")
    match = SHEET_REF.match(ref)
    if not match:
        return None, ref.replace("$", "")
    sheet = match[1].replace("''", "'") if match[1] is not None else match[2]
    return sheet, ref[match.end():].replace("$", "")


def referenced_sheets(formula):
    return {(quoted.replace("''", "'") if quoted else bare) for quoted, bare in SHEET_REF.findall(formula or "")}


def texts(element, limit=500):
    return re.sub(r"\s+", " ", "".join(node.text or "" for node in element.iter() if local(node.tag) == "t")).strip()[:limit]


def parse(archive, name):
    try:
        with archive.open(name) as source:
            return ElementTree.parse(source).getroot()
    except (KeyError, ElementTree.ParseError):
        return None


def relationships(archive, part):
    folder, base = posixpath.split(part)
    root = parse(archive, posixpath.join(folder, "_rels", base + ".rels"))
    found = {}
    for rel in [] if root is None else root:
        target, mode = rel.get("Target") or "", rel.get("TargetMode")
        external = mode == "External"
        resolved = None if external else target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(folder, target))
        found[rel.get("Id")] = {"type": (rel.get("Type") or "").rsplit("/", 1)[-1], "target": resolved, "external": target[:200] if external else None}
    return found


def scan_sheet(archive, part, sheet_names, check=None):
    """One streaming pass over a worksheet part for structure (not values).
    `check(event, element, tag)` sees every element first and may raise."""
    hidden_rows, merges, links = set(), [], []
    hidden_cols, formulas, references = set(), 0, {}
    drawing = autofilter = None
    tables = []
    with archive.open(part) as source:
        for event, element in ElementTree.iterparse(source, events=("start", "end") if check else ("end",)):
            tag = local(element.tag)
            if check:
                check(event, element, tag)
                if event == "start":
                    continue
            if tag == "col" and element.get("hidden") in ("1", "true"):
                first, last = int(element.get("min", 0)), int(element.get("max", 0))
                hidden_cols.update(range(first, min(last, first + 1000) + 1))
            elif tag == "row":
                if element.get("hidden") in ("1", "true") and len(hidden_rows) < MAX_HIDDEN_ROWS and (element.get("r") or "").isdigit():
                    hidden_rows.add(int(element.get("r")))
                element.clear()
            elif tag == "f":
                formulas += 1
                for name in referenced_sheets(element.text):
                    if name in sheet_names:
                        references[name] = references.get(name, 0) + 1
            elif tag == "mergeCell" and len(merges) < MAX_MERGES:
                found = bounds(element.get("ref"))
                if found:
                    merges.append(found)
            elif tag == "hyperlink":
                links.append({"cell": element.get("ref"), "rid": attr(element, "id"), "location": element.get("location")})
            elif tag == "drawing":
                drawing = attr(element, "id")
            elif tag == "tablePart":
                tables.append(attr(element, "id"))
            elif tag == "autoFilter":
                autofilter = element.get("ref")
    hidden_cols.discard(0)
    return {"hidden_rows": hidden_rows, "hidden_cols": hidden_cols, "merges": merges, "links": links, "drawing": drawing,
            "table_ids": tables, "autofilter": autofilter, "formulas": formulas, "references": references}


def read_drawing(archive, part, sheet, facts):
    root = parse(archive, part)
    if root is None:
        return
    rels = relationships(archive, part)
    for anchor in root:
        if local(anchor.tag) not in ("twoCellAnchor", "oneCellAnchor", "absoluteAnchor"):
            continue
        cell = None
        for child in anchor:
            if local(child.tag) == "from":
                values = {local(node.tag): (node.text or "0") for node in child}
                if values.get("col", "").isdigit() and values.get("row", "").isdigit():
                    cell = f"{column_letter(int(values['col']) + 1)}{int(values['row']) + 1}"
        for node in anchor.iter():
            tag = local(node.tag)
            if tag == "blip":
                rel = rels.get(attr(node, "embed"))
                if rel and rel["target"] and len(facts["images"]) < MAX_IMAGES * 4:
                    extension = posixpath.splitext(rel["target"])[1].casefold()
                    try:
                        size = archive.getinfo(rel["target"]).file_size
                    except KeyError:
                        break
                    facts["images"].append({"id": f"img{len(facts['images']) + 1}", "sheet": sheet, "cell": cell, "part": rel["target"],
                                            "content_type": IMAGE_TYPES.get(extension, "application/octet-stream"), "bytes": size})
                break
            if tag == "chart":
                rel = rels.get(attr(node, "id"))
                if rel and rel["target"]:
                    chart = read_chart(archive, rel["target"])
                    if chart:
                        facts["charts"].append({"id": f"chart{len(facts['charts']) + 1}", "sheet": sheet, "cell": cell, **chart})
                break
            if tag == "txBody":
                text = texts(node, 400)
                if text and len(facts["text_boxes"]) < MAX_LISTED:
                    facts["text_boxes"].append({"sheet": sheet, "cell": cell, "text": text})
                break


def read_chart(archive, part):
    root = parse(archive, part)
    if root is None:
        return None
    kinds, series, title = [], [], ""
    for node in root.iter():
        tag = local(node.tag)
        if tag == "title" and not title:
            title = texts(node, 200)
        elif tag in CHART_KINDS:
            kind = CHART_KINDS[tag]
            direction = next((attr(child, "val") for child in node if local(child.tag) == "barDir"), None)
            kinds.append("hbar" if kind == "bar" and direction == "bar" else kind)
            for ser in node:
                if local(ser.tag) != "ser" or len(series) >= 12:
                    continue
                entry = {"type": kinds[-1]}
                for child in ser:
                    role = {"tx": "name", "cat": "categories", "xVal": "categories", "val": "values", "yVal": "values"}.get(local(child.tag))
                    if not role:
                        continue
                    formula = next((f.text for f in child.iter() if local(f.tag) == "f" and f.text), None)
                    if formula:
                        entry[f"{role}_ref"] = formula[:200]
                    if role == "name":
                        entry["name"] = (texts(child, 100) or next((v.text for v in child.iter() if local(v.tag) == "v" and v.text), ""))[:100]
                    if role == "values":
                        entry["points"] = next((int(attr(p, "val") or 0) for p in child.iter() if local(p.tag) == "ptCount"), None)
                series.append(entry)
    if not kinds:
        return None
    return {"type": kinds[0] if len(set(kinds)) == 1 else "combo", "title": title, "series": series}


def read_table(archive, part, sheet):
    root = parse(archive, part)
    if root is None or local(root.tag) != "table":
        return None
    found = bounds(root.get("ref"))
    if not found:
        return None
    columns = [column.get("name") or "" for node in root if local(node.tag) == "tableColumns" for column in node if local(column.tag) == "tableColumn"]
    return {"name": root.get("displayName") or root.get("name") or "", "sheet": sheet, "ref": root.get("ref"), "bounds": found,
            "header_rows": int(root.get("headerRowCount", "1") or 1), "totals_rows": int(root.get("totalsRowCount", "0") or 0), "columns": columns[:300]}


def read_pivot(archive, part, sheet):
    root = parse(archive, part)
    if root is None:
        return None
    location = next((node.get("ref") for node in root if local(node.tag) == "location"), None)
    pivot = {"name": root.get("name") or "", "sheet": sheet, "ref": location, "source_sheet": None, "source_ref": None, "source_name": None}
    for rel in relationships(archive, part).values():
        if rel["type"] == "pivotCacheDefinition" and rel["target"]:
            cache = parse(archive, rel["target"])
            for node in [] if cache is None else cache.iter():
                if local(node.tag) == "worksheetSource":
                    pivot.update(source_sheet=node.get("sheet"), source_ref=node.get("ref"), source_name=node.get("name"))
    return pivot


def read_comments(archive, part, sheet, facts):
    root = parse(archive, part)
    for node in [] if root is None else root.iter():
        if local(node.tag) == "comment":
            facts["comment_count"][sheet] = facts["comment_count"].get(sheet, 0) + 1
            if len(facts["comments"]) < MAX_LISTED:
                facts["comments"].append({"sheet": sheet, "cell": node.get("ref"), "text": texts(node, 300)})


def empty_facts():
    return {"sheets": {}, "tables": [], "defined_names": [], "charts": [], "pivots": [], "images": [], "comments": [], "comment_count": {},
            "hyperlinks": [], "text_boxes": [], "relationships": [], "external_links": 0, "has_macros": False}


def scan(path, check=None):
    """Facts for every worksheet of an XLSX file. Unknown or broken side parts
    (drawings, charts, comments) are skipped; a broken worksheet raises. `check`
    makes a fresh structure check per worksheet."""
    facts = empty_facts()
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        facts["has_macros"] = any("vbaproject" in name.casefold() or "macrosheet" in name.casefold() for name in names)
        facts["external_links"] = sum(name.startswith("xl/externalLinks/") and name.endswith(".xml") for name in names)
        book = parse(archive, "xl/workbook.xml")
        if book is None:
            return facts
        book_rels = relationships(archive, "xl/workbook.xml")
        order = []
        for node in book.iter():
            tag = local(node.tag)
            if tag == "sheet":
                rel = book_rels.get(attr(node, "id")) or {}
                order.append((node.get("name") or "", node.get("state") or "visible", rel.get("target")))
            elif tag == "definedName" and len(facts["defined_names"]) < 100:
                name = node.get("name") or ""
                if not name.startswith("_xlnm._FilterDatabase") and node.text:
                    facts["defined_names"].append({"name": name.replace("_xlnm.", "")[:100], "ref": node.text[:200],
                                                   "hidden": node.get("hidden") in ("1", "true"), "scope": node.get("localSheetId")})
        sheet_names = {name for name, _, _ in order}
        for name, state, part in order:
            if not part or part not in names or not part.startswith("xl/worksheets/"):
                facts["sheets"][name] = {"state": state, "kind": "chartsheet" if part and "chartsheets" in part else "other"}
                continue
            sheet = scan_sheet(archive, part, sheet_names, check() if check else None)
            sheet["state"], sheet["kind"] = state, "worksheet"
            facts["sheets"][name] = sheet
            rels = relationships(archive, part)
            for link in sheet["links"]:
                rel = rels.get(link["rid"]) or {}
                if len(facts["hyperlinks"]) < MAX_LISTED:
                    facts["hyperlinks"].append({"sheet": name, "cell": link["cell"], "target": rel.get("external") or link["location"] or ""})
            sheet["hyperlink_count"] = len(sheet.pop("links"))
            for rid in sheet.pop("table_ids"):
                rel = rels.get(rid)
                table = read_table(archive, rel["target"], name) if rel and rel["target"] else None
                if table:
                    facts["tables"].append(table)
            for rel in rels.values():
                if rel["type"] == "comments" and rel["target"]:
                    read_comments(archive, rel["target"], name, facts)
                elif rel["type"] == "pivotTable" and rel["target"]:
                    pivot = read_pivot(archive, rel["target"], name)
                    if pivot:
                        facts["pivots"].append(pivot)
            drawing = rels.get(sheet.pop("drawing"))
            if drawing and drawing["target"]:
                read_drawing(archive, drawing["target"], name, facts)
            for target, count in sheet.pop("references").items():
                if target != name:
                    facts["relationships"].append({"from": name, "to": target, "via": "formula", "count": count})
        # Chart sheets hold a chart in place of cells.
        for name, state, part in order:
            if part and part.startswith("xl/chartsheets/") and part in names:
                for rel in relationships(archive, part).values():
                    if rel["type"] == "drawing" and rel["target"]:
                        read_drawing(archive, rel["target"], name, facts)
    for pivot in facts["pivots"]:
        if pivot["source_sheet"]:
            facts["relationships"].append({"from": pivot["sheet"], "to": pivot["source_sheet"], "via": "pivot", "count": 1})
    for chart in facts["charts"]:
        targets = {split_ref(series.get(key))[0] for series in chart["series"] for key in ("values_ref", "categories_ref") if series.get(key)}
        for target in sorted(filter(None, targets)):
            if target != chart["sheet"]:
                facts["relationships"].append({"from": chart["sheet"], "to": target, "via": "chart", "count": 1})
    return facts


def extract_images(path, facts, directory):
    """Write the images a vision model can read (bounded in number and size). Returns their descriptors."""
    chosen = []
    with zipfile.ZipFile(path) as archive:
        seen = set()
        for image in facts["images"]:
            if len(chosen) >= MAX_IMAGES or image["part"] in seen:
                continue
            if image["content_type"] not in VISION_TYPES or not 1_000 <= image["bytes"] <= MAX_IMAGE_BYTES:
                continue
            seen.add(image["part"])
            target = directory / f"{image['id']}{posixpath.splitext(image['part'])[1].casefold()}"
            target.write_bytes(archive.read(image["part"]))
            chosen.append({"id": image["id"], "sheet": image["sheet"], "cell": image["cell"], "mime_type": image["content_type"], "path": str(target)})
    return chosen


def locate(ref, result, default_sheet=None):
    """Map a sheet range to the stored table and column it came from, for tracing."""
    sheet, cells = split_ref(ref)
    sheet = sheet or default_sheet
    found = bounds(cells)
    if not sheet or not found:
        return None
    r1, c1, r2, c2 = found
    for stored in result["sheets"]:
        if stored.get("source_sheet") != sheet or stored.get("combined_from"):
            continue
        area = stored.get("area")
        if not area or r2 < area["first_row"] or r1 > area["last_row"]:
            continue
        for column in stored["columns"]:
            if column.get("col") == c1:
                return {"sheet_id": stored["id"], "column": column["key"], "column_name": column["name"]}
    return None


def summarize(facts, result, image_notes=None):
    """The workbook section of the IR: structure, not cell values (those stay in SQLite)."""
    notes = {note.get("id"): note for note in image_notes or [] if isinstance(note, dict)}
    sheets = []
    for name, sheet in facts["sheets"].items():
        hidden_cols = sorted(sheet.get("hidden_cols", ()))
        sheets.append({"name": name, "state": sheet["state"], "kind": sheet["kind"],
                       "hidden_rows": len(sheet.get("hidden_rows", ())), "hidden_columns": [column_letter(c) for c in hidden_cols[:30]],
                       "merged_ranges": len(sheet.get("merges", ())), "autofilter": sheet.get("autofilter"),
                       "formulas": sheet.get("formulas", 0), "comments": facts["comment_count"].get(name, 0), "hyperlinks": sheet.get("hyperlink_count", 0),
                       "tables": [stored["id"] for stored in result["sheets"] if stored.get("source_sheet") == name and not stored.get("combined_from")]})
    charts = []
    for chart in facts["charts"][:30]:
        series = []
        for entry in chart["series"]:
            item = {key: entry[key] for key in ("name", "type", "values_ref", "categories_ref", "points") if entry.get(key) not in (None, "")}
            for key in ("values", "categories"):
                mapped = locate(entry.get(f"{key}_ref"), result, chart["sheet"])
                if mapped:
                    item[f"{key}_column"] = mapped
            series.append(item)
        charts.append({"id": chart["id"], "sheet": chart["sheet"], "cell": chart["cell"], "type": chart["type"], "title": chart["title"], "series": series})
    images = []
    for image in facts["images"][:MAX_IMAGES * 2]:
        note = notes.get(image["id"]) or {}
        images.append({"id": image["id"], "sheet": image["sheet"], "cell": image["cell"], "content_type": image["content_type"], "bytes": image["bytes"],
                       "kind": note.get("kind"), "description": note.get("description"), "text": note.get("text"),
                       "table_sheet": note.get("table_sheet"), "read": bool(note)})
    tables = [{"name": table["name"], "sheet": table["sheet"], "ref": table["ref"], "columns": table["columns"][:60], "totals_row": bool(table["totals_rows"])}
              for table in facts["tables"][:50]]
    return {"sheets": sheets, "excel_tables": tables, "defined_names": facts["defined_names"][:50], "charts": charts,
            "pivots": [{key: pivot[key] for key in ("name", "sheet", "ref", "source_sheet", "source_ref", "source_name")} for pivot in facts["pivots"][:30]],
            "images": images, "comments": facts["comments"], "hyperlinks": facts["hyperlinks"], "text_boxes": facts["text_boxes"],
            "relationships": facts["relationships"][:100], "external_links": facts["external_links"], "has_macros": facts["has_macros"]}
