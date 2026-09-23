const backend = () => (process.env.BACKEND_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');

/** Preserve binary multipart bodies; the backend enforces all upload limits. */
export async function datasetProxy(request: Request) {
  const url = new URL(request.url);
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) return Response.json({ error: 'Method not allowed' }, { status: 405 });
  if (request.method !== 'GET' && request.headers.get('origin') !== url.origin) {
    return Response.json({ error: 'Origin not allowed' }, { status: 403 });
  }
  try {
    const headers = new Headers();
    for (const name of ['content-type', 'origin']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const options: RequestInit & { duplex?: string } = {
      method: request.method, headers, redirect: 'error', signal: AbortSignal.timeout(125_000),
    };
    if (request.method === 'POST') { options.body = request.body; options.duplex = 'half'; }
    const response = await fetch(backend() + url.pathname + url.search, options);
    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json; charset=utf-8',
        ...(response.headers.has('Content-Disposition') ? { 'Content-Disposition': response.headers.get('Content-Disposition')! } : {}),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return Response.json({ error: 'เชื่อมต่อบริการข้อมูลไม่ได้ กรุณาลองอีกครั้ง' }, { status: 503 });
  }
}
