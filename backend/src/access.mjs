import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'asw_access';
const FAILURE_WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 20;
const reply = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
const sha256 = value => createHash('sha256').update(value).digest();

function readCookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
}

/**
 * Shared-password gate until company SSO exists. The cookie is a signed expiry,
 * so no session store is needed; changing the password revokes every cookie.
 * Without a password the gate is open in development and closed in production,
 * unless `open` (ACCESS_OPEN=true) deliberately opens it for everyone.
 */
export function createAccessGate({ password = '', ttlHours = 12, production = false, open = false, now = Date.now } = {}) {
  const required = !open && (Boolean(password) || production);
  const key = password ? sha256(`asw-access-key:${password}`) : null;
  const expected = password ? sha256(password) : null;
  let failures = [];
  const sign = expiry => createHmac('sha256', key).update(`asw-access:${expiry}`).digest('hex');

  function allowed(request) {
    if (!required) return true;
    if (!key) return false;
    const [expiry, signature = ''] = readCookie(request, COOKIE).split('.');
    if (!/^\d+$/.test(expiry || '') || Number(expiry) <= now()) return false;
    const actual = Buffer.from(signature, 'hex'), wanted = Buffer.from(sign(expiry), 'hex');
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
  }

  function cookie(value, maxAge) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${production ? '; Secure' : ''}`;
  }

  async function handle(request) {
    if (request.method === 'GET') return reply({ required, authenticated: allowed(request) });
    if (request.method === 'DELETE') return reply({ required, authenticated: false }, 200, { 'Set-Cookie': cookie('', 0) });
    if (request.method !== 'POST') return reply({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }, 405);
    if (!key) return reply({ error: { code: 'ACCESS_NOT_CONFIGURED', message: 'ระบบยังไม่ได้ตั้งรหัสผ่านสำหรับเข้าใช้งาน กรุณาติดต่อผู้ดูแลระบบ' } }, 503);
    failures = failures.filter(time => time > now() - FAILURE_WINDOW_MS);
    if (failures.length >= MAX_FAILURES) return reply({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'ใส่รหัสผ่านผิดหลายครั้ง กรุณารอ 10 นาทีแล้วลองใหม่' } }, 429);
    const body = await request.text();
    let input = null;
    try { input = body.length <= 1000 ? JSON.parse(body) : null; } catch { /* Treated as a wrong password below. */ }
    if (typeof input?.password !== 'string' || !timingSafeEqual(sha256(input.password), expected)) {
      failures.push(now());
      return reply({ error: { code: 'ACCESS_DENIED', message: 'รหัสผ่านไม่ถูกต้อง' } }, 401);
    }
    const maxAge = Math.round(ttlHours * 3600);
    const expiry = String(now() + maxAge * 1000);
    return reply({ required, authenticated: true }, 200, { 'Set-Cookie': cookie(`${expiry}.${sign(expiry)}`, maxAge) });
  }

  const denied = () => reply({ error: { code: 'ACCESS_REQUIRED', message: 'กรุณาใส่รหัสผ่านเพื่อเข้าใช้งาน' } }, 401);
  return { allowed, handle, denied, required };
}
