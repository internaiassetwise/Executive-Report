import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWithAi, buildAiContext, DEFAULT_DATASET_MODEL } from '../src/dataset-ai.mjs';

const dataset = { filename: 'operations.csv', rows_count: 4, columns_count: 2, sheets: [{ id: 's0', name: 'operations' }], raw_rows: ['PRIVATE_RAW_RECORD'] };
const analysis = {
  insights: [{ id: 'EV-001', title: 'ค่าเฉลี่ย', description: 'ค่าเฉลี่ย 12 จากข้อมูล 4 แถว', evidence: { metric: 'mean', value: 12, method: 'Python mean', sheet: 'operations', columns: ['c1'] } }],
  kpis: [{ name: 'จำนวนแถว', value: 4, formatted_value: '4', method: 'COUNT' }],
  profiles: [{ sheet_id: 's0', sheet_name: 'operations', rows_count: 4, duplicate_rows: 0, missing_count: 0, missing_percentage: 0, columns: [{ key: 'c1', name: 'amount', data_type: 'number', unique_count: 4, missing_count: 0, missing_percentage: 0, statistics: { count: 4, mean: 12 } }] }],
  raw_rows: ['PRIVATE_RAW_RECORD'],
};
const valid = { summary: 'พบข้อมูล 4 แถว ค่าเฉลี่ย 12', insights: [{ title: 'ค่าเฉลี่ย 12', description: 'ค่าเฉลี่ยของข้อมูลอยู่ที่ 12', evidence_ids: ['EV-001'] }], recommendations: [{ text: 'ตรวจสอบการกระจายร่วมกับค่าเฉลี่ย', evidence_ids: ['EV-001'] }] };
const response = body => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] });

test('Gemini receives bounded aggregates with the configured fast model and structured output', async () => {
  let calls = 0;
  const result = await analyzeWithAi(dataset, analysis, { apiKey: 'unit-test-key', fetcher: async (url, options) => {
    calls++;
    assert.match(url, /gemini-3-flash-preview:generateContent$/);
    assert.equal(options.headers['x-goog-api-key'], 'unit-test-key');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
    assert.equal(body.generationConfig.responseSchema.type, 'OBJECT');
    assert.ok(!options.body.includes('PRIVATE_RAW_RECORD'));
    assert.ok(!options.body.includes('unit-test-key'));
    return response(valid);
  } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'complete');
  assert.equal(result.model, DEFAULT_DATASET_MODEL);
  assert.deepEqual(result.insights[0].evidence_ids, ['EV-001']);
  const large = { ...analysis, profiles: Array.from({ length: 400 }, () => analysis.profiles[0]) };
  const context = buildAiContext(dataset, large);
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 80_000);
  assert.equal(context.coverage.context_limited, true);
});

test('missing keys, provider failures and ungrounded output leave deterministic analysis available', async () => {
  assert.equal((await analyzeWithAi(dataset, analysis, { fetcher: () => { throw new Error('must not call'); } })).status, 'unavailable');
  // An unsupported statement is dropped on its own; the rest of the paid response is kept.
  for (const [body, field] of [
    [{ ...valid, summary: 'ค่าเฉลี่ย 99999' }, 'summary'],
    [{ ...valid, insights: [{ ...valid.insights[0], description: 'ค่าเฉลี่ย -12' }] }, 'insights'],
    [{ ...valid, insights: [{ ...valid.insights[0], evidence_ids: ['EV-999'] }] }, 'insights'],
    [{ ...valid, recommendations: [{ text: 'ค่าเฉลี่ย 99999', evidence_ids: ['EV-001'] }] }, 'recommendations'],
  ]) {
    const result = await analyzeWithAi(dataset, analysis, { apiKey: 'unit-test-key', fetcher: async () => response(body) });
    assert.equal(result.status, 'complete');
    assert.ok(!JSON.stringify(result).includes('99999') && !JSON.stringify(result).includes('-12'), field);
    assert.deepEqual(result[field], field === 'summary' ? '' : []);
  }
  const nothing = { summary: 'ค่าเฉลี่ย 99999', insights: [{ ...valid.insights[0], evidence_ids: ['EV-999'] }], recommendations: [] };
  assert.equal((await analyzeWithAi(dataset, analysis, { apiKey: 'unit-test-key', fetcher: async () => response(nothing) })).status, 'error');
  // Numbers that label the data (file or column names) are not invented quantities.
  const labelled = await analyzeWithAi({ ...dataset, filename: 'KMIT_R5.xlsx' }, analysis, { apiKey: 'unit-test-key', fetcher: async () => response({ ...valid, summary: 'ไฟล์ KMIT R5 มีข้อมูล 4 แถว' }) });
  assert.equal(labelled.summary, 'ไฟล์ KMIT R5 มีข้อมูล 4 แถว');
  const failed = await analyzeWithAi(dataset, analysis, { apiKey: 'unit-test-key', fetcher: async () => new Response('', { status: 429 }) });
  assert.equal(failed.status, 'error');
  assert.equal(analysis.profiles[0].columns[0].statistics.mean, 12);
});

test('AI grounding permits rounded negative figures while rejecting a reversed sign', async () => {
  const negative = { ...analysis, insights: [{ ...analysis.insights[0], description: 'ผลต่าง -12.34', evidence: { ...analysis.insights[0].evidence, value: -12.34 } }] };
  const output = { summary: 'ตรวจพบผลต่าง', insights: [{ title: 'ผลต่าง', description: 'ผลต่าง -12.3', evidence_ids: ['EV-001'] }], recommendations: [] };
  const accepted = await analyzeWithAi(dataset, negative, { apiKey: 'unit-test-key', fetcher: async () => response(output) });
  assert.equal(accepted.status, 'complete');
  const rejected = await analyzeWithAi(dataset, negative, { apiKey: 'unit-test-key', fetcher: async () => response({ ...output, insights: [{ ...output.insights[0], description: 'ผลต่าง 12.3' }] }) });
  assert.deepEqual(rejected.insights, [], 'a reversed sign is dropped');
});
