import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, readdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHandler } from '../src/app.mjs';
import { createApiServer } from '../src/server.mjs';
import { ACCEPTED_EXTENSIONS, datasetConfigFromEnv, MULTIPART_OVERHEAD } from '../src/datasets.mjs';

const origin = 'http://localhost:3000';
const pythonBin = process.env.PYTHON_BIN || 'python';
async function context(t, overrides = {}) {
  const tempBase = await mkdtemp(join(tmpdir(), 'dataset-api-test-'));
  const handle = createHandler({ allowedOrigins: [origin], datasets: { pythonBin, tempBase, autoAnalyze: false, ...overrides } });
  t.after(async () => {
    await handle.close();
    assert.deepEqual(await readdir(tempBase), [], 'service close removes every temporary dataset');
    await rmdir(tempBase);
  });
  return { handle, tempBase };
}
function request(path = '', options = {}) {
  return new Request(`http://localhost:8000/api/datasets${path}`, options);
}
function fileRequest(content, filename = 'data.csv', type = 'text/csv', requestOrigin = origin, objective) {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), filename);
  if (objective !== undefined) form.append('objective', objective);
  return request('', { method: 'POST', headers: requestOrigin ? { Origin: requestOrigin } : {}, body: form });
}
async function upload(handle, content, filename, type, objective) {
  const response = await handle(fileRequest(content, filename, type, origin, objective));
  const body = await response.json();
  assert.equal(response.status, 202, JSON.stringify(body));
  assert.match(body.id, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(body.status, 'processing');
  assert.ok(body.progress < 100);
  return body.id;
}
async function finish(handle, id) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const response = await handle(request(`/${id}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    if (body.status !== 'processing') return body;
    await delay(25);
  }
  assert.fail('Python ingestion did not finish in time');
}
async function rows(handle, id, query = '') {
  const response = await handle(request(`/${id}/rows${query}`));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

test('configuration uses validated environment limits and exposes no credentials', async t => {
  assert.throws(() => datasetConfigFromEnv({ DATASET_MAX_FILE_MB: '0' }), /DATASET_MAX_FILE_MB/);
  assert.throws(() => datasetConfigFromEnv({ DATASET_MAX_CONCURRENT: '300' }), /DATASET_MAX_CONCURRENT/);
  assert.equal(datasetConfigFromEnv({ DATASET_MAX_FILE_MB: '3' }).maxFileSize, 3 * 1024 * 1024);
  const { handle } = await context(t, { maxFileSize: 1234 });
  const response = await handle(request('/config'));
  const body = await response.json();
  assert.deepEqual(body, { max_file_size: 1234, accepted_extensions: ACCEPTED_EXTENSIONS, max_rows: 100000, max_columns: 200, max_cells: 2000000, retention_minutes: 60, auto_analyze: false, ai: { configured: false, model: 'gemini-3-flash-preview' } });
  assert.ok(['.pdf', '.docx', '.png', '.ods', '.json'].every(extension => ACCEPTED_EXTENSIONS.includes(extension)));
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('CSV ingestion returns actual typed data, stable row numbers and paginated numeric sort/search', async t => {
  const { handle } = await context(t);
  const id = await upload(handle, 'team,amount,active\nNorth,2,true\nSouth,10,false\nNorth,1,true\n');
  const job = await finish(handle, id);
  assert.equal(job.status, 'ready', JSON.stringify(job.error));
  assert.equal(job.progress, 100);
  assert.equal(job.dataset.rows_count, 3);
  assert.equal(job.dataset.columns_count, 3);
  assert.deepEqual(job.dataset.sheets[0].columns.map(c => c.name), ['team', 'amount', 'active']);
  const page = await rows(handle, id, '?sheet=s0&page=1&page_size=2&sort=c1&direction=desc');
  assert.equal(page.total_rows, 3);
  assert.equal(page.rows.length, 2);
  assert.equal(page.rows[0].values.c1, 10);
  assert.equal(page.rows[0].values.c2, false);
  assert.ok(Number.isInteger(page.rows[0].row_number));
  const filtered = await rows(handle, id, '?search=north&column=c0&sort=c1&direction=asc');
  assert.equal(filtered.total_rows, 2);
  assert.deepEqual(filtered.rows.map(row => row.values.c1), [1, 2]);
  assert.equal((await rows(handle, id, '?page=2&page_size=2')).rows.length, 1);
  assert.equal((await rows(handle, id, '?search=%25')).total_rows, 0, 'search treats SQL wildcard characters literally');
  assert.equal((await handle(request(`/${id}/rows?sort=unknown`))).status, 400);
  assert.equal((await handle(request(`/${id}/rows?page_size=10000`))).status, 400);
  assert.equal((await handle(request(`/${id}/rows?sheet=unknown`))).status, 400);
  const abort = new AbortController();
  const cancelled = handle(request(`/${id}/rows`, { signal: abort.signal }));
  abort.abort();
  assert.equal((await cancelled).status, 410, 'aborting a preview cancels its Python process');
  assert.equal((await rows(handle, id)).total_rows, 3, 'preview capacity is released after cancellation');
});

test('real XLSX ingestion preserves multiple sheets and dates', async t => {
  const { handle } = await context(t);
  const xlsx = execFileSync(pythonBin, ['-c', [
    'import sys,io,datetime,openpyxl',
    'w=openpyxl.Workbook()',
    's=w.active;s.title="Sales"',
    's.append(["day","amount"]);s.append([datetime.date(2026,1,2),12.5])',
    's=w.create_sheet("People");s.append(["name","active"]);s.append(["Alice",True]);s.append(["Bob",False])',
    'b=io.BytesIO();w.save(b);sys.stdout.buffer.write(b.getvalue())',
  ].join('\n')], { windowsHide: true });
  const id = await upload(handle, xlsx, 'mixed.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const job = await finish(handle, id);
  assert.equal(job.status, 'ready', JSON.stringify(job.error));
  assert.deepEqual(job.dataset.sheets.map(s => s.name), ['Sales', 'People']);
  const page = await rows(handle, id, '?sheet=s1');
  assert.equal(page.total_rows, 2);
  assert.equal(page.rows[0].values.c0, 'Alice');
  assert.equal(page.rows[1].values.c1, false);
  const date = (await rows(handle, id, '?sheet=s0')).rows[0].values.c0;
  assert.match(date, /^2026-01-02/);
});

test('missing MIME and UTF-16 BOM files are accepted after content validation', async t => {
  const { handle } = await context(t);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('name,value\r\nทดสอบ,3\r\n', 'utf16le')]);
  const id = await upload(handle, utf16, 'unicode.csv', '');
  const job = await finish(handle, id);
  assert.equal(job.status, 'ready', JSON.stringify(job.error));
  assert.equal((await rows(handle, id)).rows[0].values.c0, 'ทดสอบ');
});

test('extension, type-specific MIME, signatures, empty files and multipart cardinality are enforced', async t => {
  const { handle } = await context(t);
  for (const [content, name, mime, status, code] of [
    ['a,b\n1,2', 'data.exe', 'text/csv', 415, 'UNSUPPORTED_FORMAT'],
    ['a,b\n1,2', 'data.csv', 'text/html', 415, 'INVALID_MIME_TYPE'],
    ['a,b\n1,2', 'data.xlsx', 'text/csv', 415, 'INVALID_MIME_TYPE'],
    ['a,b\n1,2', 'data.xlsx', 'application/octet-stream', 400, 'INVALID_FILE'],
    ['', 'empty.csv', 'text/csv', 400, 'EMPTY_FILE'],
  ]) {
    const response = await handle(fileRequest(content, name, mime));
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }
  const form = new FormData();
  form.append('file', new Blob(['a\n1']), 'one.csv');
  form.append('file', new Blob(['a\n2']), 'two.csv');
  const response = await handle(request('', { method: 'POST', headers: { Origin: origin }, body: form }));
  assert.equal((await response.json()).error.code, 'SINGLE_FILE_REQUIRED');
});

test('other formats are converted on upload and keep the name the user gave', async t => {
  const { handle } = await context(t);
  const table = '<table><tr><th>team</th><th>amount</th></tr><tr><td>North</td><td>1,200</td></tr><tr><td>South</td><td>800</td></tr></table>';
  for (const [content, name, type, from] of [
    [`<html><body>${table}</body></html>`, 'export.xls', 'application/vnd.ms-excel', 'xls'],
    [JSON.stringify([{ team: 'North', amount: 1200 }, { team: 'South', amount: 800 }]), 'data.json', 'application/json', 'json'],
    ['team\tamount\nNorth\t1200\nSouth\t800\n', 'data.tsv', 'text/tab-separated-values', null],
  ]) {
    const id = await upload(handle, content, name, type);
    const job = await finish(handle, id);
    assert.equal(job.status, 'ready', `${name}: ${JSON.stringify(job.error)}`);
    assert.equal(job.dataset.filename, name);
    assert.equal(job.dataset.converted_from, from ?? undefined);
    const page = await rows(handle, id);
    assert.equal(page.total_rows, 2, name);
  }
  for (const [content, name, type, code] of [
    ['not a pdf', 'scan.pdf', 'application/pdf', 'INVALID_FILE'],
    ['plain', 'memo.docx', 'application/octet-stream', 'INVALID_FILE'],
    ['x', 'old.doc', 'application/msword', 'UNSUPPORTED_FORMAT'],
  ]) {
    const response = await handle(fileRequest(content, name, type));
    assert.equal((await response.json()).error.code, code, name);
  }
  // A photo needs the picture reader; without a provider the upload says so.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');
  const job = await finish(handle, await upload(handle, png, 'photo.png', 'image/png'));
  assert.equal(job.error.code, 'AI_REQUIRED');
});

test('foreign and missing write origins are rejected and no dataset listing exists', async t => {
  const { handle } = await context(t);
  for (const invalidOrigin of ['https://evil.example', 'null', null]) {
    assert.equal((await handle(fileRequest('a\n1', 'file.csv', 'text/csv', invalidOrigin))).status, 403);
  }
  assert.equal((await handle(request(''))).status, 405);
  const id = await upload(handle, 'a\n1');
  assert.equal((await handle(request(`/${id}`, { headers: { Origin: 'https://evil.example' } }))).status, 403);
  assert.equal((await handle(request(`/${id}`, { method: 'DELETE', headers: { Origin: 'https://evil.example' } }))).status, 403);
  assert.equal((await handle(request('/guessable-id'))).status, 404);
  assert.equal((await handle(request(`/${id}`, { method: 'DELETE', headers: { Origin: origin } }))).status, 204);
  assert.equal((await handle(request(`/${id}`))).status, 404);
});

test('parser validation errors remain reviewable while uploaded bytes are removed', async t => {
  const { handle, tempBase } = await context(t);
  const id = await upload(handle, 'name,value\nAlice,"2\nBob,3');
  const job = await finish(handle, id);
  assert.equal(job.status, 'error');
  assert.equal(job.error.code, 'INVALID_FILE');
  assert.equal((await handle(request(`/${id}/rows`))).status, 409);
  const roots = await readdir(tempBase);
  assert.equal(roots.length, 1);
  // Completion status is visible slightly before the asynchronous directory removal.
  for (let attempt = 0; attempt < 50 && (await readdir(join(tempBase, roots[0]))).length; attempt++) await delay(10);
  assert.deepEqual(await readdir(join(tempBase, roots[0])), []);
});

test('actual Python worker enforces row limits and timeout failures do not leak paths', async t => {
  const limited = await context(t, { maxRows: 1 });
  const id = await upload(limited.handle, 'a\n1\n2');
  const job = await finish(limited.handle, id);
  assert.equal(job.status, 'error');
  assert.equal(job.error.code, 'LIMIT_EXCEEDED');
  const timed = await context(t, { timeoutMs: 1 });
  const timeoutId = await upload(timed.handle, 'a\n1');
  const timeout = await finish(timed.handle, timeoutId);
  assert.equal(timeout.status, 'error');
  assert.equal(timeout.error.code, 'PROCESSING_TIMEOUT');
  assert.ok(!JSON.stringify(timeout).includes(timed.tempBase));
});

test('capacity limits reject excess work and deletion cancels an active job', async t => {
  const { handle } = await context(t, { maxConcurrent: 1 });
  const id = await upload(handle, 'name,value\n' + 'Example,1\n'.repeat(50_000));
  const response = await handle(fileRequest('a\n1'));
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, 'BUSY');
  assert.equal((await handle(request(`/${id}`, { method: 'DELETE', headers: { Origin: origin } }))).status, 204);
  const next = await upload(handle, 'a\n2');
  assert.equal((await finish(handle, next)).status, 'ready');
});

test('expired datasets cannot be read and service cleanup removes their files', async t => {
  const { handle } = await context(t, { retentionMinutes: 0.05 });
  const id = await upload(handle, 'name,value\nExample,1');
  assert.equal((await finish(handle, id)).status, 'ready');
  await delay(3100);
  const response = await handle(request(`/${id}`));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'DATASET_EXPIRED');
});

test('real HTTP transport accepts uploads above the old 100k limit and bounds multipart bytes', async t => {
  const { handle } = await context(t, { maxFileSize: 250_000 });
  const server = createApiServer(handle, { port: 8000, maxFileSize: 250_000 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/datasets`;
  const form = new FormData();
  form.append('file', new Blob(['description,amount\n' + `${'x'.repeat(200)},5\n`.repeat(700)], { type: 'text/csv' }), 'large.csv');
  const response = await fetch(url, { method: 'POST', headers: { Origin: origin }, body: form });
  const body = await response.json();
  assert.equal(response.status, 202, JSON.stringify(body));
  assert.equal((await finish(handle, body.id)).dataset.rows_count, 700);
  const tooLarge = await fetch(url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'multipart/form-data; boundary=test' }, body: 'x'.repeat(250_000 + MULTIPART_OVERHEAD + 1) });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error.code, 'FILE_TOO_LARGE');
  const chunked = new ReadableStream({ start(controller) {
    for (let index = 0; index < 7; index++) controller.enqueue(new Uint8Array(50_000));
    controller.close();
  } });
  const streamed = await fetch(url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'multipart/form-data; boundary=test' }, body: chunked, duplex: 'half' });
  assert.equal(streamed.status, 413, 'chunked bodies cannot bypass the byte limit');
  const fileLimit = await handle(fileRequest('x'.repeat(250_001)));
  assert.equal(fileLimit.status, 413);
});

