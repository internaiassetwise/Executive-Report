import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHandler } from '../src/app.mjs';

const origin = 'http://localhost:3000';
const pythonBin = process.env.PYTHON_BIN || 'python';
const csv = ['order_date,region,product,revenue,units',
  ...Array.from({ length: 36 }, (_, i) => `2026-${String(i % 6 + 1).padStart(2, '0')}-${String(i % 27 + 1).padStart(2, '0')},${['North', 'South', 'East'][i % 3]},P${i % 4},${100 + i * 5},${i % 4 + 1}`)].join('\n');
const revenue = Array.from({ length: 36 }, (_, i) => 100 + i * 5);

/** A provider stub: records the request and returns a fixed plan. No network. */
function fakeLlm(dashboard, calls = []) {
  return {
    name: 'fake', model: 'fake-model',
    async generateJson(request) {
      calls.push(request);
      return { data: { summary: 'สรุปจากหลักฐาน', insights: [], recommendations: [], dashboard }, usage: {} };
    },
  };
}

async function context(t, llm) {
  const tempBase = await mkdtemp(join(tmpdir(), 'dashboard-api-test-'));
  const handle = createHandler({ allowedOrigins: [origin], llm, datasets: { pythonBin, tempBase } });
  t.after(async () => {
    await handle.close();
    assert.deepEqual(await readdir(tempBase), [], 'temporary files are removed');
    await rmdir(tempBase);
  });
  return handle;
}
const url = path => `http://localhost:8000/api/datasets${path}`;
const post = (path, body) => new Request(url(path), { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function ready(handle, content = csv, filename = 'sales.csv') {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/csv' }), filename);
  const created = await handle(new Request(url(''), { method: 'POST', headers: { Origin: origin }, body: form }));
  const { id } = await created.json();
  for (let attempt = 0; attempt < 400; attempt++) {
    const job = await (await handle(new Request(url(`/${id}`)))).json();
    if (job.status !== 'processing') { assert.equal(job.status, 'ready', JSON.stringify(job.error)); return job; }
    await delay(25);
  }
  assert.fail('analysis did not finish');
}

const aiPlan = {
  title: 'ยอดขายตามภูมิภาค', description: 'ภาพรวม', sheet_id: 's0',
  kpis: [{ label: 'รายได้รวม', column: 'c3', agg: 'sum' }, { label: 'จำนวนรายการ', column: 'none', agg: 'count' }],
  charts: [{ type: 'bar', title: 'รายได้ตามภูมิภาค', x: 'c1', y: 'c3', agg: 'sum', grain: 'auto' }, { type: 'line', title: 'รายได้รายเดือน', x: 'c0', y: 'c3', agg: 'sum', grain: 'month' }],
  filters: [{ column: 'c1' }, { column: 'c0' }],
};

test('an AI plan is accepted only after validation and the prompt carries no rows', async t => {
  const calls = [];
  const handle = await context(t, fakeLlm(aiPlan, calls));
  const job = await ready(handle);
  assert.equal(calls.length, 1, 'one provider request per analysis');
  assert.ok(!calls[0].prompt.includes('P3,'), 'no raw CSV rows in the prompt');
  assert.equal(job.analysis.dashboard.source, 'ai');
  assert.equal(job.analysis.ai.dashboard, 'accepted');
  assert.deepEqual(job.analysis.dashboard.kpis.map(k => [k.column, k.agg]), [['c3', 'sum'], [null, 'count']]);
});

test('an AI plan keeps its valid items and an unusable plan falls back to rules', async t => {
  const handle = await context(t, fakeLlm({ ...aiPlan, kpis: [{ label: 'x', column: 'c1', agg: 'sum' }, ...aiPlan.kpis] }));
  const job = await ready(handle);
  assert.equal(job.analysis.dashboard.source, 'ai');
  assert.deepEqual(job.analysis.dashboard.kpis.map(k => k.column), ['c3', null], 'summing a text column is dropped');
  const other = await context(t, fakeLlm({ ...aiPlan, sheet_id: 's9' }));
  const fallback = await ready(other);
  assert.equal(fallback.analysis.dashboard.source, 'rules');
  assert.equal(fallback.analysis.ai.dashboard, 'rejected');
});

test('dashboard queries apply filters to every KPI and chart', async t => {
  const handle = await context(t, fakeLlm(aiPlan));
  const job = await ready(handle);
  const all = await (await handle(post(`/${job.id}/dashboard`, { options: true }))).json();
  assert.equal(all.kpis[0].value, revenue.reduce((a, b) => a + b, 0));
  assert.deepEqual(all.options.f1.values.map(v => v.value).sort(), ['East', 'North', 'South']);
  const south = revenue.filter((_, i) => i % 3 === 1);
  const filtered = await (await handle(post(`/${job.id}/dashboard`, { filters: [{ column: 'c1', values: ['South'] }] }))).json();
  assert.equal(filtered.rows_matched, south.length);
  assert.equal(filtered.kpis[0].value, south.reduce((a, b) => a + b, 0));
  assert.deepEqual(filtered.charts[0].data, [{ x: 'South', y: south.reduce((a, b) => a + b, 0) }]);
  const invalid = await handle(post(`/${job.id}/dashboard`, { filters: [{ column: 'c9', values: ['x'] }] }));
  assert.equal(invalid.status, 400);
  const rows = await (await handle(new Request(url(`/${job.id}/rows?filters=${encodeURIComponent(JSON.stringify([{ column: 'c0', from: '2026-02-01', to: '2026-02-28' }]))}`)))).json();
  assert.equal(rows.total_rows, 6);
});

test('HTML and PDF exports carry computed numbers and reject forged chart images', async t => {
  const handle = await context(t, fakeLlm(aiPlan));
  const job = await ready(handle);
  const html = await handle(post(`/${job.id}/export-dashboard`, { format: 'html', filters: [{ column: 'c1', values: ['North'] }] }));
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  const page = await html.text();
  assert.ok(page.includes('ยอดขายตามภูมิภาค') && page.includes('North'));
  assert.ok(!page.includes('P3,'), 'standalone HTML holds aggregates only');
  const forged = await handle(post(`/${job.id}/export-dashboard`, { format: 'pdf', images: [{ id: 'c1', data: 'data:image/png;base64,iVBORw0KGgo=' }] }));
  assert.equal(forged.status, 400);
  const pdf = await handle(post(`/${job.id}/export-dashboard`, { format: 'pdf' }));
  assert.equal(pdf.status, 200, await pdf.clone().text());
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
});
