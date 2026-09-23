import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from './app.mjs';
import { datasetConfigFromEnv, MULTIPART_OVERHEAD } from './datasets.mjs';
import { DEFAULT_DATASET_MODEL } from './dataset-ai.mjs';

export function createApiServer(handler, { port = 8000, maxFileSize = 25 * 1024 * 1024, maxConcurrentUploads = 2, allowedOrigins } = {}) {
  let activeUploads = 0;
  const server = createServer(async (incoming, outgoing) => {
    let reserved = false;
    const controller = new AbortController();
    incoming.once('aborted', () => controller.abort());
    outgoing.once('close', () => { if (!outgoing.writableEnded) controller.abort(); });
    try {
      // Use a fixed local request origin for routing; never trust the Host header.
      const path = incoming.url || '/';
      if (!path.startsWith('/') || path.startsWith('//')) { outgoing.writeHead(400); outgoing.end(); return; }
      const method = incoming.method || 'GET';
      const datasetUpload = method === 'POST' && path.split('?')[0] === '/api/datasets';
      const rejectBody = (status, error) => {
        // Drain without buffering so a useful error reaches clients still uploading.
        // Destroying a socket with unread bytes instead produces ECONNRESET.
        incoming.resume();
        outgoing.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        outgoing.end(JSON.stringify({ error }));
      };
      if (datasetUpload) {
        if (allowedOrigins && !allowedOrigins.includes(incoming.headers.origin)) {
          rejectBody(403, { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin not allowed' }); return;
        }
        if (activeUploads >= maxConcurrentUploads) {
          rejectBody(429, { code: 'BUSY', message: 'มีไฟล์กำลังอัปโหลดอยู่ กรุณาลองอีกครั้งในอีกสักครู่' }); return;
        }
        activeUploads++; reserved = true;
      }
      const bodyLimit = datasetUpload ? maxFileSize + MULTIPART_OVERHEAD : 100_000;
      const oversized = () => rejectBody(413, datasetUpload
        ? { code: 'FILE_TOO_LARGE', message: 'ไฟล์มีขนาดเกินขีดจำกัดที่กำหนด' }
        : 'ข้อมูลคำขอมีขนาดใหญ่เกินไป');
      const declaredLength = incoming.headers['content-length'];
      if (declaredLength && Number(declaredLength) > bodyLimit) { oversized(); return; }
      const chunks = []; let size = 0;
      for await (const chunk of incoming.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > bodyLimit) { oversized(); return; }
        chunks.push(chunk);
      }
      const request = new Request(`http://127.0.0.1:${port}${path}`, {
        method, headers: incoming.headers, signal: controller.signal,
        ...(method !== 'GET' && method !== 'HEAD' ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await handler(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'Backend request failed' }));
    } finally { if (reserved) activeUploads--; }
  });
  server.requestTimeout = 110_000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envFile = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const port = Number(process.env.PORT || process.env.BACKEND_PORT || 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const datasets = datasetConfigFromEnv();
  const allowedOrigins = (process.env.FRONTEND_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000').split(',').map(v => v.trim());
  const handler = createHandler({ apiKey: process.env.GEMINI_API_KEY || '', model: process.env.GEMINI_MODEL || DEFAULT_DATASET_MODEL, allowedOrigins, datasets });
  const server = createApiServer(handler, { port, maxFileSize: datasets.maxFileSize, maxConcurrentUploads: datasets.maxConcurrent, allowedOrigins });
  server.listen(port, '0.0.0.0', () => console.log(`Backend ready on 0.0.0.0:${port}`));
  server.on('error', error => { console.error(`Backend could not listen (${error.code || 'unknown'}).`); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    server.close(async () => { await handler.close(); process.exit(0); });
    server.closeAllConnections();
  });
}