test('HTTP rejects extra upload bodies and foreign origins before buffering them', async t => {
  const { handle } = await context(t);
  const server = createApiServer(handle, { maxConcurrentUploads: 1, allowedOrigins: [origin] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/datasets`;
  const arrived = new Promise(resolve => server.once('request', resolve));
  const first = httpRequest(url, { method: 'POST', headers: { Origin: origin, 'Content-Length': '1000', 'Content-Type': 'multipart/form-data; boundary=test' } });
  first.on('error', () => {});
  t.after(() => first.destroy());
  first.write('x');
  await arrived;
  const rejected = await fetch(url, { method: 'POST', headers: { Origin: origin }, body: 'another upload' });
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).error.code, 'BUSY');
  const foreign = await fetch(url, { method: 'POST', headers: { Origin: 'https://foreign.example' }, body: 'ignored' });
  assert.equal(foreign.status, 403);
  first.destroy();
});

test('automatic analysis completes computed dashboard/report without a provider key and supports retry', async t => {
  const { handle } = await context(t, { autoAnalyze: true });
  const id = await upload(handle, 'team,amount,date\nNorth,10,2026-01-01\nSouth,20,2026-01-02\nNorth,30,2026-01-03\nSouth,40,2026-01-04\n');
  const job = await finish(handle, id);
  assert.equal(job.status, 'ready', JSON.stringify(job.error));
  assert.equal(job.stage, 'complete');
  assert.equal(job.analysis.profiles[0].rows_count, 4);
  assert.ok(job.analysis.kpis.length > 0);
  assert.ok(job.analysis.charts.length > 0);
  assert.ok(job.analysis.report.sections.length > 0);
  assert.equal(job.analysis.ai.status, 'unavailable');
  assert.equal(job.analysis.ai.model, 'gemini-3-flash-preview');
  const bad = await handle(request(`/${id}/analyze`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ objective: 'x'.repeat(1001) }) }));
  assert.equal(bad.status, 400);
  const retry = await handle(request(`/${id}/analyze`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ objective: 'ตรวจคุณภาพข้อมูลและการกระจาย' }) }));
  assert.equal(retry.status, 202);
  assert.equal((await finish(handle, id)).analysis.ai.status, 'unavailable');
});

test('upload objective reaches the first AI analysis and rejects oversized text', async t => {
  const seen = [];
  const llm = { name: 'fake', model: 'fake', async generateJson(input) {
    if (input.schema.properties.sheets) return { data: { sheets: [] }, usage: {} };
    if (input.schema.properties.queries) return agentPlan(input);
    if (input.schema.properties.paragraphs) return reportSection(input);
    if (input.schema.properties.sections && !input.schema.properties.summary) return reportOutline(input);
    seen.push(JSON.parse(input.prompt).objective);
    return { data: { summary: '', insights: [], recommendations: [] }, usage: {} };
  } };
  const { handle } = await context(t, { autoAnalyze: true, llm });
  const invalid = await handle(fileRequest('team,amount\nNorth,10\n', 'data.csv', 'text/csv', origin, 'x'.repeat(1001)));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_OBJECTIVE');
  const id = await upload(handle, 'team,amount\nNorth,10\nSouth,20\n', 'data.csv', 'text/csv', 'ตรวจแนวโน้มค่าใช้จ่าย');
  assert.equal((await finish(handle, id)).status, 'ready');
  assert.deepEqual(seen, ['ตรวจแนวโน้มค่าใช้จ่าย']);
});

test('BOQ objective appears in focused dashboard result and printable report', async t => {
  const calls = [];
  const llm = { name: 'fake', model: 'fake', async generateJson(input) {
    if (input.schema.properties.sheets) return { data: { sheets: [] }, usage: {} };
    if (input.schema.properties.paragraphs) return reportSection(input);
    if (input.schema.properties.sections && !input.schema.properties.summary) return reportOutline(input);
    calls.push(input);
    if (input.schema.properties.queries) return agentPlan(input);
    return agentAnswer(input);
  } };
  const { handle } = await context(t, { autoAnalyze: true, llm });
  const bytes = await readFile(new URL('./fixtures/excel/cost_estimate.xlsx', import.meta.url));
  const id = await upload(handle, bytes, 'cost_estimate.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'เน้นมูลค่ารวม');
  const job = await finish(handle, id);
  assert.equal(job.status, 'ready', JSON.stringify(job.error));
  assert.equal(job.document.type, 'estimate');
  assert.equal(job.document.focus.status, 'complete');
  assert.equal(job.document.focus.objective, 'เน้นมูลค่ารวม');
  assert.equal(calls.length, 2, 'the agent plans once and answers once after the layout request');
  // The detail under the answer comes from the report writer; its invented forecast is dropped.
  assert.match(job.document.focus.sections[0].paragraphs[0], /\d/, 'the answer quotes a total Python computed');
  assert.equal(job.document.focus.sections[0].evidence_ids[0], 'Q-001');
  assert.equal(job.document.focus.sections[0].paragraphs.length, 1, 'the invented forecast is dropped');
  const report = await handle(request(`/${id}/boq-report`));
  assert.equal(report.status, 200);
  const html = await report.text();
  assert.match(html, /เน้นมูลค่ารวม/);
  assert.match(html, /วิเคราะห์ตามโจทย์ที่ระบุ/);
  assert.match(html, /หน้า \d+ \/ \d+/);
});

// Fake agent: plan a sum of the first numeric column (grouped by the first text column),
// then answer by quoting the computed statement plus one invented forecast that must be dropped.
function agentPlan(input) {
  const { profiles } = JSON.parse(input.prompt);
  const sheet = profiles[0];
  const measure = sheet.columns.find(column => column.role === 'measure' || column.data_type === 'number');
  const label = sheet.columns.find(column => column.data_type === 'text' && column !== measure);
  return { data: { queries: [{ purpose: 'ยอดรวม', sheet_id: sheet.sheet_id, measure: measure.key, agg: 'sum', group_by: label ? [label.key] : [], filters: [], sort: 'desc' }] }, usage: {} };
}

function agentAnswer(input) {
  const result = JSON.parse(input.prompt).evidence.find(item => /^Q\d*-/.test(item.id));
  return { data: { status: 'complete', title: 'ยอดรวม', summary: '', chart_ids: [result.id],
    sections: [{ title: 'ยอดรวม', paragraphs: [result.statement, 'คาดว่าปีหน้าจะโต 73%'], evidence_ids: [result.id] }] }, usage: {} };
}

// Fake report writer: one section on the first evidence; it quotes the evidence and adds a forecast
// nobody computed, which the number check must drop.
function reportOutline(input) {
  const { evidence, sections_required: count } = JSON.parse(input.prompt);
  const ids = evidence.map(item => item.id);
  return { data: { title: 'รายงานทดสอบ', sections: Array.from({ length: count }, (_, index) => ({ title: `หัวข้อ ${index + 1}`, brief: '', evidence_ids: [ids[index % ids.length]], weight: 2 })) }, usage: {} };
}
function reportSection(input) {
  const { evidence } = JSON.parse(input.prompt);
  return { data: { paragraphs: [evidence[0]?.statement, 'คาดว่าปีหน้าจะโต 73%'].filter(Boolean) }, usage: {} };
}

test('a length in the objective sizes the report; each section is written from its evidence', async t => {
  const outlines = [];
  const llm = { name: 'fake', model: 'fake', async generateJson(input) {
    if (input.schema.properties.sheets) return { data: { sheets: [] }, usage: {} };
    if (input.schema.properties.queries) {
      assert.match(input.system, /up to 22 queries/, 'a 7-page report plans more computations');
      return agentPlan(input);
    }
    if (input.schema.properties.paragraphs) return reportSection(input);
    if (input.schema.properties.sections && !input.schema.properties.summary) { outlines.push(JSON.parse(input.prompt)); return reportOutline(input); }
    return { data: { summary: '', insights: [], recommendations: [] }, usage: {} };
  } };
  const { handle } = await context(t, { autoAnalyze: true, llm });
  const id = await upload(handle, 'team,amount\nNorth,10\nSouth,20\n', 'data.csv', 'text/csv', 'สรุปยอดตามทีม ขอ 7 หน้า');
  const job = await finish(handle, id);
  assert.equal(job.status, 'ready', JSON.stringify(job.error));
  assert.equal(outlines[0].pages, 7);
  assert.equal(outlines[0].sections_required, 9);
  const report = job.analysis.report;
  assert.equal(report.source, 'ai');
  assert.equal(report.pages, 7, 'the PDF is fitted to the pages asked for');
  assert.ok(report.sections.every(section => section.paragraphs.every(text => !text.includes('73%'))), 'numbers nobody computed never reach the report');
  assert.ok(report.sections.every(section => new Set(section.paragraphs).size === section.paragraphs.length), 'the extra pass adds no repeats');
  const table = report.tables['Q-001'];
  assert.deepEqual(table.rows.map(row => row.slice(0, 2)), [['South', 20], ['North', 10]], 'cited results come with their computed table');
});

test('follow-up questions are planned, computed and answered from the results', async t => {
  const llm = { name: 'fake', model: 'fake', async generateJson(input) {
    if (input.schema.properties.sheets) return { data: { sheets: [] }, usage: {} };
    if (input.schema.properties.queries) return agentPlan(input);
    if (input.schema.properties.chart_ids) return agentAnswer(input);
    return { data: { summary: '', insights: [], recommendations: [] }, usage: {} };
  } };
  const { handle } = await context(t, { autoAnalyze: true, llm });
  const id = await upload(handle, 'team,amount\nNorth,10\nSouth,20\n');
  assert.equal((await finish(handle, id)).status, 'ready');
  const ask = question => handle(request(`/${id}/ask`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) }));
  const asked = await ask('ทีมไหนยอดสูงสุด');
  const entry = await asked.json();
  assert.equal(asked.status, 200, JSON.stringify(entry));
  assert.equal(entry.question, 'ทีมไหนยอดสูงสุด');
  assert.equal(entry.sections[0].paragraphs.length, 1, 'a paragraph with a number nobody computed is dropped');
  assert.deepEqual(entry.charts[0].categories, ['South', 'North']);
  assert.deepEqual(entry.charts[0].series[0].values, [20, 10]);
  assert.match(entry.charts[0].id, /^Q2-/, 'follow-up evidence ids never collide with the upload analysis');
  const job = await (await handle(request(`/${id}`))).json();
  assert.equal(job.conversation.length, 1);
  assert.match(job.analysis.report.sections.at(-1).title, /คำถามเพิ่มเติม: ทีมไหนยอดสูงสุด/);
  assert.equal((await ask('   ')).status, 400);
});
