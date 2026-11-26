import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createSocketManager } from './wa.js';

const SID_RE = /^[a-f0-9]{24,64}$/;

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function createSessionStore(sessionsRootDir) {
  const managers = new Map();

  function getManager(sid) {
    if (!SID_RE.test(sid)) throw new Error('Invalid session id');
    let m = managers.get(sid);
    if (!m) {
      m = createSocketManager({
        authDir: join(sessionsRootDir, sid),
        label: `session:${sid.slice(0, 8)}`,
        sendOnly: true,
      });
      managers.set(sid, m);
      if (m.hasCreds()) {
        m.connect().catch(() => {});
      }
    }
    return m;
  }

  function ensureSid(req, res) {
    const cookies = parseCookies(req.headers.cookie);
    let sid = cookies.sid;
    if (!sid || !SID_RE.test(sid)) {
      sid = randomBytes(16).toString('hex');
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.append('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure}`);
    }
    return sid;
  }

  function getStatus(sid) {
    const m = getManager(sid);
    const st = m.getStatus();
    return {
      paired: st.paired,
      connection: st.connection,
      me: st.me,
      qr: st.qr,
      code: st.code,
      lastError: st.lastError,
    };
  }

  async function startPairing(sid, { phone } = {}) {
    const m = getManager(sid);
    await m.startPairing({ phone });
    return getStatus(sid);
  }

  async function logout(sid) {
    const m = getManager(sid);
    await m.logout();
    managers.delete(sid);
    return { paired: false, connection: 'disconnected', me: null, qr: null, code: null, lastError: null };
  }

  async function sendToSelf(sid, { webpBuf, audioBuf, audioSeconds }) {
    const m = getManager(sid);
    return m.sendSoundSticker({ toPhone: null, webpBuf, audioBuf, audioSeconds });
  }

  return { ensureSid, getStatus, startPairing, logout, sendToSelf };
}
