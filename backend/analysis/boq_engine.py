"""Benchmark-comparison analysis for BOQ workbooks. CPython and Pyodide.

Unlike analysis_engine, this path deliberately joins proposals against a
benchmark column set and aggregates across sheets. Every figure it emits is
derived from the uploaded workbooks; nothing is supplied from outside them.

Vendors are found three ways, all from the workbook itself:
  1. one vendor per workbook (unlabelled proposal columns),
  2. several vendors side by side in one sheet (proposal columns carry a name:
     'ปริมาณ KMIT เสนอ', 'ปริมาณ WGE เสนอ'),
  3. one sheet per vendor (unlabelled sheets that quote the same benchmark
     lines in the same order are the same BOQ priced by different parties).

build_many([(sheets, filename), ...]) -> the multi-vendor report contract.
analyze_workbook(sheets, filename) -> the same contract for one workbook.
"""
import re
from collections import defaultdict

# Header vocabulary. A column is identified by an axis word plus an optional
# role word; a column carrying an axis word and no role word is a proposal.
AXES = {
    'quantity': ('ปริมาณ', 'quantity', 'qty'),
    'material': ('ราคาของ', 'ค่าของ', 'ราคาวัสดุ', 'ค่าวัสดุ', 'material', 'mat unit', 'mat '),
    'labour': ('ราคาแรง', 'ค่าแรง', 'labour', 'labor', 'lab unit', 'lab '),
}
AXIS_TH = {'quantity': 'ปริมาณ', 'material': 'ค่าของ', 'labour': 'ค่าแรง'}
BENCHMARK = ('ราคากลาง', 'rbp', 'dpp', 'reference', 'benchmark', 'budget')
NORMALIZED = ('ที่ใช้คำนวณ', 'หลังปรับ', 'ปรับแล้ว', 'normalize', 'normalized', 'adjusted')
TOTAL = ('รวม', 'total', 'ยอดรวม', 'summary cost', 'amount')
CATEGORY = ('หมวดงาน', 'หมวด', 'ระบบ', 'category', 'system', 'discipline')
ITEM = ('รายการ', 'item', 'description')
# Columns the workbook derived from the comparison itself. They carry axis or
# total words but are differences, ratios or flags, never inputs.
DERIVED = ('ส่วนต่าง', 'ผลต่าง', 'ประหยัด', 'เท่า', 'diff', 'variance', 'saving', 'ratio', '%', 'flag')
# Rows the source itself marks as uncomparable.
OUT_OF_SCOPE = ('นอกขอบเขต', 'out of scope', 'rbp=0')
NOT_QUOTED = ('ไม่ได้เสนอ', 'not quoted', 'no bid')
# Sheets that restate other sheets. Including them double counts the workbook.
AGGREGATE_SHEET = ('summary', 'สรุป', 'ภาพรวม', 'overview', 'bridge', 'เปรียบเทียบ',
                   'วิเคราะห์', 'analysis', ' vs ', 'แนวทาง')
# Cells that name the parties, in the workbook's own words.
VENDOR_LABEL = (r'ผู้รับเหมา', r'ผู้เสนอราคา', r'ผู้เสนองาน', r'contractor', r'bidder', r'vendor', r'tenderer')
PROJECT_LABEL = (r'โครงการ', r'project')
# A unit rate this many times the benchmark is a unit or scope mismatch (a LOT
# quoted against a per-unit rate), not a price deviation. Such rows are set
# aside from the percentages and from normalization, and disclosed.
RATIO_CAP = 20
MIN_INSIGHT_ITEMS = 5
MIN_TOLERANCE_SAMPLE = 20
DEFAULT_TOLERANCE = 0.15
# Two unlabelled sheets whose benchmark lines agree, position by position, at
# least this closely are one BOQ priced by different vendors.
SAME_BOQ = 0.9


def norm(text):
    return re.sub(r'\s+', ' ', str(text or '')).strip().lower()


def num(v):
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace(',', '').strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def axis_of(header):
    h = norm(header)
    for axis, words in AXES.items():
        if any(w in h for w in words):
            return axis
    return None


def role_of(header):
    h = norm(header)
    if any(w in h for w in NORMALIZED):
        return 'normalized'
    if any(w in h for w in BENCHMARK):
        return 'benchmark'
    return 'proposal'


def is_derived(header):
    return any(w in norm(header) for w in DERIVED)


def is_total(header):
    """A line total: carries a total word but no axis word, so component
    totals such as 'ค่าของรวม' stay with their axis and never shadow the
    line total."""
    return any(w in norm(header) for w in TOTAL) and axis_of(header) is None


def is_category(header):
    h = norm(header)
    return any(w in h for w in CATEGORY) and axis_of(header) is None and not is_total(header) \
        and not is_derived(header)


def is_item(header):
    h = norm(header)
    return any(w in h for w in ITEM) and axis_of(header) is None and not is_total(header)


