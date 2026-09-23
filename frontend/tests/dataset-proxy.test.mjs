import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { datasetProxy } from '../lib/dataset-proxy.ts';
import { createHandler } from '../../backend/src/app.mjs';
import { createApiServer } from '../../backend/src/server.mjs';

const origin = 'http://localhost:3000';
const pythonBin = process.env.PYTHON_BIN || 'python';
const frontendRequest = (path, options = {}) => new Request(`${origin}/api/datasets${path}`, options);

test('production proxy preserves binary multipart uploads, query parameters, status and deletion', { timeout: 20_000 }, async t => {
  const temporaryParent = fileURLToPath(new URL('../../tmp/', import.meta.url));
  await mkdir(temporaryParent, { recursive: true });
  const tempBase = await mkdtemp(join(temporaryParent, 'dataset-proxy-test-'));
  const handle = createHandler({ allowedOrigins: [origin], datasets: { pythonBin, tempBase } });
  const forwardedPaths = [];
  const server = createApiServer(request => {
    const url = new URL(request.url);
    forwardedPaths.push(url.pathname + url.search);
    return handle(request);
  }, { allowedOrigins: [origin] });
  const previousBackend = process.env.BACKEND_URL;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await handle.close();
    if (previousBackend === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = previousBackend;
    assert.deepEqual(await readdir(tempBase), [], 'proxy test leaves no temporary datasets');
    await rmdir(tempBase);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.BACKEND_URL = `http://127.0.0.1:${server.address().port}`;

  const workbook = execFileSync(pythonBin, ['-c', [
    'import io,sys,openpyxl',
    'book=openpyxl.Workbook()',
    'sheet=book.active;sheet.title="Other";sheet.append(["name"]);sheet.append(["unused"])',
    'sheet=book.create_sheet("Regions");sheet.append(["team","amount"])',
    'sheet.append(["North & East",2]);sheet.append(["North & East",10]);sheet.append(["North & East",7]);sheet.append(["South",99])',
    'buffer=io.BytesIO();book.save(buffer);sys.stdout.buffer.write(buffer.getvalue())',
  ].join('\n')], { windowsHide: true, timeout: 5000 });
  assert.equal(workbook.subarray(0, 2).toString(), 'PK');
  const form = new FormData();
  form.append('file', new Blob([workbook], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'ข้อมูล.xlsx');
  const response = await datasetProxy(frontendRequest('', { method: 'POST', headers: { Origin: origin }, body: form }));
  const uploaded = await response.json();
  assert.equal(response.status, 202, JSON.stringify(uploaded));
  assert.equal(uploaded.status, 'processing');
  assert.match(uploaded.id, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  let ready;
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await datasetProxy(frontendRequest(`/${uploaded.id}`));
    assert.equal(status.status, 200);
    ready = await status.json();
    if (ready.status !== 'processing') break;
    await delay(25);
  }
  assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
  assert.equal(ready.dataset.filename, 'ข้อมูล.xlsx');
  assert.equal(ready.dataset.sheets.length, 2);
  assert.equal(ready.dataset.rows_count, 5);

  const query = '?sheet=s1&page=2&page_size=1&search=North+%26+East&sort=c1&direction=desc&column=c0';
  const preview = await datasetProxy(frontendRequest(`/${uploaded.id}/rows${query}`));
  assert.equal(preview.status, 200);
  assert.equal(forwardedPaths.at(-1), `/api/datasets/${uploaded.id}/rows${query}`, 'encoded query string is forwarded exactly');
  const page = await preview.json();
  assert.equal(page.total_rows, 3);
  assert.equal(page.page, 2);
  assert.equal(page.page_size, 1);
  assert.deepEqual(page.rows.map(row => row.values), [{ c0: 'North & East', c1: 7 }]);

  const removed = await datasetProxy(frontendRequest(`/${uploaded.id}`, { method: 'DELETE', headers: { Origin: origin } }));
  assert.equal(removed.status, 204);
  assert.equal(await removed.text(), '');
  assert.equal((await datasetProxy(frontendRequest(`/${uploaded.id}`))).status, 404);
});

test('production proxy rejects wrong write origins before contacting the backend', async () => {
  for (const method of ['POST', 'DELETE']) {
    const response = await datasetProxy(frontendRequest('', { method, headers: { Origin: 'https://foreign.example' } }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Origin not allowed' });
  }
});

test('production proxy returns a useful 503 when the backend is unavailable', { timeout: 5000 }, async t => {
  const previousBackend = process.env.BACKEND_URL;
  t.after(() => {
    if (previousBackend === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = previousBackend;
  });
  // Reserve an ephemeral port, then close it to exercise a real connection failure.
  const server = createApiServer(() => Response.json({ unexpected: true }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  process.env.BACKEND_URL = `http://127.0.0.1:${port}`;
  const response = await datasetProxy(frontendRequest('/config'));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(typeof body.error, 'string');
  assert.ok(body.error.includes('ลองอีกครั้ง'));
  assert.ok(!body.error.includes(process.env.BACKEND_URL));
});
