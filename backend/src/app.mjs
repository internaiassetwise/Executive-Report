import { readFile } from 'node:fs/promises';
import { configured, interpret } from './gemini.mjs';

export function createHandler(config, fetcher = fetch) {
  return async function handle(request) {
    const path = new URL(request.url).pathname;
    if (path === '/api/health' && request.method === 'GET') {
      return Response.json({ status: 'ok', service: 'asw-backend' });
    }
    if (path === '/api/analysis-engine' && request.method === 'GET') {
      const source = await readFile(new URL('../analysis/analysis_engine.py', import.meta.url), 'utf8');
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
