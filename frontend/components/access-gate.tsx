'use client';

import { useState } from 'react';
import { LoaderCircle, LockKeyhole } from 'lucide-react';
import { unlockAccess } from '@/lib/datasets';

/** Shared-password screen shown until company SSO replaces it. */
export function AccessGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true); setError('');
    try { await unlockAccess(password); setPassword(''); onUnlocked(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองอีกครั้ง'); }
    finally { setBusy(false); }
  }

  return <section className="data-upload-panel access-gate" aria-labelledby="access-title">
    <span className="data-upload-icon"><LockKeyhole size={26} aria-hidden="true" /></span>
    <h2 id="access-title">ใส่รหัสผ่านเพื่อใช้งาน</h2>
    <p className="data-panel-subtitle">ระบบนี้ใช้ภายในบริษัท ขอรหัสผ่านได้จากผู้ดูแลระบบ</p>
    <form onSubmit={event => void submit(event)}>
      <label htmlFor="access-password">รหัสผ่าน</label>
      <input id="access-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? 'access-error' : undefined} />
      {error && <p id="access-error" className="access-error" role="alert">{error}</p>}
      <button className="data-button primary" type="submit" disabled={!password || busy}>{busy && <LoaderCircle size={16} className="data-spin" aria-hidden="true" />}เข้าใช้งาน</button>
    </form>
  </section>;
}
