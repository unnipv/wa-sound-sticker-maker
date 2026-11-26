import { createSocketManager } from './wa.js';

export function createRelayManager({ authDir, enabled = true }) {
  const manager = createSocketManager({ authDir, label: 'relay', sendOnly: true });

  async function init() {
    if (!enabled) return;
    if (manager.hasCreds()) {
      manager.connect().catch((err) => {
        console.error('[relay] initial connect failed:', err.message);
      });
    }
  }

  function getStatus() {
    const st = manager.getStatus();
    return {
      enabled,
      paired: st.paired,
      connection: st.connection,
      me: st.me,
      qr: st.qr,
      code: st.code,
      lastError: st.lastError,
    };
  }

  function getPublicStatus() {
    const st = manager.getStatus();
    return {
      enabled,
      paired: enabled && st.paired,
      connection: enabled ? st.connection : 'disabled',
      me: enabled && st.paired ? { phone: st.me?.phone || null } : null,
    };
  }

  async function startPairing({ phone } = {}) {
    if (!enabled) {
      const err = new Error('Relay mode is disabled on this server.');
      err.code = 'relay_disabled';
      throw err;
    }
    await manager.startPairing({ phone });
    return getStatus();
  }

  async function logout() {
    await manager.logout();
    return getStatus();
  }

  async function send({ phone, webpBuf, audioBuf, audioSeconds }) {
    if (!enabled) {
      const err = new Error('Relay mode is disabled on this server.');
      err.code = 'relay_disabled';
      throw err;
    }
    if (!phone) {
      const err = new Error('Enter your phone number with country code.');
      err.code = 'phone_required';
      throw err;
    }
    return manager.sendSoundSticker({ toPhone: phone, webpBuf, audioBuf, audioSeconds });
  }

  return { init, getStatus, getPublicStatus, startPairing, logout, send };
}
