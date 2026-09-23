import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/app.mjs';
import { createAccessGate } from '../src/access.mjs';
import { createAiBudget } from '../src/ai-budget.mjs';
import { analyzeWithAi } from '../src/dataset-ai.mjs';

const origin = 'http://localhost:3000';
const base = { apiKey: 'unit-test-key', model: 'test-model', allowedOrigins: [origin] };
const login = password => new Request('http://localhost:8000/api/access', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
const withCookie = (path, cookie) => new Request(`http://localhost:8000${path}`, { headers: cookie ? { cookie } : {} });

test('retired multi-request AI endpoints are off by default', async () => {
  const handle = createHandler(base, () => { throw new Error('must not call provider'); });
  for (const path of ['/api/plan', '/api/report', '/api/interpret']) {
    const response = await handle(new Request(`http://localhost:8000${path}`, { method: 'POST', headers: { Origin: origin }, body: '{}' }));
    assert.equal(response.status, 410, path);
  }
});

test('development without a password leaves the gate open', async () => {
  const handle = createHandler(base);
  assert.deepEqual(await (await handle(withCookie('/api/access'))).json(), { required: false, authenticated: true });
});

test('production without a password refuses dataset requests', async () => {
  const handle = createHandler({ ...base, access: createAccessGate({ production: true }) });
  assert.equal((await handle(withCookie('/api/datasets/config'))).status, 401);
  assert.equal((await handle(login('anything'))).status, 503);
});

test('ACCESS_OPEN opens production without a password, even when one is set', async () => {
  for (const password of ['', 'secret']) {
    const handle = createHandler({ ...base, access: createAccessGate({ password, production: true, open: true }) });
    assert.deepEqual(await (await handle(withCookie('/api/access'))).json(), { required: false, authenticated: true });
    assert.equal((await handle(withCookie('/api/datasets/config'))).status, 200);
  }
});

test('a correct password issues a signed cookie that unlocks the API until it expires', async () => {
  let clock = 1_000_000;
  const access = createAccessGate({ password: 'correct horse', ttlHours: 1, production: true, now: () => clock });
  const handle = createHandler({ ...base, access });
  assert.equal((await handle(withCookie('/api/datasets/config'))).status, 401);
  assert.equal((await handle(login('wrong'))).status, 401);

  const ok = await handle(login('correct horse'));
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly; SameSite=Strict; Max-Age=3600; Secure/);
  const cookie = setCookie.split(';')[0];
  assert.deepEqual(await (await handle(withCookie('/api/access', cookie))).json(), { required: true, authenticated: true });

  const [name, value] = cookie.split('=');
  const tampered = `${name}=${Number(value.split('.')[0]) + 1}.${value.split('.')[1]}`;
  assert.equal(access.allowed(withCookie('/', tampered)), false);
  assert.equal(createAccessGate({ password: 'rotated', production: true, now: () => clock }).allowed(withCookie('/', cookie)), false);

  clock += 3600 * 1000 + 1;
  assert.equal(access.allowed(withCookie('/', cookie)), false);
});

test('repeated wrong passwords are throttled', async () => {
  const handle = createHandler({ ...base, access: createAccessGate({ password: 'secret' }) });
  for (let i = 0; i < 20; i++) assert.equal((await handle(login('guess' + i))).status, 401);
  assert.equal((await handle(login('secret'))).status, 429);
});

test('login requires an allowed origin', async () => {
  const handle = createHandler({ ...base, access: createAccessGate({ password: 'secret' }) });
  const response = await handle(new Request('http://localhost:8000/api/access', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: JSON.stringify({ password: 'secret' }) }));
  assert.equal(response.status, 403);
});

test('the daily AI budget stops provider calls and logs token counts only', async () => {
  const lines = [];
  const budget = createAiBudget({ dailyLimit: 1, log: line => lines.push(JSON.parse(line)) });
  const dataset = { filename: 'd.csv', rows_count: 1, columns_count: 1, sheets: [{ id: 's0', name: 'd' }] };
  const analysis = { insights: [], kpis: [], profiles: [] };
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 17 }, candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'ไม่มีหลักฐานเพียงพอ', insights: [], recommendations: [] }) }] } }] }); };
  await analyzeWithAi(dataset, analysis, { apiKey: 'k', fetcher, budget });
  const second = await analyzeWithAi(dataset, analysis, { apiKey: 'k', fetcher, budget });
  assert.equal(calls, 1);
  assert.equal(second.status, 'unavailable');
  assert.deepEqual(lines, [{ event: 'ai_usage', model: 'gemini-3-flash-preview', prompt_tokens: 10, output_tokens: 5, thinking_tokens: 2, total_tokens: 17, requests_today: 1, daily_limit: 1 }]);
});
