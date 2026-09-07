# Report rendering

`Report JSON → ReportView → print CSS → browser Save as PDF` is the implemented local export. The report covers every detected table, with selected analysis types applied wherever eligible. It contains per-sheet coverage, executive facts, weighted quality, charts, calculation provenance, partial failures, limitations and recommendations. Optional Gemini commentary is kept separate.

The interactive results page shows 12 findings per page without dropping calculations. The printable report includes all findings and statistics; it renders up to 12 charts and uses lightweight group/bin tables for subsequent charts to keep large workbooks usable. Complete evidence and chart data remain in Report JSON. No sheet/table selection is required.

The supplied ASW logo is unchanged. Reports use navy/white, Thai-compatible fonts, A4 margins, content-aware page breaks and CSS page counters where supported. Charts are driven by Python-calculated data. Empty analytical sections are omitted. JSON download preserves the complete evidence payload and outlier source-row details.

The button opens the browser print dialog; the user selects Save as PDF. Page numbering and pagination depend on browser support. This initial release does not claim a server-side Jinja2/Playwright PDF service or automatic PDF render validation. A future service should consume this same JSON, enforce schema/size limits, use escaped Jinja templates, embed Thai fonts locally, render Chromium A4 pages and validate page images before release.
