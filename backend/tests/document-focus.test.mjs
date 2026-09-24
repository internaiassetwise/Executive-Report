import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDocumentFocus, documentEvidence, renderFocusedReportHtml } from '../src/document-focus.mjs';

const document = { type: 'estimate', headline: 'มูลค่ารวม 56,500 บาท', dashboard: {
  headline: 'มูลค่ารวม 56,500 บาท',
  kpis: [{ label: 'มูลค่ารวม', value: 56500, format: 'money', note: 'บาท' }],
  charts: [], tables: [],
} };

test('BOQ objective selects computed evidence and rejects invented numbers', async () => {
  const facts = documentEvidence(document.dashboard);
  assert.ok(facts.some(item => item.statement.includes('56,500')));
  const llm = { async generateJson({ prompt }) {
    const input = JSON.parse(prompt);
    assert.equal(input.objective, 'สรุปมูลค่ารวม');
    return { data: { status: 'complete', summary: 'มูลค่ารวม 56,500 บาท', evidence_ids: [input.facts[0].id] } };
  } };
  const focus = await analyzeDocumentFocus(document, 'สรุปมูลค่ารวม', { llm });
  assert.equal(focus.status, 'complete');
  assert.equal(focus.evidence.length, 1);
  const invented = await analyzeDocumentFocus(document, 'สรุปมูลค่ารวม', { llm: { async generateJson() {
    return { data: { status: 'complete', summary: 'มูลค่ารวม 999,999 บาท', evidence_ids: [facts[0].id] } };
  } } });
  assert.equal(invented.status, 'error');
});

test('focused report adds one escaped page and updates page totals', () => {
  const original = '<html><body><section class="page"><div class="foot">หน้า 1 / 2</div></section><section class="page"><div class="foot">หน้า 2 / 2</div></section></body></html>';
  const result = renderFocusedReportHtml(original, { status: 'complete', objective: '<script>bad</script>', summary: 'มูลค่ารวม 56,500 บาท', evidence: [{ id: 'BOQ-001', statement: 'มูลค่ารวม 56,500 บาท' }] });
  assert.equal((result.match(/class="page"/g) || []).length, 3);
  assert.match(result, /หน้า 1 \/ 3/);
  assert.match(result, /หน้า 3 \/ 3/);
  assert.match(result, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(result, /<script>/);
});