def label_of(header, role):
    """What the workbook calls this column's party, from its own header text.

    'ปริมาณ KMIT เสนอ' -> 'KMIT'; 'Mat Unit DPP' -> 'DPP'. Returns '' when
    the header carries no name beyond the axis and role words, so no name is
    ever invented.
    """
    text = re.sub(r'\s+', ' ', str(header or '')).strip()
    if role == 'benchmark':
        for w in BENCHMARK:
            m = re.search(re.escape(w), text, flags=re.IGNORECASE)
            if m:
                return m.group(0)
        return ''
    words = [w for ws in AXES.values() for w in ws]
    words += list(NORMALIZED) if role == 'normalized' else []
    words += ['เสนอ', 'ที่', 'ราคา', 'unit', 'cost', 'price', '(', ')', '/', 'หน่วย', 'net', 'wastage', '%']
    for w in sorted(words, key=len, reverse=True):
        text = re.sub(re.escape(w), ' ', text, flags=re.IGNORECASE)
    return re.sub(r'\s+', ' ', text).strip(' -–—:')


def find_header_row(grid, limit=12):
    """The header row is the one resolving to the most distinct axis+role pairs."""
    best, best_score = None, 0
    for i, row in enumerate(grid[:limit]):
        seen = {(axis_of(c), role_of(c)) for c in row if axis_of(c) and not is_derived(c)}
        if len(seen) > best_score:
            best, best_score = i, len(seen)
    return best if best_score >= 2 else None


def map_sheet(header):
    """Map every vendor in a header row: vendor -> {'columns', 'totals'}.

    Proposal columns that name a party ('ปริมาณ KMIT เสนอ') define the
    vendors; a header whose proposal columns name nobody is a single vendor
    keyed ''. Benchmark columns are shared. When several columns carry the
    same axis for one vendor (a net and a priced quantity, say), the one
    nearest to the left of that axis' benchmark is the priced one.
    """
    cols = []
    for i, cell in enumerate(header):
        if is_derived(cell):
            continue
        axis = axis_of(cell)
        if axis and not is_total(cell):
            role = role_of(cell)
            cols.append((i, axis, role, label_of(cell, role)))
    bench = {}
    for i, axis, role, _ in cols:
        if role == 'benchmark':
            bench.setdefault(axis, i)
    labels = sorted({lab for _, _, role, lab in cols if role == 'proposal' and lab})
    vendors = labels or ['']
    out = {}
    for v in vendors:
        mine = lambda lab: lab == v or (not lab and len(vendors) == 1)
        cmap = {}
        for axis, ref in bench.items():
            props = [i for i, a, r, lab in cols if a == axis and r == 'proposal' and mine(lab)]
            if not props:
                continue
            left = [i for i in props if i < ref]
            entry = {'benchmark': ref, 'proposal': max(left) if left else props[0]}
            norms = [i for i, a, r, lab in cols if a == axis and r == 'normalized' and mine(lab)]
            if norms:
                entry['normalized'] = norms[0]
            cmap[axis] = entry
        if len(cmap) >= 2:
            out[v] = {'columns': cmap, 'totals': {}}
    for i, cell in enumerate(header):
        if not is_total(cell) or is_derived(cell):
            continue
        role, h = role_of(cell), norm(cell)
        owners = [v for v in out if v and v.lower() in h]
        if not owners and (role == 'benchmark' or len(out) == 1):
            owners = list(out)
        for v in owners:
            out[v]['totals'].setdefault(role, i)
    return out


def scan_labels(sheets, limit=400):
    """Party and project names from labelled cells, e.g. 'ผู้รับเหมา: X'.
    Handles both 'label: value' in one cell and 'label' beside 'value'."""
    out = {}
    patterns = [('vendor', VENDOR_LABEL), ('project', PROJECT_LABEL)]
    for sheet in sheets:
        seen = 0
        for row in sheet.get('grid') or []:
            cells = [c for c in row if c is not None and str(c).strip()]
            for i, c in enumerate(cells):
                text = str(c)
                seen += 1
                for key, labels in patterns:
                    if key in out:
                        continue
                    for lab in labels:
                        m = re.search(lab + r'\s*[:：]\s*([^|\n]+)', text, flags=re.IGNORECASE)
                        if m and m.group(1).strip():
                            out[key] = m.group(1).strip()
                            break
                        if re.fullmatch(r'\s*' + lab + r'\s*[:：]?\s*', text, flags=re.IGNORECASE) \
                                and i + 1 < len(cells) and not num(cells[i + 1]):
                            out[key] = str(cells[i + 1]).strip()
                            break
                        if key == 'project':
                            m = re.match(r'\s*' + lab + r'\s+([^|\n:]{2,60})', text, flags=re.IGNORECASE)
                            if m:
                                out[key] = m.group(1).strip()
                                break
                if 'vendor' not in out:
                    m = re.search(r'ราคาที่(\S{2,30}?)เสนอ', text)
                    if m:
                        out['vendor'] = m.group(1)
            if seen > limit or ('vendor' in out and 'project' in out):
                break
    return out


