import test from 'node:test';
import assert from 'node:assert/strict';
import { requestedPages } from '../src/report-author.mjs';
import { renderFocusedReportHtml, reportPageCount, REPORT_PAGE_CHARS } from '../src/document-focus.mjs';

test('the length asked for is read from the objective', () => {
  assert.equal(requestedPages('สรุปภาพรวม 7 หน้า'), 7);
  assert.equal(requestedPages('ขอรายงาน ๑๒ หน้า'), 12);
  assert.equal(requestedPages('a 5-page report, 5 pages please'), 5);
  assert.equal(requestedPages('สรุปหน้าเดียว'), 1);
  assert.equal(requestedPages('ขอ 99 หน้า'), 30, 'capped');
  assert.equal(requestedPages('ยอดขายปี 2026 แยกตามภาค'), null, 'a year is not a length');
  assert.equal(requestedPages(''), null);
});

test('a long answer spreads over as many engine report pages as it needs, footers renumbered', () => {
  const page = number => `<section class="page"><p>เดิม</p><div class="foot">หน้า ${number} / 2</div></section>`;
  const original = `<html><body>${page(1)}${page(2)}</body></html>`;
  const paragraph = 'ก'.repeat(900);
  const focus = { status: 'complete', objective: 'โจทย์', summary: 'สรุป', sections: [
    { title: 'หนึ่ง', paragraphs: [paragraph, paragraph, paragraph] },
    { title: 'สอง', paragraphs: [paragraph, paragraph, paragraph] },
  ] };
  const html = renderFocusedReportHtml(original, focus);
  const total = reportPageCount(html);
  assert.ok(total >= 2 + Math.ceil((6 * 900) / REPORT_PAGE_CHARS), `pages: ${total}`);
  const footers = [...html.matchAll(/หน้า (\d+) \/ (\d+)/g)].map(match => [Number(match[1]), Number(match[2])]);
  assert.deepEqual(footers.map(([number]) => number), Array.from({ length: total }, (_, index) => index + 1));
  assert.ok(footers.every(([, of]) => of === total));
  assert.equal((html.match(/<h2>/g) || []).length, 1, 'the heading opens the first answer page only');
  assert.ok(!/<h3>[^<]*<\/h3><div class="foot">/.test(html), 'a heading never ends a page');
});
