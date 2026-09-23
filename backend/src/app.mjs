import { readFile } from 'node:fs/promises';
import { configured, interpret } from './gemini.mjs';
import { writeReport } from './report-writer.mjs';
import { planReport } from './analysis-planner.mjs';
import { createDatasetService } from './datasets.mjs';
import { DEFAULT_DATASET_MODEL } from './dataset-ai.mjs';

export function createHandler(config, fetcher = fetch) {
  let datasets;
  async function handle(request) {
    const path = new URL(request.url).pathname;
    if(path==='/api/plan')return request.method==='POST'?planReport(request,config,fetcher):Response.json({error:'Method not allowed'},{status:405});
    if (path === '/api/report') {
      if(request.method === 'POST') return writeReport(request, config, fetcher);
      return Response.json({error:'Method not allowed'}, {status:405});
    }
    if (path === '/api/datasets' || path.startsWith('/api/datasets/')) {
      datasets ||= createDatasetService({ autoAnalyze: true, apiKey: config.apiKey, model: config.model || DEFAULT_DATASET_MODEL, fetcher, ...config.datasets, allowedOrigins: config.allowedOrigins });
      return datasets.handle(request);
    }
    if (path === '/api/health' && request.method === 'GET') {
      return Response.json({ status: 'ok', service: 'asw-backend' });
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
  handle.close = async () => { await datasets?.close(); };
  return handle;
}
