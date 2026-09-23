import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeWithAi, DEFAULT_DATASET_MODEL } from './dataset-ai.mjs';
import { renderDashboardHtml } from './dashboard-html.mjs';
import { describeImages } from './image-ai.mjs';
import { planLayouts } from './layout-ai.mjs';
import { describeFilter, formatNumber } from '../../shared/dashboard-charts.mjs';

const MiB = 1024 * 1024;
export const MULTIPART_OVERHEAD = 64 * 1024;
const workerPath = fileURLToPath(new URL('../datasets/worker.py', import.meta.url));
const exportWorkerPath = fileURLToPath(new URL('../datasets/exports.py', import.meta.url));
const boqWorkerPath = fileURLToPath(new URL('../datasets/boq.py', import.meta.url));
const defaults = {
  maxFileSize: 25 * MiB, maxRows: 100_000, maxColumns: 200, maxCells: 2_000_000,
  retentionMinutes: 60, maxConcurrent: 2, maxStored: 20, timeoutMs: 120_000,
  previewTimeoutMs: 30_000, maxPreviews: 2, pythonBin: 'python', tempBase: tmpdir(),
  autoAnalyze: false, model: DEFAULT_DATASET_MODEL, aiTimeoutMs: 45_000, maxExports: 1,
};

function integer(value, fallback, min, max, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${name}`);
  return parsed;
}

export function datasetConfigFromEnv(env = process.env) {
  return {
    maxFileSize: integer(env.DATASET_MAX_FILE_MB, 25, 1, 100, 'DATASET_MAX_FILE_MB') * MiB,
    maxRows: integer(env.DATASET_MAX_ROWS, defaults.maxRows, 1, 1_000_000, 'DATASET_MAX_ROWS'),
    maxColumns: integer(env.DATASET_MAX_COLUMNS, defaults.maxColumns, 1, 1000, 'DATASET_MAX_COLUMNS'),
    maxCells: integer(env.DATASET_MAX_CELLS, defaults.maxCells, 1, 10_000_000, 'DATASET_MAX_CELLS'),
    retentionMinutes: integer(env.DATASET_RETENTION_MINUTES, 60, 1, 1440, 'DATASET_RETENTION_MINUTES'),
    maxConcurrent: integer(env.DATASET_MAX_CONCURRENT, 2, 1, 8, 'DATASET_MAX_CONCURRENT'),
    maxStored: integer(env.DATASET_MAX_STORED, 20, 1, 100, 'DATASET_MAX_STORED'),
    timeoutMs: integer(env.DATASET_TIMEOUT_SECONDS, 120, 5, 600, 'DATASET_TIMEOUT_SECONDS') * 1000,
    aiTimeoutMs: integer(env.GEMINI_TIMEOUT_SECONDS, 45, 5, 120, 'GEMINI_TIMEOUT_SECONDS') * 1000,
    pythonBin: env.PYTHON_BIN || 'python',
    tempBase: env.DATASET_TEMP_DIR || tmpdir(),
  };
}

class DatasetError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (code, message, status) => new DatasetError(code, message, status);
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const errorReply = error => reply({ error: { code: error.code || 'REQUEST_FAILED', message: error instanceof DatasetError ? error.message : 'ไม่สามารถดำเนินการได้ กรุณาลองอีกครั้ง' } }, error.status || 500);

async function removeWithin(parent, target) {
  const child = relative(resolve(parent), resolve(target));
  if (!child || child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(child)) {
    throw new Error('Refusing cleanup outside the temporary dataset directory');
  }
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export function sanitizeFilename(filename) {
  const basename = String(filename).split(/[\\/]/).pop() || 'dataset';
  return basename.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, '_').slice(-180);
}

async function boundedBody(request, limit) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw fail('FILE_TOO_LARGE', 'ไฟล์มีขนาดเกินขีดจำกัดที่กำหนด', 413);
  const reader = request.body?.getReader();
  if (!reader) throw fail('MISSING_FILE', 'กรุณาเลือกไฟล์ CSV หรือ XLSX');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw fail('FILE_TOO_LARGE', 'ไฟล์มีขนาดเกินขีดจำกัดที่กำหนด', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

const mimeTypes = {
  '.csv': new Set(['', 'text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel', 'application/octet-stream']),
  '.xlsx': new Set(['', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream']),
  '.xls': new Set(['', 'application/vnd.ms-excel', 'application/x-msexcel', 'application/x-excel', 'application/octet-stream']),
};

export function createDatasetService(options = {}) {
  const config = { ...defaults, ...options };
  const allowedOrigins = new Set(options.allowedOrigins || []);
  const jobs = new Map();
  const requests = new Set();
  let rootPromise; let closed = false; let closePromise;
  let activeIngests = 0; let pendingUploads = 0; let activePreviews = 0; let activeExports = 0;
  const tempBase = resolve(config.tempBase);
  const getRoot = () => rootPromise ||= mkdir(tempBase, { recursive: true }).then(() => mkdtemp(join(tempBase, 'ai-data-')));
  const limits = { max_rows: config.maxRows, max_columns: config.maxColumns, max_cells: config.maxCells };

  function worker(job, args, onStage, timeoutMs, signal, script = workerPath) {
    if (signal?.aborted) return Promise.reject(fail('CANCELLED', 'ยกเลิกการอ่านข้อมูลแล้ว', 410));
    const child = spawn(config.pythonBin, ['-B', '-u', script, ...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let terminalError; let finalResult; let line = ''; let size = 0;
    const cancel = (error = fail('CANCELLED', 'ยกเลิกการประมวลผลแล้ว', 410)) => { terminalError ||= error; child.kill(); };
    const onAbort = () => cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    const promise = new Promise((resolveResult, rejectResult) => {
      const timeout = setTimeout(() => cancel(fail('PROCESSING_TIMEOUT', 'ใช้เวลาประมวลผลนานเกินไป กรุณาลดขนาดไฟล์แล้วลองอีกครั้ง', 504)), timeoutMs);
      timeout.unref();
      const parse = text => {
        if (!text.trim()) return;
        try {
          const event = JSON.parse(text);
          if (event.error && typeof event.error.code === 'string' && typeof event.error.message === 'string') terminalError = fail(event.error.code, event.error.message);
          if (event.result !== undefined) finalResult = event.result;
          if (event.stage && Number.isFinite(event.progress)) onStage?.(event);
        } catch { cancel(fail('PROCESSING_FAILED', 'ตัวประมวลผลส่งผลลัพธ์ไม่ถูกต้อง กรุณาลองอีกครั้ง', 500)); }
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size > 16 * MiB) { cancel(fail('RESULT_TOO_LARGE', 'ผลลัพธ์มีขนาดใหญ่เกินไป กรุณาลดจำนวนแถวต่อหน้า', 413)); return; }
        line += chunk;
        let end;
        while ((end = line.indexOf('\n')) >= 0) { parse(line.slice(0, end)); line = line.slice(end + 1); }
      });
      // Never log file contents, local paths, or parser tracebacks.
      child.stderr.resume();
      child.on('error', () => { terminalError = fail('PYTHON_UNAVAILABLE', 'ไม่สามารถเริ่มตัวประมวลผล Python ได้ กรุณาตรวจการตั้งค่าเซิร์ฟเวอร์', 503); });
      child.on('close', code => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        parse(line);
        if (terminalError) rejectResult(terminalError);
        else if (code !== 0 || finalResult === undefined) rejectResult(fail('PROCESSING_FAILED', 'อ่านไฟล์ไม่สำเร็จ กรุณาตรวจไฟล์แล้วลองอีกครั้ง', 500));
        else resolveResult(finalResult);
      });
    });
    const task = { cancel, promise };
    job.workers.add(task);
    // Use both branches so the bookkeeping promise cannot reject unhandled.
    promise.then(() => job.workers.delete(task), () => job.workers.delete(task));
    return promise;
  }

  // Specs and profiles can exceed the Windows command-line limit, so the
  // payload travels as a private file inside the job directory.
  async function runDashboard(job, payload, signal, timeoutMs = config.previewTimeoutMs) {
    const path = join(job.directory, `dashboard-${randomBytes(8).toString('hex')}.json`);
    await writeFile(path, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
    try { return await worker(job, ['dashboard', job.database, path], undefined, timeoutMs, signal); }
    finally { await rm(path, { force: true }); }
  }

  async function jsonBody(request, limit) {
    const body = request.body ? await boundedBody(request, limit) : Buffer.alloc(0);
    let input = {};
    try { if (body.length) input = JSON.parse(body.toString('utf8')); } catch { throw fail('INVALID_JSON', 'รูปแบบคำขอไม่ถูกต้อง'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('INVALID_JSON', 'รูปแบบคำขอไม่ถูกต้อง');
    return input;
  }

  function parseFilters(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > 12 || JSON.stringify(value).length > 16_000) throw fail('INVALID_FILTER', 'รูปแบบตัวกรองไม่ถูกต้อง');
    return value;
  }

  // Another sheet is planned by rules in Python; the id must be a known sheet.
  function sheetChoice(input, job) {
    if (input.sheet_id === undefined || input.sheet_id === job.analysis.dashboard.sheet_id) return {};
    if (typeof input.sheet_id !== 'string' || !job.dataset.sheets.some(sheet => sheet.id === input.sheet_id)) throw fail('INVALID_SHEET', 'ไม่พบชีตที่เลือก');
    return { sheet_id: input.sheet_id, filename: job.dataset.filename };
  }

  async function queryDashboard(request, job) {
    if (!job.analysis?.dashboard || job.status === 'processing') throw fail('ANALYSIS_NOT_READY', 'Dashboard ยังไม่พร้อม กรุณารอให้วิเคราะห์เสร็จ', 409);
    const input = await jsonBody(request, 32_768);
    const filters = parseFilters(input.filters);
    if (activePreviews >= config.maxPreviews) throw fail('BUSY', 'กำลังคำนวณ Dashboard กรุณาลองอีกครั้งในอีกสักครู่', 429);
    activePreviews++;
    try { return reply(await runDashboard(job, { spec: job.analysis.dashboard, profiles: job.analysis.profiles, filters, include_options: input.options === true, ...sheetChoice(input, job) }, request.signal)); }
    finally { activePreviews--; }
  }

  async function exportDashboard(request, job) {
    if (!job.analysis?.dashboard || job.status === 'processing') throw fail('ANALYSIS_NOT_READY', 'Dashboard ยังไม่พร้อม กรุณารอให้วิเคราะห์เสร็จ', 409);
    const input = await jsonBody(request, 12 * MiB);
    if (!['html', 'pdf'].includes(input.format)) throw fail('INVALID_EXPORT', 'รองรับการส่งออก Dashboard เป็น HTML และ PDF เท่านั้น');
    const filters = parseFilters(input.filters);
    const images = input.format === 'pdf' ? chartImages(input.images, job.analysis.dashboard) : new Map();
    if (activeExports >= config.maxExports) throw fail('BUSY', 'กำลังสร้างไฟล์ส่งออก กรุณาลองอีกครั้งในอีกสักครู่', 429);
    activeExports++;
    const created = [];
    try {
      const result = await runDashboard(job, { spec: job.analysis.dashboard, profiles: job.analysis.profiles, filters, ...sheetChoice(input, job) }, request.signal);
      const document = dashboardDocument(job, result);
      const base = sanitizeFilename(job.dataset.filename).replace(/\.[^.]+$/, '');
      if (input.format === 'html') return download(Buffer.from(renderDashboardHtml(document), 'utf8'), `${base}-dashboard.html`, 'text/html; charset=utf-8');
      for (const chart of document.charts) {
        const bytes = images.get(chart.id);
        if (!bytes) continue;
        chart.image = join(job.directory, `chart-${randomBytes(8).toString('hex')}.jpg`);
        await writeFile(chart.image, bytes, { mode: 0o600, flag: 'wx' });
        created.push(chart.image);
      }
      const payload = join(job.directory, `pdf-${randomBytes(8).toString('hex')}.json`);
      const output = join(job.directory, `dashboard-${randomBytes(8).toString('hex')}.pdf`);
      created.push(payload, output);
      await writeFile(payload, JSON.stringify(document), { mode: 0o600, flag: 'wx' });
      const written = await worker(job, ['dashboard-pdf', payload, output], undefined, config.timeoutMs, request.signal, exportWorkerPath);
      // Compare file identity, not strings: Python expands Windows short (8.3) path names.
      const info = await lstat(output).catch(() => null);
      if (!written || !info?.isFile() || info.isSymbolicLink() || info.size > 100 * MiB) throw fail('EXPORT_FAILED', 'สร้างไฟล์ PDF ไม่สำเร็จ', 500);
      return download(await readFile(output), `${base}-dashboard.pdf`, 'application/pdf');
    } finally {
      activeExports--;
      await Promise.all(created.map(path => rm(path, { force: true })));
    }
  }

  /** Chart pictures from the browser are only decoration: JPEG, bounded, one per known chart. */
  function chartImages(value, spec) {
    const images = new Map();
    if (value === undefined) return images;
    if (!Array.isArray(value) || value.length > spec.charts.length) throw fail('INVALID_EXPORT', 'รูปกราฟสำหรับ PDF ไม่ถูกต้อง');
    for (const item of value) {
      const match = typeof item?.data === 'string' && /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(item.data);
      if (!match || !spec.charts.some(chart => chart.id === item.id) || images.has(item.id)) throw fail('INVALID_EXPORT', 'รูปกราฟสำหรับ PDF ไม่ถูกต้อง');
      const bytes = Buffer.from(match[1], 'base64');
      if (bytes.length > 3 * MiB || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw fail('INVALID_EXPORT', 'รูปกราฟสำหรับ PDF ไม่ถูกต้อง');
      images.set(item.id, bytes);
    }
    return images;
  }

  /** Everything an exported dashboard shows, with numbers from the Python result only. */
  function dashboardDocument(job, result) {
    const spec = result.spec;
    const profile = job.analysis.profiles.find(item => item.sheet_id === spec.sheet_id);
    const column = key => profile.columns.find(item => item.key === key);
    const values = new Map(result.kpis.map(item => [item.id, item.value]));
    const charts = new Map(result.charts.map(item => [item.id, item]));
    const ai = job.analysis.ai?.status === 'complete' ? job.analysis.ai : null;
    const evidence = new Map(job.analysis.insights.map(item => [item.id, item]));
    const insights = ai?.insights?.length
      ? ai.insights.map(item => ({ title: item.title, description: item.description, evidence: item.evidence_ids.map(id => ({ id, method: evidence.get(id)?.evidence.method || '' })) }))
      : job.analysis.insights.slice(0, 6).map(item => ({ title: item.title, description: item.description, evidence: [{ id: item.id, method: item.evidence.method }] }));
    return {
      title: spec.title, description: spec.description, source: spec.source, filename: job.dataset.filename, sheet: profile.sheet_name,
      generated_at: new Date().toISOString(), rows_total: result.rows_total, rows_matched: result.rows_matched,
      filters: result.filters.map(item => describeFilter(item, column(item.column))),
      kpis: spec.kpis.map(kpi => ({ ...kpi, value: values.get(kpi.id) ?? null, text: formatNumber(values.get(kpi.id), column(kpi.column)?.meaning, kpi.agg) })),
      charts: spec.charts.map(chart => ({ ...chart, x_name: column(chart.x)?.name || '', y_name: chart.y ? column(chart.y)?.name || '' : 'จำนวนแถว', meaning: chart.y ? column(chart.y)?.meaning || null : null, ...charts.get(chart.id) })),
      insights, ai_summary: ai?.summary || '',
    };
  }

  function download(bytes, name, type) {
    const encodedName = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const ascii = type.startsWith('text/html') ? 'dashboard.html' : 'dashboard.pdf';
    return new Response(bytes, { headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodedName}`, 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }

  async function readLayouts(job, input, filename, directory) {
    if (!config.llm) return [];
    const samplePath = join(directory, 'sample.json');
    const layoutPath = join(directory, 'layout.json');
    try {
      job.stage = 'understanding_columns';
      await worker(job, ['sample', input, filename, samplePath, JSON.stringify(limits)], undefined, config.timeoutMs, job.controller.signal);
      const sample = JSON.parse(await readFile(samplePath, 'utf8'));
      // Table positions and the pictures' contents are read in parallel; either may fail alone.
      const [layouts, images] = await Promise.allSettled([
        planLayouts(sample, config.llm, job.controller.signal),
        describeImages(sample.images, config.llm, job.controller.signal),
      ]);
      if (job.controller.signal.aborted) throw job.controller.signal.reason;
      for (const [name, outcome] of [['layout', layouts], ['images', images]]) {
        if (outcome.status === 'rejected') console.warn(JSON.stringify({ event: `${name}_fallback`, reason: outcome.reason?.kind || outcome.reason?.code || 'error' }));
      }
      const plan = { layouts: layouts.value || {}, images: images.value || [] };
      if (!Object.keys(plan.layouts).length && !plan.images.length) return [];
      await writeFile(layoutPath, JSON.stringify(plan), { mode: 0o600 });
      return [layoutPath];
    } catch (error) {
      if (job.controller.signal.aborted) throw error;
      console.warn(JSON.stringify({ event: 'layout_fallback', reason: error?.kind || error?.code || 'error' }));
      return [];
    } finally {
      await rm(samplePath, { force: true });
      await rm(join(directory, 'images'), { recursive: true, force: true });
    }
  }

  async function removeJob(id) {
    const job = jobs.get(id);
    if (!job) return;
    jobs.delete(id);
    job.controller.abort();
    for (const task of job.workers) task.cancel();
    await Promise.allSettled([...job.workers].map(task => task.promise));
    await job.finished;
    if (job.directory && rootPromise) await removeWithin(await rootPromise, job.directory);
  }

  async function sweep() {
    await Promise.allSettled([...jobs].filter(([, job]) => Date.now() >= job.expiresAt).map(([id]) => removeJob(id)));
  }
  const timer = setInterval(() => { void sweep(); }, Math.min(60_000, config.retentionMinutes * 60_000));
  timer.unref();

  function advance(job, stage, progress) {
    if (!jobs.has(job.id)) return;
    job.stage = stage;
    job.progress = Math.max(job.progress, Math.min(99, Math.max(0, progress)));
  }

  function validateAnalysis(analysis, dataset) {
    if (!analysis || typeof analysis.summary !== 'string' || !Array.isArray(analysis.kpis) || !Array.isArray(analysis.profiles) || !Array.isArray(analysis.insights) || !Array.isArray(analysis.charts) || !Array.isArray(analysis.report?.sections)) throw fail('INVALID_ANALYSIS', 'รูปแบบผลวิเคราะห์ไม่ถูกต้อง กรุณาลองวิเคราะห์ใหม่', 500);
    if (analysis.insights.length > 24 || analysis.charts.length > 12) throw fail('INVALID_ANALYSIS', 'ผลวิเคราะห์เกินขีดจำกัดที่กำหนด', 500);
    const ids = new Set();
    for (const insight of analysis.insights) {
      const isGlobal = insight.evidence?.sheet === 'ทุกชีต' || insight.evidence?.sheet === 'all';
      const sheet = isGlobal ? null : dataset.sheets.find(item => item.name === insight.evidence?.sheet);
      if (!/^EV-\d+$/.test(insight.id) || ids.has(insight.id)) throw fail('INVALID_ANALYSIS', 'รหัสหลักฐานไม่ถูกต้อง', 500);
      if (isGlobal) {
        if (!Array.isArray(insight.evidence?.columns)) throw fail('INVALID_ANALYSIS', 'หลักฐานวิเคราะห์อ้างอิงคอลัมน์ไม่ถูกต้อง', 500);
      } else {
        if (!sheet || !Array.isArray(insight.evidence.columns) || insight.evidence.columns.some(key => !sheet.columns.some(column => column.key === key))) throw fail('INVALID_ANALYSIS', 'หลักฐานวิเคราะห์อ้างอิงคอลัมน์ไม่ถูกต้อง', 500);
      }
      ids.add(insight.id);
    }
    for (const chart of analysis.charts) {
      const sheet = dataset.sheets.find(item => item.id === chart.sheet_id);
      if (!['bar', 'line', 'histogram', 'donut', 'scatter'].includes(chart.type) || !sheet || ![chart.x, chart.y].every(key => sheet.columns.some(column => column.key === key)) || !Array.isArray(chart.data) || chart.data.some(point => !Number.isFinite(point.y))) throw fail('INVALID_ANALYSIS', 'กราฟอ้างอิงข้อมูลหรือคอลัมน์ไม่ถูกต้อง', 500);
    }
    return analysis;
  }

  async function analyzeDataset(job, objective = '') {
    advance(job, 'profiling', 35);
    const analysis = validateAnalysis(await worker(job, ['analyze', job.database], event => {
      const stage = ['profiling', 'patterns', 'dashboard', 'report'].includes(event.stage) ? event.stage : 'profiling';
      advance(job, stage, 35 + Math.min(100, Math.max(0, event.progress)) * 0.35);
    }, config.timeoutMs, job.controller.signal), job.dataset);
    advance(job, 'ai', 75);
    // A BOQ comparison has its own fixed report; every other file gets a report written for its content.
    const ai = await analyzeWithAi(job.dataset, analysis, { llm: config.llm, apiKey: config.apiKey, model: config.model || DEFAULT_DATASET_MODEL, objective, timeoutMs: config.aiTimeoutMs, signal: job.controller.signal, fetcher: config.fetcher || fetch, budget: config.aiBudget, report: !job.boq });
    if (!jobs.has(job.id)) return;
    advance(job, 'dashboard', 88);
    const { dashboard: proposal, report: written, ...prose } = ai;
    analysis.ai = prose;
    // The AI plan replaces the rule-based plan only after Python validates it
    // against the real column roles; otherwise the rule-based plan stays.
    if (proposal) {
      try {
        analysis.dashboard = (await runDashboard(job, { spec: proposal, profiles: analysis.profiles }, job.controller.signal)).spec;
        analysis.ai.dashboard = 'accepted';
      } catch (error) {
        if (job.controller.signal.aborted) throw error;
        analysis.ai.dashboard = 'rejected';
        console.warn(JSON.stringify({ event: 'ai_dashboard_rejected', code: error.code || 'UNKNOWN' }));
      }
    }
    advance(job, 'dashboard', 90);
    if (written) {
      // The report the model wrote for this file replaces the computed outline.
      analysis.report = { source: 'ai', title: written.title, sections: written.sections.map((section, index) => ({ id: `ai_${index + 1}`, title: `${index + 1}. ${section.title}`, paragraphs: section.paragraphs, evidence_ids: section.evidence_ids })) };
      analysis.ai.report = 'written';
    } else if (analysis.ai.status === 'complete') {
      const executive = analysis.report.sections.find(section => section.id === 'executive_summary');
      if (executive && analysis.ai.summary) executive.paragraphs = [analysis.ai.summary, ...executive.paragraphs];
      const findings = analysis.report.sections.find(section => section.id === 'key_findings');
      if (findings) {
        findings.paragraphs.push(...analysis.ai.insights.map(item => `${item.title}: ${item.description}`));
        findings.evidence_ids = [...new Set([...findings.evidence_ids, ...analysis.ai.insights.flatMap(item => item.evidence_ids)])];
      }
      const recommendations = analysis.report.sections.find(section => section.id === 'recommendations');
      if (recommendations) {
        recommendations.paragraphs.push(...analysis.ai.recommendations.map(item => item.text));
        recommendations.evidence_ids = [...new Set([...recommendations.evidence_ids, ...analysis.ai.recommendations.flatMap(item => item.evidence_ids)])];
      }
    }
    advance(job, 'report', 95);
    await writeFile(join(job.directory, 'analysis.json'), JSON.stringify(analysis), { mode: 0o600 });
    if (!jobs.has(job.id)) return;
    job.analysis = analysis;
    job.objective = objective;
    job.status = 'ready'; job.stage = 'complete'; job.progress = 100;
    delete job.error;
  }

  function recordFailure(job, error) {
    if (!jobs.has(job.id)) return;
    job.status = 'error';
    job.error = { code: error.code || 'PROCESSING_FAILED', message: error instanceof DatasetError ? error.message : 'ประมวลผลไม่สำเร็จ กรุณาลองอีกครั้ง ข้อมูลที่อ่านสำเร็จแล้วยังคงอยู่' };
  }

  async function upload(request) {
    if (activeIngests >= config.maxConcurrent) throw fail('BUSY', 'มีไฟล์กำลังประมวลผลอยู่ กรุณาลองอีกครั้งในอีกสักครู่', 429);
    if (jobs.size + pendingUploads >= config.maxStored) throw fail('STORAGE_FULL', 'พื้นที่ไฟล์ชั่วคราวเต็ม กรุณาลบชุดข้อมูลเดิมหรือลองอีกครั้งภายหลัง', 429);
    activeIngests++; pendingUploads++;
    let launched = false; let directory;
    try {
      const contentType = request.headers.get('content-type') || '';
      if (!/^multipart\/form-data\s*;/i.test(contentType)) throw fail('INVALID_UPLOAD', 'กรุณาส่งไฟล์ผ่านแบบฟอร์มอัปโหลด', 415);
      const body = await boundedBody(request, config.maxFileSize + MULTIPART_OVERHEAD);
      let form;
      try { form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData(); }
      catch { throw fail('INVALID_UPLOAD', 'รูปแบบคำขออัปโหลดไม่ถูกต้อง'); }
      const entries = [...form.entries()];
      if (entries.length !== 1 || entries[0][0] !== 'file' || typeof entries[0][1] === 'string') throw fail('SINGLE_FILE_REQUIRED', 'กรุณาอัปโหลดทีละหนึ่งไฟล์ในช่อง file');
      const file = entries[0][1];
      const filename = sanitizeFilename(file.name);
      const extension = extname(filename).toLowerCase();
      if (!Object.hasOwn(mimeTypes, extension)) throw fail('UNSUPPORTED_FORMAT', 'รองรับเฉพาะไฟล์ .csv, .xlsx และ .xls', 415);
      if (!mimeTypes[extension].has(file.type.toLowerCase())) throw fail('INVALID_MIME_TYPE', 'ชนิดข้อมูลในไฟล์ไม่ตรงกับนามสกุล CSV/XLSX', 415);
      if (file.size === 0) throw fail('EMPTY_FILE', 'ไฟล์ว่าง กรุณาเลือกไฟล์ที่มีข้อมูล');
      if (file.size > config.maxFileSize) throw fail('FILE_TOO_LARGE', 'ไฟล์มีขนาดเกินขีดจำกัดที่กำหนด', 413);
      const data = Buffer.from(await file.arrayBuffer());
      const zip = data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      const ole = data.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
      // Many systems export HTML or XML with an .xls name; say so instead of a vague parse error.
      if (extension === '.xls' && !ole) throw fail('INVALID_FILE', zip ? 'ไฟล์นี้เป็น Excel รุ่นใหม่ กรุณาเปลี่ยนนามสกุลเป็น .xlsx แล้วอัปโหลดใหม่' : 'ไฟล์ .xls นี้ไม่ใช่รูปแบบ Excel 97-2003 จริง กรุณาเปิดใน Excel แล้วบันทึกเป็น .xlsx ก่อนอัปโหลด');
      if ((extension === '.xlsx' && !zip) || (extension === '.csv' && (zip || ole))) throw fail('INVALID_FILE', 'เนื้อหาไฟล์ไม่ตรงกับนามสกุล หรือไฟล์เสียหาย');
      if (closed) throw fail('UNAVAILABLE', 'เซิร์ฟเวอร์กำลังปิด กรุณาลองอีกครั้ง', 503);
      const root = await getRoot();
      directory = await mkdtemp(join(root, 'dataset-'));
      const input = join(directory, `input${extension}`);
      const database = join(directory, 'dataset.sqlite');
      await writeFile(input, data, { mode: 0o600, flag: 'wx' });
      if (closed) throw fail('UNAVAILABLE', 'เซิร์ฟเวอร์กำลังปิด กรุณาลองอีกครั้ง', 503);
      const id = randomBytes(24).toString('base64url');
      const job = { id, directory, database, controller: new AbortController(), workers: new Set(), status: 'processing', stage: 'validating', progress: 10, expiresAt: Date.now() + config.retentionMinutes * 60_000 };
      jobs.set(id, job);
      job.finished = (async () => {
        try {
          // Where the tables are is read from a sample of the first rows; every row is
          // then loaded by Python. Without a provider the rule-based reader decides.
          const layoutArgs = await readLayouts(job, input, filename, directory);
          const result = await worker(job, ['ingest', input, database, filename, JSON.stringify(limits), ...layoutArgs], event => {
            if (!jobs.has(id)) return;
            if (['reading', 'validating', 'understanding_columns', 'detecting_types', 'preview'].includes(event.stage)) job.stage = event.stage;
            job.progress = Math.max(job.progress, Math.min(config.autoAnalyze ? 35 : 99, Math.max(0, config.autoAnalyze ? 5 + event.progress * 0.3 : event.progress)));
          }, config.timeoutMs, job.controller.signal);
          if (jobs.has(id)) job.dataset = result;
          // A BOQ comparison workbook also gets the benchmark report; it needs the original file.
          if (jobs.has(id)) {
            const html = join(directory, 'boq-report.html');
            const boq = await worker(job, [input, filename, html], undefined, config.timeoutMs, job.controller.signal, boqWorkerPath).catch(error => { if (job.controller.signal.aborted) throw error; return null; });
            if (boq?.mode === 'boq') job.boq = { html, vendors: boq.vendors, benchmark: boq.benchmark, headline: boq.headline };
          }
          await rm(input, { force: true });
          if (!jobs.has(id)) return;
          if (config.autoAnalyze) await analyzeDataset(job);
          else { job.status = 'ready'; job.stage = 'preview'; job.progress = 100; }
        } catch (error) {
          recordFailure(job, error);
          if (!job.dataset) await removeWithin(root, directory);
        } finally { activeIngests--; }
      })();
      // An unexpected filesystem failure must not become an unhandled rejection.
      job.finished.catch(() => {});
      launched = true;
      return reply({ id, status: 'processing', stage: 'validating', progress: 10 }, 202);
    } finally {
      pendingUploads--;
      if (!launched) {
        activeIngests--;
        if (directory && rootPromise) await removeWithin(await rootPromise, directory);
      }
    }
  }

  async function reanalyze(request, job) {
    if (!job.dataset) throw fail('DATASET_NOT_READY', 'ยังอ่านไฟล์ไม่สำเร็จ กรุณาอัปโหลดใหม่', 409);
    if (job.status === 'processing') throw fail('BUSY', 'ชุดข้อมูลนี้กำลังประมวลผลอยู่', 409);
    if (activeIngests >= config.maxConcurrent) throw fail('BUSY', 'มีไฟล์กำลังประมวลผลอยู่ กรุณาลองอีกครั้งในอีกสักครู่', 429);
    const body = request.body ? await boundedBody(request, 8192) : Buffer.alloc(0);
    let input = {};
    try { if (body.length) input = JSON.parse(body.toString('utf8')); } catch { throw fail('INVALID_JSON', 'รูปแบบคำขอวิเคราะห์ไม่ถูกต้อง'); }
    if (!input || typeof input !== 'object' || Array.isArray(input) || (input.objective !== undefined && (typeof input.objective !== 'string' || input.objective.length > 1000))) throw fail('INVALID_OBJECTIVE', 'เป้าหมายการวิเคราะห์ต้องเป็นข้อความไม่เกิน 1,000 ตัวอักษร');
    // Recheck after awaiting body bytes; another request may already have started.
    if (job.status === 'processing' || activeIngests >= config.maxConcurrent || !jobs.has(job.id)) throw fail('BUSY', 'ชุดข้อมูลกำลังประมวลผลหรือไม่พร้อมใช้งาน', 409);
    activeIngests++;
    job.status = 'processing'; job.stage = 'profiling'; job.progress = 35;
    delete job.error;
    job.finished = analyzeDataset(job, input.objective === undefined ? job.objective || '' : input.objective.trim()).catch(error => recordFailure(job, error)).finally(() => { activeIngests--; });
    return reply({ id: job.id, status: job.status, stage: job.stage, progress: job.progress }, 202);
  }

  async function exportDataset(request, url, job) {
    const format = url.searchParams.get('format') || 'pdf';
    if (!['pdf', 'xlsx', 'csv'].includes(format)) throw fail('INVALID_EXPORT', 'รองรับการส่งออก PDF, XLSX และ CSV เท่านั้น');
    if (!job.dataset || (format !== 'csv' && !job.analysis) || job.status === 'processing') throw fail('ANALYSIS_NOT_READY', 'กรุณารอให้วิเคราะห์เสร็จก่อนส่งออกรายงาน', 409);
    const sheet = url.searchParams.get('sheet') || job.dataset.sheets[0].id;
    if (!job.dataset.sheets.some(item => item.id === sheet)) throw fail('INVALID_SHEET', 'ไม่พบชีตที่เลือก');
    if (activeExports >= config.maxExports) throw fail('BUSY', 'กำลังสร้างไฟล์ส่งออก กรุณาลองอีกครั้งในอีกสักครู่', 429);
    activeExports++;
    const output = join(job.directory, `export-${randomBytes(8).toString('hex')}.${format}`);
    const analysisPath = join(job.directory, 'analysis.json');
    try {
      if (!job.analysis) await writeFile(analysisPath, '{}', { mode: 0o600 });
      const result = await worker(job, ['export', job.database, analysisPath, format, output, sheet], undefined, config.timeoutMs, request.signal, exportWorkerPath);
      if (!result || typeof result.path !== 'string' || resolve(result.path) !== resolve(output)) throw fail('EXPORT_FAILED', 'ตำแหน่งไฟล์ส่งออกไม่ถูกต้อง', 500);
      const info = await lstat(output);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 100 * MiB) throw fail('EXPORT_TOO_LARGE', 'ไฟล์ส่งออกใหญ่เกินไป กรุณาลดขนาดข้อมูลหรือเลือก CSV', 413);
      const bytes = await readFile(output);
      const name = `${sanitizeFilename(job.dataset.filename).replace(/\.[^.]+$/, '')}-${format === 'csv' ? 'data' : 'report'}.${format}`;
      const encodedName = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      return new Response(bytes, { headers: { 'Content-Type': { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv; charset=utf-8' }[format], 'Content-Disposition': `attachment; filename="data-${format === 'csv' ? 'export' : 'report'}.${format}"; filename*=UTF-8''${encodedName}`, 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } finally { activeExports--; await rm(output, { force: true }); }
  }

  function parseQuery(url, job) {
    const query = url.searchParams;
    const sheetId = query.get('sheet') || job.dataset.sheets[0]?.id;
    const sheet = job.dataset.sheets.find(item => item.id === sheetId);
    if (!sheet) throw fail('INVALID_SHEET', 'ไม่พบชีตที่เลือก');
    const page = Number(query.get('page') || 1);
    const pageSize = Number(query.get('page_size') || 50);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw fail('INVALID_PAGINATION', 'เลขหน้าหรือจำนวนแถวต่อหน้าไม่ถูกต้อง (1–100 แถว)');
    const sort = query.get('sort') || '';
    const column = query.get('column') || '';
    if ([sort, column].some(key => key && !sheet.columns.some(item => item.key === key))) throw fail('INVALID_COLUMN', 'ไม่พบคอลัมน์ที่เลือก');
    const direction = query.get('direction') || 'asc';
    if (!['asc', 'desc'].includes(direction)) throw fail('INVALID_SORT', 'ลำดับการเรียงข้อมูลไม่ถูกต้อง');
    const search = query.get('search') || '';
    if (search.length > 500) throw fail('INVALID_SEARCH', 'คำค้นหาต้องไม่เกิน 500 ตัวอักษร');
    const rawFilters = query.get('filters');
    if (rawFilters && rawFilters.length > 16_000) throw fail('INVALID_FILTER', 'ตัวกรองยาวเกินไป');
    let filters = [];
    try { filters = parseFilters(rawFilters ? JSON.parse(rawFilters) : []); } catch (error) { throw error instanceof DatasetError ? error : fail('INVALID_FILTER', 'รูปแบบตัวกรองไม่ถูกต้อง'); }
    // Pass column roles for date/number filters; the worker validates keys against the sheet.
    const profile = job.analysis?.profiles.find(item => item.sheet_id === sheet.id);
    const columns = Object.fromEntries(filters.map(item => profile?.columns.find(entry => entry.key === item?.column)).filter(Boolean).map(entry => [entry.key, { role: entry.role, ...(entry.time_format ? { time_format: entry.time_format } : {}) }]));
    return { sheet: sheet.id, page, page_size: pageSize, sort, column, direction, search, ...(filters.length ? { filters, columns } : {}) };
  }

  async function route(request) {
    try {
      if (closed) throw fail('UNAVAILABLE', 'เซิร์ฟเวอร์กำลังปิด กรุณาลองอีกครั้ง', 503);
      const url = new URL(request.url);
      const origin = request.headers.get('origin');
      if ((origin !== null || !['GET', 'HEAD'].includes(request.method)) && !allowedOrigins.has(origin)) throw fail('ORIGIN_NOT_ALLOWED', 'Origin not allowed', 403);
      if (url.pathname === '/api/datasets/config' && request.method === 'GET') {
        return reply({ max_file_size: config.maxFileSize, accepted_extensions: ['.csv', '.xlsx', '.xls'], ...limits, retention_minutes: config.retentionMinutes, auto_analyze: config.autoAnalyze, ai: { configured: Boolean(config.llm || config.apiKey), model: config.llm?.model || config.model || DEFAULT_DATASET_MODEL } });
      }
      if (url.pathname === '/api/datasets') {
        if (request.method === 'POST') { await sweep(); return await upload(request); }
        throw fail('METHOD_NOT_ALLOWED', 'Method not allowed', 405);
      }
      const match = /^\/api\/datasets\/([A-Za-z0-9_-]{32})(\/(?:rows|analyze|export|dashboard|export-dashboard|boq-report))?$/.exec(url.pathname);
      if (!match) throw fail('NOT_FOUND', 'ไม่พบชุดข้อมูล', 404);
      const id = match[1];
      const job = jobs.get(id);
      if (job && Date.now() >= job.expiresAt) await removeJob(id);
      if (!job || !jobs.has(id)) throw fail('DATASET_EXPIRED', 'ไม่พบชุดข้อมูล หรือไฟล์ชั่วคราวหมดอายุแล้ว กรุณาอัปโหลดใหม่', 404);
      if (!match[2] && request.method === 'DELETE') { await removeJob(id); return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }); }
      if (match[2] === '/analyze' && request.method === 'POST') return await reanalyze(request, job);
      if (match[2] === '/dashboard' && request.method === 'POST') return await queryDashboard(request, job);
      if (match[2] === '/export-dashboard' && request.method === 'POST') return await exportDashboard(request, job);
      if (request.method !== 'GET') throw fail('METHOD_NOT_ALLOWED', 'Method not allowed', 405);
      if (!match[2]) return reply({ id, status: job.status, stage: job.stage, progress: job.progress, ...(job.dataset ? { dataset: job.dataset } : {}), ...(job.analysis ? { analysis: job.analysis } : {}), ...(job.boq ? { boq: { vendors: job.boq.vendors, benchmark: job.boq.benchmark, headline: job.boq.headline } } : {}), ...(job.error ? { error: job.error } : {}) });
      if (match[2] === '/boq-report') {
        if (!job.boq) throw fail('NOT_FOUND', 'ไฟล์นี้ไม่มีรายงานเปรียบเทียบ BOQ', 404);
        // Engine-rendered HTML shown in a sandboxed frame: no scripts, no remote resources.
        return new Response(await readFile(job.boq.html), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:", 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      if (match[2] === '/export') return await exportDataset(request, url, job);
      if (match[2] === '/analyze') throw fail('METHOD_NOT_ALLOWED', 'Method not allowed', 405);
      if (!job.dataset) throw fail('DATASET_NOT_READY', job.status === 'error' ? 'อ่านไฟล์ไม่สำเร็จ กรุณาอัปโหลดใหม่' : 'กำลังอ่านไฟล์ กรุณารอสักครู่', 409);
      const query = parseQuery(url, job);
      if (activePreviews >= config.maxPreviews) throw fail('BUSY', 'กำลังอ่านข้อมูล กรุณาลองอีกครั้งในอีกสักครู่', 429);
      activePreviews++;
      try { return reply(await worker(job, ['preview', job.database, JSON.stringify(query)], undefined, config.previewTimeoutMs, request.signal)); }
      finally { activePreviews--; }
    } catch (error) { return errorReply(error); }
  }

  function handle(request) {
    const pending = route(request);
    requests.add(pending);
    pending.then(() => requests.delete(pending), () => requests.delete(pending));
    return pending;
  }

  function close() {
    return closePromise ||= (async () => {
      closed = true; clearInterval(timer);
      for (const job of jobs.values()) { job.controller.abort(); for (const task of job.workers) task.cancel(); }
      await Promise.allSettled([...requests]);
      await Promise.allSettled([...jobs.keys()].map(removeJob));
      if (rootPromise) await removeWithin(tempBase, await rootPromise);
    })();
  }

  return { handle, close };
}
