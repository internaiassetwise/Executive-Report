'use client';

import { Table2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DataPreview } from '@/components/data-preview';
import { EChart } from '@/components/echart';
import { AnswerView } from '@/components/agent-answer';
import { chartOption, formatValue } from '@/lib/document-charts';
import type { Dataset, DocumentInfo } from '@/lib/datasets';
import { formatFull } from '../../shared/dashboard-charts.mjs';

export { chartOption, formatValue };

/** The answer to the objective typed at upload, computed by the agent (or the older focused summary). */
export function DocumentFocus({ focus, compact = false }: { focus?: DocumentInfo['focus']; compact?: boolean }) {
  if (!focus) return null;
  if (compact) return <p className="answer-note">คำตอบตามโจทย์ “{focus.objective}” อยู่หน้าท้ายของรายงานด้านล่าง</p>;
  return <AnswerView answer={focus} question={focus.objective} heading="คำตอบตามโจทย์" />;
}

/** Dashboard of a construction cost document: figures, charts and tables computed on the server. */
export function DocumentDashboard({ id, dataset, document }: { id: string; dataset: Dataset; document: DocumentInfo }) {
  const board = document.dashboard;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const options = useMemo(() => new Map((board?.charts || []).map(chart => [chart.id, chartOption(chart)])), [board]);
  const sheet = dataset.sheets.find(item => item.id === document.sheet_id) || dataset.sheets.find(item => !item.combined_from);
  if (!board) return <section className="office-card office-empty"><h2>ยังสร้างแดชบอร์ดของไฟล์นี้ไม่ได้</h2></section>;
  const where = [board.source.sheet && `ชีต ${board.source.sheet}`, board.source.range].filter(Boolean).join(' ช่วง ');
  const isWide = (chart: (typeof board.charts)[number]) => chart.kind === 'hbar' || chart.kind === 'pareto' || chart.categories.length > 6;
  // Half-width charts pair up; an odd one out takes the full row instead of leaving a hole.
  const narrow = board.charts.filter(chart => !isWide(chart));
  const lone = narrow.length % 2 ? narrow.at(-1)?.id : undefined;
  return <div className="dash">
    <header className="dash-header"><div>
      <span className="doc-badge">{document.label}</span>
      <h2>{board.title}</h2>
      <p>{board.headline}</p>
      <small>คำนวณจากทุกรายการในไฟล์ {board.source.filename}{where ? ` · ${where}` : ''} · ไม่นับแถวสรุปยอดและ VAT</small>
    </div></header>

    <DocumentFocus focus={document.focus} />

    <section className="dash-kpis" aria-label="ตัวเลขสรุป">
      {board.kpis.map(kpi => <article key={kpi.label}>
        <span>{kpi.label}</span>
        <strong title={formatValue(kpi.value, kpi.format)}>{formatValue(kpi.value, kpi.format, true)}</strong>
        <small>{kpi.note}</small>
      </article>)}
    </section>

    <section className="dash-grid" aria-label="กราฟ">
      {board.charts.map(chart => {
        const wide = isWide(chart) || chart.id === lone;
        return <article key={chart.id} className={`dash-panel${wide ? ' wide' : ''}`}>
          <div className="dash-panel-head">
            <div><h3>{chart.title}</h3>{chart.note && <p>{chart.note}</p>}</div>
            <button className="data-icon-button" aria-pressed={!!open[chart.id]} aria-label={`แสดงตัวเลขของ ${chart.title}`} title="ดูตัวเลข"
              onClick={() => setOpen(current => ({ ...current, [chart.id]: !current[chart.id] }))}><Table2 size={16} /></button>
          </div>
          <EChart option={options.get(chart.id) || {}} label={chart.title} />
          {open[chart.id] && <div className="dash-mini-table"><table>
            <thead><tr><th>รายการ</th>{chart.series.map(entry => <th key={entry.name}>{entry.name}</th>)}</tr></thead>
            <tbody>{chart.categories.map((name, index) => <tr key={index}><td>{name}</td>
              {chart.series.map(entry => <td key={entry.name}>{formatValue(entry.values[index], entry.name.includes('%') ? 'percent' : chart.format)}</td>)}</tr>)}</tbody>
          </table></div>}
        </article>;
      })}
    </section>

    {board.tables.map(table => <section key={table.title} className="dash-panel doc-table">
      <div className="dash-panel-head"><div><h3>{table.title}</h3></div></div>
      <div className="doc-table-scroll"><table>
        <thead><tr>{table.columns.map(column => <th key={column.label} className={column.format === 'text' ? '' : 'num'}>{column.label}</th>)}</tr></thead>
        <tbody>{table.rows.map((row, index) => <tr key={index}>{row.map((cell, position) =>
          <td key={position} className={table.columns[position]?.format === 'text' ? '' : 'num'}>{formatValue(cell, table.columns[position]?.format || 'text')}</td>)}</tr>)}</tbody>
      </table></div>
    </section>)}

    {sheet && <DataPreview key={`${id}:${sheet.id}`} id={id} sheet={sheet} />}
    <p className="dash-note">{formatFull(dataset.rows_count)} แถวจาก {dataset.filename}</p>
  </div>;
}
