// Minimal stand-in for @github/copilot-sdk 1.0.13 surface used by the adapter.
// Dispatch mirrors CopilotSession._dispatchEvent: each handler wrapped in try/catch.
// disconnect mirrors _markDisconnected: eventHandlers.clear().
export const tick = () => new Promise((r) => setTimeout(r, 5));
export class FakeSession {
  constructor(id) { this.sessionId = id; this.handlers = new Set(); this.script = null; this.sends = []; this.aborted = 0; }
  on(h) { this.handlers.add(h); return () => this.handlers.delete(h); }
  _dispatch(ev) { for (const h of [...this.handlers]) { try { h(ev); } catch {} } }
  async send(msg) {
    this.sends.push(msg);
    const script = this.script;
    if (script) setTimeout(() => { script(this).catch((e) => console.error('script failed', e)); }, 0);
    return 'msg-' + this.sends.length;
  }
  async abort() { this.aborted++; }
  async disconnect() { this.handlers.clear(); }
}
export class CopilotClient {
  constructor(opts) { this.opts = opts; this.sessions = []; }
  async start() {}
  async createSession(cfg) { const s = new FakeSession(cfg.sessionId || 'sess-' + (this.sessions.length + 1)); s.config = cfg; this.sessions.push(s); return s; }
  async resumeSession(id, cfg) { const s = new FakeSession(id); s.config = cfg; this.sessions.push(s); return s; }
  async getStatus() { return { version: 'fake' }; }
  async getAuthStatus() { return { isAuthenticated: true }; }
  async listSessions() { return []; }
  async deleteSession() {}
  async stop() { return []; }
}
export const RuntimeConnection = { forUri: (url, opts) => ({ kind: 'uri', url, opts }), forStdio: (opts) => ({ kind: 'stdio', opts }) };
export const approveAll = () => ({ kind: 'approve-once' });
export const ev = {
  delta: (t, id = 'm1') => ({ type: 'assistant.message_delta', data: { deltaContent: t, messageId: id } }),
  msg: (t, id = 'm1') => ({ type: 'assistant.message', data: { content: t, messageId: id } }),
  idle: (mode) => ({ type: 'session.idle', data: mode ? { mode } : {} }),
  err: (m) => ({ type: 'session.error', data: { message: m, errorType: 'query' } })
};
