# Analysis engine

Core code: `backend/analysis/analysis_engine.py`. There are no domain-name conditions.

`analyze_workbook` executes eligible analyses for every detected table in every sheet automatically, including hidden sheets. Calculations remain independent per table; measures are never summed, joined or correlated across tables. Whole-workbook completeness uses total non-missing cells divided by total data cells; duplicate counts are summed from within-table checks. Empty and metadata-only sheets remain in coverage with an explicit no-table reason. Per-analysis calculation failures are disclosed while remaining analyses continue. Evidence IDs are unique across the report, and progress updates identify the current table and sheet.

| Analysis | Eligibility | Calculation |
|---|---|---|
| Quality | Any detected table | Missing cells, preserved duplicates, completeness |
| Statistics | Numeric non-ID column | Count, mean, median, min/max, sample standard deviation |
| Frequency | 2–30 unique categories | Row count per category, descending |
| Category comparison | Category plus measure | Mean per group, valid pairs only |
| Time trend | Unambiguous dates with at least three dates | Monthly mean, missing months disclosed |
| Distribution | At least ten values and three distinct parsed numbers | Equal-width histogram, final bin includes upper endpoint |
| Outliers | At least eight values and three distinct parsed numbers | Linear-interpolated quartiles, 1.5 IQR; no flags when IQR=0 |
| Correlation | Two variable non-ID measures and ten complete pairs | Scaled, centered Pearson r; never causation |

Thresholds are conservative presentation heuristics, not statistical-significance guarantees. Parser excludes only clearly empty rows and numeric-reconciled labeled summaries, with row-level reasons. Unresolved summary candidates stay in the data and are flagged. Duplicates remain included. Missing numeric cells are excluded per computation, never from the original workbook.

Numbers with ambiguous locale punctuation remain text. ISO dates and real Excel datetime cells support chronology. Slash dates are flagged rather than guessed. Numeric codes with leading zeros are preserved. Excel formulas use cached values; absent caches become missing values with an explicit warning.

Tests exercise expected values, retention, exclusions, eligibility and provenance instead of mirroring code structure.