def note_class(row, note_cols):
    for i in note_cols:
        if i < len(row):
            n = norm(row[i])
            if any(w in n for w in OUT_OF_SCOPE):
                return 'out_of_scope'
            if any(w in n for w in NOT_QUOTED):
                return 'not_quoted'
    return None


def detect(sheets):
    """Return the comparable sheets with their vendor mappings, plus the sheets
    set aside and why, so nothing is dropped without an explanation."""
    found, skipped = [], []
    for sheet in sheets:
        grid = sheet.get('grid') or []
        name = sheet['name']
        if any(w in norm(name) for w in AGGREGATE_SHEET):
            skipped.append({'sheet': name, 'reason': 'ชีตสรุปหรือชีตวิเคราะห์ ไม่นับซ้ำกับชีตรายการ'})
            continue
        h = find_header_row(grid)
        if h is None:
            continue
        vendors = map_sheet(grid[h])
        if not vendors:
            continue
        header = grid[h]
        first = lambda test: next((i for i, c in enumerate(header) if test(c)), None)
        found.append({'sheet': name, 'header_row': h, 'vendors': vendors,
                      'note_columns': [i for i, c in enumerate(header)
                                       if 'หมายเหตุ' in norm(c) or 'remark' in norm(c) or 'note' in norm(c)],
                      'category_column': first(is_category), 'item_column': first(is_item), 'grid': grid})
    return found, skipped


def sheet_group(sheet_name):
    """Group key from the {CATEGORY}_{UNIT} sheet convention, else None."""
    m = re.match(r'^([A-Za-z]{2,})[_\s-]', sheet_name.strip())
    return m.group(1).upper() if m else None


def read_rows(found):
    """Flatten detected sheets into classified comparison rows, one per
    (row, vendor)."""
    rows = []
    for f in found:
        base = sheet_group(f['sheet'])
        cat_col, item_col = f['category_column'], f['item_column']
        for r in f['grid'][f['header_row'] + 1:]:
            category = None
            if cat_col is not None and cat_col < len(r) and r[cat_col] is not None and str(r[cat_col]).strip():
                category = str(r[cat_col]).strip()
            item = norm(r[item_col]) if item_col is not None and item_col < len(r) else ''
            # With a category column in play, a row that names no category is
            # a heading or a grand total for the sheet, never a line item.
            uncategorized = base is None and cat_col is not None and category is None
            note = note_class(r, f['note_columns'])
            for vendor, spec in f['vendors'].items():
                rec = {'sheet': f['sheet'], 'vendor': vendor, 'group': base or category or f['sheet'].strip(),
                       'category': category, 'item': item, 'note': note}
                has_value = False
                for axis, roles in spec['columns'].items():
                    for role, idx in roles.items():
                        v = num(r[idx]) if idx < len(r) else None
                        rec[f'{axis}_{role}'] = v
                        has_value = has_value or v is not None
                for role, idx in spec['totals'].items():
                    v = num(r[idx]) if idx < len(r) else None
                    rec[f'total_{role}'] = v
                    has_value = has_value or v is not None
                rec['priced'] = any(rec.get(f'{a}_proposal') for a in ('material', 'labour')) \
                    or bool(rec.get('quantity_proposal'))
                # A proposal or normalized total on an unpriced row marks a
                # heading (a heading may carry a subtotal in one column and
                # nothing in another). A benchmark total alone does not: that
                # is a benchmark line the vendor left unquoted, and it stays.
                own_total = any(rec.get(f'total_{k}') for k in ('proposal', 'normalized'))
                rec['parent'] = uncategorized or (own_total and not rec['priced'])
                if has_value:
                    rows.append(rec)
    return rows


