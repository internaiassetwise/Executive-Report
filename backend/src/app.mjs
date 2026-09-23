import { readFile } from 'node:fs/promises';
import { configured, interpret } from './gemini.mjs';
import { writeReport } from './report-writer.mjs';
import { planReport } from './analysis-planner.mjs';
import { createDatasetService } from './datasets.mjs';
import { DEFAULT_DATASET_MODEL } from './dataset-ai.mjs';
import { createAccessGate } from './access.mjs';
import { createAiBudget } from './ai-budget.mjs';
import { createLlm } from './llm/index.mjs';

// Endpoints of the retired report UI. They issue many uncapped provider calls
// per report, so they stay off unless LEGACY_AI_ENDPOINTS explicitly enables them.
const legacyPaths = new Set(['/api/plan', '/api/report', '/api/interpret', '/api/analysis-engine', '/api/boq-engine', '/api/boq-report']);

export function createHandler(config, fetcher = fetch) {
  let datasets;
  const gate = config.access || createAccessGate();
  const aiBudget = config.aiBudget || createAiBudget({ dailyLimit: config.aiDailyLimit ?? 200 });
  // Every dataset AI call goes through one provider-neutral client with the daily budget.
  const llm = config.llm !== undefined ? config.llm : createLlm({ provider: config.llmProvider || 'gemini', apiKey: config.apiKey, model: config.model || DEFAULT_DATASET_MODEL, baseUrl: config.llmBaseUrl, fetcher, budget: aiBudget, timeoutMs: config.datasets?.aiTimeoutMs });
  async function handle(request) {
    const path = new URL(request.url).pathname;
    if (path === '/api/health' && request.method === 'GET') {
      return Response.json({ status: 'ok', service: 'asw-backend' });
    }
    if (path === '/api/access') {
      if (request.method !== 'GET' && !config.allowedOrigins.includes(request.headers.get('origin'))) return Response.json({ error: 'Origin not allowed' }, { status: 403 });
      return gate.handle(request);
    }
    if (legacyPaths.has(path) && !config.legacyAi) return Response.json({ error: 'ปิดใช้งานแล้ว' }, { status: 410 });
    if (!gate.allowed(request)) return gate.denied();
    if(path==='/api/plan')return request.method==='POST'?planReport(request,config,fetcher):Response.json({error:'Method not allowed'},{status:405});
    if (path === '/api/report') {
      if(request.method === 'POST') return writeReport(request, config, fetcher);
      return Response.json({error:'Method not allowed'}, {status:405});
    }
    if (path === '/api/datasets' || path.startsWith('/api/datasets/')) {
      datasets ||= createDatasetService({ autoAnalyze: true, llm, apiKey: config.apiKey, model: config.model || DEFAULT_DATASET_MODEL, fetcher, aiBudget, ...config.datasets, allowedOrigins: config.allowedOrigins });
      return datasets.handle(request);
    }
    // The browser runtime executes these three modules in Pyodide; the files
    // themselves are the single source of truth for every calculation.
    const sources = { '/api/analysis-engine': 'analysis_engine.py', '/api/boq-engine': 'boq_engine.py', '/api/boq-report': 'boq_report.py' };
    if (sources[path] && request.method === 'GET') {
      const source = await readFile(new URL(`../analysis/${sources[path]}`, import.meta.url), 'utf8');
      return new Response(source, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (path === '/api/interpret') {
      if (request.method === 'GET') return Response.json({ configured: configured(config) }, { headers: { 'Cache-Control': 'no-store' } });
      if (request.method === 'POST') return interpret(request, config, fetcher);
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  }
  handle.allowed = request => gate.allowed(request);
  handle.close = async () => { await datasets?.close(); };
  return handle;
}
