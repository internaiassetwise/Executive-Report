import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHandler } from './app.mjs';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const port = Number(process.env.BACKEND_PORT || 8000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid BACKEND_PORT');
const handler = createHandler({
  apiKey: process.env.GEMINI_API_KEY || '',
  model: process.env.GEMINI_MODEL || '',
  allowedOrigins: (process.env.FRONTEND_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000').split(',').map(v => v.trim()),
});

const server = createServer(async (incoming, outgoing) => {
  try {
    // Bind to loopback and use a fixed local request origin; never trust the Host header.
    const path = incoming.url || '/';
    if (!path.startsWith('/') || path.startsWith('//')) { outgoing.writeHead(400); outgoing.end(); return; }
    const method = incoming.method || 'GET';
    const chunks = []; let size = 0;
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > 100_000) {
        outgoing.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
        outgoing.end(JSON.stringify({ error: 'ข้อมูลคำขอมีขนาดใหญ่เกินไป' }));
        return;
      }
      chunks.push(chunk);
    }
    const request = new Request(`http://127.0.0.1:${port}${path}`, {
      method, headers: incoming.headers,
      ...(method !== 'GET' && method !== 'HEAD' ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await handler(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({ error: 'Backend request failed' }));
  }
});

server.requestTimeout = 60_000;
server.listen(port, '127.0.0.1', () => console.log(`Backend ready: http://127.0.0.1:${port}`));
server.on('error', error => { console.error(`Backend could not listen (${error.code || 'unknown'}).`); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(() => process.exit(0)); server.closeAllConnections(); });