def split_sheet_vendors(found, rows):
    """Case 3: unlabelled sheets that quote the same benchmark lines.

    The signature of a sheet is its sequence of (item, benchmark quantity,
    benchmark rates). Sheets whose signatures agree position by position are
    one BOQ priced by different parties, so each sheet's name (less any
    category prefix) becomes the vendor. Returns {sheet: vendor}.
    """
    cands = [f for f in found if list(f['vendors']) == ['']]
    if len(cands) < 2:
        return {}
    sig = {}
    for f in cands:
        cm = f['vendors']['']['columns']
        seq = []
        for r in f['grid'][f['header_row'] + 1:]:
            def ref(axis):
                e = cm.get(axis)
                return num(r[e['benchmark']]) if e and e['benchmark'] < len(r) else None
            q = ref('quantity')
            if q:
                item = norm(r[f['item_column']]) if f['item_column'] is not None and f['item_column'] < len(r) else ''
                seq.append((item, q, ref('material'), ref('labour')))
        sig[f['sheet']] = seq

    def similar(a, b):
        if not a or not b:
            return 0.0
        return sum(1 for x, y in zip(a, b) if x == y) / max(len(a), len(b))

    names = [f['sheet'] for f in cands]
    parent = {n: n for n in names}

    def root(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            if similar(sig[names[i]], sig[names[j]]) >= SAME_BOQ:
                parent[root(names[i])] = root(names[j])
    clusters = defaultdict(list)
    for n in names:
        clusters[root(n)].append(n)
    # Two buildings can share a benchmark template as closely as two vendors
    # do. What sets vendor tabs apart is that the match is complete: every
    # unlabelled sheet in the workbook (or every sheet under a category
    # prefix) belongs to the cluster. A partial cluster is coincidence.
    by_prefix = defaultdict(set)
    for n in names:
        by_prefix[sheet_group(n)].add(n)
    mapping = {}
    for members in clusters.values():
        if len(members) < 2:
            continue
        prefixes = {sheet_group(n) for n in members}
        if len(prefixes) != 1 or by_prefix[next(iter(prefixes))] != set(members):
            continue
        for n in members:
            pre = sheet_group(n)
            label = n[len(pre) + 1:].strip() if pre and len(n) > len(pre) + 1 else n.strip()
            mapping[n] = label or n.strip()
    for rec in rows:
        if rec['vendor'] == '' and rec['sheet'] in mapping:
            rec['vendor'] = mapping[rec['sheet']]
            if sheet_group(rec['sheet']) is None:
                rec['group'] = rec['category'] or rec['sheet'].strip()
    return mapping


def classify(rec, axes):
    """comparable only when at least one axis has both sides present."""
    if rec['note']:
        return rec['note']
    for axis in axes:
        ref, bid = rec.get(f'{axis}_benchmark'), rec.get(f'{axis}_proposal')
        if ref is not None and bid is not None and ref > 0:
            return 'comparable'
    if all(rec.get(f'{axis}_benchmark') in (None, 0) for axis in axes):
        return 'out_of_scope'
    return 'not_quoted'


def infer_tolerance(rows, axes):
    """Recover the tolerance the workbook was flagged at.

    A cell was normalized when its adjusted value was set to the benchmark
    while the proposal sat above it. The smallest over-ratio among those is
    the tightest deviation the source still accepted, so it is an upper bound
    on the tolerance actually used, converging as flagged cells accumulate.
    """
    ratios = []
    for rec in rows:
        for axis in axes:
            ref, bid, adj = (rec.get(f'{axis}_benchmark'), rec.get(f'{axis}_proposal'),
                             rec.get(f'{axis}_normalized'))
            if None in (ref, bid, adj) or ref <= 0 or bid <= 0:
                continue
            if bid > ref and abs(adj - bid) > 1e-9 and abs(adj - ref) <= abs(ref) * 1e-6:
                ratios.append(bid / ref)
    if len(ratios) < MIN_TOLERANCE_SAMPLE:
        return None, len(ratios)
    # The smallest flagged deviation is an upper bound: the true tolerance sits
    # at or below it, and no flagged cell reveals the gap between them. Real
    # tolerances are set at round figures, so step down to the nearest half
    # point, which recovers the stated threshold instead of overshooting it.
    bound = (min(ratios) - 1) * 100
    return max(0.0, (bound * 2 // 1) / 2) / 100, len(ratios)


def line_money(rec, axes, tolerance):
    """Original and normalized value for one row.

    The workbook's own line total is authoritative where it exists, so lump
    sums and other rows carrying no unit rate keep their stated value. The
    normalized figure scales that total by the ratio the unit rates imply,
    which leaves rows with nothing to normalize untouched.
    """
    rate_axes = [a for a in axes if a != 'quantity']
    qb = rec.get('quantity_proposal')
    stated = rec.get('total_proposal')
    if rec.get('mismatch'):
        # Pulling a LOT price down to a per-unit rate would fabricate savings.
        v = stated if stated is not None else (qb or 0.0) * sum(rec.get(f'{a}_proposal') or 0.0 for a in rate_axes)
        return v, v
    qu = qb
    qr = rec.get('quantity_benchmark')
    if qr is not None and qb is not None and qr > 0 and qb > qr * (1 + tolerance):
        qu = qr
    bid_rate = used_rate = 0.0
    priced = False
    for axis in rate_axes:
        ref, bid = rec.get(f'{axis}_benchmark'), rec.get(f'{axis}_proposal')
        if bid is None:
            continue
        priced = True
        use = bid
        if ref is not None and ref > 0 and bid > ref * (1 + tolerance):
            use = ref                     # normalization is one-directional
        bid_rate += bid
        used_rate += use
    calc = (qb or 0.0) * bid_rate if priced and qb is not None else None
    original = stated if stated is not None else (calc or 0.0)
    if not priced or qb is None or not calc:
        return original, original
    normalized = (qu or 0.0) * used_rate
    if stated is not None:
        normalized = original * (normalized / calc) if calc else original
    return original, normalized


def aggregate(rows, axes, tolerance):
    """Roll comparison rows up to one record per group."""
    blank = {'sheets': set(), 'total': 0, 'comparable': 0, 'out_of_scope': 0, 'not_quoted': 0,
             'parent_rows': 0, 'parent_value': 0.0, 'mismatch': 0,
             'original': 0.0, 'normalized': 0.0, 'stated_normalized': 0.0, 'stated_seen': 0}
    for a in axes:
        blank.update({f'{a}_over': 0, f'{a}_under': 0, f'{a}_w_bid': 0.0, f'{a}_w_ref': 0.0})
    out = defaultdict(lambda: {k: (set() if isinstance(v, set) else v) for k, v in blank.items()})
    rate_axes = [a for a in axes if a != 'quantity']
    for rec in rows:
        g = out[rec['group']]
        g['sheets'].add(rec['sheet'])
        if rec['parent']:
            g['parent_rows'] += 1
            g['parent_value'] += rec.get('total_proposal') or 0.0
            continue
        g['total'] += 1
        kind = classify(rec, axes)
        g[kind] += 1
        rec['mismatch'] = kind == 'comparable' and any(
            (rec.get(f'{a}_benchmark') or 0) > 0 and rec.get(f'{a}_proposal') is not None
            and rec[f'{a}_proposal'] / rec[f'{a}_benchmark'] > RATIO_CAP for a in rate_axes)
        # Money covers every priced row: an out-of-scope line still has value.
        original, normalized = line_money(rec, axes, tolerance)
        g['original'] += original
        g['normalized'] += normalized
        if rec.get('total_normalized') is not None:
            g['stated_normalized'] += rec['total_normalized']
            g['stated_seen'] += 1
        if kind != 'comparable':
            continue
        if rec['mismatch']:
            g['mismatch'] += 1
            continue
        weight = rec.get('quantity_benchmark')
        for axis in axes:
            ref, bid = rec.get(f'{axis}_benchmark'), rec.get(f'{axis}_proposal')
            if ref is None or bid is None:
                continue
            if ref > 0 and bid > ref * (1 + tolerance):
                g[f'{axis}_over'] += 1
            if bid < ref:
                g[f'{axis}_under'] += 1
            # Rate deviation is weighted by benchmark quantity so the measure
            # isolates price and is not moved by quantity differences.
            if axis != 'quantity' and ref > 0 and weight:
                g[f'{axis}_w_ref'] += weight * ref
                g[f'{axis}_w_bid'] += weight * bid
    return out


def summarize(agg, axes):
    groups = []
    for key in sorted(agg):
        g = agg[key]
        items = g['comparable'] + g['not_quoted']       # lines the benchmark lists
        rec = {'group': key, 'sheets': sorted(g['sheets']), 'total': g['total'],
               'benchmark_items': items, 'comparable': g['comparable'],
               'out_of_scope': g['out_of_scope'], 'not_quoted': g['not_quoted'],
               'original': g['original'], 'normalized': g['normalized'],
               'savings': g['original'] - g['normalized'],
               'savings_pct': (g['original'] - g['normalized']) / g['original'] * 100 if g['original'] else None,
               'stated_normalized': g['stated_normalized'] if g['stated_seen'] else None,
               'parent_rows': g['parent_rows'], 'parent_value': g['parent_value'], 'mismatch': g['mismatch']}
        for axis in axes:
            rec[f'{axis}_over'] = g[f'{axis}_over']
            rec[f'{axis}_under'] = g[f'{axis}_under']
            rec[f'{axis}_over_pct'] = g[f'{axis}_over'] / items * 100 if items else None
            ref_w = g[f'{axis}_w_ref']
            rec[f'{axis}_dev_pct'] = (g[f'{axis}_w_bid'] / ref_w - 1) * 100 if ref_w else None
            rec[f'{axis}_w_ref'] = ref_w
            rec[f'{axis}_w_bid'] = g[f'{axis}_w_bid']
        groups.append(rec)
    total = {k: sum(g[k] for g in groups) for k in
             ('original', 'normalized', 'benchmark_items', 'comparable', 'out_of_scope',
              'not_quoted', 'total', 'parent_rows', 'parent_value', 'mismatch')}
    total['savings'] = total['original'] - total['normalized']
    total['savings_pct'] = total['savings'] / total['original'] * 100 if total['original'] else None
    stated = [g['stated_normalized'] for g in groups if g['stated_normalized'] is not None]
    total['stated_normalized'] = sum(stated) if stated else None
    for axis in axes:
        total[f'{axis}_over'] = sum(g[f'{axis}_over'] for g in groups)
        total[f'{axis}_over_pct'] = total[f'{axis}_over'] / total['benchmark_items'] * 100 if total['benchmark_items'] else None
        ref_w = sum(g[f'{axis}_w_ref'] for g in groups)
        total[f'{axis}_dev_pct'] = (sum(g[f'{axis}_w_bid'] for g in groups) / ref_w - 1) * 100 if ref_w else None
    return groups, total


def stem(filename):
    return re.sub(r'\.[A-Za-z0-9]+$', '', str(filename or '')).strip() or 'ไฟล์ที่อัปโหลด'


def prepare(sheets, filename):
    """Read one workbook: every vendor it contains, with rows, names and the
    file's own tolerance. Returns a list, possibly empty."""
    found, skipped = detect(sheets)
    if not found:
        return []
    rows = read_rows(found)
    if not rows:
        return []
    split_sheet_vendors(found, rows)
    benchmark = ''
    for f in found:
        header = f['grid'][f['header_row']]
        for spec in f['vendors'].values():
            for roles in spec['columns'].values():
                benchmark = benchmark or label_of(header[roles['benchmark']], 'benchmark')
    scanned = scan_labels(sheets)
    by_vendor = defaultdict(list)
    for rec in rows:
        by_vendor[rec['vendor']].append(rec)
    out = []
    for key, recs in by_vendor.items():
        axes = sorted({k.rsplit('_', 1)[0] for r in recs for k in r
                       if k.endswith('_benchmark') and not k.startswith('total')})
        inferred, sample = infer_tolerance(recs, axes)
        out.append({'vendor': key or scanned.get('vendor') or stem(filename),
                    'benchmark': benchmark or 'ราคากลาง', 'project': scanned.get('project'),
                    'filename': filename, 'axes': axes, 'rows': recs,
                    'sheets_used': sorted({r['sheet'] for r in recs}), 'sheets_skipped': skipped,
                    'file_tolerance': inferred, 'tolerance_sample': sample})
    return out


def finish(p, tolerance, source):
    """Aggregate a prepared vendor at the report tolerance."""
    groups, total = summarize(aggregate(p['rows'], p['axes'], tolerance), p['axes'])
    v = {k: p[k] for k in ('vendor', 'benchmark', 'project', 'filename', 'axes',
                           'sheets_used', 'sheets_skipped', 'file_tolerance', 'tolerance_sample')}
    v.update({'tolerance': tolerance, 'tolerance_source': source, 'groups': groups, 'total': total})
    v['insights'] = vendor_insights(v)
    return v


def choose_tolerance(prepared, declared):
    """One tolerance for the whole report so vendors are judged alike.
    Declared wins; else the strictest the files themselves used; else default."""
    if declared is not None:
        return declared, 'declared'
    inferred = [p['file_tolerance'] for p in prepared if p['file_tolerance'] is not None]
    if inferred:
        return max(inferred), 'inferred'
    return DEFAULT_TOLERANCE, 'default'


def pct(v):
    return f"{v:+.1f}%" if v is not None else '—'


def money(v):
    return f"{v:,.0f}" if v is not None else '—'


def top(groups, key, min_items=0):
    """Largest group by key. A 'highest deviation' claim needs a few items
    behind it, so a one-line reconciliation sheet cannot headline a finding."""
    cands = [g for g in groups if g.get(key) is not None and g['comparable'] >= min_items]
    return max(cands, key=lambda g: g[key]) if cands else None


def vendor_insights(v):
    """การวิเคราะห์เชิงลึก: observations stated from the computed figures."""
    G, T, ref = v['groups'], v['total'], v['benchmark']
    out = []
    if 'quantity' in v['axes']:
        q = top(G, 'quantity_over')
        if q and q['quantity_over']:
            out.append(f"{v['vendor']} มีปริมาณเกิน {ref} มากที่สุดในหมวด {q['group']} ({q['quantity_over']:,} รายการ "
                       f"คิดเป็น {q['quantity_over_pct']:.1f}% ของรายการในหมวด) รวมทุกหมวด {T['quantity_over']:,} รายการ")
        else:
            out.append(f"{v['vendor']} แทบไม่มีปริมาณเกิน {ref} เกินเกณฑ์ (พบ {T['quantity_over']:,} รายการ)")
    lab, mat = top(G, 'labour_dev_pct', MIN_INSIGHT_ITEMS), top(G, 'material_dev_pct', MIN_INSIGHT_ITEMS)
    if lab and mat:
        out.append(f"ค่าแรงต่างจาก {ref} สูงสุดในหมวด {lab['group']} ({pct(lab['labour_dev_pct'])}) "
                   f"และค่าของสูงสุดในหมวด {mat['group']} ({pct(mat['material_dev_pct'])}) "
                   f"ภาพรวมค่าแรง {pct(T.get('labour_dev_pct'))} ค่าของ {pct(T.get('material_dev_pct'))}")
    s = top(G, 'savings')
    if s and s['savings'] > 0:
        out.append(f"หมวดที่ปรับได้มากที่สุดคือ {s['group']} ประหยัด {money(s['savings'])} บาท ({s['savings_pct']:.1f}% ของหมวด) "
                   f"รวมทั้งหมด {money(T['savings'])} บาท หรือ {T['savings_pct']:.1f}% ของราคาที่เสนอ")
    if T['not_quoted']:
        out.append(f"มี {T['not_quoted']:,} รายการใน {ref} ที่ {v['vendor']} ไม่ได้เสนอราคา ควรขอยืนยันขอบเขตก่อนเปรียบเทียบยอดรวม")
    if T.get('mismatch'):
        out.append(f"มี {T['mismatch']:,} รายการที่ราคาต่อหน่วยสูงกว่า {ref} เกิน {RATIO_CAP} เท่า ซึ่งบ่งชี้ว่าหน่วยหรือขอบเขตไม่ตรงกัน "
                   f"(เช่น เสนอเป็นเหมารวม) จึงไม่นำมาคิด % ต่างและไม่ Normalize ควรขอ Breakdown รายการเหล่านี้")
    return out


def signature(v, all_vendors):
    """สรุปแนวโน้มเฉพาะตัว: which axis carries this vendor's deviation.

    Thresholds here are presentation heuristics for naming a pattern; every
    figure the pattern is judged on comes from the workbook.
    """
    T = v['total']
    lab, mat = T.get('labour_dev_pct'), T.get('material_dev_pct')
    qty = T.get('quantity_over_pct')
    lab0, mat0, qty0 = lab or 0, mat or 0, qty or 0
    qty_max = max((x['total'].get('quantity_over_pct') or 0 for x in all_vendors), default=0)
    parts = []
    if lab0 > 15 and lab0 > mat0 + 10:
        parts.append('เน้นไปทาง ค่าแรงสูงกว่า ' + v['benchmark'])
    elif mat0 > 15 and mat0 > lab0 + 10:
        parts.append('เน้นไปทาง ค่าของสูงกว่า ' + v['benchmark'])
    elif lab0 > 15 and mat0 > 15:
        parts.append('ค่าแรงและค่าของสูงกว่า ' + v['benchmark'] + ' ทั้งคู่')
    # Quantity padding is judged relative to the field: the vendor(s) at the
    # top of the range, not everyone above a fixed line.
    if qty0 > 5 and qty0 >= 0.8 * qty_max:
        parts.append('ปริมาณเผื่อสูงกระจายหลายหมวด')
    if not parts:
        parts.append('ใกล้เคียง ' + v['benchmark'] + ' ที่สุด ความผิดปกติต่ำทุกมิติ')
    worst = sorted([g for g in v['groups'] if g['savings'] > 0], key=lambda g: -g['savings'])[:2]
    return {'vendor': v['vendor'], 'pattern': ' + '.join(parts),
            'top_groups': ', '.join(g['group'] for g in worst) or 'ไม่มีจุดวิกฤต'}


def strategy(vendors, sigs):
    """บทวิเคราะห์เชิงกลยุทธ์: statements ordered by what moves the money."""
    out = []
    by = {s['vendor']: s for s in sigs}
    lab_heavy = [v for v in vendors if 'ค่าแรง' in by[v['vendor']]['pattern'] and 'ทั้งคู่' not in by[v['vendor']]['pattern']]
    mat_heavy = [v for v in vendors if 'ค่าของ' in by[v['vendor']]['pattern'] and 'ทั้งคู่' not in by[v['vendor']]['pattern']]
    both = [v for v in vendors if 'ทั้งคู่' in by[v['vendor']]['pattern']]
    qty_heavy = [v for v in vendors if 'ปริมาณ' in by[v['vendor']]['pattern']]
    if lab_heavy:
        v = max(lab_heavy, key=lambda x: x['total'].get('labour_dev_pct') or 0)
        out.append(f"เจ้าที่ 'เน้นค่าแรง': {', '.join(x['vendor'] for x in lab_heavy)} — {v['vendor']} ค่าแรงสูงกว่า {v['benchmark']} "
                   f"{pct(v['total'].get('labour_dev_pct'))} ควรเจรจาต่อรองอัตราค่าแรงเป็นประเด็นหลัก ไม่ใช่ปริมาณ")
    if mat_heavy:
        v = max(mat_heavy, key=lambda x: x['total'].get('material_dev_pct') or 0)
        out.append(f"เจ้าที่ 'เน้นค่าของ': {', '.join(x['vendor'] for x in mat_heavy)} — {v['vendor']} ค่าของสูงกว่า {v['benchmark']} "
                   f"{pct(v['total'].get('material_dev_pct'))} ควรขอ Breakdown ราคาวัสดุและแหล่งที่มาก่อนอนุมัติ")
    if both:
        out.append(f"เจ้าที่สูงทั้งค่าแรงและค่าของ: {', '.join(x['vendor'] for x in both)} — ควรเจรจาแบบครอบคลุมทั้งสองมิติพร้อมกัน")
    if qty_heavy:
        out.append(f"เจ้าที่ 'เน้นปริมาณ': {', '.join(x['vendor'] for x in qty_heavy)} — มีรายการปริมาณเกิน "
                   f"{qty_heavy[0]['benchmark']} มาก ควรตรวจสอบปริมาณร่วม (Joint Re-measure) ก่อนตกลงราคา")
    closest = min(vendors, key=lambda x: x['total']['savings_pct'] or 0)
    if len(vendors) > 1:
        out.append(f"{closest['vendor']} ใกล้เคียง {closest['benchmark']} ที่สุด (ปรับได้เพียง {closest['total']['savings_pct']:.1f}%) "
                   f"จึงเหมาะเป็นราคาอ้างอิงเปรียบเทียบ (Benchmark) ในการเจรจากับเจ้าอื่น")
    return out


def executive(vendors, sigs, tolerance):
    rows = [{'vendor': v['vendor'], 'original': v['total']['original'], 'normalized': v['total']['normalized'],
             'savings': v['total']['savings'], 'savings_pct': v['total']['savings_pct']} for v in vendors]
    items = sum(v['total']['benchmark_items'] for v in vendors)
    lo = min(vendors, key=lambda v: v['total']['savings_pct'] or 0)
    hi = max(vendors, key=lambda v: v['total']['savings_pct'] or 0)
    names = ', '.join(v['vendor'] for v in vendors)
    if len(vendors) > 1:
        summary = (f"รายงานฉบับนี้ตรวจสอบรายการ BOQ รวม {items:,} รายการ จากผู้เสนอราคา {len(vendors)} ราย ({names}) "
                   f"พบว่าราคาที่เสนอสูงกว่าราคากลางอย่างมีนัยสำคัญในระดับ {lo['total']['savings_pct']:.1f}–{hi['total']['savings_pct']:.1f}% "
                   f"โดย {lo['vendor']} ใกล้เคียงราคากลางที่สุด และ {hi['vendor']} ห่างจากราคากลางมากที่สุด")
    else:
        v = vendors[0]
        summary = (f"รายงานฉบับนี้ตรวจสอบรายการ BOQ รวม {items:,} รายการ ของ {v['vendor']} เทียบ {v['benchmark']} "
                   f"พบว่าปรับลดได้ {v['total']['savings_pct']:.1f}% ของราคาที่เสนอ")
    by = {s['vendor']: s for s in sigs}
    bullets = [f"{v['vendor']}: {by[v['vendor']]['pattern']} — หมวดที่กระทบมากที่สุด {by[v['vendor']]['top_groups']} "
               f"ปรับได้ {money(v['total']['savings'])} บาท ({v['total']['savings_pct']:.1f}%)" for v in vendors]
    bullets.append(f"ข้อเสนอแนะเชิงกลยุทธ์: ใช้ผลการ Normalize ที่เกณฑ์ {tolerance * 100:.0f}% นี้เป็นฐานการเจรจา "
                   f"โดยเน้นจุดที่มีมูลค่าสูงสุดของแต่ละเจ้าก่อน")
    avg_s = sum(r['savings'] for r in rows) / len(rows)
    avg_p = sum(r['savings_pct'] or 0 for r in rows) / len(rows)
    headline = (f"ผลรวมการประหยัดที่เป็นไปได้ (เฉลี่ย {len(rows)} เจ้า {names} เทียบราคาที่เสนอ): "
                f"ประมาณ {avg_s / 1e6:,.0f} ล้านบาท หรือ {avg_p:.1f}% ของราคาเสนอเฉลี่ย")
    return {'rows': rows, 'summary': summary, 'bullets': bullets, 'headline': headline}


def build_many(workbooks, tolerance=None):
    """The report contract for one or more uploaded workbooks.

    workbooks: iterable of (sheets, filename). Every vendor in every workbook
    is included; a workbook with no comparable structure is listed as skipped.
    """
    prepared, skipped = [], []
    for sheets, filename in workbooks:
        found = prepare(sheets, filename)
        if not found:
            skipped.append({'filename': filename, 'reason': 'ไม่พบคอลัมน์เปรียบเทียบผู้เสนอราคากับราคากลาง'})
        prepared.extend(found)
    if not prepared:
        return None
    # Two workbooks naming the same vendor stay distinguishable by file.
    names = defaultdict(int)
    for p in prepared:
        names[p['vendor']] += 1
    for p in prepared:
        if names[p['vendor']] > 1:
            p['vendor'] = f"{p['vendor']} ({stem(p['filename'])})"
    tol, source = choose_tolerance(prepared, tolerance)
    vendors = [finish(p, tol, source) for p in prepared]
    groups = sorted({g['group'] for v in vendors for g in v['groups']})
    comparison = {}
    for key, field in (('labour_dev', 'labour_dev_pct'), ('material_dev', 'material_dev_pct'),
                       ('quantity_over', 'quantity_over')):
        comparison[key] = {g: {v['vendor']: next((x[field] for x in v['groups'] if x['group'] == g), None)
                               for v in vendors} for g in groups}
    sigs = [signature(v, vendors) for v in vendors]
    return {'tolerance': tol, 'tolerance_source': source, 'vendors': vendors, 'files_skipped': skipped,
            'files': [f for f in dict.fromkeys(fn for _, fn in workbooks)],
            'groups': groups, 'comparison': comparison, 'signatures': sigs,
            'strategy': strategy(vendors, sigs), 'executive': executive(vendors, sigs, tol)}


def analyze_workbook(sheets, filename='', tolerance=None):
    return build_many([(sheets, filename)], tolerance)
