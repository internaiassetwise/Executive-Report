import { readFile } from 'node:fs/promises';
import { configured, interpret } from './gemini.mjs';

export function createHandler(config, fetcher = fetch) {
  return async function handle(request) {
    const path = new URL(request.url).pathname;
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
  };
}
