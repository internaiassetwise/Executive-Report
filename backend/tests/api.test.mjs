import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHandler } from '../src/app.mjs';

const config = { apiKey: 'test-only-key', model: 'test-model', allowedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'] };
const payload = { objective: 'ตรวจแนวโน้ม', evidence: [{ evidence_id: 'EV-001', finding: 'ค่าเฉลี่ย 12 จากข้อมูล 20 แถว', method: 'Python mean' }] };
const request = (body, origin = 'http://localhost:3000') => new Request('http://127.0.0.1:8000/api/interpret', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const result = insights => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ insights }) }] } }] });
const insight = { interpretation: 'ควรพิจารณาการกระจายร่วมกับค่าเฉลี่ย', recommendation: 'ตรวจข้อมูลกับเจ้าของข้อมูล', evidence_ids: ['EV-001'] };

test('health and configuration never expose provider credentials', async () => {
  const handle = createHandler(config);
  const health = await handle(new Request('http://localhost:8000/api/health'));
  assert.equal((await health.json()).status, 'ok');
  const status = await handle(new Request('http://localhost:8000/api/interpret'));
  assert.deepEqual(await status.json(), { configured: true });
});

test('unconfigured interpretation does not make a provider call', async () => {
  const handle = createHandler({ ...config, apiKey: '' }, () => { throw new Error('Must not call'); });
  assert.equal((await handle(request(payload))).status, 503);
});

test('frontend origin is accepted even when backend has a different port', async () => {
  let calls = 0;
  const handle = createHandler(config, async (url, options) => {
    calls++;
    assert.match(url, /test-model:generateContent$/);
    assert.equal(options.headers['x-goog-api-key'], 'test-only-key');
    const body = JSON.parse(options.body);
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), payload);
    return result([insight]);
  });
  const response = await handle(request(payload));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { insights: [insight] });
  assert.equal(calls, 1);
});

test('foreign origin is rejected before provider use', async () => {
  const handle = createHandler(config, () => { throw new Error('Must not call'); });
  assert.equal((await handle(request(payload, 'https://unrelated.example'))).status, 403);
});

test('invalid and oversized input is rejected', async () => {
  const handle = createHandler(config, () => { throw new Error('Must not call'); });
  assert.equal((await handle(request('{bad'))).status, 400);
  assert.equal((await handle(request('null'))).status, 400);
  assert.equal((await handle(request({ objective: '', evidence: [null] }))).status, 400);
  assert.equal((await handle(request('x'.repeat(100_001)))).status, 413);
});

test('invented evidence IDs and numerical statements remain rejected', async () => {
  for (const invalid of [
    { ...insight, evidence_ids: ['EV-999'] },
    { ...insight, interpretation: 'ค่าเฉลี่ย 99' },
    { ...insight, interpretation: 'จำนวน ๙' },
  ]) {
    const handle = createHandler(config, async () => result([invalid]));
    assert.equal((await handle(request(payload))).status, 502);
  }
});

test('provider failure is handled without leaking request or key', async () => {
  const handle = createHandler(config, async () => { throw new Error('test-only-key'); });
  const response = await handle(request(payload));
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('test-only-key'));
});

test('analysis endpoint serves the one canonical Python source', async () => {
  const handle = createHandler(config);
  const response = await handle(new Request('http://localhost:8000/api/analysis-engine'));
  const source = await readFile(new URL('../analysis/analysis_engine.py', import.meta.url), 'utf8');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), source);
});

test('backend does not serve env files or arbitrary paths', async () => {
  const handle = createHandler(config);
  for (const path of ['/.env', '/api/.env', '/analysis/analysis_engine.py']) {
    assert.equal((await handle(new Request('http://localhost:8000' + path))).status, 404);
  }
});
