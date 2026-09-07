// Transport only: provider settings and Gemini logic live in backend/.
const endpoint = () => (process.env.BACKEND_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');

export async function backendProxy(request: Request, path: '/api/interpret' | '/api/analysis-engine') {
  if (request.method === 'POST' && request.headers.get('origin') !== new URL(request.url).origin) {
    return Response.json({ error: 'Origin not allowed' }, { status: 403 });
  }
  try {
    const body = request.method === 'POST' ? await request.text() : undefined;
    if (body && new TextEncoder().encode(body).byteLength > 100_000) return Response.json({ error: 'ข้อมูลคำขอมีขนาดใหญ่เกินไป' }, { status: 413 });
    const headers = new Headers();
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const origin = request.headers.get('origin');
    if (origin) headers.set('Origin', origin);
    const response = await fetch(endpoint() + path, {
      method: request.method, headers, body,
      signal: AbortSignal.timeout(55_000), redirect: 'error',
    });
    return new Response(response.body, {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ error: 'เชื่อมต่อ backend ไม่สำเร็จ กรุณารัน npm run dev จากโฟลเดอร์หลัก' }, { status: 503 });
  }
}
