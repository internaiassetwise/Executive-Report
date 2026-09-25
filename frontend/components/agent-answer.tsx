'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowUp, LoaderCircle } from 'lucide-react';
import { EChart } from '@/components/echart';
import { chartOption, formatValue } from '@/lib/document-charts';
import type { AgentAnswer, DocumentChart } from '@/lib/datasets';
import type { SheetProfile } from '@/lib/dataset-analysis';

type AnswerLike = Partial<Omit<AgentAnswer, 'status' | 'evidence'>> & { status?: string; message?: string; evidence?: { id: string; statement: string }[] };

const STATUS: Record<string, string> = { partial: 'ตอบได้บางส่วน', unsupported: 'ข้อมูลในไฟล์ไม่พอจะตอบ', unavailable: 'ยังตอบไม่ได้', error: 'ยังตอบไม่ได้' };

const isWide = (chart: DocumentChart) => chart.kind === 'hbar' || chart.kind === 'line' || chart.categories.length > 8;

export function AnswerChart({ chart, wide = isWide(chart) }: { chart: DocumentChart; wide?: boolean }) {
  const option = useMemo(() => chartOption(chart), [chart]);
  return <figure className={`answer-chart${wide ? ' wide' : ''}`}>
    <figcaption><strong>{chart.title}</strong><span>{chart.note}</span></figcaption>
    <EChart option={option} label={chart.title} />
  </figure>;
}

/** One computed answer: the reply first, then its numbers, charts, detail and sources. */
export function AnswerView({ answer, question, heading }: { answer: AnswerLike; question?: string | null; heading?: string }) {
  const status = answer.status && STATUS[answer.status];
  const kpis = answer.kpis || [];
  const charts = answer.charts || [];
  const sections = answer.sections || [];
  const queries = answer.queries || [];
  const text = answer.summary || answer.message || '';
  const narrow = charts.filter(chart => !isWide(chart));
  const lone = narrow.length % 2 ? narrow.at(-1)?.id : undefined;
  return <article className="answer">
    <header className="answer-head">
      {heading && <span className="answer-eyebrow">{heading}</span>}
      {question && <p className="answer-question">{question}</p>}
      {status && <span className={`answer-status ${answer.status}`}>{status}</span>}
    </header>
    {answer.title && <h3 className="answer-title">{answer.title}</h3>}
    {text && <p className="answer-summary">{text}</p>}
    {kpis.length > 0 && <div className="answer-kpis">{kpis.map(kpi =>
      <div key={kpi.label}><span>{kpi.label}</span><strong>{formatValue(kpi.value, 'number')}</strong><small>{kpi.note}</small></div>)}</div>}
    {charts.length > 0 && <div className="answer-charts">{charts.map(chart => <AnswerChart key={chart.id} chart={chart} wide={isWide(chart) || chart.id === lone} />)}</div>}
    {sections.map(section => <section key={section.title} className="answer-section">
      <h4>{section.title}</h4>
      {section.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
    </section>)}
    {(queries.length > 0 || Boolean(answer.evidence?.length)) && <details className="answer-sources">
      <summary>ที่มาของตัวเลข</summary>
      <ul>
        {queries.map(query => <li key={query.id}><span>{query.purpose}</span><small>{[query.trace?.sheet && `ชีต ${query.trace.sheet}`, query.trace?.range, query.matched != null && `${formatValue(query.matched, 'count')} แถว`].filter(Boolean).join(' · ')}</small></li>)}
        {!queries.length && answer.evidence?.map(item => <li key={item.id}><span>{item.statement}</span></li>)}
      </ul>
      <p>ทุกตัวเลขคำนวณจากแถวข้อมูลในไฟล์ ไม่นับแถวสรุปยอด ข้อความที่อ้างตัวเลขซึ่งคำนวณไม่ได้จะถูกตัดออก</p>
    </details>}
  </article>;
}

/** Question ideas made from the file's own columns, so each one can be computed. */
export function suggestQuestions(profiles: SheetProfile[] = [], construction = false): string[] {
  if (construction) return ['รายการไหนมีมูลค่าสูงสุด 10 อันดับแรก', 'หมวดงานไหนมีสัดส่วนมูลค่ามากที่สุด', 'มีรายการไหนที่ควรตรวจสอบราคาเป็นพิเศษ'];
  const profile = profiles[0];
  const columns = profile?.columns || [];
  const measure = columns.find(column => column.role === 'measure' && column.meaning === 'money') || columns.find(column => column.role === 'measure');
  // A grouping column repeats: order numbers and other near-unique ids make useless groups.
  const dimension = columns.find(column => column.role === 'dimension' && column.unique_count > 1 && column.unique_count <= 50 && column.unique_count < 0.8 * (profile?.rows_count || Infinity));
  const time = columns.find(column => column.role === 'time');
  const ideas: string[] = [];
  if (measure && dimension) ideas.push(`${measure.name} รวมแยกตาม ${dimension.name} กลุ่มไหนสูงสุด`);
  if (measure && time) ideas.push(`${measure.name} เปลี่ยนไปอย่างไรในแต่ละเดือน`);
  if (dimension) ideas.push(`${dimension.name} ไหนมีจำนวนรายการมากที่สุด`);
  if (!ideas.length) ideas.push('สรุปภาพรวมของไฟล์นี้', 'มีข้อมูลส่วนไหนที่ควรตรวจสอบ');
  return ideas.slice(0, 3);
}

/** The question box pinned under the results. Enter sends, Shift+Enter adds a line. */
export function AskBar({ onAsk, pending, disabled, note }: { onAsk: (question: string) => Promise<boolean>; pending: boolean; disabled?: boolean; note?: string }) {
  const [value, setValue] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 132)}px`;
  }, [value]);
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const question = value.trim();
    if (!question || pending || disabled) return;
    setValue('');
    if (!(await onAsk(question))) setValue(current => current || question);
  }
  function key(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
  }
  return <form className="askbar" onSubmit={submit}>
    <div className="askbar-box">
      <textarea ref={box} rows={1} value={value} maxLength={1000} disabled={disabled} aria-label="ถามเพิ่มเติมเกี่ยวกับไฟล์นี้"
        placeholder={disabled ? note : 'ถามเพิ่มเติมเกี่ยวกับไฟล์นี้…'} onChange={event => setValue(event.target.value)} onKeyDown={key} />
      <button type="submit" className="askbar-send" disabled={!value.trim() || pending || disabled} aria-label="ส่งคำถาม">
        {pending ? <LoaderCircle size={18} className="data-spin" /> : <ArrowUp size={18} />}
      </button>
    </div>
  </form>;
}
