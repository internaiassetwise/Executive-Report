import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeImages, mergePages } from '../src/image-ai.mjs';

const note = (id, columns, rows) => ({ id, sheet: id, cell: 'A1', kind: 'table', description: 'ตาราง', text: '', table: { columns, rows } });

test('pages of one scanned table become one table', () => {
  const merged = mergePages([
    note('p1', ['รายการ', 'จำนวน', 'ราคา'], [['ปูน', '10', '1,200'], ['ทราย', '5', '800']]),
    note('p2', ['รายการ', 'จำนวน', 'ราคา'], [['หิน', '3', '600']]),
    note('p3', ['เหล็ก', '8', '4,500'], [['สี', '2', '900']]),
    note('p4', ['ผู้อนุมัติ', 'วันที่'], [['สมชาย', '1 ก.ย.']]),
  ]);
  assert.deepEqual(merged[0].table.rows.map(row => row[0]), ['ปูน', 'ทราย', 'หิน', 'เหล็ก', 'สี'], 'repeated header dropped; a header-less page keeps its first line');
  assert.equal(merged[1].table, undefined);
  assert.equal(merged[2].table, undefined);
  assert.deepEqual(merged[3].table.columns, ['ผู้อนุมัติ', 'วันที่'], 'a different table starts again');
});

test('a picture of a table is read on its own, with a longer limit and one retry', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'image-ai-test-'));
  const images = [];
  for (const id of ['img1', 'img2']) {
    const path = join(folder, `${id}.png`);
    await writeFile(path, Buffer.from('fake'));
    images.push({ id, sheet: 'Sheet1', cell: id === 'img1' ? 'A1' : 'H1', mime_type: 'image/png', path });
  }
  const calls = [];
  const llm = { async generateJson(request) {
    const ids = JSON.parse(request.prompt).images.map(image => image.id);
    calls.push({ ids, timeoutMs: request.timeoutMs });
    // The quick pass sees both pictures but has no room for the table's rows.
    if (ids.length > 1) return { data: { images: [
      { id: 'img1', kind: 'table', description: 'ตารางราคา', text: '', table: { columns: [], rows: [] } },
      { id: 'img2', kind: 'logo', description: 'โลโก้', text: '', table: { columns: [], rows: [] } },
    ] } };
    if (calls.filter(call => call.ids.length === 1).length === 1) throw Object.assign(new Error('slow'), { kind: 'timeout' });
    return { data: { images: [{ id: 'img1', kind: 'table', description: 'ตารางราคา', text: '', table: { columns: ['รายการ', 'ราคา'], rows: [['ปูน', '1,200']] } }] } };
  } };
  const notes = await describeImages(images, llm);
  assert.deepEqual(calls.map(call => call.ids.length), [2, 1, 1], 'quick pass, then the table picture alone, retried once');
  assert.equal(calls[1].timeoutMs, 180_000);
  assert.deepEqual(notes.find(item => item.id === 'img1').table.rows, [['ปูน', '1,200']]);
  assert.equal(notes.find(item => item.id === 'img2').kind, 'logo');
});
